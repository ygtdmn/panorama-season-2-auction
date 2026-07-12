// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { Script } from "forge-std/src/Script.sol";

abstract contract BaseScript is Script {
    /// @dev Needed for the deterministic deployments.
    bytes32 internal constant ZERO_SALT = bytes32(0);

    /// @dev The address of the transaction broadcaster.
    address internal broadcaster;

    /// @dev The broadcaster's private key, taken from $PRIVATE_KEY.
    uint256 internal privateKey;

    /// @dev Initializes the transaction broadcaster from the $PRIVATE_KEY environment variable.
    ///
    /// There is deliberately no fallback key: running any script without an explicit
    /// $PRIVATE_KEY must fail instead of silently broadcasting from a publicly known
    /// test account.
    constructor() {
        string memory pkString = vm.envOr({ name: "PRIVATE_KEY", defaultValue: string("") });
        require(bytes(pkString).length != 0, "PRIVATE_KEY env var is required (no fallback key)");
        privateKey = vm.parseUint(pkString);
        broadcaster = vm.addr(privateKey);
    }

    modifier broadcast() {
        vm.startBroadcast(privateKey);
        _;
        vm.stopBroadcast();
    }
}
