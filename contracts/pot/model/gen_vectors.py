# Writes vectors.json: fixed and seeded scenarios run through the reference model (pot_ext.py on v4_model.py).
# `ModelVectors.t.sol` replays every scenario against the real contracts and compares every number.
# Run: python3 -I gen_vectors.py            (writes vectors.json next to this file)
#      python3 -I gen_vectors.py --check    (regenerates in memory and fails if vectors.json differs)
# Deterministic: no clock, no environment, a seeded generator. Amounts are decimal STRINGS in base units (dollars in
# millionths, Shares in wei), because JSON numbers lose digits above 2^53.
#
# File shape: {"format": 1, "scenarios": [ {"head": {name, note, pool, rate, actors, team_who, team_amt, force_P, force_A,
# force_who, force_amt}, "ops": {column: [values]}} ]}. Before the first operation a scenario may give Team Shares (team_who,
# team_amt: granted, vested over 104 time units and claimed) and force a state (force_P, force_A, force_who, force_amt: a pot, a
# paid-in and Shares in hands, as the design's worked examples need). Columns, one value per operation:
#   kind  one of join, leave, leaveTeam, leaveTeamZero, revenue, warp, checkIn, draw, setRate, proposeRate, applyRate,
#         grant, ownExit, execute
#   who   the actor index (the payer for revenue, the grant's index for ownExit and execute)
#   x, y  arguments: join/revenue/draw amount x; leave fraction x/y of the actor's Shares; warp seconds x; a rate x in ppm
#   o1,o2,o3  what the operation returns, by kind:
#         join        o1 Shares minted, o2 what taking them out at once would pay, o3 unused
#         leave       o1 cash, o2 Shares burned, o3 outside money left behind for those who stay
#         leaveTeam   o1 cash, o2 Team Shares burned
#         draw        o1 dollars drawn
#         ownExit     o1 Team Shares announced to burn
#         execute     o1 Team Shares burned
#   P A B G box D fees Z   the state after the operation (and one more settle at the same second): pot, paid-in, Shares,
#         Team Shares, allowance box, outside money still arriving, platform fees owed, the burn queue.
import importlib.util
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pot_ext", os.path.join(HERE, "pot_ext.py"))
ext = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ext)
F, floor_int, EdgeError = ext.F, ext.floor_int, ext.EdgeError
UNIT, DAY = ext.UNIT, ext.DAY
S = 10**18


def usd(x):
    """Dollars (int, float or str) to dollar units."""
    return int(F(str(x)) * 10**6)


def shares(x):
    return int(F(str(x)) * S)


class Scn:
    def __init__(self, name, note, pool, rate, actors, team=(), force=None):
        self.name, self.note, self.pool, self.rate, self.actors = name, note, pool, rate, actors
        self.team = list(team)  # (who, amount): vested and claimed before the first operation
        self.force = force  # {"P":, "A":, "who": [], "amt": []}
        self.m = ext.PotProj(pool, rate)
        for who, amt in self.team:
            self.m.give_team(who, amt)
        if force:
            self.m.P = F(force["P"])
            self.m.A = F(force["A"])
            for who, amt in zip(force["who"], force["amt"]):
                self.m.back[who] = F(amt)
                self.m.B += F(amt)
        self.cols = {k: [] for k in "kind who x y o1 o2 o3 P A B G box D fees Z".split()}
        self.grant_names = []

    # ----- recording
    def _rec(self, kind, who=0, x=0, y=0, o1=0, o2=0, o3=0):
        m = self.m
        m.settle()
        row = dict(kind=kind, who=who, x=x, y=y, o1=o1, o2=o2, o3=o3, P=m.P, A=m.A, B=m.B, G=m.G, box=m.box, D=m.D,
                   fees=m.fees, Z=m.Z)
        for k, v in row.items():
            self.cols[k].append(v if k == "kind" else str(floor_int(v)))

    def n_ops(self):
        return len(self.cols["kind"])

    # ----- operations
    def join(self, who, amount):
        n, inst = self.m.join(who, amount)
        self._rec("join", who, amount, 0, n, inst)

    def leave(self, who, num=1, den=1):
        n = self.m.back[who] * F(num) / F(den)
        cash, behind = self.m.take_out(who, n)
        self._rec("leave", who, num, den, cash, n, behind)

    def leave_team(self, who, num=1, den=1):
        n = self.m.team[who] * F(num) / F(den)
        cash = self.m.take_out_team(who, n)
        self._rec("leaveTeam", who, num, den, cash, n)

    def leave_team_zero(self, who):
        """The Team Share holder's take-out must pay nothing (and so revert): the pot holds no surplus for them."""
        self.m.settle()
        n = self.m.team[who]
        assert self.m.u(self.m.P, self.m.G) * n < 1, "this take-out would pay something"
        self._rec("leaveTeamZero", who, 1, 1)

    def revenue(self, who, amount):
        self.m.revenue_in(who, amount)
        self._rec("revenue", who, amount)

    def warp(self, secs):
        self.m.advance(secs)
        self._rec("warp", 0, secs)

    def check_in(self):
        self.m.check_in()
        self._rec("checkIn")

    def draw(self):
        x = self.m.draw_all("runner")
        self._rec("draw", 0, 0, 0, x)

    def set_rate(self, ppm):
        self.m.set_rate(ppm)
        self._rec("setRate", 0, ppm)

    def propose_rate(self, ppm):
        self.m.propose_rate(ppm)
        self._rec("proposeRate", 0, ppm)

    def apply_rate(self):
        self.m.apply_rate()
        self._rec("applyRate")

    def grant(self, who, amount):
        idx = len(self.grant_names)
        self.grant_names.append(idx)
        self.m.grant(idx, amount)
        self._rec("grant", who, amount, idx)

    def own_exit(self, idx):
        burn = self.m.announce_own_exit(idx)
        self._rec("ownExit", idx, 0, 0, burn)

    def execute(self, idx):
        burn = self.m.execute_forfeit(idx)
        self._rec("execute", idx, 0, 0, burn)

    def to_json(self):
        return dict(name=self.name, note=self.note, pool=str(self.pool), rate=self.rate, actors=self.actors,
                    team_who=[w for w, _ in self.team], team_amt=[str(a) for _, a in self.team],
                    force_P=str(self.force["P"]) if self.force else "0", force_A=str(self.force["A"]) if self.force else "0",
                    force_who=list(self.force["who"]) if self.force else [],
                    force_amt=[str(a) for a in self.force["amt"]] if self.force else [], ops=self.cols)


POOL = shares(10_000_000)  # a 10 million Share Team pool
BIG = shares(100_000_000)


# ====================================================== the fixed scenarios =============================================
def fixed():
    out = []

    s = Scn("first-price", "the first join prices a Share at one cent whatever the Team pool; leaving at once pays 98 per 100",
            POOL, 1000, 2)
    s.join(0, usd(100)); s.leave(0)
    out.append(s)

    s = Scn("first-price-no-team", "same with no Team pool", 0, 1000, 2)
    s.join(0, usd(100)); s.leave(0, 1, 2); s.leave(0)
    out.append(s)

    s = Scn("minimum-join", "one dollar, the smallest join", POOL, 1000, 2)
    s.join(0, usd(1)); s.join(1, usd(5)); s.leave(0)
    out.append(s)

    # worked example 2.1: pot 83,500, paid-in 98,000, 9.8M backer Shares, 10M Team Shares
    s = Scn("worked-2.1", "design 2.1: a Share is worth 0.008520; 100 paid buys about 11,501.78 Shares; leaving at once pays about 97.9998",
            POOL, 0, 3, force=dict(P=usd(83_500), A=usd(98_000), who=[0], amt=[shares(9_800_000)]))
    s.join(1, usd(100)); s.leave(1); s.leave(0, 1, 2)
    out.append(s)

    # worked example 2.2: pot 120,000 above paid-in 98,000; 1,000,000 backer Shares and 1,000,000 Team Shares
    s = Scn("worked-2.2", "design 2.2: 1,000,000 backer Shares pay 11,111.111111 and 1,000,000 Team Shares pay 1,111.111111",
            POOL, 0, 3, team=[(1, shares(1_000_000))],
            force=dict(P=usd(120_000), A=usd(98_000), who=[0, 2], amt=[shares(8_800_000), shares(1_000_000)]))
    s.leave_team(1); s.leave(2)
    out.append(s)

    # section C: do later joiners pay the Team?  10,000 first, then 200 joins of 500; the whole pool is in the Team's hands
    for label, pool in (("10M", POOL), ("100M", BIG)):
        s = Scn("later-joins-" + label, "10,000 first, then 200 joins of 500: the Team's claim is zero and every backer gets 98.00 per 100 paid",
                pool, 0, 21, team=[(20, pool)])
        s.join(0, usd(10_000))
        for i in range(200):
            s.join(1 + i % 19, usd(500))
        s.leave_team_zero(20)
        for w in range(0, 20):
            if w in s.m.back and s.m.back[w] > 0:
                s.leave(w)
        out.append(s)

    # section B: a bot joins just before an outside payment, the payment starts to arrive, the bot leaves in the same second
    for R in (10, 25, 50):
        for W in ("0.1", "1", "3"):
            s = Scn("sandwich-R%d-W%s" % (R, W), "outside payment %d%% of the pot, a joiner of %s times the pot, in and out in one second" % (R, W),
                    0, 0, 4)
            s.join(0, usd(100_000))                               # pot 98,000
            a = int(F(98_000_000_000) * F(W) / F(98, 100))
            s.join(1, a)
            s.revenue(2, int(F(98_000_000_000) * R // 100))
            s.leave(1)
            s.warp(UNIT + 1)                                       # all the outside money has arrived
            s.leave(0)
            out.append(s)

    # section B2: an honest holder leaves while outside money is still arriving
    for R, days in ((10, 0), (10, 3), (25, 1), (25, 6)):
        s = Scn("arriving-R%d-day%d" % (R, days), "an honest holder leaves with %d%% of the pot still arriving after %d day(s): paid on what has arrived" % (R, days),
                0, 0, 3)
        s.join(0, usd(100_000)); s.join(1, usd(10_000))
        s.revenue(2, int(F(98_000_000_000) * R // 100))
        if days:
            s.warp(days * DAY)
        s.leave(0, 1, 2)
        s.warp(UNIT)
        s.leave(0)
        s.leave(1)
        out.append(s)

    # section D: equal joins of 100 into an empty project, nobody leaves, then the first, the middle and the last leave
    s = Scn("early-joiners", "60 equal joins of 100: the first and the last backer are worth the same per 100 paid", 0, 0, 60)
    for i in range(60):
        s.join(i, usd(100))
    for i in (0, 30, 59):
        s.leave(i)
    out.append(s)

    # section E: round trips
    s = Scn("round-trips", "join 100 then leave at once; a whale of 900,000 into 100,000 and out at once", POOL, 0, 4)
    s.join(0, usd(100_000)); s.join(1, usd(100)); s.leave(1); s.join(2, usd(900_000)); s.leave(2); s.leave(0)
    out.append(s)

    s = Scn("cyclers", "a cycler of 1,000 / 100,000 / 1,000,000 / 10,000,000 into a 98,000 pot gets back about 98 per 100", 0, 0, 3)
    s.join(0, usd(100_000))
    for big in (1_000, 100_000, 1_000_000, 10_000_000):
        s.join(1, usd(big)); s.leave(1)
    s.leave(0)
    out.append(s)

    # section I: 40 equal holders with the quote offset on, leaving in a shuffled order
    s = Scn("offset-holders", "40 holders of 500 each leave in a shuffled order and are paid the same per Share", POOL, 0, 40)
    for i in range(40):
        s.join(i, usd(500))
    order = list(range(40)); random.Random(3).shuffle(order)
    for w in order:
        s.leave(w)
    out.append(s)

    # the allowance: a project that is checked in on, spends its box, lowers and raises the rate, and goes quiet
    s = Scn("allowance", "0.10% a day: the box fills to at most seven days, is drawn, the rate is lowered at once and raised after a time unit, a lapse stops it",
            POOL, 1000, 3, team=[(2, shares(2_000_000))])
    s.join(0, usd(100_000))
    s.warp(3 * DAY + 1234); s.draw()
    s.warp(4 * DAY + 77); s.check_in(); s.draw()
    for k in range(6):
        s.warp(7 * DAY + 11 * k); s.check_in()
        s.draw() if k % 2 else None
    s.set_rate(500)
    s.warp(5 * DAY + 3); s.check_in(); s.draw()
    s.propose_rate(1800)
    s.warp(UNIT + 100); s.apply_rate()
    s.warp(6 * DAY + 5); s.check_in(); s.join(1, usd(20_000))
    s.warp(2 * UNIT + 4000)                                        # quiet: past the window
    s.check_in(); s.draw()
    s.leave(1); s.leave(0, 1, 2)
    out.append(s)

    s = Scn("allowance-ceiling", "0.20% a day, nobody draws: the box holds at most seven days (1.40% of pot and box)", POOL, 2000, 2)
    s.join(0, usd(100_000))
    for k in range(5):
        s.warp(6 * DAY + 17 * k); s.check_in()
    s.draw(); s.leave(0)
    out.append(s)

    s = Scn("lapse", "a 60-day lapse pays nothing for the idle time; the box holds only what accrued inside the window",
            POOL, 1000, 2)
    s.join(0, usd(100_000)); s.warp(5 * DAY); s.draw(); s.warp(60 * DAY); s.check_in(); s.draw(); s.leave(0)
    out.append(s)

    # outside money: two payments merge into one weighted stream
    s = Scn("revenue-merge", "two payments merge into one stream that is fully in the pot by its end", POOL, 1000, 3,
            team=[(2, shares(1_000_000))])
    s.join(0, usd(50_000)); s.join(1, usd(5_000))
    s.revenue(2, usd(8_000)); s.warp(2 * DAY + 55); s.check_in()
    s.revenue(2, usd(20_000)); s.warp(3 * DAY + 9); s.check_in()
    s.leave(1, 1, 2)
    s.warp(UNIT); s.check_in(); s.draw()
    s.warp(UNIT); s.check_in()
    s.leave(0); s.leave(1); s.leave_team(2)
    out.append(s)

    # the Team: only what is above paid-in is theirs
    s = Scn("team-surplus", "Team Shares are paid only from the pot above paid-in: nothing at or under it", POOL, 0, 4,
            team=[(3, shares(2_000_000))])
    s.join(0, usd(100_000)); s.leave_team_zero(3)
    s.revenue(1, usd(30_000)); s.warp(UNIT + 5)
    s.leave_team(3, 1, 2); s.leave(0, 1, 2); s.leave_team(3); s.leave(0)
    out.append(s)

    # outside money before the first backer, and the Team's leftover after the last backer: a first backer pays for a slice of it
    s = Scn("revenue-before-first", "outside money 20,000 arrives before any backer: the first backer pays for a slice of it in the price and is not credited it as paid-in",
            POOL, 0, 3)
    s.revenue(2, usd(20_000)); s.warp(UNIT // 2); s.join(0, usd(100_000)); s.leave(0, 1, 2); s.warp(UNIT); s.leave(0)
    out.append(s)

    s = Scn("teams-leftover", "after the last backer leaves, the Team's slice of the surplus stays; the next first backer pays for a slice of it",
            POOL, 0, 3)
    s.join(0, usd(10_000)); s.revenue(2, usd(5_000)); s.warp(UNIT + 7); s.leave(0)
    s.join(1, usd(10_000)); s.leave(1, 1, 2); s.leave(1)
    out.append(s)

    # a forfeit: the burn is priced into joins from the announcement, the leave still pays on all Team Shares until the burn.
    # Outside money first, so the pot is above paid-in and the Team Shares counted in the price matter.
    s = Scn("forfeit", "an own exit announces the unvested part to burn: joiners are priced as if it were gone; it burns a time unit later",
            POOL, 1000, 4)
    s.join(0, usd(100_000))
    s.revenue(3, usd(60_000)); s.warp(UNIT - 5 * DAY); s.check_in()
    s.grant(1, shares(4_000_000))
    s.warp(6 * DAY); s.check_in(); s.warp(6 * DAY); s.check_in()
    s.own_exit(0)
    s.join(2, usd(30_000))
    s.leave(2)
    s.warp(UNIT + 1); s.execute(0)
    s.check_in(); s.join(3, usd(30_000)); s.leave(3); s.leave(0)
    out.append(s)

    return out


# ====================================================== the seeded scenarios ============================================
def random_scn(seed, nops=45):
    rnd = random.Random(seed)
    pool = rnd.choice([POOL, BIG, shares(1_000_000)])
    rate = rnd.choice([0, 500, 1000, 2000])
    actors = 6
    team = [(5, pool // 10)] if rnd.random() < 0.7 else []
    s = Scn("random-%d" % seed, "seeded mixed run, 45 operations at most", pool, rate, actors, team=team)
    m = s.m
    s.join(0, usd(rnd.choice([100, 2_000, 60_000])) + rnd.randrange(1000))
    attempts = 0
    while s.n_ops() < nops and attempts < 400:
        attempts += 1
        r = rnd.random()
        m.settle()
        try:
            if r < 0.22:
                if not m.door_open():
                    s.check_in()
                s.join(rnd.randrange(5), rnd.choice([1, 40, 500, 7_000, 90_000]) * 10**6 + rnd.randrange(10**6))
            elif r < 0.37:
                w = rnd.randrange(5)
                if m.back.get(w, 0) > 0:
                    num, den = rnd.choice([(1, 10), (1, 4), (1, 3), (1, 2), (1, 1), (3, 4)])
                    n = m.back[w] * F(num) / F(den)
                    m.settle()
                    if n * m.vcash() >= 1000 and m.A > 0:
                        s.leave(w, num, den)
            elif r < 0.42:
                if m.team.get(5, 0) > 0:
                    num, den = rnd.choice([(1, 4), (1, 2), (1, 1)])
                    if m.team[5] * F(num) / F(den) * m.u(m.P, m.G) >= 1000:
                        s.leave_team(5, num, den)
            elif r < 0.50:
                if not m.door_open():
                    pass
                s.revenue(rnd.choice([3, 4]), rnd.choice([1, 50, 3_000]) * 10**6 + rnd.randrange(10**6))
            elif r < 0.68:
                s.warp(rnd.choice([3_600, 20_000, DAY, 2 * DAY + 11, 3 * DAY + 3, 5 * DAY, 9 * DAY + 17, 16 * DAY + 5]))
            elif r < 0.80:
                s.check_in()
            elif r < 0.87:
                if m.box >= 1000:
                    s.draw()
            elif r < 0.91:
                if m.rate > 100:
                    s.set_rate(rnd.randrange(0, m.rate))
            elif r < 0.95:
                if m.pending is None and m.rate < 2000:
                    s.propose_rate(rnd.randrange(m.rate + 1, 2001))
            else:
                if m.pending is not None and m.t >= m.pending[1] + UNIT:
                    s.apply_rate()
        except EdgeError:
            continue
    # everyone out at the end, the Team first
    if not m.door_open():
        s.check_in()
    for w in range(5):
        m.settle()
        if m.back.get(w, 0) > 0 and m.back[w] * m.vcash() >= 1000:
            s.leave(w)
    return s


# ====================================================== cross-check against the unchanged model =========================
def cross_check():
    """The offset is the one place the contracts add to the price rule. Run time-free scenarios through the unchanged
    v4_model (offset off, first join flat at 0.01) and through the extension: what each holder is paid may differ by the
    offset effect only, which is well under one part in a thousand when the pot holds a hundred dollars or more."""
    worst = F(0)
    for pool, joins in ((POOL, [usd(10_000)] + [usd(500)] * 200), (BIG, [usd(10_000)] + [usd(500)] * 200), (0, [usd(100)] * 60)):
        old = ext.v4.Proj(G=F(pool))
        new = ext.PotProj(pool, 0)
        for i, a in enumerate(joins):
            # the unchanged model works in whole dollars and whole Shares: scale in and out
            old.join(i, F(a) / F(10**6))
            new.join(i, a)
        for i in range(len(joins)):
            c_old, _ = old.leave(i)
            c_new, _ = new.take_out(i, new.back[i])
            rel = abs(c_old * 10**6 - c_new) / c_new
            worst = max(worst, rel)
    assert worst < F(1, 1000), "the quote offset moved a payout by %s" % worst
    # at a state where the price is not one cent (design 2.1: pot 83,500, paid-in 98,000, 9.8M Shares, 10M Team Shares) the
    # offset does move the price, by the virtual dollar over the money in the quote
    old = ext.v4.Proj(G=F(10_000_000))
    old.P, old.A, old.B = F(83_500), F(98_000), F(9_800_000)
    n_old = old.join("x", F(100))
    new = ext.PotProj(POOL, 0)
    new.P, new.A, new.B = F(usd(83_500)), F(usd(98_000)), F(shares(9_800_000))
    n_new, _ = new.join("x", usd(100))
    rel = abs(n_old * S - n_new) / n_new
    assert rel < F(1, 10_000), "the offset moved a quote by %s" % rel
    return float(max(worst, rel))


def build():
    scns = fixed()
    seed, made = 0, 0
    while made < 20:
        seed += 1
        try:
            scns.append(random_scn(seed))
            made += 1
        except (EdgeError, AssertionError, KeyError, ZeroDivisionError):
            continue
    return dict(format=1, note="Generated by gen_vectors.py from v4_model.py and pot_ext.py. Do not edit by hand.",
                scenarios=[s.to_json() for s in scns])


def dump(doc):
    lines = ['{"format": 1, "note": %s, "scenarios": [' % json.dumps(doc["note"])]
    parts = []
    for sc in doc["scenarios"]:
        head = {k: v for k, v in sc.items() if k != "ops"}
        ops = sc["ops"]
        body = ",\n".join('    "%s": %s' % (k, json.dumps(v)) for k, v in ops.items())
        parts.append("{\n  \"head\": %s,\n  \"ops\": {\n%s\n  }\n}" % (json.dumps(head), body))
    return "\n".join(lines) + "\n" + ",\n".join(parts) + "\n]}\n"


if __name__ == "__main__":
    doc = build()
    text = dump(doc)
    worst = cross_check()
    path = os.path.join(HERE, "vectors.json")
    if "--check" in sys.argv:
        old = open(path).read() if os.path.exists(path) else ""
        if old != text:
            print("vectors.json is out of date: run python3 -I model/gen_vectors.py")
            sys.exit(1)
        print("vectors.json is current (%d scenarios)" % len(doc["scenarios"]))
    else:
        with open(path, "w") as f:
            f.write(text)
        print("wrote %s: %d scenarios, %d operations; offset cross-check worst relative payout difference %.2e"
              % (path, len(doc["scenarios"]), sum(len(s["ops"]["kind"]) for s in doc["scenarios"]), worst))
