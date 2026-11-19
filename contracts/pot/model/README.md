# model

The exact-decimal reference model of the join-and-leave rules (`docs/next-version/JOIN-LEAVE-DESIGN.md`). Plain Python, no
packages, no private content. Run it with `python3 -I v4_model.py` (a 300-seed random run of 400 operations that prints the
lowest per-Share ratio and the conservation error; about three seconds).

| File | What it is |
|---|---|
| `v4_model.py` | The model, copied byte for byte. sha256 `a1388285675c649b4f8951dc942928d5449cb2856eb3993d3ce1dfb858944649`. 70-digit decimals, no integer rounding. |
| `v4_attacks_output.txt` | Output of the attack and worked-example scenarios (serial notes, outside-payment sandwiches, forfeit, later joins, early joiners, round trips, offset run, worked quotes). Copied only. |
| `v4_team_output.txt` | Output of the Team Share runs (with and without outside money). Copied only. |
| `v4_fuzz_output.txt` | Output of the 1,000-seed fuzz. Copied only. |

Where the contracts differ from the model, and who wins (full list in `POT-STEP1A-REPORT.md`):

- The quote offset adds one virtual dollar to paid-in as well as to the money (the model has no offset in `join`).
- A first join into a project that already holds money prices by the same formula; the model prices it flat at 0.01.
- The allowance is linear between settles with a box cap of seven days; the model's `accrue` compounds daily with no cap.
- Outside money arrives as one weighted-average stream; the model's `release` takes a manual fraction.
- The platform fee rounds up by at most one unit; mint and cash round down.
- Tasks, locked money and notes are step 2; the contracts have none of them yet.

The vectors that bind the contracts to this model, and the extension that carries the contract rules, come in pass C.
