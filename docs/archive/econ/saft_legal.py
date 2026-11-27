# Creaton's SAFT backers: the numbers the legal-structure lane needs for counsel. Plain Python, standard library.
# Run: python3 -I docs/archive/econ/saft_legal.py [path to the owner's private sheet]
# Every number printed is SIMULATED (this script) unless the line says "sheet" (totals from the owner's old sheet) or
# "judgement". Legal-structure lane, 18 November 2026. Not legal advice: these are inputs to questions for counsel.
#
# PRIVACY: the sheet holds backer names, amounts and wallet addresses. This file holds totals and counts only. With the
# optional sheet path it also prints counts and threshold buckets (never a name, an address or one backer's amount).
#
# What it answers:
#   1. The conversion rates a consent text would state (Shares per dollar paid, Shares per old token) for the economics
#      lane's two main cases (saft_sheet.py: S1 keeps each group's percent of the old supply; S2 counts all money at 6M).
#   2. Who crosses the Marshall Islands DAO Act's identification line (a "beneficial member" holds 25% or more of
#      membership interests or voting rights; some earlier commentary says 10%) as held Shares release over 365 days.
#      Voting Shares = free Shares in people's hands: the 250M auction Shares from day one, plus released held Shares.
#      Pool and Treasury Shares do not vote (plan v2; saft_sheet.py section 7). Held Shares cannot be parked, so they
#      carry no vote until released (built Vester).
#   3. With the private sheet: how many entries can be paid at once (a usable address), and the largest single address's
#      share of votes at its peak, as a bucket.
import re
import sys

M = 1e6
B = 1e9
OLD = 110 * M
SEED_USD, SEED_OLD, SEED_N = 177_500, 8_875_000, 3          # sheet
PRIV_USD, PRIV_OLD, PRIV_N = 1_052_457, 22_879_500, 18       # sheet
AUCTION = 250 * M
FOUNDER = 200 * M
ROUNDS_6M = 50_000 * B / 6_000_000                            # Creaton's Team cap at 6M (measured, PLANV2-M4-REPORT)
ADVISORS = 14.55 * M                                         # saft_sheet.py judgement (old 1.6M line kept as a percent)

CASES = {
    "S1 each group keeps its percent": (SEED_OLD / OLD * B, PRIV_OLD / OLD * B),
    "S2 all money counted at 6M": (SEED_USD / 6e6 * B, PRIV_USD / 6e6 * B),
}


def votes(day, earlier):
    f = min(day, 365) / 365
    return AUCTION + f * (earlier + FOUNDER + ROUNDS_6M + ADVISORS)


def main():
    print("== 1. Conversion a consent text would state (sheet totals; mapping is the economics lane's) ==")
    for name, (seed, priv) in CASES.items():
        tot = seed + priv
        print(f" {name}: seed {seed / M:.2f}M ({seed / SEED_USD:.3f} a dollar), private {priv / M:.2f}M "
              f"({priv / PRIV_USD:.3f} a dollar); total {tot / M:.2f}M = {tot / B:.2%}; per old token "
              f"{tot / (SEED_OLD + PRIV_OLD):.4f}")
    print(" S1 per old token is the same for every backer: 1,000,000,000 / 110,000,000 = 9.0909 Shares")

    print("\n== 2. Share of votes as held Shares release (day 0 = market open; nobody sells or hands back) ==")
    for name, (seed, priv) in list(CASES.items()) + [("none (no earlier backers)", (0, 0))]:
        eb = seed + priv
        row = []
        for d in (1, 30, 90, 180, 365):
            v = votes(d, eb)
            row.append(f"day {d:3d}: founder {FOUNDER * min(d, 365) / 365 / v:5.1%}, earlier backers together "
                       f"{eb * min(d, 365) / 365 / v:5.1%}")
        print(f" {name}\n   " + "\n   ".join(row))
    print(" the founder's 20% crosses 25% of votes in every case by day 365 (simulated): identify the founder as a"
          " beneficial member in any case. Before the market only the founder or the Pair decides: same answer.")
    print(" turnout: if the line is read against parked Shares, not all voting Shares, a much smaller holder can cross"
          " it in a quiet vote (question for counsel)")

    if len(sys.argv) > 1:
        private(sys.argv[1])


def private(path):
    import openpyxl  # only for the optional private check

    ws = openpyxl.load_workbook(path, data_only=False).worksheets[0]
    seed_amounts = [ws[f"G{r}"].value for r in (19, 20, 21)]
    priv_rows = [r for r in range(23, 42) if isinstance(ws[f"H{r}"].value, (int, float))]
    entries = [("seed", a, None) for a in seed_amounts]
    entries += [("private", ws[f"H{r}"].value, ws[f"L{r}"].value) for r in priv_rows]
    ok_addr = re.compile(r"^0x[0-9a-fA-F]{40}$")
    counts = {"usable address": 0, "address with a break or bad form": 0, "marked DONE": 0, "no address": 0}
    by_addr = {}
    for kind, amt, a in entries:
        s = (str(a) if a is not None else "").strip()
        if ok_addr.match(s):
            counts["usable address"] += 1
            by_addr.setdefault(s.lower(), []).append((kind, amt))
        elif s.upper() == "DONE":
            counts["marked DONE"] += 1
        elif s:
            counts["address with a break or bad form"] += 1
        else:
            counts["no address"] += 1
    shared = sum(1 for v in by_addr.values() if len(v) > 1)
    print("\n== 3. The private sheet (counts and buckets only) ==")
    print(f" entries {len(entries)} (sheet: 21); seed total {sum(seed_amounts):,.0f}; private total "
          f"{sum(e[1] for e in entries if e[0] == 'private'):,.0f}")
    print(" " + "; ".join(f"{k} {v}" for k, v in counts.items()) + f"; addresses used by more than one entry {shared}")
    rate = {"S1 each group keeps its percent": {"seed": B / 2.2e6, "private": B / 5.06e6},
            "S2 all money counted at 6M": {"seed": B / 6e6, "private": B / 6e6}}
    for name, (seed, priv) in CASES.items():
        eb = seed + priv
        per_entry = [amt * rate[name][kind] for kind, amt, _ in entries]
        biggest = max(per_entry)
        peak = max(biggest * d / 365 / votes(d, eb) for d in range(1, 366))
        bucket = "under 5%" if peak < .05 else "5% to 10%" if peak < .10 else "10% to 25%" if peak < .25 else "25% or more"
        print(f" {name}: the largest single entry's peak share of votes is {bucket} (all voting Shares, nobody sells)")


if __name__ == "__main__":
    main()
