// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC1363Receiver} from "oz5/interfaces/IERC1363Receiver.sol";
import {PlayDollar} from "../src/PlayDollar.sol";

contract GoodReceiver is IERC1363Receiver {
    address public lastOperator;
    address public lastFrom;
    uint256 public lastValue;
    bytes public lastData;

    function onTransferReceived(address operator, address from, uint256 value, bytes calldata data)
        external
        returns (bytes4)
    {
        (lastOperator, lastFrom, lastValue, lastData) = (operator, from, value, data);
        return IERC1363Receiver.onTransferReceived.selector;
    }
}

contract WrongSelectorReceiver {
    function onTransferReceived(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract PlayDollarTest is Test {
    PlayDollar internal pd;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        pd = new PlayDollar(admin);
    }

    function test_sixDecimals() public view {
        assertEq(pd.decimals(), 6);
    }

    function test_faucetOncePerAccountOfOneThousand() public {
        vm.prank(alice);
        pd.faucet();
        assertEq(pd.balanceOf(alice), 1000e6);
        vm.prank(alice);
        vm.expectRevert(PlayDollar.FaucetUsed.selector);
        pd.faucet();
        vm.prank(bob);
        pd.faucet();
        assertEq(pd.balanceOf(bob), 1000e6);
        assertEq(pd.totalSupply(), 2000e6);
    }

    function test_faucetEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit PlayDollar.Faucet(alice, 1000e6);
        vm.prank(alice);
        pd.faucet();
    }

    function test_adminMintOnly() public {
        vm.prank(alice);
        vm.expectRevert(PlayDollar.NotAdmin.selector);
        pd.mint(alice, 1);
        vm.prank(admin);
        pd.mint(alice, 5e6);
        assertEq(pd.balanceOf(alice), 5e6);
    }

    function test_transferAndCallReachesTheReceiverWithTheSenderAsOperatorAndFrom() public {
        GoodReceiver r = new GoodReceiver();
        vm.prank(alice);
        pd.faucet();
        vm.prank(alice);
        pd.transferAndCall(address(r), 100e6, hex"1234");
        assertEq(pd.balanceOf(address(r)), 100e6);
        assertEq(r.lastOperator(), alice);
        assertEq(r.lastFrom(), alice);
        assertEq(r.lastValue(), 100e6);
        assertEq(r.lastData(), hex"1234");
    }

    function test_transferAndCallRevertsWhenTheReceiverIsNotAReceiver() public {
        address wrong = address(new WrongSelectorReceiver());
        vm.prank(alice);
        pd.faucet();
        vm.startPrank(alice);
        vm.expectRevert(); // an account with no code
        pd.transferAndCall(bob, 1e6, "");
        vm.expectRevert(); // a contract without the call-back
        pd.transferAndCall(address(this), 1e6, "");
        vm.expectRevert(); // a call-back that answers with the wrong selector
        pd.transferAndCall(wrong, 1e6, "");
        vm.stopPrank();
        assertEq(pd.balanceOf(alice), 1000e6);
    }

    function test_onlyOnATestChain() public {
        vm.chainId(1);
        vm.expectRevert(PlayDollar.NotATestChain.selector);
        new PlayDollar(admin);
        vm.chainId(11_155_111);
        new PlayDollar(admin); // Sepolia is a test chain
        vm.chainId(8453);
        vm.expectRevert(PlayDollar.NotATestChain.selector);
        new PlayDollar(admin);
    }
}
