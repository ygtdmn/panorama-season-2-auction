// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { ERC721 } from "solady/tokens/ERC721.sol";
import { Ownable } from "solady/auth/Ownable.sol";
import { Lifebuoy } from "solady/utils/Lifebuoy.sol";
import { IPanorama } from "./interfaces/IPanorama.sol";
import { IPanoramaRenderer } from "./interfaces/IPanoramaRenderer.sol";
import { IPanoramaMintController } from "./interfaces/IPanoramaMintController.sol";

/// @title Panorama
/// @author Yigit Duman (@yigitduman)

contract Panorama is ERC721, Ownable, Lifebuoy, IPanorama {
    uint256 public constant MAX_SUPPLY = 365;
    uint256 public totalMinted;
    uint256 public totalBurned;

    // Contract References
    address public renderer;
    address public storageContract;
    address public muriOperator;
    address public panoramaERC20;
    address public muriProtocol;
    address public mintController;

    // Authorized addresses that can mint new tokens and signal metadata update
    mapping(address operator => bool authorized) public authorizedOperators;

    modifier onlyOwnerOrOperator() {
        if (
            msg.sender != owner() && msg.sender != storageContract && msg.sender != muriOperator
                && msg.sender != renderer && !authorizedOperators[msg.sender]
        ) {
            revert NotOwnerOrOperator();
        }
        _;
    }

    constructor() {
        _initializeOwner(msg.sender);
    }

    function name() public pure override returns (string memory) {
        return "Panorama";
    }

    function symbol() public pure override returns (string memory) {
        return "PANO";
    }

    // ERC721 tokenURI
    function tokenURI(uint256 id) public view override returns (string memory) {
        if (!_exists(id)) revert TokenDoesNotExist();
        if (renderer == address(0)) revert RendererNotSet();
        return IPanoramaRenderer(renderer).tokenURI(id);
    }

    // ERC20 tokenURI
    function tokenURI() external view override returns (string memory) {
        if (renderer == address(0)) revert RendererNotSet();
        return IPanoramaRenderer(renderer).tokenURI();
    }

    function maxSupply() public pure override returns (uint256) {
        return MAX_SUPPLY;
    }

    function mintCap() public view override returns (uint256) {
        if (mintController == address(0)) return MAX_SUPPLY;
        uint256 cap = IPanoramaMintController(mintController).getMintCap();
        return cap < MAX_SUPPLY ? cap : MAX_SUPPLY;
    }

    function totalSupply() external view override returns (uint256) {
        return totalMinted - totalBurned;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == bytes4(0x49064906) // EIP-4906
            || super.supportsInterface(interfaceId);
    }

    function mintTo(address to) external override onlyOwnerOrOperator returns (uint256) {
        if (totalMinted + 1 > mintCap()) revert MaxSupplyReached();
        uint256 tokenId = ++totalMinted;
        _mint(to, tokenId);
        return tokenId;
    }

    function mintTo(address to, uint256 quantity) external override onlyOwnerOrOperator returns (uint256[] memory) {
        if (totalMinted + quantity > mintCap()) revert MaxSupplyReached();
        uint256[] memory tokenIds = new uint256[](quantity);
        for (uint256 i; i < quantity; ++i) {
            uint256 tokenId = ++totalMinted;
            _mint(to, tokenId);
            tokenIds[i] = tokenId;
        }
        return tokenIds;
    }

    function burn(uint256 tokenId) external override {
        _burn(msg.sender, tokenId);
        ++totalBurned;
    }

    function signalMetadataUpdate() public override onlyOwnerOrOperator {
        emit BatchMetadataUpdate(0, totalMinted);
    }

    function signalMetadataUpdate(uint256 tokenId) external override onlyOwnerOrOperator {
        emit MetadataUpdate(tokenId);
    }

    function signalBatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external override onlyOwnerOrOperator {
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    function setAuthorizedOperator(address operator, bool authorized) external override onlyOwner {
        authorizedOperators[operator] = authorized;
        emit AuthorizedOperatorUpdated(operator, authorized);
    }

    function setRenderer(address _renderer) external override onlyOwner {
        renderer = _renderer;
        signalMetadataUpdate();
    }

    function setStorageContract(address _storage) external override onlyOwner {
        storageContract = _storage;
        signalMetadataUpdate();
    }

    function setMuriOperator(address _muriOperator) external override onlyOwner {
        muriOperator = _muriOperator;
        signalMetadataUpdate();
    }

    function setPanoramaERC20(address _token) external override onlyOwner {
        panoramaERC20 = _token;
        signalMetadataUpdate();
    }

    function setMuriProtocol(address _muriProtocol) external override onlyOwner {
        muriProtocol = _muriProtocol;
        signalMetadataUpdate();
    }

    function setMintController(address _mintController) external override onlyOwner {
        mintController = _mintController;
        signalMetadataUpdate();
    }
}
