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

# 4. Seed the community host the client will use, a channel, and membership for
#    the repo's documented dev test identity (Tyler).
psql postgres://buzz:buzz_dev@localhost:5432/buzz_web_verify -f web/tests/e2e-real/seed.sql

# 5. Run the tests.
pnpm -C web test:e2e:real
```

The relay serves NIP-11 JSON at `/` unless the request asks for HTML, which a
browser does — a plain `curl /` is not the app.
