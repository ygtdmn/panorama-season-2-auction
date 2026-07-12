// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { BaseScript } from "./Base.s.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";
import { IPanorama } from "../src/interfaces/IPanorama.sol";

interface IRefundOwnableView {
    function owner() external view returns (address);
}

/// @notice After cancellation, permissionlessly refunds every remaining bid in bounded batches.
///         Uses the explicit completion flag because `activeBids()` now decreases as bids process.
///
/// Required env:
///   PANORAMA_AUCTION_ADDRESS
///   PANORAMA_AUCTION_RUNTIME_CODEHASH - independently verified deployed runtime code hash
/// Optional env:
///   PANORAMA_REFUND_BATCH              - heap slots per batch (default: 45; maximum: 90)
contract RefundAllAuction is BaseScript {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    uint256 internal constant MAX_UNITS = 90;

    function run() public {
        require(block.chainid == MAINNET_CHAIN_ID, "WRONG_CHAIN_ID");

        address auctionAddress = vm.envAddress("PANORAMA_AUCTION_ADDRESS");
        bytes32 expectedCodehash = vm.envBytes32("PANORAMA_AUCTION_RUNTIME_CODEHASH");
        uint256 batch = vm.envOr("PANORAMA_REFUND_BATCH", uint256(45));

        require(auctionAddress != address(0) && auctionAddress.code.length != 0, "INVALID_AUCTION");
        require(expectedCodehash != bytes32(0) && auctionAddress.codehash == expectedCodehash, "CODEHASH_MISMATCH");
        require(batch > 0 && batch <= MAX_UNITS, "INVALID_REFUND_BATCH");

        PanoramaSeason2Auction auction = PanoramaSeason2Auction(auctionAddress);
        require(auction.phase() == PanoramaSeason2Auction.Phase.Cancelled, "AUCTION_NOT_CANCELLED");
        IPanorama nft = auction.nft();
        require(address(nft).code.length != 0, "INVALID_NFT");

        // If authorization happened before cancellation, this run also removes the now-unneeded
        // mint power. A permissionless caller can still use refundAll directly without this script.
        if (nft.authorizedOperators(auctionAddress)) {
            require(IRefundOwnableView(address(nft)).owner() == broadcaster, "BROADCASTER_NOT_NFT_OWNER");
        }

        vm.startBroadcast(privateKey);

        while (!auction.refundsComplete()) {
            uint256 cursorBefore = auction.refundCursor();
            auction.refundAll(batch);
            require(auction.refundsComplete() || auction.refundCursor() > cursorBefore, "REFUND_MADE_NO_PROGRESS");
        }
        if (nft.authorizedOperators(auctionAddress)) {
            nft.setAuthorizedOperator(auctionAddress, false);
        }

        vm.stopBroadcast();

        require(auction.phase() == PanoramaSeason2Auction.Phase.Cancelled, "POST_PHASE_MISMATCH");
        require(auction.refundsComplete(), "REFUNDS_INCOMPLETE");
        require(auction.activeBids() == 0 && auction.totalEscrowed() == 0, "BID_LIABILITY_REMAINS");
        require(auction.unreleasedProceeds() == 0, "PROCEEDS_NOT_RELEASED");
        require(!nft.authorizedOperators(auctionAddress), "AUCTION_OPERATOR_NOT_REVOKED");
        require(auctionAddress.codehash == expectedCodehash, "POST_CODEHASH_MISMATCH");
    }
}
