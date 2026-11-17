#!/usr/bin/env python3
"""Remove one guard at a time from the milestone 2 and 3 sources and check that a test fails (a "mutation run").

    python3 scripts/mutate-guards.py            # every removal, unit/fuzz/attack suites (about 75 seconds each)
    python3 scripts/mutate-guards.py T09 L03    # only these ids
    python3 scripts/mutate-guards.py --m3       # only the milestone 3 entries (their ids start with F, A, H, P, X, E or B)
    python3 scripts/mutate-guards.py --m4       # only the plan version 2 milestone 4 entries (their ids start with N)
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
('T06', 'Treasury: settle may split more than arrived', T, '        if (amount > arrived) revert NotArrived(amount, arrived);\n        _accrue();\n        uint256 toSpendable = amount * spendableParts', '        _accrue();\n        uint256 toSpendable = amount * spendableParts', False),
('T07','Treasury: settle ratio is not 15:60',T,'amount * spendableParts / (spendableParts + floorParts)','amount * spendableParts / (spendableParts + floorParts) * 2',True),
('T08', 'Treasury: any settle renews the check-in window', T, 'if (!settled) {\n            rounds.sync();\n            (settled, accruedUpTo, lastCheckIn) = (true, block.timestamp, block.timestamp);\n        }', 'rounds.sync(); settled = true; accruedUpTo = block.timestamp; lastCheckIn = block.timestamp;', False),
('T09','Treasury: hand back before the sale money is split',T,'if (!settled) revert NotSettled();','',False),
('T10','Treasury: the Vester counts in the exit denominator (its whole balance leaves the count, claimed or not)',T,' - vester.unreleased();',' - shares.balanceOf(address(vester));',True),
('T11', 'Treasury: the Treasury counts in the exit denominator', T, 'return shares.totalSupply() - shares.balanceOf(address(this)) - shares.balanceOf(address(rounds))', 'return shares.totalSupply() - shares.balanceOf(address(rounds))', True),
('T12', 'Treasury: the exit slice reaches spendable', T, 'uint256 slice = fromMelting + fromPermanent;', 'uint256 slice = fromMelting + fromPermanent + spendable * amount / counting;', True),
('T13', 'Treasury: no exit fee', T, 'paid = slice - (slice * feeBps + BPS - 1) / BPS;', 'paid = slice;', True),
('T14', 'Treasury: exit fee rounds down', T, '(slice * feeBps + BPS - 1) / BPS', '(slice * feeBps) / BPS', False),
('T15','Treasury: the platform part of the fee is not recorded',T,'        feesOwed += toPlatform;\n','',True),
('T16','Treasury: an exit does not burn the Shares',T,'        shares.burnFrom(msg.sender, amount);\n','',True),
('T17','Treasury: an exit does not first work out the daily release',T,'        if (amount == 0) revert BadInput();\n        _accrue();\n        uint256 counting','        if (amount == 0) revert BadInput();\n        uint256 counting',False),
('T18','Treasury: the release ignores the check-in window',T,'uint256 upto = block.timestamp < end ? block.timestamp : end;','uint256 upto = block.timestamp; end;',False),
('T19', 'Treasury: anyone (an agent too) may check in', T, 'if (msg.sender != runner) revert NotAllowed();\n        _sync();\n        lastCheckIn', '_sync();\n        lastCheckIn', False),
('T20','Treasury: an agent spends with no daily cap',T,'_agentUsd[msg.sender].consume(DAY, DAY_PARTS, a.usdCap, amount);','',False),
('T21','Treasury: spend does not stop at spendable (error kind)',T,'if (amount > spendable) revert TooMuch(amount, spendable);','',False),
('T22','Treasury: an agent gives Shares with no daily cap',T,'_agentShares[msg.sender].consume(DAY, DAY_PARTS, a.shareCap, amount);','',False),
('T23', 'Treasury: no monthly cap on gifts after the pool', T, '_gifts.consume(MONTH, MONTH_PARTS, countingSupply() * GIFT_CAP_BPS / BPS, amount);', '', True),
('T24','Treasury: gifts before the pool go straight to the person',T,'if (poolOpen) {\n            _gifts','if (true) {\n            _gifts',False),
('T25','Treasury: the work pot may be overdrawn (error kind)',T,'if (amount > workPot) revert WorkPotShort(amount, workPot);','',False),
('T26', 'Treasury: anyone may take the reserve out', T, 'function releaseReserve(address to, uint256 amount) external nonReentrant {\n        if (msg.sender != salePath) revert NotAllowed();', 'function releaseReserve(address to, uint256 amount) external nonReentrant {', True),
('T27', 'Treasury: anyone may set agents', T, '        if (msg.sender != runner) revert NotAllowed();\n        if (agent == address(0)) revert BadInput();', '        if (agent == address(0)) revert BadInput();', False),
('T28', 'Treasury: anyone may switch agents off', T, '        if (msg.sender != runner) revert NotAllowed();\n        agents[agent].active = false;', '        agents[agent].active = false;', False),
('T29','Treasury: an outgoing token fee is not noticed',T,'if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();','',False),
('T30','Treasury: a pulled amount is credited as asked, not as received',T,'got = quote.balanceOf(address(this)) - before;','got = amount;',False),
('T31','Treasury: fees are swept to the caller',T,'_pay(platform, owed);','_pay(msg.sender, owed);',False),
('T32','Treasury: fees owed count as new money',T,'uint256 accounted = spendable + melting + permanentFloor + feesOwed;','uint256 accounted = spendable + melting + permanentFloor;',False),
('T33','Treasury: a second sale restarts the clock at a year',T,'meltRemaining = m == 0 ? RELEASE_PERIOD : (m * meltRemaining + toFloor * RELEASE_PERIOD) / (m + toFloor);','meltRemaining = RELEASE_PERIOD;',False),
('T34','Treasury: release is a share of the original deposit, not of what is left',T,'return (m * active / remaining, remaining - active);','return (m * active / RELEASE_PERIOD, remaining - active);',False),
('T35','Treasury: gifts to the Vester address are allowed',T,'|| to == address(vester) ||','||',False),
('T36','Treasury: more than the counting supply may be handed back (error kind)',T,'if (amount > counting) revert TooMuch(amount, counting);','',False),
('T37','Treasury: a hand back that pays nothing still burns',T,'if (paid == 0) revert NothingToPay();','',False),
('T38', 'Treasury: the exit takes nothing from the Share revenue', T, 'uint256 fromPermanent = permanentFloor * amount / shares.totalSupply();', 'uint256 fromPermanent = 0;', False),
('T39','Treasury: shareRevenue goes to the melting floor',T,'permanentFloor += got;\n        emit ShareRevenue','melting += got;\n        emit ShareRevenue',False),
('T40','Treasury birth check: an exit fee of 100% or more is accepted',T,'|| s.exitFeeBps >= BPS ||','||',False),
('V01','Vester: anyone may start the clock',V,'if (msg.sender != starter) revert NotAllowed();','',False),
('V02','Vester: the clock may be started twice',V,'if (start != 0) revert WrongPhase();\n        start = block.timestamp;','start = block.timestamp;',False),
('V03', 'Vester: plain grants may be added after the clock started', V, 'if (msg.sender != granter) revert NotAllowed();\n        if (start != 0) revert WrongPhase();\n        if (beneficiary', 'if (msg.sender != granter) revert NotAllowed();\n        if (beneficiary', False),
('V04','Vester: a grant needs no Shares behind it',V,'if (shares.balanceOf(address(this)) < committed + amount) revert NotFunded();','',False),
('V05','Vester: Shares release before the clock starts',V,'if (s == 0) return 0;','if (s == 0) s = 1;',False),
('V06','Vester: the release does not stop at the grant',V,'return elapsed >= DURATION ? total : total * elapsed / DURATION;','return total * elapsed / DURATION;',False),
('V07','Vester: initialize may be called twice',V,'if (starter != address(0)) revert AlreadyInitialized();','',False),
('V08','Vester: a claim does not record what was claimed',V,'        grants[beneficiary].claimed += amount;\n','',False),
('V09', 'Vester: anyone may add grants', V, 'if (msg.sender != granter) revert NotAllowed();\n        if (start != 0) revert WrongPhase();\n        if (beneficiary', 'if (start != 0) revert WrongPhase();\n        if (beneficiary', False),
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
('L06','Launcher: the exit fee ceiling is not checked',L,' || s.exitFeeBps > MAX_EXIT_FEE_BPS','',False),
('L09','Launcher: the founder allocation is 190M not 200M',L,'uint256 public constant FOUNDER = 200_000_000e18;','uint256 public constant FOUNDER = 190_000_000e18;',False),


('L07','Launcher: the platform part may exceed the whole fee',L,'|| s.platformFeeBps > s.exitFeeBps','',False),
('L10','Launcher: the founder is the Launcher, not the caller',L,'                    founder: msg.sender,','                    founder: address(this),',False),
('T41','Treasury: the reserve ignores Shares returned or donated to it',T,'return shares.balanceOf(address(this)) - workPot;','return 100_000_000e18;',False),
('T29b','Treasury: raw transfer, no balance measurement on the way out (both layers)',T,'quote.safeTransfer(to, amount);\n        uint256 afterBal = quote.balanceOf(address(this));\n        if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();','quote.transfer(to, amount);',False),
('T30b','Treasury: raw transferFrom, no arrival check on the way in (both layers)',T,'quote.safeTransferFrom(msg.sender, address(this), amount);\n        got = quote.balanceOf(address(this)) - before;\n        if (got == 0) revert TokenMisbehaved();','quote.transferFrom(msg.sender, address(this), amount);\n        got = amount;',False),
('T42','Treasury birth check: a platform part above the whole fee is accepted',T,'|| s.platformFeeBps > s.exitFeeBps ||','||',False),
('T43', 'Treasury: a check-in does not first work out the release', T, '_sync();\n        lastCheckIn = block.timestamp;', 'rounds.sync();\n        lastCheckIn = block.timestamp;', False),
('T44','Treasury: spend does not work out the release first',T,'        _accrue();\n        if (amount > spendable)','        if (amount > spendable)',False),
('T45', "Treasury: the exit fee's 4 stays in the floor (milestone 2's rule; B2 comes back)", T, '        melting -= fromMelting;\n        spendable += toProject;', '        melting -= fromMelting - toProject;', True),
('T46', 'Treasury: an exit pays twice its slice', T, 'uint256 slice = fromMelting + fromPermanent;', 'uint256 slice = (fromMelting + fromPermanent) * 2;', False),
('T47','Treasury: the platform part is recorded twice',T,'feesOwed += toPlatform;','feesOwed += toPlatform * 2;',False),
('T48','Treasury: spend lets spendable fall below zero silently',T,'if (amount > spendable) revert TooMuch(amount, spendable);\n        spendable -= amount;','spendable = spendable > amount ? spendable - amount : 0;',False),
# ---- milestone 2 review round (fix round)
('T49', 'Treasury: hand back before the sale is closed (unsold Shares count as held)', T, 'if (!saleClosed || reserveSaleOpen) revert SaleNotClosed();', 'if (reserveSaleOpen) revert SaleNotClosed();', False),
('T50','Treasury: anybody may mark the sale closed',T,'        if (msg.sender != opener) revert NotAllowed();\n        if (!poolOpen) revert NoPool();\n        if (saleClosed)','        if (!poolOpen) revert NoPool();\n        if (saleClosed)',False),
('T51','Treasury: the sale may be marked closed before the pool is proven',T,'        if (!poolOpen) revert NoPool();\n        if (saleClosed)','        if (saleClosed)',False),
('T52','Treasury: the sale may be marked closed twice',T,'if (saleClosed) revert SaleAlreadyClosed();','',False),
('T53','Treasury birth check: no ceiling on the spendable part of the split',T,'|| s.spendableParts > MAX_SPLIT_PART','',False),
('T54','Treasury birth check: no ceiling on the floor part of the split',T,'|| s.floorParts > MAX_SPLIT_PART','',False),
('V10', 'Vester: unreleased is nothing before the clock starts', V, 'uint256 g = granted;\n        return g - _released(g);', 'uint256 g = granted;\n        return start == 0 ? 0 : g - _released(g);', False),
('V11', 'Vester: unreleased does not fall with time', V, 'uint256 g = granted;\n        return g - _released(g);', 'uint256 g = granted;\n        return start != 0 && block.timestamp - start >= DURATION ? 0 : g;', False),
('V12','Vester: unreleased forgets what was granted',V,'        granted += amount;\n','',False),
('V13', 'Vester: unreleased falls with claims (the old denominator)', V, 'uint256 g = granted;\n        return g - _released(g);', 'uint256 g = committed;\n        return g - _released(g);', False),
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
LAU='test/{Launcher,SaleRules,Life,AttackM2,PairStages}.t.sol'
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
('A11', 'Launcher: the bid hook may be no contract', L, 'strategy_.code.length == 0 || minBid_.code.length == 0) {', 'strategy_.code.length == 0) {', False, LAU),
('A12', 'Launcher: the Treasury trusts the founder as its opener', L, '                    opener: p.finisher,', '                    opener: msg.sender,', False, LAU),
('A13','Launcher: the Treasury trusts the founder as its sale path',L,'                    salePath: address(this),','                    salePath: msg.sender,',False,LAU),
('A14', 'Launcher: the sale Shares are minted to the Launcher, not the Finisher', L, '(to[0], amounts[0]) = (p.finisher, SALE + POOL_RESERVE);', '(to[0], amounts[0]) = (address(this), SALE + POOL_RESERVE);', False, LAU),
('A15','Launcher: the holder cannot tell which Treasury a project\'s Shares belong to',L,'        treasuryOfShares[shares] = treasury;\n','',False,LAU),
('A16','Launcher: the sale raises the current dollar setting, not the project\'s own (strategy side)',L,'currency: address(Treasury(p.treasury).quote()),\n            migrationBlock','currency: address(settings.quote),\n            migrationBlock',False,LAU),
('A17', "Launcher: the sale raises the current dollar setting, not the project's own (auction side)", L, '_auctionParams(address(t.quote()), p.finisher', '_auctionParams(address(settings.quote), p.finisher', False, LAU),
('A18','Launcher: the pool position goes to the Finisher, not the LiquidityHolder',L,'            positionRecipient: holder,','            positionRecipient: p.finisher,',False,LAU),
('A19','Launcher: what the pool leaves goes to the founder',L,'            recipient: p.finisher,\n            positionRecipient','            recipient: msg.sender,\n            positionRecipient',False,LAU),
('A20', 'Launcher: the unsold Shares go to the runner', L, 'address(t.quote()), p.finisher, strategy, AUCTION_MINIMUM', 'address(t.quote()), msg.sender, strategy, AUCTION_MINIMUM', False, LAU),
('A21','Launcher: no bid rules',L,'            validationHook: minBid,','            validationHook: address(0),',False,LAU),
('A22','Launcher: the pool has no guard',L,'tickSpacing: SaleParams.POOL_TICK_SPACING, hook: poolGuard','tickSpacing: SaleParams.POOL_TICK_SPACING, hook: address(0)',False,LAU),
('A23','Launcher: the pool is reserved half the Shares',L,'reservedTokenAmountForLP: SaleParams.POOL_SHARES,','reservedTokenAmountForLP: SaleParams.POOL_SHARES / 2,',False,LAU),
('A24','Launcher: the pool step may run later than the first block after the sale',L,'migrationBlock: endBlock_ + 1,','migrationBlock: endBlock_ + 5,',False,LAU),
('A25','Launcher: bidders may claim later than the first block after the sale',L,'claimBlock: startBlock + SaleParams.SALE_BLOCKS + 1,','claimBlock: startBlock + SaleParams.SALE_BLOCKS + 2,',False,LAU),
('A26', "Launcher: the auction's minimum is 90,000 dollars", L, 'uint256 public constant AUCTION_MINIMUM = 100_000e6;', 'uint256 public constant AUCTION_MINIMUM = 90_000e6;', False, LAU),
('A29', 'Launcher: the floor price is rounded down to the tick', L, 'tickQ96 = (exactQ96 + TICKS_IN_FLOOR - 1) / TICKS_IN_FLOOR;', 'tickQ96 = exactQ96 / TICKS_IN_FLOOR;', False, LAU),
('A30', 'Launcher: the sale starts in the block it is opened', L, 'uint64 startBlock = uint64(block.number + 1);\n        uint64 endBlock_', 'uint64 startBlock = uint64(block.number);\n        uint64 endBlock_', False, LAU),
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

# ---- the milestone 3 fix round: the closing window, "this sale's pool", the events the server reads, the false-answering token.
# E = an event is no longer emitted (`emit X(` becomes `abi.encode(`, which keeps the arguments and drops the event), B = MinBid.
MB='src/MinBid.sol'; TR='src/Treasury.sol'
AM3='test/AttackM3.t.sol'
EVT='test/{FinishEvents,LiquidityHolder}.t.sol'
WIN='test/{SaleRules,Launcher,AttackM3}.t.sol'
M3+=[
('F33','Finisher: a pool the pool step did not fund counts as this sale\'s pool (the fake pool after a failed step)',FI,'return settled || (poolAtTheKey() && _poolTookTheMoney());','return settled || poolAtTheKey();',False,'test/{AttackM3,FinishAttacks}.t.sol'),
('F34','Finisher: a pool that took only 5 of each 100 dollars of its budget counts',FI,'MIN_TAKEN_PERCENT = 50;','MIN_TAKEN_PERCENT = 5;',False,AM3),
('F35','Finisher: after the sale is done the pool is not reported open',FI,'        if (s == Stage.Done) return true;\n','',False,'test/{AttackM3,FinishAttacks,Life}.t.sol'),
('F36','Finisher: after step 2 the pool is judged by the dollars held again (a gift can reopen the way out)',FI,'return settled || (poolAtTheKey()','return (poolAtTheKey()',False,AM3),
('A31','Launcher: the bid hook may have any closing window',L,'\n                || IPinnedMinBid(minBid_).closingBlocks() != BID_CLOSING_BLOCKS','',False,'test/Launcher.t.sol'),
('B01','MinBid: bids are accepted in the closing window',MB,'            if (block.number + closingBlocks > end) {\n                revert BidTooLate(block.number, end > closingBlocks ? end - closingBlocks : 0);\n            }\n','',False,WIN),
('B02','MinBid: the window is one block short',MB,'if (block.number + closingBlocks > end)','if (block.number + closingBlocks > end + 1)',False,WIN),
('H11','LiquidityHolder: a guarded pool of a stranger\'s own token may be collected',HO,'        if (treasury == address(0)) revert UnknownProject();\n','',False,'test/LiquidityHolder.t.sol'),
('H12','LiquidityHolder: a token that answers false counts as paid',HO,'if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {','if (!ok) {',False,'test/LiquidityHolder.t.sol'),
('E01','Launcher: SaleOpened is not emitted',L,'        emit SaleOpened(','        abi.encode(',False,EVT),
('E02','Finisher: SaleOpenedBy is not emitted',FI,'        emit SaleOpenedBy(','        abi.encode(',False,EVT),
('E03','Finisher: PoolStep is not emitted',FI,'        emit PoolStep(','        abi.encode(',False,EVT),
('E04','Finisher: PoolOpened is not emitted',FI,'        emit PoolOpened(','        abi.encode(',False,EVT),
('E05','Finisher: Settled is not emitted',FI,'        emit Settled(','        abi.encode(',False,EVT),
('E06','Finisher: Swept is not emitted by sweep',FI,'        emit Swept(address(a), held);','        abi.encode(address(a), held);',False,EVT),
('E07','Finisher: Swept is not emitted by abandon',FI,'        emit Swept(address(a), sharesBack);','        abi.encode(address(a), sharesBack);',False,EVT),
('E08','Finisher: SaleFailed is not emitted',FI,'            emit SaleFailed(','            abi.encode(',False,EVT),
('E09','Finisher: Abandoned is not emitted',FI,'        emit Abandoned(','        abi.encode(',False,EVT),
('E10','LiquidityHolder: Collected is not emitted',HO,'        emit Collected(','        abi.encode(',False,EVT),
('E11','LiquidityHolder: Owed is not emitted',HO,'            emit Owed(','            abi.encode(',False,EVT),
('E12','LiquidityHolder: OwedSent is not emitted',HO,'        emit OwedSent(','        abi.encode(',False,EVT),
('E13','Treasury: PoolOpened is not emitted',TR,'        emit PoolOpened(','        abi.encode(',False,EVT),
('E14','Treasury: SaleAbandoned is not emitted',TR,'        emit SaleAbandoned(','        abi.encode(',False,EVT),
('E15','Treasury: SaleClosed is not emitted',TR,'        emit SaleClosed(','        abi.encode(',False,EVT),
('E16','Treasury: the floor-only Settled is not emitted',TR,'        emit Settled(amount, 0, amount);','        abi.encode(amount, 0, amount);',False,EVT),
('E17','Treasury: Settled is not emitted by settle',TR,'        emit Settled(amount, toSpendable, toFloor);','        abi.encode(amount, toSpendable, toFloor);',False,EVT),
]
MUT+=M3
# ---------------------------------------------------------------- plan version 2, milestone 4 (ids N..): run with --m4
RO='src/Rounds.sol'; PA='src/Pair.sol'; MB='src/MinBid.sol'
M4R='test/{Rounds,RoundsFuzz,RoundsWorked,RoundsReentry,PairStages}.t.sol'
M4V='test/{Vester,VesterHeld,Rounds,RoundsWorked,PairStages,AttackM2,TreasuryActions}.t.sol'
M4T='test/{Treasury,TreasuryActions,TreasuryEdges,TreasuryAttacks,TreasuryFuzz,TreasuryAbandon,TreasurySeams,AttackM2,Rounds,RoundsWorked,RoundsReentry,PairStages}.t.sol'
M4TA='test/{TreasurySeams,AuctionV2}.t.sol'  # the reserve sale's money and exits are tested on the real auction
M4L='test/{Launcher,PairStages,Rounds,RoundsWorked,AuctionV2}.t.sol'
M4P='test/{PairStages,RoundsWorked}.t.sol'
M4B='test/{MarketAttacks,SaleRules,Pieces}.t.sol'
M4X='test/{Rounds,RoundsWorked,RoundsReentry,PairStages,Vester,VesterHeld,Launcher,AuctionV2,TreasurySeams,PlanV2M4Fixes,AttackPlanV2M4}.t.sol'  # the review's entries
M4=[
# Rounds
('N01','Rounds: anyone may open a round',RO,'if (msg.sender != launcher) revert NotAllowed();\n        if (isOpen()','if (isOpen()',False,M4R),
('N02','Rounds: a round may open while another is open',RO,'if (isOpen() || size < MIN_ASK','if (size < MIN_ASK',False,M4R),
('N03','Rounds: a round may be larger than the Shares left',RO,' || size * SHARES_PER_RAW_DOLLAR > unsold()','',False,M4R),
('N04','Rounds: asks are taken after the 24 hours',RO,'if (r.openedAt == 0 || block.timestamp >= r.openedAt + WINDOW) revert WrongPhase();','if (r.openedAt == 0) revert WrongPhase();',False,M4R),
('N05','Rounds: an ask under 1 dollar is taken',RO,'if (amount == 0 || total < MIN_ASK) revert BadAmount();','if (amount == 0) revert BadAmount();',False,M4R),
('N06','Rounds: a dollar token that delivers less is not noticed',RO,'if (quote.balanceOf(address(this)) - before != amount) revert TokenMisbehaved();','',False,M4R),
('N07','Rounds: asks may be lowered after the 12th hour',RO,'block.timestamp >= r.openedAt + LOWER_WINDOW','false',False,M4R),
('N08','Rounds: an ask may be lowered to under 1 dollar',RO,' || (total != 0 && total < MIN_ASK)','',False,M4R),
('N09','Rounds: a round may close before 24 hours',RO,'r.closedAt != 0 || block.timestamp < r.openedAt + WINDOW','r.closedAt != 0',False,M4R),
('N10','Rounds: a round may close twice',RO,' || r.closedAt != 0 || block.timestamp < r.openedAt + WINDOW',' || block.timestamp < r.openedAt + WINDOW',False,M4R),
('N11','Rounds: a round accepts more than its size',RO,'uint256 accepted = r.asked < r.size ? r.asked : r.size;','uint256 accepted = r.asked;',False,M4R),
('N12','Rounds: accepted money does not count against the cap',RO,'        raised += accepted;\n','',False,M4R),
('N13','Rounds: no scale-back',RO,'uint256 acc = r.asked <= r.size ? askd : askd * r.accepted / r.asked;','uint256 acc = askd;',False,M4R),
('N14','Rounds: a backer may be settled twice',RO,'if (p.settled || askd == 0) revert WrongPhase();','if (askd == 0) revert WrongPhase();',False,M4R),
('N15','Rounds: a backer may be settled before the close',RO,'        if (r.closedAt == 0) revert WrongPhase();\n        Position storage p = _positions[id][backer];\n        uint256 askd','        Position storage p = _positions[id][backer];\n        uint256 askd',False,M4R),
('N16','Rounds: the platform takes 30 instead of 3',RO,'uint256 toPlatform = acc * PLATFORM_BPS / BPS;','uint256 toPlatform = acc * PLATFORM_BPS * 10 / BPS;',False,M4R),
('N17','Rounds: nothing is held, all goes to the project at once',RO,'uint256 held_ = acc * HELD_BPS / BPS;','uint256 held_ = 0;',False,M4R),
('N18','Rounds: bought Shares go straight to the backer, not held',RO,'if (!shares.transfer(address(vester), bought)) revert TokenMisbehaved();\n            vester.grantHeld(id, backer, bought);','if (!shares.transfer(backer, bought)) revert TokenMisbehaved();',False,M4R),
('N19','Rounds: 6,000 Shares a dollar',RO,'uint256 bought = acc * SHARES_PER_RAW_DOLLAR;','uint256 bought = acc * SHARES_PER_RAW_DOLLAR * 2;',False,M4R),
('N20','Rounds: the held money is released at once',RO,'uint256 due = r.held * _elapsed(r) / RELEASE + r.frozen;','uint256 due = r.held + r.frozen;',False,M4R),
('N21','Rounds: time outside the check-in window counts',RO,'uint256 upto = block.timestamp < end ? block.timestamp : end;','uint256 upto = block.timestamp; end;',False,M4R),
('N22','Rounds: a release is not recorded (paid again)',RO,'        _rounds[id].paidOut += amount;\n','',False,M4R),
('N23','Rounds: a refund ignores the release (the whole held money back)',RO,'uint256 released_ = _releasedUp(part, _elapsed(r));','uint256 released_ = 0;',False,M4R),
('N24','Rounds: a refund has no fee',RO,'uint256 fee = (unreleased_ * feeBps + BPS - 1) / BPS;','uint256 fee = 0;',False,M4R),
('N25','Rounds: the refund fee rounds down',RO,'uint256 fee = (unreleased_ * feeBps + BPS - 1) / BPS;','uint256 fee = (unreleased_ * feeBps) / BPS;',False,M4R),
('N26','Rounds: a refund leaves the held Shares in place',RO,'(uint256 cancelled,) = vester.cancelHeld(id, msg.sender);','uint256 cancelled;',False,M4R),
('N27','Rounds: after the market a refund covers Shares already taken out',RO,'uint256 part = still == total ? p.held : p.held * still / total;\n        uint256 released_','uint256 part = p.held;\n        uint256 released_',False,M4R),
('N28','Rounds: a refund does not lower the round\'s held money',RO,'(r.held, r.frozen, p.held) = (r.held - part, r.frozen + released_, p.held - part);','(r.frozen, p.held) = (r.frozen + released_, p.held - part);',False,M4R),
('N29','Rounds: a refund\'s released part rounds down (the fuzz finding: a unit paid twice)',RO,'return (part * elapsed + RELEASE - 1) / RELEASE;','return part * elapsed / RELEASE;',False,M4R),
('N30','Rounds: the whole refund fee goes to the platform',RO,'uint256 toPlatform = woundDown ? fee : unreleased_ * REFUND_PLATFORM_BPS / BPS;','uint256 toPlatform = fee;',False,M4R),
('N31','Rounds: after a wind-down the refund fee stays 5',RO,'uint256 feeBps = woundDown ? REFUND_PLATFORM_BPS : REFUND_FEE_BPS;\n        uint256 fee','uint256 feeBps = REFUND_FEE_BPS;\n        uint256 fee',False,M4R),
('N32','Rounds: anyone may wind the Rounds down',RO,'if (msg.sender != address(treasury)) revert NotAllowed();\n        woundDown = true;','woundDown = true;',False,M4R),
('N33','Rounds: unsold Shares may leave before any market',RO,'if (!treasury.poolOpen() && !treasury.woundDown()) revert WrongPhase();','',False,M4R),
('N34','Rounds: unsold includes the Shares owed to accepted asks',RO,'return shares.balanceOf(address(this)) - reserved;','return shares.balanceOf(address(this));',False,M4R),
('N35','Rounds: initialize may be called again',RO,'if (launcher != address(0) || launcher_ == address(0)) revert BadSetup();','if (launcher_ == address(0)) revert BadSetup();',False,M4R),
('N36','Rounds: no re-entrancy lock',RO,'if (_locked) revert Reentrancy();','',False,M4R),
('N37','Rounds: fees are swept to the caller',RO,'_send(platform, owed);','_send(msg.sender, owed);',False,M4R),
# Vester
('N40','Vester: anyone may add a backer grant',V,'if (msg.sender != rounds) revert NotAllowed();\n        if (backer == address(0)) revert BadGrant();','if (backer == address(0)) revert BadGrant();',False,M4V),
('N41','Vester: anyone may cancel a backer grant',V,'if (msg.sender != rounds) revert NotAllowed();\n        Grant storage g = heldGrants','Grant storage g = heldGrants',False,M4V),
('N42','Vester: a cancel takes back Shares already claimed',V,'cancelled = total - g.claimed;','cancelled = total;',False,M4V),
('N43','Vester: a cancelled grant stays on the clock (unreleased overcounted)',V,'granted -= total; //','granted -= 0; //',False,M4V),
('N44','Vester: a grant may be cancelled with nothing held',V,'if (cancelled == 0) revert NothingHeld();','',False,M4V),
('N45','Vester: anyone may trim the founder',V,'if (msg.sender != granter) revert NotAllowed();\n        if (start != 0 || trimmed) revert WrongPhase();','if (start != 0 || trimmed) revert WrongPhase();',False,M4V),
('N46','Vester: the founder may be trimmed after the clock started',V,'if (start != 0 || trimmed) revert WrongPhase();','if (trimmed) revert WrongPhase();',False,M4V),
('N47','Vester: a trimmed founder keeps nothing',V,'uint256 keep = served >= DURATION ? amount : amount * served / DURATION;','uint256 keep = 0;',False,M4V),
('N48','Vester: a backer grant is claimable before its release',V,'Grant memory g = heldGrants[round][backer];\n        uint256 r = _released(g.total);','Grant memory g = heldGrants[round][backer];\n        uint256 r = g.total;',False,M4V),
# Treasury
('N51','Treasury: a check-in does not work out the Rounds\' clock first',T,'_sync();\n        lastCheckIn = block.timestamp;','_accrue();\n        lastCheckIn = block.timestamp;',False,M4T),
('N52','Treasury: anyone may offer the runner seat',T,'function handOver(address next, bool founderLeaves) external onlyRunner {','function handOver(address next, bool founderLeaves) external {',False,M4T),
('N53','Treasury: anyone may take the runner seat',T,'if (msg.sender != pendingRunner || msg.sender == address(0)) revert NotAllowed();','',False,M4T),
('N54','Treasury: a hand-over leaves the old runner\'s agents working',T,'        ++agentEpoch;\n','',False,M4T),
('N55','Treasury: the trimmed Shares do not return to the work pot',T,'            workPot += cut;\n','',False,M4T),
('N56','Treasury: anyone may pause',T,'if (msg.sender != pauser || msg.sender == address(0)) revert NotAllowed();','',False,M4T),
('N57','Treasury: a pause does not stop the release',T,'if (paused || woundDown) return 0;','if (woundDown) return 0;',False,M4T),
('N58','Treasury: anyone may name the pauser',T,'function setPauser(address next) external {\n        if (msg.sender != salePath) revert NotAllowed();','function setPauser(address next) external {',False,M4T),
('N59','Treasury: anyone may wind the project down',T,'function markWoundDown() external nonReentrant {\n        if (msg.sender != salePath) revert NotAllowed();','function markWoundDown() external nonReentrant {',False,M4T),
('N60','Treasury: a wind-down does not stop the release',T,'if (paused || woundDown) return 0;','if (paused) return 0;',False,M4T),
('N61','Treasury: a wind-down does not reach the Rounds',T,'        rounds.windDown();\n','',False,M4T),
('N62','Treasury: after a wind-down the exit fee stays 5',T,'uint256 feeBps = woundDown ? platformFeeBps : exitFeeBps;','uint256 feeBps = exitFeeBps;',False,M4T),
('N63','Treasury: anyone may declare no market',T,'function markNoMarket() external nonReentrant {\n        if (msg.sender != salePath) revert NotAllowed();','function markNoMarket() external nonReentrant {',False,M4T),
('N64','Treasury: no market does not start the clock',T,'(poolOpen, noMarket) = (true, true);\n        vester.startNow();','(poolOpen, noMarket) = (true, true);',False,M4T),
('N65','Treasury: the stake is not granted (sent but not set aside)',T,'            vester.grant(stake, s);\n','',False,M4T),
('N67','Treasury: Share revenue is shared by the Shares in hands (B3 comes back)',T,'uint256 fromPermanent = permanentFloor * amount / shares.totalSupply();','uint256 fromPermanent = permanentFloor * amount / counting;',True,M4T),
('N68','Treasury: the gift cap is on all Shares (B3 comes back)',T,'_gifts.consume(MONTH, MONTH_PARTS, countingSupply() * GIFT_CAP_BPS / BPS, amount);','_gifts.consume(MONTH, MONTH_PARTS, shares.totalSupply() * GIFT_CAP_BPS / BPS, amount);',True,M4T),
('N69','Treasury: the Rounds\' Shares count as in hands',T,' - shares.balanceOf(address(rounds))','',True,M4T),
('N70','Treasury: the Finisher\'s Shares count as in hands',T,'\n            - shares.balanceOf(opener) - vester.unreleased();',' - vester.unreleased();',True,M4T),
('N71','Treasury: exits run while a reserve sale is out',T,'if (!saleClosed || reserveSaleOpen) revert SaleNotClosed();','if (!saleClosed) revert SaleNotClosed();',False,M4TA),
('N72','Treasury: a second reserve sale may start while one is out',T,'if (reserveSaleOpen) revert ReserveSaleState();\n        uint256 left','uint256 left',False,M4T),
('N73','Treasury: anyone may settle a reserve sale',T,'if (msg.sender != salePath) revert NotAllowed();\n        if (amount == 0) revert BadInput();\n        uint256 arrived','if (amount == 0) revert BadInput();\n        uint256 arrived',False,M4T),
('N74','Treasury: a reserve sale is all spendable',T,'uint256 toSpendable = amount * RESERVE_SPENDABLE_PARTS / (RESERVE_SPENDABLE_PARTS + RESERVE_FLOOR_PARTS);','uint256 toSpendable = amount;',False,M4TA),
('N75','Treasury: anyone may close a reserve sale',T,'function closeReserveSale() external nonReentrant {\n        if (msg.sender != salePath) revert NotAllowed();','function closeReserveSale() external nonReentrant {',False,M4T),
('N76','Treasury: the first settle does not work out the Rounds\' clock',T,'            rounds.sync();\n            (settled, accruedUpTo, lastCheckIn)','            (settled, accruedUpTo, lastCheckIn)',False,M4T),
('N77','Treasury: setAgent does not record the runner\'s epoch',T,'        agentEpochOf[agent] = agentEpoch;\n','',False,M4T),
('N78','Treasury: spend ignores the agent epoch',T,'if (!a.active || agentEpochOf[msg.sender] != agentEpoch) revert NotAllowed();\n            _agentUsd','if (!a.active) revert NotAllowed();\n            _agentUsd',False,M4T),
# Launcher
('N80','Launcher: anyone may act as the runner',L,'if (msg.sender != runner) revert NotRunner();','',False,M4L),
('N81','Launcher: a single founder may raise 50,000',L,'return runnerKind(runner) == RunnerKind.Single ? SOLO_CAP : TEAM_CAP;','return TEAM_CAP;',False,M4L),
('N82','Launcher: a round is sized to the whole cap, not what is left',L,'round = Rounds(p.rounds).open(cap - raised);','round = Rounds(p.rounds).open(cap);',False,M4L),
('N83','Launcher: no cap check before the round opens',L,'if (raised >= cap) revert CapReached(cap);','',False,M4L),
('N84','Launcher: rounds open after a market',L,'if (t.poolOpen() || t.woundDown() || Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();','if (t.woundDown() || Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();',False,M4L),
('N85','Launcher: a single founder may open the auction',L,'if (kind == RunnerKind.Single) revert WrongRunner(RunnerKind.Pair);','',False,M4L),
('N86','Launcher: the Council requirement is ignored',L,'if (requireCouncilForAuction && kind != RunnerKind.Council) revert WrongRunner(RunnerKind.Council);','',False,M4L),
('N87','Launcher: the Council requirement is off on every network',L,'requireCouncilForAuction = block.chainid != 31_337 && block.chainid != 11_155_111;','requireCouncilForAuction = false;',False,M4L),
('N88','Launcher: the auction opens while a round is open',L,' || Rounds(p.rounds).isOpen()) revert WrongStage();\n        (uint256 floorQ96',') revert WrongStage();\n        (uint256 floorQ96',False,M4L),
('N90','Launcher: no market may be declared at once',L,'if (block.timestamp < from) revert TooEarly(from);\n        t.markNoMarket();','t.markNoMarket();',False,M4L),
('N91','Launcher: no market counts from the launch even after a round',L,'(since == 0 ? p.launchedAt : since)','p.launchedAt',False,M4L),
('N92','Launcher: a Pair may wind down after a market',L,'if (market && !isCouncil[runner]) revert WrongRunner(RunnerKind.Council);','',False,M4L),
('N93','Launcher: any runner may open a reserve sale',L,'if (!isCouncil[_runner(t)]) revert WrongRunner(RunnerKind.Council);','_runner(t);',False,M4L),
('N94','Launcher: reserve sales need no 28 days between them',L,'if (block.number < lastEnd + RESERVE_SALE_GAP_BLOCKS) revert TooEarly(lastEnd + RESERVE_SALE_GAP_BLOCKS);','',False,M4L),
('N95','Launcher: a reserve sale may open before the market',L,'if (Finisher(p.finisher).stage() != Finisher.Stage.Done || t.woundDown()) revert WrongStage();','if (t.woundDown()) revert WrongStage();',False,M4L),
('N96','Launcher: a reserve sale starts at the first sale\'s starting price',L,'(uint256 floorQ96, uint256 tickQ96) = _floorAndTick(lastPrice);','(uint256 floorQ96, uint256 tickQ96) = salePrices();',False,M4L),
('N97','Launcher: anyone may register a Council',L,'if (msg.sender != councilMaker || council == address(0)) revert NotCouncilMaker();','if (council == address(0)) revert NotCouncilMaker();',False,M4L),
('N98','Launcher: anyone may name a pauser',L,'function setPauser(bytes32 key, address pauser) external {\n        if (msg.sender != councilMaker) revert NotCouncilMaker();','function setPauser(bytes32 key, address pauser) external {',False,M4L),
('N99','Launcher: a Pair it made is not marked as a Pair',L,'        isPair[pair] = true;\n','',False,M4L),
('NA0','Launcher: no stake',L,'                    stakeAmount: STAKE,','                    stakeAmount: 0,',False,M4L),
('NA1','Launcher: the backing Shares are minted to the Treasury',L,'(to[3], amounts[3]) = (p.rounds, BACKING);','(to[3], amounts[3]) = (treasury, BACKING);',False,M4L),
('NA2','Launcher: parts with no code are accepted',L,'shareImpl.code.length == 0 || treasuryImpl.code.length == 0 || vesterImpl.code.length == 0\n                || roundsImpl.code.length == 0 || pairImpl.code.length == 0','false',False,M4L),
('NA3','Launcher: the stake address may be zero',L,' || s.stake == address(0)','',False,M4L),
('NA4','Launcher: a finished reserve sale\'s money is not split',L,'            Treasury(p.treasury).settleReserveSale(got);\n','',False,M4L),
('NA5','Launcher: a finished reserve sale leaves exits closed',L,'        Treasury(p.treasury).closeReserveSale();\n','',False,M4L),
# Pair
('NP0','Pair: a signer alone spends with no weekly limit',PA,'_spent[msg.sender].consume(WINDOW, PARTS, ALONE_CAP, amount);','',False,M4P),
('NP1','Pair: anyone may act as a signer',PA,'if (msg.sender != first && msg.sender != second) revert NotAllowed();','',False,M4P),
('NP2','Pair: a signer may confirm their own proposal',PA,'if (by == msg.sender) revert NotAllowed();','',False,M4P),
('NP3','Pair: a proposal may run twice',PA,'        delete proposer[id];\n        bool ok;','        bool ok;',False,M4P),
('NP4','Pair: calls may go anywhere',PA,'if (target != address(treasury) && target != launcher) revert BadTarget();','',False,M4P),
('NP5','Pair: the two signers share one weekly limit',PA,'_spent[msg.sender].consume','_spent[first].consume',False,M4P),
('NP6','Pair: initialize may be called again',PA,'if (launcher != address(0) || msg.sender != launcher_) revert BadSetup();','if (msg.sender != launcher_) revert BadSetup();',False,M4P),
('NP7','Pair: the same person may be both signers',PA,' || first_ == second_','',False,M4P),
('NP8','Pair: anyone may cancel a proposal',PA,'if (proposer[id] != msg.sender) revert NotAllowed();\n        delete proposer[id];\n        emit Cancelled','delete proposer[id];\n        emit Cancelled',False,M4P),
# milestone 4 review (R1, R2, M4A-1): guards no entry covered, and the fixes' own guards
('NC0','Launcher: wind down while the auction runs (X1)',L,'if (Rounds(p.rounds).isOpen() || Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();\n        t.markWoundDown();','if (Rounds(p.rounds).isOpen()) revert WrongStage();\n        t.markWoundDown();',False,M4X),
('NC1','Launcher: wind down while a round is open',L,'if (Rounds(p.rounds).isOpen() || Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();\n        t.markWoundDown();','if (Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();\n        t.markWoundDown();',False,M4X),
('NC2','Launcher: no market while a round is open (X2)',L,' || Rounds(p.rounds).isOpen()) {\n            revert WrongStage();',') {\n            revert WrongStage();',False,M4X),
('NC3','Launcher: no market while the auction runs',L,'if (t.poolOpen() || Finisher(p.finisher).stage() == Finisher.Stage.Open || Rounds(p.rounds).isOpen()) {','if (t.poolOpen() || Rounds(p.rounds).isOpen()) {',False,M4X),
('NC4','Launcher: no market after a market (Launcher check)',L,'if (t.poolOpen() || Finisher(p.finisher).stage() == Finisher.Stage.Open || Rounds(p.rounds).isOpen()) {','if (Finisher(p.finisher).stage() == Finisher.Stage.Open || Rounds(p.rounds).isOpen()) {',False,M4X),
('NC5','Launcher: the auction opens after a wind-down (X4)',L,'if (t.poolOpen() || t.woundDown() || Rounds(p.rounds).isOpen()) revert WrongStage();','if (t.poolOpen() || Rounds(p.rounds).isOpen()) revert WrongStage();',False,M4X),
('NC6','Launcher: the auction opens after a market',L,'if (t.poolOpen() || t.woundDown() || Rounds(p.rounds).isOpen()) revert WrongStage();','if (t.woundDown() || Rounds(p.rounds).isOpen()) revert WrongStage();',False,M4X),
('NC7','Launcher: a second reserve sale while one is out (Launcher check)',L,'if (rs.auction != address(0)) revert WrongStage();','',False,M4X),
('NC8','Launcher: finish a reserve sale when none is out',L,'if (address(a) == address(0)) revert WrongStage();','',False,M4X),
('NC9','Launcher: an unknown project is not refused',L,'if (p.shares == address(0)) revert UnknownProject();','',False,M4X),
('ND0','Treasury: any runner may start the founder\'s trim (R1)',T,'if (founderLeaves && !_founderAgrees()) revert NotAllowed();','',False,M4X),
('ND1','Treasury: a contract that only says it is the founder\'s Pair may trim (R1)',T,'        if (!ILauncherPairs(salePath).isPair(msg.sender)) return false;\n','',False,M4X),
('ND2','Treasury: any Pair may trim the founder (R1)',T,'return IPairSigners(msg.sender).first() == founder || IPairSigners(msg.sender).second() == founder;','return true;',False,M4X),
('ND3','Treasury: the seat may be offered to nobody or to the runner',T,'if (next == address(0) || next == runner) revert BadInput();','',False,M4X),
('ND4','Treasury: the project may wind down twice',T,'if (woundDown) revert AlreadyWoundDown();','',False,M4X),
('ND5','Treasury: no market after a market (Treasury check)',T,'if (msg.sender != salePath) revert NotAllowed();\n        if (poolOpen) revert PoolAlreadyOpen();','if (msg.sender != salePath) revert NotAllowed();',False,M4X),
('ND6','Treasury: more than the reserve may go out for sale',T,'if (amount > left) revert TooMuch(amount, left);','',False,M4X),
('ND7','Treasury: a reserve sale of nothing or to nobody',T,'if (to == address(0) || amount == 0) revert BadInput();\n        if (amount > left)','if (amount > left)',False,M4X),
('ND8','Treasury: a reserve sale may be closed when none is out',T,'if (!reserveSaleOpen) revert ReserveSaleState();','',False,M4X),
('NE0','Vester: anyone may take out a backer\'s held Shares (M4A-1)',V,'if (msg.sender != backer) revert NotAllowed();','',False,M4X),
('NE1','Vester: the founder may be trimmed twice (X3)',V,'if (start != 0 || trimmed) revert WrongPhase();','if (start != 0) revert WrongPhase();',False,M4X),
('NE2','Vester: a backer grant to nobody',V,'if (backer == address(0)) revert BadGrant();','',False,M4X),
('NE3','Vester: a founder grant to nobody',V,'if (founder_ == address(0)) revert BadGrant();','',False,M4X),
('NF0','Rounds: a refund that pays nothing still cancels the held Shares',RO,'if (paid == 0) revert NothingToRefund();','',False,M4X),
('NF1','Rounds: a refund with no held money is not refused early (redundant early exit: paid == 0 refuses the same calls with the same error; expect n 0)',RO,'if (p.held == 0) revert NothingToRefund();','',False,M4X),
('NF2','Rounds: a refund with every Share taken out is not refused early (redundant early exit: paid == 0 refuses the same calls with the same error; expect n 0)',RO,'if (still == 0) revert NothingToRefund();','',False,M4X),
('NF3','Rounds: unsold Shares leave while a round is open (redundant defence: the Launcher never leaves a round open past a market or a wind-down; expect n 0)',RO,'if (isOpen()) revert WrongPhase();','',False,M4X),
('NF4','Rounds: an ask may be "lowered" to the same or more',RO,'if (total >= old || (total != 0 && total < MIN_ASK)) revert BadAmount();','if (total != 0 && total < MIN_ASK) revert BadAmount();',False,M4X),
('NF5','Rounds: a round under 1 dollar may open',RO,' || size < MIN_ASK','',False,M4X),
('NF6','Rounds: a round that was never opened may be closed',RO,'if (r.openedAt == 0 || r.closedAt != 0 || block.timestamp < r.openedAt + WINDOW) revert WrongPhase();','if (r.closedAt != 0 || block.timestamp < r.openedAt + WINDOW) revert WrongPhase();',False,M4X),
('NF7','Rounds: a dollar token that sends less is not noticed',RO,'if (before - quote.balanceOf(address(this)) != amount) revert TokenMisbehaved();','',False,M4X),
('NG0','Pair: a call nobody proposed may be confirmed',PA,'if (by == address(0)) revert UnknownCall();','',False,M4X),
('NG1','Pair: a failing call is confirmed as if it ran',PA,'if (!ok) {','if (false) {',False,M4X),
('NG2','Pair: a signer may be nobody',PA,'if (first_ == address(0) || second_ == address(0) || first_ == second_) revert BadSetup();','if (first_ == second_) revert BadSetup();',False,M4X),
# MinBid
('NB0','MinBid: the cap is 64 times the starting price (back towards milestone 3\'s ladder)',MB,'IAuctionPrice(msg.sender).floorPrice() * maxPriceMultiple','IAuctionPrice(msg.sender).floorPrice() * maxPriceMultiple * 16',False,M4B),
]
MUT+=M4

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
only_m4='--m4' in sys.argv
shard=[a for a in sys.argv[1:] if a.startswith('--shard=')]
k,n=(int(x) for x in shard[0][8:].split('/')) if shard else (0,1)
pos=-1
for entry in MUT:
    (i,desc,f,old,new,inv)=entry[:6]
    suites=entry[6] if len(entry)>6 else None
    if sel and i not in sel: continue
    if only_m3 and i[0] not in 'FAHPXEB': continue
    if only_m4 and i[0] != 'N': continue
    if os.environ.get('M2_ONLY') and i[0] in 'FAHPXEB': continue
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
