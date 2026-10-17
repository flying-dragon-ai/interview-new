// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InterviewCredential} from "src/InterviewCredential.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract CredentialCaller {
    function mintFor(InterviewCredential target, bytes32 assessmentId, address recipient) external {
        target.mintCredential(assessmentId, recipient);
    }
}

/// @dev Self-contained Foundry tests; no forge-std dependency required.
contract InterviewCredentialTest is IERC721Receiver {
    InterviewCredential private credential;
    bytes32 private constant SESSION = keccak256("session-1");
    bytes32 private constant SCORE = keccak256("score-1");

    function setUp() public {
        credential = new InterviewCredential();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function testIssueCredentialRecordsAssessmentAndMintsSoulboundToken() public {
        bytes32[] memory skills = new bytes32[](2);
        skills[0] = keccak256("analysis");
        skills[1] = keccak256("collaboration");

        (bytes32 assessmentId, uint256 tokenId) = credential.issueCredential(SESSION, SCORE, 82, skills);
        (bytes32 sessionHash, bytes32 scoreHash, uint16 score, uint64 createdAt, address assessor, bool minted) = credential.assessments(assessmentId);

        require(tokenId == 1, "first token id");
        require(credential.ownerOf(tokenId) == address(this), "recipient is caller");
        require(sessionHash == SESSION && scoreHash == SCORE, "hashes recorded");
        require(score == 82 && createdAt > 0 && assessor == address(this) && minted, "assessment fields");
        require(credential.getSkillHashes(assessmentId).length == 2, "skill hashes recorded");
        require(credential.assessmentByToken(tokenId) == assessmentId, "token links to assessment");
    }

    function testAssessmentCannotBeRecordedTwiceForSameWalletAndSession() public {
        credential.recordAssessment(SESSION, SCORE, 82, new bytes32[](0));
        (bool ok,) = address(credential).call(
            abi.encodeCall(credential.recordAssessment, (SESSION, SCORE, 82, new bytes32[](0)))
        );
        require(!ok, "duplicate assessment rejected");
    }

    function testOtherAddressCannotMintAssessment() public {
        bytes32 assessmentId = credential.recordAssessment(SESSION, SCORE, 82, new bytes32[](0));
        CredentialCaller caller = new CredentialCaller();
        (bool ok,) = address(caller).call(
            abi.encodeCall(caller.mintFor, (credential, assessmentId, address(caller)))
        );
        require(!ok, "unauthorized mint rejected");
    }

    function testSoulboundTokenCannotTransfer() public {
        (, uint256 tokenId) = credential.issueCredential(SESSION, SCORE, 82, new bytes32[](0));
        (bool ok,) = address(credential).call(
            abi.encodeCall(credential.transferFrom, (address(this), address(0xBEEF), tokenId))
        );
        require(!ok, "transfer rejected");
    }

    function testScoreOverOneHundredIsRejected() public {
        (bool ok,) = address(credential).call(
            abi.encodeCall(credential.recordAssessment, (SESSION, SCORE, 101, new bytes32[](0)))
        );
        require(!ok, "invalid score rejected");
    }
}
