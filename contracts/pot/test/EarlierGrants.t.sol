// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EarlierBase, Row} from "./helpers/EarlierBase.sol";
import {MerkleProof} from "oz5/utils/cryptography/MerkleProof.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {Vester} from "../src/Vester.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice The claim contract: every check of the claim call reverts with its own error (and a mutation of the script removes
/// each one in turn to see a test fail), a valid claim makes exactly one protected grant to exactly the row's account, and a row
/// can be claimed once. Every row is invented (see EarlierBase).
contract EarlierGrantsTest is EarlierBase {
    // ---------------------------------------------------------------- the claim

    function test_aValidClaimMakesExactlyOneProtectedGrant() public {
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        uint256 grantsBefore = v.grantCount();
        uint256 reserveBefore = v.earlierReserve();
        vm.expectEmit(true, true, false, true, address(earlier));
        emit EarlierGrants.Claimed(0, row1, r.amount, 0, TEXT, 1, r.amount);
        vm.prank(row1);
        uint256 id = earlier.claim(r.index, r.amount, p, TEXT);

        assertEq(id, grantsBefore, "the next grant id");
        assertEq(v.grantCount(), grantsBefore + 1, "exactly one grant");
        Vester.Grant memory g = v.grantOf(id);
        assertEq(g.member, row1, "to the row's account");
        assertEq(g.total, r.amount, "of the row's amount");
        assertTrue(g.protected_);
        assertEq(uint8(g.state), uint8(Vester.State.Live));
        assertEq(g.start, v.earlierStart(), "the clock is the project's birth, not the claim");
        assertEq(v.earlierReserve(), reserveBefore - r.amount, "out of the reserve");
        assertEq(earlier.claimedRows(), 1);
        assertEq(earlier.claimedTotal(), r.amount);
        assertTrue(earlier.isClaimed(0));
        assertFalse(earlier.isClaimed(1));
        assertEq(earlier.acceptedAt(row1), block.timestamp, "the acceptance is recorded");
        assertEq(earlier.acceptedText(row1), TEXT, "with the fingerprint");
        assertEq(earlier.acceptedText(row2), bytes32(0), "and only for those who claimed");
    }

    function test_theClaimEventCarriesTheFingerprintAndTheTotals() public {
        _claim(0);
        Row memory r = rows_[1];
        bytes32[] memory p = _proof(1);
        vm.expectEmit(true, true, false, true, address(earlier));
        emit EarlierGrants.Claimed(1, row2, r.amount, 1, TEXT, 2, rows_[0].amount + r.amount);
        vm.prank(row2);
        earlier.claim(r.index, r.amount, p, TEXT);
    }

    function test_twoRowsOfOneAccountEachClaimOnce() public {
        uint256 a = _claim(0);
        uint256 b = _claim(4);
        assertEq(v.grantOf(a).total, 1000e18);
        assertEq(v.grantOf(b).total, 700e18);
        assertEq(v.idsOf(row1).length, 2);
        assertEq(earlier.claimedRows(), 2);
        assertEq(earlier.acceptedAt(row1), block.timestamp, "the first acceptance stands");
        vm.expectRevert(EarlierGrants.AlreadyClaimed.selector);
        this.claimAs(row1, 0);
        vm.expectRevert(EarlierGrants.AlreadyClaimed.selector);
        this.claimAs(row1, 4);
    }

    function test_theAcceptanceIsNeverOverwritten() public {
        _claim(0);
        uint256 first = earlier.acceptedAt(row1);
        _warp(3 days);
        _claim(4);
        assertEq(earlier.acceptedAt(row1), first, "the second claim leaves the first acceptance alone");
    }

    /// @dev External so a test can put an expected revert in front of it.
    function claimAs(address who, uint256 index) external {
        Row memory r = rows_[index];
        bytes32[] memory p = _proof(index);
        vm.prank(who);
        earlier.claim(r.index, r.amount, p, TEXT);
    }

    // ---------------------------------------------------------------- one revert per check, in order

    function test_notBound() public {
        EarlierGrants loose =
            new EarlierGrants(address(launcher), root, TEXT, poolTotal, 8, launcher.keyOf(founder, "other"));
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.NotBound.selector);
        loose.claim(r.index, r.amount, p, TEXT);
    }

    function test_wrongText() public {
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        vm.startPrank(row1);
        vm.expectRevert(EarlierGrants.WrongText.selector);
        earlier.claim(r.index, r.amount, p, keccak256("another text"));
        vm.expectRevert(EarlierGrants.WrongText.selector);
        earlier.claim(r.index, r.amount, p, bytes32(0));
        vm.stopPrank();
        assertEq(earlier.claimedRows(), 0, "nothing was claimed or accepted");
        assertEq(earlier.acceptedAt(row1), 0);
    }

    function test_badRowIndexAndProofDepth() public {
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        vm.startPrank(row1);
        vm.expectRevert(EarlierGrants.BadRow.selector);
        earlier.claim(8, r.amount, p, TEXT); // rows = 8: the last index is 7
        vm.expectRevert(EarlierGrants.BadRow.selector);
        earlier.claim(type(uint256).max, r.amount, p, TEXT);
        bytes32[] memory deep = new bytes32[](33);
        vm.expectRevert(EarlierGrants.BadRow.selector);
        earlier.claim(r.index, r.amount, deep, TEXT);
        // 32 is the deepest accepted: it is refused for the proof, not for its depth
        deep = new bytes32[](32);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, deep, TEXT);
        vm.stopPrank();
    }

    function test_alreadyClaimed() public {
        _claim(1);
        vm.expectRevert(EarlierGrants.AlreadyClaimed.selector);
        this.claimAs(row2, 1);
    }

    function test_aProofForAnotherAccountIndexOrAmountIsRefused() public {
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        // another account (the sender is in the leaf: nobody can claim, or front-run, someone else's row)
        vm.prank(row2);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
        vm.prank(stranger);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
        // another amount
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount + 1, p, TEXT);
        // another index (row 4 is also row1's: the proof of row 0 does not open it)
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(4, r.amount, p, TEXT);
        // the proof of another row
        bytes32[] memory other = _proof(1);
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, other, TEXT);
        // an empty proof
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, new bytes32[](0), TEXT);
        assertEq(earlier.claimedRows(), 0);
    }

    /// @dev The sender, not the transaction's origin, is in the leaf: a row's proof in the hands of another account's call is
    /// refused even when the origin is the row's own account (a contract or a relay cannot claim in someone's name).
    function test_theOriginDoesNotCount() public {
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        vm.prank(row2, row1); // sender row2, origin row1
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
        vm.prank(stranger, row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
    }

    function test_aShortenedProofIsRefused() public {
        Row memory r = rows_[0];
        bytes32[] memory p = _proof(0);
        bytes32[] memory shorter = new bytes32[](p.length - 1);
        for (uint256 i; i < shorter.length; ++i) {
            shorter[i] = p[i];
        }
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, shorter, TEXT);
    }

    /// @dev The second-preimage guard: a row's leaf is the hash of a hash, so no inner node of the tree is one. A list
    /// fingerprinted over single-hashed leaves (the shape that attack needs) opens nothing here, with its own correct proofs.
    function test_aSinglyHashedTreeOpensNothing() public {
        Row[] memory list = _defaultRows();
        bytes32[] memory layer = new bytes32[](8);
        for (uint256 i; i < 8; ++i) {
            layer[i] = keccak256(abi.encode(list[i].index, list[i].account, list[i].amount)); // one hash only
        }
        bytes32[] memory proof = new bytes32[](3);
        proof[0] = layer[1];
        proof[1] = _pair(layer[2], layer[3]);
        proof[2] = _pair(_pair(layer[4], layer[5]), _pair(layer[6], layer[7]));
        while (layer.length > 1) {
            layer = _up(layer);
        }
        _setupRooted(list, 0, layer[0]);
        assertTrue(
            MerkleProof.verify(proof, layer[0], keccak256(abi.encode(list[0].index, list[0].account, list[0].amount))),
            "the proof is a valid proof of the singly hashed tree"
        );
        vm.prank(row1);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(list[0].index, list[0].amount, proof, TEXT);
    }

    /// @dev An inner node can never equal a leaf of this list's shape (so it cannot be offered as a row).
    function test_anInnerNodeIsNotALeaf() public view {
        Row[] memory list = _list();
        bytes32 inner = _pair(_leaf(list[0]), _leaf(list[1]));
        for (uint256 i; i < 8; ++i) {
            assertTrue(inner != _leaf(list[i]));
        }
        assertTrue(
            _leaf(list[0]) != keccak256(abi.encode(list[0].index, list[0].account, list[0].amount)), "double hash"
        );
    }

    function test_rowTooSmall() public {
        Row memory r = rows_[3]; // half a Share: a valid row that can never be granted
        bytes32[] memory p = _proof(3);
        vm.prank(row4);
        vm.expectRevert(EarlierGrants.RowTooSmall.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
        assertFalse(earlier.isClaimed(3));
    }

    function test_overPool() public {
        // a bad list: its rows add up to more than the pool the deployer funded
        Row[] memory list = _defaultRows();
        _setupWith(list, 3000e18); // the first two rows are 3,500
        _claim(0);
        Row memory r = rows_[1];
        bytes32[] memory p = _proof(1);
        vm.prank(row2);
        vm.expectRevert(EarlierGrants.OverPool.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
        // a row that fits still goes through
        _claim(2);
        assertLe(earlier.claimedTotal(), earlier.total());
    }

    function test_theChecksRunInTheDocumentedOrder() public {
        EarlierGrants loose =
            new EarlierGrants(address(launcher), root, TEXT, poolTotal, 8, launcher.keyOf(founder, "other"));
        bytes32[] memory none = new bytes32[](0);
        // not bound comes before the text
        vm.expectRevert(EarlierGrants.NotBound.selector);
        loose.claim(99, 0, none, bytes32(0));
        // the text comes before the row
        vm.expectRevert(EarlierGrants.WrongText.selector);
        earlier.claim(99, 0, none, bytes32(0));
        // the row's bounds come before the claimed bit and the proof
        vm.expectRevert(EarlierGrants.BadRow.selector);
        earlier.claim(99, 0, none, TEXT);
        // claimed comes before the proof
        _claim(0);
        vm.prank(stranger);
        vm.expectRevert(EarlierGrants.AlreadyClaimed.selector);
        earlier.claim(0, 1, none, TEXT);
        // the proof comes before the minimum and the pool
        vm.prank(stranger);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(1, 0.1e18, none, TEXT);
    }

    // ---------------------------------------------------------------- after the vester: nothing is left to the sender

    function test_claimsAfterAWindDownStillWork() public {
        vm.prank(founder);
        t.windDown();
        uint256 id = _claim(0);
        assertEq(v.grantOf(id).total, 1000e18, "a wind-down closes nothing for the earlier backers");
    }

    // ---------------------------------------------------------------- construction and binding

    function test_theConstructorRefusesZeroAndOversizeSettings() public {
        address l = address(launcher);
        bytes32 k = launcher.keyOf(founder, "x");
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(address(0), root, TEXT, 1e18, 1, k);
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(l, bytes32(0), TEXT, 1e18, 1, k);
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(l, root, bytes32(0), 1e18, 1, k);
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(l, root, TEXT, 0, 1, k);
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(l, root, TEXT, 1e18, 0, k);
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(l, root, TEXT, 1e18, 1, bytes32(0));
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        new EarlierGrants(l, root, TEXT, 1_000_000_000e18 + 1, 1, k);
        // the ceiling itself is allowed
        EarlierGrants ok = new EarlierGrants(l, root, TEXT, 1_000_000_000e18, 1, k);
        assertEq(ok.total(), earlier.MAX_EARLIER_POOL());
    }

    function test_bindIsTheLaunchersAndOnce() public {
        EarlierGrants loose =
            new EarlierGrants(address(launcher), root, TEXT, poolTotal, 8, launcher.keyOf(founder, "other"));
        vm.prank(stranger);
        vm.expectRevert(EarlierGrants.NotLauncher.selector);
        loose.bind(address(v));
        vm.prank(address(this)); // the deployer of the claim contract has no say either
        vm.expectRevert(EarlierGrants.NotLauncher.selector);
        loose.bind(address(v));
        vm.startPrank(address(launcher));
        vm.expectRevert(EarlierGrants.BadSettings.selector);
        loose.bind(address(0));
        vm.expectEmit(false, false, false, true, address(loose));
        emit EarlierGrants.Bound(address(v));
        loose.bind(address(v));
        vm.expectRevert(EarlierGrants.AlreadyBound.selector);
        loose.bind(address(0xBEEF));
        vm.stopPrank();
        assertEq(address(loose.vester()), address(v));
        // the real one was bound by the launch and cannot be rebound
        vm.prank(address(launcher));
        vm.expectRevert(EarlierGrants.AlreadyBound.selector);
        earlier.bind(address(0xBEEF));
        assertEq(address(earlier.vester()), address(v));
    }

    function test_theMinimumRowIsTheVestersMinimumGrant() public view {
        assertEq(earlier.MIN_ROW(), v.MIN_GRANT());
    }

    function test_noValueIsHeldOrTaken() public view {
        assertEq(address(earlier).balance, 0);
        assertEq(usd.balanceOf(address(earlier)), 0);
    }

    /// @dev Like `Pragma.t.sol` for the new source file: the pinned compiler and the licence line.
    function test_pragmaAndLicenceOfTheNewSource() public view {
        string memory src = vm.readFile("src/EarlierGrants.sol");
        assertTrue(vm.contains(src, "\npragma solidity 0.8.37;\n"), "the pragma is pinned");
        assertTrue(vm.contains(src, "// SPDX-License-Identifier: MIT\n"), "the licence line");
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev Only the row's own account opens a row: any other sender is refused, and the right one is not.
    function testFuzz_onlyTheRowsOwnAccountClaims(address who, uint8 which) public {
        uint256 i = bound(which, 0, 7);
        if (i == 3) i = 0; // the half-Share row is refused for its size: not this test
        Row memory r = rows_[i];
        bytes32[] memory p = _proof(i);
        vm.prank(who);
        if (who != r.account) {
            vm.expectRevert(EarlierGrants.BadProof.selector);
            earlier.claim(r.index, r.amount, p, TEXT);
            assertEq(earlier.claimedRows(), 0);
        } else {
            earlier.claim(r.index, r.amount, p, TEXT);
            assertEq(earlier.claimedRows(), 1);
        }
    }

    /// @dev Any change to a proof word makes the claim fail.
    function testFuzz_aTamperedProofFails(uint8 which, uint8 word, bytes32 flip) public {
        uint256 i = bound(which, 0, 7);
        if (i == 3) i = 0;
        Row memory r = rows_[i];
        bytes32[] memory p = _proof(i);
        uint256 w = bound(word, 0, p.length - 1);
        vm.assume(flip != bytes32(0));
        p[w] = p[w] ^ flip;
        vm.prank(r.account);
        vm.expectRevert(EarlierGrants.BadProof.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
    }

    /// @dev A claim in any order, by anyone who may, never passes the pool and marks exactly the rows claimed.
    function testFuzz_claimsNeverPassThePoolAndRowsAreOnce(uint256 order) public {
        uint256 got;
        uint256 count;
        for (uint256 k; k < 8; ++k) {
            uint256 i = (order >> (k * 3)) & 7;
            if (i == 3) continue;
            Row memory r = rows_[i];
            bytes32[] memory p = _proof(i);
            bool done = earlier.isClaimed(i); // read before the prank: a prank is spent by the first call after it
            vm.prank(r.account);
            if (done) {
                vm.expectRevert(EarlierGrants.AlreadyClaimed.selector);
                earlier.claim(r.index, r.amount, p, TEXT);
            } else {
                earlier.claim(r.index, r.amount, p, TEXT);
                got += r.amount;
                ++count;
            }
        }
        assertEq(earlier.claimedTotal(), got);
        assertEq(earlier.claimedRows(), count);
        assertLe(earlier.claimedTotal(), earlier.total());
        assertEq(v.earlierReserve() + got, earlier.total(), "the reserve is what the claims left");
    }
}
