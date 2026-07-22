import { describe, expect, it } from "vitest";
import {
	BaseError,
	ContractFunctionRevertedError,
	UserRejectedRequestError,
	encodeErrorResult,
	parseEther,
} from "viem";
import { panoramaAuctionAbi } from "@/lib/abis/panoramaAuction";
import { describeAuctionError } from "@/lib/auctionErrors";

function revertError(errorName: string, args: readonly unknown[] = []): BaseError {
	const data = encodeErrorResult({
		abi: panoramaAuctionAbi,
		errorName,
		args,
		// Dynamic error name for test brevity; runtime-validated by encodeErrorResult.
	} as Parameters<typeof encodeErrorResult>[0]);
	const revert = new ContractFunctionRevertedError({
		abi: panoramaAuctionAbi,
		functionName: "placeBid",
		data,
	});
	return new BaseError("Execution reverted.", { cause: revert });
}

describe("describeAuctionError", () => {
	it("decodes BidTooLow with a ceil-formatted minimum", () => {
		const msg = describeAuctionError(revertError("BidTooLow", [parseEther("0.11025")]));
		expect(msg).toBe("Bid too low. The minimum right now is 0.11025 ETH.");
	});

	it("never understates the decoded minimum", () => {
		// 0.110250000000000001 must NOT display as 0.11025 (typing that would revert again).
		const min = parseEther("0.11025") + 1n;
		const msg = describeAuctionError(revertError("BidTooLow", [min]));
		expect(msg).toContain("0.110251");
	});

	it("decodes BidIncreaseTooLow", () => {
		const msg = describeAuctionError(revertError("BidIncreaseTooLow", [parseEther("0.005")]));
		expect(msg).toBe("Raises in the final five minutes must add at least 0.005 ETH.");
	});

	it("covers the common bidding reverts with human copy", () => {
		expect(describeAuctionError(revertError("AuctionEnded"))).toBe("Bidding has ended.");
		expect(describeAuctionError(revertError("BelowReserve"))).toBe(
			"Bid is below the reserve price.",
		);
		expect(describeAuctionError(revertError("TooManyBids"))).toBe(
			"This wallet already holds the maximum of 4 bids.",
		);
		expect(describeAuctionError(revertError("IsPaused"))).toBe("Bidding is paused.");
		expect(describeAuctionError(revertError("UnexpectedSupply", [90n, 91n]))).toContain(
			"halted",
		);
	});

	it("returns null for user rejections (nothing to toast)", () => {
		const rejection = new BaseError("User rejected the request.", {
			cause: new UserRejectedRequestError(new Error("User rejected the request.")),
		});
		expect(describeAuctionError(rejection)).toBeNull();
		expect(describeAuctionError({ code: 4001, message: "User rejected" })).toBeNull();
	});

	it("falls back to the first line of unknown errors", () => {
		const msg = describeAuctionError(new Error("boom\nsecond line"));
		expect(msg).toBe("boom");
	});

	it("returns null for nullish input", () => {
		expect(describeAuctionError(null)).toBeNull();
		expect(describeAuctionError(undefined)).toBeNull();
	});
});

describe("wallet-side send failures", () => {
	// viem wraps anything the wallet refuses in one generic sentence; the reason lives in details.
	function walletError(details: string): BaseError {
		const err = new BaseError("Transaction creation failed.", { details });
		return err;
	}

	it("explains a lost race instead of the generic wrapper", () => {
		expect(describeAuctionError(walletError("execution reverted"))).toBe(
			"The minimum moved before your wallet sent this. Re-check the minimum and bid again.",
		);
		expect(describeAuctionError(walletError("cannot estimate gas; transaction may fail"))).toBe(
			"The minimum moved before your wallet sent this. Re-check the minimum and bid again.",
		);
	});

	it("names the common wallet refusals", () => {
		expect(describeAuctionError(walletError("insufficient funds for gas * price + value"))).toBe(
			"Not enough ETH for the bid plus gas in this wallet.",
		);
		expect(describeAuctionError(walletError("nonce too low"))).toContain("earlier transaction");
		expect(describeAuctionError(walletError("Failed to fetch"))).toContain("could not reach the network");
	});

	it("falls back to the wallet's own words, never to the bare wrapper", () => {
		const msg = describeAuctionError(walletError("Provider disconnected while signing"));
		expect(msg).toBe("Your wallet refused the transaction: Provider disconnected while signing");
	});

	it("still returns null for a user rejection", () => {
		expect(describeAuctionError(new UserRejectedRequestError(new Error("denied")))).toBeNull();
	});
});
