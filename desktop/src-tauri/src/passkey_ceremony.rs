//! macOS passkey ceremony bridge — native `AuthenticationServices`, PRF-first.
//!
//! This module implements the `PasskeyCeremony` seam (`commands/passkey.rs`)
//! against Apple's native WebAuthn surface, replacing the
//! `PasskeyUnsupportedPlatformError` stub on macOS 15+. The raw ceremony bytes
//! flow straight into the existing, tested derivations (`passkey_derive.rs`);
//! nothing here re-derives keys.
//!
//! Platform APIs used (all `AuthenticationServices.framework`, macOS 12.0+
//! unless noted — headers of the local macOS 26.3 SDK; see the platform ledger
//! at `commands/passkey.rs`):
//!
//! - `ASAuthorizationPlatformPublicKeyCredentialProvider`
//!   (`initWithRelyingPartyIdentifier:`,
//!   `createCredentialRegistrationRequestWithChallenge:name:userID:`,
//!   `createCredentialAssertionRequestWithChallenge:`).
//! - `ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest.prf` =
//!   `ASAuthorizationPublicKeyCredentialPRFRegistrationInput`
//!   (`initWithInputValues:` over
//!   `ASAuthorizationPublicKeyCredentialPRFAssertionInputValues`
//!   `initWithSaltInput1:saltInput2:`) — **macOS 15.0+**
//!   (`ASAuthorizationPublicKeyCredentialPRFRegistrationInput.h`). The input
//!   `saltInput1` is web's `extensions.prf.eval.first`; the response's
//!   `ASAuthorizationPublicKeyCredentialPRFRegistrationOutput.first` is web's
//!   `prf.results.first` — same bytes, same derivation seam.
//! - `ASAuthorizationPlatformPublicKeyCredentialAssertionRequest.prf` =
//!   `ASAuthorizationPublicKeyCredentialPRFAssertionInput` — **macOS 15.0+**.
//!   The assertion challenge is the caller's `challenge` bytes when given
//!   (web's UserOp-hash-as-challenge seam) and a random 32-byte nonce
//!   otherwise, exactly like web `performGet`.
//! - `ASAuthorizationController` (`performRequests`, delegate protocol
//!   `ASAuthorizationControllerDelegate`, presentation anchor
//!   `ASAuthorizationControllerPresentationContextProviding`).
//! - `ASAuthorizationPlatformPublicKeyCredentialRegistration` /
//!   `ASAuthorizationPlatformPublicKeyCredentialAssertion`
//!   (`rawClientDataJSON`, `rawAttestationObject`, `credentialID`,
//!   `rawAuthenticatorData`, `signature`).
//!
//! PRF is the **default** ceremony on macOS 15+: registration always requests
//! `eval.first = prf_salt`. The create composition refuses up front on
//! platforms without PRF (macOS 12–14 → web's typed `PrfUnavailableError`
//! with `created: false`, nothing registered) rather than mint a half
//! identity that can never derive its Nostr root here — the "restore/rollback
//! refuse wrong-derivation" discipline. The EVM secp256r1 root has no PRF
//! dependency (it is parsed from the attestation object) and the plain
//! assertion (UserOp signing) still runs on macOS 12–14; the capability
//! matrix in `commands/passkey.rs` reports that split honestly.
//!
//! The platform synthesizes `clientDataJSON` for native ceremonies (the
//! `ASPublicKeyCredentialClientData` initializer is browser-bridge-only);
//! its `origin` is read back from the returned bytes and recorded on the
//! identity record (the `expectedOrigin`/`expectedRPID` coupling contract).
//!
//! # Unsafe policy (repo rule: "No `unsafe` code")
//!
//! This file is the single documented exception in `desktop/src-tauri/src` —
//! the same exception class as `frb_generated.rs` in `crates/buzz-client-core`
//! (`#[allow(unsafe_code)]` over FFI glue). objc2's Objective-C message sends
//! are `unsafe fn` by construction (`objc2-authentication-services` 0.3.2 is
//! auto-generated from the framework headers). Every `unsafe` block below
//! carries a `// SAFETY:` justification; the surface is message sends, one
//! Objective-C class definition, and one GCD dispatch. Every other module in
//! this crate stays unsafe-free.
//!
//! # Untested-by-necessity seam
//!
//! This module is the ONE unit-test-untestable module of the passkey stack:
//! a ceremony needs a signed app, a `webcredentials` associated domain, and
//! live Touch ID UI. Everything below the seam is pure and tested in
//! `commands/passkey.rs` (composition through mock ceremonies, RP-id policy,
//! capability matrix, provenance extraction). This file only marshals bytes
//! across the FFI boundary and refuses loudly before it (RP id / OS floor);
//! the wait is bounded (`recv_timeout`) so a stuck platform prompt can never
//! hang a Tauri command (Review-Proven Rule 4: bound every wait).
//!
//! # Activation requirements (the in-repo half of the chain)
//!
//! A ceremony only starts when three exact matches hold for one domain:
//! 1. the AASA is served at
//!    `https://<rp-domain>/.well-known/apple-app-site-association` — the relay
//!    builds it from `BUZZ_PASSKEY_TEAM_ID` + `BUZZ_PASSKEY_BUNDLE_ID`
//!    (`aasa_body` in `crates/buzz-relay/src/router.rs`, pinned to
//!    `desktop/src-tauri/aasa.example.json`; Apple caches it ~24h);
//! 2. `com.apple.developer.associated-domains` carries
//!    `webcredentials:<rp-domain>` in the **signed** build
//!    (`desktop/src-tauri/Entitlements.plist` + a provisioning profile with
//!    associated-domains, release-repo work in `buzz-releases`);
//! 3. `BUZZ_PASSKEY_RP_ID=<rp-domain>` at runtime.
//! The ordered checklist — with step 0 `bash scripts/passkey-activation-check.sh`
//! verifying all three plus the live fetch — lives in `commands/passkey.rs`.

#![allow(unsafe_code)]

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::NSApplication;
use objc2_authentication_services::{
    ASAuthorization, ASAuthorizationController, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding, ASAuthorizationError,
    ASAuthorizationErrorDomain, ASAuthorizationPlatformPublicKeyCredentialAssertion,
    ASAuthorizationPlatformPublicKeyCredentialDescriptor,
    ASAuthorizationPlatformPublicKeyCredentialProvider,
    ASAuthorizationPlatformPublicKeyCredentialRegistration,
    ASAuthorizationPublicKeyCredentialAssertion,
    ASAuthorizationPublicKeyCredentialPRFAssertionInput,
    ASAuthorizationPublicKeyCredentialPRFAssertionInputValues,
    ASAuthorizationPublicKeyCredentialPRFRegistrationInput,
    ASAuthorizationPublicKeyCredentialRegistration,
    ASAuthorizationPublicKeyCredentialRegistrationRequest, ASAuthorizationRequest,
    ASPresentationAnchor, ASPublicKeyCredential,
};
use objc2_foundation::{NSArray, NSData, NSError, NSObjectProtocol, NSString};

use crate::commands::{
    base64url, macos_product_version, os_supported_for_version, prf_supported_for_version,
    require_real_rp_id, resolve_rp_id, CreatePasskeyOptions, CreatedPasskeyRef,
    GetPasskeyAssertionOptions, PasskeyCommandError, RawAssertion, RawRegistration, RP_ID_ENV,
};

// Re-export the weak-linked preference constants under the trait-imported
// names used below (`...Constants` holds the `Option<&'static NSString>`s).
use objc2_authentication_services::{
    ASAuthorizationPublicKeyCredentialAttestationKindNone,
    ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired,
};

// ---------------------------------------------------------------------------
// Main-thread dispatch (libSystem GCD).
//
// SAFETY: `dispatch_async_f` and `_dispatch_main_q` are the stable libSystem
// dispatch ABI (`dispatch/queue.h`; `dispatch_get_main_queue()` is the
// documented macro form of `&_dispatch_main_q`). We only take the address of
// the queue object and hand `dispatch_async_f` a unique `Box` context plus an
// `extern "C"` trampoline that re-boxes it. No dispatch object is ever
// dereferenced from Rust.
// ---------------------------------------------------------------------------

#[repr(C)]
struct DispatchQueueOpaque {
    _private: [u8; 0],
}

unsafe extern "C" {
    /// The main queue object; its *address* is the `dispatch_queue_t`.
    static _dispatch_main_q: DispatchQueueOpaque;

    /// Schedule `work(context)` on `queue` and return immediately.
    fn dispatch_async_f(
        queue: *mut DispatchQueueOpaque,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

/// Bounded wait for one platform prompt. The delegate always reports back
/// when the system finishes or cancels the flow; this is the backstop against
/// a platform that never calls back.
const CEREMONY_WAIT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Ceremony plumbing (plain Rust).
// ---------------------------------------------------------------------------

/// What the bridge asks the platform for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CeremonyKind {
    Register,
    Assert,
}

/// Raw bytes one completed platform ceremony handed back.
enum CeremonyOutput {
    Registered {
        raw_id: Vec<u8>,
        attestation_object: Option<Vec<u8>>,
        client_data_json: Vec<u8>,
        prf_output: Option<Vec<u8>>,
    },
    Asserted {
        signature: Vec<u8>,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
        prf_output: Option<Vec<u8>>,
    },
}

type CeremonyResult = Result<CeremonyOutput, PasskeyCommandError>;

/// Everything the main-thread block needs to start one ceremony. Plain,
/// `Send` data only — Objective-C objects are created on the main thread.
struct CeremonyRequest {
    kind: CeremonyKind,
    rp_id: String,
    user_label: String,
    user_id: Vec<u8>,
    prf_salt: Vec<u8>,
    /// Only set on macOS 15.0+; reading the response's `prf` property
    /// anywhere else would message a selector that OS does not have.
    prf_requested: bool,
    challenge: Vec<u8>,
    credential_id: Option<Vec<u8>>,
}

struct CeremonyStart {
    request: CeremonyRequest,
    tx: Sender<CeremonyResult>,
}

// ---------------------------------------------------------------------------
// The delegate + presentation anchor (one Objective-C class).
// ---------------------------------------------------------------------------

struct DelegateIvars {
    kind: CeremonyKind,
    prf_requested: bool,
    /// The anchor window captured at ceremony start; returned to the system
    /// when it asks where to present the prompt.
    anchor: Retained<ASPresentationAnchor>,
    tx: Mutex<Option<Sender<CeremonyResult>>>,
    /// The controller is retained here for the duration of the flow (its
    /// `delegate` reference is weak).
    controller: Mutex<Option<Retained<ASAuthorizationController>>>,
    done: AtomicBool,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. The class stores
    // interior-mutable plain Rust state (`Mutex`, `AtomicBool`) plus a
    // main-thread-only retained anchor, and is `#[thread_kind = MainThreadOnly]`
    // because `ASAuthorizationControllerDelegate` and
    // `ASAuthorizationControllerPresentationContextProviding` are
    // `MainThreadOnly` protocols (their generated supertraits).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    struct CeremonyDelegate;

    unsafe impl NSObjectProtocol for CeremonyDelegate {}

    unsafe impl ASAuthorizationControllerDelegate for CeremonyDelegate {
        // The camelCase names are forced: protocol impls must match the
        // objc2 `extern_protocol!` trait method names verbatim.
        #[allow(non_snake_case)]
        #[unsafe(method(authorizationController:didCompleteWithAuthorization:))]
        fn authorizationController_didCompleteWithAuthorization(
            &self,
            _controller: &ASAuthorizationController,
            authorization: &ASAuthorization,
        ) {
            let ivars = self.ivars();
            let result = extract_output(ivars.kind, ivars.prf_requested, authorization);
            self.finish(result);
        }

        #[allow(non_snake_case)]
        #[unsafe(method(authorizationController:didCompleteWithError:))]
        fn authorizationController_didCompleteWithError(
            &self,
            _controller: &ASAuthorizationController,
            error: &NSError,
        ) {
            self.finish(Err(map_authorization_error(error)));
        }
    }

    unsafe impl ASAuthorizationControllerPresentationContextProviding for CeremonyDelegate {
        #[allow(non_snake_case)]
        #[unsafe(method_id(presentationAnchorForAuthorizationController:))]
        fn presentationAnchorForAuthorizationController(
            &self,
            _controller: &ASAuthorizationController,
        ) -> Retained<ASPresentationAnchor> {
            // Safe: `Retained::clone` retains; the anchor window is kept
            // alive in the ivars until the ceremony is retired.
            self.ivars().anchor.clone()
        }
    }
);

impl CeremonyDelegate {
    /// Mark the flow finished and hand the result to the waiting command.
    /// Sending is the last thing this path does with `self`; the delegate is
    /// retired by the main-thread registry at the NEXT ceremony start (never
    /// inside its own callback — see `retain_in_flight`).
    fn finish(&self, result: CeremonyResult) {
        self.ivars().done.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.ivars().tx.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(result);
            }
        }
    }

    fn is_done(&self) -> bool {
        self.ivars().done.load(Ordering::SeqCst)
    }
}

// Main-thread-only registry of in-flight delegates. The controller's delegate
// reference is weak and the flows are asynchronous, so the delegate must be
// retained until its callback has run; entries are retired (dropped) when the
// NEXT ceremony starts, long after any callback finished. That keeps the
// registry bounded by in-flight flows + 1 and never deallocates an object
// inside its own callback.
thread_local! {
    static IN_FLIGHT: RefCell<Vec<Retained<CeremonyDelegate>>> = const { RefCell::new(Vec::new()) };
}

fn retain_in_flight(delegate: Retained<CeremonyDelegate>) {
    IN_FLIGHT.with(|list| {
        let mut list = list.borrow_mut();
        list.retain(|entry| !entry.is_done());
        list.push(delegate);
    });
}

// ---------------------------------------------------------------------------
// Entry points — the `PasskeyCeremony` implementation surface.
// ---------------------------------------------------------------------------

/// One registration ceremony (web `performCreate` with `prf.eval.first`).
///
/// Request shape is web-identical: random 32-byte challenge, random 16-byte
/// user id, `userVerification = required`, `attestation = none`, platform
/// passkey (ES256), and PRF `eval.first = prf_salt` on macOS 15.0+. The RP id
/// is `options.rp_id` → `BUZZ_PASSKEY_RP_ID` → refused loudly.
///
/// `options.rp_name` (web's `rp.name`) has no native equivalent: the
/// `AuthenticationServices` provider takes only `initWithRelyingPartyIdentifier:`
/// and the prompt labels come from the associated domain, so the value is
/// accepted for call-shape parity and not forwarded.
pub(crate) fn register(
    options: &CreatePasskeyOptions,
    prf_salt: &[u8],
) -> Result<RawRegistration, PasskeyCommandError> {
    let version = macos_product_version();
    if !os_supported_for_version(version) {
        return Err(PasskeyCommandError::Environment {
            message: format!(
                "Apple's passkey APIs need macOS 12.0 or later — this Mac reports {}. Nothing was created.",
                version_label(version)
            ),
        });
    }
    let rp_id = resolve_rp_id(options.rp_id.as_deref(), std::env::var(RP_ID_ENV).ok());
    require_real_rp_id(&rp_id)?;
    let request = CeremonyRequest {
        kind: CeremonyKind::Register,
        rp_id: rp_id.clone(),
        user_label: options.user_label.clone(),
        user_id: random_nonce(16)?,
        prf_salt: prf_salt.to_vec(),
        prf_requested: prf_supported_for_version(version),
        challenge: random_nonce(32)?,
        credential_id: None,
    };
    match run_ceremony(request)? {
        CeremonyOutput::Registered {
            raw_id,
            attestation_object,
            client_data_json,
            prf_output,
        } => {
            let attestation_object = attestation_object.ok_or_else(|| {
                // The credential exists but carries no attestation object, so
                // the secp256r1 owner root cannot be derived — refuse loudly
                // with the credential ref so nothing is silently orphaned.
                PasskeyCommandError::Attestation {
                    message: "the passkey ceremony returned no attestation object, so the secp256r1 owner key cannot be derived — the credential was created but is not usable as an identity.".to_string(),
                    created: Some(CreatedPasskeyRef {
                        credential_id: base64url(&raw_id),
                        r1_uncompressed_hex: None,
                    }),
                }
            })?;
            Ok(RawRegistration {
                raw_id,
                prf_output_at_create: prf_output,
                attestation_object,
                rp_id,
                client_data_json,
            })
        }
        CeremonyOutput::Asserted { .. } => Err(PasskeyCommandError::Failed {
            message: "internal: the registration ceremony returned an assertion".to_string(),
        }),
    }
}

/// One assertion ceremony (web `performGet`). The challenge is the caller's
/// `challenge` bytes when given (the UserOp hash) and a random nonce
/// otherwise; PRF `eval.first = prf_salt` is requested only when both the OS
/// supports PRF and the caller passed a salt.
pub(crate) fn assert(
    options: &GetPasskeyAssertionOptions,
) -> Result<RawAssertion, PasskeyCommandError> {
    let version = macos_product_version();
    if !os_supported_for_version(version) {
        return Err(PasskeyCommandError::Environment {
            message: format!(
                "Apple's passkey APIs need macOS 12.0 or later — this Mac reports {}. Nothing was signed or created.",
                version_label(version)
            ),
        });
    }
    let rp_id = resolve_rp_id(options.rp_id.as_deref(), std::env::var(RP_ID_ENV).ok());
    require_real_rp_id(&rp_id)?;
    let prf_requested = prf_supported_for_version(version) && options.prf_salt.is_some();
    let request = CeremonyRequest {
        kind: CeremonyKind::Assert,
        rp_id: rp_id.clone(),
        user_label: String::new(),
        user_id: Vec::new(),
        prf_salt: options.prf_salt.clone().unwrap_or_default(),
        prf_requested,
        challenge: match &options.challenge {
            Some(challenge) => challenge.clone(),
            None => random_nonce(32)?,
        },
        credential_id: Some(decode_credential_id(&options.credential_id)?),
    };
    match run_ceremony(request)? {
        CeremonyOutput::Asserted {
            signature,
            authenticator_data,
            client_data_json,
            prf_output,
        } => Ok(RawAssertion {
            signature,
            authenticator_data,
            client_data_json,
            prf_output,
        }),
        CeremonyOutput::Registered { .. } => Err(PasskeyCommandError::Failed {
            message: "internal: the assertion ceremony returned a registration".to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Dispatch + wait.
// ---------------------------------------------------------------------------

fn run_ceremony(request: CeremonyRequest) -> Result<CeremonyOutput, PasskeyCommandError> {
    let (tx, rx) = channel::<CeremonyResult>();
    let start = Box::new(CeremonyStart { request, tx });
    // SAFETY: `Box::into_raw` hands over a unique, fully initialized pointer
    // that is consumed exactly once by `start_on_main` below; nothing else
    // reads it. The `extern "C"` ABI matches `dispatch_async_f`'s contract.
    unsafe {
        dispatch_async_f(
            std::ptr::addr_of!(_dispatch_main_q).cast_mut().cast(),
            Box::into_raw(start).cast(),
            start_trampoline,
        );
    }
    match rx.recv_timeout(CEREMONY_WAIT) {
        Ok(result) => result,
        Err(_) => Err(PasskeyCommandError::Failed {
            message: "the passkey ceremony did not complete within 2 minutes — dismiss any open prompt and try again.".to_string(),
        }),
    }
}

extern "C" fn start_trampoline(context: *mut c_void) {
    // SAFETY: `context` is the unique `Box` pointer from `run_ceremony`; this
    // trampoline is its single documented consumer.
    let start = unsafe { Box::from_raw(context.cast::<CeremonyStart>()) };
    match MainThreadMarker::new() {
        Some(mtm) => build_and_perform(mtm, *start),
        None => {
            let _ = start.tx.send(Err(PasskeyCommandError::Failed {
                message: "internal: the passkey ceremony started off the main thread".to_string(),
            }));
        }
    }
}

// ---------------------------------------------------------------------------
// Request building + presentation (main thread).
// ---------------------------------------------------------------------------

fn build_and_perform(mtm: MainThreadMarker, start: CeremonyStart) {
    let CeremonyStart { request, tx } = start;
    let app = NSApplication::sharedApplication(mtm);
    let anchor = match app.keyWindow().or_else(|| app.windows().firstObject()) {
        Some(window) => window,
        None => {
            let _ = tx.send(Err(PasskeyCommandError::Failed {
                message: "no window is available to present the passkey prompt over — open the Buzz window and try again. Nothing was created.".to_string(),
            }));
            return;
        }
    };
    // Safe upcast: NSWindow -> NSResponder -> NSObject (`ASPresentationAnchor`
    // is `NSObject` in `objc2-authentication-services`; the framework only
    // treats it as a window anchor). The compiler checks each `Super` step.
    let anchor: Retained<ASPresentationAnchor> = anchor.into_super().into_super();

    // SAFETY: the provider/request/controller APIs are used exactly as
    // declared in the framework headers; the objects are created, messaged
    // and retained on the main thread and the response types are downcast
    // with a class check (`Retained::downcast`) before any field is read.
    let (delegate, controller) = unsafe {
        let rp = NSString::from_str(&request.rp_id);
        let provider =
            ASAuthorizationPlatformPublicKeyCredentialProvider::initWithRelyingPartyIdentifier(
                mtm.alloc(),
                &rp,
            );
        let challenge = NSData::with_bytes(&request.challenge);
        let request_obj: Retained<ASAuthorizationRequest> = match request.kind {
            CeremonyKind::Register => {
                let name = NSString::from_str(&request.user_label);
                let user_id = NSData::with_bytes(&request.user_id);
                let registration = provider
                    .createCredentialRegistrationRequestWithChallenge_name_userID(
                        &challenge, &name, &user_id,
                    );
                // Web parity: userVerification "required", attestation "none".
                if let Some(preference) =
                    ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired
                {
                    registration.setUserVerificationPreference(preference);
                }
                if let Some(kind) = ASAuthorizationPublicKeyCredentialAttestationKindNone {
                    registration.setAttestationPreference(kind);
                }
                if request.prf_requested {
                    let values = ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::initWithSaltInput1_saltInput2(
                        mtm.alloc(),
                        &NSData::with_bytes(&request.prf_salt),
                        None,
                    );
                    let prf =
                        ASAuthorizationPublicKeyCredentialPRFRegistrationInput::initWithInputValues(
                            mtm.alloc(),
                            Some(&values),
                        );
                    registration.setPrf(Some(&prf));
                }
                registration.into_super()
            }
            CeremonyKind::Assert => {
                let assertion = provider.createCredentialAssertionRequestWithChallenge(&challenge);
                if let Some(raw_id) = &request.credential_id {
                    let descriptor =
                        ASAuthorizationPlatformPublicKeyCredentialDescriptor::initWithCredentialID(
                            mtm.alloc(),
                            &NSData::with_bytes(raw_id),
                        );
                    assertion.setAllowedCredentials(&NSArray::from_retained_slice(&[descriptor]));
                }
                if request.prf_requested {
                    let values = ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::initWithSaltInput1_saltInput2(
                        mtm.alloc(),
                        &NSData::with_bytes(&request.prf_salt),
                        None,
                    );
                    let prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput::initWithInputValues_perCredentialInputValues(
                        mtm.alloc(),
                        Some(&values),
                        None,
                    );
                    assertion.setPrf(Some(&prf));
                }
                assertion.into_super()
            }
        };
        let requests = NSArray::from_retained_slice(&[request_obj]);
        let controller =
            ASAuthorizationController::initWithAuthorizationRequests(mtm.alloc(), &requests);
        let delegate: Retained<CeremonyDelegate> = {
            let this = mtm.alloc::<CeremonyDelegate>().set_ivars(DelegateIvars {
                kind: request.kind,
                prf_requested: request.prf_requested,
                anchor,
                tx: Mutex::new(Some(tx)),
                controller: Mutex::new(None),
                done: AtomicBool::new(false),
            });
            // NSObject's designated initializer on our freshly allocated
            // subclass instance.
            msg_send![super(this), init]
        };
        controller.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        controller.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*delegate)));
        if let Ok(mut slot) = delegate.ivars().controller.lock() {
            *slot = Some(controller.clone());
        }
        (delegate, controller)
    };

    // Retain the delegate (+ its controller) before the flow can call back,
    // then start it.
    retain_in_flight(delegate);
    // SAFETY: message send on the main thread; the controller, its request
    // and its delegate are all retained for the flow's duration.
    unsafe { controller.performRequests() };
}

// ---------------------------------------------------------------------------
// Response extraction + error mapping.
// ---------------------------------------------------------------------------

fn extract_output(
    kind: CeremonyKind,
    prf_requested: bool,
    authorization: &ASAuthorization,
) -> CeremonyResult {
    // SAFETY: `authorization` is the framework's completion object, read on
    // the main thread inside the delegate callback.
    let credential = unsafe { authorization.credential() };
    match kind {
        CeremonyKind::Register => {
            let registration = credential
                .downcast::<ASAuthorizationPlatformPublicKeyCredentialRegistration>()
                .map_err(|_| unexpected_credential())?;
            // SAFETY: message sends on a class-checked registration object
            // (downcast above), all on the main thread inside the delegate
            // callback.
            unsafe {
                let raw_id = registration.credentialID().to_vec();
                let client_data_json = registration.rawClientDataJSON().to_vec();
                let attestation_object = registration
                    .rawAttestationObject()
                    .map(|data| data.to_vec());
                let prf_output = if prf_requested {
                    registration
                        .prf()
                        .and_then(|output| output.first())
                        .map(|data| data.to_vec())
                } else {
                    None
                };
                Ok(CeremonyOutput::Registered {
                    raw_id,
                    attestation_object,
                    client_data_json,
                    prf_output,
                })
            }
        }
        CeremonyKind::Assert => {
            let assertion = credential
                .downcast::<ASAuthorizationPlatformPublicKeyCredentialAssertion>()
                .map_err(|_| unexpected_credential())?;
            // SAFETY: message sends on a class-checked assertion object
            // (downcast above), all on the main thread inside the delegate
            // callback.
            unsafe {
                let signature = assertion.signature().to_vec();
                let authenticator_data = assertion.rawAuthenticatorData().to_vec();
                let client_data_json = assertion.rawClientDataJSON().to_vec();
                let prf_output = if prf_requested {
                    assertion.prf().map(|output| output.first().to_vec())
                } else {
                    None
                };
                Ok(CeremonyOutput::Asserted {
                    signature,
                    authenticator_data,
                    client_data_json,
                    prf_output,
                })
            }
        }
    }
}

fn unexpected_credential() -> PasskeyCommandError {
    PasskeyCommandError::Failed {
        message: "the passkey platform returned a credential of an unexpected type".to_string(),
    }
}

fn map_authorization_error(error: &NSError) -> PasskeyCommandError {
    // SAFETY: reading the framework's exported error-domain constant and the
    // NSError accessors; both are immutable Objective-C objects.
    let (is_platform_error, code, description) = unsafe {
        let is_platform_error =
            error.domain().to_string() == ASAuthorizationErrorDomain.to_string();
        (
            is_platform_error,
            error.code(),
            error.localizedDescription().to_string(),
        )
    };
    if is_platform_error && code == ASAuthorizationError::Canceled.0 {
        // Web's `NotAllowedError` explanation, verbatim — a dismissed or
        // timed-out prompt is the common case and the copy is already proven.
        return PasskeyCommandError::Failed {
            message: "The passkey prompt was dismissed or timed out — nothing was created. Try again and complete the touch.".to_string(),
        };
    }
    if is_platform_error && code == ASAuthorizationError::DeviceNotConfiguredForPasskeyCreation.0 {
        return PasskeyCommandError::Failed {
            message: "This Mac is not set up to create or use passkeys (Touch ID / passkey support is unavailable) — nothing was created.".to_string(),
        };
    }
    PasskeyCommandError::Failed {
        message: if description.is_empty() {
            "the passkey ceremony failed without a platform explanation".to_string()
        } else {
            description
        },
    }
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

fn random_nonce(len: usize) -> Result<Vec<u8>, PasskeyCommandError> {
    let mut nonce = vec![0u8; len];
    getrandom::getrandom(&mut nonce).map_err(|error| PasskeyCommandError::Failed {
        message: format!("could not generate a ceremony nonce: {error}"),
    })?;
    Ok(nonce)
}

fn version_label(version: Option<(u32, u32, u32)>) -> String {
    version
        .map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .unwrap_or_else(|| "an unknown version".to_string())
}

/// Web's `b64urlDecode` semantics for the stored credential id: either
/// base64url alphabet, padded or not.
fn decode_credential_id(value: &str) -> Result<Vec<u8>, PasskeyCommandError> {
    use base64::Engine;
    let normalized = value.replace('-', "+").replace('_', "/");
    let padding = "=".repeat((4 - (normalized.len() % 4)) % 4);
    let padded = format!("{normalized}{padding}");
    base64::engine::general_purpose::STANDARD
        .decode(padded)
        .map_err(|error| PasskeyCommandError::Failed {
            message: format!("credentialId is not valid base64url: {error}"),
        })
}
