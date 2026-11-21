//! Reading an account's call data: the Kernel account's single and batch `execute` (ERC-7579), the inverse of the
//! app's `encodeExecuteCallData` (`packages/creaton-core/src/aa/sponsoredSender.ts`).
//!
//! The sponsor tells an **exit** (Take out) from other operations by what the operation calls, so this reads exactly the
//! two shapes the app writes and refuses everything else, including call data that decodes but is not byte for byte what
//! encoding the decoded calls gives (padding or extra bytes a signer would not have been shown). The test
//! `agrees_with_the_apps_decoder_on_the_same_bytes` reads vectors the app's own encoder made
//! (`scripts/sponsor-calldata-vectors.mjs`).

use buzz_evm_allowance::abi::keccak256;

/// `execute(bytes32,bytes)`: the function of both shapes.
pub const EXECUTE_SIGNATURE: &str = "execute(bytes32,bytes)";
/// `leave(uint256,uint256,address)` of the Treasury: take out backer Shares.
pub const LEAVE_SIGNATURE: &str = "leave(uint256,uint256,address)";
/// `leaveTeam(uint256,uint256,address)` of the Treasury: take out Team Shares.
pub const LEAVE_TEAM_SIGNATURE: &str = "leaveTeam(uint256,uint256,address)";
/// `unpark(uint256)` of a project's holder pause: take parked Shares back (the first call of a Take out of Shares that
/// are parked).
pub const UNPARK_SIGNATURE: &str = "unpark(uint256)";
/// The most calls a batch may hold (the app's decoder has the same bound).
pub const BATCH_MAX: usize = 64;

/// The mode of a single call: CALLTYPE_SINGLE and EXECTYPE_DEFAULT, all zero.
const MODE_SINGLE: [u8; 32] = [0u8; 32];
/// The mode of a batch: CALLTYPE_BATCH (0x01) then zeros.
const MODE_BATCH: [u8; 32] = {
    let mut mode = [0u8; 32];
    mode[0] = 1;
    mode
};

/// The first four bytes of the keccak hash of a signature.
pub fn selector(signature: &str) -> [u8; 4] {
    let hash = keccak256(signature.as_bytes());
    [hash[0], hash[1], hash[2], hash[3]]
}

/// One call inside an operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    /// The contract called.
    pub to: [u8; 20],
    /// The native value sent, as a 32-byte big-endian number.
    pub value: [u8; 32],
    /// The call data.
    pub data: Vec<u8>,
}

impl Call {
    /// Whether the call sends no native value.
    pub fn is_zero_value(&self) -> bool {
        self.value.iter().all(|b| *b == 0)
    }

    /// The first four bytes of the call data, when it has them.
    pub fn selector(&self) -> Option<[u8; 4]> {
        self.data.get(..4).map(|s| [s[0], s[1], s[2], s[3]])
    }
}

/// Why call data was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// It is not the `execute` function of the account.
    WrongFunction,
    /// It is cut short, or its layout is not the one the app writes.
    Layout,
    /// The mode is neither a single call nor a batch.
    UnknownMode,
    /// A batch of no calls or more than [`BATCH_MAX`].
    BadCount,
    /// It decodes, but is not the canonical encoding of its calls.
    NotCanonical,
}

fn word(bytes: &[u8], index: usize) -> Option<&[u8]> {
    bytes.get(index.checked_mul(32)?..index.checked_mul(32)?.checked_add(32)?)
}

/// A word as a `usize`, when it is small enough (the high 24 bytes zero).
fn small(word: &[u8]) -> Option<usize> {
    if word.len() != 32 || word[..24].iter().any(|b| *b != 0) {
        return None;
    }
    usize::try_from(u64::from_be_bytes(word[24..32].try_into().ok()?)).ok()
}

fn pad32(len: usize) -> usize {
    len.div_ceil(32) * 32
}

fn encode_execute(mode: &[u8; 32], execution: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 96 + pad32(execution.len()));
    out.extend_from_slice(&selector(EXECUTE_SIGNATURE));
    out.extend_from_slice(mode);
    out.extend_from_slice(&u256(64));
    out.extend_from_slice(&u256(execution.len()));
    out.extend_from_slice(execution);
    out.resize(out.len() + pad32(execution.len()) - execution.len(), 0);
    out
}

fn u256(n: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&(n as u64).to_be_bytes());
    out
}

/// The canonical call data for these calls: one call is a single execute, several are a batch.
pub fn encode(calls: &[Call]) -> Vec<u8> {
    if let [only] = calls {
        let mut execution = Vec::with_capacity(52 + only.data.len());
        execution.extend_from_slice(&only.to);
        execution.extend_from_slice(&only.value);
        execution.extend_from_slice(&only.data);
        return encode_execute(&MODE_SINGLE, &execution);
    }
    // abi.encode(Execution[]): [0x20][count][offsets][each: target, value, 0x60, length, data padded]
    let mut items: Vec<Vec<u8>> = Vec::with_capacity(calls.len());
    for call in calls {
        let mut item = Vec::new();
        item.extend_from_slice(&[0u8; 12]);
        item.extend_from_slice(&call.to);
        item.extend_from_slice(&call.value);
        item.extend_from_slice(&u256(96));
        item.extend_from_slice(&u256(call.data.len()));
        item.extend_from_slice(&call.data);
        item.resize(item.len() + pad32(call.data.len()) - call.data.len(), 0);
        items.push(item);
    }
    let mut execution = Vec::new();
    execution.extend_from_slice(&u256(32));
    execution.extend_from_slice(&u256(calls.len()));
    let mut offset = calls.len() * 32;
    for item in &items {
        execution.extend_from_slice(&u256(offset));
        offset += item.len();
    }
    for item in &items {
        execution.extend_from_slice(item);
    }
    encode_execute(&MODE_BATCH, &execution)
}

/// The calls inside account call data, or why it was refused. Reads only the two shapes [`encode`] writes.
pub fn decode(call_data: &[u8]) -> Result<Vec<Call>, DecodeError> {
    let args = call_data
        .strip_prefix(&selector(EXECUTE_SIGNATURE)[..])
        .ok_or(DecodeError::WrongFunction)?;
    let mode = word(args, 0).ok_or(DecodeError::Layout)?;
    if small(word(args, 1).ok_or(DecodeError::Layout)?) != Some(64) {
        return Err(DecodeError::Layout);
    }
    let length = small(word(args, 2).ok_or(DecodeError::Layout)?).ok_or(DecodeError::Layout)?;
    let execution = args
        .get(96..96usize.checked_add(length).ok_or(DecodeError::Layout)?)
        .ok_or(DecodeError::Layout)?;
    let calls = if mode == MODE_SINGLE {
        if execution.len() < 52 {
            return Err(DecodeError::Layout);
        }
        vec![Call {
            to: execution[..20]
                .try_into()
                .map_err(|_| DecodeError::Layout)?,
            value: execution[20..52]
                .try_into()
                .map_err(|_| DecodeError::Layout)?,
            data: execution[52..].to_vec(),
        }]
    } else if mode == MODE_BATCH {
        if small(word(execution, 0).ok_or(DecodeError::Layout)?) != Some(32) {
            return Err(DecodeError::Layout);
        }
        let count =
            small(word(execution, 1).ok_or(DecodeError::Layout)?).ok_or(DecodeError::Layout)?;
        if !(1..=BATCH_MAX).contains(&count) {
            return Err(DecodeError::BadCount);
        }
        let area = execution.get(64..).ok_or(DecodeError::Layout)?;
        let mut calls = Vec::with_capacity(count);
        for i in 0..count {
            let start =
                small(word(area, i).ok_or(DecodeError::Layout)?).ok_or(DecodeError::Layout)?;
            let item = area.get(start..).ok_or(DecodeError::Layout)?;
            let target = word(item, 0).ok_or(DecodeError::Layout)?;
            if target[..12].iter().any(|b| *b != 0) {
                return Err(DecodeError::Layout);
            }
            let value = word(item, 1).ok_or(DecodeError::Layout)?;
            let data_len =
                small(word(item, 3).ok_or(DecodeError::Layout)?).ok_or(DecodeError::Layout)?;
            let data = item
                .get(128..128usize.checked_add(data_len).ok_or(DecodeError::Layout)?)
                .ok_or(DecodeError::Layout)?;
            calls.push(Call {
                to: target[12..].try_into().map_err(|_| DecodeError::Layout)?,
                value: value.try_into().map_err(|_| DecodeError::Layout)?,
                data: data.to_vec(),
            });
        }
        calls
    } else {
        return Err(DecodeError::UnknownMode);
    };
    if encode(&calls) != call_data {
        return Err(DecodeError::NotCanonical);
    }
    Ok(calls)
}

/// Whether the operation is an exit: every call goes to a followed contract with no native value, and the calls are
/// `leave` or `leaveTeam` of one of `treasuries`, or `unpark(uint256)` of one of `pauses` (at most one `unpark` of each
/// pause), with **at least one `leave` or `leaveTeam`**. A holder whose Shares are parked takes out in one press that
/// takes them back first (`[unpark, leave]`); an `unpark` alone is not an exit (it moves no money out of the project, so
/// it counts like any other operation), and a batch of `unpark`s cannot be made to burn the sponsor's fee on a `leave`
/// that is not there. An operation of no calls is not one.
pub fn is_exit(calls: &[Call], treasuries: &[[u8; 20]], pauses: &[[u8; 20]]) -> bool {
    let (leave, leave_team, unpark) = (
        selector(LEAVE_SIGNATURE),
        selector(LEAVE_TEAM_SIGNATURE),
        selector(UNPARK_SIGNATURE),
    );
    let mut leaves = 0usize;
    let mut unparked: Vec<[u8; 20]> = Vec::new();
    for call in calls {
        if !call.is_zero_value() {
            return false;
        }
        let Some(called) = call.selector() else {
            return false;
        };
        if treasuries.contains(&call.to) && (called == leave || called == leave_team) {
            leaves += 1;
        } else if pauses.contains(&call.to) && called == unpark && call.data.len() == 36 {
            if unparked.contains(&call.to) {
                return false;
            }
            unparked.push(call.to);
        } else {
            return false;
        }
    }
    leaves > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn hex_bytes(text: &str) -> Option<Vec<u8>> {
        hex::decode(text.strip_prefix("0x")?).ok()
    }

    fn address(text: &str) -> [u8; 20] {
        hex_bytes(text).expect("hex").try_into().expect("20 bytes")
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!("calldata_vectors.json")).expect("the vectors are JSON")
    }

    fn calls_of(row: &Value) -> Vec<Call> {
        row["calls"]
            .as_array()
            .expect("calls")
            .iter()
            .map(|c| {
                let value = hex_bytes(&format!(
                    "0x{:0>64}",
                    c["value"].as_str().expect("value").trim_start_matches("0x")
                ))
                .expect("value");
                Call {
                    to: address(c["to"].as_str().expect("to")),
                    value: value.try_into().expect("32 bytes"),
                    data: hex_bytes(c["data"].as_str().expect("data")).expect("data"),
                }
            })
            .collect()
    }

    /// K6: the Rust reader agrees with the app's own `decodeExecuteCallData` on the same bytes (single and batch), and
    /// refuses what the app's decoder refuses.
    #[test]
    fn agrees_with_the_apps_decoder_on_the_same_bytes() {
        let vectors = vectors();
        let valid = vectors["valid"].as_array().expect("valid rows");
        assert!(valid.len() >= 8, "single and batch rows are there");
        let mut batches = 0;
        for row in valid {
            let name = row["name"].as_str().expect("name");
            let bytes = hex_bytes(row["callData"].as_str().expect("callData")).expect("hex");
            let calls = calls_of(row);
            assert_eq!(
                decode(&bytes).as_ref(),
                Ok(&calls),
                "{name}: decodes to the app's calls"
            );
            assert_eq!(encode(&calls), bytes, "{name}: encodes to the app's bytes");
            batches += usize::from(calls.len() > 1);
        }
        assert!(batches >= 3, "batches are in the vectors");
        for row in vectors["invalid"].as_array().expect("invalid rows") {
            let name = row["name"].as_str().expect("name");
            let text = row["callData"].as_str().expect("callData");
            let refused = match hex_bytes(text) {
                Some(bytes) => decode(&bytes).is_err(),
                None => true,
            };
            assert!(refused, "{name}: refused as the app refuses it");
        }
    }

    /// The two exit selectors are computed from the signatures and equal the generated ABI of the Treasury; the
    /// signatures in this file are the ABI's, parameter by parameter.
    #[test]
    fn the_exit_selectors_are_the_generated_abis() {
        let abi_file =
            include_str!("../../../../../packages/creaton-core/src/pot/abis.generated.ts");
        let treasury = abi_file
            .split("export const TREASURY_ABI")
            .nth(1)
            .and_then(|rest| rest.split("] as const").next())
            .expect("the Treasury ABI");
        let signature_in_abi = |name: &str| -> String {
            let line = treasury
                .lines()
                .find(|l| l.contains(&format!("\"type\":\"function\",\"name\":\"{name}\"")))
                .unwrap_or_else(|| panic!("{name} is in the ABI"));
            let json = line.trim().trim_end_matches(',');
            let item: Value = serde_json::from_str(json).expect("an ABI item");
            let types: Vec<&str> = item["inputs"]
                .as_array()
                .expect("inputs")
                .iter()
                .map(|i| i["type"].as_str().expect("type"))
                .collect();
            format!("{name}({})", types.join(","))
        };
        assert_eq!(signature_in_abi("leave"), LEAVE_SIGNATURE);
        assert_eq!(signature_in_abi("leaveTeam"), LEAVE_TEAM_SIGNATURE);
        // The selectors the app encodes with appear at the start of its own take-out call data.
        let vectors = vectors();
        let by_name = |name: &str| {
            let row = vectors["valid"]
                .as_array()
                .expect("rows")
                .iter()
                .find(|r| r["name"] == name)
                .unwrap_or_else(|| panic!("the vectors have {name}"));
            calls_of(row).remove(0)
        };
        assert_eq!(
            by_name("a take out").selector(),
            Some(selector(LEAVE_SIGNATURE))
        );
        assert_eq!(
            by_name("a take out of Team Shares").selector(),
            Some(selector(LEAVE_TEAM_SIGNATURE))
        );
        assert_ne!(selector(LEAVE_SIGNATURE), selector(LEAVE_TEAM_SIGNATURE));
    }

    #[test]
    fn an_exit_is_only_leave_and_leave_team_on_a_followed_treasury_with_no_value() {
        let vectors = vectors();
        let rows = |name: &str| {
            calls_of(
                vectors["valid"]
                    .as_array()
                    .expect("rows")
                    .iter()
                    .find(|r| r["name"] == name)
                    .unwrap_or_else(|| panic!("the vectors have {name}")),
            )
        };
        let treasury = rows("a take out")[0].to;
        let followed = [treasury];
        assert!(is_exit(&rows("a take out"), &followed, &[]));
        assert!(is_exit(&rows("a take out of Team Shares"), &followed, &[]));
        assert!(
            is_exit(&rows("two take outs in one batch"), &followed, &[]),
            "all calls are exits"
        );
        assert!(
            !is_exit(
                &rows("a take out and something else in one batch"),
                &followed,
                &[]
            ),
            "one call that is not an exit makes the whole operation not one"
        );
        assert!(!is_exit(&rows("a single call with data"), &followed, &[]));
        assert!(
            !is_exit(&rows("a take out"), &[], &[]),
            "a treasury this reader does not follow"
        );
        assert!(!is_exit(&rows("a take out"), &[[7u8; 20]], &[]));
        assert!(
            !is_exit(&[], &followed, &[]),
            "an operation of no calls is not an exit"
        );
        let mut with_value = rows("a take out");
        with_value[0].value[31] = 1;
        assert!(
            !is_exit(&with_value, &followed, &[]),
            "a call that sends value is not an exit"
        );
        let mut other_function = rows("a take out");
        other_function[0].data[0] ^= 0xff;
        assert!(!is_exit(&other_function, &followed, &[]));
        let mut short = rows("a take out");
        short[0].data.truncate(3);
        assert!(
            !is_exit(&short, &followed, &[]),
            "call data too short to hold a selector"
        );
    }

    fn unpark(to: [u8; 20], value: u8) -> Call {
        let mut data = selector(UNPARK_SIGNATURE).to_vec();
        data.extend_from_slice(&[0u8; 31]);
        data.push(value);
        Call {
            to,
            value: [0u8; 32],
            data,
        }
    }

    /// A holder whose Shares are parked takes out in one press that takes them back first: `[unpark, leave]` is an
    /// exit and is never charged; `[unpark]` alone, a second `unpark` of one pause, an `unpark` of a pause this reader
    /// does not follow, one that sends value, and one with extra data are not. (Guard: `is_exit`'s pause rule.)
    #[test]
    fn an_unpark_before_a_take_out_is_part_of_the_exit_and_an_unpark_alone_is_not() {
        let vectors = vectors();
        let leave = calls_of(
            vectors["valid"]
                .as_array()
                .expect("rows")
                .iter()
                .find(|r| r["name"] == "a take out")
                .expect("the vectors have a take out"),
        )
        .remove(0);
        let (treasuries, pause, other) = ([leave.to], [0x55u8; 20], [0x66u8; 20]);
        let pauses = [pause];
        assert!(is_exit(
            &[unpark(pause, 5), leave.clone()],
            &treasuries,
            &pauses
        ));
        assert!(
            !is_exit(&[unpark(pause, 5)], &treasuries, &pauses),
            "an unpark alone moves no money out and is not an exit"
        );
        assert!(
            !is_exit(
                &[unpark(pause, 5), unpark(pause, 6), leave.clone()],
                &treasuries,
                &pauses
            ),
            "two unparks of one pause"
        );
        assert!(
            !is_exit(&[unpark(other, 5), leave.clone()], &treasuries, &pauses),
            "a pause this reader does not follow"
        );
        assert!(!is_exit(
            &[unpark(pause, 5), leave.clone()],
            &treasuries,
            &[]
        ));
        let mut with_value = unpark(pause, 5);
        with_value.value[31] = 1;
        assert!(!is_exit(&[with_value, leave.clone()], &treasuries, &pauses));
        let mut long = unpark(pause, 5);
        long.data.push(0);
        assert!(!is_exit(&[long, leave.clone()], &treasuries, &pauses));
        // Another function of the pause is not an exit's call.
        let mut park = unpark(pause, 5);
        park.data[..4].copy_from_slice(&selector("park(uint256)"));
        assert!(!is_exit(&[park, leave], &treasuries, &pauses));
    }

    #[test]
    fn call_data_that_is_not_the_apps_shape_is_refused() {
        assert_eq!(decode(&[]), Err(DecodeError::WrongFunction));
        assert_eq!(decode(&[1, 2, 3, 4, 5]), Err(DecodeError::WrongFunction));
        let call = Call {
            to: [3u8; 20],
            value: [0u8; 32],
            data: vec![1, 2, 3],
        };
        let good = encode(std::slice::from_ref(&call));
        assert_eq!(decode(&good), Ok(vec![call.clone()]));
        let mut extra = good.clone();
        extra.push(0);
        assert!(decode(&extra).is_err());
        let mut dirty = good.clone();
        let last = dirty.len() - 1;
        dirty[last] = 9;
        assert_eq!(decode(&dirty), Err(DecodeError::NotCanonical));
        let mut mode = good.clone();
        mode[4] = 7;
        assert_eq!(decode(&mode), Err(DecodeError::UnknownMode));
        assert!(decode(&good[..good.len() - 1]).is_err());
        // A batch of none, and of too many.
        let many = vec![call.clone(); BATCH_MAX + 1];
        assert!(decode(&encode(&many)).is_err());
        assert_eq!(
            decode(&encode(&vec![call.clone(); BATCH_MAX])).map(|c| c.len()),
            Ok(BATCH_MAX)
        );
        assert_eq!(decode(&encode(&[])), Err(DecodeError::BadCount));
    }
}
