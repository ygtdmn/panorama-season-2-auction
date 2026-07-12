// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { BaseScript } from "./Base.s.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";
import { IPanorama } from "../src/interfaces/IPanorama.sol";

interface IFinalizeOwnableView {
    function owner() external view returns (address);
}

/// @notice Settles the auction in bounded batches and then revokes its Panorama operator right.
///         Each `finalize` call and the final revocation are separate transactions.
///
/// Required env:
///   PANORAMA_AUCTION_ADDRESS
///   PANORAMA_AUCTION_RUNTIME_CODEHASH - independently verified deployed runtime code hash
/// Optional env:
///   PANORAMA_FINALIZE_BATCH            - winners per batch (default: 45; maximum: 90)
contract FinalizeAuction is BaseScript {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    uint256 internal constant MAX_UNITS = 90;

    function run() public {
        require(block.chainid == MAINNET_CHAIN_ID, "WRONG_CHAIN_ID");

        address auctionAddress = vm.envAddress("PANORAMA_AUCTION_ADDRESS");
        bytes32 expectedCodehash = vm.envBytes32("PANORAMA_AUCTION_RUNTIME_CODEHASH");
        uint256 batch = vm.envOr("PANORAMA_FINALIZE_BATCH", uint256(45));

        require(auctionAddress != address(0) && auctionAddress.code.length != 0, "INVALID_AUCTION");
        require(expectedCodehash != bytes32(0) && auctionAddress.codehash == expectedCodehash, "CODEHASH_MISMATCH");
        require(batch > 0 && batch <= MAX_UNITS, "INVALID_FINALIZE_BATCH");

        PanoramaSeason2Auction auction = PanoramaSeason2Auction(auctionAddress);
        IPanorama nft = auction.nft();
        require(address(nft).code.length != 0, "INVALID_NFT");

        PanoramaSeason2Auction.Phase phase = auction.phase();
        require(
            phase == PanoramaSeason2Auction.Phase.Active || phase == PanoramaSeason2Auction.Phase.Finalizing
                || phase == PanoramaSeason2Auction.Phase.Settled,
            "AUCTION_NOT_FINALIZABLE"
        );
        if (phase != PanoramaSeason2Auction.Phase.Settled) {
            require(block.timestamp >= auction.endTime(), "AUCTION_NOT_ENDED");
            require(nft.authorizedOperators(auctionAddress), "AUCTION_NOT_AUTHORIZED");
            if (block.timestamp < uint256(auction.endTime()) + auction.FINALIZE_GRACE()) {
                require(auction.owner() == broadcaster, "BROADCASTER_CANNOT_FINALIZE_YET");
            }
        }

        // Revocation is part of successful completion, so refuse to begin unless this run can do it.
        if (nft.authorizedOperators(auctionAddress)) {
            require(IFinalizeOwnableView(address(nft)).owner() == broadcaster, "BROADCASTER_NOT_NFT_OWNER");
        }

        vm.startBroadcast(privateKey);

        while (
            auction.phase() == PanoramaSeason2Auction.Phase.Active
                || auction.phase() == PanoramaSeason2Auction.Phase.Finalizing
        ) {
            uint256 cursorBefore = auction.finalizeCursor();
            auction.finalize(batch);
            require(
                auction.phase() == PanoramaSeason2Auction.Phase.Settled || auction.finalizeCursor() > cursorBefore,
                "FINALIZE_MADE_NO_PROGRESS"
            );
        }

        require(auction.phase() == PanoramaSeason2Auction.Phase.Settled, "AUCTION_NOT_SETTLED");
        if (nft.authorizedOperators(auctionAddress)) {
            nft.setAuthorizedOperator(auctionAddress, false);
        }

        vm.stopBroadcast();

        require(auction.phase() == PanoramaSeason2Auction.Phase.Settled, "POST_PHASE_MISMATCH");
        require(auction.finalizeCursor() == auction.winnerCount(), "INCOMPLETE_FINALIZATION");
        require(auction.activeBids() == 0 && auction.totalEscrowed() == 0, "BID_LIABILITY_REMAINS");
        require(auction.unreleasedProceeds() == 0, "PROCEEDS_NOT_RELEASED");
        require(
            nft.totalMinted() == auction.FIRST_TOKEN_ID() - 1 + auction.winnerCount(), "UNEXPECTED_FINAL_NFT_SUPPLY"
        );
        require(!nft.authorizedOperators(auctionAddress), "AUCTION_OPERATOR_NOT_REVOKED");
        require(auctionAddress.codehash == expectedCodehash, "POST_CODEHASH_MISMATCH");
    }
}
