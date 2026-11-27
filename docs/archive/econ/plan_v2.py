# Plan V2 numbers. Plain constant-product pool, 1% fee on the way in. All output is SIMULATED.
def buy(usd_pool, sh_pool, usd):
    x = usd*0.99; out = sh_pool*x/(usd_pool+x)
    p0 = usd_pool/sh_pool; p1=(usd_pool+x)/(sh_pool-out); return out, p1/p0-1
def sell(usd_pool, sh_pool, sh):
    x = sh*0.99; out = usd_pool*x/(sh_pool+x)
    p0 = usd_pool/sh_pool; p1=(usd_pool-out)/(sh_pool+x); return out, p1/p0-1
print("model check vs M3: 2200 pool +%.1f%% (measured 9.2), 880 pool +%.1f%% (measured 23.7)"%(buy(2200,88e6,100)[1]*100, buy(880,35.2e6,100)[1]*100))
print("sell 9M into 2200/88M: %.2f usd, %.1f%% (measured 202.27, -17.5)"%(sell(2200,88e6,9e6)[0], sell(2200,88e6,9e6)[1]*100))
P=0.0004
for raised in (100000, 250000, 400000):
    price = max(P, raised/250e6); pool=0.22*raised; sh=pool/price
    sh=min(sh,100e6)
    print("auction %d: price %.6f pool %d usd / %.1fM sh; buy100 %+.2f%%, buy2500 %+.1f%%, sell2500usd-worth %+.1f%%; floor/share day1 %.1f%% of price"%(
        raised, price, pool, sh/1e6, buy(pool,sh,100)[1]*100, buy(pool,sh,2500)[1]*100, sell(pool,sh,2500/price)[1]*100,
        0.60*raised/(raised/price+sh)/price*100))
# backing round
for size in (2500,10000,40000):
    print("round %d: shares %.1fM, platform %d, at once %d, weekly %.0f; project has after 4w %.0f, 13w %.0f, 26w %.0f"%(
        size, size*3000/1e6, size*.03, size*.15, size*.82/26, size*.15+size*.82*28/182, size*.15+size*.82*91/182, size*.97))
for d in (0,28,45,91,182):
    print(" refund per 100 on day %d: %.1f"%(d, 82*(1-d/182)*0.95))
print("founder side by day 15, backing: %.1f per 100; auction: %.1f per 100"%(15+82*15/182, 15+60*15/365))
# bear run day 45, half leave
for size in (2500,10000):
    left=0.5*size*.82*(1-45/182); paid=left*.95
    proj=size*.15+size*.82*45/182+ (size*.82*(1-45/182)-left) + left*.04
    print("bear backing %d: leavers take %.0f, project ends with %.0f (%.1f%%)"%(size,paid,proj,proj/size*100))
R=100000; fl=.6*R*(1-45/365); cnt=250e6+55e6; sl=fl*125e6/cnt
proj=.15*R+.6*R*45/365+(fl-sl)+sl*.04
print("bear auction 100k: leavers take %.0f, project ends with %.0f (%.1f%%), pool 22000 stays"%(sl*.95,proj,proj/R*100))
# held Shares releasing after market: self-filled 150M backing, cost 3% of 50,000
for days in (1,30,90,180,365):
    freed=150e6*days/365
    out,dp=sell(22000,55e6,freed)
    print("day %d after market: %.1fM of 150M backing Shares free; sold at once take %.0f usd of the 22,000 pool, price %+.0f%%"%(days,freed/1e6,out,dp*100))
out,dp=sell(22000,55e6,150e6); print("no hold: 150M sold on day 1 take %.0f, price %+.0f%%"%(out,dp*100))
# income
def year(rounds, avg_r, auctions, avg_a, turn, back_frac, tasks, mgr):
    rb=rounds*avg_r; ra=auctions*avg_a
    fee=.03*(rb+ra); trade=.22*ra*turn*.0025; ex=.01*back_frac*(.82*rb+.60*ra); t=.025*tasks; m=mgr*120
    tot=fee+trade+ex+t+m
    return rb+ra,fee,trade,ex,t,m,tot
for name,a in (("bear, no auction",(200,3000,0,0,10,.25,100000,20)),("bear, one auction",(200,3000,1,100000,10,.25,100000,20)),("good",(1800,5000,100,150000,40,.10,2000000,300))):
    r=year(*a); print(name,"raised %d: raise fee %d, trades %d, hand-back %d, tasks %d, manager %d, TOTAL %d (%.2f%% of raised)"%r+ (r[6]/r[0]*100,) if False else (name,"raised %d: raise fee %d, trades %d, hand-back %d, tasks %d, manager %d, TOTAL %d"%r, "take %.2f%%"%(r[6]/r[0]*100)))
for wage in (72000,300000,600000):
    print("wage bill %d needs fees %d = raised about %.1fM (bear take 4.0%%) to %.1fM (good take 4.8%%)"%(wage,wage*2,wage*2/.040/1e6,wage*2/.048/1e6))
