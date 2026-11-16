#!/usr/bin/env python3
"""Remove one guard at a time from the milestone 2 and 3 sources and check that a test fails (a "mutation run").

    python3 scripts/mutate-guards.py            # every removal, unit/fuzz/attack suites (about 75 seconds each)
    python3 scripts/mutate-guards.py T09 L03    # only these ids
    python3 scripts/mutate-guards.py --m3       # only the milestone 3 entries (their ids start with F, A, H, P or X)
    M2_ONLY=1 python3 scripts/mutate-guards.py  # the milestone 2 entries, against the milestone 2 suites only (about 25 seconds each)
    INV_ONLY=1 python3 scripts/mutate-guards.py T10 T15   # only the invariant suite

Each removal edits one file under src/, runs `forge test` on the milestone 2 tests, prints one JSON line (the tests that
failed) and puts the file back with `git checkout`. It refuses to start if src/ has uncommitted changes, because the
restore would throw them away. Stored fuzz and invariant failures are deleted before every run, because Foundry replays
them and would blame a later removal for an earlier one's failure. A line with "n": 0 is a guard no test needs.
"""
import json, os, re, shutil, subprocess, sys

SELF = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# MUT_ROOT: run in another copy of this project (so several runs can go at once); MUT_PRISTINE: where the committed sources are,
# to restore each file from (the copy is not a git checkout).
ROOT = os.environ.get('MUT_ROOT') or SELF
PRISTINE = os.environ.get('MUT_PRISTINE')
ENV = dict(os.environ)
M1 = 'test/{Attacks,ForkFacts,ForkPick,Measure,Pieces,Route,UniversalRouter}.t.sol'
# (id, what is removed or broken, file, old, new, run invariants too)
T='src/Treasury.sol'; V='src/Vester.sol'; S='src/ShareToken.sol'; R='src/RollingCap.sol'; L='src/Launcher.sol'; FI='src/Finisher.sol'; HO='src/LiquidityHolder.sol'; PI='src/Pinned.sol'
MUT=[
('T01','Treasury: initialize may be called again',T,'if (founder != address(0)) revert BadSetup();','',False),
('T02','Treasury: no re-entrancy lock',T,'if (_locked) revert Reentrancy();','',False),
('T03','Treasury: anybody may declare the pool open',T,'function markPoolOpen() external nonReentrant {\n        if (msg.sender != opener) revert NotAllowed();\n        if (poolOpen) revert PoolAlreadyOpen();','function markPoolOpen() external nonReentrant {\n        if (poolOpen) revert PoolAlreadyOpen();',False),
('T04','Treasury: the pool may be declared open twice',T,'function markPoolOpen() external nonReentrant {\n        if (msg.sender != opener) revert NotAllowed();\n        if (poolOpen) revert PoolAlreadyOpen();','function markPoolOpen() external nonReentrant {\n        if (msg.sender != opener) revert NotAllowed();',False),
('T05','Treasury: settle works with no proven pool',T,'if (!poolOpen) revert NoPool();\n        if (amount == 0)','if (amount == 0)',False),
('T06','Treasury: settle may split more than arrived',T,'        if (amount > arrived) revert NotArrived(amount, arrived);\n        _accrue();\n        uint256 toSpendable','        _accrue();\n        uint256 toSpendable',False),
('T07','Treasury: settle ratio is not 15:60',T,'amount * spendableParts / (spendableParts + floorParts)','amount * spendableParts / (spendableParts + floorParts) * 2',True),
('T08','Treasury: any settle renews the check-in window',T,'if (!settled) {\n            (settled, accruedUpTo, lastCheckIn) = (true, block.timestamp, block.timestamp);\n        }','settled = true; accruedUpTo = block.timestamp; lastCheckIn = block.timestamp;',False),
('T09','Treasury: hand back before the sale money is split',T,'if (!settled) revert NotSettled();','',False),
('T10','Treasury: the Vester counts in the exit denominator (its whole balance leaves the count, claimed or not)',T,' - vester.unreleased();',' - shares.balanceOf(address(vester));',True),
('T11','Treasury: the Treasury counts in the exit denominator',T,'shares.totalSupply() - shares.balanceOf(address(this)) - vester.unreleased()','shares.totalSupply() - vester.unreleased()',True),
('T12','Treasury: the exit slice reaches spendable',T,'uint256 slice = floorTotal * amount / counting;','uint256 slice = (floorTotal + spendable) * amount / counting;',True),
('T13','Treasury: no exit fee',T,'paid = slice - (slice * exitFeeBps + BPS - 1) / BPS;','paid = slice;',True),
('T14','Treasury: exit fee rounds down',T,'(slice * exitFeeBps + BPS - 1) / BPS','(slice * exitFeeBps) / BPS',False),
('T15','Treasury: the platform part of the fee is not recorded',T,'        feesOwed += toPlatform;\n','',True),
('T16','Treasury: an exit does not burn the Shares',T,'        shares.burnFrom(msg.sender, amount);\n','',True),
('T17','Treasury: an exit does not first work out the daily release',T,'        if (amount == 0) revert BadInput();\n        _accrue();\n        uint256 counting','        if (amount == 0) revert BadInput();\n        uint256 counting',False),
('T18','Treasury: the release ignores the check-in window',T,'uint256 upto = block.timestamp < end ? block.timestamp : end;','uint256 upto = block.timestamp; end;',False),
('T19','Treasury: anyone may check in',T,'if (msg.sender != founder && !agents[msg.sender].active) revert NotAllowed();','',False),
('T20','Treasury: an agent spends with no daily cap',T,'_agentUsd[msg.sender].consume(DAY, DAY_PARTS, a.usdCap, amount);','',False),
('T21','Treasury: spend does not stop at spendable (error kind)',T,'if (amount > spendable) revert TooMuch(amount, spendable);','',False),
('T22','Treasury: an agent gives Shares with no daily cap',T,'_agentShares[msg.sender].consume(DAY, DAY_PARTS, a.shareCap, amount);','',False),
('T23','Treasury: no monthly cap on gifts after the pool',T,'_gifts.consume(MONTH, MONTH_PARTS, shares.totalSupply() * GIFT_CAP_BPS / BPS, amount);','',True),
('T24','Treasury: gifts before the pool go straight to the person',T,'if (poolOpen) {\n            _gifts','if (true) {\n            _gifts',False),
('T25','Treasury: the work pot may be overdrawn (error kind)',T,'if (amount > workPot) revert WorkPotShort(amount, workPot);','',False),
('T26','Treasury: anyone may take the reserve out',T,'if (msg.sender != salePath) revert NotAllowed();','',True),
('T27','Treasury: anyone may set agents',T,'        if (msg.sender != founder) revert NotAllowed();\n        if (agent == address(0)) revert BadInput();','        if (agent == address(0)) revert BadInput();',False),
('T28','Treasury: anyone may switch agents off',T,'        if (msg.sender != founder) revert NotAllowed();\n        agents[agent].active = false;','        agents[agent].active = false;',False),
('T29','Treasury: an outgoing token fee is not noticed',T,'if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();','',False),
('T30','Treasury: a pulled amount is credited as asked, not as received',T,'got = quote.balanceOf(address(this)) - before;','got = amount;',False),
('T31','Treasury: fees are swept to the caller',T,'_pay(platform, owed);','_pay(msg.sender, owed);',False),
('T32','Treasury: fees owed count as new money',T,'uint256 accounted = spendable + melting + permanentFloor + feesOwed;','uint256 accounted = spendable + melting + permanentFloor;',False),
('T33','Treasury: a second sale restarts the clock at a year',T,'meltRemaining = m == 0 ? RELEASE_PERIOD : (m * meltRemaining + toFloor * RELEASE_PERIOD) / (m + toFloor);','meltRemaining = RELEASE_PERIOD;',False),
('T34','Treasury: release is a share of the original deposit, not of what is left',T,'return (m * active / remaining, remaining - active);','return (m * active / RELEASE_PERIOD, remaining - active);',False),
('T35','Treasury: gifts to the Vester address are allowed',T,'|| to == address(vester) ||','||',False),
('T36','Treasury: more than the counting supply may be handed back (error kind)',T,'if (amount > counting) revert TooMuch(amount, counting);','',False),
('T37','Treasury: a hand back that pays nothing still burns',T,'if (paid == 0) revert NothingToPay();','',False),
('T38','Treasury: the exit takes everything from the melting floor',T,'uint256 fromPermanent = leaves * permanentFloor / floorTotal;','uint256 fromPermanent = 0;',False),
('T39','Treasury: shareRevenue goes to the melting floor',T,'permanentFloor += got;\n        emit ShareRevenue','melting += got;\n        emit ShareRevenue',False),
('T40','Treasury birth check: an exit fee of 100% or more is accepted',T,'|| s.exitFeeBps >= BPS ||','||',False),
('V01','Vester: anyone may start the clock',V,'if (msg.sender != starter) revert NotAllowed();','',False),
('V02','Vester: the clock may be started twice',V,'if (start != 0) revert WrongPhase();\n        start = block.timestamp;','start = block.timestamp;',False),
('V03','Vester: grants may be added after the clock started',V,'if (start != 0) revert WrongPhase();\n        _grant','_grant',False),
('V04','Vester: a grant needs no Shares behind it',V,'if (shares.balanceOf(address(this)) < committed + amount) revert NotFunded();','',False),
('V05','Vester: Shares release before the clock starts',V,'if (s == 0) return 0;','if (s == 0) s = 1;',False),
('V06','Vester: the release does not stop at the grant',V,'return elapsed >= DURATION ? total : total * elapsed / DURATION;','return total * elapsed / DURATION;',False),
('V07','Vester: initialize may be called twice',V,'if (starter != address(0)) revert AlreadyInitialized();','',False),
('V08','Vester: a claim does not record what was claimed',V,'        grants[beneficiary].claimed += amount;\n','',False),
('V09','Vester: anyone may add grants',V,'if (msg.sender != granter) revert NotAllowed();','',False),
('S01','ShareToken: birth may be repeated',S,'if (_born || to.length != amounts.length) revert BadBirth();','if (to.length != amounts.length) revert BadBirth();',False),
('S02','ShareToken: birth amounts need not add up to the supply',S,'if (sum != SUPPLY) revert BadBirth();','',False),
('S03','ShareToken: burnFrom ignores the allowance',S,'        _spendAllowance(from, value);\n        _burn(from, value);','        _burn(from, value);',False),
('S04','ShareToken: transferFrom ignores the allowance',S,'        _spendAllowance(from, value);\n        _move(from, to, value);','        _move(from, to, value);',False),
('S05','ShareToken: the implementation is not locked',S,'        _born = true; // the copy the clones point at can never be initialised','',False),
('R01','RollingCap: no cap check',R,'if (already + amount > cap) revert CapExceeded(already, amount, cap);','',False),
('R02','RollingCap: only the newest part counts',R,'if ((e >> 192) + buckets >= cur) sum += e & MASK;','if ((e >> 192) == cur) sum += e & MASK;',False),
('R03','RollingCap: a used amount stops counting one part early',R,'if ((e >> 192) + buckets >= cur) sum += e & MASK;','if ((e >> 192) + buckets > cur) sum += e & MASK;',False),
('L01','Launcher: a founder may reuse an id (error kind)',L,'if (_projects[key].shares != address(0)) revert ProjectExists();','',False),
('L05','Launcher: anyone may change settings',L,'        if (msg.sender != admin) revert NotAdmin();\n        _set(next);','        _set(next);',False),
('L06','Launcher: the exit fee ceiling is not checked',L,'s.exitFeeBps > MAX_EXIT_FEE_BPS ||','',False),
('L09','Launcher: the founder allocation is 190M not 200M',L,'uint256 public constant FOUNDER = 200_000_000e18;','uint256 public constant FOUNDER = 190_000_000e18;',False),


('L07','Launcher: the platform part may exceed the whole fee',L,'|| s.platformFeeBps > s.exitFeeBps','',False),
('L10','Launcher: the founder is the Launcher, not the caller',L,'                    founder: msg.sender,','                    founder: address(this),',False),
('T41','Treasury: the reserve ignores Shares returned or donated to it',T,'return shares.balanceOf(address(this)) - workPot;','return 100_000_000e18;',False),
('T29b','Treasury: raw transfer, no balance measurement on the way out (both layers)',T,'quote.safeTransfer(to, amount);\n        uint256 afterBal = quote.balanceOf(address(this));\n        if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();','quote.transfer(to, amount);',False),
('T30b','Treasury: raw transferFrom, no arrival check on the way in (both layers)',T,'quote.safeTransferFrom(msg.sender, address(this), amount);\n        got = quote.balanceOf(address(this)) - before;\n        if (got == 0) revert TokenMisbehaved();','quote.transferFrom(msg.sender, address(this), amount);\n        got = amount;',False),
('T42','Treasury birth check: a platform part above the whole fee is accepted',T,'|| s.platformFeeBps > s.exitFeeBps ||','||',False),
('T43','Treasury: a check-in does not first work out the release',T,'        _accrue();\n        lastCheckIn = block.timestamp;','        lastCheckIn = block.timestamp;',False),
('T44','Treasury: spend does not work out the release first',T,'        _accrue();\n        if (amount > spendable)','        if (amount > spendable)',False),
('T45','Treasury: the exit takes the fee from the floor instead of leaving it (the 4 percent leaves too)',T,'uint256 leaves = paid + toPlatform;','uint256 leaves = slice;',True),
('T46','Treasury: an exit pays twice its slice',T,'uint256 slice = floorTotal * amount / counting;','uint256 slice = floorTotal * amount / counting * 2;',False),
('T47','Treasury: the platform part is recorded twice',T,'feesOwed += toPlatform;','feesOwed += toPlatform * 2;',False),
('T48','Treasury: spend lets spendable fall below zero silently',T,'if (amount > spendable) revert TooMuch(amount, spendable);\n        spendable -= amount;','spendable = spendable > amount ? spendable - amount : 0;',False),
# ---- milestone 2 review round (fix round)
('T49','Treasury: hand back before the sale is closed (unsold Shares count as held)',T,'if (!saleClosed) revert SaleNotClosed();','',False),
('T50','Treasury: anybody may mark the sale closed',T,'        if (msg.sender != opener) revert NotAllowed();\n        if (!poolOpen) revert NoPool();\n        if (saleClosed)','        if (!poolOpen) revert NoPool();\n        if (saleClosed)',False),
('T51','Treasury: the sale may be marked closed before the pool is proven',T,'        if (!poolOpen) revert NoPool();\n        if (saleClosed)','        if (saleClosed)',False),
('T52','Treasury: the sale may be marked closed twice',T,'if (saleClosed) revert SaleAlreadyClosed();','',False),
('T53','Treasury birth check: no ceiling on the spendable part of the split',T,'|| s.spendableParts > MAX_SPLIT_PART','',False),
('T54','Treasury birth check: no ceiling on the floor part of the split',T,'|| s.floorParts > MAX_SPLIT_PART','',False),
('V10','Vester: unreleased is nothing before the clock starts',V,'if (s == 0) return granted;','if (s == 0) return 0;',False),
('V11','Vester: unreleased does not fall with time',V,'return elapsed >= DURATION ? 0 : granted - granted * elapsed / DURATION;','return elapsed >= DURATION ? 0 : granted;',False),
('V12','Vester: unreleased forgets what was granted',V,'        granted += amount;\n','',False),
('V13','Vester: unreleased falls with claims (the old denominator)',V,'return elapsed >= DURATION ? 0 : granted - granted * elapsed / DURATION;','return elapsed >= DURATION ? 0 : committed - (committed * elapsed / DURATION);',False),
('L13','Launcher: launch ignores the settings hash the founder saw',L,'if (settingsHash() != expectedSettingsHash) revert SettingsMoved();','',False),
('L15','Launcher: the dollar token may be an account, not a contract',L,' || address(s.quote).code.length == 0','',False),
('L16','Launcher: the dollar token may have any decimals',L,'if (d != QUOTE_DECIMALS) revert BadSettings();','',False),
('L17','Launcher: platform address may be the Launcher',L,'s.platform == address(this) ||','',False),
('L18','Launcher: platform address may be the dollar token',L,'|| s.platform == address(s.quote)','',False),
('L19','Launcher: no ceiling on the spendable part of the split',L,'|| s.spendableParts > MAX_SPLIT_PART','',False),
('L20','Launcher: no ceiling on the floor part of the split',L,'|| s.floorParts > MAX_SPLIT_PART','',False),
]


# ---- milestone 3: the Finisher, the LiquidityHolder, the real Launcher, the Treasury's abandoned state.
# A seventh field names the test files to run (the milestone 3 suites are slow and each guard has one or two that must catch it).
FIN='test/{FinishAttacks,Life,SaleRules,FinisherPool}.t.sol'
FINA='test/{AttackM2,FinishAttacks}.t.sol'
LAU='test/{Launcher,SaleRules,Life,AttackM2}.t.sol'
HOL='test/{LiquidityHolder,Life,MarketAttacks}.t.sol'
TAB='test/{TreasuryAbandon,FinishAttacks}.t.sol'
DRI='test/PinnedDrift.t.sol'
M2SUITES='test/{AttackM2,Treasury,TreasuryActions,TreasuryAttacks,TreasuryEdges,TreasuryFuzz,TreasuryAbandon,Launcher,Vester,ShareToken,RollingCap}.t.sol'
M3=[
('F01','Finisher: anyone may open the sale',FI,'        if (msg.sender != launcher) revert NotLauncher();\n        if (!canOpen()) revert CannotOpen();','        if (!canOpen()) revert CannotOpen();',False,FIN),
('F02','Finisher: anyone may set a clone up',FI,'        if (msg.sender != launcher) revert NotLauncher();\n        if (address(treasury) != address(0) ||','        if (address(treasury) != address(0) ||',False,FINA),
('F03','Finisher: a clone may be set up twice',FI,'if (address(treasury) != address(0) || treasury_','if (treasury_',False,FINA),
('F04','Finisher: a failed sale may open again at once',FI,'(s == Stage.Failed && block.number >= retryBlock)','(s == Stage.Failed)',False,FIN),
('F05','Finisher: a project that sold may open another sale',FI,'return s == Stage.Idle ||','return s == Stage.Idle || s == Stage.Done ||',False,FIN),
('F06','Finisher: a second sale may open while one is open',FI,'return s == Stage.Idle ||','return s == Stage.Idle || s == Stage.Open ||',False,FIN),
('F07','Finisher: an abandoned project may open another sale',FI,'return s == Stage.Idle ||','return s == Stage.Idle || s == Stage.Abandoned ||',False,FIN),
('F08','Finisher: step 1 runs the pool step again',FI,'if (s != Stage.Open || !_stepPending()) return false;','if (s != Stage.Open) return false;',False,FIN),
('F09','Finisher: step 1 works on a project with no sale',FI,'        if (s == Stage.Idle) revert WrongStage();\n        if (s != Stage.Open || !_stepPending()) return false;','        if (s != Stage.Open || !_stepPending()) return false;',False,FIN),
('F10','Finisher: step 2 does not know it is done',FI,'        if (settled) return false;\n','',False,FIN),
('F11','Finisher: step 2 works at any stage',FI,'        if (stage != Stage.Open) revert WrongStage();\n        if (_stepPending()) revert PoolStepNotRun();\n        IPinnedAuction a = IPinnedAuction(auction);\n        if (!a.isGraduated()) revert SaleDidNotGraduate();\n        if (!poolIsOpen()) revert NoPool();','        if (_stepPending()) revert PoolStepNotRun();\n        IPinnedAuction a = IPinnedAuction(auction);\n        if (!a.isGraduated()) revert SaleDidNotGraduate();\n        if (!poolIsOpen()) revert NoPool();',False,FIN),
('F12','Finisher: step 2 does not need step 1',FI,'        if (_stepPending()) revert PoolStepNotRun();\n        IPinnedAuction a = IPinnedAuction(auction);\n        if (!a.isGraduated()) revert SaleDidNotGraduate();\n        if (!poolIsOpen())','        IPinnedAuction a = IPinnedAuction(auction);\n        if (!a.isGraduated()) revert SaleDidNotGraduate();\n        if (!poolIsOpen())',False,FIN),
('F13','Finisher: step 2 splits a sale that did not reach its minimum',FI,'        if (!a.isGraduated()) revert SaleDidNotGraduate();\n        if (!poolIsOpen()) revert NoPool();\n        uint256 raised','        if (!poolIsOpen()) revert NoPool();\n        uint256 raised',False,FIN),
('F14','Finisher: step 2 splits the money when no pool exists (the swallowed failure)',FI,'        if (!poolIsOpen()) revert NoPool();\n        uint256 raised','        uint256 raised',False,FIN),
('F15','Finisher: step 2 does not compare the money with the auction\'s figures',FI,'        if (held < least) revert MoneyMissing(held, least);\n','',False,FIN),
('F16','Finisher: step 3 does not need step 1',FI,'        if (s != Stage.Open) return false;\n        if (_stepPending()) revert PoolStepNotRun();\n        IPinnedAuction a = IPinnedAuction(auction);\n        a.sweepUnsoldTokens();','        if (s != Stage.Open) return false;\n        IPinnedAuction a = IPinnedAuction(auction);\n        a.sweepUnsoldTokens();',False,FIN),
('F17','Finisher: step 3 does not need step 2',FI,'        if (!settled) revert SettleFirst();\n','',False,FIN),
('F18','Finisher: step 3 does not tell a failed sale from a good one',FI,'        a.sweepUnsoldTokens();\n        if (!a.isGraduated()) {','        a.sweepUnsoldTokens();\n        if (false) {',False,FIN),
('F19','Finisher: a failed sale may retry from the block it failed in',FI,'uint64 retry = endBlock + SaleParams.SALE_BLOCKS;','uint64 retry = uint64(block.number);',False,FIN),
('F20','Finisher: step 3 does not know it is done',FI,'        if (s == Stage.Idle) revert WrongStage();\n        if (s != Stage.Open) return false;\n        if (_stepPending()) revert PoolStepNotRun();\n        IPinnedAuction a = IPinnedAuction(auction);\n        a.sweepUnsoldTokens();','        if (s == Stage.Idle) revert WrongStage();\n        if (_stepPending()) revert PoolStepNotRun();\n        IPinnedAuction a = IPinnedAuction(auction);\n        a.sweepUnsoldTokens();',False,FIN),
('F21','Finisher: step 3 works on a project with no sale',FI,'        if (s == Stage.Idle) revert WrongStage();\n        if (s != Stage.Open) return false;\n        if (_stepPending()) revert PoolStepNotRun();','        if (s != Stage.Open) return false;\n        if (_stepPending()) revert PoolStepNotRun();',False,FIN),
('F22','Finisher: abandon works at any stage',FI,'    function abandon() external nonReentrant {\n        if (stage != Stage.Open) revert WrongStage();','    function abandon() external nonReentrant {',False,FIN),
('F23','Finisher: abandon works before seven days',FI,'        if (block.number < from) revert TooEarly(from);\n','',False,FIN),
('F24','Finisher: abandon works on a sale that did not reach its minimum',FI,'        if (_stepPending()) _runPoolStep();\n        if (!a.isGraduated()) revert SaleDidNotGraduate();','        if (_stepPending()) _runPoolStep();',False,FIN),
('F25','Finisher: abandon works when a pool exists',FI,'        if (poolIsOpen()) revert PoolExists();\n','',False,FIN),
('F26','Finisher: abandon does not run the pool step first',FI,'        if (_stepPending()) _runPoolStep();\n        if (!a.isGraduated()) revert SaleDidNotGraduate();','        if (!a.isGraduated()) revert SaleDidNotGraduate();',False,FIN),
('F27','Finisher: abandon sends nothing to the floor alone (15 : 60 of everything)',FI,'uint256 toFloorOnly = arrived * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;','uint256 toFloorOnly = 1;',False,FIN),
('F28','Finisher: a guard that names someone else counts as the project\'s guard',FI,'            if (creator != address(strategy)) return false;','',False,FIN),
('F29','Finisher: a hook that answers nothing makes the answer revert',FI,'        try IPinnedGuard(guard).authorized() returns (address creator) {\n            if (creator != address(strategy)) return false;\n        } catch {\n            return false;\n        }','        if (IPinnedGuard(guard).authorized() != address(strategy)) return false;',False,FIN),
('F30','Finisher: a pool with no liquidity counts as open',FI,'return PoolRead.liquidity(poolManager, _poolId()) != 0;','return PoolRead.sqrtPrice(poolManager, _poolId()) != 0;',False,FIN),
('F31','Finisher: no re-entry lock',FI,'        if (_locked) revert Reentrancy();','',False,FIN),
('F32','Finisher: the pool key leaves out the guard (a stranger\'s plain pool counts)',FI,'            hooks: guard\n','            hooks: address(0)\n',False,FIN),
('A01','Launcher: the guard may be no contract',L,'if (poolGuard_.code.length == 0 || uint160(poolGuard_)','if (uint160(poolGuard_)',False,LAU),
('A02','Launcher: the guard may sit at an address without exactly the beforeInitialize bit',L,' || uint160(poolGuard_) & HOOK_BITS != BEFORE_INITIALIZE','',False,LAU),
('A03','Launcher: the guard may name someone else as the pool\'s only creator',L,'            if (creator != strategy_) revert NoPoolGuard();','',False,LAU),
('A04','Launcher: the fee controller may be no contract',L,'        if (controller.code.length == 0) revert BadStack();\n','',False,LAU),
('A05','Launcher: the raise fee may be any rate',L,'IPinnedFeeController(controller).getProtocolFeeAmount(address(0), 1e6) != RAISE_FEE_PIPS','false',False,LAU),
('A06','Launcher: the fee may go to nobody',L,'        if (recipient == address(0)) revert BadStack();\n','',False,LAU),
('A07','Launcher: the fee controller may have an owner',L,'            revert BadStack(); // a controller with an owner can change the fee in the middle of a sale','',False,LAU),
('A08','Launcher: the smallest bid may be anything',L,'            IPinnedMinBid(minBid_).minAmount() != MIN_BID\n                || ','            ',False,LAU),
('A09','Launcher: the top-price cap may be anything',L,'\n                || IPinnedMinBid(minBid_).maxPriceMultiple() != MAX_PRICE_MULTIPLE','',False,LAU),
('A10','Launcher: the strategy may be no contract',L,'strategy_ == address(0) || strategy_.code.length == 0 ||','strategy_ == address(0) ||',False,LAU),
('A11','Launcher: the bid hook may be no contract',L,' || minBid_.code.length == 0) revert BadStack();',') revert BadStack();',False,LAU),
('A12','Launcher: the Treasury trusts the founder as its opener',L,'                    opener: finisher,','                    opener: msg.sender,',False,LAU),
('A13','Launcher: the Treasury trusts the founder as its sale path',L,'                    salePath: address(this),','                    salePath: msg.sender,',False,LAU),
('A14','Launcher: the sale Shares are minted to the Launcher, not the Finisher',L,'(to[0], amounts[0]) = (finisher, SALE + POOL_RESERVE);','(to[0], amounts[0]) = (address(this), SALE + POOL_RESERVE);',False,LAU),
('A15','Launcher: the holder cannot tell which Treasury a project\'s Shares belong to',L,'        treasuryOfShares[shares] = treasury;\n','',False,LAU),
('A16','Launcher: the sale raises the current dollar setting, not the project\'s own (strategy side)',L,'currency: address(Treasury(p.treasury).quote()),\n            migrationBlock','currency: address(settings.quote),\n            migrationBlock',False,LAU),
('A17','Launcher: the sale raises the current dollar setting, not the project\'s own (auction side)',L,'currency: address(Treasury(p.treasury).quote()),\n            tokensRecipient','currency: address(settings.quote),\n            tokensRecipient',False,LAU),
('A18','Launcher: the pool position goes to the Finisher, not the LiquidityHolder',L,'            positionRecipient: holder,','            positionRecipient: p.finisher,',False,LAU),
('A19','Launcher: what the pool leaves goes to the founder',L,'            recipient: p.finisher,\n            positionRecipient','            recipient: msg.sender,\n            positionRecipient',False,LAU),
('A20','Launcher: the unsold Shares go to the founder',L,'            tokensRecipient: p.finisher,','            tokensRecipient: msg.sender,',False,LAU),
('A21','Launcher: no bid rules',L,'            validationHook: minBid,','            validationHook: address(0),',False,LAU),
('A22','Launcher: the pool has no guard',L,'tickSpacing: SaleParams.POOL_TICK_SPACING, hook: poolGuard','tickSpacing: SaleParams.POOL_TICK_SPACING, hook: address(0)',False,LAU),
('A23','Launcher: the pool is reserved half the Shares',L,'reservedTokenAmountForLP: SaleParams.POOL_SHARES,','reservedTokenAmountForLP: SaleParams.POOL_SHARES / 2,',False,LAU),
('A24','Launcher: the pool step may run later than the first block after the sale',L,'migrationBlock: endBlock_ + 1,','migrationBlock: endBlock_ + 5,',False,LAU),
('A25','Launcher: bidders may claim later than the first block after the sale',L,'claimBlock: startBlock + SaleParams.SALE_BLOCKS + 1,','claimBlock: startBlock + SaleParams.SALE_BLOCKS + 2,',False,LAU),
('A26','Launcher: the Standard minimum is 2,000 dollars',L,'return (10_000e6, 2500e6);','return (10_000e6, 2000e6);',False,LAU),
('A27','Launcher: the Small goal is 5,000 dollars',L,'return (4000e6, 2000e6);','return (5000e6, 2000e6);',False,LAU),
('A28','Launcher: the Large minimum is 10,000 dollars',L,'return (50_000e6, 12_500e6);','return (50_000e6, 10_000e6);',False,LAU),
('A29','Launcher: the floor price is rounded down to the tick',L,'tickQ96 = (exact + TICKS_IN_FLOOR - 1) / TICKS_IN_FLOOR;','tickQ96 = exact / TICKS_IN_FLOOR;',False,LAU),
('A30','Launcher: the sale starts in the block it is opened',L,'uint64 startBlock = uint64(block.number + 1);','uint64 startBlock = uint64(block.number);',False,LAU),
('P01','Pinned: the pool takes 20 of every 100 raised',PI,'uint24 internal constant POOL_RATE = 2_268_041;','uint24 internal constant POOL_RATE = 2_061_856;',False,LAU),
('P02','Pinned: the pool fee is 0.3 percent',PI,'uint24 internal constant POOL_FEE = 10_000;','uint24 internal constant POOL_FEE = 3000;',False,LAU),
('P03','Pinned: the pool tick spacing is 60',PI,'int24 internal constant POOL_TICK_SPACING = 200;','int24 internal constant POOL_TICK_SPACING = 60;',False,LAU),
('P04','Pinned: the sale is 6,000 blocks',PI,'uint64 internal constant SALE_BLOCKS = 7200;','uint64 internal constant SALE_BLOCKS = 6000;',False,LAU),
('P05','Pinned: the pool state is read from the wrong storage slot',PI,'bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));','bytes32 internal constant POOLS_SLOT = bytes32(uint256(5));',False,DRI),
('P06','Pinned: abandon opens after one day',PI,'uint64 internal constant ABANDON_DELAY_BLOCKS = 50_400;','uint64 internal constant ABANDON_DELAY_BLOCKS = 7200;',False,FIN),
('H01','LiquidityHolder: anyone\'s position may be collected, held or not',HO,'        if (positionManager.ownerOf(tokenId) != address(this)) revert NotHeld();\n','',False,HOL),
('H03','LiquidityHolder: a position of a stranger\'s plain pool of a project\'s Shares may be collected',HO,'        if (key.hooks != guard) revert UnknownProject();\n','',False,HOL),
('H04','LiquidityHolder: the platform gets all the dollar fees',HO,'        uint256 toPlatform = dollars / 2;','        uint256 toPlatform = dollars;',False,HOL),
('H05','LiquidityHolder: the project gets nothing of the dollar fees',HO,'            ITreasuryFinish(treasury).topUp(toProject);\n','',False,HOL),
('H06','LiquidityHolder: the Share fees are kept, not burned',HO,'        if (sharesBurned != 0) IShares(sharesToken).burn(sharesBurned);\n','',False,HOL),
('H07','LiquidityHolder: a platform address the token refuses stops the whole collect',HO,'        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {\n            owed[token][to] += amount;\n            emit Owed(token, to, amount);\n        }','        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert NotHeld();',False,HOL),
('H08','LiquidityHolder: a collect takes out liquidity (a decrease of one unit)',HO,'params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));','params[0] = abi.encode(tokenId, uint256(1), uint128(0), uint128(0), bytes(""));',False,HOL),
('H09','LiquidityHolder: no re-entry lock',HO,'        if (_locked) revert Reentrancy();','',False,HOL),
('H10','LiquidityHolder: owed amounts are paid out and not cleared',HO,'        owed[token][to] = 0;\n','',False,HOL),
('X01','Treasury: anybody may mark the sale abandoned',T,'function markAbandoned() external nonReentrant {\n        if (msg.sender != opener) revert NotAllowed();','function markAbandoned() external nonReentrant {',False,TAB),
('X02','Treasury: a sale may be abandoned after the pool opened',T,'        if (msg.sender != opener) revert NotAllowed();\n        if (poolOpen) revert PoolAlreadyOpen();\n        (poolOpen, abandoned) = (true, true);','        if (msg.sender != opener) revert NotAllowed();\n        (poolOpen, abandoned) = (true, true);',False,TAB),
('X03','Treasury: anybody may put sale money wholly into the floor',T,'        if (msg.sender != opener) revert NotAllowed();\n        if (!abandoned) revert NotAbandoned();','        if (!abandoned) revert NotAbandoned();',False,TAB),
('X04','Treasury: money may be put wholly into the floor when the sale was not abandoned',T,'        if (!abandoned) revert NotAbandoned();\n','',False,TAB),
('X05','Treasury: more than arrived may be put into the floor',T,'        if (amount > arrived) revert NotArrived(amount, arrived);\n        _accrue();\n        _addMelting(amount);','        _accrue();\n        _addMelting(amount);',False,TAB),
('X06','Treasury: an abandoned sale does not start the Vester\'s clock',T,'        (poolOpen, abandoned) = (true, true);\n        vester.startNow();','        (poolOpen, abandoned) = (true, true);',False,TAB),
]
MUT+=M3

status = '' if PRISTINE else subprocess.run(['git', 'status', '--porcelain', 'src'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
if status:
    sys.exit('src/ has uncommitted changes; commit or stash them first:\n' + status)

def run(extra,suites=None):
    subprocess.run('find cache/fuzz cache/invariant -type f -delete 2>/dev/null',shell=True,cwd=ROOT)
    cmd=['forge','test','--no-match-path',M1]+extra if not suites else ['forge','test','--match-path',suites]+extra
    p=subprocess.run(cmd,cwd=ROOT,env=ENV,capture_output=True,text=True)
    out=p.stdout+p.stderr
    fails=[]
    for line in out.splitlines():
        if line.startswith('[FAIL'):
            m=re.findall(r'\] (\w+)\(',line)
            inv=re.findall(r'(invariant_\w+)',line)
            if inv: fails.append(inv[0])
            elif m: fails.append(m[-1])
    for line in out.splitlines():
        m2=re.match(r'^\s+(invariant_\w+)\(\) \(runs',line)
        if m2: fails.append(m2.group(1))
    total=re.findall(r'Encountered a total of (\d+) failing',out)
    comp='Compiler run failed' in out
    return sorted(set(fails)),comp,out,total
sel=[a for a in sys.argv[1:] if not a.startswith('--')]
only_m3='--m3' in sys.argv
shard=[a for a in sys.argv[1:] if a.startswith('--shard=')]
k,n=(int(x) for x in shard[0][8:].split('/')) if shard else (0,1)
pos=-1
for entry in MUT:
    (i,desc,f,old,new,inv)=entry[:6]
    suites=entry[6] if len(entry)>6 else None
    if sel and i not in sel: continue
    if only_m3 and i[0] not in 'FAHPX': continue
    if os.environ.get('M2_ONLY') and i[0] in 'FAHPX': continue
    if os.environ.get('M2_ONLY') and not suites: suites=M2SUITES
    pos+=1
    if pos%n!=k: continue
    path=os.path.join(ROOT,f)
    src=open(path).read()
    if src.count(old)!=1:
        print(json.dumps({'inv_only':bool(os.environ.get('INV_ONLY')),'id':i,'error':'old string count %d'%src.count(old)}),flush=True); continue
    open(path,'w').write(src.replace(old,new))
    try:
        extra=['--match-contract','Invariants'] if os.environ.get('INV_ONLY') else ['--no-match-contract','Invariants']
        fails,comp,out,total=run(extra,suites)
    finally:
        if PRISTINE: shutil.copyfile(os.path.join(PRISTINE,f),path)
        else: subprocess.run(['git','checkout','--',f],cwd=ROOT,check=True)
    print(json.dumps({'inv_only':bool(os.environ.get('INV_ONLY')),'id':i,'what':desc,'compile_failed':comp,'failed':fails if os.environ.get('SHOW') else fails[:8],'n':len(fails),'total_failing_reported':total}),flush=True)
