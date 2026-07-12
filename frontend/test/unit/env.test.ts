import { describe, expect, it } from "vitest";
import { EnvError, validateRpcUrl } from "@/lib/env";

describe("RPC URL validation", () => {
	it("requires HTTPS for mainnet and sepolia", () => {
		expect(validateRpcUrl("https://rpc.example", 1)).toBe("https://rpc.example");
		expect(validateRpcUrl("https://rpc.example", 11155111)).toBe("https://rpc.example");
		expect(() => validateRpcUrl("http://rpc.example", 1)).toThrow(EnvError);
		expect(() => validateRpcUrl("http://rpc.example", 11155111)).toThrow(EnvError);
	});

	it("rejects ws and wss because the app constructs an HTTP transport", () => {
		expect(() => validateRpcUrl("wss://rpc.example", 1)).toThrow(/HTTP transport/);
		expect(() => validateRpcUrl("ws://127.0.0.1:8545", 31337)).toThrow(/HTTP transport/);
	});

	it("allows plain HTTP only for loopback anvil", () => {
		expect(validateRpcUrl("http://127.0.0.1:8545", 31337)).toBe(
			"http://127.0.0.1:8545",
		);
		expect(validateRpcUrl("http://localhost:8545", 31337)).toBe(
			"http://localhost:8545",
		);
		expect(() => validateRpcUrl("http://192.168.1.5:8545", 31337)).toThrow(
			/only allowed for local anvil/,
		);
	});

	it("rejects malformed and non-HTTP URLs", () => {
		expect(() => validateRpcUrl("not a url", 1)).toThrow(EnvError);
		expect(() => validateRpcUrl("ftp://rpc.example", 1)).toThrow(EnvError);
	});
});
