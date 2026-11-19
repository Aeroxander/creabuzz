# Model of the REVISED JOIN-LEAVE-DESIGN.md (self-contained; run with python3 -I). 70-digit decimals, no integer rounding.
# Changes against v3 (adv_core.py): no 2% extra (price = leave-value at face), outside money drips in over 7 days and a
# joiner pays it at face while a leaver is paid only what has arrived, tasks keyed by a never-reused serial, part-paid
# accept splits the remainder pro rata, a forfeit is announced 7 days before it burns and joiners are priced as if burned.
import random, sys
from decimal import Decimal, getcontext
getcontext().prec = 70
def F(a, b=None):
    cv = lambda x: Decimal(str(x)) if isinstance(x, float) else Decimal(x)
    return cv(a) / cv(b) if b is not None else cv(a)
FEE = F(2, 100)
OPEN = F(1, 100)
Z0 = F(0)

class Task:
    def __init__(s, serial, payee, locked):
        s.serial, s.payee, s.locked = serial, payee, F(locked)
        s.C = F(locked)          # stayers' claim still carried in the quote
        s.notes = {}             # acct -> dollars of note issued
        s.ratio = None           # set at resolution: share of the locked money that comes back

class Proj:
    def __init__(s, G=0, extra=F(1)):
        s.P = s.A = s.B = F(0)
        s.G = F(G)               # Team Shares counted (declared, vested or not, minus forfeited)
        s.Z = F(0)               # inside G: unvested Shares announced to burn, counted as burned in the join price
        s.unvested = F(G)
        s.D = F(0)               # outside money not yet released into the pot (counted at face in a join price only)
        s.box = F(0); s.fees = F(0)
        s.back = {}; s.team = {}
        s.tasks = {}             # open tasks by serial
        s.done = {}              # resolved tasks by serial (kept so a claim can be checked)
        s.claimable = {}         # (serial, acct) -> dollars still claimable
        s.next_serial = 0
        s.extra = extra          # 1 = no extra (the revised design); 102/100 = the old rule
        s.cash_in = {}; s.cash_out = {}
    # ---------- reads
    def Ctot(s): return sum((t.C for t in s.tasks.values()), F(0))
    def f(s, X, Geff):
        if s.B == 0: return F(0)
        return min(X, s.A) / s.B + max(F(0), X - s.A) / (s.B + Geff)
    def u(s, X, Geff):
        d = s.B + Geff
        return max(F(0), X - s.A) / d if d > 0 else F(0)
    def vface(s): return s.f(s.P + s.Ctot() + s.D, s.G - s.Z)       # what a joiner pays per Share
    def vlock(s): return s.f(s.P + s.Ctot(), s.G)                   # what a leaver is owed counting locks only
    def vcash(s): return s.f(s.P, s.G)                              # what a leaver is paid now
    def ufaceT(s): return s.u(s.P + s.Ctot() + s.D, s.G - s.Z)
    def _in(s, a, x): s.cash_in[a] = s.cash_in.get(a, F(0)) + x
    def _out(s, a, x): s.cash_out[a] = s.cash_out.get(a, F(0)) + x
    # ---------- actions
    def join(s, acct, a):
        a = F(a); m = a - a * FEE
        if s.B == 0:
            p = OPEN; credit = m
        else:
            p = s.vface() * s.extra
            if p == 0: return F(0)
            credit = min(m, (m / p) * s.A / s.B)
        n = m / p
        s.P += m; s.A += credit; s.B += n; s.fees += a * FEE
        s.back[acct] = s.back.get(acct, F(0)) + n; s._in(acct, a)
        return n
    def _spread_note(s, acct, note):
        C = s.Ctot()
        if note <= 0 or C == 0: return
        for t in s.tasks.values():
            part = note * t.C / C
            t.C -= part; t.notes[acct] = t.notes.get(acct, F(0)) + part
    def leave(s, acct, n=None):
        n = s.back.get(acct, F(0)) if n is None else F(n)
        assert n <= s.back.get(acct, F(0))
        cash = n * s.vcash(); note = n * (s.vlock() - s.vcash())
        s.A *= (1 - n / s.B); s.P -= cash; s.B -= n; s.back[acct] -= n
        s._out(acct, cash); s._spread_note(acct, note)
        return cash, note
    def vest(s, acct, k):
        k = F(k); assert k <= s.unvested - s.Z
        s.unvested -= k; s.team[acct] = s.team.get(acct, F(0)) + k
    def leave_team(s, acct, n=None):
        n = s.team.get(acct, F(0)) if n is None else F(n)
        assert n <= s.team.get(acct, F(0))
        cash = n * s.u(s.P, s.G); note = n * (s.u(s.P + s.Ctot(), s.G) - s.u(s.P, s.G))
        s.P -= cash; s.G -= n; s.team[acct] -= n
        s._out(acct, cash); s._spread_note(acct, note)
        return cash, note
    def announce_forfeit(s, k):
        k = F(k); assert k <= s.unvested - s.Z
        s.Z += k
    def execute_forfeit(s, k):
        k = min(F(k), s.Z); s.Z -= k; s.unvested -= k; s.G -= k
    def revenue(s, who, x):
        x = F(x); s.D += x; s._in(who, x)
    def release(s, frac):
        r = s.D * F(frac); s.D -= r; s.P += r
    def accrue(s, rate, days):
        take = s.P * (1 - (1 - F(rate)) ** days); s.P -= take; s.box += take; return take
    def draw(s, who, x):
        x = min(F(x), s.box); s.box -= x; s._out(who, x); return x
    def take(s, payee, L):
        L = min(F(L), s.P)
        serial = s.next_serial; s.next_serial += 1
        s.P -= L; s.tasks[serial] = Task(serial, payee, L); return serial
    def resolve(s, serial, pay):
        """pay = dollars paid to the worker (0 = returned). The rest comes back pro rata to notes and to stayers."""
        t = s.tasks.pop(serial); pay = min(F(pay), t.locked)
        rem = t.locked - pay; ratio = rem / t.locked if t.locked > 0 else F(0)
        s._out(t.payee, pay)
        s.P += t.C * ratio
        for who, nn in t.notes.items():
            if ratio > 0: s.claimable[(serial, who)] = nn * ratio
        t.ratio = ratio; s.done[serial] = t
        return pay
    def claim_note(s, serial, acct):
        x = s.claimable.pop((serial, acct), F(0)); s._out(acct, x); return x
    def conserved(s):
        tin = sum(s.cash_in.values(), F(0)); tout = sum(s.cash_out.values(), F(0))
        held = s.P + s.box + s.D + s.fees + sum((t.locked for t in s.tasks.values()), F(0)) + sum(s.claimable.values(), F(0))
        return tin - tout - held

def fuzz(seed, steps=400, extra=F(1)):
    rnd = random.Random(seed)
    G = rnd.choice([0, 5_000_000, 10_000_000, 100_000_000])
    pr = Proj(G=G, extra=extra)
    pr.join("h1", 50_000); pr.join("h2", 20_000)
    if G: pr.vest("founder", F(G) / 4)
    worst = worst_t = F(10); cons = F(0); notes_ok = True; tasks_made = 0
    accts = ["bot%d" % i for i in range(5)] + ["founder"]
    for _ in range(steps):
        op = rnd.random(); spend = False
        v0 = pr.vface() if pr.B > 0 else F(0); u0 = pr.ufaceT()
        if op < 0.22: pr.join(rnd.choice(accts), rnd.choice([1, 10, 500, 5000, 80000, 400000]))
        elif op < 0.37:
            a = rnd.choice(accts)
            if pr.back.get(a, 0) > 0: pr.leave(a, pr.back[a] * F(rnd.choice([1, 3, 10, 50, 100]), 100))
        elif op < 0.44:
            if pr.team.get("founder", 0) > 0: pr.leave_team("founder", pr.team["founder"] * F(rnd.choice([10, 50, 100]), 100))
        elif op < 0.49: pr.revenue("ext", rnd.choice([10, 1000, 30000]))
        elif op < 0.57: pr.release(F(rnd.choice([1, 2, 7]), rnd.choice([7, 7, 7])) if False else F(rnd.choice([1, 3, 7]), 7))
        elif op < 0.60:
            if pr.unvested - pr.Z > 10: pr.announce_forfeit((pr.unvested - pr.Z) * F(rnd.choice([5, 30, 100]), 100))
        elif op < 0.63:
            if pr.Z > 0: pr.execute_forfeit(pr.Z * F(rnd.choice([50, 100]), 100))
        elif op < 0.66:
            if pr.unvested - pr.Z > 10: pr.vest("founder", (pr.unvested - pr.Z) * F(rnd.choice([5, 30]), 100))
        elif op < 0.74:
            if len(pr.tasks) < 8 and pr.P > 100:
                pr.take("worker", pr.P * F(rnd.choice([1, 5]), 100)); tasks_made += 1
        elif op < 0.80 and pr.tasks: pr.resolve(rnd.choice(list(pr.tasks)), 0)
        elif op < 0.85 and pr.tasks:
            tid = rnd.choice(list(pr.tasks)); pr.resolve(tid, pr.tasks[tid].locked * F(rnd.choice([30, 60, 100]), 100)); spend = True
        elif op < 0.90 and pr.claimable:
            k = rnd.choice(list(pr.claimable)); pr.claim_note(*k)
        else: pr.accrue(F(2, 1000), rnd.choice([1, 3, 7])); spend = True
        cons = max(cons, abs(pr.conserved()))
        for (serial, _a), x in pr.claimable.items():          # notes never exceed the money returned for that serial
            t = pr.done[serial]
            if x > t.locked * t.ratio + F(1, 10**30): notes_ok = False
        if not spend:
            if v0 > F(1, 10**9) and pr.B > 0: worst = min(worst, pr.vface() / v0)
            if u0 > F(1, 10**9) and (pr.B + pr.G - pr.Z) > 0: worst_t = min(worst_t, pr.ufaceT() / u0)
    return float(worst), float(worst_t), float(cons), notes_ok, tasks_made

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    lw = lt = 10.0; cm = 0.0; ok = True; most = 0
    for s in range(n):
        w, t, c, k, tm = fuzz(s); lw = min(lw, w); lt = min(lt, t); cm = max(cm, c); ok &= k; most = max(most, tm)
    print("FUZZ %d seeds x 400 ops: lowest per-Share face ratio backer %.15f team %.15f; max conservation error %g; notes<=returned %s; most tasks in one run %d (8 open at a time, serials never reused)" % (n, lw, lt, cm, ok, most))
