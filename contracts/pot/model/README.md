# model

The exact-decimal reference model of the join-and-leave rules (`docs/next-version/JOIN-LEAVE-DESIGN.md`), the extension that carries
what the contracts define, and the vectors that tie the two together. Plain Python 3, no packages, no private content. Run
everything with `python3 -I` (isolated mode).

| File | What it is |
|---|---|
| `v4_model.py` | The model, copied byte for byte. sha256 `a1388285675c649b4f8951dc942928d5449cb2856eb3993d3ce1dfb858944649`. 70-digit decimals, no integer rounding. Self-test: `python3 -I v4_model.py` (a 300-seed random run of 400 operations; about three seconds). |
| `pot_ext.py` | The extension, on top of the unchanged model: the contracts' rules in exact arithmetic (below). All amounts in base units (dollars in millionths, Shares in wei). |
| `gen_vectors.py` | Fixed and seeded scenarios run through the extension. `python3 -I gen_vectors.py` writes `vectors.json`; `--check` fails if the committed file differs. |
| `vectors.json` | 52 scenarios (32 fixed, 20 seeded), 1,805 operations, every expected number as a decimal string. Read by `test/ModelVectors.t.sol`. |
| `v4_attacks_output.txt`, `v4_team_output.txt`, `v4_fuzz_output.txt` | Outputs of the model's attack, Team and fuzz runs. Copied only. |

## Where the contracts differ from the model, and who wins

The extension implements the contract side of each point, so a vector says what the contracts must do. Each is stated again,
with the choice, in `POT-STEP1A-REPORT.md`.

- **Quote offset.** The join price adds one virtual dollar to the money *and to paid-in*, and 100 virtual Shares (the model has no offset in `join`). Without the dollar in paid-in the first join would be priced about 100,000 times too low whenever a Team pool exists.
- **A first join into a project that already holds money** is priced by the same formula (the model prices it flat at one cent) and is credited as paid-in only what is left after paying for its slice of that money. This was found by the invariant run (see the report) and is the one place the contracts changed in pass C.
- **The allowance** is linear between settles on the pot, with the box cut to seven days of accrual on pot and box together; the model's `accrue` compounds daily with no cap.
- **Outside money** arrives as one weighted-average stream over one time unit; the model's `release` takes a manual fraction.
- **Time.** The check-in window (2N), active seconds, the door, the rate raise (propose, wait N, apply) and Team Share vesting exist only in the contracts and the extension.
- **Fees** round up by at most one unit; Shares minted and cash paid round down.
- **Tasks, locked money and exit notes** are step 2: the vector scenarios use none of them.

## How the vectors bind the contracts

`ModelVectors.t.sol` launches each scenario through the real Launcher, gives Team Shares by a real grant (vested over 104 time
units of active time and claimed), optionally forces a pot and a paid-in with storage writes (only for the design's worked
examples, whose states cannot be reached in a few steps), then replays the operations with the real calls and compares, after
each, the pot, paid-in, Shares, Team Shares, burn queue, box, outside money arriving, fees owed and what the operation returned.
Between the Treasury's own quote and its action it asserts exact equality.

Tolerance, stated in the test header: after `k` operations a dollar number may differ from the model's by `4k` units plus its own
size times `4k / X`, and a Share number by `8k` wei plus the same relative term. `X` is the smallest money-in-the-quote the
project held while it had backers (or the smallest join, if less: a join's fee rounds by up to one unit). That is the rounding
the contracts define (floors, a fee rounded up, paid-in cut down) carried through at most `k` prices. The largest deviation seen
over the 1,805 operations and 17,201 compared numbers is 24% of its allowance (a first join of 2,000.0007 dollars whose fee
rounds by one unit, a part in 2e9 of the Shares it mints); the mutation check shows a changed formula moves numbers by orders of
magnitude more.

No vector is excluded for failing to match. One rule keeps the scenarios clear of a rounding edge: the generator drops an
outside payment whose arrival end (the weighted average of two payments) sits within a few units of a whole second, because the
contract's integers could land on the other side of it; it never loosens a bound.

`scripts/check-mutations.py` changes one formula at a time in a scratch copy of the contracts and requires `ModelVectors` to
fail; it covers the offset, the quote, both take-out formulas, the paid-in cut and credit, the fee, the allowance, the box cap,
the release, the merge of two payments, the window, the burn queue in the price and the vesting length.
