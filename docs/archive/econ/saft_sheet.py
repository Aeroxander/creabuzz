# Creaton's SAFT backers from the owner's old token sheet: how many of CREATE's 1,000,000,000 Shares, from where, and on
# what release. Plain Python, standard library. Run: python3 -I docs/archive/econ/saft_sheet.py
# Every number printed is SIMULATED (this script) unless the line says "sheet" (read from the owner's old sheet, totals
# only), "measured" (a report) or "judgement". Economics lane, 18 November 2026. Replaces the guessed "about 1.2M at 6M"
# of saft_backers.py and earlier_claim.py with the sheet's totals.
#
# PRIVACY: the sheet holds backer names, amounts and wallet addresses. This file holds totals and counts only.
#
# Sheet facts (old supply 110,000,000 tokens, Doppler launch, no longer used):
#   seed 177,500 dollars from 3 entries at 0.02 = 8,875,000 old tokens; private 1,052,457 dollars from 18 entries at 0.046
#   = 22,879,500 old tokens. Total 1,229,957 dollars, 31,754,500 old tokens = 28.868% of 110M. A "Private 2" tranche of
#   24M at 0.055 (= 6.05M for the whole supply) is listed but shows no sales. The owner also bought seed tokens and will
#   put them back (amount not on the sheet).
#
# Model (plan v2 + founder-set prices, as built in contracts/next; judgement where it says so):
# - Birth: founder 200M (Vester grant), work pot 200M + reserve 100M (Treasury), backing 150M (Rounds), auction 250M +
#   pool match 100M (Finisher). Project zero takes no 2% stake (built: nameProjectZero).
# - Creaton's rounds at 6M: the 50,000 Team cap buys 8.33M Shares (measured, PLANV2-M4-REPORT); the other 141.67M backing
#   Shares can never sell at 6M and join the reserve at the market (built: returnUnsold).
# - The auction sells all 250M at the start or above; 22 of each 100 go to the pool with 55M Shares; the 45M pool-match
#   Shares not needed join the reserve; 60 of each 100 is the floor, melting to the project evenly over 365 days.
# - Held Shares release evenly over 365 days from market open and never count until released (built Vester).
# - Pool: constant product, 1% fee on the way in (plan_v2.py; reproduces M3). Every pool ratio below depends only on
#   held Shares / 55M, not on the price, because the pool always holds 55M Shares and 22 of each 100 of 250M x start.
# - Hand-back: slice = floor x amount / Shares counting, holder gets 95 (built). CREATE's permanent fee floor left out.
# - Advisors (judgement): 14.55M from the work pot (the old 1.6M line kept as a percent), held like any pre-market gift.

B = 1e9
M = 1e6
OLD = 110 * M
SALE, POOL_SH, POOL_LEFT = 250 * M, 55 * M, 45 * M
FOUNDER, WORK, BACK, RES = 200 * M, 200 * M, 150 * M, 100 * M
TEAM_CAP, CV = 50_000, 6_000_000
ROUNDS = TEAM_CAP * B / CV           # 8.33M: all Creaton's rounds can sell at 6M under the Team cap
SPARE = BACK - ROUNDS                # 141.67M backing Shares Creaton's rounds can never sell at 6M
ADVISORS = 1.6 * M / OLD * B         # 14.55M (judgement)

SEED_USD, SEED_N, SEED_P = 177_500, 3, 0.02
PRIV_USD, PRIV_N, PRIV_P = 1_052_457, 18, 0.046
SEED_OLD, PRIV_OLD = SEED_USD / SEED_P, PRIV_USD / PRIV_P
USD = SEED_USD + PRIV_USD
DONE_USD, DONE_N = 320_100, 2        # sheet: private entries marked "DONE" (meaning unknown), total and count only
OLD_SOLD = SEED_OLD + PRIV_OLD


def m(x):
    return "%.2fM" % (x / M)


def d(x):
    return f"{x:,.0f}"


def pct(x):
    return "%.2f%%" % (x / B * 100)


def sell(u, s, sh):
    x = sh * 0.99
    out = u * x / (s + x)
    return out, u - out, s + x


def move(sh):
    """Dollars out and price move when `sh` Shares are sold at once into the 55M-Share pool (per dollar of pool)."""
    out, u2, s2 = sell(1.0, POOL_SH, sh)
    return out, (u2 / s2) / (1.0 / POOL_SH) - 1


# ------------------------------------------------------------------ 0 facts
print("== 0. The sheet, totals only ==")
print(" seed    %9s dollars, %2d entries, 0.020 a token = %s old tokens (%.3f%% of 110M); whole-supply price %s" % (
    d(SEED_USD), SEED_N, d(SEED_OLD), SEED_OLD / OLD * 100, d(SEED_P * OLD)))
print(" private %9s dollars, %2d entries, 0.046 a token = %s old tokens (%.3f%% of 110M); whole-supply price %s" % (
    d(PRIV_USD), PRIV_N, d(PRIV_OLD), PRIV_OLD / OLD * 100, d(PRIV_P * OLD)))
print(" total   %9s dollars, %2d entries, %s old tokens = %.3f%% of 110M; blended whole-supply price %s" % (
    d(USD), SEED_N + PRIV_N, d(OLD_SOLD), OLD_SOLD / OLD * 100, d(USD / (OLD_SOLD / OLD))))
print(" 'Private 2' at 0.055 = %s for the whole supply: no sales on the sheet. The '6M valuation' is that unsold tranche"
      % d(0.055 * OLD))

# ------------------------------------------------------------------ 1 sizes
print("\n== 1. How many CREATE Shares (of 1,000M) ==")
S1 = OLD_SOLD / OLD * B
S2 = USD / CV * B
S2_PRE = USD / (CV + USD) * B
S3B = OLD_SOLD
S4 = SEED_OLD / OLD * B + PRIV_USD / CV * B
SIZES = [  # (name, seed Shares, private Shares)
    ("S1 their percent kept (28.87%)", SEED_OLD / OLD * B, PRIV_OLD / OLD * B),
    ("S3 each at its own old price", SEED_USD / (SEED_P * OLD) * B, PRIV_USD / (PRIV_P * OLD) * B),
    ("S4 seed own price, private at 6M", SEED_OLD / OLD * B, PRIV_USD / CV * B),
    ("S2 all at 6M, money counted in", SEED_USD / CV * B, PRIV_USD / CV * B),
    ("S2p all at 6M, money on top (7.23M)", SEED_USD / (CV + USD) * B, PRIV_USD / (CV + USD) * B),
    ("S3b old token count, no change", SEED_OLD, PRIV_OLD),
]
for nm, a, b in SIZES:
    print(" %-40s %8s = %6s; seed %7s, private %8s; average paid %.5f a Share = %s for the whole project" % (
        nm, m(a + b), pct(a + b), m(a), m(b), USD / (a + b), d(USD / (a + b) * B)))
print(" S3 equals S1 exactly: each old price x 110M is that group's whole-supply price, so mapping each group at its own")
print(" price to 1B keeps its percent. S3b (the old token count as Shares) cuts them %.0f%% because the supply grew 9.09x." % (
    (1 - S3B / S1) * 100))
print(" S2 against S1: %+.1f%% Shares for the backers (a %.0f%% cut, which each backer would have to sign)" % (
    (S2 / S1 - 1) * 100, (1 - S2 / S1) * 100))

# ------------------------------------------------------------------ 2 old lines
print("\n== 2. Every old line onto the new split (old percent x 1B shown for scale; sheet numbers, mapping judgement) ==")
OLD_LINES = [
    ("Team 23M, 180-day cliff, 2 years", 23, "founder 20% (200M), 365 days from market, trimmed if the founder leaves before it"),
    ("Advisors 1.6M", 1.6, "work pot, Give Shares before the market (held on the same clock)"),
    ("Ambassadors 2.4M", 2.4, "work pot: gifts for tasks (free after the market, 1% of Shares in hands per 30 days)"),
    ("Seed 9M at 0.02 (8.875M sold)", 9, "earlier backers (sections 3 to 5); the unsold 0.125M goes nowhere"),
    ("Private 23M at 0.046 (22.88M sold)", 23, "earlier backers; unsold 0.12M and 'Private 2' 24M gone: Creaton's"
     " rounds at 6M and the auction replace them"),
    ("Liquidity 1M, unlocked, to Doppler", 1, "pool match 10%: 55M Shares paired with 22 of each 100 auction dollars,"
     " locked for good; the 45M not needed join the reserve"),
    ("Doppler launch (and 'part of team')", 0, "the one auction, 25% (250M) at the runner's start; the minimum is all"
     " 250M at that start (1,500,000 at 6M)"),
    ("Staking and rewards 6M", 6, "no staking (it would be a payout to holders); rewards for work come from the work pot"),
    ("DAO treasury 40M, DAO vote", 40, "reserve 10% (sales only with the Council, holders vote at Open) and the work pot"
     " (runner and Council budget)"),
    ("Airdrop 4M", 4, "work pot gifts after the market, under the 1% per 30 days cap; no blind drops to fresh wallets"),
]
for nm, old, new in OLD_LINES:
    print(" %-36s %6.2f%% = %7s  ->  %s" % (nm, old / 110 * 100, m(old / 110 * B), new))
wp_old = (1.6 + 2.4 + 6 + 4) / 110 * B
print(" old lines the work pot replaces (advisors, ambassadors, staking and rewards, airdrop): %s of the 200M work pot;"
      " %s left for contributors (judgement: those lines were plans, not promises, except the advisors)" % (
          m(wp_old), m(WORK - wp_old)))
print(" old insiders (team + advisors + sold) %.1f%%; old community lines %.1f%%" % (
    (23 + 1.6) / 110 * 100 + OLD_SOLD / OLD * 100, 100 - (23 + 1.6) / 110 * 100 - OLD_SOLD / OLD * 100))


# ------------------------------------------------------------------ 3 sources
def option(name, size, takes):
    """takes: ordered list of (source, cap) with source in founder/work/back/res; returns allocation or None if short."""
    left = dict(founder=FOUNDER, work=WORK, back=BACK, res=RES)
    caps = dict(founder=FOUNDER, work=WORK, back=SPARE, res=RES)
    need = size
    for src in takes:
        t = min(need, caps[src])
        left[src] -= t
        need -= t
    o = dict(name=name, size=size, short=need, **left)
    o["rounds"] = min(ROUNDS, o["back"])
    o["res_after"] = o["res"] + POOL_LEFT + (o["back"] - o["rounds"])
    o["held"] = o["founder"] + (size - need) + o["rounds"] + ADVISORS
    o["work_after"] = o["work"] - ADVISORS
    return o


OPTS = []
for tag, size in (("S1", S1), ("S2", S2)):
    OPTS += [
        option("A founder only, %s" % tag, size, ["founder"]),
        option("B work pot only, %s" % tag, size, ["work"]),
        option("C unused backing + reserve, %s" % tag, size, ["back", "res"]),
        option("C+ backing + reserve + founder, %s" % tag, size, ["back", "res", "founder"]),
        option("D unused backing, then founder, %s" % tag, size, ["back", "founder"]),
    ]
OPTS.append(option("A founder only, S2p", S2_PRE, ["founder"]))
NONE = option("none (no earlier backers)", 0, [])
DEFAULT_HELD = FOUNDER + BACK + 20 * M  # a default project, every backing Share sold, with the stake

print("\n== 3. Where they come from (Creaton keeps its 8.33M of backing for its own 6M rounds) ==")
print(" %-38s %8s %8s %9s %8s %8s %9s %9s %7s  %s" % ("option", "short", "founder", "work pot", "rounds",
                                                     "reserve", "res after", "held mkt", "/55M", "contract"))
CHANGE = {"A": "founder grant split at launch (Launcher) + claim contract", "B": "none (Give Shares, built)",
          "C": "Launcher: backing and reserve to an earlier-backers grant (reserve: project zero only)",
          "C+": "as C, plus founder grant split", "D": "Launcher: earlier-backers grant from unused backing, then founder"}
for o in [NONE] + OPTS:
    key = o["name"].split()[0]
    print(" %-38s %8s %8s %9s %8s %8s %9s %9s %6.2fx  %s" % (
        o["name"], m(o["short"]) if o["short"] > 1 else "-", pct(o["founder"]), pct(o["work_after"]), m(o["rounds"]),
        m(o["res"]), m(o["res_after"]), m(o["held"]), o["held"] / POOL_SH, CHANGE.get(key, "-")))
print(" work pot shown after the advisors' %s; 'held mkt' = founder + earlier backers + Creaton's rounds + advisors" % m(ADVISORS))
print(" a default project with every backing Share sold and the stake holds %s at market = %.2fx the pool's 55M"
      " (plan section 10 counts 350M, without advisors)" % (m(DEFAULT_HELD), DEFAULT_HELD / POOL_SH))
print(" the auction (250M) and the pool match (100M) are the same in every option. A short option cannot be built.")
dS1 = [o for o in OPTS if o["name"].startswith("D") and o["name"].endswith("S1")][0]
print(" D always leaves held at market = founder 200 + backing 150 + advisors = %s: exactly a default project's"
      " founder plus every backing Share, whatever the size" % m(dS1["held"]))


# ------------------------------------------------------------------ 4 market
def floor_path(start, groups, exit_groups, days=(1, 15, 30, 90, 180, 365)):
    """Daily. Held groups release 1/365 a day. exit_groups take each day's release out the best way at the margin:
    sell into the pool while it pays more than the floor slice, then hand back the rest. Returns snapshots."""
    raised = SALE * start
    u, s = 0.22 * raised, POOL_SH
    melt = 0.60 * raised
    counting = SALE + POOL_SH
    taken_pool = taken_floor = 0.0
    snaps = {}
    total_held = sum(groups.values())
    exit_held = sum(groups[g] for g in exit_groups)
    for day in range(1, 366):
        melt -= melt / (366 - day)
        counting += total_held / 365
        r = exit_held / 365
        if r:
            slice_ = melt / counting * 0.95
            x = 0.0
            if slice_ <= 0:
                x = r
            elif (u / s) * 0.99 > slice_:
                s_target = ((u * s) / (slice_ / 0.99)) ** 0.5
                x = min(r, max(0.0, (s_target - s) / 0.99))
            if x > 0:
                out, u, s = sell(u, s, x)
                taken_pool += out
            h = r - x
            if h > 0:
                frm = melt * h / counting
                melt -= frm
                taken_floor += frm * 0.95
                counting -= h
        if day in days:
            snaps[day] = dict(price=(u / s) / start, floor=melt / counting / start, pool=taken_pool,
                              floor_taken=taken_floor, raised=raised)
    return snaps


def groups(o):
    return dict(f=o["founder"], e=o["size"] - o["short"], r=o["rounds"], a=ADVISORS)


FEASIBLE = [o for o in OPTS if o["short"] < 1]
print("\n== 4. CREATE's pool after the auction (any start: these ratios do not depend on the price) ==")
print(" pool holds 55M Shares and 22 of each 100 raised: 330,000 dollars at a 6M start, 396,000 at 7.2M, 132,000 at 2.4M")
for nm, sh in (("plan's case: 150M self-filled backing", 150 * M), ("plan's 350M held", 350 * M)):
    o1, mv1 = move(sh / 365)
    o30, mv30 = move(sh * 30 / 365)
    print(" %-42s 1 day of release sold %+5.1f%% (%.2f%% of pool dollars), 30 days %+5.1f%% (%.1f%%)" % (
        nm, mv1 * 100, o1 * 100, mv30 * 100, o30 * 100))
print(" check against the plan (22,000 pool): 150M self-filled, day 1 %s and day 30 %s dollars (plan: 162 and 3,996)" % (
    d(move(150 * M / 365)[0] * 22000), d(move(150 * M * 30 / 365)[0] * 22000)))
for o in [NONE] + FEASIBLE:
    e = o["size"] - o["short"]
    o1, mv1 = move(o["held"] / 365)
    o30, mv30 = move(o["held"] * 30 / 365)
    s1, smv1 = move(e / 365)
    s30, smv30 = move(e * 30 / 365)
    print(" %-38s all held: 1 day %+4.1f%%, 30 days %+4.1f%% (%5s of the pool's dollars at 6M); earlier backers alone:"
          " 1 day %+4.1f%% (%7s), 30 days %+4.1f%% (%7s)" % (
              o["name"], mv1 * 100, mv30 * 100, d(o30 * 330000), smv1 * 100, d(s1 * 330000), smv30 * 100,
              d(s30 * 330000)))

print("\n== 5. An auction buyer's floor per Share, as %% of the start (6M start; the same %% at any start) ==")
print("   nobody takes anything out: the floor melts to the project; released held Shares join the count")
for o in [NONE] + FEASIBLE:
    sn = floor_path(0.006, groups(o), ())
    print("   %-38s day 1 %4.1f%%  day 30 %4.1f%%  day 90 %4.1f%%  day 180 %4.1f%%" % (
        o["name"], sn[1]["floor"] * 100, sn[30]["floor"] * 100, sn[90]["floor"] * 100, sn[180]["floor"] * 100))
print("   earlier backers and founder take every released Share out at once (pool down to the floor, then hand back):")
for o in [NONE] + FEASIBLE:
    sn = floor_path(0.006, groups(o), ("f", "e"))
    print("   %-38s by day 30 pool %8s + floor %8s dollars, price x%.2f; by day 180 %9s + %9s, price x%.2f, floor/Share"
          " %4.1f%% (%.1f%% of the 1.5M raised taken)" % (
              o["name"], d(sn[30]["pool"]), d(sn[30]["floor_taken"]), sn[30]["price"], d(sn[180]["pool"]),
              d(sn[180]["floor_taken"]), sn[180]["price"], sn[180]["floor"] * 100,
              (sn[180]["pool"] + sn[180]["floor_taken"]) / sn[180]["raised"] * 100))

print("\n== 6. The most the founder side can take, 6M start (released Shares; dollars if all went out that day on) ==")
for o in [NONE] + FEASIBLE:
    row = []
    for day in (15, 30, 365):
        g = groups(o)
        f_ = floor_path(0.006, g, ("f",), days=(day,))[day]
        b_ = floor_path(0.006, g, ("f", "e"), days=(day,))[day]
        row.append("day %3d: founder %7s %9s $ | with earlier %7s %9s $" % (
            day, m(o["founder"] * day / 365), d(f_["pool"] + f_["floor_taken"]),
            m((o["founder"] + g["e"]) * day / 365), d(b_["pool"] + b_["floor_taken"])))
    print(" %-38s %s" % (o["name"], " || ".join(row)))
print(" per 100 of honest auction money (1,500,000 at 6M): divide the dollars by 15,000")

print("\n== 7. What a 6M round backer and an auction buyer see (6M start, nobody sold; pool and Treasury Shares do not"
      " vote) ==")
rb = 10_000 * B / CV
ab = 10_000 / 0.006
print(" 10,000 in a Creaton round at 6M: %s Shares = %s of all; 10,000 in the auction at the 6M start: %s = %s."
      " The same in every option: the total is fixed" % (m(rb), pct(rb), m(ab), pct(ab)))
for o in [NONE] + FEASIBLE:
    e = o["size"] - o["short"]
    held = o["held"]
    free1 = SALE + POOL_SH
    voters365 = SALE + held
    print(" %-38s day 1: free %s, held %s (held %.0f%% of Shares in people's hands); day 365 of voters: auction %.0f%%,"
          " earlier %.0f%%, founder %.0f%%, a 10,000 round backer %.3f%%" % (
              o["name"], m(free1), m(held), held / (free1 + held) * 100, SALE / voters365 * 100, e / voters365 * 100,
              o["founder"] / voters365 * 100, rb / voters365 * 100))
print(" default project at day 365: founder side (founder + 150M backing + stake) %.0f%% of voters (plan section 10)" % (
    DEFAULT_HELD / (SALE + DEFAULT_HELD) * 100))

# ------------------------------------------------------------------ 8 schedules
print("\n== 8. Release for the S1 Shares: the one clock vs the old sheet and SAFT-style cliffs (day 0 = market open) ==")


def old_seed(t):
    """Sheet: 30-day cliff, then 25% every other month (25% at day 30, 90, 150, 210)."""
    return min(1.0, sum(0.25 for k in range(4) if t >= 30 + 60 * k))


def old_priv(t):
    """Sheet: 30-day cliff, then 25% a month (25% at day 30, 60, 90, 120)."""
    return min(1.0, sum(0.25 for k in range(4) if t >= 30 + 30 * k))


S1_SEED = SEED_OLD / OLD * B
S1_PRIV = PRIV_OLD / OLD * B
SCHED = {
    "one clock: evenly over 365 days": lambda t: (min(1, t / 365), min(1, t / 365)),
    "old sheet (seed / private steps)": lambda t: (old_seed(t), old_priv(t)),
    "6-month cliff, then evenly to 18 months": lambda t: ((0 if t < 182.5 else min(1, t / 547.5)),) * 2,
    "12-month cliff, then evenly to 36 months": lambda t: ((0 if t < 365 else min(1, t / 1095)),) * 2,
}
for nm, f in SCHED.items():
    pts = []
    for t in (1, 15, 30, 90, 180, 365, 547, 1095):
        a, b = f(t)
        pts.append((a * S1_SEED + b * S1_PRIV) / S1 * 100)
    steps = []
    for t in range(0, 1100):
        a0, b0 = f(t)
        a1, b1 = f(t + 1)
        steps.append((a1 - a0) * S1_SEED + (b1 - b0) * S1_PRIV)
    jump = max(steps)
    out, mv = move(jump)
    print(" %-42s free by day 1/15/30/90/180/365/547/1095: %s; biggest one-day step %s (sold at once %+.0f%%, %s $ of a"
          " 330,000 pool)" % (nm, " ".join("%3.0f%%" % p for p in pts), m(jump), mv * 100, d(out * 330000)))
print(" the one clock is the same Vester as the founder's (no second schedule); a cliff is a second Vester schedule")

# ------------------------------------------------------------------ 9 never opens
print("\n== 9. If CREATE's market never opens (built rules; dates judgement) ==")
print(" held Shares release only from the market or a 'no market' declaration (runner, 365 days after the first round"
      " with money); 'no market' closes Creaton's auction for good, so the plan says Creaton's runner never declares it.")
print(" so the earlier backers' Shares stay held: no sending, parking, voting or hand-back, and no pool. Their only right")
print(" is the off-chain one in the replacement agreement. The gate (25 outside projects raised and kept the money 90 days,")
print(" 2,500 of fees in 90 days, the audit) decides when; the old sheet promised all tokens within 3 to 7 months of TGE.")
for gate in (12, 24, 36):
    print("   gate met at month %2d, auction a month later: first Share free month %d, all free month %d" % (
        gate, gate + 1, gate + 13))

# ------------------------------------------------------------------ 10 prices
print("\n== 10. Price per Share and for the whole project ==")
for nm, p in (("seed, kept percent (S1)", SEED_USD / (SEED_OLD / OLD * B)),
              ("private, kept percent (S1)", PRIV_USD / (PRIV_OLD / OLD * B)),
              ("all earlier, kept percent (S1)", USD / S1), ("all earlier at 6M (S2)", USD / S2),
              ("unsold 'Private 2'", 0.055 * OLD / B),
              ("Creaton's rounds at 6M", CV / B), ("auction, app pre-fill 7.2M", 7.2e6 / B)):
    print("   %-32s %.5f a Share = %11s; Creaton's 6M rounds pay %.2fx this" % (nm, p, d(p * B), (CV / B) / p))
print("   a 6M round backer can take back 77.90 of each 100 on day 0 (measured); earlier backers took the risk years"
      " earlier with no refund, and their money is spent")

# ------------------------------------------------------------------ 11 sensitivity
print("\n== 11. What the open facts change (each 10,000 dollars, at the group's own price, in S1 Shares) ==")
print("   seed: 10,000 = %s Shares; private: 10,000 = %s Shares" % (m(10_000 / (SEED_P * OLD) * B),
                                                                     m(10_000 / (PRIV_P * OLD) * B)))
done = DONE_USD
print("   the %d private entries marked DONE are %s dollars = %s Shares under S1 (%.1f%% of S1): if DONE means settled or"
      " repaid, D's founder keeps that much more" % (DONE_N, d(done), m(done / (PRIV_P * OLD) * B), done / PRIV_USD * PRIV_OLD / OLD_SOLD * 100))
for own in (10_000, 25_000, 50_000):
    s = own / (SEED_P * OLD) * B
    print("   if the owner's own seed purchase was %6s dollars: S1 falls to %s; D's founder ends at %s" % (
        d(own), m(S1 - s), pct(FOUNDER - (S1 - s - SPARE))))
