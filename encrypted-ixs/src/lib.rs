use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub const MAX_BIDS: usize = 32;

    #[derive(Copy, Clone)]
    pub struct UserBid {
        pub price: u64,
        pub quantity: u64,
    }

    #[derive(Copy, Clone)]
    pub struct Bid {
        pub price: u64,
        pub quantity: u64,
        pub bidder_id: u64,
    }

    #[derive(Copy, Clone)]
    pub struct BidBook {
        pub bids: [Bid; MAX_BIDS],
        pub count: u8,
    }

    // Sentinel bidder_id for empty slots. Larger than MAX_BIDS so no real bidder
    // (assigned 0..count-1 by the program) ever collides with it during re-indexing.
    pub const EMPTY_BIDDER_ID: u64 = u64::MAX;

    #[instruction]
    pub fn init_bid_book() -> Enc<Mxe, BidBook> {
        let empty = Bid {
            price: 0,
            quantity: 0,
            bidder_id: EMPTY_BIDDER_ID,
        };
        let book = BidBook {
            bids: [empty; MAX_BIDS],
            count: 0,
        };
        Mxe::get().from_arcis(book)
    }

    #[instruction]
    pub fn add_bid(
        user_bid_ctxt: Enc<Shared, UserBid>,
        bidder_id: u64,
        book_ctxt: Enc<Mxe, BidBook>,
    ) -> Enc<Mxe, BidBook> {
        let user_bid = user_bid_ctxt.to_arcis();
        let mut book = book_ctxt.to_arcis();

        let new_bid = Bid {
            price: user_bid.price,
            quantity: user_bid.quantity,
            bidder_id,
        };

        for i in 0..MAX_BIDS {
            if (i as u8) == book.count {
                book.bids[i] = new_bid;
            }
        }
        book.count = book.count + 1;

        book_ctxt.owner.from_arcis(book)
    }

    #[instruction]
    pub fn compute_clearing(
        book_ctxt: Enc<Mxe, BidBook>,
        total_supply: u64,
    ) -> (u64, [u64; MAX_BIDS], u64) {
        let book = book_ctxt.to_arcis();
        let mut bids = book.bids;

        // Bitonic sort, descending by price. log2(32)=5 phases, 15 stages total,
        // 16 comparators per stage = 240 comparators. Each (d, g) pair encodes
        // the partner-distance and bitonic-group-size for that stage.
        bitonic_stage(&mut bids, 1, 2);
        bitonic_stage(&mut bids, 2, 4);
        bitonic_stage(&mut bids, 1, 4);
        bitonic_stage(&mut bids, 4, 8);
        bitonic_stage(&mut bids, 2, 8);
        bitonic_stage(&mut bids, 1, 8);
        bitonic_stage(&mut bids, 8, 16);
        bitonic_stage(&mut bids, 4, 16);
        bitonic_stage(&mut bids, 2, 16);
        bitonic_stage(&mut bids, 1, 16);
        bitonic_stage(&mut bids, 16, 32);
        bitonic_stage(&mut bids, 8, 32);
        bitonic_stage(&mut bids, 4, 32);
        bitonic_stage(&mut bids, 2, 32);
        bitonic_stage(&mut bids, 1, 32);

        // Fill top-down until supply exhausted. Uniform price = last non-zero fill's bid price.
        let mut remaining: u64 = total_supply;
        let mut clearing_price: u64 = 0;
        let mut total_sold: u64 = 0;
        let mut fills: [u64; MAX_BIDS] = [0; MAX_BIDS];

        for i in 0..MAX_BIDS {
            let is_real = (i as u8) < book.count;
            let wants = if is_real { bids[i].quantity } else { 0 };
            let fill = if wants <= remaining { wants } else { remaining };
            fills[i] = fill;
            total_sold = total_sold + fill;
            remaining = remaining - fill;
            if fill > 0 {
                clearing_price = bids[i].price;
            }
        }

        // Re-index sorted-order fills to bidder-id-indexed allocations (O(N^2)).
        // Empty slots carry EMPTY_BIDDER_ID (u64::MAX), which is > any j in 0..MAX_BIDS,
        // so the inner match fails and they cannot clobber a real bidder's allocation.
        // `is_real` is kept as belt-and-suspenders.
        let mut allocations: [u64; MAX_BIDS] = [0; MAX_BIDS];
        for i in 0..MAX_BIDS {
            let is_real = (i as u8) < book.count;
            let target = bids[i].bidder_id;
            for j in 0..MAX_BIDS {
                if is_real && (j as u64) == target {
                    allocations[j] = fills[i];
                }
            }
        }

        (clearing_price.reveal(), allocations.reveal(), total_sold.reveal())
    }

    // One bitonic stage at partner-distance `d` within bitonic groups of size `g`.
    // For each canonical-low index i (whose position in its 2d-block is < d),
    // compare with partner i+d. Direction alternates per g-block.
    // Arithmetic indexing only — Arcis rejects bitwise `&`.
    fn bitonic_stage(bids: &mut [Bid; MAX_BIDS], d: usize, g: usize) {
        for i in 0..MAX_BIDS {
            if (i % (2 * d)) < d {
                let partner = i + d;
                let dir_lower_first = ((i / g) % 2) == 0;
                bitonic_compare(bids, i, partner, dir_lower_first);
            }
        }
    }

    // Descending overall sort: position lower index with larger price when
    // `dir_lower_first` is true; otherwise position smaller price first.
    fn bitonic_compare(bids: &mut [Bid; MAX_BIDS], i: usize, j: usize, dir_lower_first: bool) {
        let a = bids[i];
        let b = bids[j];
        let swap = if dir_lower_first {
            a.price < b.price
        } else {
            a.price > b.price
        };
        if swap {
            bids[i] = b;
            bids[j] = a;
        }
    }
}

#[cfg(test)]
mod tests {
    // Plaintext mirror of the bitonic network used inside the encrypted circuit.
    // Tests the index/direction algebra; the encrypted version runs the same
    // shape over MPC-backed Bid values.

    const MAX_BIDS: usize = 32;

    #[derive(Copy, Clone, Debug, PartialEq, Eq)]
    struct Bid {
        price: u64,
        quantity: u64,
        bidder_id: u64,
    }

    fn bitonic_compare(bids: &mut [Bid; MAX_BIDS], i: usize, j: usize, dir_lower_first: bool) {
        let a = bids[i];
        let b = bids[j];
        let swap = if dir_lower_first {
            a.price < b.price
        } else {
            a.price > b.price
        };
        if swap {
            bids[i] = b;
            bids[j] = a;
        }
    }

    fn bitonic_stage(bids: &mut [Bid; MAX_BIDS], d: usize, g: usize) {
        for i in 0..MAX_BIDS {
            if (i % (2 * d)) < d {
                let partner = i + d;
                let dir_lower_first = ((i / g) % 2) == 0;
                bitonic_compare(bids, i, partner, dir_lower_first);
            }
        }
    }

    fn bitonic_sort_desc(bids: &mut [Bid; MAX_BIDS]) {
        bitonic_stage(bids, 1, 2);
        bitonic_stage(bids, 2, 4);
        bitonic_stage(bids, 1, 4);
        bitonic_stage(bids, 4, 8);
        bitonic_stage(bids, 2, 8);
        bitonic_stage(bids, 1, 8);
        bitonic_stage(bids, 8, 16);
        bitonic_stage(bids, 4, 16);
        bitonic_stage(bids, 2, 16);
        bitonic_stage(bids, 1, 16);
        bitonic_stage(bids, 16, 32);
        bitonic_stage(bids, 8, 32);
        bitonic_stage(bids, 4, 32);
        bitonic_stage(bids, 2, 32);
        bitonic_stage(bids, 1, 32);
    }

    fn bid(price: u64, bidder_id: u64) -> Bid {
        Bid { price, quantity: 0, bidder_id }
    }

    fn empty() -> Bid {
        Bid { price: 0, quantity: 0, bidder_id: u64::MAX }
    }

    fn assert_descending(bids: &[Bid; MAX_BIDS]) {
        for i in 1..MAX_BIDS {
            assert!(
                bids[i - 1].price >= bids[i].price,
                "not descending at {}: {} < {}",
                i,
                bids[i - 1].price,
                bids[i].price
            );
        }
    }

    #[test]
    fn already_descending() {
        let mut bids = [empty(); MAX_BIDS];
        for i in 0..MAX_BIDS {
            bids[i] = bid((MAX_BIDS - i) as u64 * 10, i as u64);
        }
        bitonic_sort_desc(&mut bids);
        assert_descending(&bids);
        assert_eq!(bids[0].price, 320);
        assert_eq!(bids[31].price, 10);
    }

    #[test]
    fn ascending_input_reverses() {
        let mut bids = [empty(); MAX_BIDS];
        for i in 0..MAX_BIDS {
            bids[i] = bid(i as u64 * 10 + 1, i as u64);
        }
        bitonic_sort_desc(&mut bids);
        assert_descending(&bids);
        for i in 0..MAX_BIDS {
            assert_eq!(bids[i].price, ((MAX_BIDS - 1 - i) as u64) * 10 + 1);
        }
    }

    #[test]
    fn three_real_bids_with_zeros() {
        let mut bids = [empty(); MAX_BIDS];
        bids[0] = Bid { price: 10, quantity: 500, bidder_id: 0 };
        bids[1] = Bid { price: 8, quantity: 300, bidder_id: 1 };
        bids[2] = Bid { price: 7, quantity: 400, bidder_id: 2 };
        bitonic_sort_desc(&mut bids);
        assert_eq!(bids[0].price, 10);
        assert_eq!(bids[0].bidder_id, 0);
        assert_eq!(bids[1].price, 8);
        assert_eq!(bids[1].bidder_id, 1);
        assert_eq!(bids[2].price, 7);
        assert_eq!(bids[2].bidder_id, 2);
        for i in 3..MAX_BIDS {
            assert_eq!(bids[i].price, 0);
            assert_eq!(bids[i].bidder_id, u64::MAX);
        }
    }

    #[test]
    fn random_permutation() {
        // A scrambled permutation of 1..=32 across all 32 slots.
        let prices: [u64; MAX_BIDS] = [
            5, 12, 7, 1, 9, 14, 2, 11, 3, 8, 6, 13, 4, 15, 10, 16,
            17, 23, 18, 20, 19, 24, 21, 22, 25, 31, 26, 28, 27, 32, 29, 30,
        ];
        let mut bids = [empty(); MAX_BIDS];
        for i in 0..MAX_BIDS {
            bids[i] = bid(prices[i], i as u64);
        }
        bitonic_sort_desc(&mut bids);
        assert_descending(&bids);
        for i in 0..MAX_BIDS {
            assert_eq!(bids[i].price, (MAX_BIDS - i) as u64);
        }
    }

    #[test]
    fn ties_preserve_order() {
        let mut bids = [empty(); MAX_BIDS];
        bids[0] = bid(5, 0);
        bids[1] = bid(5, 1);
        bids[2] = bid(5, 2);
        bitonic_sort_desc(&mut bids);
        assert_descending(&bids);
        assert_eq!(bids[0].price, 5);
        assert_eq!(bids[1].price, 5);
        assert_eq!(bids[2].price, 5);
        for i in 3..MAX_BIDS {
            assert_eq!(bids[i].price, 0);
        }
    }
}
