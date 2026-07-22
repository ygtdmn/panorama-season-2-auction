// Turns viem/wagmi errors into one human sentence, or null when nothing should be shown
// (user rejected in wallet). Custom errors decode because panoramaAuctionAbi declares them.

import {
	BaseError,
	ContractFunctionRevertedError,
	UserRejectedRequestError,
} from "viem";
import { ethCeil } from "./format";

const ERROR_COPY: Record<string, (args: readonly unknown[]) => string> = {
	BidTooLow: (a) => `Bid too low. The minimum right now is ${ethCeil(a[0] as bigint, 6)} ETH.`,
	BidIncreaseTooLow: (a) =>
		`Raises in the final five minutes must add at least ${ethCeil(a[0] as bigint, 6)} ETH.`,
	BelowReserve: () => "Bid is below the reserve price.",
	AuctionEnded: () => "Bidding has ended.",
	AuctionNotEnded: () => "The auction has not ended yet.",
	NotStarted: () => "Bidding has not opened yet.",
	NotActive: () => "The auction is not accepting bids.",
	IsPaused: () => "Bidding is paused.",
	TooManyBids: () => "This wallet already holds the maximum of 4 bids.",
	AmountTooLarge: () => "Amount is too large.",
	NotYourBid: () => "That bid belongs to a different wallet.",
	ZeroIncrease: () => "Enter an amount to raise by.",
	ZeroBatch: () => "Batch size must be at least 1.",
	NothingToWithdraw: () => "Nothing to withdraw for this wallet.",
	NotFinalizable: () => "Settlement is not available in this phase.",
	NotAuthorizedToFinalize: () =>
		"Settlement is owner-only until the 7-day grace period passes. See the recovery page.",
	NotOperatorAuthorized: () => "The auction is not authorized to mint yet.",
	InsufficientMintCap: () => "The mint cap does not cover the remaining winners.",
	NotCancellable: () => "The auction can only be cancelled while active.",
	NotCancelled: () => "Refund-all needs a cancelled auction.",
	NotYetEmergency: () => "The emergency window has not opened yet.",
	AlreadySettled: () => "The auction is already settled.",
	TooLateToConfigure: () => "The schedule locks after the first bid.",
	UnexpectedSupply: () =>
		"The collection supply changed unexpectedly. Settlement is halted; recovery is available.",
	UnexpectedTokenId: () => "Settlement halted on an unexpected token id.",
	NoBidFound: () => "No bid found to process.",
	RecoveryIncomplete: () => "Recovery must finish before rescue.",
	NothingToRescue: () => "No surplus to rescue.",
	SupplyNotMismatched: () => "Supply matches. Mismatch recovery is not needed.",
	NotYetMintingUnavailableRecovery: () =>
		"Minting-capability recovery opens after the seven-day settlement grace period.",
	MintingStillAvailable: () =>
		"Minting is still available. Continue settlement instead of starting refunds.",
	InvalidConfig: () => "Invalid configuration.",
};

/**
 * Wallet-side failures viem cannot classify all arrive as one generic sentence
 * ("Transaction creation failed.") with the real reason buried in `details`/`cause`. These are
 * the ones bidders actually hit, so they get an answer they can act on.
 */
function describeWalletFailure(text: string): string | null {
	if (/insufficient funds/i.test(text)) {
		return "Not enough ETH for the bid plus gas in this wallet.";
	}
	if (/(gas required exceeds|cannot estimate gas|unpredictable gas|execution reverted|always failing)/i.test(text)) {
		// The simulation passed a moment earlier, so this is nearly always a bid that was
		// outbid between the preview and the wallet signing screen.
		return "The minimum moved before your wallet sent this. Re-check the minimum and bid again.";
	}
	if (/replacement transaction underpriced|already known|nonce too low/i.test(text)) {
		return "Your wallet still has an earlier transaction for this nonce. Wait for it or speed it up in the wallet.";
	}
	if (/chain (id )?mismatch|wrong network|unsupported chain/i.test(text)) {
		return "Your wallet is on the wrong network. Switch to Ethereum mainnet and try again.";
	}
	if (/intrinsic gas too low|max fee per gas|fee cap|underpriced/i.test(text)) {
		return "Your wallet's gas settings were rejected by the network. Retry with the wallet's default fees.";
	}
	if (/timeout|timed out|network (error|request failed)|failed to fetch|load failed/i.test(text)) {
		return "Your wallet could not reach the network. Check your connection and try again.";
	}
	return null;
}

function isUserRejection(err: unknown): boolean {
	if (err instanceof BaseError) {
		if (err.walk((e) => e instanceof UserRejectedRequestError)) return true;
	}
	const code = (err as { code?: number })?.code;
	if (code === 4001) return true;
	const msg = err instanceof Error ? err.message : "";
	return /user rejected|user denied|rejected the request/i.test(msg);
}

/**
 * One sentence for a failed simulation, send, or reverted receipt.
 * Returns null when the user cancelled in their wallet (show nothing).
 */
export function describeAuctionError(err: unknown): string | null {
	if (err == null) return null;
	if (isUserRejection(err)) return null;

	if (err instanceof Error && err.name === "WaitForTransactionReceiptTimeoutError") {
		return "Still waiting for the transaction. It may have been replaced; check your wallet activity or the transaction link.";
	}

	if (err instanceof BaseError) {
		const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as
			| ContractFunctionRevertedError
			| null;
		if (revert) {
			const name = revert.data?.errorName ?? revert.signature;
			if (name && ERROR_COPY[name]) {
				return ERROR_COPY[name](revert.data?.args ?? []);
			}
			if (revert.reason) return revert.reason;
			if (name) return `Transaction reverted: ${name}.`;
		}
		// No decoded revert: the wallet or its node refused the send. Read the reason out of
		// details/metaMessages/cause before falling back to viem's generic summary, which on its
		// own ("Transaction creation failed.") tells a bidder nothing they can act on.
		const detail = [
			err.details,
			err.shortMessage,
			err.metaMessages?.join(" "),
			(err.cause as { message?: string } | undefined)?.message,
			err.message,
		]
			.filter(Boolean)
			.join(" ");
		const walletCopy = describeWalletFailure(detail);
		if (walletCopy) return walletCopy;
		const short = err.shortMessage.split("\n")[0].trim();
		// Keep the wallet's own words when viem's summary carries no information.
		if (/^transaction creation failed\.?$/i.test(short) && err.details) {
			return `Your wallet refused the transaction: ${err.details.split("\n")[0].slice(0, 150)}`;
		}
		return short.slice(0, 200);
	}

	const msg = err instanceof Error ? err.message : String(err);
	const walletCopy = describeWalletFailure(msg);
	if (walletCopy) return walletCopy;
	return msg.split("\n")[0].slice(0, 200);
}
