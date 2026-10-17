// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title InterviewCredential
/// @notice Stores user-approved assessment commitments and issues non-transferable credentials.
/// @dev Raw transcripts, audio, names, and report text must remain offchain.
contract InterviewCredential is ERC721 {
    struct Assessment {
        bytes32 sessionHash;
        bytes32 scoreHash;
        uint16 overallScore;
        uint64 createdAt;
        address assessor;
        bool credentialMinted;
    }

    uint256 public nextTokenId = 1;
    mapping(bytes32 assessmentId => Assessment assessment) public assessments;
    mapping(bytes32 assessmentId => bytes32[] skillHashes) private _skillHashes;
    mapping(uint256 tokenId => bytes32 assessmentId) public assessmentByToken;

    error InvalidHash();
    error InvalidScore(uint16 score);
    error AssessmentAlreadyExists(bytes32 assessmentId);
    error AssessmentNotFound(bytes32 assessmentId);
    error NotAssessmentOwner(address caller, address owner);
    error CredentialAlreadyMinted(bytes32 assessmentId);
    error InvalidRecipient();
    error Soulbound();

    event AssessmentRecorded(
        bytes32 indexed assessmentId,
        address indexed assessor,
        bytes32 indexed sessionHash,
        bytes32 scoreHash,
        uint16 overallScore,
        bytes32[] skillHashes,
        uint64 createdAt
    );
    event CredentialMinted(bytes32 indexed assessmentId, address indexed recipient, uint256 indexed tokenId);

    constructor() ERC721("Interview Credential", "ICRED") {}

    /// @notice Record an assessment commitment. The caller becomes its assessor.
    function recordAssessment(
        bytes32 sessionHash,
        bytes32 scoreHash,
        uint16 overallScore,
        bytes32[] calldata skillHashes
    ) public returns (bytes32 assessmentId) {
        if (sessionHash == bytes32(0) || scoreHash == bytes32(0)) revert InvalidHash();
        if (overallScore > 100) revert InvalidScore(overallScore);

        assessmentId = keccak256(abi.encode(msg.sender, sessionHash));
        if (assessments[assessmentId].assessor != address(0)) revert AssessmentAlreadyExists(assessmentId);

        uint64 createdAt = uint64(block.timestamp);
        assessments[assessmentId] = Assessment({
            sessionHash: sessionHash,
            scoreHash: scoreHash,
            overallScore: overallScore,
            createdAt: createdAt,
            assessor: msg.sender,
            credentialMinted: false
        });
        for (uint256 i; i < skillHashes.length; ++i) {
            if (skillHashes[i] == bytes32(0)) revert InvalidHash();
            _skillHashes[assessmentId].push(skillHashes[i]);
        }

        emit AssessmentRecorded(assessmentId, msg.sender, sessionHash, scoreHash, overallScore, skillHashes, createdAt);
    }

    /// @notice Mint the non-transferable credential for an assessment owned by the caller.
    function mintCredential(bytes32 assessmentId, address recipient) public returns (uint256 tokenId) {
        Assessment storage assessment = assessments[assessmentId];
        if (assessment.assessor == address(0)) revert AssessmentNotFound(assessmentId);
        if (assessment.assessor != msg.sender) revert NotAssessmentOwner(msg.sender, assessment.assessor);
        if (assessment.credentialMinted) revert CredentialAlreadyMinted(assessmentId);
        if (recipient == address(0) || recipient != msg.sender) revert InvalidRecipient();

        tokenId = nextTokenId++;
        assessment.credentialMinted = true;
        assessmentByToken[tokenId] = assessmentId;
        _safeMint(recipient, tokenId);
        emit CredentialMinted(assessmentId, recipient, tokenId);
    }

    /// @notice Convenience function to record and issue in one user-signed transaction.
    function issueCredential(
        bytes32 sessionHash,
        bytes32 scoreHash,
        uint16 overallScore,
        bytes32[] calldata skillHashes
    ) external returns (bytes32 assessmentId, uint256 tokenId) {
        assessmentId = recordAssessment(sessionHash, scoreHash, overallScore, skillHashes);
        tokenId = mintCredential(assessmentId, msg.sender);
    }

    function getSkillHashes(bytes32 assessmentId) external view returns (bytes32[] memory) {
        if (assessments[assessmentId].assessor == address(0)) revert AssessmentNotFound(assessmentId);
        return _skillHashes[assessmentId];
    }

    /// @dev Soulbound policy: minting and burning are allowed; transfers are rejected.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
}
