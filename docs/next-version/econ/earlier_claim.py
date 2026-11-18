# Creaton (project zero) earlier backers: the on-chain claim. Plain Python, standard library, run with `python3 -I`.
# Every number printed is SIMULATED (this script) unless a line says otherwise. Contract lane, 18 November 2026.
#
# Owner's facts (18 November 2026; the old token sheet, totals and counts only, no names or addresses here):
#   seed    177,500 dollars from 3 entries at 0.02 an old token    =  8,875,000 old tokens
#   private 1,052,457 dollars from 18 entries at 0.046 an old token = 22,879,500 old tokens
#   total   1,229,957 dollars, 21 entries, 31,754,500 old tokens = 28.868% of the old 110,000,000 supply.
#   Old valuations: seed 2.2M, private 5.06M (blended about 4.26M); 6M was the unsold "Private 2" price.
# How many Shares each old token becomes is the economics lane's call. This script takes three CASES and checks, for each:
#   1. Shares owed, and what each funding source leaves (work pot, founder, unused backing, reserve, mixes).
#   2. The market after it: held Shares against the pool's dollars (the judge's model in founder_price_judge.py).
#   3. Shares the claim contract holds that nobody can hand back, and what they do to everyone's exit slice
#      (unconsented entries with and without a deadline; a slower schedule done in the claim layer).
#   4. The claim contract's integer accounting, a model of the interface in the contract lane's report: pro rata of the
#      Vester's release over max(funding, list total), consents until a close, the reserve's stream, strays, outside
#      Vester.claim calls, under- and over-funding. Every raw unit is paid at most once and never early.
# The owner's own seed entry is to go back to the project (the owner's word); it is not taken out here because its size
# is in the private sheet only. Every case below shrinks by it.
import random

B = 1e9
M = 1e6
FOUNDER, WORK_POT, BACKING, SALE, POOL_MATCH, RESERVE = 200 * M, 200 * M, 150 * M, 250 * M, 100 * M, 100 * M
POOL_SH = 55 * M  # pool Shares at any start (all 250M sold, 22 of each 100), measured split; the other 45M join the reserve
SEED_USD, PRIV_USD = 177_500, 1_052_457
SEED_OLD, PRIV_OLD = 8_875_000, 22_879_500
OLD_SUPPLY = 110_000_000
RAISED = SEED_USD + PRIV_USD
TEAM_CAP = 50_000
CV = 6_000_000
CRE_ROUNDS = TEAM_CAP / CV * B  # what Creaton's own rounds can sell at 6M under the Team cap (8.33M)
SPARE_BACKING = BACKING - CRE_ROUNDS
DAY = 86400
YEAR = 365 * DAY


def m(x):
    return "%7.2fM" % (x / M)


CASES = [
    ("K keep the old percent (= price paid at the old supply)", (SEED_OLD + PRIV_OLD) / OLD_SUPPLY * B),
    ("P all money at 6M, after the money", RAISED / CV * B),
    ("Q all money at 6M, before the money (7.23M after)", RAISED / (CV + RAISED) * B),
]

print("== 1. Shares owed to the earlier backers (CASES; the economics lane picks) ==")
print(" raised %s dollars, %d entries; old tokens %s = %.3f%% of the old supply" % (
    f"{RAISED:,}", 21, f"{SEED_OLD + PRIV_OLD:,}", (SEED_OLD + PRIV_OLD) / OLD_SUPPLY * 100))
for name, e in CASES:
    print(" %-56s %s Shares = %5.2f%% of all; %.6f dollars a Share paid on average" % (name, m(e), e / B * 100, RAISED / e))
print(" Creaton's own rounds at 6M sell at most %s (Team cap 50,000); %s of the backing slice would join the reserve unused"
      % (m(CRE_ROUNDS), m(SPARE_BACKING)))
print()


def take(e, plan):
    left = dict(founder=FOUNDER, work=WORK_POT, backing=BACKING, reserve=RESERVE)
    need = e
    for k, cap in plan:
        t = min(need, cap(left))
        left[k] -= t
        need -= t
    return left, need


spare = lambda l: max(0.0, l["backing"] - CRE_ROUNDS)
SOURCES = [
    ("W  work pot only (Give Shares)", [("work", lambda l: l["work"])], "none"),
    ("F  founder's grant only", [("founder", lambda l: l["founder"])], "Launcher + Vester init"),
    ("S+F unused backing, then founder", [("backing", spare), ("founder", lambda l: l["founder"])], "Launcher + Vester init"),
    ("S+W unused backing, then work pot", [("backing", spare), ("work", lambda l: l["work"])], "Launcher + Vester init"),
    ("R+F reserve, then founder", [("reserve", lambda l: l["reserve"]), ("founder", lambda l: l["founder"])],
     "Launcher + Vester init"),
    ("F/2+S/2 half founder, half unused backing", "half", "Launcher + Vester init"),
]
print(" source                                     case | founder   work pot   backing   reserve | short    | contract change")
for sname, plan, change in SOURCES:
    for cname, e in CASES:
        if plan == "half":
            l = dict(founder=FOUNDER - e / 2, work=WORK_POT, backing=BACKING - e / 2, reserve=RESERVE)
            short = max(0.0, e / 2 - SPARE_BACKING)
            l["backing"] = max(l["backing"], CRE_ROUNDS)
        else:
            l, short = take(e, plan)
        print(" %-42s %s | %s %s %s %s | %s | %s" % (sname, cname[0], m(l["founder"]), m(l["work"]), m(l["backing"]),
                                                    m(l["reserve"]), "SHORT %s" % m(short) if short > 1 else "  ok          ",
                                                    change))
print(" W cannot cover K or P alone (the work pot is 200M); S is capped at %s so a 6M Team round still fits; a down round"
      " to 333,333 needs the full 150M (built: CannotOpen refuses a round the Shares left cannot cover)" % m(SPARE_BACKING))


print("\n== 2. The market after it (judge's model: all 250M sold at the start, 22 of each 100 in the pool) ==")


def sell(usd_pool, sh_pool, sh):
    x = sh * 0.99
    out = usd_pool * x / (sh_pool + x)
    return out, ((usd_pool - out) / (sh_pool + x)) / (usd_pool / sh_pool) - 1


def market(name, start, held):
    pool_usd = 0.22 * SALE * start
    _, d1 = sell(pool_usd, POOL_SH, held / 365)
    _, d30 = sell(pool_usd, POOL_SH, held / 365 * 30)
    print(" %-52s held %s = %4.1f x the pool's dollars; 1 / 30 days of release sold: %+3.0f%% / %+3.0f%%" % (
        name, m(held), held * start / pool_usd, d1 * 100, d30 * 100))


market("default project, start 0.0004, 150M backed", 0.0004, FOUNDER + 20 * M + BACKING)
market("Creaton, start 0.006 (6M), no earlier backers", 0.006, FOUNDER + CRE_ROUNDS)
for cname, e in CASES:
    market("Creaton 6M, case %s, added (W, S or R)" % cname[0], 0.006, FOUNDER + CRE_ROUNDS + e)
    market("Creaton 6M, case %s, from the founder (F)" % cname[0], 0.006, max(FOUNDER, e) + CRE_ROUNDS)
print(" the ratio does not depend on the start (all 250M sell at it); only the founder route keeps held Shares where they")
print(" were: the earlier backers take the founder's place in the release. Every other route adds them.")


print("\n== 3. Shares in the claim contract that nobody can hand back thin everyone's exit slice ==")
# Treasury.countingSupply = all - Treasury - Rounds - Finisher - Vester.unreleased(). Shares the Vester has released to the
# claim contract count as "in hands" whether or not the contract passed them on. Released Shares of entries nobody has
# consented to cannot reach a holder: each hand-back gets (1 - stuck / counting) of its fair slice.


def counting(t_days, e, founder_held):
    rel = min(t_days, 365) / 365
    return SALE + POOL_SH + rel * (founder_held + CRE_ROUNDS + e)


for cname, e in CASES[:2]:
    print(" case %s (%s), added route:" % (cname[0], m(e)))
    for u in (0.05, 0.25):
        cells = []
        for close in (90, 180, 365, None):
            worst = 0.0
            for t in range(1, 731):
                if close is not None and t >= close:
                    stuck = 0.0
                else:
                    stuck = u * e * min(t, 365) / 365
                worst = max(worst, stuck / counting(t, e, FOUNDER))
            cells.append("%s %4.1f%%" % ("never" if close is None else "%3d" % close, worst * 100))
        print("   %2.0f%% never consent; worst thinning by when the list closes (days after the market): %s" % (
            u * 100, " | ".join(cells)))
    t = 365
    for dur in (730, 1095):
        stuck = e - e * t / dur
        print("   a %4d-day schedule done in the claim layer (Vester still 365): at day 365 %s released but not due ="
              " %4.1f%% thinner; done by a second Vester clock: 0%%" % (dur, m(stuck), stuck / counting(t, e, FOUNDER) * 100))
print(" delivered weekly by anyone (deliverMany), the stuck part of consented entries averages half a week of release:"
      " %.2f%% at day 30 in case K" % (CASES[0][1] / 365 * 3.5 / counting(30, CASES[0][1], FOUNDER) * 100))


print("\n== 4. The claim contract's integer accounting (a model of the interface in the report) ==")
U = 10 ** 18


class Vester:
    def __init__(self, g):
        self.g, self.claimed, self.start = g, 0, None

    def released(self, t):
        if self.start is None:
            return 0
        el = t - self.start
        return self.g if el >= YEAR else self.g * el // YEAR

    def claim(self, t):  # anyone may call Vester.claim(claimContract)
        x = self.released(t) - self.claimed
        self.claimed += x
        return x


class Claim:
    """The contract's own state. Its Share balance is the token's count: everything the Vester ever sent here (by this
    contract's pull or by anyone's Vester.claim), plus strays, less what it sent out."""

    def __init__(self, amounts, vester):
        self.a = list(amounts)
        self.T = sum(amounts)
        self.v = vester
        self.state = [0] * len(amounts)  # 0 open, 1 consented
        self.taken = [0] * len(amounts)
        self.C = 0  # consented total
        self.closed = False
        self.paid = 0  # delivered to entries
        self.res_stream = 0  # sent to the reserve from the Vester's stream
        self.strays_in = 0  # free Shares sent straight here (the model's outside world)
        self.strays_out = 0  # strays sent on to the reserve

    def D(self):
        return max(self.v.g, self.T)

    def balance(self):
        return self.v.claimed + self.strays_in - self.paid - self.res_stream - self.strays_out

    def consent(self, i):
        assert not self.closed and self.state[i] == 0
        self.state[i] = 1
        self.C += self.a[i]

    def close(self):
        self.closed = True

    def deliver(self, i, t):
        assert self.state[i] == 1
        self.v.claim(t)  # pull
        x = self.a[i] * self.v.released(t) // self.D() - self.taken[i]
        assert 0 <= x <= self.balance(), (x, self.balance())
        self.taken[i] += x
        self.paid += x
        return x

    def to_reserve(self, t):
        self.v.claim(t)
        rest = self.D() - (self.C if self.closed else self.T)
        due = self.v.released(t) * rest // self.D() - self.res_stream
        stray = self.balance() - (self.v.claimed - self.paid - self.res_stream)
        assert due >= 0 and stray >= 0 and due + stray <= self.balance()
        self.res_stream += due
        self.strays_out += stray
        return due + stray


rng = random.Random(18)
runs = 2000
worst_dust = 0
for trial in range(runs):
    n = rng.randint(1, 30)
    amounts = [rng.randint(1, 60_000_000) * U + rng.randint(0, U) for _ in range(n)]
    T = sum(amounts)
    kind = rng.choice(["exact", "exact", "over", "under"])
    G = T if kind == "exact" else T + rng.randint(1, 10 ** 26) if kind == "over" else T - rng.randint(1, T // 2)
    v = Vester(G)
    c = Claim(amounts, v)
    start = rng.randint(0, 60) * DAY
    v.start = start
    close_at = start + rng.choice([90, 180, 365]) * DAY
    got = [0] * n
    for t in sorted(rng.randint(start, start + 800 * DAY) for _ in range(60)):
        if not c.closed and t >= close_at:
            c.close()
        i = rng.randrange(n)
        r = rng.random()
        if r < 0.3 and not c.closed and c.state[i] == 0:
            c.consent(i)
        elif r < 0.65 and c.state[i] == 1:
            got[i] += c.deliver(i, t)
            assert got[i] <= amounts[i] * v.released(t) // c.D()  # never early
        elif r < 0.75:
            v.claim(t)  # an outsider calls Vester.claim(claimContract): nothing in the accounting may depend on it
        elif r < 0.8:
            c.strays_in += rng.randint(1, 10 ** 20)  # free Shares sent straight here
        else:
            c.to_reserve(t)
    end = start + 400 * DAY
    if not c.closed:
        c.close()
    for i in range(n):
        if c.state[i] == 1:
            got[i] += c.deliver(i, end)
            want = amounts[i] if G >= T else amounts[i] * G // T
            assert got[i] == want, (got[i], want)
    c.to_reserve(end)
    left = c.balance()
    assert c.strays_out == c.strays_in
    if G >= T:
        assert left == 0, left
        assert c.res_stream == G - c.C
    assert left <= n  # underfunded: at most one raw unit per entry stays, counted for ever
    worst_dust = max(worst_dust, left)
print(" %d random runs (1 to 30 entries; funding exact, over or under the list; consents until a close 90/180/365 days" % runs)
print(" after the market; deliveries, outside Vester.claim calls, stray Shares and reserve sends at random times):")
print("   no entry is ever paid ahead of the Vester's release; each consented entry ends with exactly its amount")
print("   (funded) or amount x funding / list total rounded down (underfunded); the reserve ends with the surplus, the")
print("   unconsented entries and every stray; funded, the contract ends holding 0 raw units; underfunded at most %d raw"
      " units (one per entry at most)." % worst_dust)
