# Decisions taken while implementing the v3 review plan

You said to keep going and do what I think is best. These are the answers I used for the plan's questions
([PLAN.md §10](PLAN.md)). Each one is cheap to reverse until the code that depends on it lands; the "Reverting"
column says what that costs.

| # | Question | Taken | Why | Reverting |
|---|---|---|---|---|
| D1 | Do backers vote? | **Yes: vote and exit.** Raise buyers hold the DAO's own Shares | Matches the product copy and what MetaDAO and Umia sell; "exit only" needs the copy changed instead | Medium: the token architecture (D2) is built around it |
| D2 | Token architecture | **C, DAO token is the apptoken, after a spike**; fall back to B (Loot sold) if the spike fails | One supply, one exit, programmable transfers through the same validator hooks | Spike result recorded in `SPIKE-token.md` before any wiring |
| D3 | Conviction | **Accrual removed from the executable lanes**, replaced by a plain "support must hold for N hours" rule; real conviction returns later as funding pools | Your own sim: review time dominates the half-life; hold-time is enforceable, auditable and cheaper | Low until pools ship |
| D4 | Thresholds | Tiered-B starting values (§4.3 of the plan), as constructor/summon parameters, not constants | Study B | Low: parameters |
| D5 | Tickers | First claim per community, case-insensitive, no onchain registry in v1 | Simplest thing that works | Low |
| D6 | Social trading | Supporter lists by hold time and early backing; no PnL leaderboards | Vision documents set productive ownership against speculation | Low |
| D7 | Majeur | `Moloch` frozen except for the minimum needed to remove bugs; new logic in satellites | 313 bytes of headroom | n/a |
| D8 | Superseded pieces | Hide `ProposalVault` and voucher UI; keep contracts and tests until D1 lands | No competing "entry voice" | Low |
| D9 | Scope | Web and CLI first; desktop and mobile parity after | Agents use the CLI; web is the main client | Low |
| D10 | Working tree | New branch `v4-governance-rework`, WIP committed unchanged as checkpoint commits first | Reviewable diff against what you had | n/a |

Hard limits I am holding to regardless: nothing is pushed (the remote is a public repo), mainnet stays off, every
launch flow keeps its "unaudited" notice, no secrets or keys are written to the repo.
