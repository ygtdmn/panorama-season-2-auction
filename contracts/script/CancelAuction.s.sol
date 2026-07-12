// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { BaseScript } from "./Base.s.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";

/// @notice Cancels an Active auction. If bids remain, cancellation immediately enables the
///         permissionless `refundAll` process; if there are none, recovery completes immediately.
///
/// Required env:
///   PANORAMA_AUCTION_ADDRESS
///   PANORAMA_AUCTION_RUNTIME_CODEHASH - independently verified deployed runtime code hash
contract CancelAuction is BaseScript {
    uint256 internal constant MAINNET_CHAIN_ID = 1;

    function run() public {
        require(block.chainid == MAINNET_CHAIN_ID, "WRONG_CHAIN_ID");

        address auctionAddress = vm.envAddress("PANORAMA_AUCTION_ADDRESS");
        bytes32 expectedCodehash = vm.envBytes32("PANORAMA_AUCTION_RUNTIME_CODEHASH");
        require(auctionAddress != address(0) && auctionAddress.code.length != 0, "INVALID_AUCTION");
        require(expectedCodehash != bytes32(0) && auctionAddress.codehash == expectedCodehash, "CODEHASH_MISMATCH");

        PanoramaSeason2Auction auction = PanoramaSeason2Auction(auctionAddress);
        require(auction.owner() == broadcaster, "BROADCASTER_NOT_AUCTION_OWNER");
        require(auction.phase() == PanoramaSeason2Auction.Phase.Active, "AUCTION_NOT_ACTIVE");
        require(auction.finalizeCursor() == 0 && auction.refundCursor() == 0, "PROCESSING_ALREADY_STARTED");
        uint256 bidsBefore = auction.activeBids();

        vm.startBroadcast(privateKey);
        auction.cancelAuction();
        vm.stopBroadcast();

        require(auction.phase() == PanoramaSeason2Auction.Phase.Cancelled, "CANCELLATION_FAILED");
        if (bidsBefore == 0) {
            require(auction.refundsComplete(), "EMPTY_RECOVERY_NOT_COMPLETE");
        } else {
            require(!auction.refundsComplete() && auction.activeBids() == bidsBefore, "BID_REFUND_STATE_MISMATCH");
        }
        require(auctionAddress.codehash == expectedCodehash, "POST_CODEHASH_MISMATCH");
    }
}
