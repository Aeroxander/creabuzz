# The reference model of the join-and-leave rules, carried to what the step 1 contracts define.
#
# `v4_model.py` is the exact-decimal model of the design and is read in unchanged. This file adds, on top of it and
# only where the contracts differ from the model (the full list is in POT-STEP1A-REPORT.md and in README.md here):
#   - the quote offset (one virtual dollar of money AND of paid-in, 100 virtual Shares) in the join price;
#   - a first join into a project that already holds money priced by the same formula (the model prices it flat) and credited
#     as paid-in only what is left of the payment after the price of its slice of that money;
#   - the allowance as a linear accrual between settles on the pot, with the box cut to seven days of accrual on pot + box;
#   - outside money arriving as one weighted-average stream over one time unit N;
#   - the check-in window of 2N and active seconds;
#   - Team Shares held by named accounts, and the burn queue Z with its one notice period.
# Everything is plain Python with exact 70-digit decimals, no integer rounding. All amounts are in BASE UNITS: dollars in
# millionths (1e6 = one dollar), Shares in wei (1e18 = one Share). Run with `python3 -I`; it has no packages.
import importlib.util
import os
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


v4 = _load("v4_model", "v4_model.py")
F = v4.F
Proj = v4.Proj

PPM = 1_000_000
UNIT = 7 * 86400  # N on a real network: seven days
DAY = UNIT // 7
OFFSET_USD = F(1_000_000)  # one dollar, in the quote only
OFFSET_SHARES = F(100) * F(10) ** 18  # 100 Shares, in the quote only
CHECK_IN_MULT = 2
CLIFF_MULT = 13
VEST_MULT = 104
MAX_RATE_PPM = 2000


class EdgeError(Exception):
    """A scenario sits on a rounding edge: the contract's integers could land on the other side of it."""


def floor_int(x):
    """Floor to a whole base unit. A value a hair under zero (exact arithmetic that should end at zero) is zero."""
    x = Decimal(x)
    if x < 0:
        assert x > Decimal(-1) / Decimal(10**9), "a negative amount: %s" % x
        return 0
    return int(x.to_integral_value(rounding=ROUND_FLOOR))


class PotProj(Proj):
    """The model with the contract's rules. Time is whole seconds in `t`, counted from the start of the scenario."""

    def __init__(self, pool, rate_ppm, unit=UNIT, fee=F(2, 100)):
        super().__init__(G=F(pool))
        self.unit = unit
        self.day = unit // 7
        self.fee = fee
        self.rate = rate_ppm
        self.pending = None  # (ppm, proposed_at)
        self.t = 0
        self.last = 0  # last settle
        self.last_ci = 0  # last check-in
        self.active = 0  # active seconds so far (settled)
        self.arr_end = 0
        self.grants = {}  # name -> dict(total, start_active, state, burn, burn_at)
        self.burn_at = {}

    # ---------- the clock
    def window_end(self):
        return self.last_ci + CHECK_IN_MULT * self.unit

    def door_open(self):
        return self.t < self.window_end()

    def settle(self):
        """The contract's `_settled`, in exact arithmetic, at the model's current time."""
        t = self.t
        upto = min(t, self.window_end())
        dt = upto - self.last if upto > self.last else 0
        cap = (self.P + self.box) * F(self.rate * 7) / F(PPM)
        if dt > 0 and self.rate > 0:
            take = self.P * F(self.rate * dt) / F(PPM * self.day)
            self.box += take
            self.P -= take
        if self.box > cap:
            self.P += self.box - cap
            self.box = cap
        if self.D > 0:
            rel = self.D if t >= self.arr_end else self.D * F(t - self.last) / F(self.arr_end - self.last)
            self.D -= rel
            self.P += rel
        self.active += dt
        self.last = t

    def advance(self, secs):
        self.t += secs

    # ---------- the price a joiner pays (the contract's PotMath.quote)
    def vq(self):
        x = self.P + self.D + OFFSET_USD
        aq = self.A + OFFSET_USD
        bq = self.B + OFFSET_SHARES
        ge = self.G - self.Z
        mn = min(x, aq)
        sur = x - mn
        return mn / bq + sur / (bq + ge)

    # ---------- actions (each settles first)
    def join(self, acct, a):
        self.settle()
        assert self.door_open()
        a = F(a)
        m = a - a * self.fee
        n = m / self.vq()
        if self.B == 0:
            # no paid-in per Share to copy: the payment less the price of the slice of money already in the project
            credit = max(F(0), m - n * (self.P + self.D) / (OFFSET_SHARES + (self.G - self.Z)))
        else:
            credit = min(m, n * self.A / self.B)
        self.P += m
        self.A += credit
        self.B += n
        self.fees += a * self.fee
        self.back[acct] = self.back.get(acct, F(0)) + n
        self._in(acct, a)
        return n, n * self.vcash()  # shares, what an instant take-out would pay

    def take_out(self, acct, n):
        self.settle()
        behind = n * (self.f(self.P + self.D, self.G) - self.f(self.P, self.G))
        cash, _ = self.leave(acct, n)
        return cash, behind

    def take_out_team(self, acct, n):
        self.settle()
        cash, _ = self.leave_team(acct, n)
        return cash

    def revenue_in(self, who, x):
        self.settle()
        x = F(x)
        old = self.D
        if old == 0:
            self.arr_end = self.t + self.unit
        else:
            rem = self.arr_end - self.t
            self.arr_end = self.t + _ceil_edge(old, rem, x, self.unit)
        self.D = old + x
        self._in(who, x)

    def check_in(self):
        self.settle()
        self.last_ci = self.t

    def draw_all(self, who):
        self.settle()
        return self.draw(who, self.box)

    def set_rate(self, ppm):
        self.settle()
        assert ppm < self.rate
        self.rate = ppm
        self.pending = None

    def propose_rate(self, ppm):
        self.settle()
        assert self.rate < ppm <= MAX_RATE_PPM
        self.pending = (ppm, self.t)

    def apply_rate(self):
        self.settle()
        assert self.pending and self.t >= self.pending[1] + self.unit
        self.rate = self.pending[0]
        self.pending = None

    # ---------- Team Shares in hands, grants and the burn queue
    def give_team(self, acct, k):
        k = F(k)
        self.team[acct] = self.team.get(acct, F(0)) + k

    def grant(self, name, total):
        self.settle()
        self.grants[name] = dict(total=F(total), start=self.active, state="live", burn=F(0))

    def accrued(self, name):
        g = self.grants[name]
        el = self.active - g["start"]
        length = VEST_MULT * self.unit
        return g["total"] if el >= length else g["total"] * F(el) / F(length)

    def announce_own_exit(self, name):
        """The member leaves: keeps what has accrued (no cliff), the rest is announced to burn after one time unit."""
        self.settle()
        g = self.grants[name]
        burn = g["total"] - self.accrued(name)
        g["total"] -= burn
        g["burn"] = burn
        g["state"] = "announced"
        self.burn_at[name] = self.t + self.unit
        self.Z += burn
        return burn

    def execute_forfeit(self, name):
        self.settle()
        g = self.grants[name]
        assert self.t >= self.burn_at[name]
        burn = g["burn"]
        g["burn"] = F(0)
        g["state"] = "closed"
        self.Z -= burn
        self.G -= burn
        return burn


def _ceil_edge(old, rem, x, unit):
    """ceil((old x rem + x x unit) / (old + x)) in seconds, refusing a value so close to a whole second that the
    contract's integer `arriving` (a few units off the model's exact one) could round it the other way."""
    def calc(o):
        return (o * F(rem) + x * F(unit)) / (o + x)
    base = calc(old)
    c = int(base.to_integral_value(rounding=ROUND_CEILING))
    for d in (F(-4), F(4)):
        if int(calc(old + d).to_integral_value(rounding=ROUND_CEILING)) != c:
            raise EdgeError("arrival end sits on a whole second")
    return c


def check_no_edge_on_fraction(num, den):
    """Used by the generator: a leave fraction is always exact, nothing to check."""
    return num, den
