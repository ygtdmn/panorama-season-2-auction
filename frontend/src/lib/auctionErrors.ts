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
		// Fall back to viem's concise summary, first line only.
		return err.shortMessage.split("\n")[0].slice(0, 200);
	}

	const msg = err instanceof Error ? err.message : String(err);
	return msg.split("\n")[0].slice(0, 200);
}
