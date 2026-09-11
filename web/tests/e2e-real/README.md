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

The dev relay rate-limits writes per identity (channel creation and messages),
so a burst of sends can be accepted late; the round-trip test is marked slow for
that reason.

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
