// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IPanorama {
    error MaxSupplyReached();
    error RendererNotSet();
    error NotOwnerOrOperator();

    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event AuthorizedOperatorUpdated(address indexed operator, bool indexed authorized);

    // ERC20
    function tokenURI() external view returns (string memory);

    // State
    function MAX_SUPPLY() external view returns (uint256);
    function totalMinted() external view returns (uint256);
    function totalBurned() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function renderer() external view returns (address);
    function storageContract() external view returns (address);
    function muriOperator() external view returns (address);
    function panoramaERC20() external view returns (address);
    function muriProtocol() external view returns (address);
    function authorizedOperators(address operator) external view returns (bool);

    // Mutations
    function mintTo(address to) external returns (uint256);
    function mintTo(address to, uint256 quantity) external returns (uint256[] memory);
    function burn(uint256 tokenId) external;
    function signalMetadataUpdate() external;
    function signalMetadataUpdate(uint256 tokenId) external;
    function signalBatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;
    function setAuthorizedOperator(address operator, bool authorized) external;
    function setRenderer(address _renderer) external;
    function setStorageContract(address _storage) external;
    function setMuriOperator(address _muriOperator) external;
    function setPanoramaERC20(address _token) external;
    function setMuriProtocol(address _muriProtocol) external;
    function mintController() external view returns (address);
    function maxSupply() external view returns (uint256);
    function mintCap() external view returns (uint256);
    function setMintController(address _mintController) external;
}
