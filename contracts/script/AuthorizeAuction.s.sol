// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { console2 } from "forge-std/src/console2.sol";
import { SafeCastLib } from "solady/utils/SafeCastLib.sol";
import { BaseScript } from "./Base.s.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";
import { IPanorama } from "../src/interfaces/IPanorama.sol";
import { PanoramaMintController } from "../src/PanoramaMintController.sol";

interface IOwnableView {
    function owner() external view returns (address);
}

/// @notice Authorizes a completed, bid-bearing Season 2 auction to mint tokens #91..#180.
///         Authorization is intentionally delayed until bidding has ended. Every immutable and
///         lifecycle precondition is checked before either privileged transaction is broadcast.
///
/// Required env:
///   PANORAMA_NFT / PANORAMA_MINT_CONTROLLER / PANORAMA_AUCTION_ADDRESS
///   PANORAMA_AUCTION_RUNTIME_CODEHASH     - independently obtained deployed runtime code hash
///   PANORAMA_AUCTION_OWNER                - expected auction owner
///   PANORAMA_AUCTION_RESERVE_PRICE
///   PANORAMA_AUCTION_MIN_INCREMENT_BPS
///   PANORAMA_AUCTION_START
///   PANORAMA_PAYOUT_A / PANORAMA_PAYOUT_B
/// Optional env:
///   PANORAMA_AUCTION_DURATION             - seconds (default: 86_400)
contract AuthorizeAuction is BaseScript {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    uint256 internal constant FIRST_TOKEN_ID = 91;
    uint256 internal constant MAX_UNITS = 90;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MIN_DURATION = 1 hours;
    uint256 internal constant MAX_DURATION = 30 days;
    uint256 internal constant MAX_TOTAL_EXTENSION = 24 hours;
    uint8 internal constant SEASON = 2;

    struct ExpectedConfig {
        address nft;
        address controller;
        address auction;
        bytes32 runtimeCodehash;
        address auctionOwner;
        address payoutA;
        address payoutB;
        uint96 reservePrice;
        uint16 minIncrementBps;
        uint64 startTime;
        uint64 initialEndTime;
        uint64 absoluteEndTime;
    }

    struct AuctionState {
        uint32 nextBidId;
        uint256 activeBids;
        uint64 endTime;
    }

    function run() public {
        ExpectedConfig memory expected = _loadExpectedConfig();
        AuctionState memory beforeState = _preflight(expected);

        IPanorama nft = IPanorama(expected.nft);
        PanoramaMintController controller = PanoramaMintController(expected.controller);

        vm.startBroadcast(privateKey);

        // Authorize while the cap is still 90. This ordering avoids opening token #91 to any
        // existing collection operator in the transaction gap before the auction is authorized.
        if (!nft.authorizedOperators(expected.auction)) {
            nft.setAuthorizedOperator(expected.auction, true);
        }
        if (controller.seasonCount() == 1) {
            controller.setSeasonMintCap(SEASON, MAX_UNITS);
        }

        vm.stopBroadcast();

        _verifyPostState(expected, beforeState);
        console2.log("Auction authorized after end-time preflight:", expected.auction);
    }

    function _loadExpectedConfig() internal view returns (ExpectedConfig memory expected) {
        require(block.chainid == MAINNET_CHAIN_ID, "WRONG_CHAIN_ID");

        expected.nft = vm.envAddress("PANORAMA_NFT");
        expected.controller = vm.envAddress("PANORAMA_MINT_CONTROLLER");
        expected.auction = vm.envAddress("PANORAMA_AUCTION_ADDRESS");
        expected.runtimeCodehash = vm.envBytes32("PANORAMA_AUCTION_RUNTIME_CODEHASH");
        expected.auctionOwner = vm.envAddress("PANORAMA_AUCTION_OWNER");
        expected.payoutA = vm.envAddress("PANORAMA_PAYOUT_A");
        expected.payoutB = vm.envAddress("PANORAMA_PAYOUT_B");

        require(expected.nft != address(0) && expected.nft.code.length != 0, "INVALID_NFT");
        require(expected.controller != address(0) && expected.controller.code.length != 0, "INVALID_CONTROLLER");
        require(expected.auction != address(0) && expected.auction.code.length != 0, "INVALID_AUCTION");
        require(expected.runtimeCodehash != bytes32(0), "INVALID_EXPECTED_CODEHASH");
        require(expected.auction.codehash == expected.runtimeCodehash, "AUCTION_CODEHASH_MISMATCH");
        require(expected.auctionOwner != address(0), "INVALID_AUCTION_OWNER");
        require(expected.payoutA != address(0) && expected.payoutB != address(0), "INVALID_PAYOUT");
        require(expected.payoutA != expected.payoutB, "PAYOUTS_MUST_DIFFER");

        uint256 reserveRaw = vm.envUint("PANORAMA_AUCTION_RESERVE_PRICE");
        uint256 incrementRaw = vm.envUint("PANORAMA_AUCTION_MIN_INCREMENT_BPS");
        uint256 startRaw = vm.envUint("PANORAMA_AUCTION_START");
        uint256 durationRaw = vm.envOr("PANORAMA_AUCTION_DURATION", uint256(24 hours));

        // Mirrors the contract's MIN_RESERVE_PRICE (0.1 ETH floor).
        require(reserveRaw >= 0.1 ether && reserveRaw <= type(uint96).max, "INVALID_RESERVE_PRICE");
        require(
            incrementRaw > 0 && incrementRaw <= BPS_DENOMINATOR && incrementRaw <= type(uint16).max,
            "INVALID_INCREMENT_BPS"
        );
        require(startRaw > 0 && startRaw <= type(uint64).max, "INVALID_START_TIME");
        require(durationRaw >= MIN_DURATION && durationRaw <= MAX_DURATION, "INVALID_DURATION");
        require(durationRaw <= type(uint64).max - startRaw, "END_TIME_OVERFLOW");

        uint256 initialEndRaw = startRaw + durationRaw;
        require(initialEndRaw <= type(uint64).max - MAX_TOTAL_EXTENSION, "ABSOLUTE_END_OVERFLOW");

        expected.reservePrice = SafeCastLib.toUint96(reserveRaw);
        expected.minIncrementBps = SafeCastLib.toUint16(incrementRaw);
        expected.startTime = SafeCastLib.toUint64(startRaw);
        expected.initialEndTime = SafeCastLib.toUint64(initialEndRaw);
        expected.absoluteEndTime = SafeCastLib.toUint64(initialEndRaw + MAX_TOTAL_EXTENSION);
    }

    function _preflight(ExpectedConfig memory expected) internal view returns (AuctionState memory state) {
        PanoramaSeason2Auction auction = PanoramaSeason2Auction(expected.auction);
        IPanorama nft = IPanorama(expected.nft);
        PanoramaMintController controller = PanoramaMintController(expected.controller);

        require(address(auction.nft()) == expected.nft, "AUCTION_NFT_MISMATCH");
        require(nft.mintController() == expected.controller, "NFT_CONTROLLER_MISMATCH");
        require(auction.owner() == expected.auctionOwner, "AUCTION_OWNER_MISMATCH");
        require(IOwnableView(expected.nft).owner() == broadcaster, "BROADCASTER_NOT_NFT_OWNER");
        require(controller.owner() == broadcaster, "BROADCASTER_NOT_CONTROLLER_OWNER");

        require(auction.payoutA() == expected.payoutA && auction.payoutB() == expected.payoutB, "PAYOUT_MISMATCH");
        require(auction.reservePrice() == expected.reservePrice, "RESERVE_PRICE_MISMATCH");
        require(auction.minIncrementBps() == expected.minIncrementBps, "INCREMENT_BPS_MISMATCH");
        require(auction.startTime() == expected.startTime, "START_TIME_MISMATCH");
        require(auction.absoluteEndTime() == expected.absoluteEndTime, "ABSOLUTE_END_TIME_MISMATCH");
        require(auction.FIRST_TOKEN_ID() == FIRST_TOKEN_ID, "FIRST_TOKEN_ID_MISMATCH");
        require(auction.MAX_UNITS() == MAX_UNITS, "MAX_UNITS_MISMATCH");

        state.endTime = auction.endTime();
        require(state.endTime >= expected.initialEndTime, "END_BEFORE_CONFIGURED_END");
        require(state.endTime <= expected.absoluteEndTime, "END_AFTER_ABSOLUTE_END");
        require(block.timestamp >= state.endTime, "AUCTION_NOT_ENDED");

        require(uint8(auction.phase()) == uint8(PanoramaSeason2Auction.Phase.Active), "AUCTION_NOT_ACTIVE");
        require(!auction.paused(), "AUCTION_PAUSED");
        state.nextBidId = auction.nextBidId();
        state.activeBids = auction.activeBids();
        require(state.nextBidId > 1 && state.activeBids > 0, "AUCTION_HAS_NO_BIDS");
        require(state.activeBids <= MAX_UNITS, "TOO_MANY_ACTIVE_BIDS");
        require(auction.finalizeCursor() == 0, "FINALIZATION_ALREADY_STARTED");
        require(auction.refundCursor() == 0, "REFUND_ALREADY_STARTED");
        require(auction.clearingPrice() == 0 && auction.proceeds() == 0, "NONZERO_SETTLEMENT_STATE");

        require(nft.totalMinted() == FIRST_TOKEN_ID - 1, "UNEXPECTED_MINTED_SUPPLY");
        require(nft.maxSupply() >= FIRST_TOKEN_ID + MAX_UNITS - 1, "INSUFFICIENT_MAX_SUPPLY");
        require(nft.MAX_SUPPLY() == nft.maxSupply(), "NFT_MAX_SUPPLY_MISMATCH");

        uint8 seasonCount = controller.seasonCount();
        require(seasonCount == 1 || seasonCount == SEASON, "UNEXPECTED_SEASON_COUNT");
        require(controller.seasonMintCap(1) == FIRST_TOKEN_ID - 1, "UNEXPECTED_SEASON_1_CAP");
        if (seasonCount == 1) {
            require(controller.getMintCap() == FIRST_TOKEN_ID - 1, "UNEXPECTED_PRE_AUTH_CAP");
            require(nft.mintCap() == FIRST_TOKEN_ID - 1, "UNEXPECTED_NFT_PRE_AUTH_CAP");
        } else {
            // Accept an exact partial/retry state, but never normalize an unknown controller state.
            require(controller.seasonMintCap(SEASON) == MAX_UNITS, "UNEXPECTED_SEASON_2_CAP");
            require(controller.getMintCap() == FIRST_TOKEN_ID + MAX_UNITS - 1, "UNEXPECTED_TOTAL_MINT_CAP");
            require(nft.mintCap() == FIRST_TOKEN_ID + MAX_UNITS - 1, "UNEXPECTED_NFT_MINT_CAP");
        }
    }

    function _verifyPostState(ExpectedConfig memory expected, AuctionState memory beforeState) internal view {
        PanoramaSeason2Auction auction = PanoramaSeason2Auction(expected.auction);
        IPanorama nft = IPanorama(expected.nft);
        PanoramaMintController controller = PanoramaMintController(expected.controller);

        require(expected.auction.codehash == expected.runtimeCodehash, "AUCTION_CODEHASH_CHANGED");
        require(nft.authorizedOperators(expected.auction), "AUCTION_NOT_AUTHORIZED");
        require(controller.seasonCount() == SEASON, "SEASON_2_NOT_CREATED");
        require(controller.seasonMintCap(1) == FIRST_TOKEN_ID - 1, "SEASON_1_CAP_CHANGED");
        require(controller.seasonMintCap(SEASON) == MAX_UNITS, "WRONG_SEASON_2_CAP");
        require(controller.getMintCap() == FIRST_TOKEN_ID + MAX_UNITS - 1, "WRONG_TOTAL_MINT_CAP");
        require(nft.mintCap() == FIRST_TOKEN_ID + MAX_UNITS - 1, "WRONG_NFT_MINT_CAP");
        require(nft.totalMinted() == FIRST_TOKEN_ID - 1, "MINTED_SUPPLY_CHANGED");

        require(uint8(auction.phase()) == uint8(PanoramaSeason2Auction.Phase.Active), "AUCTION_PHASE_CHANGED");
        require(auction.nextBidId() == beforeState.nextBidId, "BID_ID_CHANGED");
        require(auction.activeBids() == beforeState.activeBids, "ACTIVE_BIDS_CHANGED");
        require(auction.endTime() == beforeState.endTime, "END_TIME_CHANGED");
        require(auction.finalizeCursor() == 0 && auction.refundCursor() == 0, "PROCESSING_STATE_CHANGED");
    }
}
