//! Desktop passkey ceremony seam — API shapes mirror
//! `web/src/features/identity/lib/passkey.ts` EXACTLY (same option/return
//! types, same error classes), and derivations run through
//! `crate::passkey_derive`, which is a byte-identical port of the web module's
//! pure functions (pinned to the web test vectors).
//!
//! # Platform findings (spike, 2026-09-24) — the anti-hallucination ledger
//!
//! 1. Tauri webview + WebAuthn (WKWebView on macOS): NOT a usable path today.
//!    - `navigator.credentials.create` throws `NotAllowedError` inside the
//!      Tauri webview (empirical): https://github.com/tauri-apps/tauri/issues/6471
//!    - "Passkey doesn't work in Tauri webview" (WebKit limitation; works on
//!      Windows WebView2, fails on macOS): https://github.com/tauri-apps/tauri/issues/7926
//!    - Apple's own guidance: passkeys in WKWebView only work when the RP id is
//!      configured as a `webcredentials` associated domain of the APP (plus
//!      codesigned entitlement + AASA on the domain); the webview page origin
//!      (`tauri://localhost` / `http://tauri.localhost`) can never be the RP id
//!      itself — WebAuthn RP ids must be domains and browsers reject IP/loopback
//!      origins (the web e2e proved Chrome refuses IP origins; WKWebView inherits
//!      the same WebAuthn machinery). Apple also ships a JS availability probe
//!      for WKWebView since iOS 16.4 / macOS 13.3:
//!      https://developer.apple.com/documentation/authenticationservices/supporting-passkeys#Use-passkeys-in-a-web-view
//!
//! 2. Native path — macOS `AuthenticationServices`
//!    (`ASAuthorizationPlatformPublicKeyCredentialProvider`, macOS 12+):
//!    - PRF extension EXISTS natively but ONLY from macOS 15.0 / iOS 18.0:
//!      `ASAuthorizationPublicKeyCredentialPRF{Registration,Assertion}{Input,Output}`
//!      are `API_AVAILABLE(macos(15.0), ios(18.0))` in the local macOS 26.3 SDK
//!      headers (`AuthenticationServices.framework/Headers/…PRF…h`) and Apple
//!      docs: https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfregistrationoutput
//!      macOS 14 has NO PRF via this API — the PRF→HKDF→Nostr root cannot be
//!      derived there (unlock-mode fallback territory, cf. the web module).
//!    - Attested P-256 public key extraction is covered: registration responses
//!      carry `rawAttestationObject`
//!      (`ASAuthorizationPublicKeyCredentialRegistration.rawAttestationObject`,
//!      macOS 12+) — the same CBOR→COSE→`04‖x‖y` parse the web module runs is
//!      valid on the native bytes, so the r1 root is contract-portable.
//!    - RP id: BOTH native and WKWebView ceremonies require a `webcredentials`
//!      associated domain — "You need to have an associated domain with the
//!      `webcredentials` service type when making a registration or assertion
//!      request; otherwise, the request returns an error", and the RP id is
//!      "usually the service's domain name":
//!      https://developer.apple.com/documentation/authenticationservices/supporting-passkeys
//!      The demo app for the macOS passkey plugin ships exactly this setup
//!      (AASA with `webcredentials` + entitlement + provisioning profile):
//!      https://github.com/yminghua/tauri-passkey-demo
//!      → TRADEOFF: a desktop credential is web-portable ONLY when both sides
//!      use the same domain RP id AND that domain's AASA lists the app's
//!      appID (`TEAMID.bundle.id`). A bundle-id RP id makes a desktop-only
//!      island (no Safari/web reuse). The identity doc's "same credential +
//!      salt re-derives" story therefore needs ONE shared domain RP id across
//!      web + desktop. This repo today has NO `webcredentials` entitlement
//!      (`desktop/src-tauri/Entitlements.plist`) and no associated-domain
//!      config — deployment work, not code work.
//!
//! 3. Plugin landscape (checked, not guessed):
//!    - `tauri-plugin-webauthn` (Linux/Windows/Android native FIDO APIs;
//!      macOS explicitly unsupported): https://github.com/profiidev/tauri-plugin-webauthn
//!    - `tauri-plugin-macos-passkey` (wraps the native passkey API on macOS
//!      15+, returns `attestation_object` + PRF output — exactly our raw
//!      material) is a single 0.1.0 release (2025-08) with a demo repo; not a
//!      maintained dependency: https://crates.io/crates/tauri-plugin-macos-passkey
//!    - `objc2-authentication-services` (madsmtm/objc2 workspace, actively
//!      maintained, 788k downloads) is the solid foundation for a first-party
//!      bridge: https://crates.io/crates/objc2-authentication-services
//!    - `authenticationservices-rs` exists but is early-stage;
//!      `window-passkey` is Electron-only (not Tauri).
//!
//! # Verdict and recommended architecture
//!
//! There is no maintained, drop-in Tauri passkey plugin, and every viable
//! macOS path (webview OR native) needs deployment artifacts this build does
//! not have (signed app + `webcredentials` entitlement + AASA on the RP
//! domain). So this module ships the honest fallback seam (per the spike
//! brief): a real capability probe, the web-mirroring command surface, the
//! tested derivation engine, and a typed `PasskeyUnsupportedPlatformError`
//! where the ceremony bridge would run. NOTHING is faked.
//!
//! To reach parity with the web ceremony, pick ONE (both need the same
//! deployment setup):
//! - In-webview: signed build + AASA on the Buzz web domain +
//!   `com.apple.developer.webcredentials` entitlement, then `rp.id = <web
//!   domain>` reuses `web/src/features/identity/lib/passkey.ts` verbatim.
//!   OPEN QUESTION: whether the WKWebView bridge forwards the WebAuthn `prf`
//!   extension (Safari/WebKit PRF support is an existing open question on the
//!   identity roadmap) — verify on hardware before relying on it.
//! - Native bridge: implement `PasskeyCeremony` with `objc2-authentication-services`
//!   (`ASAuthorizationPlatformPublicKeyCredentialProvider`, PRF input on
//!   macOS 15+); PRF is guaranteed on the native API where the OS provides it.
//!
//! Either way the on-chain/web verification policy must accept the desktop
//! webview's `clientDataJSON.origin` (`tauri://localhost` / `http://tauri.localhost`)
//! alongside the web origins, or the desktop UserOp will verify its challenge
//! but fail an origin allow-list.

use serde::{Deserialize, Serialize};

use crate::passkey_derive::{
    cose_p256_uncompressed, derive_nostr_secret_key, parse_attestation_auth_data,
    parse_attested_credential_data, passkey_identity_from, DeriveError,
};

/// The native ceremony bridge is not compiled into this build — see the
/// platform ledger above. When a real `PasskeyCeremony` implementation lands,
/// flip this so `passkey_capability` reports the bridge as wired.
pub(crate) const CEREMONY_BRIDGE_WIRED: bool = false;

/// Environment variable naming the app's `webcredentials` associated domain
/// (the WebAuthn RP id). Without it no Apple passkey ceremony can succeed.
pub(crate) const RP_ID_ENV: &str = "BUZZ_PASSKEY_RP_ID";

// ---------------------------------------------------------------------------
// API shapes — camelCase JSON mirrors of `web/src/features/identity/lib/passkey.ts`.
// Byte fields cross the IPC boundary as JSON number arrays; the desktop TS
// layer (`desktop/src/features/identity/passkeyContract.ts`) converts them to
// `Uint8Array` so call shapes match the web module exactly.
// ---------------------------------------------------------------------------

/// The two public roots of one passkey registration (web `PasskeyIdentity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyIdentity {
    /// Nostr root: secp256k1 pubkey derived from the PRF output.
    pub nostr: NostrRoot,
    /// Smart-wallet root: the passkey's own secp256r1 key (wave 4b owner).
    pub evm_owner: EvmOwnerRoot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrRoot {
    pub pubkey_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmOwnerRoot {
    pub r1_uncompressed_hex: String,
    pub address_preview: Option<String>,
}

/// Credential reference carried by errors raised after creation succeeded
/// (web `CreatedPasskeyRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPasskeyRef {
    pub credential_id: String,
    pub r1_uncompressed_hex: Option<String>,
}

/// Web `CreatePasskeyOptions`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePasskeyOptions {
    /// Relying-party display name shown by the platform prompt.
    pub rp_name: String,
    /// Relying-party id; defaults to the configured associated domain.
    pub rp_id: Option<String>,
    /// Credential user label shown by the platform prompt.
    pub user_label: String,
    /// PRF `eval.first` salt (random 32 bytes when omitted). Persist it — it
    /// is non-secret and is what makes re-derivation deterministic.
    pub prf_salt: Option<Vec<u8>>,
}

/// Web `CreatedPasskey`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPasskey {
    pub credential_id: String,
    pub prf_salt: Vec<u8>,
    /// Both public roots.
    pub identity: PasskeyIdentity,
    /// The Nostr secret key — kept in memory only, never persisted.
    pub nostr_secret_key: Vec<u8>,
}

/// Web `GetPasskeyAssertionOptions`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPasskeyAssertionOptions {
    /// base64url credential id from `passkey_create`.
    pub credential_id: String,
    /// PRF `eval.first` salt from registration. When passed, the result
    /// carries the PRF output for re-derivation; when omitted, a plain
    /// assertion is requested.
    pub prf_salt: Option<Vec<u8>>,
    pub rp_id: Option<String>,
    pub challenge: Option<Vec<u8>>,
}

/// Web `PasskeyAssertion`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyAssertion {
    pub credential_id: String,
    /// ES256 signature over `authenticatorData ‖ SHA-256(clientDataJSON)`.
    pub signature: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub client_data_json: Vec<u8>,
    /// PRF output for `prf_salt` — present iff `prf_salt` was passed.
    pub prf_output: Option<Vec<u8>>,
}

// ---------------------------------------------------------------------------
// Errors — web's error classes, carried as typed command errors.
// ---------------------------------------------------------------------------

/// Typed ceremony/derivation failure. Serialized as `{code, message, …}` for
/// the desktop TS layer, which maps codes back onto the web module's error
/// classes (`PasskeyEnvironmentError`, `PrfUnavailableError`,
/// `PasskeyAttestationError`, plus the desktop-only
/// `PasskeyUnsupportedPlatformError`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PasskeyCommandError {
    /// Web `PasskeyEnvironmentError` — no ceremony API at all. Part of the
    /// serialized error contract (the TS layer maps it); constructed by
    /// future webview/bridge ceremonies, not by today's stub.
    #[allow(dead_code)]
    Environment { message: String },
    /// Web `PrfUnavailableError` — the platform withheld the PRF output.
    PrfUnavailable {
        message: String,
        created: Option<CreatedPasskeyRef>,
    },
    /// Web `PasskeyAttestationError` — no secp256r1 owner key extractable.
    Attestation {
        message: String,
        created: Option<CreatedPasskeyRef>,
    },
    /// Desktop-only: this build cannot run the ceremony (see the ledger).
    UnsupportedPlatform { message: String, detail: String },
    /// Stand-in for web's plain `Error` (e.g. a cancelled ceremony).
    Failed { message: String },
}

impl PasskeyCommandError {
    /// Web `PrfUnavailableError`'s fixed message.
    pub(crate) fn prf_unavailable(created: Option<CreatedPasskeyRef>) -> Self {
        PasskeyCommandError::PrfUnavailable {
            message: "This platform did not provide a PRF output for the passkey — passkey identity needs PRF support (Windows Hello / Google Password Manager).".to_string(),
            created,
        }
    }
}

impl std::fmt::Display for PasskeyCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PasskeyCommandError::Environment { message }
            | PasskeyCommandError::PrfUnavailable { message, .. }
            | PasskeyCommandError::Attestation { message, .. }
            | PasskeyCommandError::UnsupportedPlatform { message, .. }
            | PasskeyCommandError::Failed { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for PasskeyCommandError {}

// ---------------------------------------------------------------------------
// The native ceremony seam.
//
// Everything a platform authenticator returns raw crosses exactly this
// boundary; everything below it is pure, tested composition. A future
// `objc2-authentication-services` bridge implements `PasskeyCeremony` and
// nothing else changes. Tests bind the composition through this same trait
// with a mock authenticator (see `tests` below).
// ---------------------------------------------------------------------------

/// Raw registration material from one platform ceremony.
pub(crate) struct RawRegistration {
    /// `rawId` bytes — composed into web's base64url `credentialId`.
    pub raw_id: Vec<u8>,
    /// PRF `eval.first` output when the platform returned it at creation.
    pub prf_output_at_create: Option<Vec<u8>>,
    /// WebAuthn `attestationObject` — carries the attested secp256r1 key.
    pub attestation_object: Vec<u8>,
}

/// Raw assertion material from one platform ceremony.
pub(crate) struct RawAssertion {
    pub signature: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub client_data_json: Vec<u8>,
    pub prf_output: Option<Vec<u8>>,
}

pub(crate) trait PasskeyCeremony {
    fn register(
        &self,
        options: &CreatePasskeyOptions,
        prf_salt: &[u8],
    ) -> Result<RawRegistration, PasskeyCommandError>;

    fn assert(
        &self,
        options: &GetPasskeyAssertionOptions,
    ) -> Result<RawAssertion, PasskeyCommandError>;
}

/// The production ceremony: honestly unsupported in this build.
pub(crate) struct PlatformCeremony;

impl PasskeyCeremony for PlatformCeremony {
    fn register(
        &self,
        _options: &CreatePasskeyOptions,
        _prf_salt: &[u8],
    ) -> Result<RawRegistration, PasskeyCommandError> {
        Err(unsupported_platform_error())
    }

    fn assert(
        &self,
        _options: &GetPasskeyAssertionOptions,
    ) -> Result<RawAssertion, PasskeyCommandError> {
        Err(unsupported_platform_error())
    }
}

pub(crate) fn unsupported_platform_error() -> PasskeyCommandError {
    PasskeyCommandError::UnsupportedPlatform {
        message: "Passkey sign-in is not available in this desktop build yet — no passkey ceremony was run and nothing was created. The web app supports passkeys today.".to_string(),
        detail: "The native AuthenticationServices ceremony bridge is not wired in this build; it also needs a signed app with the webcredentials associated domain (see the platform ledger in desktop/src-tauri/src/commands/passkey.rs).".to_string(),
    }
}

fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_salt() -> Result<Vec<u8>, PasskeyCommandError> {
    let mut salt = vec![0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|error| PasskeyCommandError::Failed {
        message: format!("could not generate a PRF salt: {error}"),
    })?;
    Ok(salt)
}

/// One registration ceremony, both identity roots — web `createPasskey`,
/// composed from raw ceremony material (production path; the commands below
/// run exactly this with `PlatformCeremony`).
pub(crate) fn create_passkey_with_ceremony<C: PasskeyCeremony + ?Sized>(
    ceremony: &C,
    options: CreatePasskeyOptions,
) -> Result<CreatedPasskey, PasskeyCommandError> {
    let prf_salt = match options.prf_salt.clone() {
        Some(salt) => salt,
        None => random_salt()?,
    };
    let registration = ceremony.register(&options, &prf_salt)?;
    let credential_id = base64url(&registration.raw_id);
    let created_ref = CreatedPasskeyRef {
        credential_id: credential_id.clone(),
        r1_uncompressed_hex: None,
    };
    let auth_data =
        parse_attestation_auth_data(&registration.attestation_object).map_err(|error| {
            PasskeyCommandError::Attestation {
                message: error.to_string(),
                created: Some(created_ref.clone()),
            }
        })?;
    let attested = parse_attested_credential_data(&auth_data).map_err(|error| {
        PasskeyCommandError::Attestation {
            message: error.to_string(),
            created: Some(created_ref.clone()),
        }
    })?;
    let r1_uncompressed = cose_p256_uncompressed(&attested.cose_key).map_err(|error| {
        PasskeyCommandError::Attestation {
            message: error.to_string(),
            created: Some(created_ref),
        }
    })?;
    let created_ref = CreatedPasskeyRef {
        credential_id: credential_id.clone(),
        r1_uncompressed_hex: Some(hex::encode(&r1_uncompressed)),
    };
    // Some platforms defer the PRF result to the first assertion; one
    // follow-up assertion with the same salt covers that (web's posture).
    let prf_output = match registration.prf_output_at_create {
        Some(output) => Some(output),
        None => {
            ceremony
                .assert(&GetPasskeyAssertionOptions {
                    credential_id: credential_id.clone(),
                    prf_salt: Some(prf_salt.clone()),
                    rp_id: options.rp_id.clone(),
                    challenge: None,
                })?
                .prf_output
        }
    };
    let prf_output =
        prf_output.ok_or_else(|| PasskeyCommandError::prf_unavailable(Some(created_ref)))?;
    let nostr_secret_key = derive_nostr_secret_key(&prf_output);
    let identity = passkey_identity_from(&nostr_secret_key, &r1_uncompressed)
        .map_err(derive_error_to_command)?;
    Ok(CreatedPasskey {
        credential_id,
        prf_salt,
        identity: PasskeyIdentity {
            nostr: NostrRoot {
                pubkey_hex: identity.nostr_pubkey_hex,
            },
            evm_owner: EvmOwnerRoot {
                r1_uncompressed_hex: identity.r1_uncompressed_hex,
                address_preview: Some(identity.address_preview),
            },
        },
        nostr_secret_key: nostr_secret_key.to_vec(),
    })
}

/// Signed assertion by the passkey's secp256r1 key plus the second PRF
/// evaluation of the registration salt — web `getPasskeyAssertion`.
pub(crate) fn get_passkey_assertion_with_ceremony<C: PasskeyCeremony + ?Sized>(
    ceremony: &C,
    options: GetPasskeyAssertionOptions,
) -> Result<PasskeyAssertion, PasskeyCommandError> {
    let result = ceremony.assert(&options)?;
    if options.prf_salt.is_some() && result.prf_output.is_none() {
        return Err(PasskeyCommandError::prf_unavailable(None));
    }
    Ok(PasskeyAssertion {
        credential_id: options.credential_id,
        signature: result.signature,
        authenticator_data: result.authenticator_data,
        client_data_json: result.client_data_json,
        prf_output: result.prf_output,
    })
}

fn derive_error_to_command(error: DeriveError) -> PasskeyCommandError {
    match error {
        DeriveError::Attestation(message) => PasskeyCommandError::Attestation {
            message,
            created: None,
        },
        DeriveError::InvalidSecretKey => PasskeyCommandError::Failed {
            message: error.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Capability probe — honest platform reporting for the UI.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformKind {
    Macos,
    Windows,
    Linux,
    Other,
}

impl PlatformKind {
    fn label(self) -> &'static str {
        match self {
            PlatformKind::Macos => "macos",
            PlatformKind::Windows => "windows",
            PlatformKind::Linux => "linux",
            PlatformKind::Other => "other",
        }
    }
}

/// Probe inputs (injectable for tests; the command uses the real machine).
#[derive(Debug, Clone)]
pub(crate) struct CapabilityInputs {
    pub platform: PlatformKind,
    /// `ProductVersion` of the OS when known (macOS only).
    pub os_version: Option<(u32, u32, u32)>,
    /// The configured `webcredentials` associated domain, if any.
    pub rp_id: Option<String>,
    pub bridge_wired: bool,
}

/// What the desktop can honestly do with passkeys right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyCapability {
    pub platform: String,
    /// Which native ceremony backend this platform has.
    pub ceremony_backend: String,
    /// Whether the platform authenticator exposes the WebAuthn PRF extension
    /// (native AuthenticationServices: macOS 15.0+ — see the ledger).
    pub prf_supported: bool,
    pub prf_min_os: Option<String>,
    /// The associated domain the ceremonies would use as RP id.
    pub rp_id: Option<String>,
    pub available: bool,
    /// Why ceremonies cannot run here, in words a person can act on.
    pub blocker: Option<String>,
}

pub(crate) fn capability_for(inputs: &CapabilityInputs) -> PasskeyCapability {
    let macos = inputs.platform == PlatformKind::Macos;
    let (ceremony_backend, backend_blocker) = if macos {
        ("apple-authentication-services", None)
    } else {
        (
            "none",
            Some(format!(
                "this build has no passkey ceremony bridge for {} — passkey identity needs a platform authenticator (Touch ID / Windows Hello).",
                inputs.platform.label()
            )),
        )
    };
    let prf_supported = macos && inputs.os_version.is_some_and(|(major, _, _)| major >= 15);
    let prf_min_os = macos.then(|| "macOS 15.0".to_string());

    let blocker = backend_blocker.or_else(|| {
        if macos && !prf_supported {
            let version = inputs
                .os_version
                .map(|(a, b, c)| format!("{a}.{b}.{c}"))
                .unwrap_or_else(|| "an unknown version".to_string());
            return Some(format!(
                "passkey identity needs the PRF extension, which the native platform authenticator exposes from macOS 15.0 (this Mac reports {version})."
            ));
        }
        if !inputs.bridge_wired {
            return Some(
                "the native passkey ceremony bridge is not wired in this build — nothing was created. Passkey sign-in is available in the web app today."
                    .to_string(),
            );
        }
        if inputs.rp_id.is_none() {
            return Some(
                "no passkey associated domain is configured (BUZZ_PASSKEY_RP_ID) — Apple's passkey APIs require a webcredentials associated domain, so no ceremony can run."
                    .to_string(),
            );
        }
        None
    });

    PasskeyCapability {
        platform: inputs.platform.label().to_string(),
        ceremony_backend: ceremony_backend.to_string(),
        prf_supported,
        prf_min_os,
        rp_id: inputs.rp_id.clone(),
        available: blocker.is_none(),
        blocker,
    }
}

/// The machine's macOS `ProductVersion` (e.g. 26.3 → (26, 3, 0)), read from
/// `/System/Library/CoreServices/SystemVersion.plist` — no `unsafe`, cached.
fn macos_product_version() -> Option<(u32, u32, u32)> {
    static VERSION: std::sync::OnceLock<Option<(u32, u32, u32)>> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        let plist =
            std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
        let start = plist.find("<key>ProductVersion</key>")?;
        let rest = &plist[start..];
        let version_start = rest.find("<string>")? + "<string>".len();
        let version_end = rest.find("</string>")?;
        parse_version(&rest[version_start..version_end])
    })
}

/// `"26.3"` → (26, 3, 0). Non-numeric tails parse as 0.
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

pub(crate) fn real_capability_inputs() -> CapabilityInputs {
    let platform = match std::env::consts::OS {
        "macos" => PlatformKind::Macos,
        "windows" => PlatformKind::Windows,
        "linux" => PlatformKind::Linux,
        _ => PlatformKind::Other,
    };
    CapabilityInputs {
        platform,
        os_version: (platform == PlatformKind::Macos)
            .then(macos_product_version)
            .flatten(),
        rp_id: std::env::var(RP_ID_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty()),
        bridge_wired: CEREMONY_BRIDGE_WIRED,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — the desktop call shapes of the web module.
// ---------------------------------------------------------------------------

/// Honest capability probe (the spike's `passkey_unavailable` seam, reporting
/// the full matrix — platform, PRF support, RP id — rather than a bare bool).
#[tauri::command]
pub fn passkey_capability() -> PasskeyCapability {
    capability_for(&real_capability_inputs())
}

/// Web `createPasskey` — one registration, both identity roots. Wires to the
/// platform ceremony seam; this build returns the typed
/// `PasskeyUnsupportedPlatformError` (nothing is faked).
#[tauri::command]
pub async fn passkey_create(
    options: CreatePasskeyOptions,
) -> Result<CreatedPasskey, PasskeyCommandError> {
    create_passkey_with_ceremony(&PlatformCeremony, options)
}

/// Web `getPasskeyAssertion` — signed assertion (+ PRF re-evaluation).
#[tauri::command]
pub async fn passkey_get(
    options: GetPasskeyAssertionOptions,
) -> Result<PasskeyAssertion, PasskeyCommandError> {
    get_passkey_assertion_with_ceremony(&PlatformCeremony, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pinned vectors — identical to `web/src/features/identity/lib/passkey.test.mjs`
    // and `crate::passkey_derive`'s tests (the parity contract).
    const GX_HEX: &str = "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
    const GY_HEX: &str = "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
    const FIXED_PRF_HEX: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const EXPECTED_NOSTR_SK_HEX: &str =
        "35430cd334f6fe898d7b37886f33a3612edea16fce04fe8bceb92f863e309bf6";
    const EXPECTED_NOSTR_PUB_HEX: &str =
        "489e1b47933dfababa9842058b3a19e2f15cc7f6da0c6f1983688aabe66c2353";
    const EXPECTED_G_ADDRESS: &str = "0xd3a9f047ad43d7e2e4e7e491f1fe2e657a2651b6";

    fn g_uncompressed_hex() -> String {
        format!("04{GX_HEX}{GY_HEX}")
    }

    fn attestation_hex() -> String {
        let mut out = String::new();
        out.push_str("a363666d74646e6f6e65");
        out.push_str("6761747453746d74a0");
        out.push_str("6861757468446174615894");
        out.push_str("49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763");
        out.push_str("4500000000");
        out.push_str("00000000000000000000000000000000");
        out.push_str("0010000102030405060708090a0b0c0d0e0f");
        out.push_str(&format!("a5010203262001215820{GX_HEX}225820{GY_HEX}"));
        out
    }

    /// Mock authenticator: the web tests' constructed attestation vector and
    /// a configurable PRF posture. Exercises the SAME production composition
    /// (`create_passkey_with_ceremony`) that `passkey_create` runs.
    struct MockCeremony {
        prf_at_create: bool,
        prf_on_assert: bool,
        attestation: Vec<u8>,
    }

    impl MockCeremony {
        fn web_vector(prf_at_create: bool, prf_on_assert: bool) -> Self {
            MockCeremony {
                prf_at_create,
                prf_on_assert,
                attestation: hex::decode(attestation_hex()).expect("attestation hex"),
            }
        }

        fn with_no_prf(mut self) -> Self {
            self.prf_at_create = false;
            self.prf_on_assert = false;
            self
        }
    }

    impl PasskeyCeremony for MockCeremony {
        fn register(
            &self,
            _options: &CreatePasskeyOptions,
            _prf_salt: &[u8],
        ) -> Result<RawRegistration, PasskeyCommandError> {
            Ok(RawRegistration {
                raw_id: hex::decode("000102030405060708090a0b0c0d0e0f").expect("raw id"),
                prf_output_at_create: self
                    .prf_at_create
                    .then(|| hex::decode(FIXED_PRF_HEX).expect("prf")),
                attestation_object: self.attestation.clone(),
            })
        }

        fn assert(
            &self,
            _options: &GetPasskeyAssertionOptions,
        ) -> Result<RawAssertion, PasskeyCommandError> {
            Ok(RawAssertion {
                signature: vec![0x30],
                authenticator_data: vec![0u8; 37],
                client_data_json: br#"{"type":"webauthn.get"}"#.to_vec(),
                prf_output: self
                    .prf_on_assert
                    .then(|| hex::decode(FIXED_PRF_HEX).expect("prf")),
            })
        }
    }

    fn create_options() -> CreatePasskeyOptions {
        CreatePasskeyOptions {
            rp_name: "Creaton".to_string(),
            rp_id: None,
            user_label: "Test".to_string(),
            prf_salt: Some(vec![0x2a; 32]),
        }
    }

    #[test]
    fn create_composes_the_web_pinned_identity_byte_identically() {
        for prf_at_create in [true, false] {
            let created = create_passkey_with_ceremony(
                &MockCeremony::web_vector(prf_at_create, true),
                create_options(),
            )
            .expect("created");
            // credentialId is web's b64urlEncode(rawId).
            assert_eq!(created.credential_id, "AAECAwQFBgcICQoLDA0ODw");
            assert_eq!(created.prf_salt, vec![0x2a; 32]);
            assert_eq!(
                hex::encode(&created.nostr_secret_key),
                EXPECTED_NOSTR_SK_HEX,
                "prf_at_create={prf_at_create}"
            );
            assert_eq!(created.identity.nostr.pubkey_hex, EXPECTED_NOSTR_PUB_HEX);
            assert_eq!(
                created.identity.evm_owner.r1_uncompressed_hex,
                g_uncompressed_hex()
            );
            assert_eq!(
                created.identity.evm_owner.address_preview.as_deref(),
                Some(EXPECTED_G_ADDRESS)
            );
        }
    }

    #[test]
    fn create_without_any_prf_output_fails_unorphaned() {
        let error = create_passkey_with_ceremony(
            &MockCeremony::web_vector(true, false).with_no_prf(),
            create_options(),
        )
        .expect_err("no PRF anywhere");
        let PasskeyCommandError::PrfUnavailable { created, .. } = error else {
            panic!("expected PrfUnavailable, got {error:?}");
        };
        // The created credential is carried so callers can fall back without
        // orphaning the passkey (web `PrfUnavailableError.created`).
        let created = created.expect("created ref");
        assert_eq!(created.credential_id, "AAECAwQFBgcICQoLDA0ODw");
        assert_eq!(
            created.r1_uncompressed_hex.as_deref(),
            Some(g_uncompressed_hex().as_str())
        );
    }

    #[test]
    fn create_with_a_broken_attestation_fails_loudly_with_the_credential_ref() {
        let mut mock = MockCeremony::web_vector(true, false);
        mock.attestation = vec![0x41, 0x00]; // CBOR bytes, not a map
        let error =
            create_passkey_with_ceremony(&mock, create_options()).expect_err("bad attestation");
        let PasskeyCommandError::Attestation { created, .. } = error else {
            panic!("expected Attestation, got {error:?}");
        };
        assert_eq!(
            created.expect("created ref").credential_id,
            "AAECAwQFBgcICQoLDA0ODw"
        );
    }

    #[test]
    fn get_with_prf_salt_requires_the_prf_output() {
        let options = GetPasskeyAssertionOptions {
            credential_id: "abc".to_string(),
            prf_salt: Some(vec![0x2a; 32]),
            rp_id: None,
            challenge: None,
        };
        let error = get_passkey_assertion_with_ceremony(
            &MockCeremony::web_vector(true, false).with_no_prf(),
            options.clone(),
        )
        .expect_err("PRF withheld");
        assert!(matches!(error, PasskeyCommandError::PrfUnavailable { .. }));

        let assertion =
            get_passkey_assertion_with_ceremony(&MockCeremony::web_vector(true, true), options)
                .expect("assertion");
        assert_eq!(assertion.credential_id, "abc");
        assert_eq!(
            assertion.prf_output.as_deref().map(hex::encode),
            Some(FIXED_PRF_HEX.to_string())
        );
    }

    #[test]
    fn the_production_platform_seam_reports_unsupported_not_fake_success() {
        // Falsifiable guard on the seam `passkey_create` actually calls: if a
        // fake ceremony ever replaces PlatformCeremony, this fails.
        let error = create_passkey_with_ceremony(&PlatformCeremony, create_options())
            .expect_err("no ceremony in this build");
        let PasskeyCommandError::UnsupportedPlatform { message, detail } = error else {
            panic!("expected UnsupportedPlatform, got {error:?}");
        };
        assert!(message.contains("nothing was created"), "{message}");
        assert!(detail.contains("commands/passkey.rs"), "{detail}");
        let error = get_passkey_assertion_with_ceremony(
            &PlatformCeremony,
            GetPasskeyAssertionOptions {
                credential_id: "abc".to_string(),
                prf_salt: None,
                rp_id: None,
                challenge: None,
            },
        )
        .expect_err("no ceremony in this build");
        assert!(matches!(
            error,
            PasskeyCommandError::UnsupportedPlatform { .. }
        ));
    }

    #[test]
    fn command_errors_serialize_with_stable_codes() {
        let json = serde_json::to_string(&unsupported_platform_error()).expect("json");
        assert!(json.contains(r#""code":"unsupported_platform""#), "{json}");
        let json =
            serde_json::to_string(&PasskeyCommandError::prf_unavailable(None)).expect("json");
        assert!(json.contains(r#""code":"prf_unavailable""#), "{json}");
    }

    #[test]
    fn capability_matrix_matches_the_platform_ledger() {
        let base = CapabilityInputs {
            platform: PlatformKind::Macos,
            os_version: Some((15, 0, 0)),
            rp_id: Some("app.buzz.example".to_string()),
            bridge_wired: true,
        };
        let capable = capability_for(&base);
        assert!(capable.available, "{capable:?}");
        assert!(capable.prf_supported);
        assert_eq!(capable.ceremony_backend, "apple-authentication-services");
        assert_eq!(capable.rp_id.as_deref(), Some("app.buzz.example"));

        // macOS 14: native passkey API exists but has no PRF (ledger §2).
        let mut macos14 = base.clone();
        macos14.os_version = Some((14, 5, 0));
        let cap = capability_for(&macos14);
        assert!(!cap.prf_supported);
        assert!(!cap.available);
        assert!(
            cap.blocker
                .as_deref()
                .unwrap_or_default()
                .contains("macOS 15.0"),
            "{cap:?}"
        );

        // No bridge wired (today's build).
        let mut no_bridge = base.clone();
        no_bridge.bridge_wired = false;
        let cap = capability_for(&no_bridge);
        assert!(!cap.available);
        assert!(cap
            .blocker
            .as_deref()
            .unwrap_or_default()
            .contains("bridge"));

        // No associated domain (ledger §2: ceremonies error without one).
        let mut no_rp = base.clone();
        no_rp.rp_id = None;
        let cap = capability_for(&no_rp);
        assert!(!cap.available);
        assert!(
            cap.blocker
                .as_deref()
                .unwrap_or_default()
                .contains("webcredentials"),
            "{cap:?}"
        );

        // Windows/Linux: no backend in this build.
        for platform in [PlatformKind::Windows, PlatformKind::Linux] {
            let mut other = base.clone();
            other.platform = platform;
            let cap = capability_for(&other);
            assert!(!cap.available);
            assert_eq!(cap.ceremony_backend, "none");
            assert!(!cap.prf_supported);
        }
    }

    #[test]
    fn the_real_probe_is_honest_on_this_machine() {
        let inputs = real_capability_inputs();
        let capability = capability_for(&inputs);
        // Invariants every build must hold: no availability without all
        // preconditions, no unavailability without a stated reason.
        if capability.available {
            assert!(capability.prf_supported);
            assert!(inputs.bridge_wired);
            assert!(inputs.rp_id.is_some());
            assert!(capability.blocker.is_none());
        } else {
            assert!(capability.blocker.is_some());
        }
        // This build ships no bridge, so the probe can never claim available.
        const _: () = assert!(!CEREMONY_BRIDGE_WIRED);
        assert!(!capability.available);
    }

    #[test]
    fn version_parsing_covers_the_macos_product_version_shapes() {
        assert_eq!(parse_version("26.3"), Some((26, 3, 0)));
        assert_eq!(parse_version("15.0"), Some((15, 0, 0)));
        assert_eq!(parse_version("14.7.1"), Some((14, 7, 1)));
        assert_eq!(parse_version("garbage"), None);
    }
}
