//! EIP-712 `NostrSigner` attestation: an EVM account authorizes a Nostr
//! signer keypair ("Design 2" in `docs/protocol-strategy.md`).
//!
//! The attestation digest is fully offline to compute and verify (EOA via
//! `ecrecover`). Smart-account accounts verify the same digest through
//! EIP-1271 (`SignatureVerifier`, RPC-backed implementation planned).

use crate::address::{keccak256, EvmAddress};
use crate::error::EvmAuthError;
use crate::siwe::recover_address;

/// EIP-712 domain for creabuzz attestations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Eip712Domain {
    /// Human-readable protocol name (e.g. `"creabuzz"`).
    pub name: String,
    /// Version string (e.g. `"1"`).
    pub version: String,
    /// EIP-155 chain id the attestation is valid on.
    pub chain_id: u64,
    /// Verifying contract (use the zero address while attestations are
    /// offchain-only).
    pub verifying_contract: EvmAddress,
}

/// An authorization binding an EVM account to a Nostr signer pubkey.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NostrSignerAttestation {
    /// EVM account granting the authorization (the identity root).
    pub account: EvmAddress,
    /// Nostr public key (x-only, 32 bytes) authorized to sign events.
    pub npub: [u8; 32],
    /// Unix timestamp after which the attestation is invalid.
    pub expires: u64,
    /// Replay-protection nonce (per account).
    pub nonce: u64,
}

/// EIP-712 type string for the attestation struct.
const TYPE_STRING: &str = "NostrSigner(address account,bytes32 npub,uint256 expires,uint256 nonce)";
/// EIP-712 type string for the domain struct.
const DOMAIN_TYPE_STRING: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

impl Eip712Domain {
    /// `keccak256` of the ABI-encoded domain struct.
    pub fn separator(&self) -> [u8; 32] {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&keccak256(DOMAIN_TYPE_STRING.as_bytes()));
        encoded.extend_from_slice(&keccak256(self.name.as_bytes()));
        encoded.extend_from_slice(&keccak256(self.version.as_bytes()));
        encoded.extend_from_slice(&u256(self.chain_id));
        encoded.extend_from_slice(&self.verifying_contract.to_word());
        keccak256(&encoded)
    }
}

impl NostrSignerAttestation {
    /// `keccak256` of the ABI-encoded struct.
    pub fn struct_hash(&self) -> [u8; 32] {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&keccak256(TYPE_STRING.as_bytes()));
        encoded.extend_from_slice(&self.account.to_word());
        encoded.extend_from_slice(&self.npub);
        encoded.extend_from_slice(&u256(self.expires));
        encoded.extend_from_slice(&u256(self.nonce));
        keccak256(&encoded)
    }

    /// Full EIP-712 digest: `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`.
    pub fn digest(&self, domain: &Eip712Domain) -> [u8; 32] {
        let mut data = Vec::with_capacity(2 + 64);
        data.extend_from_slice(b"\x19\x01");
        data.extend_from_slice(&domain.separator());
        data.extend_from_slice(&self.struct_hash());
        keccak256(&data)
    }

    /// Verify a 65-byte hex signature over the attestation digest and require
    /// the recovered signer to be `account`.
    pub fn verify(&self, domain: &Eip712Domain, signature_hex: &str) -> Result<(), EvmAuthError> {
        let sig = crate::siwe::parse_signature(signature_hex)?;
        let recovered = recover_address(&self.digest(domain), &sig)?;
        if recovered != self.account {
            return Err(EvmAuthError::SignerMismatch {
                expected: self.account.to_hex(),
                got: recovered.to_hex(),
            });
        }
        Ok(())
    }

    /// Whether the attestation is expired at `now` (unix seconds).
    pub fn is_expired(&self, now: u64) -> bool {
        self.expires < now
    }
}

/// A signed, stored attestation: the EIP-712 struct + domain + 65-byte hex
/// signature. This is the JSON shape persisted in `evm_identities.attestation`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AttestationEnvelope {
    /// The authorized signing relationship.
    pub attestation: NostrSignerAttestation,
    /// The EIP-712 domain the attestation was signed under.
    pub domain: Eip712Domain,
    /// 65-byte hex signature over the attestation digest.
    pub signature: String,
}

impl AttestationEnvelope {
    /// Verify the signature, expiry, and that the authorized npub matches the
    /// publishing device key. Returns the EVM account that granted it.
    pub fn verify_for_npub(&self, npub_hex: &str, now: u64) -> Result<EvmAddress, EvmAuthError> {
        if self.attestation.is_expired(now) {
            return Err(EvmAuthError::Expired);
        }
        if hex::encode(self.attestation.npub) != npub_hex {
            return Err(EvmAuthError::SignerMismatch {
                expected: npub_hex.to_string(),
                got: hex::encode(self.attestation.npub),
            });
        }
        self.attestation.verify(&self.domain, &self.signature)?;
        Ok(self.attestation.account)
    }
}

#[cfg(feature = "rpc")]
impl AttestationEnvelope {
    /// Verify the signature of an account that is a **contract** (a smart account signs through EIP-1271, so there
    /// is no `ecrecover` to do): the account itself is asked, through `verifier`, whether `signature` is valid over
    /// the attestation digest. Expiry and the npub are not looked at here; see [`Self::verify_for_npub_contract`].
    pub async fn verify_contract_signature(
        &self,
        verifier: &crate::rpc::RpcSignatureVerifier,
    ) -> Result<(), EvmAuthError> {
        let hex_part = self.signature.strip_prefix("0x").unwrap_or(&self.signature);
        let signature = hex::decode(hex_part)
            .map_err(|e| EvmAuthError::InvalidSignature(format!("not hex: {e}")))?;
        let digest = self.attestation.digest(&self.domain);
        if verifier
            .verify_hash(&self.attestation.account, &digest, &signature)
            .await?
        {
            Ok(())
        } else {
            Err(EvmAuthError::InvalidSignature(
                "the account did not accept the signature".into(),
            ))
        }
    }

    /// [`Self::verify_for_npub`] for a contract account: expiry, the npub, and then the account's own answer.
    /// Expiry and the npub are checked first, so a stale or misdirected proof never costs a network call.
    pub async fn verify_for_npub_contract(
        &self,
        verifier: &crate::rpc::RpcSignatureVerifier,
        npub_hex: &str,
        now: u64,
    ) -> Result<EvmAddress, EvmAuthError> {
        if self.attestation.is_expired(now) {
            return Err(EvmAuthError::Expired);
        }
        if hex::encode(self.attestation.npub) != npub_hex {
            return Err(EvmAuthError::SignerMismatch {
                expected: npub_hex.to_string(),
                got: hex::encode(self.attestation.npub),
            });
        }
        self.verify_contract_signature(verifier).await?;
        Ok(self.attestation.account)
    }
}

/// ABI-encode a `uint256` from a `u64` (32-byte big-endian).
fn u256(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    fn test_domain() -> Eip712Domain {
        Eip712Domain {
            name: "creabuzz".into(),
            version: "1".into(),
            chain_id: 8453,
            verifying_contract: EvmAddress::from_bytes([0u8; 20]),
        }
    }

    fn attestation_for(key: &SigningKey) -> NostrSignerAttestation {
        NostrSignerAttestation {
            account: EvmAddress::from_verifying_key(key.verifying_key()),
            npub: [42u8; 32],
            expires: 1_800_000_000,
            nonce: 0,
        }
    }

    fn sign_attestation(key: &SigningKey, att: &NostrSignerAttestation) -> String {
        let digest = att.digest(&test_domain());
        let (sig, recid) = key.sign_prehash_recoverable(&digest);
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        hex::encode(bytes)
    }

    #[test]
    fn verify_roundtrip() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        att.verify(&test_domain(), &sig).unwrap();
    }

    #[test]
    fn verify_rejects_wrong_signer() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        // Signed by `key`, but `account` is `other`'s address.
        let att = attestation_for(&other);
        let sig = sign_attestation(&key, &att);
        assert!(matches!(
            att.verify(&test_domain(), &sig),
            Err(EvmAuthError::SignerMismatch { .. })
        ));
    }

    #[test]
    fn verify_rejects_tampered_npub() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let tampered = NostrSignerAttestation {
            npub: [43u8; 32],
            ..att
        };
        assert!(tampered.verify(&test_domain(), &sig).is_err());
    }

    #[test]
    fn digest_is_domain_separated() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let other_chain = Eip712Domain {
            chain_id: 1,
            ..test_domain()
        };
        assert!(att.verify(&other_chain, &sig).is_err());
    }

    #[test]
    fn envelope_roundtrip_json() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: AttestationEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env);
        assert_eq!(back.signature, sig);
    }

    #[test]
    fn envelope_verifies_for_correct_npub() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        let now = 1_800_000_100; // after expires in attestation_for
                                 // attestation_for uses expires 1_800_000_000; now slightly after → expired.
        assert!(env.verify_for_npub(&hex::encode(att.npub), now).is_err());
        // Before expiry, correct npub verifies.
        let now_ok = 1_700_000_000;
        let account = env.verify_for_npub(&hex::encode(att.npub), now_ok).unwrap();
        assert_eq!(account, att.account);
    }

    #[test]
    fn envelope_rejects_wrong_npub() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        // Attestation authorizes npub = [42u8; 32]; presenting a different npub
        // must fail.
        let wrong = hex::encode([43u8; 32]);
        assert_ne!(wrong, hex::encode(att.npub));
        assert!(env.verify_for_npub(&wrong, 1_700_000_000).is_err());
    }

    #[test]
    fn envelope_rejects_bad_signature() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let att = attestation_for(&other);
        // Signed by `key`, but account is `other` → mismatch.
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        assert!(env
            .verify_for_npub(&hex::encode(att.npub), 1_700_000_000)
            .is_err());
    }

    #[cfg(feature = "rpc")]
    mod contract_accounts {
        use super::*;
        use crate::rpc::{JsonRpc, RpcSignatureVerifier};
        use std::sync::{Arc, Mutex};

        /// A node that says a fixed answer to `isValidSignature` and remembers what it was asked.
        struct Node {
            answer: [u8; 4],
            asked: Mutex<Vec<(EvmAddress, Vec<u8>)>>,
        }

        #[async_trait::async_trait]
        impl JsonRpc for Node {
            async fn eth_get_code(&self, _address: &EvmAddress) -> Result<Vec<u8>, EvmAuthError> {
                Ok(vec![0x60, 0x80]) // an account with code
            }
            async fn eth_call(
                &self,
                to: &EvmAddress,
                data: &[u8],
            ) -> Result<Vec<u8>, EvmAuthError> {
                self.asked.lock().unwrap().push((*to, data.to_vec()));
                Ok(self.answer.to_vec())
            }
        }

        const MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

        fn contract_envelope(signature: &str) -> AttestationEnvelope {
            AttestationEnvelope {
                attestation: NostrSignerAttestation {
                    account: EvmAddress::from_bytes([9u8; 20]),
                    npub: [42u8; 32],
                    expires: 1_800_000_000,
                    nonce: 0,
                },
                domain: test_domain(),
                signature: signature.to_string(),
            }
        }

        fn verifier(answer: [u8; 4]) -> (RpcSignatureVerifier, Arc<Node>) {
            let node = Arc::new(Node {
                answer,
                asked: Mutex::new(Vec::new()),
            });
            (RpcSignatureVerifier::from_transport(node.clone()), node)
        }

        #[tokio::test]
        async fn the_account_is_asked_about_the_attestation_digest_and_its_answer_decides() {
            let envelope = contract_envelope(&format!("0x00{}", "ab".repeat(300)));
            let (accepting, node) = verifier(MAGIC);
            envelope
                .verify_for_npub_contract(&accepting, &hex::encode([42u8; 32]), 1_700_000_000)
                .await
                .expect("an account that says yes is accepted");
            // Take what was asked out of the lock before anything is awaited again.
            let asked = node.asked.lock().unwrap().clone();
            assert_eq!(asked.len(), 1);
            // The call goes to the claimed account and carries `isValidSignature(digest, signature)`.
            assert_eq!(asked[0].0, envelope.attestation.account);
            assert_eq!(&asked[0].1[..4], &MAGIC);
            assert_eq!(
                &asked[0].1[4..36],
                &envelope.attestation.digest(&envelope.domain)
            );
            // ABI padding follows the signature, so look for it inside the call rather than at its end.
            let mut whole = vec![0x00u8];
            whole.extend_from_slice(&[0xab; 300]);
            assert!(
                asked[0].1.windows(whole.len()).any(|part| part == whole),
                "the signature is passed on whole"
            );

            let (refusing, _) = verifier([0xff; 4]);
            let refused = envelope
                .verify_for_npub_contract(&refusing, &hex::encode([42u8; 32]), 1_700_000_000)
                .await;
            assert!(matches!(refused, Err(EvmAuthError::InvalidSignature(_))));
        }

        #[tokio::test]
        async fn an_expired_or_misdirected_proof_never_reaches_the_node() {
            let envelope = contract_envelope(&format!("0x00{}", "ab".repeat(300)));
            let (accepting, node) = verifier(MAGIC);
            let expired = envelope
                .verify_for_npub_contract(&accepting, &hex::encode([42u8; 32]), 1_900_000_000)
                .await;
            assert!(matches!(expired, Err(EvmAuthError::Expired)));
            let elsewhere = envelope
                .verify_for_npub_contract(&accepting, &hex::encode([7u8; 32]), 1_700_000_000)
                .await;
            assert!(matches!(
                elsewhere,
                Err(EvmAuthError::SignerMismatch { .. })
            ));
            assert!(node.asked.lock().unwrap().is_empty());
        }

        /// A passkey proof signed with the repo's pinned fixture passkey (`contracts/test/kernel-sign.mjs`, an obviously
        /// fake test key) by the web client's production signer (`web/.../kernel-signature.ts`), for the fixture's Kernel
        /// 0.3.3 account on Sepolia. Regenerate with `node scripts/kernel-1271-live-check.mjs --print`.
        const GOLDEN_ENVELOPE: &str = r#"{"domain":{"name":"creabuzz","version":"1","chain_id":11155111,"verifying_contract":"0x0000000000000000000000000000000000000000"},"attestation":{"account":"0xd6b93cedda0d95145b822f44108ef13e41e9aa39","npub":[60,114,173,219,79,223,9,175,148,240,201,77,127,233,42,56,106,126,112,207,138,29,133,145,99,134,187,37,53,199,177,177],"expires":4102444800,"nonce":1},"signature":"0x0000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000178cb0339b0bccfcbb3030f0a5ada052e2427e6dea4258be324aaddf92313913e3830ca74d444004b89134806440516e14eb26c72e831dacfdc4a524ddd9bb4360000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000847b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22566e3776486f53366649735251507651706658734c394e48516f496c5265636c674f775476354c42413830222c226f726967696e223a2268747470733a2f2f6578616d706c652e636f6d222c2263726f73734f726967696e223a66616c73657d00000000000000000000000000000000000000000000000000000000"}"#;
        const GOLDEN_NPUB: &str =
            "3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1";
        /// The digest the web client computes for it: the two implementations must agree, or no signature checks.
        const GOLDEN_DIGEST: &str =
            "8149da79a165ccb5a2e52703c454a869d3130968622cd3a1e1f8dcc1d3db89ea";

        #[test]
        fn the_golden_attestation_has_the_same_digest_as_the_web_client() {
            let envelope: AttestationEnvelope =
                serde_json::from_str(GOLDEN_ENVELOPE).expect("the golden envelope parses");
            assert_eq!(
                hex::encode(envelope.attestation.digest(&envelope.domain)),
                GOLDEN_DIGEST
            );
            assert_eq!(hex::encode(envelope.attestation.npub), GOLDEN_NPUB);
        }

        /// What the web client sent the real account, byte for byte, when it accepted the golden proof
        /// (`isValidSignature(digest, signature)` as the web client's `kernel-signature.ts` builds it). The server must ask the same
        /// question, or a proof the account would accept is refused for a mistake in how it was put.
        const GOLDEN_CALLDATA: &str =
            "1626ba7e8149da79a165ccb5a2e52703c454a869d3130968622cd3a1e1f8dcc1d3db89ea000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001e10000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000178cb0339b0bccfcbb3030f0a5ada052e2427e6dea4258be324aaddf92313913e3830ca74d444004b89134806440516e14eb26c72e831dacfdc4a524ddd9bb4360000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000847b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22566e3776486f53366649735251507651706658734c394e48516f496c5265636c674f775476354c42413830222c226f726967696e223a2268747470733a2f2f6578616d706c652e636f6d222c2263726f73734f726967696e223a66616c73657d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

        #[test]
        fn the_server_asks_the_account_the_same_question_the_web_client_did() {
            let envelope: AttestationEnvelope =
                serde_json::from_str(GOLDEN_ENVELOPE).expect("the golden envelope parses");
            let digest = envelope.attestation.digest(&envelope.domain);
            let signature = hex::decode(envelope.signature.trim_start_matches("0x"))
                .expect("the signature is hex");
            assert_eq!(
                hex::encode(crate::erc6492::encode_is_valid_signature(
                    &digest, &signature
                )),
                GOLDEN_CALLDATA
            );
        }

        /// The real thing, against a real deployed Kernel 0.3.3 account. Read-only (`eth_call` only).
        /// `cargo test -p buzz-evm-auth --features rpc -- --ignored a_real_kernel`
        #[tokio::test]
        #[ignore = "needs a Sepolia RPC: the public endpoint, or BUZZ_TEST_SEPOLIA_RPC"]
        async fn a_real_kernel_account_on_sepolia_accepts_the_golden_passkey_proof() {
            let url = std::env::var("BUZZ_TEST_SEPOLIA_RPC")
                .unwrap_or_else(|_| "https://ethereum-sepolia-rpc.publicnode.com".into());
            let verifier = RpcSignatureVerifier::new(&url);
            let envelope: AttestationEnvelope =
                serde_json::from_str(GOLDEN_ENVELOPE).expect("the golden envelope parses");
            let account = envelope
                .verify_for_npub_contract(&verifier, GOLDEN_NPUB, 1_800_000_000)
                .await
                .expect("the account accepts the passkey proof it signed");
            assert_eq!(account, envelope.attestation.account);

            // The same signature for a different Nostr key, or a different nonce, is refused by the account.
            let mut other_key = envelope.clone();
            other_key.attestation.npub[0] ^= 1;
            let refused = other_key
                .verify_for_npub_contract(
                    &verifier,
                    &hex::encode(other_key.attestation.npub),
                    1_800_000_000,
                )
                .await;
            assert!(
                refused.is_err(),
                "a proof moved to another key must not verify"
            );
            let mut other_nonce = envelope.clone();
            other_nonce.attestation.nonce += 1;
            assert!(other_nonce
                .verify_for_npub_contract(&verifier, GOLDEN_NPUB, 1_800_000_000)
                .await
                .is_err());
        }

        #[tokio::test]
        async fn a_signature_that_is_not_hex_is_refused() {
            let envelope = contract_envelope("0xnot-hex");
            let (accepting, node) = verifier(MAGIC);
            let result = envelope.verify_contract_signature(&accepting).await;
            assert!(matches!(result, Err(EvmAuthError::InvalidSignature(_))));
            assert!(node.asked.lock().unwrap().is_empty());
        }
    }
}
