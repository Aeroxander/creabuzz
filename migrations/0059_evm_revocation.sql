-- creabuzz: soft revocation for EVM identity bindings.
--
-- `POST /auth/siwe/revoke` marks a binding revoked (instead of deleting it)
-- so history is preserved and audit-friendly. A revoked binding cannot be
-- used to register again; a future `re-register` path (or the owning EVM
-- account) can clear `revoked_at` to re-bind a fresh device npub.

ALTER TABLE evm_identities
    ADD COLUMN revoked_at  TIMESTAMPTZ,
    ADD COLUMN revoked_by  TEXT,
    ADD COLUMN revoked_reason TEXT;
