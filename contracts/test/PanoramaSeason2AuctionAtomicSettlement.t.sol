// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/src/Test.sol";
import { AuctionSettlementBatchLib } from "../script/SettleAuctionAtomic.s.sol";

contract AuctionSettlementBatchHarness {
    function finalizeCallCount(uint256 winners, uint256 finalized, uint256 batch) external pure returns (uint256) {
        return AuctionSettlementBatchLib.finalizeCallCount(winners, finalized, batch);
    }
}

contract PanoramaSeason2AuctionAtomicSettlementTest is Test {
    AuctionSettlementBatchHarness internal harness;

    function setUp() public {
        harness = new AuctionSettlementBatchHarness();
    }

    function test_finalizeCallCount_freshAuction() public view {
        assertEq(harness.finalizeCallCount(90, 0, 45), 2);
        assertEq(harness.finalizeCallCount(90, 0, 30), 3);
    }

    function test_finalizeCallCount_partialRetryUsesRemainingWinners() public view {
        assertEq(harness.finalizeCallCount(90, 45, 45), 1, "one batch remains, not two total-winner batches");
        assertEq(harness.finalizeCallCount(90, 46, 45), 1);
        assertEq(harness.finalizeCallCount(90, 30, 45), 2);
        assertEq(harness.finalizeCallCount(90, 89, 45), 1);
        assertEq(harness.finalizeCallCount(90, 90, 45), 0);
    }

    function test_finalizeCallCount_rejectsInvalidInputs() public {
        vm.expectRevert(bytes("INVALID_FINALIZE_BATCH"));
        harness.finalizeCallCount(90, 0, 0);

        vm.expectRevert(bytes("INVALID_FINALIZE_PROGRESS"));
        harness.finalizeCallCount(89, 90, 45);
    }

    function testFuzz_finalizeCallCount_matchesCeilingOfRemaining(
        uint8 winnersSeed,
        uint8 cursorSeed,
        uint8 batchSeed
    ) public view {
        uint256 winners = bound(uint256(winnersSeed), 1, 90);
        uint256 finalized = bound(uint256(cursorSeed), 0, winners);
        uint256 batch = bound(uint256(batchSeed), 1, 90);
        uint256 remaining = winners - finalized;
        uint256 expected = remaining == 0 ? 0 : ((remaining - 1) / batch) + 1;
        assertEq(harness.finalizeCallCount(winners, finalized, batch), expected);
    }
}
