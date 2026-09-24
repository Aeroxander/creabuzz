// Cross-implementation compatibility proof: the Rust shared core
// (crates/buzz-client-core via flutter_rust_bridge) is payload-compatible
// with the Dart implementation in shared/crypto/nip44.dart — in both
// directions. This is the seam that lets the hand-rolled Dart crypto be
// deleted in favor of the shared Rust core.
//
// Requires the host library to be built first:
//   cargo build -p buzz-client-core
// then:
//   cd mobile && flutter test test/rust_nip44_interop_test.dart

import 'dart:io';

import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart'
    show ExternalLibrary;
import 'package:flutter_test/flutter_test.dart';

import 'package:buzz/shared/crypto/ecdh.dart' show bytesToHex;
import 'package:buzz/shared/crypto/nip44.dart' as dart_nip44;
import 'package:buzz/src/rust/api.dart' as rust_nip44;
import 'package:buzz/src/rust/frb_generated.dart';

/// Official NIP-44 vector case (sec1, pub2, conversation_key) from
/// crates/buzz-client-core/tests/data/nip44.vectors.json.
const _sec1Hex =
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364139';
const _pub2Hex =
    '0000000000000000000000000000000000000000000000000000000000000002';
const _expectedConversationKeyHex =
    '8b6392dbf2ec6a2b2d5b1477fc2be84d63ef254b667cadd31bd3f444c44ae6ba';

void main() {
  setUpAll(() async {
    final dylibPath =
        '${Directory.current.parent.path}/target/debug/libbuzz_client_core.dylib';
    await RustLib.init(externalLibrary: ExternalLibrary.open(dylibPath));
  });

  test('rust and dart derive identical conversation keys', () {
    final rustKey = rust_nip44.getConversationKey(
      senderSecretHex: _sec1Hex,
      receiverPublicHex: _pub2Hex,
    );
    final dartKey = dart_nip44.getConversationKey(_sec1Hex, _pub2Hex);

    // Both match the official NIP-44 vector, and each other.
    expect(bytesToHex(rustKey), _expectedConversationKeyHex);
    expect(bytesToHex(dartKey), _expectedConversationKeyHex);
  });

  test('rust decrypts payloads encrypted by the dart implementation', () {
    final key = dart_nip44.getConversationKey(_sec1Hex, _pub2Hex);
    const plaintext = 'Dart → Rust interop 🐝';

    final payload = dart_nip44.nip44Encrypt(key, plaintext);

    expect(
      rust_nip44.nip44Decrypt(conversationKey: key, payloadBase64: payload),
      plaintext,
    );
  });

  test('dart decrypts payloads encrypted by the rust implementation', () {
    final key = rust_nip44.getConversationKey(
      senderSecretHex: _sec1Hex,
      receiverPublicHex: _pub2Hex,
    );
    const plaintext = 'Rust → Dart interop 🦀';

    final payload = rust_nip44.nip44Encrypt(
      conversationKey: key,
      plaintext: plaintext,
    );

    expect(dart_nip44.nip44Decrypt(key, payload), plaintext);
  });
}
