-- creabuzz: backfill events.d_tag for the slug-addressed fork kinds.
--
-- The human wiki (44001), agent wiki (44002), wiki corrections (44003), fleet
-- capabilities/tasks (44010/44011) and team strategy/run/turn kinds
-- (44020-44022) are addressed
-- by their `d` tag but live outside the NIP-33 window (30000-39999), so
-- `extract_d_tag` used to store NULL for them and every query that pushes a
-- `d_tag` predicate into SQL (`GET /governance.md` reads kind 44001 by slug)
-- found nothing. New writes now materialize the slug at insert time
-- (`buzz_core::kind::D_TAG_ADDRESSED_KINDS`); this migration fills in the
-- rows written before that change.
--
-- These kinds stay REGULAR events: nothing here changes replacement or
-- retention, every revision is kept, and read-side last-write-wins is
-- unchanged. Only the lookup column is populated.
--
-- Mirrors `extract_d_tag`: the first `d` tag that carries a value wins; rows
-- with no such tag, or a slug longer than D_TAG_MAX_LEN (1024 bytes, keeps the
-- btree index entry bounded), stay NULL. Soft-deleted rows are included so the
-- column is fully populated (same as scripts/backfill-d-tag.sql). Idempotent:
-- only NULL d_tag rows are touched. `community_write_allowed` skips tenants
-- that are fenced or mid-deletion instead of aborting the whole migration on
-- the community write fence; `events` is partitioned and the UPDATE runs on
-- the parent.

WITH first_slug AS (
    SELECT e.community_id,
           e.created_at,
           e.id,
           (SELECT elem->>1
              FROM jsonb_array_elements(e.tags) AS elem
             WHERE elem->>0 = 'd'
               AND elem->>1 IS NOT NULL
             LIMIT 1) AS slug
      FROM events e
     WHERE e.kind IN (44001, 44002, 44003, 44010, 44011, 44020, 44021, 44022)
       AND e.d_tag IS NULL
       AND jsonb_typeof(e.tags) = 'array'
)
UPDATE events e
   SET d_tag = first_slug.slug
  FROM first_slug
 WHERE e.community_id = first_slug.community_id
   AND e.created_at = first_slug.created_at
   AND e.id = first_slug.id
   AND e.kind IN (44001, 44002, 44010, 44011, 44020, 44021, 44022)
   AND first_slug.slug IS NOT NULL
   AND octet_length(first_slug.slug) <= 1024
   AND community_write_allowed(e.community_id);
