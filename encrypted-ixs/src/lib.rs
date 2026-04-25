use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub const MAX_BIDS: usize = 4;

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

        // 5-comparator sorting network for N=4, descending by price.
        sort_stage(&mut bids, 0, 1);
        sort_stage(&mut bids, 2, 3);
        sort_stage(&mut bids, 0, 2);
        sort_stage(&mut bids, 1, 3);
        sort_stage(&mut bids, 1, 2);

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

    fn sort_stage(bids: &mut [Bid; MAX_BIDS], i: usize, j: usize) {
        let a = bids[i];
        let b = bids[j];
        let swap = a.price < b.price;
        if swap {
            bids[i] = b;
            bids[j] = a;
        }
    }
}
