"""Platform and CREATE economics. SIMULATED: every figure rests on the assumptions printed beside it.
Plain standard library. Nothing here was run against contracts."""
import random, statistics as st

STAKE = 0.02            # Creaton's part of each project's 1,000,000,000 Shares
SOLD = 0.40             # part of Shares sold for the raise (so stake paper value = STAKE/SOLD of the raise)
SPLIT = dict(run=0.40, pot=0.30, floor=0.30)   # what happens to each fee dollar

def year(name, a, quiet=False):
    rounds = a['rounds_n'] * a['rounds_avg']          # plain backing rounds: 3 / 15 / 82, no pool
    aucts = a['auct_n'] * a['auct_avg']               # auction into pool: 3 / 22 / 15 / 60
    raised = rounds + aucts
    raise_fee = 0.03 * raised
    pool_usd = 0.22 * aucts
    volume = pool_usd * a['turnover']
    # 1% fee on the token paid in; only the dollar half is kept, half of that is the platform's (LiquidityHolder.collect)
    trade_fee = volume * a['buy_share'] * 0.01 * 0.5
    floor = 0.82 * rounds + 0.60 * aucts
    exit_fee = floor * a['handed_back'] * 0.01
    task_fee = a['tasks'] * 0.025
    mgr = a['mgr_paid'] * 120
    cash = raise_fee + trade_fee + exit_fee + task_fee + mgr
    paper = raised * STAKE / SOLD
    costs = a['hosting'] + a['season_projects'] * 240 * a['call_cost'] + a['active'] * 520 * a['call_cost'] + (a['rounds_n'] + a['auct_n']) * a['gas_per_raise']
    r = dict(raised=raised, raise_fee=raise_fee, trade_fee=trade_fee, exit_fee=exit_fee, task_fee=task_fee, mgr=mgr,
             cash=cash, paper=paper, costs=costs, run=cash * SPLIT['run'], pot=cash * SPLIT['pot'], floor=cash * SPLIT['floor'],
             pool_usd=pool_usd, volume=volume)
    if not quiet:
        print(f"\n== {name} ==")
        for k, v in r.items(): print(f"  {k:10s} {v:14,.0f}")
        print(f"  take rate (cash / raised) {cash / raised:.2%};  pot per six-week season {r['pot'] / 8:,.0f};  running left after costs {r['run'] - costs:,.0f}")
    return r

BEAR = dict(rounds_n=185, rounds_avg=3000, auct_n=15, auct_avg=30000, turnover=10, buy_share=0.5, handed_back=0.25,
            tasks=100_000, mgr_paid=20, hosting=3000, season_projects=200, active=150, call_cost=0.02, gas_per_raise=2.0)
GOOD = dict(rounds_n=1800, rounds_avg=5000, auct_n=200, auct_avg=60000, turnover=40, buy_share=0.5, handed_back=0.10,
            tasks=2_000_000, mgr_paid=300, hosting=20000, season_projects=1200, active=1500, call_cost=0.02, gas_per_raise=2.0)
b = year("BEAR YEAR", BEAR); g = year("GOOD YEAR", GOOD)

print("\n== sensitivity: cash income ==")
for nm, base in (("bear", BEAR), ("good", GOOD)):
    for f in (0.5, 1, 2):
        a = dict(base); a['rounds_n'] = base['rounds_n'] * f; a['auct_n'] = base['auct_n'] * f
        print(f"  {nm}: number of raises x{f}: {year('', a, True)['cash']:,.0f}", end=" | ")
    print()
    for t in (0.25, 1, 2):
        a = dict(base); a['turnover'] = base['turnover'] * t
        print(f"  {nm}: pool turnover x{t} ({a['turnover']:.0f}x a year): {year('', a, True)['cash']:,.0f}", end=" | ")
    print()

print("\n== scale needed (40% of fees is running money) ==")
for nm, r in (("bear mix", b), ("good mix", g)):
    take = r['cash'] / r['raised']
    for need, what in ((72_000, "one modest wage + servers"), (300_000, "two builders + servers"), (600_000, "team of four")):
        print(f"  {nm} (take {take:.2%}): {what} = {need:,} running -> fees {need / SPLIT['run']:,.0f} -> raised {need / SPLIT['run'] / take:,.0f} a year")

# ---- the accelerator stake as an index -------------------------------------------------------------------------------
OUT = {  # (chance, value of the Shares 3 years on as a multiple of the raise price). JUDGEMENT.
    'bear': [(0.85, 0), (0.10, 0.25), (0.04, 1), (0.009, 5), (0.001, 50)],
    'good': [(0.70, 0), (0.17, 0.5), (0.09, 2), (0.035, 10), (0.005, 100)],
}
REAL = 0.6   # part of paper value actually collected when sold slowly into the pool (judgement; see sell-down below)
def draw(dist):
    x = random.random(); c = 0
    for p, m in dist:
        c += p
        if x < c: return m
    return dist[-1][1]
def cohort(a, dist, pct, runs=20000):
    res = []
    for _ in range(runs):
        v = 0.0
        for n, avg in ((int(a['rounds_n']), a['rounds_avg']), (int(a['auct_n']), a['auct_avg'])):
            for _ in range(n): v += avg * pct / SOLD * draw(dist) * REAL
        res.append(v)
    res.sort()
    return st.mean(res), res[len(res) // 2], res[len(res) // 10], res[9 * len(res) // 10]
random.seed(7)
print("\n== stake: what one year's projects are worth to Creaton 3 years later (collected dollars) ==")
for nm, a in (("bear", BEAR), ("good", GOOD)):
    for pct in (0.01, 0.02, 0.03, 0.05):
        m, med, lo, hi = cohort(a, OUT[nm], pct, 4000 if nm == 'good' else 20000)
        paper = (a['rounds_n'] * a['rounds_avg'] + a['auct_n'] * a['auct_avg']) * pct / SOLD
        print(f"  {nm} {pct:.0%}: paper at birth {paper:10,.0f} | mean {m:10,.0f} median {med:10,.0f} 1-in-10 low {lo:10,.0f} 1-in-10 high {hi:10,.0f}")
print("  stake sensitivity (2%, good year): chance of a 100x project 0.5% -> 0.1%:")
d2 = [(0.704, 0), (0.17, 0.5), (0.09, 2), (0.035, 10), (0.001, 100)]
print("   mean/median/low/high", [round(x) for x in cohort(GOOD, d2, 0.02, 4000)])

# ---- what the stake does to the floor, and what handing it back would be worth ---------------------------------------
print("\n== 10,000 auction raise: stake released over 365 days, floor 6,000 melting over 365 days ==")
best = 0
for day in (0, 30, 90, 180, 270, 364):
    t = day / 365
    people = 400 + 60 + 200 * t            # millions: buyers + pool + founder released
    stake = 1000 * STAKE * t               # millions released
    floor = 6000 * (1 - t)
    dil = stake / (people + stake)
    back = floor * dil * 0.95
    print(f"  day {day:3d}: floor {floor:6,.0f}; stake released {stake:5.1f}M; floor per Share lower by {dil:.2%}; if Creaton could hand back it would take {back:6.2f}")
print("  max over the year:", round(max(6000 * (1 - d / 365) * (20 * d / 365) / (460 + 220 * d / 365) * 0.95 for d in range(366)), 2))

# ---- selling the stake into the pool (constant product; checked against M3's measured 9M Shares -> -17.5%, 202.27) ---
def sell(pool_usd, pool_sh, s):
    out = pool_usd * (1 - pool_sh / (pool_sh + s * 0.99)); return out, (pool_sh / (pool_sh + s * 0.99)) ** 2 - 1
print("\n== sell-down, nobody else trading ==")
print("  check vs measured: 9M into 2,200 / 88M ->", [round(x, 3) for x in sell(2200, 88e6, 9e6)])
for nm, usd, price in (("Standard 10,000", 2200, 0.000025), ("Large 50,000", 11000, 0.000125)):
    one, mv = sell(usd, 88e6, 2e6); allp, mv2 = sell(usd, 88e6, 20e6)
    print(f"  {nm}: paper {20e6 * price:,.0f}; one month's 2M Shares -> {one:,.0f} (price {mv:.1%}); all 20M -> {allp:,.0f} = {allp / (20e6 * price):.0%} of paper (price {mv2:.1%})")

# ---- matching pot farm ------------------------------------------------------------------------------------------------
print("\n== matching pot: a fake project backed with the faker's own money through fresh wallets ==")
def farm(own, match, days_paid, wins=1.0):
    fee = 0.03 * own
    at_once = 0.15 * own
    floor_own = 0.82 * own
    back_own = floor_own * 0.95            # hands own Shares back at once (pot Shares stay, so the slice is his own money)
    left_behind = floor_own * 0.04         # stays in the floor and is released to him with the match
    got_match = (match + left_behind) * days_paid / 365
    return wins * got_match + at_once + back_own - own
for label, match, days in (("automatic match 50% of round, junk check-ins for a year", 2500, 365),
                           ("voted match, Creaton's Shares vote Stop after 6 weeks", 2500, 42),
                           ("voted match, stopped after 2 weeks", 2500, 14)):
    print(f"  own money 5,000, {label}: profit {farm(5000, match, days):8,.0f}")
print("  break-even days of payments before a Stop:", round(365 * (5000 - 750 - 3895) / (2500 + 164)))
