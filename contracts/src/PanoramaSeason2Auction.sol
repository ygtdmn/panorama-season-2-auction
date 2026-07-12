// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Ownable } from "solady/auth/Ownable.sol";
import { ReentrancyGuardTransient } from "solady/utils/ReentrancyGuardTransient.sol";
import { SafeCastLib } from "solady/utils/SafeCastLib.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { IPanorama } from "./interfaces/IPanorama.sol";

interface IERC721Rescue {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title PanoramaSeason2Auction
/// @author Yigit Duman (@yigitduman)
/// @notice Multi-unit English (open, ascending) auction with a uniform clearing price for
///         Panorama Season 2 (tokens #91-#180). Sells `MAX_UNITS` identical units: the highest
///         `MAX_UNITS` bids win, every winner pays the lowest winning bid (the clearing price),
///         and the excess over the clearing price is refunded at settlement.
/// @dev    Only the top `MAX_UNITS` bids ever escrow funds. Once full, a new bid must beat the
///         current lowest winning bid by `minIncrementBps`; the displaced bidder is refunded
///         immediately. Each wallet may hold up to `MAX_BIDS_PER_WALLET` independent bids and can
///         therefore win that many tokens. The active bid set is kept in an indexed binary
///         min-heap so the root is always the current clearing floor.
///
///         Fund safety: the owner can never take escrow for itself, only settle to the fixed
///         payout split or refund bidders. Recovery paths are the owner's `cancelAuction` followed
///         by permissionless `refundAll`, immediate permissionless recovery from a permanent NFT
///         supply mismatch, post-finalize-grace recovery when mint authorization/capability is
///         objectively unavailable, and permissionless `emergencyRefund` after `EMERGENCY_GRACE`.
///         Recovery never depends on mint authorization, so bidders can recover if the owner
///         disappears, minting was never authorized, or another mint consumes the expected sequence.
contract PanoramaSeason2Auction is Ownable, ReentrancyGuardTransient {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Number of tokens for sale (Season 2 = #91-#180).
    uint256 public constant MAX_UNITS = 90;
    /// @dev Exact token range enforced during deployment and every settlement batch.
    uint256 public constant FIRST_TOKEN_ID = 91;
    uint256 public constant LAST_TOKEN_ID = FIRST_TOKEN_ID + MAX_UNITS - 1;
    /// @dev Maximum concurrent bids a single wallet may hold.
    uint8 public constant MAX_BIDS_PER_WALLET = 4;
    /// @dev A qualifying bid inside this window before the end triggers an extension.
    uint256 public constant EXT_WINDOW = 5 minutes;
    /// @dev Each extension guarantees at least this much time remains from the bid.
    uint256 public constant EXT_LEN = 10 minutes;
    /// @dev Extensions can move the scheduled end by at most 24 hours in total.
    uint256 public constant MAX_TOTAL_EXTENSION = 24 hours;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    /// @dev After `endTime + FINALIZE_GRACE`, anyone may finalize (owner-inaction backstop).
    uint256 public constant FINALIZE_GRACE = 7 days;
    /// @dev After `absoluteEndTime + EMERGENCY_GRACE`, anyone may `emergencyRefund`: the trustless
    ///      last-resort recovery when settlement is stuck (never authorized to mint, or bricked
    ///      mid-finalize). Set well beyond `FINALIZE_GRACE` so normal settlement is tried first.
    uint256 public constant EMERGENCY_GRACE = 30 days;
    /// @dev Basis-points denominator.
    uint256 internal constant BPS_DENOM = 10_000;
    /// @dev Share of proceeds paid to `payoutA` (the remainder goes to `payoutB`).
    uint256 public constant SPLIT_A_BPS = 5800;
    /// @dev Hard floor for the reserve price. The constructor rejects any lower configuration,
    ///      so no bid below 0.1 ETH can ever be accepted (`placeBid` requires >= `reservePrice`).
    uint96 public constant MIN_RESERVE_PRICE = 0.1 ether;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    enum Phase {
        Active,
        Finalizing,
        Settled,
        Cancelled
    }

    struct Bid {
        address bidder; // 160 bits
        uint96 amount; // 96 bits -> single storage slot
    }

    /*//////////////////////////////////////////////////////////////
                                CONFIG
    //////////////////////////////////////////////////////////////*/

    IPanorama public immutable nft;
    address public immutable payoutA; // 58%
    address public immutable payoutB; // 42%
    uint96 public immutable reservePrice;
    uint16 public immutable minIncrementBps;

    uint64 public startTime;
    uint64 public endTime;
    /// @dev Hard deadline that bidding extensions can never move. Set to scheduled end + 24 hours.
    uint64 public absoluteEndTime;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    Phase public phase;
    bool public paused;
    uint32 public extensionCount;

    /// @dev Bid id => bid. Ids are dense from 1; inactive/evicted ids are deleted.
    mapping(uint32 => Bid) public bids;
    uint32 public nextBidId = 1;

    /// @dev 1-based binary min-heap of active bid ids ordered by amount. `_heap[0]` is a burned
    ///      sentinel so real elements live at indices `1..size` and `heapPos[id] == 0` means absent.
    uint32[] internal _heap;
    /// @dev Bid id => its index in `_heap` (0 = not in the heap).
    mapping(uint32 => uint32) public heapPos;

    /// @dev Active bid count per wallet (<= MAX_BIDS_PER_WALLET).
    mapping(address => uint8) public activeBidCount;
    /// @dev Number of live, unprocessed bids. Unlike `_heap.length - 1`, this shrinks during settlement/refunds.
    uint256 public remainingBidCount;
    /// @dev Pull-payment ledger for refunds/excess that could not be pushed.
    mapping(address => uint256) public pendingReturns;
    /// @dev Aggregate pull-payment liability, used to distinguish rescueable surplus from bidder funds.
    uint256 public totalPendingReturns;
    /// @dev Aggregate value of all live bids still held in escrow.
    uint256 public totalEscrowed;

    /// @dev Uniform clearing price, frozen on the first finalize batch.
    uint96 public clearingPrice;
    /// @dev Accumulated proceeds (winners * clearingPrice) across finalize batches.
    uint256 public proceeds;
    /// @dev Portion of `proceeds` not yet released to the immutable payout split.
    uint256 public unreleasedProceeds;
    /// @dev Frozen winner count once finalization starts.
    uint256 public winnerCount;
    /// @dev Number of winners minted so far across finalize batches.
    uint256 public finalizeCursor;
    /// @dev 1-based cursor into `_heap` for batched full refunds after cancellation.
    uint256 public refundCursor;
    /// @dev True once every unminted bid is processed and any minted-winner proceeds are released.
    bool public refundsComplete;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BidPlaced(uint32 indexed bidId, address indexed bidder, uint96 amount);
    event BidIncreased(uint32 indexed bidId, address indexed bidder, uint96 newAmount);
    event BidDisplaced(uint32 indexed bidId, address indexed bidder, uint96 amount);
    event Refunded(address indexed to, uint256 amount);
    event RefundFailed(address indexed to, uint256 amount);
    event Extended(uint64 newEndTime, uint32 extensionCount);
    event FinalizeStarted(uint96 clearingPrice, uint256 winners);
    event Won(
        uint32 indexed bidId, address indexed winner, uint256 indexed tokenId, uint96 bidAmount, uint96 pricePaid
    );
    event FinalizeProgress(uint256 processed, uint256 total);
    event Settled(uint256 proceeds, uint96 clearingPrice, uint256 winners);
    event Cancelled();
    event EmergencyRefundStarted(uint256 minted, uint256 remaining);
    event SupplyMismatchRecoveryStarted(uint256 expectedSupply, uint256 actualSupply, uint256 remaining);
    event MintingUnavailableRecoveryStarted(
        bool operatorAuthorized, uint256 currentMintCap, uint256 requiredMintCap, uint256 minted, uint256 remaining
    );
    event RefundAllProgress(uint256 processed, uint256 total);
    event RefundAllComplete();
    event ProceedsReleased(uint256 amount, uint256 payoutAShare, uint256 payoutBShare);
    event Withdrawn(address indexed to, uint256 amount);
    event ScheduleUpdated(uint64 startTime, uint64 endTime, uint64 absoluteEndTime);
    event PausedSet(bool paused);
    event SurplusETHRescued(address indexed to, uint256 amount);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);
    event ERC721Rescued(address indexed token, address indexed to, uint256 tokenId);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidConfig();
    error NotActive();
    error NotStarted();
    error AuctionEnded();
    error AuctionNotEnded();
    error IsPaused();
    error TooManyBids();
    error BelowReserve();
    error AmountTooLarge();
    error BidTooLow(uint256 minRequired);
    error NotYourBid();
    error ZeroIncrease();
    error ZeroBatch();
    error NotFinalizable();
    error NotOperatorAuthorized();
    error InsufficientMintCap();
    error NotCancellable();
    error NotCancelled();
    error NothingToWithdraw();
    error NotAuthorizedToFinalize();
    error TooLateToConfigure();
    error NotYetEmergency();
    error AlreadySettled();
    error BidIncreaseTooLow(uint256 minRequired);
    error UnexpectedSupply(uint256 expected, uint256 actual);
    error UnexpectedTokenId(uint256 expected, uint256 actual);
    error NoBidFound();
    error RecoveryIncomplete();
    error NothingToRescue();
    error SupplyNotMismatched();
    error NotYetMintingUnavailableRecovery();
    error MintingStillAvailable();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param nft_ The Panorama ERC721 (this contract must be an authorized operator to mint).
    /// @param reservePrice_ Minimum bid; also the clearing price when undersubscribed.
    ///        Must be >= `MIN_RESERVE_PRICE` (0.1 ETH).
    /// @param minIncrementBps_ Minimum raise over the current floor, in bps. Must be > 0.
    /// @param startTime_ Explicit auction start. Must be strictly in the future.
    /// @param duration_ Auction length in seconds (e.g. 24 hours). Bounds: `MIN_DURATION`..`MAX_DURATION`.
    /// @param payoutA_ Receives `SPLIT_A_BPS` of proceeds.
    /// @param payoutB_ Receives the remainder of proceeds.
    constructor(
        address nft_,
        uint96 reservePrice_,
        uint16 minIncrementBps_,
        uint64 startTime_,
        uint64 duration_,
        address payoutA_,
        address payoutB_
    ) {
        if (nft_ == address(0) || nft_.code.length == 0 || payoutA_ == address(0) || payoutB_ == address(0)) {
            revert InvalidConfig();
        }
        if (
            reservePrice_ < MIN_RESERVE_PRICE || minIncrementBps_ == 0 || minIncrementBps_ > BPS_DENOM
                || duration_ < MIN_DURATION || duration_ > MAX_DURATION || startTime_ <= block.timestamp
        ) revert InvalidConfig();

        uint256 et256 = uint256(startTime_) + duration_;
        uint256 absoluteEt256 = et256 + MAX_TOTAL_EXTENSION;
        if (absoluteEt256 > type(uint64).max) revert InvalidConfig();

        IPanorama panorama = IPanorama(nft_);
        uint256 expectedSupply = FIRST_TOKEN_ID - 1;
        if (panorama.totalMinted() != expectedSupply || panorama.maxSupply() < LAST_TOKEN_ID) revert InvalidConfig();

        _initializeOwner(msg.sender);
        nft = panorama;
        reservePrice = reservePrice_;
        minIncrementBps = minIncrementBps_;
        startTime = startTime_;
        endTime = SafeCastLib.toUint64(et256);
        absoluteEndTime = SafeCastLib.toUint64(absoluteEt256);
        payoutA = payoutA_;
        payoutB = payoutB_;

        _heap.push(0); // burn index 0 so the heap is 1-based
    }

    /*//////////////////////////////////////////////////////////////
                                BIDDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Place a new bid. Once the auction is full, the value must beat the current lowest
    ///         winning bid by `minIncrementBps`; the displaced bidder is refunded immediately.
    function placeBid() external payable nonReentrant {
        _requireBiddable();

        address bidder = msg.sender;
        if (activeBidCount[bidder] >= MAX_BIDS_PER_WALLET) revert TooManyBids();
        if (msg.value < reservePrice) revert BelowReserve();
        if (msg.value > type(uint96).max) revert AmountTooLarge();

        uint96 amount = uint96(msg.value);
        uint32 newId = nextBidId++;
        bids[newId] = Bid({ bidder: bidder, amount: amount });

        address displaced;
        uint96 displacedAmount;

        uint256 size = _heap.length - 1;
        totalEscrowed += msg.value;
        if (size < MAX_UNITS) {
            // Room available: append and sift up.
            _heap.push(newId);
            uint256 pos = _heap.length - 1;
            heapPos[newId] = SafeCastLib.toUint32(pos);
            ++remainingBidCount;
            _siftUp(pos);
        } else {
            // Full: must beat the floor (heap root) by the minimum increment.
            uint32 rootId = _heap[1];
            uint256 floor = bids[rootId].amount;
            uint256 minRequired = floor + _bpsIncrement(floor);
            if (msg.value < minRequired) revert BidTooLow(minRequired);

            displaced = bids[rootId].bidder;
            displacedAmount = bids[rootId].amount;

            // Effects: evict root, then place the new bid at the root and sift down.
            unchecked {
                activeBidCount[displaced]--;
            }
            totalEscrowed -= displacedAmount;
            heapPos[rootId] = 0;
            delete bids[rootId];

            _heap[1] = newId;
            heapPos[newId] = 1;
            _siftDown(1);

            emit BidDisplaced(rootId, displaced, displacedAmount);
        }

        unchecked {
            activeBidCount[bidder]++;
        }
        _maybeExtend();
        emit BidPlaced(newId, bidder, amount);

        // Interactions last. Force-send so a reverting displaced contract cannot block bidding.
        if (displaced != address(0)) {
            SafeTransferLib.forceSafeTransferETH(displaced, displacedAmount);
            emit Refunded(displaced, displacedAmount);
        }
    }

    /// @notice Increase one of your existing active bids by sending additional ETH.
    function increaseBid(uint32 bidId) external payable nonReentrant {
        _requireBiddable();
        if (msg.value == 0) revert ZeroIncrease();

        Bid storage b = bids[bidId];
        if (b.bidder != msg.sender || heapPos[bidId] == 0) revert NotYourBid();

        // Clearing floor (the #90 / heap root) captured before this top-up applies.
        uint256 floor = bids[_heap[1]].amount;
        uint256 extensionThreshold = _extendThreshold(floor);
        if (block.timestamp + EXT_WINDOW >= endTime && msg.value < extensionThreshold) {
            revert BidIncreaseTooLow(extensionThreshold);
        }

        uint256 newAmount = uint256(b.amount) + msg.value;
        if (newAmount > type(uint96).max) revert AmountTooLarge();
        uint96 newAmount96 = SafeCastLib.toUint96(newAmount);
        b.amount = newAmount96;
        totalEscrowed += msg.value;

        // Raising a key in a min-heap can only violate the property downward.
        _siftDown(heapPos[bidId]);

        // Anti-snipe extends only for a *competitive* top-up: the added value must be at least
        // `minIncrementBps` of the clearing floor (the #90 bid), NOT of the bidder's own bid. So a
        // whale at 10 ETH need only add ~0.005 ETH (5% of a 0.1 ETH floor), while a 1-wei top-up no
        // longer extends the auction, closing the near-free extension-grief vector.
        if (msg.value >= extensionThreshold) _maybeExtend();

        emit BidIncreased(bidId, msg.sender, newAmount96);
    }

    /// @notice Withdraw any refund/excess that could not be pushed to you automatically.
    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingReturns[msg.sender] = 0;
        totalPendingReturns -= amount;
        SafeTransferLib.forceSafeTransferETH(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                              SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Settle the auction: mint tokens to winners (highest bid first, so the top bid gets
    ///         token #91 and the earliest daily reveal slot) and refund their excess, in batches.
    ///         The first call freezes the clearing price. Callable by the owner after `endTime`,
    ///         or by anyone after `endTime + FINALIZE_GRACE`.
    /// @param maxCount Maximum winners to process this call. Keep batches well under the block limit.
    function finalize(uint256 maxCount) external nonReentrant {
        if (msg.sender != owner() && block.timestamp < endTime + FINALIZE_GRACE) {
            revert NotAuthorizedToFinalize();
        }
        if (phase != Phase.Active && phase != Phase.Finalizing) revert NotFinalizable();
        if (block.timestamp < endTime) revert AuctionNotEnded();
        if (maxCount == 0) revert ZeroBatch();

        uint256 winners = phase == Phase.Active ? _heap.length - 1 : winnerCount;
        uint256 expectedSupply = expectedNftSupply();
        uint256 actualSupply = nft.totalMinted();
        if (actualSupply != expectedSupply) revert UnexpectedSupply(expectedSupply, actualSupply);
        if (!nft.authorizedOperators(address(this))) revert NotOperatorAuthorized();
        if (nft.mintCap() < expectedSupply + (winners - finalizeCursor)) revert InsufficientMintCap();

        if (phase == Phase.Active) {
            // Clearing price = the lowest winning bid = the min-heap root (captured before minting).
            uint96 cp = winners >= MAX_UNITS ? bids[_heap[1]].amount : reservePrice;
            clearingPrice = cp;
            winnerCount = winners;
            phase = Phase.Finalizing;
            emit FinalizeStarted(cp, winners);
        }

        // Mint in descending bid order so the highest bid gets the earliest token id (#91) and
        // therefore the earliest daily reveal slot. Each iteration selects the highest bid that
        // has not yet been minted (undeleted) by scanning the frozen winner set. O(winners) per
        // mint; batch `maxCount` (30-45) to stay well under the block gas limit.
        uint256 minted = finalizeCursor;
        uint256 target = minted + maxCount;
        if (target > winners) target = winners;
        uint96 cp2 = clearingPrice;

        while (minted < target) {
            uint32 bestId;
            uint96 bestAmt;
            address bestBidder;
            for (uint256 i = 1; i <= winners; ++i) {
                uint32 id = _heap[i];
                if (id == 0) continue;
                Bid memory bd = bids[id];
                if (bd.bidder == address(0)) continue; // already minted
                if (bestId == 0 || bd.amount > bestAmt || (bd.amount == bestAmt && id < bestId)) {
                    bestId = id;
                    bestAmt = bd.amount;
                    bestBidder = bd.bidder;
                }
            }

            if (bestId == 0) revert NoBidFound();

            // Effects before interactions.
            delete bids[bestId];
            heapPos[bestId] = 0;
            unchecked {
                activeBidCount[bestBidder]--;
                --remainingBidCount;
            }
            totalEscrowed -= bestAmt;
            proceeds += cp2;
            unreleasedProceeds += cp2;

            // Panorama._mint performs no receiver callback, so this cedes no control.
            uint256 tokenId = nft.mintTo(bestBidder);
            uint256 expectedTokenId = FIRST_TOKEN_ID + minted;
            if (tokenId != expectedTokenId) revert UnexpectedTokenId(expectedTokenId, tokenId);

            uint256 excess = uint256(bestAmt) - cp2;
            if (excess > 0) {
                if (SafeTransferLib.trySafeTransferETH(bestBidder, excess, SafeTransferLib.GAS_STIPEND_NO_GRIEF)) {
                    emit Refunded(bestBidder, excess);
                } else {
                    _creditPendingReturn(bestBidder, excess);
                    emit RefundFailed(bestBidder, excess);
                }
            }
            emit Won(bestId, bestBidder, tokenId, bestAmt, cp2);
            ++minted;
        }

        finalizeCursor = minted;
        emit FinalizeProgress(minted, winners);

        if (minted == winners) {
            phase = Phase.Settled;
            uint256 total = proceeds;
            _releaseProceeds();
            emit Settled(total, cp2, winners);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               FAILSAFE
    //////////////////////////////////////////////////////////////*/

    /// @notice Cancel the auction before settlement begins. Enables `refundAll`. Blocks `finalize`.
    function cancelAuction() external onlyOwner {
        if (phase != Phase.Active) revert NotCancellable();
        phase = Phase.Cancelled;
        emit Cancelled();
        if (remainingBidCount == 0) {
            refundCursor = _heap.length;
            _completeRecovery();
        }
    }

    /// @notice After cancellation, ANYONE may refund every remaining bid in full, in batches.
    /// @param maxCount Maximum bids to refund this call.
    function refundAll(uint256 maxCount) external nonReentrant {
        if (phase != Phase.Cancelled) revert NotCancelled();
        if (maxCount == 0) revert ZeroBatch();
        _refundBatch(maxCount);
    }

    /// @notice Trustless last-resort recovery, callable by ANYONE once `absoluteEndTime + EMERGENCY_GRACE`
    ///         has passed and the auction is not yet `Settled`. Covers the two ways settlement can
    ///         get stuck with no owner around: (1) the auction was never authorized to mint (so
    ///         `finalize` reverts for everyone, forever), or (2) it was bricked mid-`finalize`
    ///         (mint rights revoked / cap lowered) while `cancelAuction` is already locked out.
    ///         Refunds every still-unminted bid in full, in batches, and mints nothing. Winners
    ///         already minted keep their tokens; their clearing payments (`proceeds`) are released
    ///         to the payout split on the final batch so no ETH is stranded.
    /// @dev    Unlike `finalize`, this does not touch the NFT, so a missing/removed mint
    ///         authorization cannot block it. Enters the `Cancelled` terminal state on the first
    ///         call (locking out `finalize`) and shares `refundCursor` with `refundAll`, so it
    ///         composes with any partial owner-driven refund.
    /// @param maxCount Maximum bids to refund this call.
    function emergencyRefund(uint256 maxCount) external nonReentrant {
        if (block.timestamp <= uint256(absoluteEndTime) + EMERGENCY_GRACE) revert NotYetEmergency();
        if (phase == Phase.Settled) revert AlreadySettled();
        if (maxCount == 0) revert ZeroBatch();

        // First call locks out `finalize` by entering the Cancelled terminal state.
        if (phase != Phase.Cancelled) {
            phase = Phase.Cancelled;
            emit EmergencyRefundStarted(finalizeCursor, remainingBidCount);
        }

        _refundBatch(maxCount);
    }

    /// @notice Recover immediately when another mint permanently consumes the auction's expected
    ///         token sequence. Permissionless in both Active and Finalizing because `totalMinted` is
    ///         monotonic and an already-consumed ID cannot be restored.
    function recoverFromSupplyMismatch(uint256 maxCount) external nonReentrant {
        if (phase != Phase.Active && phase != Phase.Finalizing) revert NotFinalizable();
        if (maxCount == 0) revert ZeroBatch();

        uint256 expectedSupply = expectedNftSupply();
        uint256 actualSupply = nft.totalMinted();
        if (actualSupply == expectedSupply) revert SupplyNotMismatched();

        phase = Phase.Cancelled;
        emit SupplyMismatchRecoveryStarted(expectedSupply, actualSupply, remainingBidCount);
        _refundBatch(maxCount);
    }

    /// @notice Permissionless recovery once the normal permissionless-finalize grace has elapsed and
    ///         settlement is objectively unable to mint every remaining winner because this auction
    ///         is not an authorized NFT operator or the current mint cap lacks sufficient headroom.
    ///         Already-minted winners keep their tokens; their proceeds are released when refunds finish.
    /// @dev    Uses the same Cancelled state and batched refund cursor as every other recovery path.
    ///         A healthy, fully capable settlement cannot be cancelled through this function.
    function recoverFromMintingUnavailable(uint256 maxCount) external nonReentrant {
        if (phase != Phase.Active && phase != Phase.Finalizing) revert NotFinalizable();
        if (block.timestamp < uint256(endTime) + FINALIZE_GRACE) revert NotYetMintingUnavailableRecovery();
        if (maxCount == 0) revert ZeroBatch();

        (bool operatorAuthorized, uint256 currentMintCap, uint256 requiredMintCap, bool unavailable) = _mintingStatus();
        if (!unavailable) revert MintingStillAvailable();

        phase = Phase.Cancelled;
        emit MintingUnavailableRecoveryStarted(
            operatorAuthorized, currentMintCap, requiredMintCap, finalizeCursor, remainingBidCount
        );
        _refundBatch(maxCount);
    }

    /// @notice Rescue only ETH that is provably above every tracked auction liability.
    /// @dev Restricted to a fully processed terminal state, so the owner can never sweep bid escrow.
    function rescueSurplusETH(address to) external onlyOwner nonReentrant {
        if (phase != Phase.Settled && (phase != Phase.Cancelled || !refundsComplete)) revert RecoveryIncomplete();
        if (to == address(0)) revert InvalidConfig();
        uint256 amount = surplusETH();
        if (amount == 0) revert NothingToRescue();
        SafeTransferLib.forceSafeTransferETH(to, amount);
        emit SurplusETHRescued(to, amount);
    }

    /// @notice Rescue an ERC20 accidentally sent to this ETH-only auction.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || token.code.length == 0 || to == address(0)) revert InvalidConfig();
        SafeTransferLib.safeTransfer(token, to, amount);
        emit ERC20Rescued(token, to, amount);
    }

    /// @notice Rescue an ERC721 accidentally transferred to this auction.
    function rescueERC721(address token, address to, uint256 tokenId) external onlyOwner nonReentrant {
        if (token == address(0) || token.code.length == 0 || to == address(0)) revert InvalidConfig();
        IERC721Rescue(token).transferFrom(address(this), to, tokenId);
        emit ERC721Rescued(token, to, tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                            OWNER CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice Adjust the schedule before any bid is placed (duration is customizable).
    function setSchedule(uint64 startTime_, uint64 duration_) external onlyOwner {
        if (phase != Phase.Active || nextBidId != 1) revert TooLateToConfigure();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION || startTime_ <= block.timestamp) {
            revert InvalidConfig();
        }
        uint256 et256 = uint256(startTime_) + duration_;
        uint256 absoluteEt256 = et256 + MAX_TOTAL_EXTENSION;
        if (absoluteEt256 > type(uint64).max) revert InvalidConfig();
        startTime = startTime_;
        uint64 newEndTime = SafeCastLib.toUint64(et256);
        uint64 newAbsoluteEndTime = SafeCastLib.toUint64(absoluteEt256);
        endTime = newEndTime;
        absoluteEndTime = newAbsoluteEndTime;
        emit ScheduleUpdated(startTime_, newEndTime, newAbsoluteEndTime);
    }

    /// @notice Emergency switch that only gates new bids/increases (never withdrawals or refunds).
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @dev Number of active bids currently held (<= MAX_UNITS).
    function activeBids() public view returns (uint256) {
        return remainingBidCount;
    }

    /// @dev Whether all `MAX_UNITS` slots are filled.
    function isFull() public view returns (bool) {
        return phase == Phase.Active && remainingBidCount >= MAX_UNITS;
    }

    /// @dev The price a winner would pay if the auction ended right now.
    function currentClearingPrice() public view returns (uint256) {
        if (phase != Phase.Active) return clearingPrice;
        return isFull() ? bids[_heap[1]].amount : reservePrice;
    }

    /// @dev The lowest active bid amount (the heap root), or 0 if there are no active bids.
    function lowestActiveBid() public view returns (uint256) {
        return phase == Phase.Active && remainingBidCount > 0 ? bids[_heap[1]].amount : 0;
    }

    /// @dev The minimum msg.value a NEW bid must send to be accepted right now.
    function minimumBid() public view returns (uint256) {
        if (phase != Phase.Active) return 0;
        if (!isFull()) return reservePrice;
        uint256 floor = bids[_heap[1]].amount;
        return floor + _bpsIncrement(floor);
    }

    /// @dev Minimum ETH an `increaseBid` top-up must send to trigger an anti-snipe extension:
    ///      `minIncrementBps` of the current clearing floor (the #90 bid). During the extension
    ///      window, smaller increases are rejected so a competitive raise cannot be split to evade it.
    function minIncreaseForExtension() external view returns (uint256) {
        return phase == Phase.Active && remainingBidCount > 0 ? _extendThreshold(bids[_heap[1]].amount) : 0;
    }

    /// @dev Seconds until the auction ends (0 if ended).
    function timeRemaining() external view returns (uint256) {
        return block.timestamp >= endTime ? 0 : endTime - block.timestamp;
    }

    /// @dev Total ETH still owed by the auction. Any balance above this is accidental surplus.
    function totalLiabilities() public view returns (uint256) {
        return totalEscrowed + totalPendingReturns + unreleasedProceeds;
    }

    /// @dev ETH provably above all tracked bidder and payout liabilities.
    function surplusETH() public view returns (uint256) {
        uint256 liabilities = totalLiabilities();
        uint256 balance = address(this).balance;
        return balance > liabilities ? balance - liabilities : 0;
    }

    function expectedNftSupply() public view returns (uint256) {
        return FIRST_TOKEN_ID - 1 + finalizeCursor;
    }

    function supplyMismatched() public view returns (bool) {
        if (phase != Phase.Active && phase != Phase.Finalizing) return false;
        return nft.totalMinted() != expectedNftSupply();
    }

    /// @dev Cumulative NFT cap needed to mint every still-unprocessed winner from the current phase.
    ///      Returns zero outside the two settleable phases.
    function requiredMintCapForSettlement() public view returns (uint256) {
        if (phase != Phase.Active && phase != Phase.Finalizing) return 0;
        uint256 remainingWinners = phase == Phase.Active ? remainingBidCount : winnerCount - finalizeCursor;
        return expectedNftSupply() + remainingWinners;
    }

    /// @dev Whether settlement currently lacks operator authorization or sufficient mint-cap headroom.
    ///      Time eligibility is deliberately separate: recovery opens at `endTime + FINALIZE_GRACE`.
    function mintingUnavailable() public view returns (bool) {
        if (phase != Phase.Active && phase != Phase.Finalizing) return false;
        (,,, bool unavailable) = _mintingStatus();
        return unavailable;
    }

    /// @dev All active bids (ids, bidders, amounts) in unspecified order — sort client-side.
    function getBids() external view returns (uint32[] memory ids, address[] memory bidders, uint96[] memory amounts) {
        uint256 slots = _heap.length - 1;
        uint256 count = remainingBidCount;
        ids = new uint32[](count);
        bidders = new address[](count);
        amounts = new uint96[](count);
        uint256 k;
        for (uint256 i = 1; i <= slots && k < count; ++i) {
            uint32 id = _heap[i];
            Bid memory b = bids[id];
            if (b.bidder == address(0)) continue;
            ids[k] = id;
            bidders[k] = b.bidder;
            amounts[k] = b.amount;
            ++k;
        }
    }

    /// @dev The active bids (ids and amounts) held by `who`.
    function bidsOf(address who) external view returns (uint32[] memory ids, uint96[] memory amounts) {
        uint256 n = _heap.length - 1;
        uint256 count = activeBidCount[who];
        ids = new uint32[](count);
        amounts = new uint96[](count);
        uint256 k;
        for (uint256 i = 1; i <= n && k < count; ++i) {
            uint32 id = _heap[i];
            if (bids[id].bidder == who) {
                ids[k] = id;
                amounts[k] = bids[id].amount;
                ++k;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL: LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function _requireBiddable() internal view {
        if (phase != Phase.Active) revert NotActive();
        if (paused) revert IsPaused();
        if (block.timestamp < startTime) revert NotStarted();
        if (block.timestamp >= endTime) revert AuctionEnded();
        uint256 expectedSupply = FIRST_TOKEN_ID - 1;
        uint256 actualSupply = nft.totalMinted();
        if (actualSupply != expectedSupply) revert UnexpectedSupply(expectedSupply, actualSupply);
    }

    /// @dev Ceiling BPS increment: advertised minimum percentages are never rounded down.
    function _bpsIncrement(uint256 amount) internal view returns (uint256) {
        return (amount * minIncrementBps + BPS_DENOM - 1) / BPS_DENOM;
    }

    function _extendThreshold(uint256 floor) internal view returns (uint256) {
        return _bpsIncrement(floor);
    }

    // Anti-snipe: any qualifying bid in the last EXT_WINDOW pushes the end to now + EXT_LEN.
    // The scheduled end can move by at most MAX_TOTAL_EXTENSION (24 hours).
    function _maybeExtend() internal {
        uint256 end = endTime;
        if (block.timestamp + EXT_WINDOW >= end) {
            uint256 newEnd = block.timestamp + EXT_LEN;
            uint256 hardEnd = absoluteEndTime;
            if (newEnd > hardEnd) newEnd = hardEnd;
            if (newEnd > end) {
                uint64 newEndTime = SafeCastLib.toUint64(newEnd);
                endTime = newEndTime;
                unchecked {
                    extensionCount++;
                }
                emit Extended(newEndTime, extensionCount);
            }
        }
    }

    function _creditPendingReturn(address to, uint256 amount) internal {
        pendingReturns[to] += amount;
        totalPendingReturns += amount;
    }

    function _mintingStatus()
        internal
        view
        returns (bool operatorAuthorized, uint256 currentMintCap, uint256 requiredMintCap, bool unavailable)
    {
        operatorAuthorized = nft.authorizedOperators(address(this));
        currentMintCap = nft.mintCap();
        requiredMintCap = requiredMintCapForSettlement();
        unavailable = !operatorAuthorized || currentMintCap < requiredMintCap;
    }

    function _refundBatch(uint256 maxCount) internal {
        uint256 total = _heap.length - 1;
        uint256 cursor = refundCursor == 0 ? 1 : refundCursor;
        uint256 stop = cursor + maxCount;
        if (stop > total + 1) stop = total + 1;

        for (uint256 i = cursor; i < stop; ++i) {
            uint32 bidId = _heap[i];
            Bid memory b = bids[bidId];
            if (b.bidder == address(0)) continue; // already minted or refunded

            delete bids[bidId];
            heapPos[bidId] = 0;
            unchecked {
                activeBidCount[b.bidder]--;
                --remainingBidCount;
            }
            totalEscrowed -= b.amount;

            if (SafeTransferLib.trySafeTransferETH(b.bidder, b.amount, SafeTransferLib.GAS_STIPEND_NO_GRIEF)) {
                emit Refunded(b.bidder, b.amount);
            } else {
                _creditPendingReturn(b.bidder, b.amount);
                emit RefundFailed(b.bidder, b.amount);
            }
        }

        refundCursor = stop;
        emit RefundAllProgress(stop - 1, total);
        if (stop == total + 1) _completeRecovery();
    }

    function _completeRecovery() internal {
        if (refundsComplete) return;
        refundsComplete = true;
        _releaseProceeds();
        emit RefundAllComplete();
    }

    function _releaseProceeds() internal {
        uint256 amount = unreleasedProceeds;
        if (amount == 0) return;

        // Effects before interactions makes this idempotent from both normal and emergency completion.
        unreleasedProceeds = 0;
        uint256 aShare = (amount * SPLIT_A_BPS) / BPS_DENOM;
        uint256 bShare = amount - aShare;
        if (aShare > 0) SafeTransferLib.forceSafeTransferETH(payoutA, aShare);
        if (bShare > 0) SafeTransferLib.forceSafeTransferETH(payoutB, bShare);
        emit ProceedsReleased(amount, aShare, bShare);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL: MIN-HEAP
    //////////////////////////////////////////////////////////////*/

    function _siftUp(uint256 i) private {
        uint32[] storage h = _heap;
        while (i > 1) {
            uint256 parent = i >> 1;
            if (!_comesBeforeInMinHeap(h[i], h[parent])) break;
            _swap(i, parent);
            i = parent;
        }
    }

    function _siftDown(uint256 i) private {
        uint32[] storage h = _heap;
        uint256 n = h.length - 1;
        while (true) {
            uint256 smallest = i;
            uint256 l = i << 1;
            uint256 r = l + 1;
            if (l <= n && _comesBeforeInMinHeap(h[l], h[smallest])) smallest = l;
            if (r <= n && _comesBeforeInMinHeap(h[r], h[smallest])) smallest = r;
            if (smallest == i) break;
            _swap(i, smallest);
            i = smallest;
        }
    }

    /// @dev Lower amount is worse. For equal amounts the later bid is worse, so earliest bids survive
    ///      displacement and also win earlier reveal slots during finalization.
    function _comesBeforeInMinHeap(uint32 a, uint32 b) private view returns (bool) {
        uint96 amountA = bids[a].amount;
        uint96 amountB = bids[b].amount;
        return amountA < amountB || (amountA == amountB && a > b);
    }

    function _swap(uint256 i, uint256 j) private {
        uint32[] storage h = _heap;
        uint32 a = h[i];
        uint32 b = h[j];
        h[i] = b;
        h[j] = a;
        heapPos[b] = SafeCastLib.toUint32(i);
        heapPos[a] = SafeCastLib.toUint32(j);
    }
}
