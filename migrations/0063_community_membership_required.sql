-- ── Per-community "who may join" ─────────────────────────────────────────────
-- Until now whether people had to be members before they could read or write was one switch for the whole server
-- (`BUZZ_REQUIRE_RELAY_MEMBERSHIP`). A server that hosts many communities needs it per community: a team's private
-- workspace must be closed while another community on the same server stays open. This adds the community's own
-- setting. The server-wide switch still wins: when it is on, every community is closed.
--
-- Additive migration: previously applied files must not change checksum. `communities` is the operator-global registry
-- (no community_id column by design); this adds one per-row policy attribute, not tenant data in a shared table.
-- Existing communities keep today's behaviour (open unless the server-wide switch is on).

ALTER TABLE communities ADD COLUMN membership_required BOOLEAN NOT NULL DEFAULT FALSE;
