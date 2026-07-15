// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { DeployAuction } from "./DeployAuction.s.sol";

/// @notice Sepolia rehearsal deployment of the Season 2 auction. Runs the exact same
///         config validation, deployment, and postconditions as DeployAuction — only the
///         chain gate differs. Mainnet deployments must use DeployAuction directly.
contract DeployAuctionSepolia is DeployAuction {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    function _requiredChainId() internal pure override returns (uint256) {
        return SEPOLIA_CHAIN_ID;
    }
}
