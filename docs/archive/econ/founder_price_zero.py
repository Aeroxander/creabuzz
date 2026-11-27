# Project zero (Creaton, Shares called CREATE) under founder-set prices, and the "earlier backers" step.
# Plain Python, standard library. Every number printed is SIMULATED (this script) unless a line says otherwise.
# Nothing about Creaton's actual earlier raise is known here: the earlier-raise amounts below are a RANGE OF CASES,
# not facts. The owner must supply the real amount, date, instrument and backers.
#
# Model (judgement unless stated):
# - 1,000,000,000 Shares: founder 200M, work pot 200M, backing 150M, auction 250M, pool match 100M, reserve 100M (plan v2).
# - A founder-set round price is a whole-project value V: Shares per dollar = 1e9 / V. Lowest V = 333,333.33 (today's
#   3,000 Shares a dollar). Creaton's first round: V = 6,000,000.
# - Caps stay in dollars: 10,000 Solo, 50,000 Team (plan v2 section 3).
# - Earlier backers: listed once, before the first round, from the 150M backing slice, at most 100M (10%) of all Shares;
#   anything above that comes out of the founder's own 200M if the founder chooses. Held in the Vester on the same 365-day
#   clock as the founder's Shares, no refund (their money never passed through the platform).
# - Auction start = the last round's price per Share (the lead's floated rule; the sibling script founder_price.py also
#   models 1.2 x). Minimum stays 100,000 dollars; bids at most 4 x the start. Pool gets 22 of each 100 raised.
B = 1e9
DEFAULT_V = 1e9 / 3000
SOLO_CAP, TEAM_CAP = 10_000, 50_000
FOUNDER, BACKING, SALE, POOL_MATCH, STAKE = 200e6, 150e6, 250e6, 100e6, 20e6
EARLIER_MAX = 100e6
CV = 6_000_000


def m(x):
    return "%.2fM" % (x / 1e6)


def d(x):
    return f"{x:,.0f}"


def sell(usd_pool, sh_pool, sh):
    x = sh * 0.99
    out = usd_pool * x / (sh_pool + x)
    return out, ((usd_pool - out) / (sh_pool + x)) / (usd_pool / sh_pool) - 1


print("== 1. CREATE's rounds at 6,000,000 ==")
spd = B / CV
print(" 1 dollar buys %.2f Shares (raw %d per raw dollar unit; today 3e15); 0.006 dollars a Share" % (spd, int(1e21 // CV)))
for name, cap in (("Solo cap", SOLO_CAP), ("Team cap", TEAM_CAP)):
    print(" %s %s buys %s Shares = %.3f%% of all; platform 3%% = %s (paid to Creaton itself), at once %s, weekly %s" % (
        name, d(cap), m(cap * spd), cap * spd / B * 100, d(cap * 0.03), d(cap * 0.15), d(cap * 0.82 / 26)))
print(" to sell the whole 150M backing slice at 6M would need %s dollars (18 x the Team cap)" % d(BACKING / spd))

print("\n== 2. Caps expressed three ways, at 333,333 / 1,000,000 / 6,000,000 ==")
for v in (DEFAULT_V, 1_000_000, CV):
    s = B / v
    share_solo, share_team = 0.03 * B / s, 0.15 * B / s
    k = min(4.0, (v / DEFAULT_V) ** 0.5)
    print(" V %10s: dollar caps 10,000 / 50,000 sell %s / %s Shares;  caps as 3%% / 15%% of Shares = %s / %s dollars;"
          "  sqrt-scaled (max 4x) = %s / %s dollars" % (d(v), m(SOLO_CAP * s), m(TEAM_CAP * s), d(share_solo),
                                                       d(share_team), d(SOLO_CAP * k), d(TEAM_CAP * k)))
print(" with Share caps a founder lifts their own dollar cap by raising the price: 333,333 -> 6M moves the Solo cap from"
      " 10,000 to %s dollars held by one person" % d(0.03 * CV))

print("\n== 3. Earlier raise at 6M: Shares owed, where they come from, what is left for rounds (CASES, not facts) ==")
print(" %10s | %-26s | %-26s | from backing | from founder | founder keeps | left for rounds | most a round can take at 6M"
      % ("raised", "post-money: Shares (%)", "pre-money: Shares (%)"))
for x in (100_000, 250_000, 500_000, 600_000, 1_000_000, 1_500_000):
    post = x / CV * B
    pre = x / (CV + x) * B
    from_back = min(post, EARLIER_MAX)
    from_f = post - from_back
    left = BACKING - from_back
    most = min(TEAM_CAP, left / spd)
    print(" %10s | %10s (%5.2f%%)         | %10s (%5.2f%%)         | %12s | %12s | %13s | %15s | %s" % (
        d(x), m(post), post / B * 100, m(pre), pre / B * 100, m(from_back), m(from_f), m(FOUNDER - from_f), m(left),
        d(most)))
print(" every case leaves at least 50M backing Shares, which at 6M is %s dollars of rounds: the 50,000 cap binds first"
      % d(50e6 / spd))

print("\n== 4. An ordinary founder with a pre-seed ==")
for x, v, rv in ((20_000, 500_000, 500_000), (50_000, 1_000_000, 1_000_000), (100_000, 1_000_000, 1_500_000),
                 (150_000, 1_000_000, 1_000_000)):
    post = x / v * B
    listed = min(post, EARLIER_MAX)
    left = BACKING - listed
    most = min(TEAM_CAP, left * rv / B)
    print(" raised %s at %s before: %s Shares (%.1f%%), %s listed from backing, %s from founder; rounds at %s can take"
          " %s of the 50,000 Team cap before the backing Shares run out" % (
              d(x), d(v), m(post), post / B * 100, m(listed), m(post - listed), d(rv), d(most)))
print(" the same founder today, without the step, can already give the same Shares from the 200M work pot before a market"
      " (Treasury.giveShares, no limit before the market, same 365-day clock) - but unlabelled and out of the work pot")

print("\n== 5. Held Shares when CREATE's market opens (auction start = last round price 0.006) ==")
start = 1 / spd
print(" auction start %.4f a Share (whole project %s); 100,000 minimum sells %s Shares; selling all 250M at the start"
      " raises %s; the 4x cap allows at most %s" % (start, d(start * B), m(100_000 / start), d(SALE * start),
                                                    d(SALE * 4 * start)))
default_held = FOUNDER + BACKING + STAKE
print(" default project held at open (founder + full backing + stake): %s" % m(default_held))
for x in (0, 300_000, 600_000, 1_000_000):
    post = x / CV * B
    # the part above 100M comes out of the founder's 200M, so it does not add to what is held
    held_no_stake = FOUNDER + min(post, EARLIER_MAX) + TEAM_CAP * spd
    held_self_stake = held_no_stake + STAKE
    for raised in (100_000, 720_000, 1_500_000):
        sold = min(SALE, raised / start)
        pool_usd, pool_sh = 0.22 * raised, 0.22 * raised / start
        _, move30 = sell(pool_usd, pool_sh, held_no_stake / 365 * 30)
        print(" earlier %9s: held %s (no self-stake; %s with it); auction %9s sells %s, pool %s dollars;"
              " held on paper = %.1f x pool dollars; 30 days of release sold at once moves the price %+.0f%%" % (
                  d(x), m(held_no_stake), m(held_self_stake), d(raised), m(sold), d(pool_usd),
                  held_no_stake * start / pool_usd, move30 * 100))
print(" note: earlier backers listed inside the 150M slice (excess from the founder's 200M) never push held Shares above"
      " the default project's %s; at most %s for CREATE (no self-stake, Team cap filled)" % (
          m(default_held), m(FOUNDER + EARLIER_MAX + TEAM_CAP * spd)))
print(" the 100,000 minimum at a 0.006 start is the weak case: a 22,000 pool against 200M+ held Shares;"
      " a minimum of 100M Shares x start = %s gives a %s pool" % (d(100e6 * start), d(0.22 * 100e6 * start)))

print("\n== 6. The 2% stake on project zero ==")
print(" Creaton's stake in CREATE would be 20M CREATE held by Creaton itself: %s dollars on paper at 0.006;"
      " 2%% of the Shares owned by the platform that the Shares stand for" % d(STAKE * start))
print(" 3%% raise fee on CREATE's 50,000 Team rounds: %s, paid by CREATE's backers to Creaton, half of which"
      " (per plan v2 section 5) goes into CREATE's own floor" % d(TEAM_CAP * 0.03))

print("\n== 7. What the earlier backers wait for (judgement on dates; the gate is plan v2 section 5) ==")
for gate_months in (6, 12, 24):
    first = gate_months
    print(" gate met after %2d months, auction about 1 month later: first earlier-backer Share free at month %d,"
          " all free at month %d (365-day release from the market)" % (gate_months, first + 1, first + 13))
print(" if no market at all: the runner may declare 'no market' 365 days after launch (if no round took money) and the"
      " release starts then, but the auction is closed for ever - project zero must never do this")
