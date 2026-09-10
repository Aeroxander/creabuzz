//! Async, RPC-backed signature verification for smart accounts.
//!
//! Extends [`crate::verifier`] with EIP-1271 (deployed accounts) and EIP-6492
//! (counterfactual accounts via a universal validator singleton). Unlike the
//! hermetic [`crate::verifier::EoaVerifier`], this module talks to an EVM
//! node over JSON-RPC and lives behind the `rpc` Cargo feature.
//!
//! ## Verification order (mirrors EIP-6492 §Verifier side)
//!
//! 1. If the signature is ERC-6492-wrapped and a validator singleton is
//!    configured, call `validator.isValidSig(signer, hash, wrappedSignature)`
//!    — the singleton performs the factory deployment and `isValidSignature`
//!    atomically.
//! 2. Else, if the account has code, call `account.isValidSignature` (EIP-1271).
//! 3. Else fall back to offline `ecrecover` (EOA).
//!
//! The [`JsonRpc`] trait is the seam that keeps unit tests off a live node: a
//! mock implementing it exercises all three branches deterministically.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::erc6492::{
    decode_bytes4_return, encode_is_valid_sig, encode_is_valid_signature, is_erc6492_wrapped,
    ERC1271_SUCCESS,
};
use crate::error::EvmAuthError;
use crate::siwe::{personal_sign_digest, recover_address};
use crate::EvmAddress;

/// Minimal Ethereum JSON-RPC surface needed for signature verification.
#[async_trait::async_trait]
pub trait JsonRpc: Send + Sync {
    /// `eth_getCode` — return the runtime bytecode at an address.
    async fn eth_get_code(&self, address: &EvmAddress) -> Result<Vec<u8>, EvmAuthError>;
    /// `eth_call` — execute a call against `to` with `data` and return the
    /// raw return data.
    async fn eth_call(&self, to: &EvmAddress, data: &[u8]) -> Result<Vec<u8>, EvmAuthError>;
}

/// JSON-RPC transport over an HTTP endpoint (`http(s)://…`).
pub struct HttpJsonRpc {
    client: reqwest::Client,
    url: String,
}

impl HttpJsonRpc {
    /// Build a transport for a bare node URL (e.g. `$BUZZ_ETH_RPC_URL`).
    pub fn new(url: &str) -> Self {
        Self {
            client: reqwest::Client::new(),
            url: url.to_string(),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, EvmAuthError> {
        let resp = self
            .client
            .post(&self.url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params,
            }))
            .send()
            .await
            .map_err(|e| EvmAuthError::Rpc(format!("transport: {e}")))?;
        let body: Value = resp
            .json()
            .await
            .map_err(|e| EvmAuthError::Rpc(format!("bad response: {e}")))?;
        if let Some(err) = body.get("error") {
            return Err(EvmAuthError::Rpc(format!("{err}")));
        }
        body.get("result")
            .cloned()
            .ok_or_else(|| EvmAuthError::Rpc("missing result".into()))
    }
}

#[async_trait::async_trait]
impl JsonRpc for HttpJsonRpc {
    async fn eth_get_code(&self, address: &EvmAddress) -> Result<Vec<u8>, EvmAuthError> {
        let hex = self
            .call("eth_getCode", json!([address.to_hex(), "latest"]))
            .await?
            .as_str()
            .ok_or_else(|| EvmAuthError::Rpc("eth_getCode returned non-string".into()))?
            .to_string();
        let strip = hex.strip_prefix("0x").unwrap_or(&hex);
        hex::decode(strip).map_err(|e| EvmAuthError::Rpc(format!("eth_getCode hex: {e}")))
    }

    async fn eth_call(&self, to: &EvmAddress, data: &[u8]) -> Result<Vec<u8>, EvmAuthError> {
        let tx = json!({
            "to": to.to_hex(),
            "data": format!("0x{}", hex::encode(data)),
        });
        let hex = self
            .call("eth_call", json!([tx, "latest"]))
            .await?
            .as_str()
            .ok_or_else(|| EvmAuthError::Rpc("eth_call returned non-string".into()))?
            .to_string();
        let strip = hex.strip_prefix("0x").unwrap_or(&hex);
        hex::decode(strip).map_err(|e| EvmAuthError::Rpc(format!("eth_call hex: {e}")))
    }
}

/// RPC-backed verifier for smart (and EOA) accounts.
#[derive(Clone)]
pub struct RpcSignatureVerifier {
    rpc: Arc<dyn JsonRpc>,
    /// Optional ERC-6492 universal validator singleton address. Required to
    /// validate counterfactual (undeployed) accounts.
    erc6492_validator: Option<EvmAddress>,
}

impl RpcSignatureVerifier {
    /// Build a verifier from a bare RPC URL.
    pub fn new(url: &str) -> Self {
        Self {
            rpc: Arc::new(HttpJsonRpc::new(url)),
            erc6492_validator: None,
        }
    }

    /// Attach an ERC-6492 universal validator singleton for counterfactual
    /// (predeploy) signatures.
    pub fn with_erc6492_validator(mut self, validator: EvmAddress) -> Self {
        self.erc6492_validator = Some(validator);
        self
    }

    /// Inject a transport for tests.
    pub fn from_transport(rpc: Arc<dyn JsonRpc>) -> Self {
        Self {
            rpc,
            erc6492_validator: None,
        }
    }

    /// Verify a signed `message` claims control of `address`. Mirrors the
    /// EIP-6492 §Verifier side ordering with an EOA fallback.
    pub async fn verify_personal_sign(
        &self,
        address: &EvmAddress,
        message: &[u8],
        signature_hex: &str,
    ) -> Result<bool, EvmAuthError> {
        let hex_str = signature_hex.strip_prefix("0x").unwrap_or(signature_hex);
        let sig = hex::decode(hex_str)
            .map_err(|e| EvmAuthError::InvalidSignature(format!("not hex: {e}")))?;
        let digest = personal_sign_digest(message);
        self.verify_digest(address, &digest, &sig).await
    }

    /// Core: verify `digest` is genuinely signed for `address` by `sig`.
    async fn verify_digest(
        &self,
        address: &EvmAddress,
        digest: &[u8; 32],
        sig: &[u8],
    ) -> Result<bool, EvmAuthError> {
        // 1a. Counterfactual wrapper → universal validator singleton.
        if is_erc6492_wrapped(sig) {
            if let Some(validator) = self.erc6492_validator {
                let data = encode_is_valid_sig(address, digest, sig);
                let ret = self.rpc.eth_call(&validator, &data).await?;
                return self.parse_bool_return(&ret);
            }
            // Wrapped but no validator configured: cannot deploy/validate.
            return Err(EvmAuthError::Rpc(
                "erc6492 signature but no erc6492_validator configured".into(),
            ));
        }

        let code = self.rpc.eth_get_code(address).await?;

        // 2. Deployed account → EIP-1271 `isValidSignature`.
        if !code.is_empty() {
            let data = encode_is_valid_signature(digest, sig);
            let ret = self.rpc.eth_call(address, &data).await?;
            let magic = decode_bytes4_return(&ret)?;
            return Ok(magic == ERC1271_SUCCESS);
        }

        // 3. No code → EOA `ecrecover` requires a 65-byte r‖s‖v signature.
        let sig_65: [u8; 65] = sig
            .try_into()
            .map_err(|_| EvmAuthError::InvalidSignature("expected 65-byte signature".into()))?;
        let recovered = recover_address(digest, &sig_65)?;
        Ok(&recovered == address)
    }

    fn parse_bool_return(&self, data: &[u8]) -> Result<bool, EvmAuthError> {
        if data.is_empty() {
            return Ok(false);
        }
        // The universal validator returns a single byte [0x00 | 0x01] carrying
        // the result (EIP-6492 `isValidSig` reverts with a minimum-length
        // payload). Accept either a packed byte or a 32-byte ABI bool.
        match data[0] {
            1 => Ok(true),
            0 => Ok(false),
            _ => Err(EvmAuthError::Rpc(format!(
                "unexpected validator return byte 0x{:02x}",
                data[0]
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::siwe::personal_sign_digest;
    use k256::ecdsa::SigningKey;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct MockRpc {
        // (has_code, validated) per configured scenario.
        code: Mutex<Vec<Vec<u8>>>,
        call_results: Mutex<Vec<Vec<u8>>>,
        calls: AtomicUsize,
    }

    impl MockRpc {
        fn new(code: Vec<Vec<u8>>, call_results: Vec<Vec<u8>>) -> Self {
            Self {
                code: Mutex::new(code),
                call_results: Mutex::new(call_results),
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl JsonRpc for MockRpc {
        async fn eth_get_code(&self, _address: &EvmAddress) -> Result<Vec<u8>, EvmAuthError> {
            let mut c = self.code.lock().unwrap();
            Ok(if c.is_empty() {
                Vec::new()
            } else {
                c.remove(0)
            })
        }

        async fn eth_call(&self, _to: &EvmAddress, _data: &[u8]) -> Result<Vec<u8>, EvmAuthError> {
            let mut c = self.call_results.lock().unwrap();
            self.calls.fetch_add(1, Ordering::SeqCst);
            if c.is_empty() {
                Ok(Vec::new())
            } else {
                Ok(c.remove(0))
            }
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_slice(&[7u8; 32]).unwrap()
    }
    fn addr() -> EvmAddress {
        EvmAddress::from_verifying_key(key().verifying_key())
    }
    fn eoa_sig(msg: &[u8]) -> String {
        let d = personal_sign_digest(msg);
        let (sig, recid) = key().sign_prehash_recoverable(&d).unwrap();
        let mut b = sig.to_bytes().to_vec();
        b.push(if recid.is_y_odd() { 28 } else { 27 });
        hex::encode(b)
    }

    #[test]
    fn eoa_verifies_offline_when_no_code() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let rpc = MockRpc::new(vec![Vec::new()], vec![]);
            let v = RpcSignatureVerifier::from_transport(Arc::new(rpc));
            let msg = b"hello world";
            let res = v
                .verify_personal_sign(&addr(), msg, &eoa_sig(msg))
                .await
                .unwrap();
            assert!(res);
        });
    }

    #[test]
    fn eoa_rejects_wrong_account_when_no_code() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let rpc = MockRpc::new(vec![Vec::new()], vec![]);
            let v = RpcSignatureVerifier::from_transport(Arc::new(rpc));
            let msg = b"hello world";
            let other = EvmAddress::from_bytes([1u8; 20]);
            let res = v
                .verify_personal_sign(&other, msg, &eoa_sig(msg))
                .await
                .unwrap();
            assert!(!res);
        });
    }

    #[test]
    fn deployed_account_uses_eip1271() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Account has code; isValidSignature returns success magic.
            let magic = [0x16u8, 0x26, 0xba, 0x7e];
            let rpc = MockRpc::new(
                vec![vec![0x60u8; 4]], // nonzero code
                vec![magic.to_vec()],
            );
            let v = RpcSignatureVerifier::from_transport(Arc::new(rpc));
            let msg = b"logged in";
            let res = v
                .verify_personal_sign(&addr(), msg, &eoa_sig(msg))
                .await
                .unwrap();
            assert!(res);
        });
    }

    #[test]
    fn deployed_account_rejects_wrong_return() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let rpc = MockRpc::new(vec![vec![0x60u8; 4]], vec![[0x00u8; 4].to_vec()]);
            let v = RpcSignatureVerifier::from_transport(Arc::new(rpc));
            let msg = b"logged in";
            let res = v
                .verify_personal_sign(&addr(), msg, &eoa_sig(msg))
                .await
                .unwrap();
            assert!(!res);
        });
    }

    #[test]
    fn counterfactual_requires_validator() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut wrapped = vec![0x30u8; 40];
            wrapped.extend_from_slice(&crate::erc6492::ERC6492_DETECTION_SUFFIX);
            let rpc = MockRpc::new(vec![], vec![]);
            let v = RpcSignatureVerifier::from_transport(Arc::new(rpc));
            let res = v
                .verify_personal_sign(&addr(), b"hi", &hex::encode(&wrapped))
                .await;
            assert!(matches!(res, Err(EvmAuthError::Rpc(_))));
        });
    }

    #[test]
    fn counterfactual_through_validator_singleton() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut wrapped = vec![0x30u8; 40];
            wrapped.extend_from_slice(&crate::erc6492::ERC6492_DETECTION_SUFFIX);
            let rpc = MockRpc::new(vec![], vec![[0x01u8].to_vec()]);
            let v = RpcSignatureVerifier::from_transport(Arc::new(rpc))
                .with_erc6492_validator(EvmAddress::from_bytes([0xfeu8; 20]));
            let res = v
                .verify_personal_sign(&addr(), b"hi", &hex::encode(&wrapped))
                .await
                .unwrap();
            assert!(res);
        });
    }
}
