// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EarlierBase} from "./helpers/EarlierBase.sol";
import {EarlierBackers} from "../src/EarlierBackers.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Rounds} from "../src/Rounds.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Wallet1271, KernelStyleAccount, SafeStyleWallet, FakeClaim} from "./mocks/Wallets.sol";
import {IShares} from "../src/Interfaces.sol";
import {Clones} from "oz5/proxy/Clones.sol";

/// @notice Project zero's launch with its earlier raise and its team budget (`docs/next-version/EARLIER-BACKERS.md`,
/// "Earlier backers: built"): the Launcher's cut (LZ1 to LZ6), the numbers at S1, and the Team round Creaton keeps. Every
/// holder, amount and salt is made up (see `EarlierBase`).
contract EarlierLaunchTest is EarlierBase {
    /// @dev At S1 with 8,333,333.33 backing Shares kept: 141,666,666.67 from the backing slice, the rest from the founder's.
    uint256 internal constant FROM_BACKING = BACKING_SLICE - KEEP;
    uint256 internal constant FROM_FOUNDER = S1_TOTAL - FROM_BACKING;
    uint256 internal constant TEAM = FOUNDER_SLICE - FROM_FOUNDER;

    function test_s1_numbers() public view {
        assertEq(FROM_BACKING, 141_666_666_666_666_700_000_000_000, "141,666,666.67 from the backing slice");
        assertEq(FROM_FOUNDER, 147_010_606_333_333_300_000_000_000, "147,010,606.33 from the founder's slice");
        assertEq(TEAM, 52_989_393_666_666_700_000_000_000, "52,989,393.67 left: the team budget");
        assertApproxEqAbs(TEAM, 52_989_394e18, 1e18, "about 52,989,394 Shares");
        assertEq((TEAM * 10_000 + SUPPLY / 2) / SUPPLY, 530, "5.30% of all Shares");
    }

    /// LZ5, LZ6: project zero's founder Vester grant is zero, the claim has one plain grant of the list's total, the team
    /// budget is in the Treasury, and the work pot, the reserve, the auction and the pool match are untouched.
    function test_launch_projectZeroAtS1() public view {
        (uint256 founderGrant,) = v.grants(founder);
        assertEq(founderGrant, 0, "project zero's founder has no Vester grant");
        assertEq(v.founderAmount(), 0);
        (uint256 granted, uint256 claimed) = v.grants(address(eb));
        assertEq(granted, S1_TOTAL, "LZ3: the claim's grant is the list's total");
        assertEq(claimed, 0);
        assertEq(eb.funding(), S1_TOTAL);
        assertEq(shares.balanceOf(address(v)), S1_TOTAL, "the Vester holds the claim's grant only");
        assertEq(t.teamBudget(), TEAM, "the team budget");
        assertEq(t.workPot(), 200_000_000e18, "the work pot is untouched");
        assertEq(t.reserve(), 100_000_000e18, "the reserve is untouched");
        assertEq(shares.balanceOf(address(t)), 300_000_000e18 + TEAM);
        assertEq(shares.balanceOf(finisher), 350_000_000e18, "the auction and the pool match are untouched");
        assertEq(shares.balanceOf(rounds), KEEP, "the backing Shares Creaton keeps for its own rounds");
        assertEq(t.stakeAmount(), 0, "project zero takes no stake");
        assertEq(t.earlier(), address(eb));
        assertEq(address(eb.vester()), address(v), "bound in the launch");
        assertEq(eb.treasury(), address(t));
        assertEq(S1_TOTAL + TEAM + 300_000_000e18 + 350_000_000e18 + KEEP, SUPPLY, "LZ6: every Share is placed");
    }

    /// An ordinary project beside it is unchanged: the founder's 200M in the Vester, no team budget, no claim.
    function test_launch_ordinaryProjectUnchanged() public {
        Launcher.Project memory one = launcher.project(founder, PROJECT);
        Vester v1 = Vester(one.vester);
        Treasury t1 = Treasury(one.treasury);
        (uint256 g,) = v1.grants(founder);
        assertEq(g, FOUNDER_SLICE);
        assertEq(t1.teamBudget(), 0);
        assertEq(t1.earlier(), address(0));
        assertEq(t1.reserve(), 100_000_000e18);
        assertEq(t1.workPot(), 200_000_000e18);
        assertEq(t1.stakeAmount(), 20_000_000e18);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TeamBudgetShort.selector, 1, 0));
        t1.payTeam(alice, 1);
    }

    /// The founder trim (a leaving founder's hand-over) cuts nothing for project zero and never reaches the claim's grant.
    function test_trim_leavesTheClaimAndTheTeamBudgetWhole() public {
        vm.prank(founder);
        t.handOver(alice, true);
        vm.prank(alice);
        t.takeSeat();
        assertTrue(v.trimmed());
        (uint256 granted,) = v.grants(address(eb));
        assertEq(granted, S1_TOTAL);
        assertEq(t.workPot(), 200_000_000e18);
        assertEq(t.teamBudget(), TEAM, "the team budget stays, and the new runner pays it");
    }

    /// Creaton keeps 8,333,333.33 backing Shares: a 6,000,000 Team round of 50,000 opens; a cheaper one cannot.
    function test_teamRound_atSixMillionOpens_belowItCannot() public {
        _team();
        _checkIn();
        _bothRefused(
            address(launcher),
            abi.encodeCall(Launcher.openRound, (key, SIX_MILLION + 1)),
            abi.encodeWithSelector(Rounds.CannotOpen.selector)
        );
        uint256 id = _openRoundAt(SIX_MILLION);
        assertEq(rd.roundOf(id).size, 50_000e6, "the whole 50,000 Team cap");
    }

    /// Project zero launched: no second one can be named, so no other launch can take an earlier raise or a team budget.
    function test_noSecondProjectZero() public {
        bytes32 k = launcher.keyOf(alice, keccak256("another creaton"));
        vm.prank(admin);
        vm.expectRevert(Launcher.ProjectExists.selector);
        launcher.nameProjectZero(k);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(eb), KEEP);
    }
}

/// @notice The Launcher's checks on project zero's earlier raise, before project zero launches.
contract EarlierNamingTest is EarlierBase {
    bytes32 internal k0;

    function _launchesZero() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        k0 = launcher.keyOf(founder, ZERO_ID);
    }

    function _name(address claim, uint256 keep) internal {
        vm.startPrank(admin);
        launcher.nameProjectZero(k0);
        launcher.nameEarlierBackers(claim, keep);
        vm.stopPrank();
    }

    function test_name_onlyTheAdmin() public {
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        vm.prank(founder);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.nameEarlierBackers(address(eb), KEEP);
    }

    function test_name_onlyOnceProjectZeroIsNamed() public {
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(eb), KEEP);
    }

    /// LZ2: only the known code, made for this Launcher and project zero's key.
    function test_name_LZ2_codeLauncherAndKey() public {
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        FakeClaim fake = new FakeClaim(address(launcher), k0, S1_TOTAL);
        vm.startPrank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(fake), KEEP);
        vm.stopPrank();
        EarlierBackers other = _deployClaimWith(address(0xBEEF), k0, leaves, S1_TOTAL, 0);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(other), KEEP);
        EarlierBackers wrongKey = _deployClaimWith(address(launcher), key, leaves, S1_TOTAL, 0);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(wrongKey), KEEP);
        vm.prank(admin);
        launcher.nameEarlierBackers(address(eb), KEEP);
        assertEq(launcher.earlierClaim(), address(eb));
        assertEq(launcher.earlierKeep(), KEEP);
    }

    /// LZ1: the parts fit their slices: the kept backing at most the backing slice, the rest at most the founder's.
    function test_name_LZ1_partsFitTheirSlices() public {
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(eb), BACKING_SLICE + 1);
        EarlierBackers big = _deployClaimWith(address(launcher), k0, leaves, 350_000_000e18 + 1, 0);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector);
        launcher.nameEarlierBackers(address(big), 0);
        EarlierBackers whole = _deployClaimWith(address(launcher), k0, leaves, 350_000_000e18, 0);
        vm.prank(admin);
        launcher.nameEarlierBackers(address(whole), 0); // the whole backing and founder's slices: no team budget
        bytes32 h = launcher.launchHash(k0);
        vm.prank(founder);
        (, address tr,) = launcher.launch(ZERO_ID, "Creaton", "CREATE", h);
        assertEq(Treasury(tr).teamBudget(), 0);
        assertEq(Treasury(tr).reserve(), 100_000_000e18);
    }

    /// LZ4: project zero's launch hash covers the claim and the backing kept; the plain settings hash is refused.
    function test_launch_LZ4_theHashCoversTheCut() public {
        _name(address(eb), KEEP);
        bytes32 plain = launcher.settingsHash();
        vm.prank(founder);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch(ZERO_ID, "Creaton", "CREATE", plain);
        bytes32 seen = launcher.launchHash(k0);
        vm.prank(admin);
        launcher.nameEarlierBackers(address(eb), KEEP - 1); // the admin moves the cut after the founder looked
        vm.prank(founder);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch(ZERO_ID, "Creaton", "CREATE", seen);
        assertTrue(launcher.launchHash(k0) != plain);
        assertEq(launcher.launchHash(key), plain, "an ordinary key reads the plain hash");
    }

    /// Naming project zero again clears the claim; a zero claim takes it back.
    function test_name_projectZeroAgainClearsTheClaim() public {
        _name(address(eb), KEEP);
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        assertEq(launcher.earlierClaim(), address(0));
        vm.prank(admin);
        launcher.nameEarlierBackers(address(eb), KEEP);
        vm.prank(admin);
        launcher.nameEarlierBackers(address(0), 0);
        assertEq(launcher.earlierClaim(), address(0));
    }

    /// Project zero with no earlier raise: the founder's whole slice is the team budget.
    function test_launch_noEarlierRaise_wholeSliceIsTheTeamBudget() public {
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        bytes32 h = launcher.launchHash(k0);
        assertEq(h, launcher.settingsHash());
        vm.expectEmit(true, true, false, true, address(launcher));
        emit Launcher.ProjectZeroSplit(k0, address(0), 0, 0, FOUNDER_SLICE);
        vm.prank(founder);
        (address s, address tr, address ve) = launcher.launch(ZERO_ID, "Creaton", "CREATE", h);
        (uint256 g,) = Vester(ve).grants(founder);
        assertEq(g, 0);
        assertEq(Treasury(tr).teamBudget(), FOUNDER_SLICE);
        assertEq(Treasury(tr).workPot(), 200_000_000e18);
        assertEq(Treasury(tr).reserve(), 100_000_000e18);
        assertEq(ShareToken(s).balanceOf(ve), 0, "the Vester holds nothing");
        assertEq(ShareToken(s).balanceOf(tr), 500_000_000e18, "work pot, reserve and the whole founder's slice");
    }

    /// The claim's grant, the team budget and the backing left, as the launch reports them.
    function test_launch_emitsTheSplitAndBinds() public {
        _name(address(eb), KEEP);
        bytes32 h = launcher.launchHash(k0);
        uint256 fromBacking = BACKING_SLICE - KEEP;
        vm.expectEmit(true, true, false, true, address(launcher));
        emit Launcher.ProjectZeroSplit(
            k0, address(eb), fromBacking, S1_TOTAL - fromBacking, FOUNDER_SLICE - (S1_TOTAL - fromBacking)
        );
        vm.prank(founder);
        launcher.launch(ZERO_ID, "Creaton", "CREATE", h);
        assertEq(address(eb.vester()), launcher.projectByKey(k0).vester, "bound in the launch transaction");
        vm.expectRevert(EarlierBackers.BindState.selector);
        eb.bind(); // EB01: once
    }

    /// An ordinary launch while project zero's raise is named neither uses nor binds it.
    function test_launch_ordinaryLaunchCannotUseIt() public {
        _name(address(eb), KEEP);
        bytes32 h = launcher.launchHash(launcher.keyOf(alice, ZERO_ID));
        vm.prank(alice);
        (, address tr, address ve) = launcher.launch(ZERO_ID, "Mine", "MINE", h);
        (uint256 g,) = Vester(ve).grants(alice);
        assertEq(g, FOUNDER_SLICE);
        assertEq(Treasury(tr).teamBudget(), 0);
        assertEq(Treasury(tr).earlier(), address(0));
        (uint256 c,) = Vester(ve).grants(address(eb));
        assertEq(c, 0);
        assertEq(address(eb.vester()), address(0), "not bound");
        assertEq(launcher.earlierClaim(), address(eb), "still waiting for project zero");
    }

    /// EB25: nothing can be agreed before the launch funds the grant; EB01: bind only after the launch.
    function test_consent_EB25_notBeforeTheLaunch() public {
        vm.expectRevert(EarlierBackers.BindState.selector);
        eb.bind();
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        vm.expectRevert(EarlierBackers.NotFunded.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        assertEq(eb.undelivered(), 0);
    }

    /// @dev Deploy the built `EarlierBackers` (the artifact the Launcher's code hash is read from) with these settings.
    function _make(address l, bytes32[] memory lv, uint256 total, uint256 ls, uint256 hold, address k)
        internal
        returns (address a)
    {
        bytes memory code = abi.encodePacked(
            vm.getCode("EarlierBackers.sol:EarlierBackers"),
            abi.encode(l, k0, lv, total, TEXT, keccak256(bytes(SUMMARY)), ls, hold, k)
        );
        assembly ("memory-safe") {
            a := create(0, add(code, 0x20), mload(code))
        }
    }

    /// The Vester's second grant: never to nobody or to the founder, and a zero founder grant makes no founder grant.
    function test_vester_claimGrantRules() public {
        for (uint256 k; k < 3; ++k) {
            Vester fresh = Vester(Clones.clone(launcher.vesterImpl()));
            ShareToken tok = ShareToken(Clones.clone(launcher.shareImpl()));
            address[] memory to = new address[](1);
            uint256[] memory am = new uint256[](1);
            (to[0], am[0]) = (address(fresh), SUPPLY);
            tok.initialize("x", "x", to, am);
            address target = k == 0 ? address(0) : k == 1 ? founder : address(eb);
            if (k < 2) vm.expectRevert(Vester.BadGrant.selector);
            fresh.initialize(IShares(address(tok)), alice, alice, alice, founder, 0, target, 1e18);
            if (k == 2) {
                (uint256 g,) = fresh.grants(address(eb));
                (uint256 f,) = fresh.grants(founder);
                assertEq(g, 1e18);
                assertEq(f, 0);
                assertEq(fresh.granted(), 1e18);
            }
        }
    }

    /// The constructor's checks.
    function test_constructor_refusesBadSettings() public {
        bytes32[] memory none = new bytes32[](0);
        bytes32[] memory many = new bytes32[](65);
        uint256 ls = _now() + 730 days;
        address l = address(launcher);
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(l, leaves, S1_TOTAL, ls, 0, address(0));
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(l, none, S1_TOTAL, ls, 0, keeper);
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(l, many, S1_TOTAL, ls, 0, keeper);
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(l, leaves, 0, ls, 0, keeper);
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(l, leaves, S1_TOTAL, ls - 1, 0, keeper);
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(l, leaves, S1_TOTAL, ls, 730 days + 1, keeper);
        vm.expectRevert(EarlierBackers.BadSetup.selector);
        _make(address(0), leaves, S1_TOTAL, ls, 0, keeper);
        EarlierBackers ok = EarlierBackers(_make(l, leaves, S1_TOTAL, ls, 730 days, keeper));
        assertEq(ok.entryCount(), 21);
        assertEq(ok.minHoldFromConsent(), 730 days);
        assertEq(ok.textVersion(), 1);
        assertEq(address(ok).codehash, launcher.earlierCodeHash(), "every copy has the code hash the Launcher knows");
    }
}

/// @notice Agreeing: the typed data, the signature kinds, the receiver, the list and the keeper's powers (EB02 to EB12,
/// EB18 to EB25, EB28, EB29).
contract EarlierConsentTest is EarlierBase {
    function test_digest_matchesTheTypedDataByHand() public view {
        uint256 until = 1_900_000_000;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Creaton earlier backers"),
                keccak256("1"),
                block.chainid,
                address(eb)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Consent(uint256 entry,address holder,uint256 amount,address receiver,bytes32 project,bytes32 textHash,"
                    "uint256 textVersion,string summary,uint256 holderVersion,uint256 validUntil)"
                ),
                uint256(3),
                holders[3],
                amounts[3],
                alice,
                key,
                TEXT,
                uint256(1),
                keccak256(bytes(SUMMARY)),
                uint256(0),
                until
            )
        );
        assertEq(eb.domainSeparator(), domain);
        assertEq(
            eb.consentDigest(3, holders[3], amounts[3], alice, until),
            keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }

    function test_consent_byRelayer_EOA() public {
        _consent(0);
        EarlierBackers.Entry memory e = eb.entryOf(0);
        assertEq(e.receiver, holders[0]);
        assertEq(e.signer, holders[0]);
        assertEq(e.amount, amounts[0]);
        assertEq(e.consentAt, _now());
        assertEq(eb.consentedTotal(), amounts[0]);
        assertEq(eb.consentedCount(), 1);
    }

    function test_consent_inPerson_noSignature() public {
        uint256 until = _now() + 1 days;
        vm.prank(holders[1]);
        eb.consent(1, holders[1], amounts[1], salts[1], holders[1], TEXT, until, "");
        assertEq(eb.consentedCount(), 1);
    }

    /// EB05: an empty signature only from the holder itself.
    function test_consent_EB05_emptySignatureOnlyFromTheHolder() public {
        uint256 until = _now() + 1 days;
        vm.prank(relayer);
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(1, holders[1], amounts[1], salts[1], holders[1], TEXT, until, "");
    }

    /// EB06: a signature from another key fails.
    function test_consent_EB06_otherKeyFails() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _signWith(pks[2], _digest(1, holders[1], until));
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(1, holders[1], amounts[1], salts[1], holders[1], TEXT, until, sig);
    }

    /// EB07: the message is bound to the chain, the contract, the text version and the holder version.
    function test_consent_EB07_wrongChainFails() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        vm.chainId(8453);
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
    }

    function test_consent_EB07_otherContractFails() public {
        EarlierBackers twin = _deployClaimWith(address(launcher), key, leaves, S1_TOTAL, 0);
        uint256 until = _now() + 1 days;
        bytes memory sig = _signWith(pks[0], twin.consentDigest(0, holders[0], amounts[0], holders[0], until));
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
    }

    /// EB07, EB22: a new text (or summary) makes earlier signatures fail; the version only grows.
    function test_consent_EB07_EB22_newTextVoidsOldSignatures() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        bytes32 text2 = keccak256("made-up text version 2");
        vm.prank(keeper);
        eb.publishText(text2, keccak256("made-up summary 2"));
        assertEq(eb.textVersion(), 2);
        vm.expectRevert(EarlierBackers.TextMoved.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], text2, until, sig);
        vm.prank(keeper);
        eb.publishText(TEXT, keccak256(bytes(SUMMARY)));
        assertEq(eb.textVersion(), 3, "going back to the old text is a new version");
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        vm.prank(alice);
        vm.expectRevert(EarlierBackers.NotKeeper.selector);
        eb.publishText(text2, bytes32(0));
    }

    /// EB08: an expired message fails.
    function test_consent_EB08_expired() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        vm.warp(until + 1);
        vm.expectRevert(EarlierBackers.Expired.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
    }

    /// EB02, EB03: the entry exists and its details match its stored leaf (amount, salt, holder, index).
    function test_consent_EB02_EB03_theLeaf() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        vm.expectRevert(EarlierBackers.UnknownEntry.selector);
        eb.consent(21, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        vm.expectRevert(EarlierBackers.NotOnList.selector);
        eb.consent(0, holders[0], amounts[0] + 1, salts[0], holders[0], TEXT, until, sig);
        vm.expectRevert(EarlierBackers.NotOnList.selector);
        eb.consent(0, holders[0], amounts[0], salts[1], holders[0], TEXT, until, sig);
        vm.expectRevert(EarlierBackers.NotOnList.selector);
        eb.consent(0, holders[1], amounts[0], salts[0], holders[1], TEXT, until, sig);
        vm.expectRevert(EarlierBackers.NotOnList.selector);
        eb.consent(1, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        assertEq(eb.leaf(0), eb.leafOf(0, holders[0], amounts[0], salts[0]));
    }

    /// EB09: one consent per entry; two entries may share one wallet.
    function test_consent_EB09_oncePerEntry() public {
        _consent(0);
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        // two entries, one wallet (with code on this chain)
        Wallet1271 w = new Wallet1271(alice);
        _consentTo(1, address(w));
        _consentTo(2, address(w));
        assertEq(eb.entryOf(1).receiver, address(w));
        assertEq(eb.entryOf(2).receiver, address(w));
    }

    /// EB11: the receiver is a wallet with code here or the holder itself; never zero or a project contract.
    function test_consent_EB11_receiver() public {
        address[8] memory bad =
            [address(0), address(eb), address(launcher), address(shares), address(t), address(v), rounds, finisher];
        uint256 until = _now() + 1 days;
        for (uint256 i; i < bad.length; ++i) {
            bytes memory sig = _sign(2, bad[i], until);
            vm.expectRevert(EarlierBackers.BadReceiver.selector);
            eb.consent(2, holders[2], amounts[2], salts[2], bad[i], TEXT, until, sig);
        }
        bytes memory s2 = _sign(2, alice, until); // a wallet with no code that is not the holder
        vm.expectRevert(EarlierBackers.BadReceiver.selector);
        eb.consent(2, holders[2], amounts[2], salts[2], alice, TEXT, until, s2);
        Wallet1271 safe = new Wallet1271(holders[2]); // a wallet that exists on this chain
        _consentTo(2, address(safe));
        assertEq(eb.entryOf(2).receiver, address(safe));
    }

    /// EB04: an entry with no holder can never be agreed to (no empty-holder entries, attack finding 1).
    function test_consent_EB04_noHolderNoConsent() public {
        // a one-entry list whose holder is zero, bound to project zero; its grant is mocked as funded
        bytes32[] memory l = new bytes32[](1);
        l[0] = keccak256(abi.encode(uint256(0), address(0), uint256(1e18), bytes32(0)));
        EarlierBackers twin = _deployClaimWith(address(launcher), key, l, 1e18, 0);
        vm.mockCall(address(v), abi.encodeWithSignature("grants(address)", address(twin)), abi.encode(1e18, 0));
        twin.bind();
        vm.prank(address(0));
        vm.expectRevert(EarlierBackers.BadHolder.selector);
        twin.consent(0, address(0), 1e18, bytes32(0), address(this), TEXT, _now() + 1, "");
    }

    /// EB24: the consented total never passes the total (sum guard); see the fuzz for padded lists.
    function test_consent_EB24_total() public {
        _consentAll();
        assertEq(eb.consentedTotal(), S1_TOTAL);
        assertEq(eb.consentedCount(), 21);
    }

    /// EB28: the keeper voids only inside the window; the entry goes back to open with no receiver.
    function test_void_EB28() public {
        _consentTo(0, address(new Wallet1271(holders[0])));
        vm.prank(alice);
        vm.expectRevert(EarlierBackers.NotKeeper.selector);
        eb.voidConsent(0, "evidence");
        vm.prank(keeper);
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.voidConsent(1, "evidence");
        vm.warp(_now() + 21 days - 1);
        vm.prank(keeper);
        eb.voidConsent(0, keccak256("evidence"));
        EarlierBackers.Entry memory e = eb.entryOf(0);
        assertEq(e.consentAt, 0);
        assertEq(e.receiver, address(0), "never redirected");
        assertEq(e.barred, holders[0]);
        assertEq(eb.consentedTotal(), 0);
        assertEq(eb.consentedCount(), 0);
        _consent(0); // the holder may agree again (no replacement is pending)
        vm.warp(_now() + 21 days);
        vm.prank(keeper);
        vm.expectRevert(EarlierBackers.WindowOver.selector);
        eb.voidConsent(0, "late");
    }

    /// EB18 to EB21: keeper only, open entry only, 30 days, the holder's veto, the holder version grows.
    function test_replace_EB18_to_EB21() public {
        address next = makeAddr("new key");
        vm.prank(alice);
        vm.expectRevert(EarlierBackers.NotKeeper.selector);
        eb.proposeHolder(0, next, "lost key");
        vm.startPrank(keeper);
        vm.expectRevert(EarlierBackers.UnknownEntry.selector);
        eb.proposeHolder(21, next, "lost key");
        vm.expectRevert(EarlierBackers.BadHolder.selector);
        eb.proposeHolder(0, address(0), "lost key");
        vm.stopPrank();
        _consent(1);
        vm.prank(keeper);
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.proposeHolder(1, next, "lost key");
        // the holder vetoes
        vm.prank(keeper);
        eb.proposeHolder(0, next, "lost key");
        vm.prank(stranger);
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.cancelHolder(0, amounts[0], salts[0]);
        vm.prank(holders[0]);
        eb.cancelHolder(0, amounts[0], salts[0]);
        assertEq(eb.entryOf(0).pending, address(0));
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.applyHolder(0);
        // proposed again; it applies after 30 days
        vm.prank(keeper);
        eb.proposeHolder(0, next, "lost key");
        vm.warp(_now() + 30 days - 1);
        vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, _now() + 1));
        eb.applyHolder(0);
        vm.warp(_now() + 1);
        eb.applyHolder(0);
        EarlierBackers.Entry memory e = eb.entryOf(0);
        assertEq(e.holder, next);
        assertEq(e.holderVersion, 1);
        // the old holder's signature no longer works; the new holder agrees in person, Shares to itself
        uint256 until = _now() + 1 days;
        bytes memory old = _signWith(pks[0], eb.consentDigest(0, holders[0], amounts[0], holders[0], until));
        vm.expectRevert(EarlierBackers.BadReceiver.selector); // the old holder's own wallet is not the holder any more
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, old);
        vm.prank(next);
        eb.consent(0, holders[0], amounts[0], salts[0], next, TEXT, until, "");
        assertEq(eb.entryOf(0).signer, next);
        // a second replacement: the replaced holder's veto is by its address now
        vm.prank(keeper);
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.proposeHolder(0, alice, "again");
    }

    /// EB20 with the holder version: a signature made for holder version 0 by the new holder fails after a replacement.
    function test_replace_EB21_holderVersionBindsTheSignature() public {
        uint256 pk = 0xA11CE5;
        address next = vm.addr(pk);
        vm.prank(keeper);
        eb.proposeHolder(5, next, "lost key");
        uint256 until = _now() + 60 days;
        bytes32 v0 = eb.consentDigest(5, next, amounts[5], next, until); // made while holder version is 0
        vm.warp(_now() + 30 days);
        eb.applyHolder(5);
        bytes memory sig = _signWith(pk, v0);
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(5, holders[5], amounts[5], salts[5], next, TEXT, until, sig);
        sig = _signWith(pk, eb.consentDigest(5, next, amounts[5], next, until));
        vm.prank(relayer);
        eb.consent(5, holders[5], amounts[5], salts[5], next, TEXT, until, sig);
    }

    /// EB12: the holder's consent cancels a pending replacement.
    function test_replace_EB12_consentCancelsIt() public {
        vm.prank(keeper);
        eb.proposeHolder(0, makeAddr("new key"), "lost key?");
        _consent(0);
        assertEq(eb.entryOf(0).pending, address(0));
        vm.warp(_now() + 30 days);
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.applyHolder(0);
        assertEq(eb.entryOf(0).holder, address(0), "the holder stays");
    }

    /// EB29: after the keeper voids a consent (a leaked key) and proposes a new holder, the voided key can neither agree
    /// again nor veto; the replacement applies; the keeper can also cancel it.
    function test_replace_EB29_aVoidedKeyCannotBlockIt() public {
        _consent(0);
        vm.prank(keeper);
        eb.voidConsent(0, keccak256("leaked key"));
        address next = makeAddr("new key");
        vm.prank(keeper);
        eb.proposeHolder(0, next, keccak256("leaked key"));
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        vm.expectRevert(EarlierBackers.Barred.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        vm.prank(holders[0]);
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.cancelHolder(0, amounts[0], salts[0]);
        vm.warp(_now() + 30 days);
        eb.applyHolder(0);
        assertEq(eb.entryOf(0).holder, next);
        assertEq(eb.entryOf(0).barred, address(0));
        // the keeper may cancel its own proposal
        vm.prank(keeper);
        eb.proposeHolder(1, alice, "x");
        vm.prank(keeper);
        eb.cancelHolder(1, 0, bytes32(0));
        assertEq(eb.entryOf(1).pending, address(0));
    }

    /// EB23: the keeper role moves in two steps.
    function test_keeper_EB23_twoSteps() public {
        vm.prank(alice);
        vm.expectRevert(EarlierBackers.NotKeeper.selector);
        eb.offerKeeper(alice);
        vm.prank(keeper);
        eb.offerKeeper(alice);
        assertEq(eb.keeper(), keeper);
        vm.prank(bob);
        vm.expectRevert(EarlierBackers.NotKeeper.selector);
        eb.takeKeeper();
        vm.prank(alice);
        eb.takeKeeper();
        assertEq(eb.keeper(), alice);
        assertEq(eb.pendingKeeper(), address(0));
        vm.prank(alice);
        vm.expectRevert(EarlierBackers.NotKeeper.selector);
        eb.takeKeeper();
    }

    /// EB10, EB17: the list closes at the long-stop, once; no consent after.
    function test_close_EB10_EB17() public {
        vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, longStop));
        eb.close();
        vm.expectRevert(EarlierBackers.ClosedState.selector);
        eb.toReserve();
        vm.warp(longStop);
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        eb.close();
        assertEq(eb.closeAt(), longStop);
        vm.expectRevert(EarlierBackers.ClosedState.selector);
        eb.close();
        vm.expectRevert(EarlierBackers.ClosedState.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
    }
}

/// @notice Contract wallets: EIP-1271 (a plain one, a Kernel-style account, a Safe-style 2-of-3) and a direct call.
contract EarlierWalletsTest is EarlierBase {
    uint256 internal constant OWNER_A = 0xA0;
    uint256 internal constant OWNER_B = 0xB0;
    uint256 internal constant OWNER_C = 0xC0;

    function _holderFor(uint256 i, uint256 pk) internal override returns (address) {
        if (i == 0) return address(new Wallet1271(vm.addr(OWNER_A)));
        if (i == 1) return address(new KernelStyleAccount(vm.addr(OWNER_A)));
        if (i == 2) {
            address[] memory owners = new address[](3);
            (owners[0], owners[1], owners[2]) = (vm.addr(OWNER_A), vm.addr(OWNER_B), vm.addr(OWNER_C));
            return address(new SafeStyleWallet(owners, 2));
        }
        return vm.addr(pk);
    }

    function test_1271_plainWallet() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _signWith(OWNER_A, _digest(0, holders[0], until));
        vm.prank(relayer);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        assertEq(eb.entryOf(0).signer, holders[0]);
    }

    function test_1271_kernelStyle_ownWrapperOnly() public {
        uint256 until = _now() + 1 days;
        bytes32 d = _digest(1, holders[1], until);
        bytes memory bare = _signWith(OWNER_A, d); // the owner's key over the bare digest: the account refuses it
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(1, holders[1], amounts[1], salts[1], holders[1], TEXT, until, bare);
        // the owner's key over the account's own wrapper of the digest
        bytes memory wrapped = _signWith(OWNER_A, KernelStyleAccount(holders[1]).wrapped(d));
        eb.consent(1, holders[1], amounts[1], salts[1], holders[1], TEXT, until, wrapped);
        assertEq(eb.consentedCount(), 1);
    }

    function test_1271_safeStyle_twoOfThree() public {
        uint256 until = _now() + 1 days;
        bytes32 d = _digest(2, holders[2], until);
        bytes memory one = _signWith(OWNER_A, d);
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(2, holders[2], amounts[2], salts[2], holders[2], TEXT, until, one);
        (uint256 lo, uint256 hi) = vm.addr(OWNER_B) < vm.addr(OWNER_C) ? (OWNER_B, OWNER_C) : (OWNER_C, OWNER_B);
        bytes memory two = abi.encodePacked(_signWith(lo, d), _signWith(hi, d));
        eb.consent(2, holders[2], amounts[2], salts[2], holders[2], TEXT, until, two);
        assertEq(eb.consentedCount(), 1);
    }

    /// A contract holder may also call in person (a hardware wallet behind a contract account, any tool).
    function test_directCall_fromAContractHolder() public {
        uint256 until = _now() + 1 days;
        vm.prank(vm.addr(OWNER_A));
        Wallet1271(holders[0])
            .exec(
                address(eb),
                abi.encodeCall(
                    EarlierBackers.consent, (0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, bytes(""))
                )
            );
        assertEq(eb.entryOf(0).signer, holders[0]);
    }

    /// The front-runner and the relayer give the same result: the consent is the holder's whoever submits it.
    function test_relayerOrFrontRunner_sameResult() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _signWith(OWNER_A, _digest(0, holders[0], until));
        vm.prank(stranger);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        vm.prank(relayer);
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        assertEq(eb.entryOf(0).receiver, holders[0]);
    }
}

/// @notice Delivery: pro rata from the one grant on the one clock, never early, only to the receiver (EB13, EB14, EB16,
/// EB26); the long-stop and the reserve; the Treasury's count.
contract EarlierDeliveryTest is EarlierBase {
    function test_deliver_nothingBeforeTheMarket() public {
        _consentAll();
        vm.warp(_now() + 400 days);
        assertEq(eb.due(0), 0);
        assertEq(eb.deliver(0), 0);
        assertEq(shares.balanceOf(holders[0]), 0);
    }

    /// EB26: nothing before 21 days from the consent; EB13: amount x released / granted; EB14: to the receiver.
    function test_deliver_EB13_EB14_EB26() public {
        _market();
        Wallet1271 w = new Wallet1271(holders[3]);
        _consentTo(3, address(w));
        uint256 t0 = _now();
        vm.warp(t0 + 21 days - 1);
        vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, t0 + 21 days));
        eb.deliver(3);
        vm.warp(t0 + 100 days);
        (uint256 granted,, uint256 released) = _grant();
        uint256 expect = amounts[3] * released / granted;
        assertEq(eb.due(3), expect);
        vm.prank(stranger);
        assertEq(eb.deliver(3), expect);
        assertEq(shares.balanceOf(address(w)), expect, "only the receiver");
        assertEq(shares.balanceOf(stranger), 0);
        assertEq(eb.due(3), 0);
        assertEq(eb.deliver(3), 0, "nothing twice");
        vm.warp(t0 + 365 days);
        eb.deliver(3);
        assertEq(shares.balanceOf(address(w)), amounts[3], "exact at the end");
        assertEq(eb.entryOf(3).taken, amounts[3]);
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.deliver(4); // open
    }

    /// An outside `Vester.claim` for the claim contract changes nothing.
    function test_deliver_outsideClaimChangesNothing() public {
        _market();
        _consentAll();
        vm.warp(_now() + 50 days);
        uint256 before = eb.due(7);
        uint256 und = eb.undelivered();
        v.claim(address(eb));
        assertEq(eb.due(7), before);
        assertEq(eb.undelivered(), und);
        eb.deliverMany(_ids());
        assertEq(eb.undelivered(), und - eb.delivered());
    }

    /// The Treasury leaves released but undelivered earlier-backer Shares out of the count, and counts them once delivered.
    function test_countingSupply_leavesOutUndelivered() public {
        _market();
        _buy(alice, 350_000_000e18);
        uint256 base = t.countingSupply();
        assertEq(base, 350_000_000e18);
        vm.warp(_now() + 100 days);
        (,, uint256 released) = _grant();
        assertGt(released, 0);
        assertEq(eb.undelivered(), released);
        assertEq(t.countingSupply(), base, "released to the claim, not delivered: not counted");
        _consentAll();
        vm.warp(_now() + 21 days);
        eb.deliverMany(_ids());
        uint256 delivered = eb.delivered();
        assertGt(delivered, 0);
        assertEq(t.countingSupply(), base + delivered, "delivered: counted");
        assertEq(eb.undelivered(), v.released(address(eb)) - delivered);
    }

    /// EB16, EB17: after the long-stop the open entries' released Shares and any strays go to the reserve; consented
    /// entries keep receiving theirs; delivered + sent to the reserve never passes what was released.
    function test_close_openEntriesAndStraysToTheReserve() public {
        _market();
        for (uint256 i; i < 15; ++i) {
            _consent(i);
        }
        vm.prank(address(t));
        shares.transfer(address(eb), 1000e18); // a stray (from the reserve, by mistake)
        vm.warp(longStop);
        eb.close();
        uint256 reserveBefore = t.reserve();
        uint256 sent = eb.toReserve();
        (uint256 granted,, uint256 released) = _grant();
        assertEq(released, granted, "the clock is done");
        uint256 open = S1_TOTAL - eb.consentedTotal();
        assertEq(sent, open + 1000e18, "open entries and the stray");
        assertEq(t.reserve(), reserveBefore + sent);
        assertEq(eb.reserveTaken(), open);
        assertEq(eb.toReserve(), 0, "nothing twice");
        uint256[] memory ids = new uint256[](15);
        for (uint256 i; i < 15; ++i) {
            ids[i] = i;
        }
        eb.deliverMany(ids);
        assertEq(eb.delivered() + eb.reserveTaken(), released);
        assertEq(eb.undelivered(), 0);
        assertEq(shares.balanceOf(address(eb)), 0);
        assertEq(t.teamBudget(), 52_989_393_666_666_700_000_000_000, "the team budget is not the reserve");
    }

    /// Holdouts are not swept before the long-stop, and waiting thins nobody (their Shares are not counted).
    function test_holdouts_waitUntilTheLongStop() public {
        _market();
        vm.warp(_now() + 400 days);
        vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, longStop));
        eb.close();
        assertEq(eb.undelivered(), S1_TOTAL);
        _consent(20);
        vm.warp(_now() + 21 days);
        eb.deliver(20);
        assertEq(shares.balanceOf(holders[20]), amounts[20], "a late signer gets the whole entry at once");
    }
}

/// @notice Counsel's lock-up gate switched on: no delivery before 365 days from each signature (EB27).
contract EarlierLockTest is EarlierBase {
    function _hold() internal pure override returns (uint256) {
        return 365 days;
    }

    function test_deliver_EB27_holdFromTheSignature() public {
        _consent(0);
        uint256 t0 = _now();
        _market();
        vm.warp(t0 + 364 days);
        vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, t0 + 365 days));
        eb.deliver(0);
        vm.warp(t0 + 365 days);
        eb.deliver(0);
        assertEq(shares.balanceOf(holders[0]), eb.entryOf(0).taken);
        assertGt(eb.entryOf(0).taken, 0);
    }
}
