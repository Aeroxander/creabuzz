-- How many sponsored fees one key has used on one UTC day (migration 0074): a request reserves its count in the
-- statement that checks the limit and gives it back when the upstream refuses. The key says what is counted
-- (`acct:<sender>`, `all`, `ip:<address>`, `exit-ip:<address>`).
CREATE TABLE sponsor_usage (
    day   DATE NOT NULL,
    key   TEXT NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 160),
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (day, key)
);
