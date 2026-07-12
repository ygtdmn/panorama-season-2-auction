// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/src/Test.sol";
import { Panorama } from "../src/Panorama.sol";
import { PanoramaMintController } from "../src/PanoramaMintController.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";
import { Ownable } from "solady/auth/Ownable.sol";

/*//////////////////////////////////////////////////////////////
                          MOCK RECEIVERS
//////////////////////////////////////////////////////////////*/

/// @dev Reverts on any plain ETH receipt. Used to prove refunds cannot be blocked.
contract RevertingReceiver {
    PanoramaSeason2Auction public auction;

    constructor(PanoramaSeason2Auction a) {
        auction = a;
    }

    function bid(uint256 v) external {
        auction.placeBid{ value: v }();
    }

    function increase(uint32 id, uint256 v) external {
        auction.increaseBid{ value: v }(id);
    }

    function withdraw() external {
        auction.withdraw();
    }

    receive() external payable {
        revert("no ETH");
    }
}

/// @dev Attempts to re-enter the auction on ETH receipt (reverts propagate; no try/catch).
contract ReentrantBidder {
    PanoramaSeason2Auction public auction;
    uint256 public mode; // 0 none, 1 placeBid, 2 withdraw, 3 finalize

    constructor(PanoramaSeason2Auction a) {
        auction = a;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function bid(uint256 v) external {
        auction.placeBid{ value: v }();
    }

    receive() external payable {
        if (mode == 1) auction.placeBid{ value: 0 }();
        else if (mode == 2) auction.withdraw();
        else if (mode == 3) auction.finalize(1);
    }
}

/// @dev Exercises sequential top-ups from one smart wallet in a single transaction.
contract SplitIncreaseBidder {
    PanoramaSeason2Auction public immutable auction;

    constructor(PanoramaSeason2Auction auction_) {
        auction = auction_;
    }

    function bid(uint256 amount) external {
        auction.placeBid{ value: amount }();
    }

    function splitIncrease(uint32 bidId, uint256 first, uint256 second) external {
        auction.increaseBid{ value: first }(bidId);
        auction.increaseBid{ value: second }(bidId);
    }

    receive() external payable { }
}

/// @dev Minimal token used to verify accidental ERC20 recovery.
contract AuctionTestERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Sends ETH without invoking the auction, creating provable balance surplus.
contract AuctionForceETH {
    constructor() payable { }

    function force(address payable to) external {
        selfdestruct(to);
    }
}

/// @dev Panorama-shaped mint target that deliberately returns a token id other than the id minted.
contract WrongIdPanorama {
    uint256 public totalMinted = 90;
    uint256 public mintCap = 180;
    uint256 public constant maxSupply = 365;
    mapping(address => bool) public authorizedOperators;

    function setAuthorizedOperator(address operator, bool authorized) external {
        authorizedOperators[operator] = authorized;
    }

    function mintTo(address) external returns (uint256) {
        ++totalMinted;
        return totalMinted + 1;
    }
}

/*//////////////////////////////////////////////////////////////
                              TESTS
//////////////////////////////////////////////////////////////*/

contract PanoramaSeason2AuctionTest is Test {
    uint256 constant WRITE_GAS_LIMIT = 15_000_000;

    Panorama nft;
    PanoramaMintController controller;
    PanoramaSeason2Auction auction;

    address owner;
    address payoutA = address(0xA);
    address payoutB = address(0xB);

    uint96 constant RESERVE = 0.1 ether;
    uint16 constant INC_BPS = 500; // 5%
    uint64 constant DURATION = 24 hours;
    uint64 constant START_DELAY = 1 hours;

    function setUp() public {
        owner = address(this);
        vm.warp(1_700_000_000);

        nft = new Panorama();
        controller = new PanoramaMintController();
        nft.setMintController(address(controller));
        controller.setSeasonMintCap(1, 90);

        // Season 1 fully minted -> totalMinted == 90 so the auction mints #91..#180.
        nft.mintTo(owner, 90);
        controller.setSeasonMintCap(2, 90);

        uint64 start = uint64(block.timestamp + START_DELAY);
        auction = new PanoramaSeason2Auction(address(nft), RESERVE, INC_BPS, start, DURATION, payoutA, payoutB);
        nft.setAuthorizedOperator(address(auction), true);
        vm.warp(start);
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    function _actor(uint256 i) internal pure returns (address) {
        return address(uint160(0x100000 + i));
    }

    function _place(address who, uint256 amount) internal returns (uint32 id) {
        id = auction.nextBidId();
        vm.deal(who, amount);
        vm.prank(who);
        auction.placeBid{ value: amount }();
    }

    function _increase(address who, uint32 id, uint256 amount) internal {
        vm.deal(who, amount);
        vm.prank(who);
        auction.increaseBid{ value: amount }(id);
    }

    /// @dev Fill all 90 slots with distinct increasing amounts. Floor = RESERVE.
    function _fill90() internal {
        for (uint256 i; i < 90; ++i) {
            _place(_actor(i), RESERVE + i * 0.001 ether);
        }
    }

    function _endAuction() internal {
        vm.warp(auction.endTime() + 1);
    }

    /*//////////////////////////////////////////////////////////////
                          CONFIG / CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsConfig() public view {
        assertEq(address(auction.nft()), address(nft));
        assertEq(auction.reservePrice(), RESERVE);
        assertEq(auction.minIncrementBps(), INC_BPS);
        assertEq(auction.payoutA(), payoutA);
        assertEq(auction.payoutB(), payoutB);
        assertEq(auction.endTime(), auction.startTime() + DURATION);
        assertEq(auction.absoluteEndTime(), auction.endTime() + 24 hours);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Active));
        assertEq(auction.SPLIT_A_BPS(), 5800);
        assertEq(auction.MIN_RESERVE_PRICE(), 0.1 ether);
    }

    /// @dev The reserve is contract-floored at 0.1 ETH: exactly 0.1 deploys, one wei less
    ///      reverts, so no accepted bid can ever be below 0.1 ETH on any deployment.
    function test_constructor_enforcesReserveFloor() public {
        uint64 futureStart = uint64(block.timestamp + 1 hours);

        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), 0.1 ether - 1, INC_BPS, futureStart, DURATION, payoutA, payoutB);

        PanoramaSeason2Auction atFloor =
            new PanoramaSeason2Auction(address(nft), 0.1 ether, INC_BPS, futureStart, DURATION, payoutA, payoutB);
        assertEq(atFloor.reservePrice(), atFloor.MIN_RESERVE_PRICE());

        // A bid below the floored reserve is rejected even on a floor-priced auction.
        vm.warp(futureStart);
        address bidder = _actor(777);
        vm.deal(bidder, 1 ether);
        vm.prank(bidder);
        vm.expectRevert(PanoramaSeason2Auction.BelowReserve.selector);
        atFloor.placeBid{ value: 0.1 ether - 1 }();
    }

    function test_constructor_revertsBadConfig() public {
        uint64 futureStart = uint64(block.timestamp + 1 hours);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(0), RESERVE, INC_BPS, futureStart, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), 0, INC_BPS, futureStart, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), 0.1 ether - 1, INC_BPS, futureStart, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), RESERVE, 0, futureStart, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), RESERVE, INC_BPS, futureStart, 0, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), RESERVE, 10_001, futureStart, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), RESERVE, INC_BPS, 0, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(address(nft), RESERVE, INC_BPS, uint64(block.timestamp), DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(_actor(123), RESERVE, INC_BPS, futureStart, DURATION, payoutA, payoutB);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(
            address(nft), RESERVE, INC_BPS, uint64(type(uint64).max - 1 hours), 2 hours, payoutA, payoutB
        );
    }

    function test_constructor_requiresExactSeason2BaselineSupply() public {
        nft.mintTo(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        new PanoramaSeason2Auction(
            address(nft), RESERVE, INC_BPS, uint64(block.timestamp + 1 hours), DURATION, payoutA, payoutB
        );
    }

    function test_setSchedule_beforeAnyBid() public {
        auction.setSchedule(uint64(block.timestamp + 100), 24 hours);
        assertEq(auction.startTime(), block.timestamp + 100);
        assertEq(auction.endTime(), block.timestamp + 100 + 24 hours);
        assertEq(auction.absoluteEndTime(), block.timestamp + 100 + 48 hours);
    }

    function test_setSchedule_requiresExplicitFutureStart() public {
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        auction.setSchedule(0, 24 hours);
        vm.expectRevert(PanoramaSeason2Auction.InvalidConfig.selector);
        auction.setSchedule(uint64(block.timestamp), 24 hours);
    }

    function test_setSchedule_revertsAfterFirstBid() public {
        _place(_actor(0), RESERVE);
        vm.expectRevert(PanoramaSeason2Auction.TooLateToConfigure.selector);
        auction.setSchedule(0, 24 hours);
    }

    function test_setSchedule_onlyOwner() public {
        vm.prank(_actor(1));
        vm.expectRevert(Ownable.Unauthorized.selector);
        auction.setSchedule(0, 24 hours);
    }

    /*//////////////////////////////////////////////////////////////
                            BASIC BIDDING
    //////////////////////////////////////////////////////////////*/

    function test_placeBid_basic() public {
        uint32 id = _place(_actor(0), RESERVE);
        assertEq(id, 1);
        assertEq(auction.activeBids(), 1);
        assertEq(auction.activeBidCount(_actor(0)), 1);
        (address bidder, uint96 amount) = auction.bids(id);
        assertEq(bidder, _actor(0));
        assertEq(amount, RESERVE);
        assertEq(auction.currentClearingPrice(), RESERVE);
    }

    function test_placeBid_belowReserveReverts() public {
        vm.deal(_actor(0), RESERVE);
        vm.prank(_actor(0));
        vm.expectRevert(PanoramaSeason2Auction.BelowReserve.selector);
        auction.placeBid{ value: RESERVE - 1 }();
    }

    function test_placeBid_beforeStartReverts() public {
        auction.setSchedule(uint64(block.timestamp + 1000), DURATION);
        vm.deal(_actor(0), RESERVE);
        vm.prank(_actor(0));
        vm.expectRevert(PanoramaSeason2Auction.NotStarted.selector);
        auction.placeBid{ value: RESERVE }();
    }

    function test_placeBid_afterEndReverts() public {
        _endAuction();
        vm.deal(_actor(0), RESERVE);
        vm.prank(_actor(0));
        vm.expectRevert(PanoramaSeason2Auction.AuctionEnded.selector);
        auction.placeBid{ value: RESERVE }();
    }

    function test_placeBid_maxFourPerWallet() public {
        address w = _actor(0);
        for (uint256 i; i < 4; ++i) {
            _place(w, RESERVE + i);
        }
        assertEq(auction.activeBidCount(w), 4);
        vm.deal(w, RESERVE);
        vm.prank(w);
        vm.expectRevert(PanoramaSeason2Auction.TooManyBids.selector);
        auction.placeBid{ value: RESERVE }();
    }

    function test_bidsOf() public {
        address w = _actor(0);
        _place(w, RESERVE);
        _place(w, RESERVE + 1 ether);
        (uint32[] memory ids, uint96[] memory amounts) = auction.bidsOf(w);
        assertEq(ids.length, 2);
        assertEq(amounts.length, 2);
        assertEq(uint256(amounts[0]) + amounts[1], uint256(RESERVE) + RESERVE + 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        CAPACITY / DISPLACEMENT
    //////////////////////////////////////////////////////////////*/

    function test_fill90_thenFull() public {
        _fill90();
        assertEq(auction.activeBids(), 90);
        assertTrue(auction.isFull());
        assertEq(auction.currentClearingPrice(), RESERVE); // lowest bid is the floor
        // minimum next bid must beat floor by 5%
        assertEq(auction.minimumBid(), RESERVE + (uint256(RESERVE) * INC_BPS) / 10_000);
    }

    function test_subFloorBidReverts_whenFull() public {
        _fill90();
        uint256 minReq = auction.minimumBid();
        vm.deal(_actor(999), minReq);
        vm.prank(_actor(999));
        vm.expectRevert(abi.encodeWithSelector(PanoramaSeason2Auction.BidTooLow.selector, minReq));
        auction.placeBid{ value: minReq - 1 }();
        assertEq(auction.activeBids(), 90);
    }

    function test_displacement_evictsLowest_refundsFull() public {
        _fill90();
        address lowest = _actor(0); // bid exactly RESERVE
        assertEq(auction.activeBidCount(lowest), 1);

        uint256 newBid = auction.minimumBid();
        address challenger = _actor(999);
        vm.deal(challenger, newBid);
        vm.prank(challenger);
        auction.placeBid{ value: newBid }();

        // lowest displaced: refunded in full, slot freed, no longer in heap.
        assertEq(lowest.balance, RESERVE, "displaced refunded full");
        assertEq(auction.activeBidCount(lowest), 0);
        assertEq(auction.activeBids(), 90);
        // new clearing floor is now the previous 2nd-lowest (RESERVE + 0.001)
        assertEq(auction.currentClearingPrice(), RESERVE + 0.001 ether);
    }

    function test_displacement_revertingReceiver_stillWorks() public {
        // Fill 89 normal + 1 reverting receiver at the floor.
        for (uint256 i; i < 89; ++i) {
            _place(_actor(i), RESERVE + 0.001 ether + i * 0.001 ether);
        }
        RevertingReceiver rr = new RevertingReceiver(auction);
        vm.deal(address(rr), RESERVE);
        rr.bid(RESERVE); // lowest bid, will be displaced
        assertEq(auction.activeBids(), 90);
        assertEq(auction.currentClearingPrice(), RESERVE);

        // Challenger outbids: the reverting receiver must still be evicted & refunded (force-send).
        uint256 newBid = auction.minimumBid();
        address challenger = _actor(500);
        vm.deal(challenger, newBid);
        vm.prank(challenger);
        auction.placeBid{ value: newBid }();

        assertEq(address(rr).balance, RESERVE, "griefer force-refunded via selfdestruct");
        assertEq(auction.activeBidCount(address(rr)), 0);
        assertEq(auction.activeBids(), 90);
    }

    /*//////////////////////////////////////////////////////////////
                            INCREASE BID
    //////////////////////////////////////////////////////////////*/

    function test_increaseBid_raisesAmount() public {
        uint32 id = _place(_actor(0), RESERVE);
        _increase(_actor(0), id, 1 ether);
        (, uint96 amount) = auction.bids(id);
        assertEq(amount, uint256(RESERVE) + 1 ether);
    }

    function test_increaseBid_notYourBidReverts() public {
        uint32 id = _place(_actor(0), RESERVE);
        vm.deal(_actor(1), 1 ether);
        vm.prank(_actor(1));
        vm.expectRevert(PanoramaSeason2Auction.NotYourBid.selector);
        auction.increaseBid{ value: 1 ether }(id);
    }

    function test_increaseBid_zeroReverts() public {
        uint32 id = _place(_actor(0), RESERVE);
        vm.prank(_actor(0));
        vm.expectRevert(PanoramaSeason2Auction.ZeroIncrease.selector);
        auction.increaseBid{ value: 0 }(id);
    }

    function test_increaseBid_rootRaisesClearing() public {
        _fill90();
        // The floor bid is actor(0) at RESERVE, which is the heap root.
        assertEq(auction.currentClearingPrice(), RESERVE);
        // Raise the floor bid above the 2nd lowest -> clearing must rise.
        _increase(_actor(0), 1, 0.0015 ether); // 0.1 -> 0.1015, above actor(1)=0.101
        assertGt(auction.currentClearingPrice(), RESERVE);
        assertEq(auction.currentClearingPrice(), RESERVE + 0.001 ether); // new floor = actor(1)
    }

    function test_increaseBid_nonRootKeepsClearing() public {
        _fill90();
        uint256 before = auction.currentClearingPrice();
        // Raise a high bid (actor 50) — floor unaffected.
        _increase(_actor(50), 51, 5 ether);
        assertEq(auction.currentClearingPrice(), before);
    }

    /*//////////////////////////////////////////////////////////////
                            ANTI-SNIPE
    //////////////////////////////////////////////////////////////*/

    function test_antiSnipe_extends() public {
        uint64 end0 = auction.endTime();
        vm.warp(end0 - 2 minutes); // within 5-min window
        _place(_actor(0), RESERVE);
        assertEq(auction.endTime(), block.timestamp + 10 minutes);
        assertEq(auction.extensionCount(), 1);
    }

    function test_antiSnipe_noExtendOutsideWindow() public {
        uint64 end0 = auction.endTime();
        vm.warp(end0 - 10 minutes);
        _place(_actor(0), RESERVE);
        assertEq(auction.endTime(), end0);
        assertEq(auction.extensionCount(), 0);
    }

    function test_antiSnipe_extensionsStopAtAbsoluteEnd() public {
        uint64 hardEnd = auction.absoluteEndTime();
        assertEq(hardEnd, auction.endTime() + 24 hours);

        uint256 i;
        while (auction.endTime() < hardEnd) {
            vm.warp(auction.endTime() - 1 minutes);
            _place(_actor(i), auction.minimumBid());
            ++i;
            assertLt(i, 300, "extension loop must converge on hard end");
        }

        assertEq(auction.endTime(), hardEnd, "end must clamp to immutable hard deadline");
        vm.warp(hardEnd - 1);
        _place(_actor(10_000), auction.minimumBid());
        assertEq(auction.endTime(), hardEnd, "qualifying bid cannot move the hard deadline");
    }

    /*//////////////////////////////////////////////////////////////
                              FINALIZE
    //////////////////////////////////////////////////////////////*/

    function test_finalize_full_uniformPrice_split() public {
        _fill90();
        _endAuction();

        uint256 aBefore = payoutA.balance;
        uint256 bBefore = payoutB.balance;

        auction.finalize(90);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Settled));
        assertEq(auction.clearingPrice(), RESERVE);
        assertEq(nft.totalMinted(), 180); // 90 (season1) + 90 winners
        // every winner owns exactly one token
        uint256 owned;
        for (uint256 i; i < 90; ++i) {
            owned += nft.balanceOf(_actor(i));
        }
        assertEq(owned, 90, "all 90 winners each own one token");

        uint256 proceeds = 90 * uint256(RESERVE);
        uint256 aShare = (proceeds * 5800) / 10_000;
        assertEq(payoutA.balance - aBefore, aShare);
        assertEq(payoutB.balance - bBefore, proceeds - aShare);

        // Excess for actor(0) was 0 (bid == clearing); actor(89) got 0.089 back.
        assertEq(_actor(89).balance, 0.089 ether);
    }

    function test_finalize_descendingRevealOrder() public {
        // _fill90: actor(i) bids RESERVE + i*0.001 -> actor(89) is highest, actor(0) lowest.
        _fill90();
        _endAuction();
        auction.finalize(90);
        // Highest bid gets the earliest token (#91 -> first daily reveal); lowest gets #180.
        assertEq(nft.ownerOf(91), _actor(89), "highest bid -> #91");
        assertEq(nft.ownerOf(92), _actor(88), "2nd highest -> #92");
        assertEq(nft.ownerOf(179), _actor(1), "2nd lowest -> #179");
        assertEq(nft.ownerOf(180), _actor(0), "lowest winning -> #180");
    }

    function test_finalize_descendingOrder_survivesBatching() public {
        _fill90();
        _endAuction();
        auction.finalize(37);
        auction.finalize(37);
        auction.finalize(37);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Settled));
        // Order is preserved across batches.
        assertEq(nft.ownerOf(91), _actor(89), "highest bid -> #91 across batches");
        assertEq(nft.ownerOf(180), _actor(0), "lowest winning -> #180 across batches");
    }

    function test_finalize_batched_equalsSingle() public {
        _fill90();
        _endAuction();
        auction.finalize(30);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Finalizing));
        auction.finalize(30);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Finalizing));
        auction.finalize(30);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Settled));
        assertEq(nft.totalMinted(), 180);
        assertEq(auction.clearingPrice(), RESERVE);
        // count distinct owners of #91..#180
        for (uint256 t = 91; t <= 180; ++t) {
            assertTrue(nft.ownerOf(t) != address(0));
        }
    }

    function test_finalize_doubleFinalizeReverts() public {
        _fill90();
        _endAuction();
        auction.finalize(90);
        vm.expectRevert(PanoramaSeason2Auction.NotFinalizable.selector);
        auction.finalize(90);
    }

    function test_finalize_beforeEndReverts() public {
        _fill90();
        vm.expectRevert(PanoramaSeason2Auction.AuctionNotEnded.selector);
        auction.finalize(90);
    }

    function test_finalize_undersubscribed_clearingIsReserve() public {
        // Only 10 bids -> clearing = reserve, mint 10.
        for (uint256 i; i < 10; ++i) {
            _place(_actor(i), RESERVE + i * 0.01 ether);
        }
        _endAuction();
        auction.finalize(90);
        assertEq(auction.clearingPrice(), RESERVE);
        assertEq(nft.totalMinted(), 100); // 90 + 10
        uint256 proceeds = 10 * uint256(RESERVE);
        assertEq(payoutA.balance, (proceeds * 5800) / 10_000);
        assertEq(payoutB.balance, proceeds - (proceeds * 5800) / 10_000);
    }

    function test_finalize_zeroBids_settlesCleanly() public {
        _endAuction();
        auction.finalize(90);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Settled));
        assertEq(nft.totalMinted(), 90);
        assertEq(payoutA.balance, 0);
        assertEq(payoutB.balance, 0);
    }

    function test_finalize_notOperatorReverts() public {
        _fill90();
        _endAuction();
        nft.setAuthorizedOperator(address(auction), false);
        vm.expectRevert(PanoramaSeason2Auction.NotOperatorAuthorized.selector);
        auction.finalize(90);
    }

    function test_finalize_insufficientMintCapReverts() public {
        _fill90();
        _endAuction();
        // Drop season-2 cap so headroom < 90.
        controller.setSeasonMintCap(2, 10);
        vm.expectRevert(PanoramaSeason2Auction.InsufficientMintCap.selector);
        auction.finalize(90);
    }

    function test_finalize_multipleBidsSameWallet_winsMultiple() public {
        address whale = _actor(777);
        // 4 high bids from one wallet + 86 others.
        for (uint256 i; i < 4; ++i) {
            vm.deal(whale, 10 ether);
            vm.prank(whale);
            auction.placeBid{ value: 5 ether + i }();
        }
        for (uint256 i; i < 86; ++i) {
            _place(_actor(i), RESERVE + i * 0.001 ether);
        }
        _endAuction();
        auction.finalize(90);
        assertEq(nft.balanceOf(whale), 4, "whale won 4 tokens");
    }

    function test_finalize_permissionlessAfterGrace() public {
        _fill90();
        _endAuction();
        // Non-owner before grace -> revert.
        vm.prank(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.NotAuthorizedToFinalize.selector);
        auction.finalize(90);
        // After grace, anyone can.
        vm.warp(auction.endTime() + auction.FINALIZE_GRACE() + 1);
        vm.prank(_actor(999));
        auction.finalize(90);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Settled));
    }

    function test_finalize_revertingWinner_excessToLedger() public {
        // 89 normal winners + 1 reverting receiver bidding above clearing.
        RevertingReceiver rr = new RevertingReceiver(auction);
        vm.deal(address(rr), 1 ether);
        rr.bid(1 ether); // high bid, excess = 1 - clearing
        for (uint256 i; i < 89; ++i) {
            _place(_actor(i), RESERVE + i * 0.001 ether);
        }
        _endAuction();
        auction.finalize(90);

        assertEq(nft.balanceOf(address(rr)), 1, "griefer still won the token");
        uint256 clearing = auction.clearingPrice();
        uint256 expectedExcess = 1 ether - clearing;
        assertEq(auction.pendingReturns(address(rr)), expectedExcess, "excess parked in ledger");

        // Withdraw delivers via force-send despite the reverting receiver.
        rr.withdraw();
        assertEq(address(rr).balance, expectedExcess);
        assertEq(auction.pendingReturns(address(rr)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          CANCEL / REFUND-ALL
    //////////////////////////////////////////////////////////////*/

    function test_cancel_thenRefundAll() public {
        _fill90();
        auction.cancelAuction();
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));

        auction.refundAll(90);
        // every bidder made whole
        for (uint256 i; i < 90; ++i) {
            assertEq(_actor(i).balance, RESERVE + i * 0.001 ether);
        }
        assertEq(nft.totalMinted(), 90); // nothing minted
    }

    function test_cancel_batchedRefundAll() public {
        _fill90();
        auction.cancelAuction();
        auction.refundAll(40);
        auction.refundAll(40);
        auction.refundAll(40);
        for (uint256 i; i < 90; ++i) {
            assertEq(_actor(i).balance, RESERVE + i * 0.001 ether);
        }
    }

    function test_cancel_afterFinalizeReverts() public {
        _fill90();
        _endAuction();
        auction.finalize(30); // enters Finalizing
        vm.expectRevert(PanoramaSeason2Auction.NotCancellable.selector);
        auction.cancelAuction();
    }

    function test_refundAll_requiresCancelled() public {
        _fill90();
        vm.expectRevert(PanoramaSeason2Auction.NotCancelled.selector);
        auction.refundAll(90);
    }

    function test_cancel_onlyOwner() public {
        vm.prank(_actor(0));
        vm.expectRevert(Ownable.Unauthorized.selector);
        auction.cancelAuction();
    }

    /*//////////////////////////////////////////////////////////////
                          REENTRANCY / WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_reentrancy_displacedBidder_blocked() public {
        // 89 normal + 1 reentrant bidder at the floor.
        for (uint256 i; i < 89; ++i) {
            _place(_actor(i), RESERVE + 0.001 ether + i * 0.001 ether);
        }
        ReentrantBidder rb = new ReentrantBidder(auction);
        rb.setMode(1); // try to re-enter placeBid on receive
        vm.deal(address(rb), RESERVE);
        rb.bid(RESERVE);

        // Outbid it: displacement force-send triggers receive -> nested placeBid reverts (guard),
        // force-send falls back to selfdestruct so the refund still lands and the outer bid succeeds.
        uint256 newBid = auction.minimumBid();
        vm.deal(_actor(500), newBid);
        vm.prank(_actor(500));
        auction.placeBid{ value: newBid }();

        assertEq(address(rb).balance, RESERVE, "reentrant griefer refunded");
        assertEq(auction.activeBids(), 90);
    }

    function test_withdraw_nothingReverts() public {
        vm.prank(_actor(0));
        vm.expectRevert(PanoramaSeason2Auction.NothingToWithdraw.selector);
        auction.withdraw();
    }

    /*//////////////////////////////////////////////////////////////
                                PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_pause_blocksBids() public {
        auction.setPaused(true);
        vm.deal(_actor(0), RESERVE);
        vm.prank(_actor(0));
        vm.expectRevert(PanoramaSeason2Auction.IsPaused.selector);
        auction.placeBid{ value: RESERVE }();
        // unpausing restores bidding
        auction.setPaused(false);
        _place(_actor(0), RESERVE);
        assertEq(auction.activeBids(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                            GAS BENCHMARKS
    //////////////////////////////////////////////////////////////*/

    function test_gas_placeBid_insert() public {
        vm.deal(_actor(0), RESERVE);
        vm.prank(_actor(0));
        uint256 g = gasleft();
        auction.placeBid{ value: RESERVE }();
        uint256 used = g - gasleft();
        assertLt(used, WRITE_GAS_LIMIT);
        emit log_named_uint("gas placeBid (insert)", used);
    }

    function test_gas_placeBid_displacement() public {
        _fill90();
        uint256 newBid = auction.minimumBid();
        vm.deal(_actor(999), newBid);
        vm.prank(_actor(999));
        uint256 g = gasleft();
        auction.placeBid{ value: newBid }();
        uint256 used = g - gasleft();
        assertLt(used, WRITE_GAS_LIMIT);
        emit log_named_uint("gas placeBid (displacement)", used);
    }

    function test_gas_finalize_batchedFull() public {
        // Descending-order settlement is O(winners) per mint, so all 90 must be batched
        // (a single finalize(90) approaches the block limit). Two batches of 45 each stay
        // well under 15M and settle the whole auction.
        _fill90();
        _endAuction();

        uint256 g = gasleft();
        auction.finalize(45);
        uint256 b1 = g - gasleft();
        assertLt(b1, WRITE_GAS_LIMIT, "finalize batch 1 must fit under 15M");
        emit log_named_uint("gas finalize(45) batch 1", b1);

        g = gasleft();
        auction.finalize(45);
        uint256 b2 = g - gasleft();
        assertLt(b2, WRITE_GAS_LIMIT, "finalize batch 2 must fit under 15M");
        emit log_named_uint("gas finalize(45) batch 2", b2);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Settled));
    }

    function test_gas_finalize_batch45() public {
        _fill90();
        _endAuction();
        uint256 g = gasleft();
        auction.finalize(45);
        uint256 used = g - gasleft();
        assertLt(used, WRITE_GAS_LIMIT);
        emit log_named_uint("gas finalize(45)", used);
    }

    /*//////////////////////////////////////////////////////////////
                                FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_heapRootIsMinimum(uint96[20] memory raw) public {
        uint256 minAmt = type(uint256).max;
        for (uint256 i; i < 20; ++i) {
            uint256 amt = RESERVE + (uint256(raw[i]) % 100 ether);
            if (amt < minAmt) minAmt = amt;
            _place(_actor(i), amt);
        }
        // The heap root must always be the smallest active bid.
        assertEq(auction.lowestActiveBid(), minAmt, "root must be the minimum bid");
    }

    function testFuzz_increaseNeverLowersClearing(uint96 add) public {
        uint256 amount = bound(uint256(add), 1, type(uint96).max - 1 ether);
        _fill90();
        uint256 before = auction.lowestActiveBid();
        // increase a mid bid
        _increase(_actor(45), 46, amount);
        assertGe(auction.lowestActiveBid(), before);
    }

    function testFuzz_endToEndSplitExact(uint8 n) public {
        uint256 winners = bound(n, 1, 12);
        for (uint256 i; i < winners; ++i) {
            _place(_actor(i), RESERVE);
        }
        _endAuction();
        auction.finalize(90);
        uint256 proceeds = winners * uint256(RESERVE);
        assertEq(payoutA.balance + payoutB.balance, proceeds, "split must not strand wei");
        assertEq(payoutA.balance, (proceeds * 5800) / 10_000);
        assertEq(address(auction).balance, 0, "no funds stuck after full settlement");
    }

    /*//////////////////////////////////////////////////////////////
                  M-3: FLOOR-BASED EXTENSION THRESHOLD
    //////////////////////////////////////////////////////////////*/

    function test_minIncreaseForExtension_isBpsOfFloor() public {
        assertEq(auction.minIncreaseForExtension(), 0, "no bids -> 0");
        _place(_actor(0), 1 ether); // floor = 1 ETH
        assertEq(auction.minIncreaseForExtension(), (uint256(1 ether) * INC_BPS) / 10_000); // 0.05
    }

    function test_increaseBid_trivialTopUp_revertsInsideExtensionWindow() public {
        uint32 id = _place(_actor(0), 1 ether); // floor 1 ETH, threshold 0.05
        vm.warp(auction.endTime() - 2 minutes); // inside the 5-min window
        uint64 endBefore = auction.endTime();

        vm.deal(_actor(0), 1 wei);
        vm.prank(_actor(0));
        vm.expectRevert(abi.encodeWithSelector(PanoramaSeason2Auction.BidIncreaseTooLow.selector, 0.05 ether));
        auction.increaseBid{ value: 1 wei }(id);
        assertEq(auction.endTime(), endBefore, "dust top-up must not extend");
        assertEq(auction.extensionCount(), 0);

        (, uint96 amt) = auction.bids(id);
        assertEq(amt, 1 ether, "rejected top-up must not mutate the bid");
    }

    function test_increaseBid_splitRaiseInSmartWallet_cannotBypassExtension() public {
        SplitIncreaseBidder smartWallet = new SplitIncreaseBidder(auction);
        vm.deal(address(smartWallet), 2 ether);
        smartWallet.bid(1 ether);
        uint32 id = 1;
        uint256 part = 0.05 ether - 1;

        vm.warp(auction.endTime() - 1 minutes);
        vm.expectRevert(abi.encodeWithSelector(PanoramaSeason2Auction.BidIncreaseTooLow.selector, 0.05 ether));
        smartWallet.splitIncrease(id, part, part);

        (, uint96 amount) = auction.bids(id);
        assertEq(amount, 1 ether, "atomic split raise must fully revert");
        assertEq(auction.extensionCount(), 0);
    }

    function test_increaseBid_thresholdIsFloorBased_notOwnBid() public {
        // A small floor bid sets the bar; a whale's huge bid does NOT raise their own bar.
        _place(_actor(1), RESERVE); // floor = 0.1 ETH -> threshold 0.005 ETH
        uint32 whaleId = _place(_actor(0), 10 ether); // whale; floor still 0.1
        assertEq(auction.minIncreaseForExtension(), 0.005 ether);

        vm.warp(auction.endTime() - 2 minutes);
        uint64 endBefore = auction.endTime();

        // Whale adds only 5% of the FLOOR (0.005), not 5% of their own 10 ETH (0.5): still extends.
        _increase(_actor(0), whaleId, 0.005 ether);
        assertGt(auction.endTime(), endBefore, "floor-sized top-up extends");
        assertEq(auction.extensionCount(), 1);
    }

    function test_increaseBid_belowFloorThreshold_reverts_whale() public {
        _place(_actor(1), RESERVE); // floor 0.1 -> threshold 0.005
        uint32 whaleId = _place(_actor(0), 10 ether);
        vm.warp(auction.endTime() - 2 minutes);
        uint64 endBefore = auction.endTime();

        vm.deal(_actor(0), 0.005 ether - 1);
        vm.prank(_actor(0));
        vm.expectRevert(abi.encodeWithSelector(PanoramaSeason2Auction.BidIncreaseTooLow.selector, 0.005 ether));
        auction.increaseBid{ value: 0.005 ether - 1 }(whaleId);
        assertEq(auction.endTime(), endBefore, "rejected top-up cannot extend");
        assertEq(auction.extensionCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
              M-1/M-2: PERMISSIONLESS EMERGENCY REFUND
    //////////////////////////////////////////////////////////////*/

    function test_emergencyRefund_beforeGraceReverts() public {
        _fill90();
        _endAuction();
        vm.warp(auction.endTime() + auction.FINALIZE_GRACE() + 1); // past finalize grace, not emergency
        vm.prank(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.NotYetEmergency.selector);
        auction.emergencyRefund(90);
    }

    function test_emergencyRefund_afterSettledReverts() public {
        _fill90();
        _endAuction();
        auction.finalize(90); // Settled
        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);
        vm.prank(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.AlreadySettled.selector);
        auction.emergencyRefund(90);
    }

    /// @dev M-1: auction fills, is NEVER authorized to mint, owner disappears. `finalize` is bricked
    ///      for everyone (even post-grace) yet anyone can still recover every bid in full.
    function test_emergencyRefund_neverAuthorized_permissionlessFullRefund() public {
        _fill90();
        nft.setAuthorizedOperator(address(auction), false); // never authorized
        _endAuction();

        // finalize is bricked for everyone, even after the finalize grace.
        vm.warp(auction.endTime() + auction.FINALIZE_GRACE() + 1);
        vm.prank(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.NotOperatorAuthorized.selector);
        auction.finalize(90);

        // After the emergency grace, a random caller refunds everyone in full.
        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);
        vm.prank(_actor(424_242));
        auction.emergencyRefund(90);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        for (uint256 i; i < 90; ++i) {
            assertEq(_actor(i).balance, RESERVE + i * 0.001 ether, "full refund");
        }
        assertEq(nft.totalMinted(), 90, "nothing minted");
        assertEq(address(auction).balance, 0, "no ETH stranded");
    }

    function test_emergencyRefund_batched() public {
        _fill90();
        nft.setAuthorizedOperator(address(auction), false);
        _endAuction();
        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);

        auction.emergencyRefund(40);
        auction.emergencyRefund(40);
        auction.emergencyRefund(40); // idempotent tail is safe
        for (uint256 i; i < 90; ++i) {
            assertEq(_actor(i).balance, RESERVE + i * 0.001 ether);
        }
        assertEq(address(auction).balance, 0);
    }

    /// @dev M-2(a): owner starts settlement then bricks it (revokes mint auth) while `cancelAuction`
    ///      is already locked out. Emergency recovery still frees the unminted remainder in full,
    ///      leaves already-minted winners with their tokens, and releases their proceeds.
    function test_emergencyRefund_fromFinalizing_bricked_recoversRemainder() public {
        _fill90(); // clearing = RESERVE (floor bid = actor 0)
        _endAuction();

        auction.finalize(30); // mints the highest 30 (actors 60..89) -> #91..#120
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Finalizing));
        assertEq(nft.totalMinted(), 120);
        uint96 cp = auction.clearingPrice();
        assertEq(cp, RESERVE);

        // Owner bricks the remainder and cannot cancel (not Active anymore).
        nft.setAuthorizedOperator(address(auction), false);
        vm.expectRevert(PanoramaSeason2Auction.NotOperatorAuthorized.selector);
        auction.finalize(30);
        vm.expectRevert(PanoramaSeason2Auction.NotCancellable.selector);
        auction.cancelAuction();

        // After the emergency grace, anyone recovers the 60 unminted bids in full.
        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);
        uint256 aBefore = payoutA.balance;
        uint256 bBefore = payoutB.balance;

        vm.prank(_actor(999));
        auction.emergencyRefund(90);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertEq(nft.totalMinted(), 120, "no further mints");

        // The 60 unminted bidders (actors 0..59) are refunded in full.
        for (uint256 i; i < 60; ++i) {
            assertEq(_actor(i).balance, RESERVE + i * 0.001 ether, "unminted bidder fully refunded");
        }
        // The 30 already-minted winners keep their tokens.
        for (uint256 t = 91; t <= 120; ++t) {
            assertTrue(nft.ownerOf(t) != address(0));
        }
        // Proceeds for the 30 completed sales are released to the payout split.
        uint256 proceeds = 30 * uint256(cp);
        assertEq(payoutA.balance - aBefore, (proceeds * 5800) / 10_000);
        assertEq(payoutB.balance - bBefore, proceeds - (proceeds * 5800) / 10_000);
        assertEq(address(auction).balance, 0, "no ETH stranded after emergency recovery");
    }

    function test_emergencyRefund_composesWithPartialOwnerRefund() public {
        // Owner cancels + refunds part, then disappears; emergency completes the rest.
        _fill90();
        auction.cancelAuction();
        auction.refundAll(40); // owner refunds the first 40

        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);
        vm.prank(_actor(999));
        auction.emergencyRefund(90); // shares refundCursor, finishes the remaining 50

        for (uint256 i; i < 90; ++i) {
            assertEq(_actor(i).balance, RESERVE + i * 0.001 ether, "all fully refunded");
        }
        assertEq(address(auction).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
             POST-GRACE OBJECTIVE MINT-CAPABILITY RECOVERY
    //////////////////////////////////////////////////////////////*/

    function test_mintingUnavailable_viewsTrackAuthorizationAndCap() public {
        _place(_actor(0), RESERVE);
        _place(_actor(1), RESERVE + 1);
        _place(_actor(2), RESERVE + 2);

        assertEq(auction.requiredMintCapForSettlement(), 93);
        assertFalse(auction.mintingUnavailable());

        nft.setAuthorizedOperator(address(auction), false);
        assertTrue(auction.mintingUnavailable(), "missing authorization is unavailable");

        nft.setAuthorizedOperator(address(auction), true);
        controller.setSeasonMintCap(2, 2); // cumulative cap 92, but all three winners require 93
        assertTrue(auction.mintingUnavailable(), "insufficient cap is unavailable");

        controller.setSeasonMintCap(2, 3);
        assertFalse(auction.mintingUnavailable(), "exact remaining headroom is sufficient");
    }

    function test_recoverFromMintingUnavailable_finalizeGraceBoundary() public {
        _place(_actor(0), RESERVE);
        nft.setAuthorizedOperator(address(auction), false);
        _endAuction();

        uint256 eligibleAt = uint256(auction.endTime()) + auction.FINALIZE_GRACE();
        vm.warp(eligibleAt - 1);
        vm.prank(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.NotYetMintingUnavailableRecovery.selector);
        auction.recoverFromMintingUnavailable(1);

        vm.warp(eligibleAt);
        vm.expectEmit();
        emit PanoramaSeason2Auction.MintingUnavailableRecoveryStarted(false, 180, 91, 0, 1);
        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(1);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertTrue(auction.refundsComplete());
        assertEq(_actor(0).balance, RESERVE);
    }

    function test_recoverFromMintingUnavailable_healthySettlementRejected() public {
        _place(_actor(0), RESERVE);
        controller.setSeasonMintCap(2, 1); // cumulative cap 91: exactly enough for the sole winner
        _endAuction();
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());

        assertEq(auction.requiredMintCapForSettlement(), 91);
        assertFalse(auction.mintingUnavailable());
        vm.prank(_actor(999));
        vm.expectRevert(PanoramaSeason2Auction.MintingStillAvailable.selector);
        auction.recoverFromMintingUnavailable(1);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Active));
        assertEq(auction.totalEscrowed(), RESERVE);
    }

    function test_recoverFromMintingUnavailable_zeroBatchReverts() public {
        _place(_actor(0), RESERVE);
        nft.setAuthorizedOperator(address(auction), false);
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());

        vm.expectRevert(PanoramaSeason2Auction.ZeroBatch.selector);
        auction.recoverFromMintingUnavailable(0);
    }

    function test_recoverFromMintingUnavailable_neverAuthorizedBatched() public {
        for (uint256 i; i < 5; ++i) {
            _place(_actor(i), RESERVE + i);
        }
        nft.setAuthorizedOperator(address(auction), false);
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());

        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(2);
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertEq(auction.remainingBidCount(), 3);
        assertFalse(auction.refundsComplete());

        vm.prank(_actor(998));
        auction.refundAll(2);
        vm.prank(_actor(997));
        auction.refundAll(2);

        assertTrue(auction.refundsComplete());
        for (uint256 i; i < 5; ++i) {
            assertEq(_actor(i).balance, RESERVE + i, "full refund");
        }
        assertEq(nft.totalMinted(), 90);
        assertEq(address(auction).balance, 0);
        assertEq(auction.requiredMintCapForSettlement(), 0, "terminal view is suppressed");
        assertFalse(auction.mintingUnavailable(), "terminal view is suppressed");
    }

    function test_recoverFromMintingUnavailable_activeInsufficientCap() public {
        for (uint256 i; i < 3; ++i) {
            _place(_actor(i), RESERVE + i);
        }
        controller.setSeasonMintCap(2, 2); // cap 92 < required 93
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());

        vm.expectEmit();
        emit PanoramaSeason2Auction.MintingUnavailableRecoveryStarted(true, 92, 93, 0, 3);
        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(10);

        assertTrue(auction.refundsComplete());
        assertEq(auction.totalEscrowed(), 0);
        assertEq(address(auction).balance, 0);
    }

    function test_recoverFromMintingUnavailable_partialFinalizeThenRevoke() public {
        for (uint256 i; i < 3; ++i) {
            _place(_actor(i), RESERVE + i * 0.01 ether);
        }
        _endAuction();
        auction.finalize(1);
        assertEq(nft.ownerOf(91), _actor(2));
        assertEq(auction.requiredMintCapForSettlement(), 93);

        nft.setAuthorizedOperator(address(auction), false);
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());
        uint256 aBefore = payoutA.balance;
        uint256 bBefore = payoutB.balance;

        vm.expectEmit();
        emit PanoramaSeason2Auction.MintingUnavailableRecoveryStarted(false, 180, 93, 1, 2);
        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(1);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertEq(auction.finalizeCursor(), 1);
        assertEq(auction.remainingBidCount(), 1);
        assertEq(auction.unreleasedProceeds(), RESERVE, "proceeds wait for completed recovery");

        vm.prank(_actor(998));
        auction.refundAll(10);
        assertTrue(auction.refundsComplete());
        assertEq(_actor(0).balance, RESERVE);
        assertEq(_actor(1).balance, RESERVE + 0.01 ether);
        assertEq(nft.ownerOf(91), _actor(2), "already-minted winner keeps token");
        assertEq(payoutA.balance - aBefore, (uint256(RESERVE) * 5800) / 10_000);
        assertEq(payoutB.balance - bBefore, uint256(RESERVE) - (uint256(RESERVE) * 5800) / 10_000);
        assertEq(address(auction).balance, 0);
    }

    function test_recoverFromMintingUnavailable_partialFinalizeThenCapLowered() public {
        for (uint256 i; i < 5; ++i) {
            _place(_actor(i), RESERVE + i);
        }
        _endAuction();
        auction.finalize(2);
        assertEq(auction.finalizeCursor(), 2);
        assertEq(auction.requiredMintCapForSettlement(), 95);

        controller.setSeasonMintCap(2, 2); // current cap 92: enough for minted tokens, not the remaining three
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());
        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(10);

        assertTrue(auction.refundsComplete());
        assertEq(auction.finalizeCursor(), 2);
        assertEq(nft.totalMinted(), 92);
        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.unreleasedProceeds(), 0);
        assertEq(payoutA.balance + payoutB.balance, 2 * uint256(RESERVE));
        assertEq(address(auction).balance, 0);
    }

    function test_recoverFromMintingUnavailable_hostileRecipientsPreserveAccounting() public {
        RevertingReceiver rr = new RevertingReceiver(auction);
        ReentrantBidder rb = new ReentrantBidder(auction);
        vm.deal(address(rr), 1 ether);
        rr.bid(1 ether);
        vm.deal(address(rb), RESERVE);
        rb.bid(RESERVE);
        rb.setMode(2); // re-enter withdraw during the refund push

        nft.setAuthorizedOperator(address(auction), false);
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());
        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(10);

        assertTrue(auction.refundsComplete());
        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.pendingReturns(address(rr)), 1 ether);
        assertEq(auction.pendingReturns(address(rb)), RESERVE);
        assertEq(auction.totalPendingReturns(), 1 ether + RESERVE);
        assertEq(auction.totalLiabilities(), 1 ether + RESERVE);
        assertEq(address(auction).balance, 1 ether + RESERVE);

        rr.withdraw();
        rb.setMode(0);
        vm.prank(address(rb));
        auction.withdraw();
        assertEq(auction.totalPendingReturns(), 0);
        assertEq(auction.totalLiabilities(), 0);
        assertEq(address(auction).balance, 0);
    }

    function testFuzz_recoverFromMintingUnavailable_batchesRemainSolvent(
        uint8 nSeed,
        uint8 batchSeed,
        bool revokeAuthorization
    ) public {
        uint256 n = bound(uint256(nSeed), 1, 20);
        uint256 batch = bound(uint256(batchSeed), 1, n);
        for (uint256 i; i < n; ++i) {
            _place(_actor(i), RESERVE + i);
        }
        if (revokeAuthorization) {
            nft.setAuthorizedOperator(address(auction), false);
        } else {
            controller.setSeasonMintCap(2, n - 1); // one unit short of all winners
        }
        vm.warp(uint256(auction.endTime()) + auction.FINALIZE_GRACE());

        vm.prank(_actor(999));
        auction.recoverFromMintingUnavailable(batch);
        while (!auction.refundsComplete()) {
            vm.prank(_actor(998));
            auction.refundAll(batch);
        }

        for (uint256 i; i < n; ++i) {
            assertEq(_actor(i).balance, RESERVE + i, "every unminted bid fully refunded");
        }
        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertEq(auction.remainingBidCount(), 0);
        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.totalPendingReturns(), 0);
        assertEq(auction.totalLiabilities(), 0);
        assertEq(address(auction).balance, 0);
        assertEq(nft.totalMinted(), 90);
    }

    /*//////////////////////////////////////////////////////////////
              I-3: SETTLEMENT PROPERTY / SOLVENCY FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Random bids + random batch size must settle to: descending id order (highest bid ->
    ///      earliest token), each winner minted exactly once, uniform price, exact split, zero dust.
    function testFuzz_settlement_orderingPriceSolvency(uint96[30] memory raw, uint8 batchSeed) public {
        uint256 n = 30; // < 90 -> undersubscribed, clearing = reserve, every bidder wins one
        uint256[] memory placed = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            // Distinct amounts: 1-ETH spacing dominates the sub-1-ETH jitter, so no ties.
            uint256 amt = RESERVE + i * 1 ether + (uint256(raw[i]) % 1 ether);
            placed[i] = amt;
            _place(_actor(i), amt);
        }
        _endAuction();

        uint256 batch = 1 + (uint256(batchSeed) % 20);
        while (uint256(auction.phase()) < uint256(PanoramaSeason2Auction.Phase.Settled)) {
            auction.finalize(batch);
        }

        // Each of the n bidders won exactly one token; nothing over-minted.
        assertEq(nft.totalMinted(), 90 + n);
        for (uint256 i; i < n; ++i) {
            assertEq(nft.balanceOf(_actor(i)), 1, "each bidder minted exactly once");
        }

        // Ascending token ids <=> descending bids (highest bid -> #91 -> earliest reveal).
        for (uint256 t = 91; t < 90 + n; ++t) {
            uint256 k1 = uint160(nft.ownerOf(t)) - 0x100000;
            uint256 k2 = uint160(nft.ownerOf(t + 1)) - 0x100000;
            assertGe(placed[k1], placed[k2], "ids ascending must be bids descending");
        }

        // Uniform price = reserve (undersubscribed); exact split; no wei stranded.
        assertEq(auction.clearingPrice(), RESERVE);
        uint256 proceeds = n * uint256(RESERVE);
        assertEq(payoutA.balance, (proceeds * 5800) / 10_000);
        assertEq(payoutB.balance, proceeds - (proceeds * 5800) / 10_000);
        assertEq(address(auction).balance, 0, "no funds stuck after settlement");
    }

    /// @dev Oversubscribed: clearing price rises above reserve and every winner pays it uniformly.
    function test_finalize_oversubscribed_clearingAboveReserve() public {
        for (uint256 i; i < 90; ++i) {
            _place(_actor(i), 1 ether + i * 0.01 ether); // 1.00 .. 1.89, floor = 1.00
        }
        // Displace the floor so the 90th-highest (the new clearing) is actor(1) at 1.01.
        uint256 nb = auction.minimumBid();
        _place(_actor(1000), nb);
        assertEq(auction.currentClearingPrice(), 1.01 ether);

        _endAuction();
        auction.finalize(90);

        assertEq(auction.clearingPrice(), 1.01 ether, "clearing = 90th-highest, above reserve");
        uint256 proceeds = 90 * uint256(1.01 ether);
        assertEq(payoutA.balance, (proceeds * 5800) / 10_000);
        assertEq(payoutB.balance, proceeds - (proceeds * 5800) / 10_000);
        assertEq(address(auction).balance, 0, "no funds stuck");
    }

    /*//////////////////////////////////////////////////////////////
                   REMEDIATION REGRESSION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_finalize_competingMintBeforeFirstBatch_revertsWithoutStateChange() public {
        _place(_actor(0), RESERVE);
        _endAuction();

        nft.mintTo(_actor(999)); // consumes #91 outside the auction
        vm.expectRevert(
            abi.encodeWithSelector(PanoramaSeason2Auction.UnexpectedSupply.selector, uint256(90), uint256(91))
        );
        auction.finalize(1);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Active));
        assertEq(auction.finalizeCursor(), 0);
        assertEq(auction.remainingBidCount(), 1);
        assertEq(auction.totalEscrowed(), RESERVE);
    }

    function test_finalize_competingMintBetweenBatches_revertsAndEmergencyRecovers() public {
        for (uint256 i; i < 3; ++i) {
            _place(_actor(i), RESERVE + i * 0.01 ether);
        }
        _endAuction();
        auction.finalize(1); // actor(2) receives #91
        assertEq(nft.ownerOf(91), _actor(2));

        nft.mintTo(_actor(999)); // outsider consumes #92
        vm.expectRevert(
            abi.encodeWithSelector(PanoramaSeason2Auction.UnexpectedSupply.selector, uint256(91), uint256(92))
        );
        auction.finalize(2);

        assertEq(auction.finalizeCursor(), 1);
        assertEq(auction.remainingBidCount(), 2);
        assertEq(auction.unreleasedProceeds(), RESERVE);

        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);
        vm.prank(_actor(777));
        auction.emergencyRefund(10);

        assertTrue(auction.refundsComplete());
        assertEq(auction.remainingBidCount(), 0);
        assertEq(auction.unreleasedProceeds(), 0);
        assertEq(payoutA.balance + payoutB.balance, RESERVE, "completed mint proceeds released");
        assertEq(_actor(0).balance, RESERVE, "unminted floor bid fully refunded");
        assertEq(_actor(1).balance, RESERVE + 0.01 ether, "unminted bid fully refunded");
    }

    function test_finalize_competingMintBetweenFullSaleBatches_cannotStealSlot() public {
        _fill90();
        _endAuction();
        auction.finalize(45);
        assertEq(nft.totalMinted(), 135);

        nft.mintTo(_actor(999)); // consumes #136 and would previously shift/bricks the remaining sale
        vm.expectRevert(
            abi.encodeWithSelector(PanoramaSeason2Auction.UnexpectedSupply.selector, uint256(135), uint256(136))
        );
        auction.finalize(45);

        assertEq(auction.finalizeCursor(), 45);
        assertEq(auction.remainingBidCount(), 45);
        assertEq(nft.totalMinted(), 136);
    }

    function test_supplyMismatch_finalizing_allowsImmediatePermissionlessRecovery() public {
        for (uint256 i; i < 3; ++i) {
            _place(_actor(i), RESERVE + i * 0.01 ether);
        }
        _endAuction();
        auction.finalize(1);

        assertEq(auction.expectedNftSupply(), 91);
        assertFalse(auction.supplyMismatched());
        assertEq(nft.ownerOf(91), _actor(2));
        assertEq(auction.unreleasedProceeds(), RESERVE);

        nft.mintTo(_actor(999)); // outsider consumes auction-expected #92
        assertEq(nft.totalMinted(), 92);
        assertTrue(auction.supplyMismatched());

        uint256 aBefore = payoutA.balance;
        uint256 bBefore = payoutB.balance;
        vm.prank(_actor(777)); // no grace wait once finalization has started
        auction.recoverFromSupplyMismatch(10);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertTrue(auction.refundsComplete());
        assertFalse(auction.supplyMismatched(), "terminal phase must suppress stale mismatch alert");
        assertEq(auction.remainingBidCount(), 0);
        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.unreleasedProceeds(), 0);
        assertEq(_actor(0).balance, RESERVE);
        assertEq(_actor(1).balance, RESERVE + 0.01 ether);

        uint256 completedProceeds = RESERVE;
        assertEq(payoutA.balance - aBefore, (completedProceeds * 5800) / 10_000);
        assertEq(payoutB.balance - bBefore, completedProceeds - (completedProceeds * 5800) / 10_000);
        assertEq(address(auction).balance, auction.totalPendingReturns(), "no proceeds or escrow stranded");
    }

    function test_supplyMismatch_active_arbitraryCallerRecoversImmediately() public {
        _place(_actor(0), RESERVE);
        _place(_actor(1), RESERVE + 1);
        nft.mintTo(_actor(999));

        assertEq(auction.expectedNftSupply(), 90);
        assertTrue(auction.supplyMismatched());
        assertLt(block.timestamp, auction.endTime(), "recovery is immediate, before auction end");

        vm.prank(_actor(777));
        auction.recoverFromSupplyMismatch(10);

        assertEq(uint256(auction.phase()), uint256(PanoramaSeason2Auction.Phase.Cancelled));
        assertTrue(auction.refundsComplete());
        assertFalse(auction.supplyMismatched(), "terminal phase must suppress stale mismatch alert");
        assertEq(_actor(0).balance, RESERVE);
        assertEq(_actor(1).balance, RESERVE + 1);
        assertEq(address(auction).balance, 0);
    }

    function test_supplyMismatch_placeBidFailsClosedWithoutAcceptingETH() public {
        nft.mintTo(_actor(999));
        address bidder = _actor(777);
        vm.deal(bidder, RESERVE);

        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(PanoramaSeason2Auction.UnexpectedSupply.selector, uint256(90), uint256(91))
        );
        auction.placeBid{ value: RESERVE }();

        assertEq(bidder.balance, RESERVE, "reverted bid value must remain with bidder");
        assertEq(address(auction).balance, 0);
        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.remainingBidCount(), 0);
        assertEq(auction.nextBidId(), 1, "rejected bid must not consume an id");
    }

    function test_supplyMismatch_increaseBidFailsClosedWithoutAcceptingETH() public {
        address bidder = _actor(0);
        uint32 bidId = _place(bidder, RESERVE);
        nft.mintTo(_actor(999));
        uint256 topUp = 0.01 ether;
        vm.deal(bidder, topUp);

        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(PanoramaSeason2Auction.UnexpectedSupply.selector, uint256(90), uint256(91))
        );
        auction.increaseBid{ value: topUp }(bidId);

        (, uint96 amount) = auction.bids(bidId);
        assertEq(amount, RESERVE, "rejected increase must not mutate bid");
        assertEq(bidder.balance, topUp, "reverted top-up must remain with bidder");
        assertEq(address(auction).balance, RESERVE);
        assertEq(auction.totalEscrowed(), RESERVE);
        assertEq(auction.remainingBidCount(), 1);
    }

    function test_supplyMismatch_recoveryRequiresActualMismatch() public {
        assertEq(auction.expectedNftSupply(), 90);
        assertFalse(auction.supplyMismatched());

        vm.expectRevert(PanoramaSeason2Auction.SupplyNotMismatched.selector);
        auction.recoverFromSupplyMismatch(1);

        _place(_actor(0), RESERVE);
        _place(_actor(1), RESERVE + 1);
        _endAuction();
        auction.finalize(1);
        assertEq(auction.expectedNftSupply(), 91);
        assertFalse(auction.supplyMismatched());

        vm.prank(_actor(777));
        vm.expectRevert(PanoramaSeason2Auction.SupplyNotMismatched.selector);
        auction.recoverFromSupplyMismatch(1);
    }

    function test_finalize_wrongReturnedTokenId_revertsAtomically() public {
        WrongIdPanorama wrong = new WrongIdPanorama();
        uint64 start = uint64(block.timestamp + 1 hours);
        PanoramaSeason2Auction guarded =
            new PanoramaSeason2Auction(address(wrong), RESERVE, INC_BPS, start, DURATION, payoutA, payoutB);
        wrong.setAuthorizedOperator(address(guarded), true);
        vm.warp(start);

        vm.deal(_actor(0), RESERVE);
        vm.prank(_actor(0));
        guarded.placeBid{ value: RESERVE }();
        vm.warp(guarded.endTime() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(PanoramaSeason2Auction.UnexpectedTokenId.selector, uint256(91), uint256(92))
        );
        guarded.finalize(1);

        assertEq(wrong.totalMinted(), 90, "mock mint must roll back with settlement");
        assertEq(uint256(guarded.phase()), uint256(PanoramaSeason2Auction.Phase.Active));
        assertEq(guarded.remainingBidCount(), 1);
        assertEq(guarded.totalEscrowed(), RESERVE);
    }

    function test_recovery_mixedEmergencyThenRefundAll_releasesPartialFinalizeProceeds() public {
        _fill90();
        _endAuction();
        auction.finalize(30);
        uint256 expectedProceeds = 30 * uint256(RESERVE);
        assertEq(auction.unreleasedProceeds(), expectedProceeds);

        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE() + 1);
        vm.prank(_actor(10_000));
        auction.emergencyRefund(1);
        assertFalse(auction.refundsComplete());

        vm.prank(_actor(10_001)); // refundAll is deliberately permissionless after cancellation
        auction.refundAll(200);

        assertTrue(auction.refundsComplete());
        assertEq(auction.remainingBidCount(), 0);
        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.unreleasedProceeds(), 0);
        assertEq(payoutA.balance, (expectedProceeds * 5800) / 10_000);
        assertEq(payoutB.balance, expectedProceeds - (expectedProceeds * 5800) / 10_000);
        assertEq(address(auction).balance, auction.totalPendingReturns(), "no proceeds stranded");
    }

    function test_emergencyRefund_usesImmutableAbsoluteDeadlineBoundary() public {
        _place(_actor(0), RESERVE);
        vm.warp(auction.absoluteEndTime() + auction.EMERGENCY_GRACE());
        vm.expectRevert(PanoramaSeason2Auction.NotYetEmergency.selector);
        auction.emergencyRefund(1);

        vm.warp(block.timestamp + 1);
        vm.prank(_actor(999));
        auction.emergencyRefund(1);
        assertTrue(auction.refundsComplete());
        assertEq(_actor(0).balance, RESERVE);
    }

    function test_cancel_refundAllIsImmediatelyPermissionless() public {
        _place(_actor(0), RESERVE);
        _place(_actor(1), RESERVE + 1);
        auction.cancelAuction();

        vm.prank(_actor(999));
        auction.refundAll(10);

        assertTrue(auction.refundsComplete());
        assertEq(_actor(0).balance, RESERVE);
        assertEq(_actor(1).balance, RESERVE + 1);
        assertEq(auction.remainingBidCount(), 0);
    }

    function test_cancel_withoutBids_completesRecoveryImmediately() public {
        auction.cancelAuction();
        assertTrue(auction.refundsComplete());
        assertEq(auction.remainingBidCount(), 0);
        assertEq(auction.totalLiabilities(), 0);
    }

    function test_refundAll_revertingAndReentrantRecipient_preservesSolvency() public {
        ReentrantBidder rb = new ReentrantBidder(auction);
        vm.deal(address(rb), RESERVE);
        rb.bid(RESERVE);
        rb.setMode(2); // nested withdraw attempt makes the push fail

        auction.cancelAuction();
        vm.prank(_actor(999));
        auction.refundAll(1);

        assertEq(auction.totalEscrowed(), 0);
        assertEq(auction.pendingReturns(address(rb)), RESERVE);
        assertEq(auction.totalPendingReturns(), RESERVE);
        assertEq(address(auction).balance, RESERVE);

        vm.prank(address(rb));
        auction.withdraw();
        assertEq(auction.totalPendingReturns(), 0);
        assertEq(address(auction).balance, 0);
        assertEq(address(rb).balance, RESERVE);
    }

    function test_terminalViews_areCompactAfterPartialAndFullFinalize() public {
        for (uint256 i; i < 3; ++i) {
            _place(_actor(i), RESERVE + i);
        }
        _endAuction();
        auction.finalize(1);

        assertEq(auction.activeBids(), 2);
        assertEq(auction.remainingBidCount(), 2);
        assertEq(auction.activeBidCount(_actor(2)), 0);
        (uint32[] memory ids, address[] memory bidders, uint96[] memory amounts) = auction.getBids();
        assertEq(ids.length, 2);
        assertEq(bidders.length, 2);
        assertEq(amounts.length, 2);
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(ids[i] != 0 && bidders[i] != address(0) && amounts[i] != 0, "no deleted slots exposed");
        }
        (uint32[] memory wonIds,) = auction.bidsOf(_actor(2));
        assertEq(wonIds.length, 0);

        auction.finalize(10);
        assertEq(auction.activeBids(), 0);
        assertEq(auction.remainingBidCount(), 0);
        (ids, bidders, amounts) = auction.getBids();
        assertEq(ids.length, 0);
        assertEq(bidders.length, 0);
        assertEq(amounts.length, 0);
        assertFalse(auction.isFull());
    }

    function test_terminalViews_areCompactDuringCancellationRefunds() public {
        for (uint256 i; i < 3; ++i) {
            _place(_actor(i), RESERVE + i);
        }
        auction.cancelAuction();
        auction.refundAll(1);

        assertEq(auction.activeBids(), 2);
        (uint32[] memory ids, address[] memory bidders, uint96[] memory amounts) = auction.getBids();
        assertEq(ids.length, 2);
        assertEq(bidders.length, 2);
        assertEq(amounts.length, 2);

        auction.refundAll(10);
        assertTrue(auction.refundsComplete());
        assertEq(auction.activeBids(), 0);
        (ids,,) = auction.getBids();
        assertEq(ids.length, 0);
    }

    function test_equalBids_earliestBidIdGetsEarliestReveal() public {
        _place(_actor(0), 1 ether); // id 1
        _place(_actor(1), 1 ether); // id 2
        _place(_actor(2), 1 ether); // id 3
        _endAuction();
        auction.finalize(3);

        assertEq(nft.ownerOf(91), _actor(0));
        assertEq(nft.ownerOf(92), _actor(1));
        assertEq(nft.ownerOf(93), _actor(2));
    }

    function test_equalFloorBids_displacementEvictsLatestNotEarliest() public {
        for (uint256 i; i < 90; ++i) {
            _place(_actor(i), RESERVE);
        }
        assertEq(auction.lowestActiveBid(), RESERVE);

        uint256 challengerAmount = auction.minimumBid();
        _place(_actor(999), challengerAmount);

        (address firstBidder,) = auction.bids(1);
        (address latestBidder,) = auction.bids(90);
        assertEq(firstBidder, _actor(0), "earliest equal floor bid must survive");
        assertEq(latestBidder, address(0), "latest equal floor bid must be displaced first");
        assertEq(_actor(89).balance, RESERVE, "latest tied bidder refunded");

        _endAuction();
        auction.finalize(90);
        assertEq(nft.ownerOf(91), _actor(999), "strictly higher challenger first");
        assertEq(nft.ownerOf(92), _actor(0), "earliest retained tie next");
        assertEq(nft.ownerOf(180), _actor(88), "latest retained tie last");
    }

    function test_equalizedByIncrease_earliestBidStillWinsTie() public {
        _place(_actor(0), 1 ether); // earlier id already at target
        uint32 later = _place(_actor(1), RESERVE);
        _increase(_actor(1), later, 0.9 ether); // equal amount reached by increase
        _endAuction();
        auction.finalize(2);

        assertEq(nft.ownerOf(91), _actor(0));
        assertEq(nft.ownerOf(92), _actor(1));
    }

    function test_bpsMath_roundsUpForMinimumBidAndExtensionThreshold() public {
        uint64 start = uint64(block.timestamp + 1 hours);
        // Odd tail above the 0.1 ETH reserve floor keeps ceil(1 bp) strictly above floor division.
        uint96 oddReserve = 0.1 ether + 10_001;
        uint256 ceilIncrement = (uint256(oddReserve) + 10_000 - 1) / 10_000;
        assertEq(ceilIncrement, uint256(oddReserve) / 10_000 + 1, "premise: floor division would understate");

        PanoramaSeason2Auction tiny =
            new PanoramaSeason2Auction(address(nft), oddReserve, 1, start, DURATION, payoutA, payoutB);
        nft.setAuthorizedOperator(address(tiny), true);
        vm.warp(start);

        for (uint256 i; i < 90; ++i) {
            vm.deal(_actor(i), oddReserve);
            vm.prank(_actor(i));
            tiny.placeBid{ value: oddReserve }();
        }

        assertEq(tiny.minimumBid(), uint256(oddReserve) + ceilIncrement, "minimum uses ceiling bps math");
        assertEq(tiny.minIncreaseForExtension(), ceilIncrement, "extension threshold uses the same ceil math");

        vm.warp(tiny.endTime() - 1 minutes);
        vm.deal(_actor(0), 1);
        vm.prank(_actor(0));
        vm.expectRevert(abi.encodeWithSelector(PanoramaSeason2Auction.BidIncreaseTooLow.selector, ceilIncrement));
        tiny.increaseBid{ value: 1 }(1);
    }

    function test_surplusETH_cannotRescueUntilTerminal_andNeverTouchesLiabilities() public {
        _place(_actor(0), RESERVE);
        AuctionForceETH donor = new AuctionForceETH{ value: 1 ether }();
        donor.force(payable(address(auction)));

        assertEq(auction.totalLiabilities(), RESERVE);
        assertEq(auction.surplusETH(), 1 ether);
        vm.expectRevert(PanoramaSeason2Auction.RecoveryIncomplete.selector);
        auction.rescueSurplusETH(_actor(999));

        auction.cancelAuction();
        vm.prank(_actor(777));
        auction.refundAll(1);
        assertTrue(auction.refundsComplete());
        assertEq(auction.totalLiabilities(), 0);
        assertEq(address(auction).balance, 1 ether);

        vm.prank(_actor(999));
        vm.expectRevert(Ownable.Unauthorized.selector);
        auction.rescueSurplusETH(_actor(999));

        auction.rescueSurplusETH(_actor(999));
        assertEq(_actor(999).balance, 1 ether);
        assertEq(address(auction).balance, 0);
    }

    function test_surplusETH_rescueLeavesFailedRefundLedgerFullyBacked() public {
        RevertingReceiver rr = new RevertingReceiver(auction);
        vm.deal(address(rr), 1 ether);
        rr.bid(1 ether);
        AuctionForceETH donor = new AuctionForceETH{ value: 2 ether }();
        donor.force(payable(address(auction)));

        auction.cancelAuction();
        auction.refundAll(1); // refund push fails and becomes a pull-payment liability
        assertEq(auction.totalPendingReturns(), 1 ether);
        assertEq(auction.surplusETH(), 2 ether);

        auction.rescueSurplusETH(_actor(999));
        assertEq(_actor(999).balance, 2 ether);
        assertEq(address(auction).balance, 1 ether);
        assertEq(auction.totalLiabilities(), 1 ether);

        rr.withdraw();
        assertEq(address(rr).balance, 1 ether);
        assertEq(address(auction).balance, 0);
    }

    function test_payableOwnershipHandoverETH_isTrackedAsSurplusAndRecoverable() public {
        address pendingOwner = _actor(555);
        vm.deal(pendingOwner, 0.25 ether);
        vm.prank(pendingOwner);
        auction.requestOwnershipHandover{ value: 0.25 ether }();

        assertEq(address(auction).balance, 0.25 ether);
        assertEq(auction.totalLiabilities(), 0);
        assertEq(auction.surplusETH(), 0.25 ether);
        vm.expectRevert(PanoramaSeason2Auction.RecoveryIncomplete.selector);
        auction.rescueSurplusETH(_actor(999));

        auction.cancelAuction(); // zero bids completes recovery immediately
        auction.rescueSurplusETH(_actor(999));
        assertEq(_actor(999).balance, 0.25 ether);
        assertEq(address(auction).balance, 0);
    }

    function test_rescueAccidentalERC20AndERC721() public {
        AuctionTestERC20 token = new AuctionTestERC20();
        token.mint(address(auction), 123 ether);

        address recipient = _actor(999);
        auction.rescueERC20(address(token), recipient, 123 ether);
        assertEq(token.balanceOf(recipient), 123 ether);
        assertEq(token.balanceOf(address(auction)), 0);

        nft.transferFrom(owner, address(auction), 1);
        assertEq(nft.ownerOf(1), address(auction));
        auction.rescueERC721(address(nft), recipient, 1);
        assertEq(nft.ownerOf(1), recipient);
    }
}
