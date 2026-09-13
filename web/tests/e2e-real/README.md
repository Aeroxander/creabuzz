# Real-relay tests

These run the built client against an actual relay — real WebSocket auth, real
event ingest, real Postgres reads — instead of the mocked relay the default
suite uses. That is the difference between "the app's logic is right" and "the
app works".

Setup (macOS/Linux, Postgres and Redis already running):

```bash
# 1. A database of its own, so a developer's dev database is untouched.
psql postgres://buzz:buzz_dev@localhost:5432/postgres -c 'create database buzz_web_verify'

# 2. Build the client and the relay.
pnpm -C web build
cargo build -p buzz-relay

# 3. Run the relay with the migration set applied from scratch, serving the
#    client, on free ports (a dev relay may already own 3000/8080/9102).
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz_web_verify \
BUZZ_AUTO_MIGRATE=true BUZZ_BIND_ADDR=0.0.0.0:3199 BUZZ_RELAY_URL=ws://localhost:3199 \
BUZZ_HEALTH_PORT=8181 BUZZ_METRICS_PORT=9199 BUZZ_WEB_DIR=./web/dist BUZZ_WEB_SPA=full \
BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
./target/debug/buzz-relay

# 4. Seed the community host and relay membership (fail-closed host binding).
psql postgres://buzz:buzz_dev@localhost:5432/buzz_web_verify -f web/tests/e2e-real/seed.sql

# 5. Create the channel through the relay. Channel discovery metadata
#    (kind:39000) is relay-authored, so a channel inserted straight into
#    Postgres has no discovery event and no client ever sees it.
node web/tests/e2e-real/create-channel.mjs general

# 6. Run the tests.
pnpm -C web test:e2e:real
```

The relay rate-limits writes per identity in two windows: a per-minute message
quota and a short burst quota on websocket events (defaults 60/min and 10/s). The
web client is chatty by design — a channel view opens several subscriptions and
polls — so the fixture raises both above. When a refusal does appear it arrives as
a toast ("rate-limited: quota exceeded; retry in 2s") that then *covers* whatever
the test wants to click, which is worth knowing before reading a three-minute
click timeout as a product bug.

Channel creation has its own limit: a re-run of `create-channel.mjs` right after
a previous one is refused with `rate-limited: quota exceeded; retry in 28s`, which
is why that script treats "already exists" as success and reports anything else.

The relay serves NIP-11 JSON at `/` unless the request asks for HTML, which a
browser does — a plain `curl /` is not the app.

## Assertion pitfall

`getByText` also matches a textbox's value, so `await fill(body)` followed by
`expect(page.getByText(body)).toBeVisible()` passes even when the send never
left the browser. Assert on rendered text instead:

```ts
await expect
  .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
  .toContain(body);
```

`innerText` excludes form values, so a message can only match once the relay
has stored it and sent it back.
