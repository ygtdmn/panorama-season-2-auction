// SPDX-License-Identifier: MIT
pragma solidity >=0.8.34 <0.9.0;

import { SettleAuctionAtomic } from "./SettleAuctionAtomic.s.sol";

/// @notice Sepolia rehearsal settlement of the Season 2 auction. Runs the exact same
///         preflight, settlement sequence, and post-state verification as
///         SettleAuctionAtomic — only the chain gate differs. Mainnet settlement must
///         use SettleAuctionAtomic directly.
contract SettleAuctionAtomicSepolia is SettleAuctionAtomic {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    function _requiredChainId() internal pure override returns (uint256) {
        return SEPOLIA_CHAIN_ID;
    }
}
