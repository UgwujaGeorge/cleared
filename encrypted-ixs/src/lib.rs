use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub const MAX_BIDS: usize = 8;
    // Bid book stored as a flat [u64; 3*MAX_BIDS] inside Pack<>, which bit-packs
    // ~3 u64s per BLS12-381 scalar field element. Each bid occupies 3 slots:
    // [price, quantity, bidder_id]. Pack must be the direct inner type of Enc<>,
    // so it cannot be wrapped in a struct — count is tracked plaintext on the
    // program side (auction.bid_count) and passed back in for each computation.
    pub const FLAT_SIZE: usize = MAX_BIDS * 3;

    pub type BidBook = Pack<[u64; FLAT_SIZE]>;

    #[derive(Copy, Clone)]
    pub struct UserBid {
        pub price: u64,
        pub quantity: u64,
    }

    // Sentinel bidder_id for empty slots. Larger than MAX_BIDS so no real bidder
    // (assigned 0..count-1 by the program) ever collides during re-indexing.
    pub const EMPTY_BIDDER_ID: u64 = u64::MAX;

    #[instruction]
    pub fn init_bid_book() -> Enc<Mxe, BidBook> {
        let mut flat: [u64; FLAT_SIZE] = [0u64; FLAT_SIZE];
        // bidder_id sits at offset 3*i+2 in each bid; mark empties with sentinel.
        for i in 0..MAX_BIDS {
            flat[3 * i + 2] = EMPTY_BIDDER_ID;
        }
        Mxe::get().from_arcis(Pack::new(flat))
    }

    #[instruction]
    pub fn add_bid(
        user_bid_ctxt: Enc<Shared, UserBid>,
        bidder_id: u64,
        count: u64,
        book_ctxt: Enc<Mxe, BidBook>,
    ) -> Enc<Mxe, BidBook> {
        let user_bid = user_bid_ctxt.to_arcis();
        let mut flat = book_ctxt.to_arcis().unpack();

        for i in 0..MAX_BIDS {
            if (i as u64) == count {
                flat[3 * i] = user_bid.price;
                flat[3 * i + 1] = user_bid.quantity;
                flat[3 * i + 2] = bidder_id;
            }
        }
        book_ctxt.owner.from_arcis(Pack::new(flat))
    }

    #[instruction]
    pub fn compute_clearing(
        book_ctxt: Enc<Mxe, BidBook>,
        count: u64,
        total_supply: u64,
    ) -> (u64, [u64; MAX_BIDS], u64) {
        let mut flat = book_ctxt.to_arcis().unpack();

        // Bitonic sort, descending by price. log2(8)=3 phases, 6 stages.
        bitonic_stage(&mut flat, 1, 2);
        bitonic_stage(&mut flat, 2, 4);
        bitonic_stage(&mut flat, 1, 4);
        bitonic_stage(&mut flat, 4, 8);
        bitonic_stage(&mut flat, 2, 8);
        bitonic_stage(&mut flat, 1, 8);

        // Fill top-down until supply exhausted. Uniform price = last non-zero fill's bid price.
        let mut remaining: u64 = total_supply;
        let mut clearing_price: u64 = 0;
        let mut total_sold: u64 = 0;
        let mut fills: [u64; MAX_BIDS] = [0; MAX_BIDS];

        for i in 0..MAX_BIDS {
            let is_real = (i as u64) < count;
            let wants = if is_real { flat[3 * i + 1] } else { 0 };
            let fill = if wants <= remaining { wants } else { remaining };
            fills[i] = fill;
            total_sold = total_sold + fill;
            remaining = remaining - fill;
            if fill > 0 {
                clearing_price = flat[3 * i];
            }
        }

        // Re-index sorted-order fills to bidder-id-indexed allocations.
        // Empty slots carry EMPTY_BIDDER_ID (u64::MAX) > any j in 0..MAX_BIDS,
        // so the inner match cannot fire for them.
        let mut allocations: [u64; MAX_BIDS] = [0; MAX_BIDS];
        for i in 0..MAX_BIDS {
            let is_real = (i as u64) < count;
            let target = flat[3 * i + 2];
            for j in 0..MAX_BIDS {
                if is_real && (j as u64) == target {
                    allocations[j] = fills[i];
                }
            }
        }

        (
            clearing_price.reveal(),
            allocations.reveal(),
            total_sold.reveal(),
        )
    }

    fn bitonic_stage(flat: &mut [u64; FLAT_SIZE], d: usize, g: usize) {
        for i in 0..MAX_BIDS {
            if (i % (2 * d)) < d {
                let partner = i + d;
                let dir_lower_first = ((i / g) % 2) == 0;
                bitonic_compare(flat, i, partner, dir_lower_first);
            }
        }
    }

    fn bitonic_compare(flat: &mut [u64; FLAT_SIZE], i: usize, j: usize, dir_lower_first: bool) {
        let pi = 3 * i;
        let pj = 3 * j;
        let a_price = flat[pi];
        let b_price = flat[pj];
        let a_qty = flat[pi + 1];
        let b_qty = flat[pj + 1];
        let a_id = flat[pi + 2];
        let b_id = flat[pj + 2];
        let swap = if dir_lower_first {
            a_price < b_price
        } else {
            a_price > b_price
        };
        if swap {
            flat[pi] = b_price;
            flat[pj] = a_price;
            flat[pi + 1] = b_qty;
            flat[pj + 1] = a_qty;
            flat[pi + 2] = b_id;
            flat[pj + 2] = a_id;
        }
    }
}

#[cfg(test)]
mod tests {
    const MAX_BIDS: usize = 8;
    const FLAT_SIZE: usize = MAX_BIDS * 3;

    fn bitonic_compare(flat: &mut [u64; FLAT_SIZE], i: usize, j: usize, dir_lower_first: bool) {
        let pi = 3 * i;
        let pj = 3 * j;
        let a_price = flat[pi];
        let b_price = flat[pj];
        let a_qty = flat[pi + 1];
        let b_qty = flat[pj + 1];
        let a_id = flat[pi + 2];
        let b_id = flat[pj + 2];
        let swap = if dir_lower_first {
            a_price < b_price
        } else {
            a_price > b_price
        };
        if swap {
            flat[pi] = b_price;
            flat[pj] = a_price;
            flat[pi + 1] = b_qty;
            flat[pj + 1] = a_qty;
            flat[pi + 2] = b_id;
            flat[pj + 2] = a_id;
        }
    }

    fn bitonic_stage(flat: &mut [u64; FLAT_SIZE], d: usize, g: usize) {
        for i in 0..MAX_BIDS {
            if (i % (2 * d)) < d {
                let partner = i + d;
                let dir_lower_first = ((i / g) % 2) == 0;
                bitonic_compare(flat, i, partner, dir_lower_first);
            }
        }
    }

    fn bitonic_sort_desc(flat: &mut [u64; FLAT_SIZE]) {
        bitonic_stage(flat, 1, 2);
        bitonic_stage(flat, 2, 4);
        bitonic_stage(flat, 1, 4);
        bitonic_stage(flat, 4, 8);
        bitonic_stage(flat, 2, 8);
        bitonic_stage(flat, 1, 8);
    }

    fn empty_flat() -> [u64; FLAT_SIZE] {
        let mut flat = [0u64; FLAT_SIZE];
        for i in 0..MAX_BIDS {
            flat[3 * i + 2] = u64::MAX;
        }
        flat
    }

    fn set_bid(flat: &mut [u64; FLAT_SIZE], i: usize, price: u64, qty: u64, id: u64) {
        flat[3 * i] = price;
        flat[3 * i + 1] = qty;
        flat[3 * i + 2] = id;
    }

    fn assert_descending(flat: &[u64; FLAT_SIZE]) {
        for i in 1..MAX_BIDS {
            let prev_price = flat[3 * (i - 1)];
            let cur_price = flat[3 * i];
            assert!(
                prev_price >= cur_price,
                "not descending at slot {}: {} < {}",
                i,
                prev_price,
                cur_price
            );
        }
    }

    #[test]
    fn already_descending() {
        let mut flat = empty_flat();
        for i in 0..MAX_BIDS {
            set_bid(&mut flat, i, (MAX_BIDS - i) as u64 * 10, 1, i as u64);
        }
        bitonic_sort_desc(&mut flat);
        assert_descending(&flat);
        assert_eq!(flat[0], 80);
        assert_eq!(flat[3 * (MAX_BIDS - 1)], 10);
    }

    #[test]
    fn ascending_input_reverses() {
        let mut flat = empty_flat();
        for i in 0..MAX_BIDS {
            set_bid(&mut flat, i, i as u64 * 10 + 1, 1, i as u64);
        }
        bitonic_sort_desc(&mut flat);
        assert_descending(&flat);
        for i in 0..MAX_BIDS {
            assert_eq!(flat[3 * i], ((MAX_BIDS - 1 - i) as u64) * 10 + 1);
        }
    }

    #[test]
    fn three_real_bids_with_zeros() {
        let mut flat = empty_flat();
        set_bid(&mut flat, 0, 10, 500, 0);
        set_bid(&mut flat, 1, 8, 300, 1);
        set_bid(&mut flat, 2, 7, 400, 2);
        bitonic_sort_desc(&mut flat);
        assert_eq!(flat[0], 10);
        assert_eq!(flat[2], 0);
        assert_eq!(flat[3], 8);
        assert_eq!(flat[5], 1);
        assert_eq!(flat[6], 7);
        assert_eq!(flat[8], 2);
        for i in 3..MAX_BIDS {
            assert_eq!(flat[3 * i], 0);
            assert_eq!(flat[3 * i + 2], u64::MAX);
        }
    }

    #[test]
    fn random_permutation() {
        let prices: [u64; MAX_BIDS] = [5, 7, 1, 2, 3, 8, 4, 6];
        let mut flat = empty_flat();
        for i in 0..MAX_BIDS {
            set_bid(&mut flat, i, prices[i], 1, i as u64);
        }
        bitonic_sort_desc(&mut flat);
        assert_descending(&flat);
        for i in 0..MAX_BIDS {
            assert_eq!(flat[3 * i], (MAX_BIDS - i) as u64);
        }
    }
}
