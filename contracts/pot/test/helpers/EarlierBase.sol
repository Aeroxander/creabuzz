// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./StackBase.sol";
import {EarlierGrants} from "../../src/EarlierGrants.sol";
import {Launcher} from "../../src/Launcher.sol";
import {Parts} from "../../src/Parts.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice One row of an invented list.
struct Row {
    uint256 index;
    address account;
    uint256 amount;
}

/// @notice The real stack with the earlier backers' claim contract bound before any launch, as the deploy script does it, and a
/// list built in memory from INVENTED rows: accounts made with `makeAddr("row-N")` and amounts chosen here. No real list, name,
/// amount or address exists anywhere in the tests; the only fingerprints are computed here. The default project is project zero
/// (founder `founder`, id `ZERO_ID`), born with the reserve; `_launch` makes others.
abstract contract EarlierBase is StackBase {
    bytes32 internal constant ZERO_ID = "zero";
    bytes32 internal constant TEXT = keccak256("an invented text, version one");

    EarlierGrants internal earlier;
    Row[] internal rows_;
    bytes32 internal root;
    uint256 internal poolTotal;
    /// @dev The test's own copy of the block time (`vm.warp(block.timestamp + x)` is unreliable under the optimizer).
    uint256 internal clock;

    address internal row1 = makeAddr("row-1");
    address internal row2 = makeAddr("row-2");
    address internal row3 = makeAddr("row-3");
    address internal row4 = makeAddr("row-4");

    function setUp() public virtual override {
        _setupWith(_defaultRows(), 0);
    }

    /// @dev Eight invented rows: 1,000, 2,500, 40 and a half Share (too small to grant) for four accounts, a second row of the
    /// first account, and three more.
    function _defaultRows() internal returns (Row[] memory r) {
        r = new Row[](8);
        r[0] = Row(0, row1, 1000e18);
        r[1] = Row(1, row2, 2500e18);
        r[2] = Row(2, row3, 40e18);
        r[3] = Row(3, row4, 0.5e18);
        r[4] = Row(4, row1, 700e18);
        r[5] = Row(5, makeAddr("row-5"), 12e18);
        r[6] = Row(6, makeAddr("row-6"), 300e18);
        r[7] = Row(7, makeAddr("row-7"), 5e18);
    }

    function _sum(Row[] memory r) internal pure returns (uint256 s) {
        for (uint256 i; i < r.length; ++i) {
            s += r[i].amount;
        }
    }

    /// @dev Deploy a whole stack with `list` as the earlier list. `total_` is the pool (zero: the sum of the rows).
    function _setupWith(Row[] memory list, uint256 total_) internal {
        _setupRooted(list, total_, _root(list));
    }

    /// @dev As `_setupWith`, with the fingerprint the claim contract is made with given (a list built another way).
    function _setupRooted(Row[] memory list, uint256 total_, bytes32 root_) internal {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        delete rows_;
        for (uint256 i; i < list.length; ++i) {
            rows_.push(list[i]);
        }
        poolTotal = total_ == 0 ? _sum(list) : total_;
        root = root_;
        earlier = new EarlierGrants(
            address(launcher), root, TEXT, poolTotal, uint32(list.length), launcher.keyOf(founder, ZERO_ID)
        );
        launcher.bindEarlier(address(earlier));
        _use(_launch(founder, ZERO_ID, 1000, POOL));
    }

    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    // ===================================================== the tree ==================================================

    function _leaf(Row memory r) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(r.index, r.account, r.amount))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev The leaves padded with zeros to a power of two, one layer at a time.
    function _layer0(Row[] memory list) internal pure returns (bytes32[] memory l) {
        uint256 n = 1;
        while (n < list.length) {
            n *= 2;
        }
        l = new bytes32[](n);
        for (uint256 i; i < list.length; ++i) {
            l[i] = _leaf(list[i]);
        }
    }

    function _up(bytes32[] memory l) internal pure returns (bytes32[] memory u) {
        u = new bytes32[](l.length / 2);
        for (uint256 i; i < u.length; ++i) {
            u[i] = _pair(l[2 * i], l[2 * i + 1]);
        }
    }

    function _root(Row[] memory list) internal pure returns (bytes32) {
        bytes32[] memory l = _layer0(list);
        while (l.length > 1) {
            l = _up(l);
        }
        return l[0];
    }

    /// @dev The proof of row `index` of `list`.
    function _proofOf(Row[] memory list, uint256 index) internal pure returns (bytes32[] memory p) {
        bytes32[] memory l = _layer0(list);
        uint256 depth;
        for (uint256 n = l.length; n > 1; n /= 2) {
            ++depth;
        }
        p = new bytes32[](depth);
        uint256 at = index;
        for (uint256 d; d < depth; ++d) {
            p[d] = l[at ^ 1];
            l = _up(l);
            at /= 2;
        }
    }

    function _list() internal view returns (Row[] memory r) {
        r = new Row[](rows_.length);
        for (uint256 i; i < r.length; ++i) {
            r[i] = rows_[i];
        }
    }

    function _proof(uint256 index) internal view returns (bytes32[] memory) {
        return _proofOf(_list(), index);
    }

    /// @dev Claim row `index` as its own account, naming the right text.
    function _claim(uint256 index) internal returns (uint256 id) {
        Row memory r = rows_[index];
        bytes32[] memory p = _proof(index);
        vm.prank(r.account);
        id = earlier.claim(r.index, r.amount, p, TEXT);
    }

    /// @dev Put `n` Team Shares of vested grant `id` into the member's hands (anyone may call it).
    function _payOut(uint256 id) internal {
        v.claim(id);
    }
}
