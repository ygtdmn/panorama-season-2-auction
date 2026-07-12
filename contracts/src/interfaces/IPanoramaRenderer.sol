// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IPanoramaRenderer {
    error PanoramaNotSet();

    // State
    function panorama() external view returns (address);
    function prerevealBaseUrl() external view returns (string memory);

    // View
    function tokenURI() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function renderPanoramaHtml() external view returns (string memory);
    function resolveTableauImageUrl(uint256 tokenId) external view returns (string memory);
    function resolveTableauAnimationUrl(uint256 tokenId) external view returns (string memory);

    // Mutations
    function setPanorama(address _panorama) external;
    function setPrerevealBaseUrl(string calldata _url) external;
}
