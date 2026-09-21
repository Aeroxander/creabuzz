# Production-readiness audit — org/DAO feature set (feat/org-graph)

Audited 2026-09-21 against the committed branch (git HEAD) plus live
verification: E2E DAO walkthrough over a running relay, WebSocket
conformance suite, budget-approval live probe, classifier smoke against
the real LLM endpoint.

## Verdicts

### SECURITY — READY-WITH-CAVEATS
- Classifier key: env-only (BUZZ_CLASSIFIER_API_KEY), .env gitignored
  (verified `git check-ignore .env`), never logged or committed.
  CAVEAT: the key was pasted in chat once — rotate when convenient.
- Org write authority: budget/binding rules enforced relay-side
  (subject-or-owner; root-holder-or-owner), envelope validation on
  ingest, concurrent grant-chain enforcement opt-in behind
  ORG_GRANT_ENFORCEMENT. Grantee-continuity check closes the
  ride-a-grant hole.
- Prompt injection: org_classify.rs frames task content as UNTRUSTED
  DATA with an explicit no-instructions directive; strict schema
  validation gates publication (one retry, then fail-closed).
- CAVEAT: classifier endpoint URL is user-configurable env — SSRF
  posture is "the operator configured it", acceptable for a
  self-hosted relay, document it.
- NIP-42 auth on org writes: yes (messages-write scope).
- No unsafe / unwrap additions in production paths (enforced gate).

### FAILURE MODES — READY-WITH-CAVEATS
- Relay down mid-flow: desktop publish errors surface as inline errors
  (needs-me cards, forms). No silent success.
- Classifier endpoint down / 429: command fails loudly, nothing
  published; batch continues per-task (draft-from-task in flight).
- Anvil gone: onchain chips are read-only labels — no crash, but the
  UI cannot distinguish "contract gone" from "no binding"; CAVEAT:
  surface a stale-chain hint.
- Migration 0047: additive tables; migration-count test pinned;
  schema.sql synced (checked). pgschema bootstraps reconcile.
- Concurrent LWW: created_at-dominance guards on revoke/bind paths
  plus re-check; org reads take newest per d (client-side max).

### DATA INTEGRITY — READY
- migration 0047 vs schema.sql: table DDL matches (verified by
  reading both; index + partial unique index present in both).
- Tombstones: house a-tag deletion pattern (projectDeletion theme)
  used by org node/budget; desktop read models filter revoked/kind-5.
- Orphan policy: grants referencing deleted nodes are visible history
  (curtain), not lost; budgets referencing deleted agents just don't
  match enforcement (documented as read-model behavior).
- Reviewer multi-writer: a review by a different author creates a
  parallel addressable event (NIP-33 LWW is author-keyed) — known and
  pinned by test; needs a protocol decision before multi-reviewer orgs.

### OPERATIONS — READY-WITH-CAVEATS
- Every new env var documented in .env.example (classifier, evm,
  grant enforcement) with comments.
- Enforcement paths emit structured logs (otel spans on ingest,
  WARN on rejections with reason).
- CAVEAT: ARCHITECTURE.md has no NIP-ORG section yet; the NIP itself
  is the spec and it is current. Add an architecture blurb.

### RESOURCE BOUNDS — READY
- Classifier: 30s timeout, max_tokens 800, batch capped 20.
- Relay lookups: budget cap 100 + comment, depth cap 32 on grant
  chains, feed limits everywhere.
- Desktop hooks: limits 500-1000, abnormal-truncation honesty in the
  utilization bar (">500 — count is a floor").

## Blockers before production
None found that would lose data or hand out authority wrongly.

## Recommended before production (ranked)
1. Rotate the classifier API key (chat exposure).
2. Protocol decision on multi-reviewer contribution reviews (who may
   review; how authorship binds) — today a non-author review forks
   the record.
3. Stale-chain indication when the bound DAO address no longer
   resolves on the configured chain.
4. ARCHITECTURE.md NIP-ORG section + runbook note on
   ORG_GRANT_ENFORCEMENT and the classifier env.
5. e2e_org.rs into CI (Postgres lane) so the WS seam stays pinned.

## Live walkthrough notes (2026-09-21)
- CLI org root/seat/grant/budget create: accepted, read back.
- Budget authority rule fired correctly on the wrong subject and
  passed with the correct agent pubkey.
- Classifier published a pending 37013 from a done task (endpoint
  rate-limited twice; succeeded after backoff) — the full
  propose→review loop works.
- Conformance (4/4 green): LWW lifecycle, window rejection, p-gate,
  binding authority. Committed as 7f5bdb1e1.
