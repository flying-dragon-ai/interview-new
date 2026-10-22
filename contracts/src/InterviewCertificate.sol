// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title InterviewCertificate — LGD 群面模拟器 · 面试报告 soulbound 证书
 * @notice 付费铸造、不可转让（soulbound）、可销毁。reportHash 为前端对报告
 *         规范化 JSON（含 sessionId 与铸造者地址）计算的 keccak256。
 *         同一 reportHash 全局只能铸造一次，防止重复铸证。
 *
 * @dev Monad 计费差异（monskills gas/）：按 gas_limit 而非 gas_used 收费，
 *      前端必须设置紧凑的显式 gas limit（估值 + ≤10% buffer）。
 *      mintCertificate 实测 gas 见 test/gas snapshot 与 docs/monad-onchain.md。
 */
contract InterviewCertificate is ERC721, Ownable {
    uint256 private _nextTokenId = 1;

    /// @notice 铸证价格（wei/MON）。owner 可调；价格即付费点，不另设支付合约。
    uint256 public mintPrice;

    /// @notice 资金归集地址。withdraw() 把合约余额全部打入 treasury。
    address public treasury;

    /// @notice tokenId → 报告哈希
    mapping(uint256 => bytes32) public reportHashOf;

    /// @notice 报告哈希 → tokenId（0 = 未铸造）。任何人可凭报告哈希反查证书。
    mapping(bytes32 => uint256) public certificateOfReport;

    event CertificateMinted(
        uint256 indexed tokenId,
        address indexed recipient,
        bytes32 indexed reportHash,
        uint256 paidAmount
    );
    event MintPriceUpdated(uint256 previousPrice, uint256 newPrice);
    event TreasuryUpdated(address previousTreasury, address newTreasury);

    error InsufficientPayment(uint256 required, uint256 provided);
    error ReportAlreadyMinted(bytes32 reportHash, uint256 existingTokenId);
    error SoulboundTransfer();
    error ZeroAddress();
    error WithdrawFailed();

    constructor(uint256 initialMintPrice, address initialTreasury)
        ERC721("LGD Interview Certificate", "LGDCERT")
        Ownable(msg.sender)
    {
        if (initialTreasury == address(0)) revert ZeroAddress();
        mintPrice = initialMintPrice;
        treasury = initialTreasury;
    }

    /**
     * @notice 付费铸造面试报告证书（铸给 msg.sender，不可转让）。
     * @param reportHash 报告规范化 JSON 的 keccak256
     * @return tokenId 新证书 id（自增，从 1 开始）
     * @dev 多付不退（视为小费）；金额进入合约，由 withdraw() 归集到 treasury。
     */
    function mintCertificate(bytes32 reportHash) external payable returns (uint256 tokenId) {
        if (msg.value < mintPrice) revert InsufficientPayment(mintPrice, msg.value);
        uint256 existing = certificateOfReport[reportHash];
        if (existing != 0) revert ReportAlreadyMinted(reportHash, existing);

        tokenId = _nextTokenId++;
        certificateOfReport[reportHash] = tokenId;
        reportHashOf[tokenId] = reportHash;
        _safeMint(msg.sender, tokenId);
        emit CertificateMinted(tokenId, msg.sender, reportHash, msg.value);
    }

    /// @notice 链上验真：tokenId 存在且报告哈希一致
    function verifyReport(uint256 tokenId, bytes32 reportHash) external view returns (bool) {
        return _ownerOf(tokenId) != address(0) && reportHashOf[tokenId] == reportHash;
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    function setMintPrice(uint256 newPrice) external onlyOwner {
        emit MintPriceUpdated(mintPrice, newPrice);
        mintPrice = newPrice;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice 余额归集到 treasury。无权限要求 —— 资金去向固定，任何人触发结果相同。
    function withdraw() external {
        (bool ok,) = payable(treasury).call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @dev soulbound：铸造（from=0）与销毁（to=0）之外的转移一律拒绝。
    ///      approve/setApprovalForAll 不拦截（授权本身无害，转移时统一 revert）。
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert SoulboundTransfer();
        return super._update(to, tokenId, auth);
    }
}
