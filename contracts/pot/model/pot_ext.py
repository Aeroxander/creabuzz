# The reference model of the join-and-leave rules, carried to what the step 1 contracts define.
#
# `v4_model.py` is the exact-decimal model of the design and is read in unchanged. This file adds, on top of it and
# only where the contracts differ from the model (the full list is in POT-STEP1A-REPORT.md and in README.md here):
#   - the quote offset (one virtual dollar UNIT of money AND of paid-in, 1e14 wei of virtual Shares) in the join price;
#   - a first join into a project that already holds money priced by the same formula (the model prices it flat) and credited
#     as paid-in only what is left of the payment after the price of its slice of that money;
#   - the allowance as a linear accrual between settles on the pot, with the box cut to seven days of accrual on pot + box;
#   - outside money arriving as one weighted-average stream over one time unit N;
#   - the check-in window of 2N and active seconds;
#   - Team Shares held by named accounts, and the burn queue Z with its one notice period;
#   - the task queue and the exit notes of step 2 (JOIN-LEAVE-DESIGN.md 2.3b and 2.3c, as the contracts define them): a task is
#     announced, waits its notice (2N plus N/1400 per ten-thousandth of the pot, rounded up to a second), can be taken for one
#     more N, and is then due 2N after the take; the money set aside is the smaller of the stated dollars and the stated share of
#     the settled pot; at most 10% of the pot taken in any rolling 4N; money set aside counts at face in a joiner's price; a leaver
#     is paid cash on the pot without it and written a note for the rest, spread over the taken tasks by their stayers' claims;
#     a task that ends returns what is not paid to the worker at ONE ratio to the stayers and to the notes; a task that runs out
#     returns at the END of the settle (after the allowance and the release); a wind-down returns every open task.
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
OFFSET_USD = F(1)  # one dollar unit (a millionth of a dollar), in the quote only
OFFSET_SHARES = F(10) ** 14  # 1e14 wei of Shares (a ten-thousandth of a Share), in the quote only
CHECK_IN_MULT = 2
CLIFF_MULT = 13
VEST_MULT = 104
MAX_RATE_PPM = 2000


class EdgeError(Exception):
    """A scenario sits on a rounding edge: the contract's integers could land on the other side of it."""


class Blocked(Exception):
    """A take that the 10% cap of the rolling 28 days refuses (the contract reverts it)."""


def ceil_div(a, b):
    """ceil(a / b) for whole numbers (the notice, in seconds)."""
    return -(-a // b)


def ceil_int(x):
    return int(Decimal(x).to_integral_value(rounding=ROUND_CEILING))


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
        self.ann = {}  # announced tasks by serial: dict(bps, max, payee, notice_end, expires)
        self.nserial = 1  # serials start at 1 and are never reused
        self.takes = []  # (time, ten-thousandths of the pot) of every take, for the rolling cap
        self.wound = False

    # ---------- the clock
    def window_end(self):
        return 0 if self.wound else self.last_ci + CHECK_IN_MULT * self.unit

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
        # tasks whose time is up come back LAST, after the allowance and the release: a deadline returns what was set aside
        # (no payment), the end of a take window only frees the slot
        for serial in sorted(self.tasks):
            if self.tasks[serial].deadline <= t:
                self.resolve(serial, 0)
        for serial in sorted(self.ann):
            if self.ann[serial]["expires"] <= t:
                del self.ann[serial]

    def advance(self, secs):
        self.t += secs

    # ---------- the price a joiner pays (the contract's PotMath.quote)
    def vq(self):
        x = self.P + self.D + self.Ctot() + OFFSET_USD
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
        # the payment less what the joiner paid for the surplus part of the price (the same quote that priced the join), and,
        # with backers in the project, at most the paid-in per Share already there
        x = self.P + self.D + self.Ctot() + OFFSET_USD
        aq = self.A + OFFSET_USD
        sur = max(F(0), x - aq)
        credit = max(F(0), m - n * sur / (self.B + OFFSET_SHARES + (self.G - self.Z)))
        if self.B != 0:
            credit = min(credit, n * self.A / self.B)
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
        cash, note = self.leave(acct, n)
        return cash, behind, note

    def take_out_team(self, acct, n):
        self.settle()
        cash, note = self.leave_team(acct, n)
        return cash, note

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

    # ---------- the task queue (the contracts' rules in exact arithmetic)
    def notice_secs(self, bps):
        """2N plus N/1400 per ten-thousandth, rounded up to a whole second (14 days plus 12 hours per 1% at N = 7 days)."""
        return 2 * self.unit + ceil_div(bps * self.unit, 1400)

    def announce(self, bps, max_usd, payee):
        self.settle()
        assert not self.wound and self.door_open(), "no new task while quiet or wound down"
        assert 1 <= bps <= 500 and len(self.ann) + len(self.tasks) < 8
        serial = self.nserial
        self.nserial += 1
        notice = self.notice_secs(bps)
        self.ann[serial] = dict(bps=bps, max=F(max_usd), payee=payee, notice_end=self.t + notice,
                                expires=self.t + notice + self.unit)
        return serial, notice

    def cancel_task(self, serial):
        self.settle()
        del self.ann[serial]

    def window_sum(self):
        return sum(b for at, b in self.takes if at + 4 * self.unit > self.t)

    def take_task(self, serial, who):
        """The smaller of the stated dollars and the stated share of the settled pot, taken out of the pot into the task. The
        cap counts ceil(amount x 10,000 / pot) ten-thousandths; a take that would pass 1,000 in any 4N is refused (Blocked)."""
        self.settle()
        assert self.door_open() and not self.wound
        a = self.ann[serial]
        assert a["notice_end"] <= self.t < a["expires"], "outside the take window"
        by_share = self.P * F(a["bps"]) / F(10_000)
        amount = min(a["max"], by_share)
        if a["max"] < by_share:  # the share is exact when it binds; otherwise the ceil must not sit on an edge
            bps = ceil_int(amount * 10_000 / self.P)
            for d in (F(-8), F(8)):
                if ceil_int(amount * 10_000 / (self.P + d)) != bps:
                    raise EdgeError("the cap's ceil sits on a whole ten-thousandth")
        else:
            bps = a["bps"]
        if self.window_sum() + bps > 1000:
            raise Blocked()
        self.takes.append((self.t, bps))
        self.P -= amount
        task = v4.Task(serial, who, amount)
        task.deadline = self.t + 2 * self.unit
        self.tasks[serial] = task
        del self.ann[serial]
        return amount

    def accept_task(self, serial, pay):
        self.settle()
        task = self.tasks[serial]
        assert self.t < task.deadline
        pay = F(pay)
        assert 0 < pay <= task.locked
        return self.resolve(serial, pay)

    def reject_task(self, serial):
        self.settle()
        return self.resolve(serial, 0)

    def claim(self, serial, acct):
        self.settle()
        return self.claim_note(serial, acct)

    def wind_down(self):
        """The box returns to the pot, the door shuts for good, every open task ends: announced ones are cancelled, taken ones
        return their money (the notes keep their face)."""
        self.settle()
        self.P += self.box
        self.box = F(0)
        self.wound = True
        for serial in sorted(self.tasks):
            self.resolve(serial, 0)
        self.ann.clear()

    def notes_held(self):
        """What the Treasury holds for notes: the face of the notes against open tasks, and what is still claimable on tasks that ended."""
        face = sum((sum(t.notes.values(), F(0)) for t in self.tasks.values()), F(0))
        return face + sum(self.claimable.values(), F(0))

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
