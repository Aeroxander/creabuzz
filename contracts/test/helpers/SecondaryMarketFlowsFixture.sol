// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarketFixture} from "../SecondaryMarketMocks.t.sol";

/// @title The shared launch every secondary-market flow test starts from
/// @dev 40 / 30 / 20 whole lots born to the sellers, B1 born with nothing (a pure buyer), three funded
/// buyers, and everyone approved on both sides. The flows live across the `SecondaryMarketFlows*`
/// contracts because one contract holding all of them overflowed the via-IR assembler's tag space; this
/// base keeps their shared setup in one place so a split can never drift the fixture apart.

abstract contract SecondaryMarketFlowsFixture is SecondaryMarketFixture {
    address internal constant S1 = address(0x5E1101);
    address internal constant S2 = address(0x5E1102);
    address internal constant S3 = address(0x5E1103);
    address internal constant B1 = address(0xB11);
    address internal constant B2 = address(0xB22);
    address internal constant B3 = address(0xB33);
    address internal constant STANDIN = address(0x518D1);

    Launch internal l;

    function setUp() public {
        // 40 / 30 / 20 whole lots born to the sellers; B1 is born with nothing (a pure buyer).
        address[] memory holders = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        holders[0] = S1;
        holders[1] = S2;
        holders[2] = S3;
        holders[3] = B1;
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        amounts[2] = 20e18;
        amounts[3] = 0;
        l = _launch(holders, amounts);
        _approve(l, S1);
        _approve(l, S2);
        _approve(l, S3);
        _approve(l, B1);
        _mintQuote(B1, 1_000_000e6);
        _mintQuote(B2, 1_000_000e6);
        _mintQuote(B3, 1_000_000e6);
        _approve(l, B2);
        _approve(l, B3);
    }

    function _mintQuote(address who, uint256 amount) internal {
        l.quote.mint(who, amount);
    }
}
