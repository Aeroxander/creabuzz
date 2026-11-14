-- EVM identity bindings (migrations 0058 + 0059): maps a member's Nostr pubkey
-- (hot device key) to its EVM root account, per community. Written by
-- `POST /auth/siwe/register` after both the SIWE signature and the Nostr proof
-- event verify. Revocation is soft (`revoked_*`) so history stays auditable.
CREATE TABLE evm_identities (
    community_id   UUID NOT NULL REFERENCES communities(id),
    pubkey         TEXT NOT NULL,
    evm_address    BYTEA NOT NULL,
    attestation    JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at     TIMESTAMPTZ,
    revoked_by     TEXT,
    revoked_reason TEXT,
    PRIMARY KEY (community_id, pubkey),
    CHECK (octet_length(evm_address) = 20)
);

-- Multiple device npubs may share one EVM root account.
CREATE INDEX idx_evm_identities_address ON evm_identities (community_id, evm_address);
