// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/src/Test.sol";
import { Vm } from "forge-std/src/Vm.sol";
import { Panorama } from "../src/Panorama.sol";
import { PanoramaMintController } from "../src/PanoramaMintController.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";

/// @dev Bounded actor that drives random-but-valid placeBid/increaseBid calls at the auction, plus
///      permissionless settlement/emergency actions so the invariants are checked through the whole
///      lifecycle (bidding -> finalize -> settled, and bidding -> stuck -> emergency refund).
contract AuctionHandler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    PanoramaSeason2Auction public auction;
    address[] public actors;

    constructor(PanoramaSeason2Auction a, address[] memory actors_) {
        auction = a;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function placeBid(uint256 actorSeed, uint256 amtSeed) external {
        address who = actors[actorSeed % actors.length];
        if (auction.activeBidCount(who) >= auction.MAX_BIDS_PER_WALLET()) return;
        uint256 amount = auction.minimumBid() + (amtSeed % 5 ether);
        vm.deal(who, amount);
        vm.prank(who);
        try auction.placeBid{ value: amount }() { } catch { }
    }

    function increaseBid(uint256 actorSeed, uint256 amtSeed) external {
        address who = actors[actorSeed % actors.length];
        (uint32[] memory ids,) = auction.bidsOf(who);
        if (ids.length == 0) return;
        uint32 id = ids[amtSeed % ids.length];
        uint256 amount = 1 + (amtSeed % 1 ether);
        vm.deal(who, amount);
        vm.prank(who);
        try auction.increaseBid{ value: amount }(id) { } catch { }
    }

    /// @dev End the auction and settle a batch via the permissionless (post-grace) path.
    function endAndFinalize(uint256 batchSeed) external {
        uint256 graceEnd = uint256(auction.endTime()) + auction.FINALIZE_GRACE() + 1;
        if (block.timestamp < graceEnd) vm.warp(graceEnd);
        try auction.finalize(1 + (batchSeed % 30)) { } catch { }
    }

    /// @dev Trigger the permissionless emergency refund (covers the stuck-settlement paths).
    function triggerEmergency(uint256 batchSeed) external {
        uint256 graceEnd = uint256(auction.absoluteEndTime()) + auction.EMERGENCY_GRACE() + 1;
        if (block.timestamp < graceEnd) vm.warp(graceEnd);
        try auction.emergencyRefund(1 + (batchSeed % 30)) { } catch { }
    }

    /// @dev Exercise owner cancellation followed by permissionless batched refunds.
    function cancelAndRefund(uint256 batchSeed) external {
        if (uint8(auction.phase()) == 0) {
            vm.prank(auction.owner());
            try auction.cancelAuction() { } catch { }
        }
        if (uint8(auction.phase()) == 3) {
            try auction.refundAll(1 + (batchSeed % 30)) { } catch { }
        }
    }

    /// @dev Model a competing authorized/owner mint before or between settlement batches.
    function competingMint(uint256 actorSeed) external {
        Panorama targetNft = Panorama(address(auction.nft()));
        if (targetNft.totalMinted() >= targetNft.mintCap()) return;
        vm.prank(auction.owner());
        try targetNft.mintTo(actors[actorSeed % actors.length]) returns (uint256) { } catch { }
    }

    /// @dev Exercise the dedicated immediate/grace-gated supply-mismatch recovery path.
    function recoverSupplyMismatch(uint256 batchSeed) external {
        try auction.recoverFromSupplyMismatch(1 + (batchSeed % 30)) { } catch { }
    }

    /// @dev Objectively remove one of the two settlement capabilities covered by the post-grace path.
    function makeMintingUnavailable(uint256 mode) external {
        uint8 ph = uint8(auction.phase());
        if (ph != 0 && ph != 1) return;

        Panorama targetNft = Panorama(address(auction.nft()));
        address admin = auction.owner();
        if (mode % 2 == 0) {
            vm.prank(admin);
            targetNft.setAuthorizedOperator(address(auction), false);
        } else {
            PanoramaMintController controller = PanoramaMintController(targetNft.mintController());
            vm.prank(admin);
            controller.setSeasonMintCap(2, 0);
        }
    }

    /// @dev Exercise objective unavailable-mint recovery at the exact finalize-grace boundary.
    function recoverMintingUnavailable(uint256 batchSeed) external {
        uint256 eligibleAt = uint256(auction.endTime()) + auction.FINALIZE_GRACE();
        if (block.timestamp < eligibleAt) vm.warp(eligibleAt);
        try auction.recoverFromMintingUnavailable(1 + (batchSeed % 30)) { } catch { }
    }
}

contract PanoramaSeason2AuctionInvariants is Test {
    Panorama nft;
    PanoramaMintController controller;
    PanoramaSeason2Auction auction;
    AuctionHandler handler;

    address[] actors;

    function setUp() public {
        vm.warp(1_700_000_000);

        nft = new Panorama();
        controller = new PanoramaMintController();
        nft.setMintController(address(controller));
        controller.setSeasonMintCap(1, 90);
        nft.mintTo(address(this), 90);
        controller.setSeasonMintCap(2, 90);

        uint64 start = uint64(block.timestamp + 1 hours);
        auction = new PanoramaSeason2Auction(address(nft), 0.1 ether, 500, start, 24 hours, address(0xA), address(0xB));
        nft.setAuthorizedOperator(address(auction), true);
        vm.warp(start);

        for (uint256 i; i < 30; ++i) {
            actors.push(address(uint160(0x20000 + i)));
        }
        handler = new AuctionHandler(auction, actors);

        targetContract(address(handler));
    }

    /*//////////////////////////////////////////////////////////////
                    UNIVERSAL (hold in every phase)
    //////////////////////////////////////////////////////////////*/

    /// @dev The auction never mints beyond Season 2's 90 units (#91..#180), and never below the
    ///      Season 1 baseline. Catches any over-mint / double-mint in settlement.
    function invariant_neverOverMint() public view {
        assertLe(nft.totalMinted(), 180, "must never mint past #180");
        assertGe(nft.totalMinted(), 90, "season 1 baseline preserved");
    }

    /// @dev The contract balance always backs every tracked liability, in every phase.
    function invariant_pullLedgerBacked() public view {
        assertGe(address(auction).balance, auction.totalLiabilities(), "all liabilities must be backed");
        assertGe(address(auction).balance, auction.totalPendingReturns(), "pull-ledger must always be backed");
    }

    /// @dev No handler donates ETH, so balance and tracked liabilities must match exactly. This is
    ///      the useful solvency direction: a deficit is forbidden; a real forced donation would be surplus.
    function invariant_solvency() public view {
        assertEq(address(auction).balance, auction.totalLiabilities(), "balance != tracked liabilities");
        assertEq(auction.totalEscrowed(), _activeBidSum(), "escrow aggregate != live bids");
        assertEq(auction.totalPendingReturns(), _pendingSum(), "pending aggregate != per-user ledger");
    }

    /// @dev Remaining counts and terminal completion fields stay internally consistent.
    function invariant_progressAccounting() public view {
        uint8 ph = uint8(auction.phase());
        (uint32[] memory ids,,) = auction.getBids();
        assertEq(ids.length, auction.remainingBidCount(), "compact live view length mismatch");

        if (ph == 0) {
            assertEq(auction.finalizeCursor(), 0, "active auction has finalize progress");
            assertEq(auction.winnerCount(), 0, "active auction has frozen winners");
            assertEq(
                auction.requiredMintCapForSettlement(),
                auction.expectedNftSupply() + auction.remainingBidCount(),
                "active required cap mismatch"
            );
        } else if (ph == 1) {
            assertEq(
                auction.finalizeCursor() + auction.remainingBidCount(),
                auction.winnerCount(),
                "finalizing progress mismatch"
            );
            assertEq(
                auction.requiredMintCapForSettlement(),
                auction.expectedNftSupply() + auction.remainingBidCount(),
                "finalizing required cap mismatch"
            );
        } else if (ph == 2) {
            assertEq(auction.remainingBidCount(), 0, "settled auction has live bids");
            assertEq(auction.finalizeCursor(), auction.winnerCount(), "settled cursor mismatch");
            assertEq(auction.unreleasedProceeds(), 0, "settled proceeds unreleased");
        }

        if (ph == 2 || ph == 3) {
            assertEq(auction.requiredMintCapForSettlement(), 0, "terminal required cap not suppressed");
            assertFalse(auction.mintingUnavailable(), "terminal unavailable flag not suppressed");
        }

        if (auction.refundsComplete()) {
            assertEq(ph, 3, "refund completion outside cancellation");
            assertEq(auction.remainingBidCount(), 0, "completed recovery has live bids");
            assertEq(auction.totalEscrowed(), 0, "completed recovery has escrow");
            assertEq(auction.unreleasedProceeds(), 0, "completed recovery has proceeds");
        }
    }

    /*//////////////////////////////////////////////////////////////
                BIDDING-PHASE ONLY (heap is live)
    //////////////////////////////////////////////////////////////*/

    /// @dev Heap size is bounded and equals the reported active bid count.
    function invariant_sizeBounded() public view {
        uint256 n = auction.activeBids();
        assertLe(n, auction.MAX_UNITS(), "heap over capacity");
        (uint32[] memory ids,,) = auction.getBids();
        assertEq(ids.length, n, "getBids length mismatch");
    }

    /// @dev The min-heap property holds: every parent <= its children. (Only while bidding is live;
    ///      settlement deletes bid entries in place, which intentionally breaks the ordering.)
    function invariant_heapProperty() public view {
        if (uint8(auction.phase()) != 0) return;
        (,, uint96[] memory amounts) = auction.getBids();
        uint256 n = amounts.length;
        for (uint256 k = 1; k < n; ++k) {
            uint256 heapIdx = k + 1; // 1-based heap index of amounts[k]
            uint256 parentArr = (heapIdx / 2) - 1;
            assertLe(amounts[parentArr], amounts[k], "min-heap property violated");
        }
    }

    /// @dev heapPos is a bijection: the id at heap position i maps back to i.
    function invariant_bijection() public view {
        if (uint8(auction.phase()) != 0) return;
        (uint32[] memory ids,,) = auction.getBids();
        for (uint256 k; k < ids.length; ++k) {
            assertEq(auction.heapPos(ids[k]), k + 1, "heapPos bijection broken");
        }
    }

    /// @dev Per-wallet counts match the compact live view in every phase and stay within the cap.
    function invariant_countAndFloor() public view {
        (, address[] memory bidders, uint96[] memory amounts) = auction.getBids();
        uint256 reserve = auction.reservePrice();

        for (uint256 k; k < amounts.length; ++k) {
            assertGe(amounts[k], reserve, "active bid below reserve");
        }

        for (uint256 i; i < actors.length; ++i) {
            uint256 realCount;
            for (uint256 k; k < bidders.length; ++k) {
                if (bidders[k] == actors[i]) ++realCount;
            }
            assertEq(auction.activeBidCount(actors[i]), realCount, "activeBidCount mismatch");
            assertLe(realCount, auction.MAX_BIDS_PER_WALLET(), "over per-wallet cap");
        }
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    function _activeBidSum() internal view returns (uint256 sum) {
        (,, uint96[] memory amounts) = auction.getBids();
        for (uint256 k; k < amounts.length; ++k) {
            sum += amounts[k];
        }
    }

    function _pendingSum() internal view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += auction.pendingReturns(actors[i]);
        }
    }
}
