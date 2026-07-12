// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Ownable } from "solady/auth/Ownable.sol";
import { IPanoramaMintController } from "./interfaces/IPanoramaMintController.sol";

/// @title PanoramaMintController
/// @author Yigit Duman (@yigitduman)

contract PanoramaMintController is Ownable, IPanoramaMintController {
    mapping(uint8 season => uint256 mintCap) public seasonMintCap;
    uint8 public seasonCount;

    constructor() {
        _initializeOwner(msg.sender);
    }

    function getMintCap() external view returns (uint256) {
        uint256 total;
        for (uint8 i = 1; i <= seasonCount; ++i) {
            total += seasonMintCap[i];
        }
        return total;
    }

    function setSeasonMintCap(uint8 season, uint256 mintCap) external onlyOwner {
        require(season > 0 && season <= seasonCount + 1, "Invalid season");
        if (season == seasonCount + 1) {
            ++seasonCount;
        }
        seasonMintCap[season] = mintCap;
        emit SeasonMintCapUpdated(season, mintCap);
    }
}
