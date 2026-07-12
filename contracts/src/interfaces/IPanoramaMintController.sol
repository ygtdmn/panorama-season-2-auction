// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IPanoramaMintController {
    event SeasonMintCapUpdated(uint8 indexed season, uint256 mintCap);

    function seasonMintCap(uint8 season) external view returns (uint256);
    function seasonCount() external view returns (uint8);
    function getMintCap() external view returns (uint256);
    function setSeasonMintCap(uint8 season, uint256 mintCap) external;
}
