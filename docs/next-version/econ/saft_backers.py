# Creaton's SAFT backers (about 1.2M at a 6M valuation): where their CREATE Shares come from and when they free.
# Plain Python, standard library. Run: python3 -I docs/next-version/econ/saft_backers.py
# Every number printed is SIMULATED (this script) unless the line says "measured" or "judgement".
#
# Facts from the owner (18 November 2026): about 1,200,000 dollars from a few VCs and angels, a SAFT with an old LLC,
# 6M valuation. Not known: before or after the money. Post-money: 1.2M / 6M = 20% = 200M Shares (0.006 a Share).
# Pre-money: 1.2M / 7.2M = 16.67% = 166.67M Shares (0.0072 a Share, so 7.2M in the platform's "price for the whole
# project").
#
# Model (plan v2 + founder-set prices, as built in contracts/next; judgement where it says so):
# - 1,000M Shares at birth: founder 200 (Vester, plain grant), work pot 200 + reserve 100 (Treasury), backing 150
#   (Rounds), auction 250 + pool match 100 (Finisher). Project zero takes no 2% stake (built, nameProjectZero).
# - Creaton's rounds at 6M: the 50,000 Team cap buys 8.33M Shares (measured, PLANV2-M4-REPORT); the rest of the backing
#   slice joins the reserve when the market opens (returnUnsold, built). Assumed here: Creaton fills the Team cap.
# - The auction sells all 250M at the start or above; the pool gets 22 of each 100 and 55M Shares; the 45M pool-match
#   Shares it does not need are reserve; 60 of each 100 is the melting floor, released to the project evenly over 365
#   days (measured split). Held Shares release evenly over 365 days from market open and never count until released.
# - Pool: constant product, 1% fee on the way in (plan_v2.py; reproduces M3 measurements).
# - Hand-back: slice = melting x amount / counting Shares, holder gets 95 of it (built Treasury.handBack; CREATE's
#   permanent fee floor is left out here: it is not sized).

B = 1e9
M = 1e6
SALE, POOL_SH, POOL_LEFT = 250 * M, 55 * M, 45 * M
FOUNDER, WORK, BACK, RES = 200 * M, 200 * M, 150 * M, 100 * M
TEAM_CAP = 50_000
CV = 6_000_000
ROUND_SOLD = TEAM_CAP * B / CV          # 8.33M at 6M
BACK_SPARE = BACK - ROUND_SOLD          # 141.67M the rounds cannot sell at 6M under the Team cap
SAFT_USD = 1_200_000
POST = SAFT_USD / CV * B                # 200M
PRE = SAFT_USD / (CV + SAFT_USD) * B    # 166.67M


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


def move(u, s, sh):
    out, u2, s2 = sell(u, s, sh)
    return out, (u2 / s2) / (u / s) - 1


# ------------------------------------------------------------------ options
def options(y):
    """Shares for the SAFT group y. Each option: founder, work pot, backing left for rounds, reserve at birth."""
    o = {}
    o["0 none (no SAFT)"] = dict(f=FOUNDER, w=WORK, b=BACK, r=RES, saft=0)
    o["A founder's 20%"] = dict(f=FOUNDER - y, w=WORK, b=BACK, r=RES, saft=y)
    o["B work pot"] = dict(f=FOUNDER, w=WORK - y, b=BACK, r=RES, saft=y)
    o["C backing + reserve"] = dict(f=FOUNDER, w=WORK, b=BACK - BACK_SPARE, r=RES - (y - BACK_SPARE), saft=y)
    o["D backing + founder"] = dict(f=FOUNDER - (y - BACK_SPARE), w=WORK, b=BACK - BACK_SPARE, r=RES, saft=y)
    o["D2 half founder, half backing"] = dict(f=FOUNDER - y / 2, w=WORK, b=BACK - y / 2, r=RES, saft=y)
    for k, v in o.items():
        v["sold"] = min(ROUND_SOLD, v["b"])
        v["held"] = v["f"] + v["saft"] + v["sold"]
        v["res_after"] = v["r"] + POOL_LEFT + (v["b"] - v["sold"])
        assert abs(v["f"] + v["w"] + v["b"] + v["r"] + v["saft"] + SALE + 100 * M - B) < 1, k
    return o


DEFAULT = dict(f=FOUNDER, w=WORK, held=FOUNDER + BACK + 20 * M, res_after=RES - 20 * M + POOL_LEFT, saft=0)

print("== 1. Shares at birth and after the market, per option (judgement: Creaton fills its 50,000 Team cap at 6M) ==")
print(" a default project for comparison: founder 20.00%, work pot 20.00%, held at market 370M (founder 200 + backing 150"
      " + stake 20), reserve after the market 125M (100 - 20 stake + 45 pool match left)")
for label, y in (("POST-money 6M: SAFT 200.00M at 0.006", POST), ("PRE-money 6M: SAFT 166.67M at 0.0072", PRE)):
    print(" -- %s --" % label)
    print("   %-31s %9s %9s %10s %9s %10s %12s %12s" % ("option", "founder", "work pot", "rounds can", "reserve", "SAFT",
                                                       "held at mkt", "reserve after"))
    for k, v in options(y).items():
        print("   %-31s %9s %9s %10s %9s %10s %12s %12s" % (
            k, pct(v["f"]), pct(v["w"]), m(v["b"]), pct(v["r"]), m(v["saft"]), m(v["held"]), m(v["res_after"])))
print(" auction 250M (25%) and pool match 100M (10%) are the same in every option; only C changes the reserve at birth")
print(" at 6M Creaton's rounds can sell at most %s (the Team cap); %s of the backing slice can never sell at 6M" % (
    m(ROUND_SOLD), m(BACK_SPARE)))

print("\n== 2. Down rounds after the SAFT: what a 333,333 round could still sell (FOUNDER-PRICE attack 'down round to"
      " friends') ==")
for k, v in options(POST).items():
    if k.startswith("0"):
        continue
    room = v["b"] - 0  # before any round
    most_usd = min(TEAM_CAP, room / 3000)
    print("   %-31s backing left %8s: at 333,333 rounds can sell %8s for %7s dollars (the SAFT paid 0.006, this is 0.000333)"
          % (k, m(room), m(min(room, TEAM_CAP * 3000)), d(most_usd)))


# ------------------------------------------------------------------ markets
STARTS = (("6M start (minimum 1,500,000)", 0.006), ("7.2M start (app pre-fill, minimum 1,800,000)", 0.0072),
          ("2.4M start (fallback, minimum 600,000)", 0.0024))


def floor_path(start, groups, exit_groups, days=(1, 15, 30, 90, 180, 365)):
    """Daily: groups release held Shares; exit_groups sell or hand back each day's release, whichever pays more
    at the margin (pool down to the floor slice, then hand back). Returns snapshots."""
    raised = SALE * start
    u, s = 0.22 * raised, POOL_SH
    melt = 0.60 * raised
    counting = SALE + POOL_SH
    taken_pool = taken_floor = 0.0
    snaps = {}
    total_held = sum(groups.values())
    exit_held = sum(groups[g] for g in exit_groups)
    for day in range(1, 366):
        melt -= melt / (366 - day)          # melts evenly to zero by day 365
        counting += total_held / 365
        r = exit_held / 365
        if r:
            slice_ = melt / counting * 0.95
            p = u / s
            x = 0.0
            if p * 0.99 > slice_ and slice_ > 0:
                k = u * s
                s_target = (k / (slice_ / 0.99)) ** 0.5
                x = min(r, max(0.0, (s_target - s) / 0.99))
            elif slice_ <= 0:
                x = r
            if x > 0:
                out, u, s = sell(u, s, x)
                taken_pool += out
            h = r - x
            if h > 0 and counting > 0:
                frm = melt * h / counting
                melt -= frm
                taken_floor += frm * 0.95
                counting -= h
        if day in days:
            snaps[day] = dict(price=(u / s) / start, floor=melt / counting / start if counting else 0,
                              pool=taken_pool, floor_taken=taken_floor, u=u)
    return snaps


print("\n== 3. CREATE's market per option (post-money SAFT 200M; nobody sells unless stated) ==")
print(" plan's own hold-and-sell numbers, default project, 150M self-filled backing into a 22,000 / 55M pool: day 1 %s,"
      " day 30 %s dollars (re-run of plan_v2.py)" % (d(sell(22000, 55 * M, 150 * M / 365)[0]),
                                                    d(sell(22000, 55 * M, 150 * M * 30 / 365)[0])))
for sname, st in STARTS:
    raised = SALE * st
    pu = 0.22 * raised
    print(" -- %s: pool %s dollars + 55M Shares; floor day one %s dollars = 49.2%% of the price --" % (
        sname, d(pu), d(0.6 * raised)))
    for k, v in list(options(POST).items()) + [("default project (0.0004 start)", DEFAULT)]:
        start = st if not k.startswith("default") else 0.0004
        pu_k = 0.22 * SALE * start
        h = v["held"]
        o1, mv1 = move(pu_k, POOL_SH, h / 365)
        o30, mv30 = move(pu_k, POOL_SH, h * 30 / 365)
        saft_day1, _ = move(pu_k, POOL_SH, v["saft"] / 365)
        saft_30, smv30 = move(pu_k, POOL_SH, v["saft"] * 30 / 365)
        print("   %-31s held %7s = %4.1f x pool dollars; all held 1 day / 30 days of release sold: %+4.0f%% / %+4.0f%%"
              " (%s / %s dollars); SAFT alone day 1 / day 30: %s / %s dollars (%+.0f%%)" % (
                  k, m(h), h * start / pu_k, mv1 * 100, mv30 * 100, d(o1), d(o30), d(saft_day1), d(saft_30),
                  smv30 * 100))
        if k.startswith("default"):
            continue

print("\n== 4. What an auction buyer's floor is worth per Share (as %% of the start), 6M start ==")
print("   nobody exits: the floor melts to the project and released Shares join the count")
for k, v in list(options(POST).items()):
    g = dict(f=v["f"], saft=v["saft"], rounds=v["sold"])
    sn = floor_path(0.006, g, ())
    print("   %-31s day 1 %4.1f%%  day 30 %4.1f%%  day 90 %4.1f%%  day 180 %4.1f%%" % (
        k, sn[1]["floor"] * 100, sn[30]["floor"] * 100, sn[90]["floor"] * 100, sn[180]["floor"] * 100))
print("   founder and SAFT group both take every released Share out at once (pool down to the floor, then hand back):")
for k, v in list(options(POST).items()):
    g = dict(f=v["f"], saft=v["saft"], rounds=v["sold"])
    sn = floor_path(0.006, g, ("f", "saft"))
    print("   %-31s by day 30: pool %8s + floor %8s dollars, price x%.2f, floor/Share %4.1f%%; by day 180: %9s + %9s,"
          " price x%.2f, floor/Share %4.1f%%" % (
              k, d(sn[30]["pool"]), d(sn[30]["floor_taken"]), sn[30]["price"], sn[30]["floor"] * 100,
              d(sn[180]["pool"]), d(sn[180]["floor_taken"]), sn[180]["price"], sn[180]["floor"] * 100))

print("\n== 5. The most the founder (and founder + SAFT group, if they act together) can take, 6M start ==")
print("   released Shares, and dollars if all of it went out at once on that day (pool first, then the floor; nobody else)")
for k, v in list(options(POST).items()):
    row = []
    for day in (15, 30, 365):
        fr = v["f"] * day / 365
        both = (v["f"] + v["saft"]) * day / 365
        g = dict(f=v["f"], saft=v["saft"], rounds=v["sold"])
        sn_f = floor_path(0.006, g, ("f",), days=(day,))[day]
        sn_b = floor_path(0.006, g, ("f", "saft"), days=(day,))[day]
        row.append("day %3d: founder %7s (%8s $), with SAFT %7s (%9s $)" % (
            day, m(fr), d(sn_f["pool"] + sn_f["floor_taken"]), m(both), d(sn_b["pool"] + sn_b["floor_taken"])))
    print("   %-31s %s" % (k, " | ".join(row)))

print("\n== 6. Who holds what on day 1 and on day 365 (6M start, nobody sold; pool Shares do not vote) ==")
for k, v in list(options(POST).items()) + [("default project", dict(DEFAULT, sold=150 * M, stake=20 * M))]:
    held = v["held"]
    free1 = SALE + POOL_SH
    in_hands = free1 + held
    voters365 = SALE + held  # auction buyers + all released held (pool excluded)
    insiders = v["f"] + v["saft"]
    print("   %-31s day 1: free %s, held %s (held = %.0f%% of Shares in hands; auction buyers %.0f%% of voters);"
          " day 365: founder %s, SAFT %s, auction %.0f%% of voters, founder + SAFT %.0f%%" % (
              k, m(free1), m(held), held / in_hands * 100, 100.0, pct(v["f"]), pct(v["saft"]),
              SALE / voters365 * 100, insiders / voters365 * 100))

print("\n== 7. Release schedule for 200M SAFT Shares: the plan's one clock vs SAFT-style cliffs (6M start pool) ==")
def six_cliff(t):
    """6-month cliff, then the rest evenly to month 18 (a third frees at the cliff)."""
    if t < 182.5:
        return 0.0
    return min(1.0, 182.5 / 547.5 + (t - 182.5) / 547.5)


SCHED = {
    "one clock: 365 days from market": lambda t: min(1, t / 365),
    "6-month cliff, then 12 months": six_cliff,
    "12-month cliff, then 24 months": lambda t: 0 if t < 365 else min(1, 1 / 3 + (t - 365) / 730 * 2 / 3),
    "10% at market, 6-month cliff, 18 months": lambda t: 0.1 if t < 182.5 else min(1, 0.1 + 0.9 * (t - 182.5) / 547.5),
}
pu = 0.22 * SALE * 0.006
for name, f in SCHED.items():
    pts = [f(t) for t in (15, 30, 90, 180, 183, 365, 366, 540, 730, 1095)]
    jump = max(f(t + 1) - f(t) for t in range(0, 1100))
    out, mv = move(pu, POOL_SH, jump * POST)
    print("   %-41s free by day 15/30/90/180/183/365/366/540/730/1095: %s; biggest one-day step %s (sold at once: %+.0f%%)"
          % (name, " ".join("%3.0f%%" % (p * 100) for p in pts), m(jump * POST), mv * 100))
print("   one clock: the same Vester as the founder, no contract change; a second schedule is a Vester change (judgement)")

print("\n== 8. Price fairness (per Share, and as the platform's 'price for the whole project') ==")
rows = [
    ("SAFT, post-money", SAFT_USD / POST),
    ("SAFT, pre-money", SAFT_USD / PRE),
    ("Creaton rounds at 6M", 1 / (B / CV)),
    ("Creaton rounds at 7.2M", 7.2e6 / B),
]
for nm, p in rows:
    print("   %-24s %.4f a Share = %s for the whole project" % (nm, p, d(p * B)))
print("   rounds at 6M after a pre-money SAFT sell each Share %.1f%% cheaper than the SAFT backers paid" % (
    (1 - 0.006 / 0.0072) * 100))
print("   a 6M round backer can take back 77.90 of each 100 on day 0 (measured); the SAFT backers cannot (money spent)")
for sname, st in STARTS:
    print("   at the %-44s SAFT post %4.2fx, SAFT pre %4.2fx, a 6M round backer %4.2fx of what they paid (paper)" % (
        sname, st / 0.006, st / 0.0072, st / 0.006))

print("\n== 9. If CREATE's market never opens (judgement on dates; gate per plan section 5) ==")
for gate in (6, 12, 24, 36):
    print("   gate met at month %2d, auction a month later: first SAFT Share free month %d, all free month %d" % (
        gate, gate + 1, gate + 13))
print("   'no market' (runner, 365 days after the first round with money): release starts, auction closed for ever,"
      " no pool, and handBack needs a settled sale, so no on-chain exit at all (built: Treasury.handBack NotSettled)")

print("\n== 10. Founder's share in a normal-company reading (judgement) ==")
for label, y in (("post", POST), ("pre", PRE)):
    print("   %s-money: founder keeps %s if the SAFT comes all from the founder (A), %s with D, %s with D2" % (
        label, pct(FOUNDER - y), pct(FOUNDER - (y - BACK_SPARE)), pct(FOUNDER - y / 2)))
