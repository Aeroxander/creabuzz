-- Calls the chain helper sends (migration 0066): built from final chain rows,
-- each failure leaving a retry record, ending in a terminal state.
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
