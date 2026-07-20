// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { console2 } from "forge-std/src/console2.sol";
import { SafeCastLib } from "solady/utils/SafeCastLib.sol";
import { BaseScript } from "./Base.s.sol";
import { PanoramaSeason2Auction } from "../src/PanoramaSeason2Auction.sol";
import { IPanorama } from "../src/interfaces/IPanorama.sol";
import { PanoramaMintController } from "../src/PanoramaMintController.sol";

interface ISettleOwnableView {
    function owner() external view returns (address);
}

library AuctionSettlementBatchLib {
    /// @dev Number of finalize calls needed from the current cursor. The subtraction-first ceiling
    ///      avoids both the partial-retry overcount and addition overflow.
    function finalizeCallCount(uint256 winners, uint256 finalized, uint256 batch) internal pure returns (uint256) {
        require(batch > 0, "INVALID_FINALIZE_BATCH");
        require(finalized <= winners, "INVALID_FINALIZE_PROGRESS");
        uint256 remaining = winners - finalized;
        return remaining == 0 ? 0 : ((remaining - 1) / batch) + 1;
    }
}

/// @notice Settles a completed, bid-bearing Season 2 auction as ONE closed sequence:
///
///         1. `nft.setAuthorizedOperator(auction, true)`
///         2. `controller.setSeasonMintCap(2, winnerCount)`  (exact winners: zero cap headroom)
///         3. `auction.finalize(batch)` repeated until `Settled`
///         4. `nft.setAuthorizedOperator(auction, false)`
///
///         This closes the race windows that exist when authorization, cap-opening, and
///         finalize batches are separate manual steps: the mint cap is opened by exactly the
///         number of tokens the auction will mint, and mint power is revoked in the same run.
///
///         Two modes:
///         - `run()`       EOA broadcast. The transactions are sent back-to-back in a single
///                         forge run (no owner action can interleave, but they land in
///                         consecutive blocks; the fail-closed checks inside `finalize` still
///                         guard every batch).
///         - `safeBatch()` Prints Safe Transaction Builder JSON so the WHOLE sequence executes
///                         atomically inside one Safe transaction (recommended). The Safe must
///                         own the NFT and the mint controller, and must either own the auction
///                         or execute after `endTime + FINALIZE_GRACE`.
///
///         Gas: `finalize(45)` measures ~8.06M; the full 90-winner sequence in one Safe batch is
///         ~16.4M, well under the mainnet block gas limit. Lower `PANORAMA_FINALIZE_BATCH` if you
///         want smaller transactions.
///
/// Required env:
///   PANORAMA_NFT / PANORAMA_MINT_CONTROLLER / PANORAMA_AUCTION_ADDRESS
///   PANORAMA_AUCTION_RUNTIME_CODEHASH     - independently obtained deployed runtime code hash
///   PANORAMA_AUCTION_OWNER                - expected auction owner
///   PANORAMA_AUCTION_RESERVE_PRICE / PANORAMA_AUCTION_MIN_INCREMENT_BPS
///   PANORAMA_AUCTION_START
///   PANORAMA_PAYOUT_A / PANORAMA_PAYOUT_B
/// Optional env:
///   PANORAMA_AUCTION_DURATION             - seconds (default: 86_400)
///   PANORAMA_FINALIZE_BATCH               - winners per finalize call (default: 45; max: 90)
contract SettleAuctionAtomic is BaseScript {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    uint256 internal constant FIRST_TOKEN_ID = 91;
    uint256 internal constant MAX_UNITS = 90;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MIN_DURATION = 1 hours;
    uint256 internal constant MAX_DURATION = 30 days;
    uint256 internal constant MAX_TOTAL_EXTENSION = 24 hours;
    uint8 internal constant SEASON = 2;

    struct Expected {
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
        uint256 batch;
    }

    /// @notice EOA mode: broadcast the full settlement sequence in one run.
    function run() public {
        Expected memory e = _loadExpected();
        uint256 winners = _preflight(e, broadcaster);

        PanoramaSeason2Auction auction = PanoramaSeason2Auction(e.auction);
        IPanorama nft = IPanorama(e.nft);
        PanoramaMintController controller = PanoramaMintController(e.controller);

        // The finalize loop below runs as the broadcaster, so the broadcaster must be allowed
        // to finalize now (auction owner, or anyone once the grace period has passed).
        if (block.timestamp < uint256(auction.endTime()) + auction.FINALIZE_GRACE()) {
            require(auction.owner() == broadcaster, "BROADCASTER_CANNOT_FINALIZE_YET");
        }

        vm.startBroadcast(privateKey);

        // 1. Authorize while the cap is still exhausted (authorize-then-cap ordering).
        if (!nft.authorizedOperators(e.auction)) {
            nft.setAuthorizedOperator(e.auction, true);
        }
        // 2. Open the cap by exactly the frozen winner count.
        if (controller.seasonCount() == 1) {
            controller.setSeasonMintCap(SEASON, winners);
        }
        // 3. Mint every winner.
        while (
            auction.phase() == PanoramaSeason2Auction.Phase.Active
                || auction.phase() == PanoramaSeason2Auction.Phase.Finalizing
        ) {
            uint256 cursorBefore = auction.finalizeCursor();
            auction.finalize(e.batch);
            require(
                auction.phase() == PanoramaSeason2Auction.Phase.Settled || auction.finalizeCursor() > cursorBefore,
                "FINALIZE_MADE_NO_PROGRESS"
            );
        }
        // 4. Revoke mint power in the same run.
        if (nft.authorizedOperators(e.auction)) {
            nft.setAuthorizedOperator(e.auction, false);
        }

        vm.stopBroadcast();

        _verifyPostState(e, winners);
        console2.log("Atomic settlement complete:", e.auction);
    }

    /// @notice Safe mode: print the Transaction Builder JSON for the identical sequence so it can
    ///         be executed atomically inside a single Safe transaction. Broadcasts nothing.
    function safeBatch() public view {
        Expected memory e = _loadExpected();
        // The executor of the batch is the Safe that owns the NFT; validate ownership against
        // it rather than against whoever happens to run this read-only script.
        address executor = ISettleOwnableView(e.nft).owner();
        uint256 winners = _preflight(e, executor);

        PanoramaSeason2Auction auction = PanoramaSeason2Auction(e.auction);
        if (block.timestamp < uint256(auction.endTime()) + auction.FINALIZE_GRACE()) {
            require(auction.owner() == executor, "SAFE_CANNOT_FINALIZE_YET");
        }

        uint256 calls = AuctionSettlementBatchLib.finalizeCallCount(winners, auction.finalizeCursor(), e.batch);

        console2.log("Execute from the Safe that owns the NFT and mint controller:", executor);
        console2.log("Safe Transaction Builder JSON:");
        console2.log("");

        string memory txs = string.concat(
            _txJson(e.nft, abi.encodeCall(IPanorama.setAuthorizedOperator, (e.auction, true))),
            ",",
            _txJson(e.controller, abi.encodeCall(PanoramaMintController.setSeasonMintCap, (SEASON, winners)))
        );
        for (uint256 i; i < calls; ++i) {
            txs =
                string.concat(txs, ",", _txJson(e.auction, abi.encodeCall(PanoramaSeason2Auction.finalize, (e.batch))));
        }
        txs = string.concat(
            txs, ",", _txJson(e.nft, abi.encodeCall(IPanorama.setAuthorizedOperator, (e.auction, false)))
        );

        console2.log(
            string.concat(
                '{"version":"1.0","chainId":"',
                vm.toString(block.chainid),
                '","createdAt":',
                vm.toString(block.timestamp * 1000),
                ',"meta":{"name":"Panorama Season 2 atomic settlement","description":"authorize -> exact cap -> finalize all -> revoke"},"transactions":[',
                txs,
                "]}"
            )
        );
    }

    function _txJson(address to, bytes memory data) internal pure returns (string memory) {
        return string.concat('{"to":"', vm.toString(to), '","value":"0","data":"', vm.toString(data), '"}');
    }

    /// @dev Chain gate. Mainnet by default; testnet rehearsal variants override this
    ///      (see SettleAuctionAtomicSepolia) so the production script itself stays mainnet-only.
    function _requiredChainId() internal pure virtual returns (uint256) {
        return MAINNET_CHAIN_ID;
    }

    function _loadExpected() internal view returns (Expected memory e) {
        require(block.chainid == _requiredChainId(), "WRONG_CHAIN_ID");

        e.nft = vm.envAddress("PANORAMA_NFT");
        e.controller = vm.envAddress("PANORAMA_MINT_CONTROLLER");
        e.auction = vm.envAddress("PANORAMA_AUCTION_ADDRESS");
        e.runtimeCodehash = vm.envBytes32("PANORAMA_AUCTION_RUNTIME_CODEHASH");
        e.auctionOwner = vm.envAddress("PANORAMA_AUCTION_OWNER");
        e.payoutA = vm.envAddress("PANORAMA_PAYOUT_A");
        e.payoutB = vm.envAddress("PANORAMA_PAYOUT_B");
        e.batch = vm.envOr("PANORAMA_FINALIZE_BATCH", uint256(45));

        require(e.nft != address(0) && e.nft.code.length != 0, "INVALID_NFT");
        require(e.controller != address(0) && e.controller.code.length != 0, "INVALID_CONTROLLER");
        require(e.auction != address(0) && e.auction.code.length != 0, "INVALID_AUCTION");
        require(e.runtimeCodehash != bytes32(0), "INVALID_EXPECTED_CODEHASH");
        require(e.auction.codehash == e.runtimeCodehash, "AUCTION_CODEHASH_MISMATCH");
        require(e.auctionOwner != address(0), "INVALID_AUCTION_OWNER");
        require(e.payoutA != address(0) && e.payoutB != address(0), "INVALID_PAYOUT");
        require(e.payoutA != e.payoutB, "PAYOUTS_MUST_DIFFER");
        require(e.batch > 0 && e.batch <= MAX_UNITS, "INVALID_FINALIZE_BATCH");

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

        e.reservePrice = SafeCastLib.toUint96(reserveRaw);
        e.minIncrementBps = SafeCastLib.toUint16(incrementRaw);
        e.startTime = SafeCastLib.toUint64(startRaw);
        e.initialEndTime = SafeCastLib.toUint64(initialEndRaw);
        e.absoluteEndTime = SafeCastLib.toUint64(initialEndRaw + MAX_TOTAL_EXTENSION);
    }

    /// @dev Full preflight. Returns the winner count the settlement will mint. Accepts a fresh
    ///      ended auction (Active) or a partially settled one (Finalizing) for safe retries.
    ///      `executor` is who will send the privileged calls: the broadcaster in EOA mode, the
    ///      owning Safe in batch mode.
    function _preflight(Expected memory e, address executor) internal view returns (uint256 winners) {
        PanoramaSeason2Auction auction = PanoramaSeason2Auction(e.auction);
        IPanorama nft = IPanorama(e.nft);
        PanoramaMintController controller = PanoramaMintController(e.controller);

        require(address(auction.nft()) == e.nft, "AUCTION_NFT_MISMATCH");
        require(nft.mintController() == e.controller, "NFT_CONTROLLER_MISMATCH");
        require(auction.owner() == e.auctionOwner, "AUCTION_OWNER_MISMATCH");
        require(ISettleOwnableView(e.nft).owner() == executor, "EXECUTOR_NOT_NFT_OWNER");
        require(controller.owner() == executor, "EXECUTOR_NOT_CONTROLLER_OWNER");

        require(auction.payoutA() == e.payoutA && auction.payoutB() == e.payoutB, "PAYOUT_MISMATCH");
        require(auction.reservePrice() == e.reservePrice, "RESERVE_PRICE_MISMATCH");
        require(auction.minIncrementBps() == e.minIncrementBps, "INCREMENT_BPS_MISMATCH");
        require(auction.startTime() == e.startTime, "START_TIME_MISMATCH");
        require(auction.absoluteEndTime() == e.absoluteEndTime, "ABSOLUTE_END_TIME_MISMATCH");
        require(auction.FIRST_TOKEN_ID() == FIRST_TOKEN_ID, "FIRST_TOKEN_ID_MISMATCH");
        require(auction.MAX_UNITS() == MAX_UNITS, "MAX_UNITS_MISMATCH");

        uint64 endTime = auction.endTime();
        require(endTime >= e.initialEndTime, "END_BEFORE_CONFIGURED_END");
        require(endTime <= e.absoluteEndTime, "END_AFTER_ABSOLUTE_END");
        require(block.timestamp >= endTime, "AUCTION_NOT_ENDED");
        require(!auction.paused(), "AUCTION_PAUSED");

        PanoramaSeason2Auction.Phase phase = auction.phase();
        if (phase == PanoramaSeason2Auction.Phase.Active) {
            winners = auction.activeBids();
            require(auction.nextBidId() > 1 && winners > 0, "AUCTION_HAS_NO_BIDS");
            require(winners <= MAX_UNITS, "TOO_MANY_ACTIVE_BIDS");
            require(auction.finalizeCursor() == 0 && auction.refundCursor() == 0, "PROCESSING_ALREADY_STARTED");
            require(auction.clearingPrice() == 0 && auction.proceeds() == 0, "NONZERO_SETTLEMENT_STATE");
        } else if (phase == PanoramaSeason2Auction.Phase.Finalizing) {
            // Retry path: the winner set is frozen; resume minting the remainder.
            winners = auction.winnerCount();
            require(winners > 0 && winners <= MAX_UNITS, "INVALID_FROZEN_WINNERS");
            require(auction.refundCursor() == 0, "REFUND_ALREADY_STARTED");
        } else {
            revert("AUCTION_NOT_SETTLEABLE");
        }

        require(nft.totalMinted() == FIRST_TOKEN_ID - 1 + auction.finalizeCursor(), "UNEXPECTED_MINTED_SUPPLY");
        require(nft.maxSupply() >= FIRST_TOKEN_ID + MAX_UNITS - 1, "INSUFFICIENT_MAX_SUPPLY");

        uint8 seasonCount = controller.seasonCount();
        require(seasonCount == 1 || seasonCount == SEASON, "UNEXPECTED_SEASON_COUNT");
        require(controller.seasonMintCap(1) == FIRST_TOKEN_ID - 1, "UNEXPECTED_SEASON_1_CAP");
        if (seasonCount == 1) {
            require(controller.getMintCap() == FIRST_TOKEN_ID - 1, "UNEXPECTED_PRE_AUTH_CAP");
            require(nft.mintCap() == FIRST_TOKEN_ID - 1, "UNEXPECTED_NFT_PRE_AUTH_CAP");
        } else {
            // Accept only the exact-winners cap from a previous partial run of this script.
            require(controller.seasonMintCap(SEASON) == winners, "UNEXPECTED_SEASON_2_CAP");
        }
    }

    function _verifyPostState(Expected memory e, uint256 winners) internal view {
        PanoramaSeason2Auction auction = PanoramaSeason2Auction(e.auction);
        IPanorama nft = IPanorama(e.nft);
        PanoramaMintController controller = PanoramaMintController(e.controller);

        require(e.auction.codehash == e.runtimeCodehash, "POST_CODEHASH_MISMATCH");
        require(uint8(auction.phase()) == uint8(PanoramaSeason2Auction.Phase.Settled), "AUCTION_NOT_SETTLED");
        require(auction.finalizeCursor() == auction.winnerCount(), "INCOMPLETE_FINALIZATION");
        require(auction.winnerCount() == winners, "WINNER_COUNT_MISMATCH");
        require(auction.activeBids() == 0 && auction.totalEscrowed() == 0, "BID_LIABILITY_REMAINS");
        require(auction.unreleasedProceeds() == 0, "PROCEEDS_NOT_RELEASED");
        require(nft.totalMinted() == FIRST_TOKEN_ID - 1 + winners, "UNEXPECTED_FINAL_NFT_SUPPLY");
        // The cap is exactly consumed: no token is mintable until a future season is configured.
        require(nft.mintCap() == FIRST_TOKEN_ID - 1 + winners, "CAP_HEADROOM_REMAINS");
        require(controller.seasonMintCap(SEASON) == winners, "WRONG_SEASON_2_CAP");
        require(!nft.authorizedOperators(e.auction), "AUCTION_OPERATOR_NOT_REVOKED");
    }
}
