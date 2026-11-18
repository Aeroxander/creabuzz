# Founder-set backing prices: how they carry into the auction, the pool and reserve sales.
# Plain Python, standard library. Every number printed is SIMULATED (this script), except the M3/M4 check lines.
#
# Model (judgement unless stated):
# - 1,000,000,000 Shares. Backing budget 150M, auction 250M, pool match 100M, reserve 100M, founder 200M, work pot 200M.
# - A backing round is priced by the founder as a whole-project value V (dollars for all 1B Shares).
#   Shares per dollar = 1e9 / V. Default V = 333,333.33 (3,000 Shares a dollar), the lowest allowed.
# - Each 100 accepted: 3 platform, 15 at once, 82 over 26 weeks; refund = unreleased 82 less 5 (unchanged, price-free).
# - Auction floor = 1.2 x the last round's price per Share (default: 0.0004 exactly, today's number).
# - Auction minimum, three options:  A = 100,000 dollars;  B = max(100,000, 100M Shares x floor);  C = 250M Shares x floor.
# - Auction clearing: uniform price (simplified; the real auction clears block by block, so raise <= sold x final price).
#   Demand D dollars willing to pay up to the cap: if D < 250M x floor, sold = D / floor at the floor (a partial sale);
#   else price = min(D / 250M, 4 x floor), all 250M sold.
# - Pool: 22 of each 100 raised, paired at the clearing price, so pool Shares = 0.22 x raise / price <= 0.22 x sold <= 55M.
#   Plain constant-product pool with a 1% fee (the plan_v2.py model, checked below against M3 measurements).
# - Day-one floor per Share = 60 of each 100 raised / (Shares sold + pool Shares).
B = 1e9
DEFAULT_V = 1e9 / 3000          # 333,333.33
SOLO_CAP, TEAM_CAP = 10_000, 50_000
BACKING, SALE, POOL_MATCH, RESERVE, FOUNDER, STAKE = 150e6, 250e6, 100e6, 100e6, 200e6, 20e6


def buy(usd_pool, sh_pool, usd):
    x = usd * 0.99; out = sh_pool * x / (usd_pool + x)
    return out, ((usd_pool + x) / (sh_pool - out)) / (usd_pool / sh_pool) - 1


def sell(usd_pool, sh_pool, sh):
    x = sh * 0.99; out = usd_pool * x / (sh_pool + x)
    return out, ((usd_pool - out) / (sh_pool + x)) / (usd_pool / sh_pool) - 1


def floor_of(last_round_v):
    return 1.2 * last_round_v / B


def minimum(option, floor):
    return {"A": 100_000, "B": max(100_000, 100e6 * floor), "C": SALE * floor}[option]


def auction(floor, demand):
    """Return (sold, price, raise). Uniform clearing, demand at the 4x cap or below."""
    if demand < SALE * floor:
        return demand / floor, floor, demand
    price = min(demand / SALE, 4 * floor)
    return SALE, price, SALE * price


def market(name, last_v, backing_dollars_by_v, option, demand, show=True):
    """Open a market after rounds; report pool, floor, overhang. backing_dollars_by_v: list of (dollars, V)."""
    floor = floor_of(last_v)
    mn = minimum(option, floor)
    sold, price, raised = auction(floor, demand)
    ok = raised >= mn - 1e-6
    backed_shares = sum(d * B / v for d, v in backing_dollars_by_v)
    if not ok:
        if show:
            print("   %-34s opt %s: floor %.6f (%.2fM), minimum %s, demand %s -> FAILS, everyone refunded" % (
                name, option, floor, floor * B / 1e6, f"{mn:,.0f}", f"{demand:,.0f}"))
        return None
    pool_usd = 0.22 * raised
    pool_sh = min(pool_usd / price, POOL_MATCH)
    held = FOUNDER + backed_shares + STAKE
    floor_ps = 0.60 * raised / (sold + pool_sh)
    day_rel = held / 365
    d_out, d_move = sell(pool_usd, pool_sh, day_rel)
    w_out, w_move = sell(pool_usd, pool_sh, day_rel * 7)
    m_out, m_move = sell(pool_usd, pool_sh, day_rel * 30)
    _, b100 = buy(pool_usd, pool_sh, 100)
    _, b2500 = buy(pool_usd, pool_sh, 2500)
    leftover = (SALE - sold) + (POOL_MATCH - pool_sh) + (BACKING - backed_shares) + (RESERVE - STAKE)
    if show:
        print("   %-34s opt %s: floor %.6f (%.2fM), minimum %s; raised %s at %.6f (%.2fM), sold %.1fM" % (
            name, option, floor, floor * B / 1e6, f"{mn:,.0f}", f"{raised:,.0f}", price, price * B / 1e6, sold / 1e6))
        print("      pool %s dollars + %.1fM Shares (%.1fM of the 100M match unused); buy 100 %+.2f%%, buy 2,500 %+.1f%%;"
              " floor/Share day 1 = %.1f%% of price" % (f"{pool_usd:,.0f}", pool_sh / 1e6, (POOL_MATCH - pool_sh) / 1e6,
                                                     b100 * 100, b2500 * 100, floor_ps / price * 100))
        print("      held at open %.0fM Shares = %s dollars on paper = %.1f x the pool's dollars; selling 1 day / 7 days /"
              " 30 days of their release at once: %+.0f%% / %+.0f%% / %+.0f%%, takes %s / %s / %s dollars" % (
                  held / 1e6, f"{held * price:,.0f}", held * price / pool_usd, d_move * 100, w_move * 100, m_move * 100,
                  f"{d_out:,.0f}", f"{w_out:,.0f}", f"{m_out:,.0f}"))
        print("      platform 3%%: %s; Shares left over to the reserve %.0fM (%.0f%% of all)" % (
            f"{0.03 * raised:,.0f}", leftover / 1e6, leftover / B * 100))
    return dict(raised=raised, price=price, pool_usd=pool_usd, pool_sh=pool_sh, sold=sold, leftover=leftover)


print("== model check (vs measured) ==")
print("2,200 pool / 88M: buy 100 %+.1f%% (M3 measured +9.2); 880 / 35.2M: %+.1f%% (M3 +23.7)" % (
    buy(2200, 88e6, 100)[1] * 100, buy(880, 35.2e6, 100)[1] * 100))
print("100,000 auction pool 22,000 / 55M: buy 100 %+.2f%%, buy 2,500 %+.1f%% (M4 measured +0.9 and +23.7)" % (
    buy(22000, 55e6, 100)[1] * 100, buy(22000, 55e6, 2500)[1] * 100))
print("floor per Share at open, any uniform price: 60 / 122 = %.1f%% (M3/M4 measured 49.2)" % (60 / 122 * 100))
print("default auction floor = 1.2 x 1/3000 = %.6f (Launcher.salePrices today: 100,000 / 250M = %.6f)" % (
    floor_of(DEFAULT_V), 100_000 / SALE))

print("\n== the price range ==")
for v in (DEFAULT_V, 600_000, 1_200_000, 6_000_000, 10_000_000):
    spd = B / v
    print("V %13s: %8.2f Shares a dollar (raw %d per raw dollar); Solo 10,000 buys %6.2fM (%.3f%%), Team 50,000 buys"
          " %6.2fM (%.3f%%) of the 150M budget %.1f%%; budget would need %s dollars" % (
              f"{v:,.0f}", spd, int(1e21 // v), SOLO_CAP * spd / 1e6, SOLO_CAP * spd / B * 100, TEAM_CAP * spd / 1e6,
              TEAM_CAP * spd / B * 100, TEAM_CAP * spd / BACKING * 100, f"{BACKING / spd:,.0f}"))
print("below 333,333 the Team cap needs more than 150M Shares: at 250,000, 50,000 buys %.0fM" % (TEAM_CAP * B / 250_000 / 1e6))

print("\n== money split and refund per 100 (price-free) ==")
for d in (0, 28, 45, 91, 182):
    print(" refund per 100 on day %d: %.2f" % (d, 82 * (1 - d / 182) * 0.95))
print(" founder side by day 15: %.1f of each 100" % (15 + 82 * 15 / 182))
print(" cost to a founder of self-filling a round and refunding on day 0: platform keeps %.2f of each 100;"
      " an outsider faker loses %.2f" % (3 + 82 * 0.01, 3 + 15 + 82 * 0.05))

print("\n== 1. default project: 10,000 Solo + 40,000 Team at 333,333; auction ==")
rounds = [(10_000, DEFAULT_V), (40_000, DEFAULT_V)]
for opt in "ABC":
    market("demand = 100,000", DEFAULT_V, rounds, opt, 100_000)
market("demand = 250,000", DEFAULT_V, rounds, "B", 250_000)
market("demand 4,000,000 (10x at cap)", DEFAULT_V, rounds, "B", 4_000_000)

print("\n== 2. Creaton at 6,000,000: 10,000 Solo + 40,000 Team at 6M; auction ==")
cv = 6_000_000
rounds = [(10_000, cv), (40_000, cv)]
print(" backing: %.2fM Shares for 50,000 (%.2f%%); %.1fM of the 150M budget unsold -> reserve at market" % (
    50_000 * B / cv / 1e6, 50_000 / cv * 100, (BACKING - 50_000 * B / cv) / 1e6))
print(" platform on the rounds: %s; project at once %s, released weekly %s" % (
    f"{1500:,.0f}", f"{7500:,.0f}", f"{50_000 * .82 / 26:,.0f}"))
for opt, dem in (("A", 100_000), ("B", 100_000), ("B", 720_000), ("C", 720_000), ("C", 1_800_000)):
    market("demand = %s" % f"{dem:,.0f}", cv, rounds, opt, dem)
market("demand 2,000,000", cv, rounds, "B", 2_000_000)
market("demand at the cap, 72,000,000", cv, rounds, "B", 72_000_000)
print(" Creaton's most: backing 50,000 + auction %s at the 4x cap (auction value %.1fM)" % (
    f"{SALE * 4 * floor_of(cv):,.0f}", 4 * floor_of(cv) * B / 1e6))

print("\n== 3. stepping 333,333 -> 600,000 -> 1,200,000 ==")
steps = [(10_000, DEFAULT_V, "Solo"), (20_000, 600_000, "Team"), (20_000, 1_200_000, "Team")]
tot_sh = 0
for d, v, st in steps:
    sh = d * B / v; tot_sh += sh
    print(" %s round %s at %s: %.2fM Shares (%.3f%%)" % (st, f"{d:,}", f"{v:,.0f}", sh / 1e6, sh / B * 100))
print(" backing total 50,000 for %.2fM Shares (%.2f%%), average value %s; 150M budget %.1fM unsold" % (
    tot_sh / 1e6, tot_sh / B * 100, f"{50_000 / tot_sh * B:,.0f}", (BACKING - tot_sh) / 1e6))
for d, v, st in steps:
    print("  a 100-dollar backer at %s holds, on paper at the auction floor %s: %.0f dollars" % (
        f"{v:,.0f}", f"{floor_of(1_200_000) * B:,.0f}", 100 * floor_of(1_200_000) * B / v))
rounds = [(d, v) for d, v, _ in steps]
for opt, dem in (("A", 100_000), ("B", 100_000), ("B", 144_000), ("B", 360_000), ("C", 360_000)):
    market("demand = %s" % f"{dem:,.0f}", 1_200_000, rounds, opt, dem)

print("\n== 4. pairing check: pool Shares never exceed 0.22 x sold, so the 100M match is never short ==")
for v in (DEFAULT_V, 1_200_000, 6_000_000, 10_000_000):
    f = floor_of(v)
    for mult in (1, 2, 4):
        dem = SALE * f * mult
        sold, price, raised = auction(f, dem)
        print(" V %10s demand %3dx: price %.6f, pool %s dollars / %.1fM Shares (cap 100M), unused match %.1fM" % (
            f"{v:,.0f}", mult, price, f"{0.22 * raised:,.0f}", 0.22 * raised / price / 1e6,
            (POOL_MATCH - 0.22 * raised / price) / 1e6))

print("\n== 5. reserve sale after Creaton's market (option B, demand 720,000) ==")
r = market("", cv, [(50_000, cv)], "B", 720_000, show=False)
print(" reserve holds %.0fM Shares; a reserve sale starts at the last end price %.6f (value %.1fM);"
      " selling 50M there at the start raises %s (3 platform, 15 at once, 82 floor)" % (
          r["leftover"] / 1e6, r["price"], r["price"] * B / 1e6, f"{50e6 * r['price']:,.0f}"))

print("\n== 6. platform income per project (3% of money; the stake is paper, not money) ==")
for name, rb, ra, price in (("default, 50,000 + 100,000 auction", 50_000, 100_000, 0.0004),
                            ("Creaton 6M, 50,000 + 720,000 auction (B)", 50_000, 720_000, floor_of(cv)),
                            ("Creaton 6M, 50,000 + 100,000 auction (A)", 50_000, 100_000, floor_of(cv)),
                            ("stepped to 1.2M, 50,000 + 144,000 (B)", 50_000, 144_000, floor_of(1_200_000))):
    pool = 0.22 * ra
    trades = pool * 10 * 0.005  # bear turnover 10x pool dollars a year, platform half of the 1%
    print(" %-42s raise fee %s, pool trades (10x/yr) %s; stake 20M Shares on paper %s" % (
        name, f"{0.03 * (rb + ra):,.0f}", f"{trades:,.0f}", f"{STAKE * price:,.0f}"))

print("\n== 7. which round price sets the auction floor? (gaming checks) ==")


def floors(rounds):
    """rounds: list of (accepted dollars, V). Returns (floor from last, from average, from max(last, average))."""
    taken = [(d, v) for d, v in rounds if d > 0]
    if not taken:
        f = floor_of(DEFAULT_V); return f, f, f
    last = floor_of(taken[-1][1])
    avg_v = sum(d for d, _ in taken) / sum(d * B / v for d, v in taken) * B
    avg = floor_of(avg_v)
    return last, avg, max(last, avg)


cases = [
    ("Creaton: 50,000 at 6M", [(50_000, cv)]),
    ("dump: 10,000 at 6M, then 1 dollar at 333,333", [(10_000, cv), (1, DEFAULT_V)]),
    ("drag: 10,000 at 6M, then 40,000 at 333,333", [(10_000, cv), (40_000, DEFAULT_V)]),
    ("pump: 10,000 at 333,333, then 1 dollar at 10M", [(10_000, DEFAULT_V), (1, 10_000_000)]),
    ("stepped 333k -> 600k -> 1.2M", [(10_000, DEFAULT_V), (20_000, 600_000), (20_000, 1_200_000)]),
    ("6M round nobody backed, then 333,333 filled", [(0, cv), (10_000, DEFAULT_V)]),
]
for name, rs in cases:
    l, a, m = floors(rs)
    print(" %-46s floor value from last %6.2fM, average %6.2fM, max %6.2fM; option-B minimum at max %s" % (
        name, l * B / 1e6, a * B / 1e6, m * B / 1e6, f"{minimum('B', m):,.0f}"))
print(" pumping costs the founder: the minimum rises from %s to %s (more capital to open a market), nothing else" % (
    f"{minimum('B', floor_of(DEFAULT_V)):,.0f}", f"{minimum('B', floor_of(10_000_000)):,.0f}"))

print("\n== 8. faking demand to trigger a price step (why it is a suggestion, not automatic) ==")
size = 10_000
for honest in (0, 2_000, 10_000):
    fake_ask = 4 * size - honest           # make the round look 4x asked
    acc_fake = size * fake_ask / (fake_ask + honest)
    print(" honest asks %6s: a founder's accounts ask %s to show 4x; returned at settle %s; accepted %s;"
          " cost if refunded day 0 = %s (3.82 of each 100); honest backers get %.0f%% of their ask" % (
              f"{honest:,}", f"{fake_ask:,}", f"{fake_ask - acc_fake:,.0f}", f"{acc_fake:,.0f}",
              f"{acc_fake * 0.0382:,.0f}", size / (fake_ask + honest) * 100))
