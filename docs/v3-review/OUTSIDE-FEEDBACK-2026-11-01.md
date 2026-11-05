# Outside feedback of 2026-11-01: what each finding turned out to be

Two outside reviews arrived on 2026-11-01: a phased plan (A) and a four-lane sweep of the web app (B). A third reviewer
critiqued plan A. Every claim was checked against the code before anything was changed. The critique's corrections held
wherever the code could settle them, and they were followed. The decision is D178.

Statuses: **fixed** (it was real; fixed, with a test that fails on the old code), **not a defect** (checked, and the code
is right), **already fixed**, **open** (still true; what unblocks it is named), **yours** (needs a person, not code).

## Security

| Finding | Status | Where |
|---|---|---|
| Passkey stand-in reachable in a production build (A 1.1, B 8) | fixed | `identity/lib/passkey.ts`: the stand-in only exists on the dev server, so the production bundle has no trace of it. Tests use a software authenticator (`fake-webauthn.mjs`) and Chrome's virtual authenticator. `passkey-production.spec.ts` shows a production build with the old flag set still runs real WebAuthn. |
| Repository branches and tags could be rewritten by anyone's newer event (A 1.1) | fixed | Per the critique: only the community server's own key is trusted. That key is read from its info document, and these events are signed by the server, not the owner. A forged newer event cannot move HEAD, branches or tags, and switching community drops the old signer. If the key is unknown, a plain failure shows. A server without a stable key (`relay_private_key` unset) now shows the refs failure on repository pages. |

These are the known security findings this plan covers; the audits do not show there are no others.

## Correctness

| Finding | Status | Where |
|---|---|---|
| Milestone claim names fell back to a time-based name (A 2) | fixed, not merged | Per the critique, the stable milestone reference and the per-attempt claim name stay separate. After a turn-down, corrected work gets a new name. A reload resumes the saved one. Names come from a bounded list checked against the chain, and an explicit message shows when all are used. |
| Claim evidence lost on reload after its fingerprint went on chain (B 1) | fixed | `launchpad/lib/claim-draft.ts`: the evidence is kept before sending, scoped by server, account and claim, and cleared only after it is published. |
| Start form lost on reload (B 1) | fixed | Kept per server and account. Signing in on the page starts keeping it, and a saved copy is read before anything is written. |
| Own-words claim in a budget with no open work areas (B 5) | fixed | Refused at submit with plain words. Never refused on a cut-short list or for an existing claim. |
| Malformed approve decision silently skipped (A 2) | fixed | It is still skipped, and the Work tab now says one decision could not be read. |
| Reviewer lists split differently (A 2, critique 7) | fixed | The Start form accepts `;` like the launch panel. A repeated pick says the person is already a reviewer. |
| Add-community saved a dead server and reloaded into it (B 2) | fixed | The address is checked, the server is asked (bounded, by WebSocket, so it needs no cross-origin header), and only then saved. |
| A link to another community opened the connected server's rooms under its name (B 3) | fixed | `CommunityHomePage.tsx` uses the connected server only for its own host. Another host shows its card and "Join this community". The mocked specs moved to the real mock host (`COMMUNITY_HOST`). |
| Failed reads shown as "Nothing here" on 8 pages, silent feed end (B 4) | fixed | Explore, Bookmarks, Search, Profile, the bell, Home, load-more, and the nav badge. A partial list says what failed. |
| Composer: removed mentions still pinged; Enter sent partial text (B 6) | fixed | Only mentions still in the words are tagged. Enter and Tab pick, Escape closes. IME confirm and screen-reader announcements are covered. |
| No deadline on server HTTP reads; unchecked `/query` body; no Retry-After (B 7) | fixed | `shared/lib/timed-fetch.ts` is used across the app, the reply body is checked, and retries honour Retry-After within a bound. Upload has no deadline yet (open: it needs a deadline that grows with size). |
| `buzz org ragequit` gas cap below a real ragequit (found by the new holder journey) | fixed | The CLI's 300,000 cap refused a 336,000 ragequit, so a holder could not leave from the CLI. The cap now grows with the number of tokens. |
| Dialogs leaked focus; one crash took the navigation; partial ARIA tabs (B 10) | fixed | The unlock gate, sign-up/sign-in and the agent stop dialog trap focus. Each route has its own error view. Tabs have arrow keys and are linked to their panels on every page. |
| Fee text promised "the test network" on a real-money build (B 11) | fixed | It names the network where fees are covered, or promises nothing. |
| Milestone deep link lost the claim (B 11) | fixed | The link carries the claim in the address. |

## Words people read

| Finding | Status |
|---|---|
| Repos page said "relay"; errors had no next step (A 3, B 11) | fixed |
| Ledger narration and flat toast in bids (A 3) | fixed; the same narration on Manage and Overview too |
| "Rejected the event" errors (A 3) | fixed |
| One word per asset (A 3, critique 7) | fixed, naming the real instrument: milestones lock Shares; a funding round names non-voting shares when it sells them |
| Stencilled refusal tail, block arithmetic, two near-misses (A 3) | fixed |

## Checked and left as they are

| Finding | Why |
|---|---|
| `shorten`, `slugify`, `formatBytes` "duplicates" (A 2) | Different limits, validation and display, as the critique said. |
| Moderation helpers (A 2) | Each surface's target-kind limits are intended. Merging them would widen who can remove what. |
| `launchCoordinate` lowercasing (A 2) | Every caller passes a server-checked lowercase key. |
| The two `refetch()` calls (A 2) | They never reject. |
| Portfolio header and empty state, forecast reaching bounties (B 11) | Gated as intended. |
| Reserve release has no pool (A 5.1) | Inapplicable, as the critique said. The kit builds its executor with no reserve (now asserted in `DaoLaunchKit.t.sol`), `releaseReserve` takes the treasury's destination, and `withdrawStuckReserve` is the delayed fallback. LBAMM stays closed. |

## Operations

| Item | Status |
|---|---|
| CI for the pilot gate (A 1.2, critique 4) | Written as its own job, `.github/workflows/mvp-gate.yml` ([MVP-GATE-CI.md](MVP-GATE-CI.md)). It was **not pushed** when this was written: the remote is public, and publishing is your call. (Later the same day the branch was pushed to the fork and the job ran there; see [STATUS.md](STATUS.md), "The gates".) A green run would not replace the hosted image, the passkey reviewer, the name link or device recovery. |
| Gate coverage (B 9) | Every `*-e2e.sh` has a home or a stated reason, and an unknown one prints a warning. New journeys: `web-restricted-holder-e2e` (a banned holder still reaches their evidence and can leave) and a "Your work" step. The pilot gate runs the contributor journey in the contributor-only build. |
| Restore rehearsal (A 1.3, critique 5) | yours: [RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md) restores the real backup on another machine and checks posts, images, policies, identity and git. `test-compose-backup.sh` stays separate coverage and verifies only its own scratch deployment. |
| Holder access after a ban (A 4.1, critique 6) | Model and tested fallback in [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md). No private evidence is made public. The hand test is yours. |
| Hand tests (A 4.2) | yours, in PILOT-TEST-GUIDE order. |
| Card onramp (A 5.2) | Parked on provider keys (branch `onramp-options`). |
