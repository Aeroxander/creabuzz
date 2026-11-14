# Error reporting (web app)

The web app can tell you when it breaks. It is **off unless you turn it on**, and it sends as little as it can.

## Turning it on

Build the app with the address of a collector you run (or a service you choose) that accepts a JSON `POST`:

```bash
VITE_ERROR_REPORT_URL=https://errors.example.com/creaton VITE_APP_RELEASE=2026.10.13 pnpm build
```

Only `https` addresses are accepted (and plain `http` for a collector on this machine, for testing). Anything else leaves reporting
off. `VITE_APP_RELEASE` is optional: any short label for the build, so a note says which build it came from.

## What the collector must answer

The note is sent from the site's own address to the collector's, as JSON, so the browser first asks the collector whether it
may (a CORS preflight). A collector that does not answer it gets nothing, and nobody is told: the app never waits for a
reply.

- `OPTIONS` on the collector's address answers `204` (or `200`) with `Access-Control-Allow-Origin: https://<your site>`,
  `Access-Control-Allow-Methods: POST` and `Access-Control-Allow-Headers: Content-Type`.
- `POST` answers with the same `Access-Control-Allow-Origin`. The request carries no cookies, so
  `Access-Control-Allow-Credentials` is not needed (and `*` as the origin works too, for a collector that takes notes from
  anywhere).

Check it from any machine before you build with it:

```bash
curl -si -X OPTIONS https://errors.example.com/creaton \
  -H 'Origin: https://<your site>' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' | grep -i '^access-control'
```

Then trigger an error on the built site (for example `setTimeout(() => { throw new Error("test report") })` in the
browser console) and look for the note at the collector.

## What is sent

One small JSON note per error, with exactly these fields and nothing else:

```json
{ "kind": "error", "message": "…", "stack": "…", "page": "/launchpad", "at": 1760350000, "release": "2026.10.13" }
```

- `kind`: `error` (an uncaught error), `rejection` (a promise that failed with nobody listening), `render` (a screen that crashed and
  showed "Something went wrong"), or `handled`: a failure the screen showed in words but that only you can fix. Its `message` starts
  with the cause, then the technical words the person did not see:
  - `sponsor-refused`: the ZeroDev paymaster refused to pay a passkey step's fee (the gas policy's spending limit is spent, or the
    policy does not cover that operation). Every passkey step fails until you fix the policy in the ZeroDev dashboard.
  - `sponsor-failed-<kind>`: a passkey step failed on its way to the bundler (for example `sponsor-failed-BundlerRpcError`).
  - `chain-busy`, `chain-timeout`, `chain-unreachable`: the page's chain node refused (rate limit, HTTP 429 or 5xx), did not answer,
    or could not be reached, after the read was asked again twice.
  - `chain-history-too-wide`: the node allows too few blocks per request to read the history since the deploy block.

  A closed passkey prompt is the person's choice and is not reported.
- `page`: the page's **path only**. No query string, no fragment. A community's address is part of the path only on `/c/<address>` pages.
- `message` and `stack`: cut to 300 and 2,000 characters, with anything that looks like a secret key, a public key, a wallet address or a
  64-digit id replaced by `[key]`, `[address]` or `[id]` before it is sent.
- `at`: when, in unix seconds. `release`: the label above.

**Not sent:** the person's account, keys, name, messages, wallet addresses, browser, IP address (your collector sees the network address of
the request, as any server does: do not log it if you do not want it), cookies (the request is made without credentials), or anything from
local storage.

## Limits

The same error is sent once per visit (a `handled` note once per cause, whatever its words); at most 5 a minute and 30 a visit. A collector that is slow or down changes nothing for the person
using the app: the request is not waited on, and a failure is forgotten.

## Checking it

```bash
cd web && node --experimental-strip-types --test src/shared/lib/error-report.test.mjs
```

The tests drive the whole path with a stand-in window and collector: what is scrubbed, what is limited, what is posted, and that nothing is
listened to when reporting is off.
