# desktop/src-tauri

## Identity — deliberate fresh start

The desktop app identifies itself as `xyz.block.creaton.app`
(`xyz.block.creaton.app.dev` in debug builds, `xyz.block.creaton.app.demo.<slug>`
for named demo builds) and stores OS-keyring entries under the
`creaton-desktop` service (`creaton-desktop-dev`, `creaton-desktop-demo.<slug>`
variants).

This rename is a **fresh start by design**: there is no data or key migration
from the previous `xyz.block.buzz.app` install. On first launch the app creates
a new identity and a new data directory
(`~/Library/Application Support/xyz.block.creaton.app` on macOS — Tauri's
`app_data_dir` is `data_dir()/<identifier>`, so the directory follows the
bundle identifier automatically). Any old `xyz.block.buzz.app` data directory
and old `buzz-desktop` keyring entry are left untouched on disk/Keychain and
simply ignored.

The passkey key-derivation string `buzz-nostr-v1` and the `buzz.*` storage keys
are intentionally unchanged: they are key material/storage formats, not
product identifiers.
