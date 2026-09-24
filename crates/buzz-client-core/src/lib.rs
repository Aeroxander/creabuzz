//! Shared, side-effect-free client core for Buzz clients.
//!
//! `buzz-client-core` consolidates per-platform re-implementations of
//! protocol logic (starting with NIP-44 v2 encryption) into one pure Rust
//! crate shared by every client surface:
//!
//! - desktop: linked directly into the Tauri backend,
//! - web: compiled to WebAssembly,
//! - mobile: consumed by the Flutter app through `flutter_rust_bridge`.
//!
//! The crate performs no I/O and holds no state; all randomness is drawn by
//! the underlying `nostr` implementation at call time. Keeping it pure is
//! what makes the same logic portable to every target and cheap to test.
#![deny(unsafe_code)]

// Generated FFI glue (flutter_rust_bridge); the only `unsafe` in the crate.
#[allow(unsafe_code)]
mod frb_generated;

pub mod api;

pub use api::{get_conversation_key, nip44_decrypt, nip44_encrypt, ClientCoreError};
