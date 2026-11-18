-- ── Chain helper (plan v2, milestone 5, part 2) ─────────────────────────────
-- The helper job sends the calls anyone may make so that nobody has to press:
-- it closes and settles backing rounds, releases and sweeps, finishes sales,
-- collects pool fees, claims plain grants and delivers the earlier backers'
-- agreed Shares. It never sends a call that moves a person's money by choice.
--
-- Jobs are built only from the reader's final rows (chain_logs at least the
-- confirmation depth under the head). `due_block` is the block of the row that
-- made the job due, so a rollback past it deletes the job. Every failure
-- leaves a retry record (attempts, next try, last error) with a growing pause
-- and a limit, after which the job ends in the terminal state 'failed'.
-- Every transaction the helper broadcasts is kept in chain_helper_sends, which
-- holds the gas and the fee reserved and then spent, so the daily caps count
-- stuck and replaced transactions too.
--
-- Public chain facts and the relay's own outgoing calls, kept per reader
-- ('<chain id>:<launcher>'), not one community's data: operator-global.
-- Additive migration, plus a wider role list for the reader's contracts.

CREATE TABLE chain_helper_jobs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reader        TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    job_key       TEXT NOT NULL CHECK (octet_length(job_key) BETWEEN 1 AND 512),
    call          TEXT NOT NULL CHECK (call IN
                      ('rounds.close', 'rounds.settleMany', 'rounds.release', 'rounds.returnUnsold',
                       'rounds.sweepFees', 'treasury.sweepFees', 'treasury.release',
                       'finisher.openPool', 'finisher.settle', 'finisher.sweep', 'finisher.abandon',
                       'holder.collect', 'vester.claim', 'earlier.deliverMany')),
    target        BYTEA NOT NULL CHECK (length(target) = 20),
    args          JSONB NOT NULL,
    project_key   BYTEA CHECK (project_key IS NULL OR length(project_key) = 32),
    due_block     BIGINT NOT NULL CHECK (due_block >= 0),
    repeats       BOOLEAN NOT NULL DEFAULT false,
    state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                      ('pending', 'sent', 'done', 'dropped', 'failed')),
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_try_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error    TEXT,
    nonce         BIGINT CHECK (nonce IS NULL OR nonce >= 0),
    tx_hash       BYTEA CHECK (tx_hash IS NULL OR length(tx_hash) = 32),
    sent_at       TIMESTAMPTZ,
    settled_block BIGINT CHECK (settled_block IS NULL OR settled_block >= 0),
    done_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (reader, job_key)
);

CREATE INDEX idx_chain_helper_jobs_due ON chain_helper_jobs (reader, state, next_try_at);
CREATE INDEX idx_chain_helper_jobs_block ON chain_helper_jobs (reader, due_block);

CREATE TABLE chain_helper_sends (
    reader          TEXT NOT NULL CHECK (octet_length(reader) BETWEEN 1 AND 128),
    tx_hash         BYTEA NOT NULL CHECK (length(tx_hash) = 32),
    job_id          BIGINT NOT NULL,
    nonce           BIGINT NOT NULL CHECK (nonce >= 0),
    gas_limit       BIGINT NOT NULL CHECK (gas_limit > 0),
    max_fee_per_gas NUMERIC(78, 0) NOT NULL CHECK (max_fee_per_gas >= 0),
    max_priority_fee_per_gas NUMERIC(78, 0) NOT NULL CHECK (max_priority_fee_per_gas >= 0),
    reserved_wei    NUMERIC(78, 0) NOT NULL CHECK (reserved_wei >= 0),
    gas_used        BIGINT CHECK (gas_used IS NULL OR gas_used >= 0),
    spent_wei       NUMERIC(78, 0) CHECK (spent_wei IS NULL OR spent_wei >= 0),
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at      TIMESTAMPTZ,
    PRIMARY KEY (reader, tx_hash)
);

CREATE INDEX idx_chain_helper_sends_sent_at ON chain_helper_sends (reader, sent_at);

-- The earlier backers' claim contract (project zero) is followed too; the
-- auction, the LiquidityHolder and the pool manager are reserved for the
-- auction and pool events.
ALTER TABLE chain_contracts DROP CONSTRAINT chain_contracts_role_check;
ALTER TABLE chain_contracts ADD CONSTRAINT chain_contracts_role_check CHECK (role IN
    ('launcher', 'shares', 'treasury', 'vester', 'finisher', 'rounds', 'pair',
     'earlier', 'auction', 'holder', 'pool_manager'));

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('chain_helper_jobs', 'deployment-global calls the chain helper sends; public chain facts'),
    ('chain_helper_sends', 'deployment-global transactions the chain helper broadcast and their fees');
