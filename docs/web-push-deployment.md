# Web push and the sponsored-fee limit: what an operator sets

Two optional services of the relay, both **off unless the operator names what they need**. Neither is on in a plain
deployment. Nothing here is a secret that belongs in a file: every key is read from the environment of the running relay
and is never written to disk, logged, answered or shown in an error.

Read it against `crates/buzz-relay/src/web_push/settings.rs` and `crates/buzz-relay/src/api/sponsor.rs`, which are the
code that reads these settings.

## 1. Alerts to a device that has not opened the app (web push)

A holder who has not opened the app can get one short message when a task on a project they back is **planned**, **taken**
or **ended**. The message says only that there is news; the app has the words, the amounts and the way out.

### Settings

| Variable | Meaning |
|---|---|
| `BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY` | Your own VAPID signing key: a P-256 private key, its 32 bytes written as base64url. Make a new one for this deployment; do not reuse a key from anywhere else. |
| `BUZZ_WEB_PUSH_SUBJECT` | Your own contact for the push services: a `mailto:` address or an `https:` address. It is the `sub` of the VAPID token and what a push service uses to reach you if something goes wrong. Not this project's, yours. |
| `BUZZ_WEB_PUSH_DAILY_CAP` | Optional. Alerts per device per UTC day. Default 6, from 1 to 50. |
| `BUZZ_WEB_PUSH_MAX_PER_ACCOUNT` | Optional. Devices per account. Default 5, from 1 to 20. |
| `BUZZ_WEB_PUSH_EXTRA_HOSTS` | Optional. Comma-separated exact `host` or `host:port` entries allowed as push addresses **in addition** to the known push services. **For a local stand-in only**; empty by default. A listed host may be plain `http` and may resolve to a private address, so never list a host you do not control. |

Both of the first two, or neither. One without the other, or any other `BUZZ_WEB_PUSH_*` setting without them, **stops the
relay at start** with a message that names both. Push also needs the chain reader (`BUZZ_CHAIN_RPC_URL`): alerts are made
from the chain's own task rows, so push without it stops the relay at start too.

With neither set push is **off**: the information document has no `webPush` key, `PUT` and `DELETE /push/web` answer 404
"not switched on", the sender is not started and the tables are never written.

The public half of the key is derived and is the only thing published: `GET /info` carries
`"webPush": {"publicKey": "<base64url, 65 bytes>"}`, which the app subscribes with. The information document also carries
`"smartAccountLinks": true|false` whenever a chain reader is configured: `true` when `BUZZ_EVM_AUTH` and
`BUZZ_EVM_RPC_URL` are both set, so the server can check a phone account's wallet link. The app reads it to say plainly
that rooms and alerts are not switched on for phone accounts on a server that cannot.

### Making a key

Any tool that makes a P-256 private key works. For example, with `openssl`:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out /dev/stdout 2>/dev/null \
  | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | basenc --base64url | tr -d '='
```

(prints 43 characters). Put the result in the relay's secret store, not in a file in the repository, and not in a chat.

### What is stored about a device, and how a person removes it

`web_push_subscriptions` keeps, per device: the account, the push address the browser made for that device, the browser's
two public values (`p256dh` and `auth`), the time it was kept and when it expires (90 days; the app asks again when a
device is opened and the row is older than 30 days). **Nothing else**: no user agent, no address of the person, no label,
no project, **no wallet** (the wallet is looked up when an alert is made, never kept with the device), no list of what the
person holds.

The person removes their rows any time: the app's "Turn off" calls `DELETE /push/web` and the browser's own
`unsubscribe()`. A push service answering "gone" (404 or 410) deletes the row. An expired row is swept hourly. At most
`BUZZ_WEB_PUSH_MAX_PER_ACCOUNT` live rows per account; the oldest goes first.

### The two paths

Both are signed per request with the person's own key (NIP-98: the method, the address and the body's hash are signed, and
a request cannot be played twice), and resolved to a community by host like every API of the relay. At most 10 requests an
hour per account.

- `PUT /push/web`, body `{"endpoint": "...", "keys": {"p256dh": "...", "auth": "..."}}` exactly as a browser's
  `PushSubscription.toJSON()` gives it. Keeps the device (or renews it if the account already has that address).
- `DELETE /push/web`, body `{"endpoint": "..."}` removes that device; no body removes every device of the account.

A subscription is a bearer capability (the address that lets anyone send to that device), which is why it is a signed HTTP
call and not a stored, public event.

The relay refuses an address that is not `https`, is longer than 512 characters, carries a name or a password, or whose
host is not one of the known push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`,
`*.push.apple.com`, `*.notify.windows.com`) or on the operator's list; and a device key that is not a point on the P-256
curve. **When a message is sent the host is resolved again, an address that is private, loopback, link-local or otherwise
not public is refused (unless that exact host is on the operator's list), and the connection is made to the address that
passed.** No redirect is followed.

### What is sent, to whom, and when

- **Only from the chain.** An alert is made from the chain reader's stored (final) task rows: `TaskAnnounced` is
  `planned`, `TaskTaken` is `taken`, `TaskResolved` is `ended` (paid, sent back, lapsed or run out alike). A plan that was
  withdrawn before anyone took it moved nothing and makes no alert (the withdrawal makes none, and a plan whose withdrawal the
  reader has already stored when it reads the plan makes none either; a plan that was alerted and is withdrawn later is not
  taken back). Nothing anyone writes can make an alert.
- **Never history.** The first time push is switched on, the position is set to the reader's next block. Nothing before it
  is alerted. A row more than 24 hours older than the newest block the reader has stored is dropped.
- **To holders who proved their wallet.** The accounts that hold at least 0.001 Share (backer Shares or Team Shares) of
  the project, largest first, at most 2,000 per alert (the rest are counted and have the in-app alert only), mapped to the
  accounts that linked that wallet with a verified wallet link, mapped to their live devices. A device cannot name a wallet
  or a project, so it cannot be used to ask "does X hold here?".
- **Caps.** At most `BUZZ_WEB_PUSH_DAILY_CAP` alerts per device per UTC day and 3 per project per device per day. The rest
  are written as `dropped` with the reason, never silently skipped.
- **The message** is at most 200 bytes: `{"v":1,"k":"planned"|"taken"|"ended","r":"<project link ref>"}`. No amount, no name,
  no date and no project name. It is encrypted to the device (RFC 8291, `aes128gcm`, a fresh key and salt per message) and
  signed for the push service (RFC 8292, VAPID). Headers: `TTL: 86400`, `Urgency: normal`, and a `Topic` of 32 characters
  that is a keyed hash for that device (so a later alert about the same task replaces one the device has not received yet,
  no two devices share a topic, and a push service cannot work a topic back to a project).

### What a push service sees

Said plainly: **a push service sees which devices are notified together, and when.** It sees an encrypted message and a
per-device keyed topic, never a name or an amount, but timing is visible to it: two devices that are notified at the same
moment about the same alert are visible as such. Tell your users this if they ask what push reveals.

### Delivery, retries and the end of a row

`web_push_outbox` keeps one row per alert and device. The sender is its **own supervised task** (never inside the chain
reader's pass), so a push outage can never stall the reader or a Take out. One sender runs at a time per deployment (a
session advisory lock of its own); a second replica idles and takes over when the first is gone.

| Answer | Row |
|---|---|
| `2xx` (a push service answers `201`) | `delivered` |
| `404`, `410` | `gone`: the device is deleted, its rows with it |
| `429`, any `5xx`, a network error, a timeout (10 s) | retried with a pause of 60 s x 2^(attempts - 1), at most 6 hours; a `Retry-After` is honoured up to that cap; **after 8 attempts the row ends as `failed`** |
| `401`, `403` | the operator's key or contact was refused: retried; a warning names the host; **after 3 such answers in a row from different devices the whole sender pauses 15 minutes** (one error line, once) so a wrong key does not spend every device's day |
| `413` and any other `4xx` | `failed` at once |

Rows are claimed with a 30-second lease, so a sender that stopped leaves rows another claims. Delivered, gone and dropped
rows are kept 7 days (the daily cap counts them), failed rows 30 days, then swept. A chain rollback below an alert's block
deletes that alert's rows that have not left the server.

Metrics: `buzz_web_push_alerts_total`, `buzz_web_push_alert_errors_total`, `buzz_web_push_sent_total{result}`.

### What is not proven

No real push service (Chrome's, Firefox's, Apple's) and no real device is used in any test of this repository; the
encryption is proven against RFC 8291 appendix A and the VAPID token against RFC 8292's example. Whether those services
accept this sender is the **first human test**. On an iPhone, web push works only for an app added to the Home Screen.

## 2. The sponsored-fee limit: `POST /sponsor`

A phone account (a passkey with no wallet app) has its network fee paid by a sponsor. Nothing in the repository limited
that. `POST /sponsor` is a thin service the relay runs **in front of your own sponsor**.

### Settings

| Variable | Meaning |
|---|---|
| `BUZZ_SPONSOR_UPSTREAM_URL` | Your real sponsor (the JSON-RPC address that answers `zd_sponsorUserOperation`). It may carry a key in its address: it is read from the environment, never written down and never logged or answered. **Without it the path does not exist.** |
| `BUZZ_SPONSOR_PER_ACCOUNT_PER_DAY` | Optional. Ordinary operations per sender per UTC day. Default 10. |
| `BUZZ_SPONSOR_TOTAL_PER_DAY` | Optional. Ordinary operations for the whole deployment per UTC day. Default 1,000 (a new passkey is a new account, so a per-account limit alone can be farmed). |
| `BUZZ_SPONSOR_PER_IP_PER_DAY` | Optional. Ordinary operations per client address per UTC day. Default 40. The address is the last entry of `X-Forwarded-For` (put the relay behind a proxy that writes it); a shared carrier address can reach this limit. |
| `BUZZ_SPONSOR_EXIT_PER_IP_PER_DAY` | Optional. Exits per client address per UTC day. Default 200. |

Any of the four limits without the upstream, or the upstream without the chain reader (`BUZZ_CHAIN_RPC_URL`), stops the
relay at start. Then set the app's `VITE_CREATON_SPONSOR_URL` to `https://<this server>/sponsor`: the app accepts it
because it carries no key.

### What it does

- **An exit is never limited by a person or by the server.** The operation's call data is read; an operation is an exit
  when every call goes to a Treasury this reader follows and is `leave` or `leaveTeam` with no native value. Exits count
  against **one per-address cap only**, which an attacker spends on their own address. There is no per-sender and no
  server-wide cap on exits. Reason: the `sender` inside the request is not authenticated, so a limit in front of exits
  would let anyone name a victim's address and stop them taking their money out.
- **The request is pinned.** Only the method `zd_sponsorUserOperation`, on the chain the reader reads, one operation per
  request, a body of at most 32 KB, no batch. Anything else is refused with "not allowed". Without this the path would be an
  open proxy to your keyed upstream.
- **Every other operation** (a Back, a claim, a send) counts per sender, per address and for the whole deployment, per UTC
  day, and every call's target must be a contract the reader follows, the dollar token or the Launcher. A request reserves
  its count in the statement that checks it and **gives it back when the upstream refuses, fails or cannot be reached**.
- **A refusal is worded for the app**: a JSON-RPC error answered with HTTP 200 whose message is "daily limit exceeded" for
  the three limits and "not allowed" for the pins and the allow-list (the app turns a message holding `polic`, `denied`,
  `forbid`, `unauthor`, `not allowed`, `exceed` or `quota` into plain words, and does not retry a 200).

### A limit that stays, said plainly

Because the sender is not authenticated, ten requests naming a victim's address use up that person's day **for Back and the
like, not for exits**. That is accepted: a Back can be made from a wallet, one attacker's reach is bounded by the per-address
limit, and the limit exists to cap your spend. An authenticated sponsor is the later fix.

### Your own sponsor's cap is the last backstop

Keep a spend cap at your own sponsor too. This service limits what the relay passes on; the exit allowance (the per-address
exit cap) is deliberately generous, and your sponsor's own cap is what bounds the worst case of everything the relay lets
through.

Metrics: `buzz_sponsor_refused_total{why}`. Counts are in the table `sponsor_usage` (a row per day and key).
