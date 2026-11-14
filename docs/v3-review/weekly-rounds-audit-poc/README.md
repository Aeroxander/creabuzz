# Weekly rounds: proof tests from the 2026-11-01 internal review

Forge tests written during the internal review in [WEEKLY-ROUNDS-AUDIT-2026-11-01.md](../WEEKLY-ROUNDS-AUDIT-2026-11-01.md).
Each one shows a finding happening against the contracts as they were on 2026-11-01. They pass today because the
problem is real; once a finding is fixed, its test should be moved into `contracts/test/` and turned around, so it
fails if the fix is undone.

They are kept here, outside `contracts/`, so `forge test` does not run them. Most were written in small scratch
projects with their own setup copied from `contracts/test/WeeklyRounds.t.sol`; the file name keeps the folder they came
from. To run one, copy it into `contracts/test/` and adjust its imports.
