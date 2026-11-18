// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./RoundsBase.sol";
import {EarlierBackers} from "../../src/EarlierBackers.sol";
import {Rounds} from "../../src/Rounds.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Treasury} from "../../src/Treasury.sol";
import {Vester} from "../../src/Vester.sol";

/// @notice Project zero with its earlier backers, on the milestone 2 world (`Base`: the real Launcher, Treasury, Vester and
/// Rounds; the sale simulated). Every holder, amount and salt here is MADE UP: no real backer, amount or wallet appears in
/// the repo. The default list has 21 made-up entries that add up to 288,677,273 Shares (S1: the earlier backers keep their
/// percent of the old supply), and project zero keeps 8,333,333.33 backing Shares for its own 6,000,000 rounds (what the
/// 50,000 Team cap buys at that price, measured in `FounderPrice.t.sol`).
///
/// After `setUp` the inherited `key`, `rd`, `shares`, `t`, `v`, `finisher`, `opener` and `rounds` are project zero's (project
/// one, launched by `Base`, stays launched beside it).
abstract contract EarlierBase is RoundsBase {
    /// @dev S1: the 31,754,500 old tokens of the 110,000,000 old supply, as Shares of 1,000,000,000 (rounded to a Share).
    uint256 internal constant S1_TOTAL = 288_677_273e18;
    /// @dev The backing Shares project zero keeps for its own rounds: 50,000 dollars at 6,000,000 for the whole project.
    uint256 internal constant KEEP = 8_333_333_333_333_300_000_000_000;
    /// @dev 6,000,000 dollars for the whole project, as raw Share units per raw dollar unit.
    uint256 internal constant SIX_MILLION = 166_666_666_666_666;
    uint256 internal constant FOUNDER_SLICE = 200_000_000e18;
    uint256 internal constant BACKING_SLICE = 150_000_000e18;
    bytes32 internal constant ZERO_ID = keccak256("creaton, project zero");
    bytes32 internal constant TEXT = keccak256("made-up agreement text for tests, version 1");
    string internal constant SUMMARY = "Made-up test summary: your old agreement ends and you receive Shares instead.";

    EarlierBackers internal eb;
    address internal keeper = makeAddr("keeper");
    address internal relayer = makeAddr("relayer");
    uint256 internal longStop;

    uint256[] internal pks;
    address[] internal holders;
    uint256[] internal amounts;
    bytes32[] internal salts;
    bytes32[] internal leaves;

    function setUp() public virtual override {
        super.setUp(); // project one, launched by `founder`
        _makeList(_listSize(), _listSum());
        eb = _deployClaim(launcher.keyOf(founder, ZERO_ID), _hold());
        if (_launchesZero()) _launchZero(KEEP);
    }

    /// @dev The list's size, the sum of its entries, the total the claim contract is told, counsel's lock-up gate (zero:
    /// off), and whether `setUp` launches project zero. Tests override them.
    function _launchesZero() internal view virtual returns (bool) {
        return true;
    }

    function _listSum() internal view virtual returns (uint256) {
        return _listTotal();
    }

    function _listSize() internal view virtual returns (uint256) {
        return 21;
    }

    function _listTotal() internal view virtual returns (uint256) {
        return S1_TOTAL;
    }

    function _hold() internal view virtual returns (uint256) {
        return 0;
    }

    /// @dev `n` made-up entries adding up to `sum`: 4M + 1M x i Shares for all but the last, which takes the rest (or, when
    /// that pattern is larger than `sum`, equal parts with the rest in the last).
    function _makeList(uint256 n, uint256 sum) internal {
        delete pks;
        delete holders;
        delete amounts;
        delete salts;
        delete leaves;
        uint256 used;
        uint256 pattern = 4_000_000e18 * (n - 1) + 1_000_000e18 * ((n - 1) * (n - 2) / 2);
        for (uint256 i; i < n; ++i) {
            uint256 pk = uint256(keccak256(abi.encode("made-up backer key", i))) % (type(uint128).max - 1) + 1;
            pks.push(pk);
            holders.push(_holderFor(i, pk));
            uint256 a;
            if (i + 1 == n) a = sum - used;
            else if (pattern < sum) a = 4_000_000e18 + 1_000_000e18 * i;
            else a = sum / n;
            amounts.push(a);
            used += a;
            salts.push(keccak256(abi.encode("made-up salt", i)));
            leaves.push(keccak256(abi.encode(i, holders[i], a, salts[i])));
        }
    }

    /// @dev Entry `i`'s holder: the made-up key's address, unless a test puts a contract wallet there.
    function _holderFor(uint256, uint256 pk) internal virtual returns (address) {
        return vm.addr(pk);
    }

    function _deployClaim(bytes32 key0, uint256 hold) internal returns (EarlierBackers) {
        return _deployClaimWith(address(launcher), key0, leaves, _listTotal(), hold);
    }

    function _deployClaimWith(address launcher_, bytes32 key0, bytes32[] memory leaves_, uint256 total, uint256 hold)
        internal
        returns (EarlierBackers)
    {
        longStop = _now() + 3 * 365 days;
        return EarlierBackers(
            deployCode(
                "EarlierBackers.sol:EarlierBackers",
                abi.encode(launcher_, key0, leaves_, total, TEXT, keccak256(bytes(SUMMARY)), longStop, hold, keeper)
            )
        );
    }

    /// @dev The admin names project zero and its earlier raise, and Creaton's founder launches it with the launch hash.
    function _launchZero(uint256 keep) internal {
        bytes32 k0 = launcher.keyOf(founder, ZERO_ID);
        vm.startPrank(admin);
        launcher.nameProjectZero(k0);
        launcher.nameEarlierBackers(address(eb), keep);
        vm.stopPrank();
        bytes32 h = launcher.launchHash(k0);
        vm.prank(founder);
        (address s, address tr, address ve) = launcher.launch(ZERO_ID, "Creaton", "CREATE", h);
        (shares, t, v) = (ShareToken(s), Treasury(tr), Vester(ve));
        key = k0;
        finisher = opener = launcher.projectByKey(k0).finisher;
        rounds = launcher.projectByKey(k0).rounds;
        rd = Rounds(rounds);
    }

    // ------------------------------------------------------------------------------------------------ signing

    function _digest(uint256 i, address receiver, uint256 until) internal view returns (bytes32) {
        return eb.consentDigest(i, holders[i], amounts[i], receiver, until);
    }

    function _signWith(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v8, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v8);
    }

    function _sign(uint256 i, address receiver, uint256 until) internal view returns (bytes memory) {
        return _signWith(pks[i], _digest(i, receiver, until));
    }

    /// @dev A relayer submits entry `i`'s signed consent, its Shares going to the holder's own wallet.
    function _consent(uint256 i) internal {
        _consentTo(i, holders[i]);
    }

    function _consentTo(uint256 i, address receiver) internal {
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(i, receiver, until);
        vm.prank(relayer);
        eb.consent(i, holders[i], amounts[i], salts[i], receiver, TEXT, until, sig);
    }

    function _consentAll() internal {
        for (uint256 i; i < holders.length; ++i) {
            _consent(i);
        }
    }

    function _ids() internal view returns (uint256[] memory ids) {
        ids = new uint256[](holders.length);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = i;
        }
    }

    /// @dev The claim contract's grant and what the clock has released of it.
    function _grant() internal view returns (uint256 granted, uint256 claimed, uint256 released) {
        (granted, claimed) = v.grants(address(eb));
        released = v.released(address(eb));
    }
}
