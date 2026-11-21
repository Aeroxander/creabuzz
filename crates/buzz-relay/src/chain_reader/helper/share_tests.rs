//! The optional calls' slice of the day's caps (`optional_share_hit`), without a
//! database: where exactly it is reached, for gas and for wei, with and
//! without a call asked for.

use buzz_evm_allowance::Wallet;

use super::store::Used;
use super::{optional_share_hit, HelperConfig};

/// anvil's account 4: a public development key.
const DEV_KEY: &str = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

/// Caps of 1,000 gas and 5,000 wei a day: the slice is 20% of each, 200 and 1,000.
fn config() -> HelperConfig {
    let mut config = HelperConfig::with_key(Wallet::from_private_key_hex(DEV_KEY).expect("a key"));
    config.daily_gas = 1_000;
    config.daily_spend_wei = 5_000;
    config
}

fn used(gas: u128, wei: u128) -> Used {
    Used { gas, wei }
}

#[test]
fn the_slice_is_a_fifth_of_each_cap() {
    let config = config();
    // Asked for the whole slice and not a unit more.
    assert_eq!(optional_share_hit(&config, used(0, 0), 200, 1_000), None);
    assert!(optional_share_hit(&config, used(0, 0), 201, 0).is_some());
    assert!(optional_share_hit(&config, used(0, 0), 0, 1_001).is_some());
}

#[test]
fn with_nothing_asked_a_slice_used_up_exactly_has_no_room() {
    let config = config();
    assert_eq!(optional_share_hit(&config, used(199, 999), 0, 0), None);
    let gas = optional_share_hit(&config, used(200, 0), 0, 0).expect("gas slice reached");
    assert!(gas.contains("gas cap"), "{gas}");
    let wei = optional_share_hit(&config, used(0, 1_000), 0, 0).expect("wei slice reached");
    assert!(wei.contains("spend cap"), "{wei}");
}

#[test]
fn a_call_asked_for_is_held_when_it_would_pass_the_slice_not_when_it_reaches_it() {
    let config = config();
    // 150 used, 50 more is exactly the slice: allowed; 51 passes it.
    assert_eq!(optional_share_hit(&config, used(150, 0), 50, 0), None);
    assert!(optional_share_hit(&config, used(150, 0), 51, 0).is_some());
    // The same for wei.
    assert_eq!(optional_share_hit(&config, used(0, 900), 0, 100), None);
    assert!(optional_share_hit(&config, used(0, 900), 0, 101).is_some());
    // Gas is judged on its own: a wei reserve that fits does not save it.
    assert!(optional_share_hit(&config, used(200, 0), 1, 1).is_some());
}
