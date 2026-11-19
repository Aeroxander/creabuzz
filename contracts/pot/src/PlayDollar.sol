// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "oz5/token/ERC20/ERC20.sol";
import {ERC1363} from "oz5/token/ERC20/extensions/ERC1363.sol";

/// @title PlayDollar
/// @notice The dollar of the test network: 6 decimals, an open faucet that gives each account 1,000 play dollars once, and
/// `transferAndCall` (ERC-1363), so a join is one wallet signature: the Treasury receives the dollars and joins in the
/// same call. It exists only on a test chain; the constructor refuses to deploy anywhere else.
contract PlayDollar is ERC20, ERC1363 {
    /// @notice What the faucet gives an account, once: 1,000 dollars.
    uint256 public constant FAUCET_AMOUNT = 1000e6;

    /// @notice The address that may mint for test harnesses.
    address public immutable admin;
    /// @notice True once an account has used the faucet.
    mapping(address => bool) public faucetUsed;

    /// @notice An account took its faucet dollars.
    event Faucet(address indexed account, uint256 amount);

    /// @notice This is not a test chain.
    error NotATestChain();
    /// @notice The faucet was used by this account already.
    error FaucetUsed();
    /// @notice Only the admin may do this.
    error NotAdmin();

    constructor(address admin_) ERC20("Play Dollar", "pUSD") {
        if (block.chainid != 31_337 && block.chainid != 11_155_111) revert NotATestChain();
        admin = admin_;
    }

    /// @notice Play dollars have 6 decimals, like the real dollar the Treasury expects.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Take 1,000 play dollars. Once per account.
    function faucet() external {
        if (faucetUsed[msg.sender]) revert FaucetUsed();
        faucetUsed[msg.sender] = true;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit Faucet(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Mint play dollars to `to`. Only the admin, to fund a test harness or the anvil loop.
    function mint(address to, uint256 amount) external {
        if (msg.sender != admin) revert NotAdmin();
        _mint(to, amount);
    }
}
