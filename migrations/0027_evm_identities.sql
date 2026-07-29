-- creabuzz: EVM identity bindings (SIWE registration).
--
-- Maps a Nostr member pubkey (hot device key) to its EVM root account, per
-- community. Written by `POST /auth/siwe/register` after the SIWE signature
-- (proving the EVM key) and the Nostr proof event (proving the npub) both
-- verify. See docs/protocol-strategy.md, "Design 2".

CREATE TABLE evm_identities (
    community_id UUID NOT NULL REFERENCES communities(id),
    pubkey       TEXT NOT NULL,
    evm_address  BYTEA NOT NULL,
    attestation  JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, pubkey),
    CHECK (octet_length(evm_address) = 20)
);

-- Multiple device npubs may share one EVM root account.
CREATE INDEX idx_evm_identities_address ON evm_identities (community_id, evm_address);
