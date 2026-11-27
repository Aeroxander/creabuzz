"""Project-money simulations. Plain standard library. Every number printed is SIMULATED.
Assumptions are printed with each section. Pool model: Uniswap full-range constant product, 1% fee on the way in
(calibrated below against the measured M3 numbers)."""
from math import sqrt
FEE=0.01
def buy_move(D,x):   # price multiple after buying with x dollars in a pool holding D dollars
    return ((D+(1-FEE)*x)/D)**2
def sell_move(D,v):  # price multiple after selling Shares worth v dollars at the starting price
    return (1/(1+(1-FEE)*v/D))**2
def sell_out(D,N,s): # dollars received for selling s Shares into pool (D dollars, N Shares)
    s2=s*(1-FEE); return D*s2/(N+s2), (N/(N+s2))**2

print("=== 1. POOL DEPTH (calibration against measured M3, then the bar) ===")
for name,D,m100,m2500 in (("Standard",2200,9.2,351.5),("Small",880,23.7,1353.5)):
    print(f"{name} pool {D}: buy100 +{(buy_move(D,100)-1)*100:.1f}% (measured +{m100}); buy2500 +{(buy_move(D,2500)-1)*100:.1f}% (measured +{m2500}); "
          f"sell100 {(sell_move(D,100)-1)*100:.1f}%; sell2500 {(sell_move(D,2500)-1)*100:.1f}%")
d100=0.99*100/(sqrt(1.02)-1); d2500=0.99*2500/(sqrt(1.25)-1)
print(f"dollars needed so a 100 buy moves <2%: {d100:,.0f}; so a 2,500 buy moves <25%: {d2500:,.0f}")
for D in (880,2200,11000,21000,22000,42000,55000):
    print(f"  pool {D:>6,}: buy100 +{(buy_move(D,100)-1)*100:5.2f}%  buy2500 +{(buy_move(D,2500)-1)*100:7.1f}%  sell2500 {(sell_move(D,2500)-1)*100:6.1f}%")

print("\n=== 2. BACKING ROUNDS (fixed price, no pool). Split 3 platform / 15 at once / 82 refundable, released evenly ===")
def backing(size,price,days,label):
    plat=.03*size; once=.15*size; floor=.82*size; shares=size/price
    print(f"{label}: {size:,} at ${price:.4f}/Share -> {shares/1e6:.1f}M Shares ({shares/1e7:.2f}% of all). platform {plat:,.0f}; at once {once:,.0f}; "
          f"refundable {floor:,.0f} over {days} days = {floor/days*7:,.1f}/week. Cap per account {size*0.1:,.0f}; goes through from {size*0.25:,.0f}.")
    for d in sorted({0,7,28,45,91,days}):
        left=floor*(1-d/days) if d<days else 0
        print(f"    day {d:>3}: project has received {once+floor-left:>8,.0f} ({(once+floor-left)/size*100:4.1f}%); a backer handing back gets {left*0.95/size*100:4.1f} per 100 paid")
    # bear run: half the money hands back on day 45
    d=45; rel=floor*d/days; left=floor-rel; sl=left*0.5
    proj=once+rel+(left-sl)+0.04*sl
    print(f"    BEAR RUN, half hand back on day 45: leavers get {0.95*sl:,.0f} ({0.95*sl/(size/2)*100:.1f}% of what they paid); platform {0.01*sl:,.1f}; "
          f"project ends with {proj:,.0f} = {proj/size*100:.1f}% of the round (no run: 97%). Stayers' refund right unchanged.")
backing(1000,0.0001,91,"Solo 1,000")
backing(2500,0.0001,91,"Solo 2,500")
backing(10000,0.0002,182,"Backed 10,000")
print("  alternatives for the 2,500 round (project % received by day 28 / 91; refund per 100 on day 28; bear-run project %):")
for a,f,T,n in ((.15,.82,365,"15/82 over 12 months"),(.15,.82,182,"15/82 over 26 weeks"),(.15,.82,91,"15/82 over 13 weeks (chosen)"),(.30,.67,91,"30/67 over 13 weeks")):
    r=lambda d: a+f*min(1,d/T)
    rel=f*min(1,45/T); left=f-rel; run=a+rel+left*0.5+0.04*left*0.5
    print(f"    {n:30}: {r(28)*100:4.1f}% / {r(91)*100:4.1f}%; refund {f*(1-28/T)*95:4.1f}; bear run {run*100:4.1f}%")

print("\n  OVERSUBSCRIBED 2,500 round (assumption: 60 real backers asking 80 each = 4,800; one whale with 20 accounts asking the 250 cap each = 5,000):")
honest=60*80; whale=20*250; tot=honest+whale; k=2500/tot
print(f"    pro-rata in a 24-hour window (chosen): everyone gets {k*100:.1f}% of what they asked. Real backers {honest*k:,.0f} ({honest*k/25:.0f}%), whale {whale*k:,.0f} ({whale*k/25:.0f}%); whale had to lock {whale:,} for a day")
print(f"    first come first served: a bot whale takes up to 2,500 (100%) in the first block with 10 accounts")
L=2500/80
print(f"    equal top-up (everyone gets the same amount): each account {L:.2f}; whale 20 accounts {20*L:,.0f} (25%). But accounts are free: with 500 accounts asking 5 each (2,500 locked) the whale gets {500*2500/560/25:.0f}%")
w2=500*250; k2=2500/(honest+w2)
print(f"    pro-rata against the same 500 accounts: whale must lock {w2:,} dollars to get {w2*k2/25:.0f}%")

print("\n  WHY NOT ONE SHARED FLOOR ACROSS ROUNDS (the built Treasury rule applied to rounds at rising prices):")
f1=0.82*2500*0.5; s1=25e6   # round 1 half released
f2=0.82*10000; s2=50e6
F=f1+f2; S=s1+s2
old=F*s1/S
print(f"    round 1: 2,500 at 0.0001 (25M Shares), half its refundable money already released ({f1:,.0f} left). Round 2: 10,000 at 0.0002 (50M Shares) adds {f2:,.0f}.")
print(f"    shared floor {F:,.0f} over 75M Shares. Round-1 backers can now hand back for {0.95*old:,.0f} ({0.95*old/2500*100:.0f}% of what they paid; before round 2 it was {0.95*f1/2500*100:.0f}%).")
print(f"    Round-2 backers' day-one refund is {0.95*F*s2/S/10000*100:.1f} per 100 instead of {0.82*95:.1f}. If round 1 leaves, {0.96*old-f1:,.0f} dollars of round-2 money went to round-1 backers.")
print(f"    per-round refund (chosen): round-2 backers keep {0.82*95:.1f} per 100 whatever round 1 does.")

print("\n=== 3. AUCTION INTO A POOL ===")
def auction(raised,price,poolrate,float_M,label,founder_rel_M=0):
    sold=raised/price; plat=.03*raised; pool=poolrate*raised; rest=raised-plat-pool; once=rest/5; floor=rest*4/5
    poolS=pool/price
    counted=sold+poolS+float_M*1e6+founder_rel_M*1e6
    fps=floor/counted
    print(f"{label}: raised {raised:,} at ${price:.4f} ({sold/1e6:.0f}M Shares sold). platform {plat:,.0f} | pool {pool:,.0f} with {poolS/1e6:.1f}M Shares ({poolrate*100:.0f}%) | at once {once:,.0f} | floor {floor:,.0f} over 365 days ({floor/52:,.0f}/week)")
    print(f"    pool: buy100 +{(buy_move(pool,100)-1)*100:.2f}%, buy2500 +{(buy_move(pool,2500)-1)*100:.1f}%, sell2500 {(sell_move(pool,2500)-1)*100:.1f}%")
    print(f"    Shares that count for the floor: {sold/1e6:.0f}M sold + {poolS/1e6:.1f}M pool + {float_M}M from backing rounds + {founder_rel_M}M founder released = {counted/1e6:.0f}M -> floor per Share ${fps:.7f} = {fps/price*100:.1f}% of the sale price")
    # bear run day 45: half of non-pool holders' Shares handed back
    d=45; rel=floor*d/365; left=floor-rel; leaving=(counted-poolS)/2
    sl=left*leaving/counted
    for rule,stay in (("either fee rule: the 4 reaches the project in the end both ways",0.0),):
        after=left-sl+stay*sl
        proj=once+rel+after+(0.04-stay)*sl
        print(f"    BEAR RUN day 45, half of holders hand back ({rule}): leavers get {0.95*sl:,.0f}; project ends with {proj:,.0f} = {proj/raised*100:.1f}% of the raise (no run {(once+floor)/raised*100:.0f}%)")
    # overhang dump
    for dump in (50e6,150e6):
        got,pm=sell_out(pool,poolS,dump)
        print(f"    OVERHANG: {dump/1e6:.0f}M older Shares sold into the new pool at once: seller gets {got:,.0f} ({got/pool*100:.0f}% of the pool's dollars), price x{pm:.3f} ({(pm-1)*100:.0f}%)")
    # floor arbitrage when price has fallen to the floor
    Dfl=pool*sqrt(fps/price)
    for x in (200,1000,5000):
        be=0.99*0.95/(1+0.99*x/Dfl)
        print(f"    buy-under-the-floor-and-hand-back with {x}: pays once the pool price is {(1-be)*100:.1f}% under the floor (pool then holds {Dfl:,.0f} dollars)")
auction(50000,0.0004,0.42,150,"MARKET size at its minimum, pool 42%")
auction(50000,0.0004,0.22,150,"(for comparison) the same sale with the old 22%")
auction(250000,0.001,0.22,150,"LARGE size at its goal, pool 22%")

print("\n=== 4. FOUNDER BIDDING IN THEIR OWN AUCTION ===")
print("model: one clearing price = max(floor, all bids / Shares for sale); at a cap bids are filled pro rata. Check against measured M3 (Standard, honest 10,000, 400M Shares):")
def sale(D,F,S,floorp,cap=None):
    p=max(floorp,(D+F)/S)
    if cap and p>cap*floorp:
        p=cap*floorp; take=S*p; k=take/(D+F); return p/floorp, D*k/p, F*k, F*k/p
    return p/floorp, D/p, F, F/p
for F,meas in ((5000,"1.49x 266.7M"),(20000,"2.99x 133.3M"),(100000,"4.00x 36.4M, spends 36,364")):
    m,hs,fsp,fs=sale(10000,F,400e6,0.000025,4)
    print(f"   extra {F:>7,}: {m:.2f}x, honest {hs/1e6:.1f}M, founder spends {fsp:,.0f}   (measured {meas})")
S=250e6; fp=0.0004; D=60000
print(f"Market sale, honest bids {D:,} (150M Shares at the floor price). Founder's second account adds F. Lost for good = 45% of the founder's spend (3 platform + 42 pool).")
print("   F          | ABSOLUTE cap 4x floor (proposed): price, honest Shares, founder spends, lost | BUILT rule (4x the price at each bid, ladder): price, early honest Shares, founder spends, lost")
for F in (0,40000,100000,340000,1000000,2500000):
    m,hs,fsp,fs=sale(D,F,S,fp,4)
    m2,hs2,fsp2,fs2=sale(D,F,S,fp,None)
    early = hs2 if m2<=4 else 0.0
    print(f"   {F:>9,} | {m:5.2f}x  {hs/1e6:6.1f}M ({hs/150e6*100:5.1f}%)  {fsp:>9,.0f}  {0.45*fsp:>9,.0f} | {m2:6.2f}x  {early/1e6:6.1f}M  {fsp2:>9,.0f}  {0.45*fsp2:>9,.0f}" + ("  <- early bidders refunded; a late backer whose app sets '4x current' pays this price" if m2>4 else ""))
print("Founder filling their own BACKING round through second accounts (fixed price): cost is the 3% only.")
for size,price in ((2500,0.0001),(12500,0.0002),(25000,0.0004)):
    print(f"   {size:>6,} round: fee {0.03*size:,.0f} -> {size/price/1e6:.1f}M free Shares")
print(f"   whole backing budget (150M Shares, 40,000): fees {0.03*40000:,.0f}. Dumped into a 21,000 pool they would take {sell_out(21000,52.5e6,150e6)[0]:,.0f}.")

print("\n=== 5. EXIT IN PIECES (floor 6,000, 500M Shares counted; calibration against measured M2) ===")
def pieces(frac,n,stay):
    F=6000.0; C=500e6; hold=frac*C; x=hold/n; paid=0
    for _ in range(n):
        sl=F*x/C; paid+=0.95*sl; F-=sl-stay*sl; C-=x
    return paid
for frac,n,meas in ((0.2,100,"1,144.87"),(0.8,400,"4,670.84")):
    one=pieces(frac,1,0.04)
    print(f"   holder of {frac*100:.0f}%: one exit {one:,.2f}; {n} exits, built rule {pieces(frac,n,0.04):,.2f} (measured {meas}); proposed rule (4 to the project) {pieces(frac,n,0.0):,.2f}")

print("\n=== 6. GIFTS THROUGH FRESH WALLETS ===")
def built(C0,F=100000.0,n=11):
    sup=1e9
    for _ in range(n):
        g=0.01*sup; sl=F*g/(C0+g); F-=0.96*sl; sup-=g
    return F
lo,hi=300e6,900e6
for _ in range(60):
    mid=(lo+hi)/2
    if built(mid)<84728: lo=mid
    else: hi=mid
C0=lo
print(f"calibration: measured 100,000 -> 84,728 (11 gifts of 1% of all Shares, handed straight back). The model gives that with {C0/1e6:.0f}M Shares counted; model result {built(C0):,.0f}")
# proposed: permanent (revenue) floor is divided by ALL Shares; gifts cap 1% of counted Shares per 30 days, each released over 90 days
F=100000.0; sup=1e9; C=C0; per_before=F/sup; taken=0
events=[]  # (day released chunk, amount)
for i in range(11):
    g=0.01*C; day=i*33
    events.append((day,g))
for day,amt in sorted(events):
    sl=F*amt/sup; F-=0.96*sl; taken+=0.95*sl; sup-=amt
print(f"proposed (revenue floor shared by all 1,000,000,000 Shares; gift cap 1% of Shares in people's hands per 30 days; gifts free at once as built):")
print(f"   year one: the gift wallets take {taken:,.0f} of 100,000 ({taken/1000:.1f}%). Every other Share's claim: {per_before*1e6:.3f} -> {F/sup*1e6:.3f} dollars per million Shares (it does not fall)")
hb=100000*(1-0.96*0.5)  # sanity not used
print(f"   under the built rule each remaining holder's claim per Share fell {100-built(C0)/1000:.1f}%")
# melting floor drain, auction money, Market sale
def melt_drain(capfun,release_days,F0=22000.0,C=377.5e6,days=365):
    F=F0; taken=0; sched={}
    for i in range(11):
        g=capfun(C); d0=i*33
        if release_days==0: sched[d0]=sched.get(d0,0)+g
        else:
            for d in range(release_days):
                sched[d0+d+1]=sched.get(d0+d+1,0)+g/release_days
    for day in range(days):
        F-=F/(days-day)            # daily release to the project
        g=sched.get(day,0)
        if g: sl=F*g/(C+g); taken+=0.95*sl; F-=0.96*sl
    return taken
t1=melt_drain(lambda C:10e6,0,C=327.5e6); t2=melt_drain(lambda C:0.01*C,0,C=327.5e6); t3=melt_drain(lambda C:0.01*C,90,C=327.5e6)
print(f"melting floor of the Market sale (22,000, 327.5M counted), 11 gifts a year handed straight back: built rule (1% of ALL Shares) the gift wallets take {t1:,.0f} ({t1/220:.1f}%); cap on Shares in people's hands (proposed) {t2:,.0f} ({t2/220:.1f}%); the same plus a 90-day release (not proposed) {t3:,.0f} ({t3/220:.1f}%)")
print("before any pool, under the proposal: 0. A gift bought nothing in a round, so it has no refund to claim.")
