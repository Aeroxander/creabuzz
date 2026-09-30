//! Test-support encoders for the integration test's admin calls.
//!
//! Owner administration (setSpender/setAllowance) is deliberately not on
//! the guard's public client surface — a spend-time harness must never be
//! able to raise its own ceilings. The integration test needs the encoders,
//! so they live behind a `test_support` module guarded by the `test-support`
//! feature (enabled by the integration test via dev-dependencies).

use crate::abi;

/// ABI-encode `setSpender(bytes32,address)`.
pub fn encode_set_spender(subject: &[u8; 32], spender: &[u8; 20]) -> Vec<u8> {
    abi::encode_set_spender(subject, spender)
}

/// ABI-encode `setAllowance(bytes32,address,uint64,uint256)`.
pub fn encode_set_allowance(
    subject: &[u8; 32],
    token: &[u8; 20],
    epoch: u64,
    amount: u128,
) -> Vec<u8> {
    abi::encode_set_allowance(subject, token, epoch, amount)
}

/// Parse a `0x…` hex address (re-exported for the test's token constant).
pub fn parse_address(hex_addr: &str) -> Result<[u8; 20], crate::AllowanceError> {
    abi::parse_address(hex_addr)
}
