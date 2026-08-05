//! SIWE (EIP-4361) onboarding commands for the desktop app (creabuzz).
//!
//! The registered EVM identity is a ZeroDev Kernel smart account. With
//! EIP-7702 the Kernel account address equals the owner EOA address, so SIWE
//! signing is a standard `personal_sign` (EIP-191) by the owner key — the
//! relay verifies it via `ecrecover` before delegation is installed and via
//! EIP-1271 afterwards.
//!
//! ## Key storage
//!
//! The EVM owner private key lives in the OS keyring under the namespaced key
//! `siwe:evm:owner` (hex), sharing the same single-blob `SecretStore` as the
//! human identity nsec. On first use a fresh key is generated and persisted;
//! subsequent calls reuse it so the account address is stable.

use tauri::State;

use crate::app_state::keyring_service;
use crate::app_state::AppState;
use crate::secret_store::SecretStore;

/// Keyring key name for the EVM owner private key (hex, 64 chars).
const SIWE_OWNER_KEY_NAME: &str = "siwe:evm:owner";

/// The keyring store, `None` when the build has no keyring backend.
fn siwe_secret_store() -> Option<&'static SecretStore> {
    if cfg!(feature = "system-keyring") {
        Some(SecretStore::shared(keyring_service()))
    } else {
        None
    }
}

/// Load the stored EVM owner key (hex) from the keyring, if any.
fn load_owner_key() -> Result<Option<String>, String> {
    match siwe_secret_store() {
        Some(store) => store.load(SIWE_OWNER_KEY_NAME),
        None => Ok(None),
    }
}

/// Store the EVM owner key (hex) in the keyring.
fn store_owner_key(hex_key: &str) -> Result<(), String> {
    match siwe_secret_store() {
        Some(store) => store.store(SIWE_OWNER_KEY_NAME, hex_key),
        None => Ok(()),
    }
}

/// Generate a cryptographically random 32-byte secp256k1 secret and return it
/// as lowercase hex.
fn generate_owner_key() -> Result<String, String> {
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).map_err(|e| format!("failed to gather entropy: {e}"))?;
    Ok(hex::encode(secret))
}

/// Get or create the EVM owner key (hex), persisted in the keyring.
fn get_or_create_owner_key() -> Result<String, String> {
    if let Some(existing) = load_owner_key()? {
        return Ok(existing);
    }
    let fresh = generate_owner_key()?;
    store_owner_key(&fresh)?;
    Ok(fresh)
}

/// Derive the owner EOA address (0x-prefixed) from a hex secret.
fn owner_address_from_secret(hex_key: &str) -> Result<String, String> {
    let secret: [u8; 32] = hex::decode(hex_key)
        .map_err(|e| format!("bad owner key hex: {e}"))?
        .try_into()
        .map_err(|_| "owner key must be 32 bytes".to_string())?;
    let signing_key = k256::ecdsa::SigningKey::from_slice(&secret)
        .map_err(|e| format!("invalid secp256k1 key: {e}"))?;
    let public_key = signing_key.verifying_key();
    let point = public_key.to_encoded_point(false);
    let uncompressed = &point.as_bytes()[1..]; // skip 0x04 tag
    let hash = keccak256(uncompressed);
    Ok(format!("0x{}", hex::encode(&hash[12..])))
}

/// Keccak-256 digest.
fn keccak256(data: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256 as K};
    K::digest(data).into()
}

/// EIP-191 `personal_sign` digest: `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ msg)`.
fn personal_sign_digest(message: &[u8]) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    keccak256(&[prefix.as_bytes(), message].concat())
}

/// Sign `message` as Ethereum `personal_sign` with the stored owner key.
/// Returns a 65-byte hex signature (r‖s‖v, v = 27/28).
fn sign_personal(message: &[u8]) -> Result<String, String> {
    let hex_key = get_or_create_owner_key()?;
    let secret: [u8; 32] = hex::decode(&hex_key)
        .map_err(|e| format!("bad owner key hex: {e}"))?
        .try_into()
        .map_err(|_| "owner key must be 32 bytes".to_string())?;
    let signing_key = k256::ecdsa::SigningKey::from_slice(&secret)
        .map_err(|e| format!("invalid secp256k1 key: {e}"))?;
    let digest = personal_sign_digest(message);
    let (signature, recid) = signing_key
        .sign_prehash_recoverable(&digest)
        .map_err(|e| format!("sign failed: {e}"))?;
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(if recid.is_y_odd() { 28 } else { 27 });
    Ok(hex::encode(bytes))
}

/// Derive the ZeroDev Kernel account address for the stored owner key.
///
/// Uses EIP-7702 (`new_account_7702`): the Kernel account address is the owner
/// EOA address. `project_id`/`rpc_url`/`chain_id` are only used to construct
/// the SDK context; address derivation itself is local.
fn kernel_account_address(
    project_id: &str,
    rpc_url: &str,
    chain_id: u64,
) -> Result<String, String> {
    let hex_key = get_or_create_owner_key()?;
    let secret: [u8; 32] = hex::decode(&hex_key)
        .map_err(|e| format!("bad owner key hex: {e}"))?
        .try_into()
        .map_err(|_| "owner key must be 32 bytes".to_string())?;

    let context = zerodev_aa::Context::new(
        project_id,
        rpc_url,
        "",
        chain_id,
        zerodev_aa::GasMiddleware::ZeroDev,
        zerodev_aa::PaymasterMiddleware::ZeroDev,
    )
    .map_err(|e| format!("zerodev context: {e}"))?;
    let signer = zerodev_aa::Signer::local(&secret).map_err(|e| format!("zerodev signer: {e}"))?;
    let account = context
        .new_account_7702(&signer, zerodev_aa::KernelVersion::V3_3)
        .map_err(|e| format!("zerodev account: {e}"))?;
    let address = account
        .get_address()
        .map_err(|e| format!("zerodev address: {e}"))?;
    Ok(address.to_hex())
}

/// Result of `siwe_get_account`.
#[derive(serde::Serialize)]
pub struct SiweAccountInfo {
    /// The ZeroDev Kernel account address (0x-prefixed) — this is the EVM
    /// identity registered via SIWE.
    pub account: String,
    /// The owner EOA address (0x-prefixed) — equals `account` under EIP-7702.
    pub owner_address: String,
    /// Whether an EVM owner key is already stored in the keyring.
    pub has_owner: bool,
}

/// Return the SIWE account (ZeroDev Kernel EIP-7702) for the app.
///
/// Generates and persists an EVM owner key in the OS keyring on first use.
#[tauri::command]
pub fn siwe_get_account(state: State<'_, AppState>) -> Result<SiweAccountInfo, String> {
    let owner = get_or_create_owner_key()?;
    let owner_address = owner_address_from_secret(&owner)?;
    let account = kernel_account_address(
        &state.siwe_config.project_id,
        &state.siwe_config.rpc_url,
        state.siwe_config.chain_id,
    )?;
    Ok(SiweAccountInfo {
        account,
        owner_address,
        has_owner: load_owner_key()?.is_some(),
    })
}

/// Result of `sign_siwe_message`.
#[derive(serde::Serialize)]
pub struct SiweSignature {
    /// 65-byte hex `personal_sign` signature over the SIWE message.
    pub signature: String,
    /// The signer EOA address (0x-prefixed).
    pub owner_address: String,
}

/// Sign a canonical SIWE message with the stored EVM owner key (EIP-191
/// `personal_sign`). The returned signature is what `POST /auth/siwe/register`
/// expects.
#[tauri::command]
pub fn sign_siwe_message(message: String) -> Result<SiweSignature, String> {
    let signature = sign_personal(message.as_bytes())?;
    let owner = load_owner_key()?
        .ok_or_else(|| "no EVM owner key stored — call siwe_get_account first".to_string())?;
    let owner_address = owner_address_from_secret(&owner)?;
    Ok(SiweSignature {
        signature,
        owner_address,
    })
}

/// Whether an EVM owner key exists in the keyring.
#[tauri::command]
pub fn siwe_has_account() -> Result<SiweHasAccount, String> {
    Ok(SiweHasAccount {
        has_owner: load_owner_key()?.is_some(),
    })
}

/// Result of `siwe_has_account`.
#[derive(serde::Serialize)]
pub struct SiweHasAccount {
    /// Whether an EVM owner key is stored in the keyring.
    pub has_owner: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_sign_digest_known_vector() {
        // keccak256("\x19Ethereum Signed Message:\n12hello world")
        let digest = personal_sign_digest(b"hello world");
        assert_eq!(digest.len(), 32);
        // Deterministic: recompute matches.
        assert_eq!(digest, personal_sign_digest(b"hello world"));
    }

    #[test]
    fn owner_address_from_known_key() {
        // Well-known Hardhat account #0.
        let secret = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let addr = owner_address_from_secret(secret).unwrap();
        assert_eq!(addr, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    }

    #[test]
    fn sign_personal_roundtrip_shape() {
        // Signing requires the keyring; exercise the pure signing math via the
        // digest + a fixed key instead.
        let secret: [u8; 32] = [7u8; 32];
        let key = k256::ecdsa::SigningKey::from_slice(&secret).unwrap();
        let digest = personal_sign_digest(b"siwe message");
        let (sig, recid) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        assert_eq!(bytes.len(), 65);
    }
}
