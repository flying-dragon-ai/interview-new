// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {InterviewCertificate} from "../src/InterviewCertificate.sol";

contract InterviewCertificateTest is Test {
    InterviewCertificate cert;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant HASH_A = keccak256("report-a");
    bytes32 constant HASH_B = keccak256("report-b");
    uint256 constant PRICE = 0.01 ether;

    function setUp() public {
        cert = new InterviewCertificate(PRICE, treasury);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ---------- 铸造 ----------

    function test_mint_success() public {
        vm.prank(alice);
        uint256 tokenId = cert.mintCertificate{value: PRICE}(HASH_A);

        assertEq(tokenId, 1);
        assertEq(cert.ownerOf(1), alice);
        assertEq(cert.reportHashOf(1), HASH_A);
        assertEq(cert.certificateOfReport(HASH_A), 1);
        assertEq(cert.nextTokenId(), 2);
        assertEq(address(cert).balance, PRICE);
        assertTrue(cert.verifyReport(1, HASH_A));
        assertFalse(cert.verifyReport(1, HASH_B));
    }

    function test_mint_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit InterviewCertificate.CertificateMinted(1, alice, HASH_A, PRICE);
        vm.prank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);
    }

    function test_mint_second_certificate_increments() public {
        vm.prank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);
        vm.prank(bob);
        uint256 tokenId = cert.mintCertificate{value: PRICE}(HASH_B);
        assertEq(tokenId, 2);
        assertEq(cert.ownerOf(2), bob);
    }

    function test_mint_underpaid_reverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(InterviewCertificate.InsufficientPayment.selector, PRICE, PRICE - 1)
        );
        cert.mintCertificate{value: PRICE - 1}(HASH_A);
    }

    function test_mint_zero_value_reverts_when_price_nonzero() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InterviewCertificate.InsufficientPayment.selector, PRICE, 0));
        cert.mintCertificate{value: 0}(HASH_A);
    }

    function test_mint_duplicate_report_reverts() public {
        vm.prank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(InterviewCertificate.ReportAlreadyMinted.selector, HASH_A, 1)
        );
        cert.mintCertificate{value: PRICE}(HASH_A);
    }

    function test_mint_overpayment_accepted() public {
        vm.prank(alice);
        cert.mintCertificate{value: PRICE * 2}(HASH_A);
        assertEq(address(cert).balance, PRICE * 2);
    }

    // ---------- soulbound ----------

    function test_transfer_reverts_soulbound() public {
        vm.prank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);

        vm.prank(alice);
        vm.expectRevert(InterviewCertificate.SoulboundTransfer.selector);
        cert.transferFrom(alice, bob, 1);
    }

    function test_safe_transfer_reverts_soulbound() public {
        vm.prank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);

        vm.prank(alice);
        vm.expectRevert(InterviewCertificate.SoulboundTransfer.selector);
        cert.safeTransferFrom(alice, bob, 1);
    }

    function test_approved_third_party_transfer_reverts() public {
        vm.startPrank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);
        cert.approve(bob, 1);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(InterviewCertificate.SoulboundTransfer.selector);
        cert.transferFrom(alice, bob, 1);
    }

    // ---------- 价格与金库 ----------

    function test_set_mint_price_only_owner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cert.setMintPrice(1 ether);

        vm.expectEmit(false, false, false, true);
        emit InterviewCertificate.MintPriceUpdated(PRICE, 1 ether);
        cert.setMintPrice(1 ether);
        assertEq(cert.mintPrice(), 1 ether);
    }

    function test_set_treasury_only_owner_and_nonzero() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cert.setTreasury(bob);

        vm.expectRevert(InterviewCertificate.ZeroAddress.selector);
        cert.setTreasury(address(0));

        cert.setTreasury(bob);
        assertEq(cert.treasury(), bob);
    }

    function test_constructor_zero_treasury_reverts() public {
        vm.expectRevert(InterviewCertificate.ZeroAddress.selector);
        new InterviewCertificate(PRICE, address(0));
    }

    function test_withdraw_sends_balance_to_treasury() public {
        vm.prank(alice);
        cert.mintCertificate{value: PRICE}(HASH_A);

        uint256 before = treasury.balance;
        // 任意第三方可触发，资金去向固定为 treasury
        vm.prank(bob);
        cert.withdraw();

        assertEq(treasury.balance, before + PRICE);
        assertEq(address(cert).balance, 0);
    }

    // ---------- gas 实测（Monad 按 gas_limit 计费，前端据此设 limit） ----------

    function test_gas_mint_first_and_repeat() public {
        vm.prank(alice);
        uint256 g0 = gasleft();
        cert.mintCertificate{value: PRICE}(HASH_A);
        uint256 firstMint = g0 - gasleft();

        vm.prank(bob);
        uint256 g1 = gasleft();
        cert.mintCertificate{value: PRICE}(HASH_B);
        uint256 repeatMint = g1 - gasleft();

        emit log_named_uint("mintCertificate (first, cold storage) gas", firstMint);
        emit log_named_uint("mintCertificate (repeat) gas", repeatMint);
    }
}
