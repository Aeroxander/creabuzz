# Founder-set prices, the judge's design (docs/next-version/FOUNDER-PRICE.md). Plain Python, standard library.
# Every number printed is SIMULATED (this script) unless the line says "measured".
#
# The design checked here (judgement):
# - A backing round's price is a whole-project value V, 333,333.33 to 50,000,000, fixed when the round opens.
#   Stored on chain as raw Shares per raw dollar = floor(1e21 / V) (Shares 18 decimals, dollars 6).
# - The auction always offers all 250M Shares. The runner picks the starting price (at least 0.0004, at most 0.05).
#   The minimum is what selling all 250M at the starting price raises. The 4x bid cap stays relative to the start.
# - The app pre-fills the auction start with 1.2 x the last round's price (0.0004 exactly for a default project).
# Pool model as plan_v2.py / founder_price.py: constant product, 1% fee, 22 of each 100 raised paired at the price.

B = 1e9
SALE, POOL_MATCH, FOUNDER, STAKE = 250e6, 100e6, 200e6, 20e6
Q96 = 2 ** 96


def buy(usd_pool, sh_pool, usd):
    x = usd * 0.99; out = sh_pool * x / (usd_pool + x)
    return ((usd_pool + x) / (sh_pool - out)) / (usd_pool / sh_pool) - 1


def sell(usd_pool, sh_pool, sh):
    x = sh * 0.99; out = usd_pool * x / (sh_pool + x)
    return out, ((usd_pool - out) / (sh_pool + x)) / (usd_pool / sh_pool) - 1


def raw_price(v):
    return int(10 ** 21 // v) if v != 1e9 / 3000 else 3 * 10 ** 15


print("== 1 the price on chain (raw Shares per raw dollar) ==")
for v in (1e9 / 3000, 600_000, 1_200_000, 6_000_000, 10_000_000, 50_000_000):
    r = raw_price(v)
    print(" V %13s: raw %20d; 1 dollar buys %9.3f Shares; 10,000 buys %7.3fM; 50,000 buys %7.3fM (%.2f%%)" % (
        f"{v:,.0f}", r, r * 1e6 / 1e18, r * 10_000e6 / 1e18 / 1e6, r * 50_000e6 / 1e18 / 1e6, r * 50_000e6 / 1e18 / B * 100))
print(" check: 50,000 dollars at 3e15 = %d raw Shares (150M exactly: %s)" % (
    3 * 10 ** 15 * 50_000 * 10 ** 6, 3 * 10 ** 15 * 50_000 * 10 ** 6 == 150_000_000 * 10 ** 18))


def floor_and_tick(exact_q96):
    tick = (exact_q96 + 99) // 100
    return tick * 100, tick


def start_q96(dollars_per_share):
    # raw dollars per raw Share, times 2^96: dollars x 1e6 / 1e18
    return (int(round(dollars_per_share * 1e6 * 1e12)) * Q96) // 10 ** 30


SALE_RAW = 250_000_000 * 10 ** 18
print("\n== 2 the auction minimum = what all 250M raise at the starting price (integer maths as the Launcher would) ==")
base_exact = (100_000 * 10 ** 6 << 96) // SALE_RAW
fl, tk = floor_and_tick(base_exact)
print(" default (today's salePrices): floorQ96 %d, minimum (floorQ96 x SALE >> 96) = %d raw = %.6f dollars"
      " (today's AUCTION_MINIMUM 100,000.000000)" % (fl, (fl * SALE_RAW) >> 96, ((fl * SALE_RAW) >> 96) / 1e6))
for p in (0.0004, 0.00144, 0.0024, 0.006, 0.0072, 0.05):
    f, _ = floor_and_tick(start_q96(p))
    m = (f * SALE_RAW) >> 96
    print(" start %.5f (%5.2fM whole project): minimum %13s dollars; at the 4x cap at most %13s" % (
        p, p * B / 1e6, f"{m / 1e6:,.2f}", f"{4 * m / 1e6:,.0f}"))


def market(name, start, held):
    raised = SALE * start
    pool_usd, pool_sh = 0.22 * raised, 0.22 * SALE
    day = held / 365
    d_out, d_mv = sell(pool_usd, pool_sh, day)
    m_out, m_mv = sell(pool_usd, pool_sh, day * 30)
    print(" %-44s minimum %10s; pool %9s dollars + %.0fM Shares; buy 2,500 %+5.1f%%; held %5.1fM = %.1f x the pool's"
          " dollars; 1 day / 30 days of release sold: %+.0f%% / %+.0f%%" % (
              name, f"{raised:,.0f}", f"{pool_usd:,.0f}", pool_sh / 1e6, buy(pool_usd, pool_sh, 2500) * 100,
              held / 1e6, held * start / pool_usd, d_mv * 100, m_mv * 100))


print("\n== 3 markets at the minimum, all 250M sold (the floor per Share on day one stays 60/122 = %.1f%%) ==" % (60 / 122 * 100))
market("default, start 0.0004, 150M backed", 0.0004, FOUNDER + STAKE + 150e6)
cre_backed = 50_000 * B / 6e6
for e in (0, 500_000):
    eb = e * B / 6e6
    for st, nm in ((0.0072, "7.2M"), (0.006, "6M"), (0.0024, "2.4M")):
        market("Creaton start %s, earlier %s, no self-stake" % (nm, f"{e:,}"), st, FOUNDER + cre_backed + eb)
print(" Creaton held with a self-stake: add 20M (the stake question in section 8 of the note)")
print(" for contrast, a 6M start with today's fixed 100,000 minimum sells %.1fM Shares (attacker's A5 has the pool"
      " numbers)" % (100_000 / 0.006 / 1e6))

print("\n== 4 Creaton's earlier raise at 6M paid from the work pot (200M) ==")
for e in (100_000, 250_000, 300_000, 500_000, 600_000, 1_000_000):
    s = e * B / 6e6
    print(" %10s dollars -> %6.2fM Shares (%.2f%% of all, %.0f%% of the work pot)" % (f"{e:,}", s / 1e6, s / B * 100, s / 200e6 * 100))

print("\n== 5 a stepped project and the app's pre-filled auction start ==")
steps = [(10_000, 1e9 / 3000), (20_000, 600_000), (20_000, 1_200_000)]
sh = sum(d * B / v for d, v in steps); dol = sum(d for d, _ in steps)
print(" rounds 10,000 at 333,333 / 20,000 at 600,000 / 20,000 at 1,200,000: %.1fM Shares, average paid %.6f a Share"
      " (%.0f whole project)" % (sh / 1e6, dol / sh, dol / sh * B))
print(" pre-filled start 1.2 x last = %.5f (%.2fM), minimum %s; if the founder starts at the average instead: %s" % (
    1.2 * 1.2e6 / B, 1.44, f"{SALE * 1.2 * 1.2e6 / B:,.0f}", f"{SALE * dol / sh:,.0f}"))

print("\n== 6 a down round (allowed in this design) ==")
hon = 10_000 * B / 6e6; cheap = 40_000 * 3000
print(" 10,000 at 6M buys %.2fM; then 40,000 at 333,333 buys %.0fM for the founder's friends (fee %s)."
      " A default founder self-filling 50,000 gets 150M for a 1,500 fee: the down round gives no more." % (
          hon / 1e6, cheap / 1e6, f"{0.03 * 40_000:,.0f}"))
print(" the 6M backers' way out: refund per 100 on day 0 %.2f, week 4 %.2f, week 13 %.2f, week 26 0" % (
    82 * 0.95, 82 * (1 - 28 / 182) * 0.95, 82 * (1 - 91 / 182) * 0.95))

print("\n== 7 faking a high demand signal (the price chips are a suggestion only) ==")
for size in (10_000, 40_000):
    print(" own accounts fill a %s round 4x and refund on day 0: founder side loses 3 + 0.82 of each 100 = %s" % (
        f"{size:,}", f"{size * 0.0382:,.0f}"))
