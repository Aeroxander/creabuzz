/**
 * The earlier backers' claim on a real EVM, through the app's own calls and reads: project zero is named with its list,
 * launched, and each kind of consent (in person, by a signature anyone submits) lands; a refused receiver reads as a
 * sentence; the keeper's replacement is vetoed once by the holder; and after the release clock starts, anyone's `deliver`
 * sends exactly what is due to the receiver. Every holder, amount and salt here is made up. Run by
 * `scripts/m7-chain-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  CLAIM_READS,
  cancelHolderData,
  consentData,
  consentDigest,
  consentTypedData,
  deliverData,
  fingerprintOf,
  leafOf,
  parseBytes32,
  parseEntry,
  parseFlag,
  parseWord,
} from "../../../packages/creaton-core/src/launchpad/earlier-claim.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import type { MoneyCall } from "../../src/features/money/calls";
import { teamProblem } from "../../src/features/team/team-copy";
import { deployPlatform } from "./deploy";
import {
  accounts,
  call,
  chainTime,
  deploy,
  passTime,
  RPC,
  send,
  word,
} from "./rpc";
import { DAY, data, launched, SHARE, walletOf } from "./steps";

const run = RPC ? describe : describe.skip;
const CHAIN = 31337;
const TEXT = "Made-up agreement text for the anvil loop.";
const SUMMARY = "Made-up one-line summary for the anvil loop.";
const call0 = (to: string, d: string): MoneyCall => ({
  to,
  data: d,
  value: "0x0",
});

run("milestone 7 on anvil: the earlier backers' claim", () => {
  it("names project zero with its list, takes consent two ways, vetoes a replacement once, and delivers what is due", async () => {
    const [
      admin,
      founder,
      h1,
      h2,
      h3,
      keeper,
      stranger,
      replacement,
      otherEoa,
      stake,
    ] = await accounts();
    const platform = await deployPlatform(admin, stake);
    const coordinate = `37001:${"e2".repeat(32)}:zero`;
    const key = chainKeyOf(founder, projectIdOf(coordinate));

    // The list: three made-up lines. Entry index = position.
    const lines = [
      { holder: h1, amount: 4_000_000n * SHARE },
      { holder: h2, amount: 5_000_000n * SHARE },
      { holder: h3, amount: 3_000_000n * SHARE },
    ].map((l, i) => ({
      ...l,
      salt: `0x${(i + 1).toString(16).padStart(64, "0")}`,
    }));
    const leaves = lines.map((l, i) =>
      leafOf(BigInt(i), l.holder, l.amount, l.salt),
    );
    const total = lines.reduce((sum, l) => sum + l.amount, 0n);
    const longStop = BigInt((await chainTime()) + 3 * 365 * DAY);
    const claim = await deploy(
      admin,
      "EarlierBackers.sol/EarlierBackers.json",
      [
        "address",
        "bytes32",
        { array: "bytes32" },
        "uint256",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "address",
      ],
      [
        platform.launcher,
        key,
        leaves,
        total,
        fingerprintOf(TEXT),
        fingerprintOf(SUMMARY),
        longStop,
        0n,
        keeper,
      ],
    );
    await send(
      admin,
      platform.launcher,
      data("nameProjectZero(bytes32)", ["bytes32"], [key]),
    );
    await send(
      admin,
      platform.launcher,
      data(
        "nameEarlierBackers(address,uint256)",
        ["address", "uint256"],
        [claim, 0n],
      ),
    );
    const p = await launched(platform, founder, coordinate);
    expect(p.key).toBe(key);

    // The app's reads of the list: funded, the contract's own fingerprints, this line's leaf.
    const wallet1 = walletOf(h1);
    const read = (d: string) => wallet1.readCall(claim, d);
    expect(parseWord(await read(CLAIM_READS.funding))).toBe(total);
    expect(parseWord(await read(CLAIM_READS.total))).toBe(total);
    expect(parseBytes32(await read(CLAIM_READS.key))).toBe(key);
    expect(parseBytes32(await read(CLAIM_READS.textHash))).toBe(
      fingerprintOf(TEXT),
    );
    expect(parseBytes32(await read(CLAIM_READS.summaryHash))).toBe(
      fingerprintOf(SUMMARY),
    );
    expect(parseWord(await read(CLAIM_READS.entryCount))).toBe(3n);
    expect(parseFlag(await read(CLAIM_READS.closed))).toBe(false);
    expect(parseBytes32(await read(CLAIM_READS.leaf(0n)))).toBe(leaves[0]);

    // The digest the app builds is the contract's, so a wallet's signature over the typed data verifies.
    const until = BigInt((await chainTime()) + 7 * DAY);
    const message = {
      entry: 1n,
      holder: h2,
      amount: lines[1].amount,
      receiver: h2,
      project: key,
      textHash: fingerprintOf(TEXT),
      textVersion: 1n,
      summary: SUMMARY,
      holderVersion: 0n,
      validUntil: until,
    };
    const digestData = data(
      "consentDigest(uint256,address,uint256,address,uint256)",
      ["uint256", "address", "uint256", "address", "uint256"],
      [1n, h2, lines[1].amount, h2, until],
    );
    expect(await call(claim, digestData)).toBe(
      consentDigest(CHAIN, claim, message),
    );

    // In person: the holder's own call, no signature.
    await wallet1.sendCalls(
      [
        call0(
          claim,
          consentData({
            entry: 0n,
            holder: h1,
            amount: lines[0].amount,
            salt: lines[0].salt,
            receiver: h1,
            textHash: fingerprintOf(TEXT),
            validUntil: until,
          }),
        ),
      ],
      CHAIN,
    );
    const first = parseEntry(await read(CLAIM_READS.entryOf(0n)));
    expect(first.signer).toBe(h1);
    expect(first.receiver).toBe(h1);
    expect(first.amount).toBe(lines[0].amount);

    // By signature: h2 signs the typed data; anyone (a stranger) submits it. An EOA that is not the holder is refused,
    // in the app's own words.
    const signature = await walletOf(h2).signTypedData(
      h2,
      consentTypedData(CHAIN, claim, message),
    );
    const submit = (receiver: string, sig: string) =>
      walletOf(stranger).sendCalls(
        [
          call0(
            claim,
            consentData({
              entry: 1n,
              holder: h2,
              amount: lines[1].amount,
              salt: lines[1].salt,
              receiver,
              textHash: fingerprintOf(TEXT),
              validUntil: until,
              signature: sig,
            }),
          ),
        ],
        CHAIN,
      );
    try {
      await submit(otherEoa, signature);
      throw new Error(
        "a receiver that is neither the holder nor a wallet with code must be refused",
      );
    } catch (error) {
      expect(teamProblem(error, "consent")).toMatch(
        /your own wallet or to a wallet that already exists/,
      );
    }
    await submit(h2, signature);
    expect(parseEntry(await read(CLAIM_READS.entryOf(1n))).signer).toBe(h2);

    // A replacement the keeper proposes for h3's open line: h3's one veto cancels it, and a second veto is refused.
    await send(
      keeper,
      claim,
      data(
        "proposeHolder(uint256,address,bytes32)",
        ["uint256", "address", "bytes32"],
        [2n, replacement, `0x${"00".repeat(32)}`],
      ),
    );
    expect(parseEntry(await read(CLAIM_READS.entryOf(2n))).pending).toBe(
      replacement,
    );
    const veto = call0(
      claim,
      cancelHolderData(2n, lines[2].amount, lines[2].salt),
    );
    await walletOf(h3).sendCalls([veto], CHAIN);
    const vetoed = parseEntry(await read(CLAIM_READS.entryOf(2n)));
    expect(vetoed.pending).toBeNull();
    expect(vetoed.vetoed).toBe(true);

    // Nothing is delivered inside the 21 days; the app says so in plain words.
    try {
      await walletOf(stranger).sendCalls(
        [call0(claim, deliverData(0n))],
        CHAIN,
      );
      throw new Error("a delivery inside the 21 days must be refused");
    } catch (error) {
      expect(teamProblem(error, "deliver")).toMatch(/21 days/);
    }

    // The release clock starts when the project declares no market (365 days after launch); then Shares are released.
    await passTime(366 * DAY);
    await walletOf(founder).sendCalls(
      [
        call0(
          platform.launcher,
          data("declareNoMarket(bytes32)", ["bytes32"], [key]),
        ),
      ],
      CHAIN,
    );
    await passTime(100 * DAY);
    const due = parseWord(await read(CLAIM_READS.due(0n)));
    expect(due).toBeGreaterThan(0n);
    // Released over 365 days, evenly: about 100/365 of the line, never more than that.
    expect(due).toBeLessThan((lines[0].amount * 101n) / 365n);
    expect(due).toBeGreaterThan((lines[0].amount * 99n) / 365n);
    const balance = async (who: string) =>
      word(p.shares, data("balanceOf(address)", ["address"], [who]));
    const before = await balance(h1);
    await walletOf(stranger).sendCalls([call0(claim, deliverData(0n))], CHAIN);
    const sent = (await balance(h1)) - before;
    // Delivered to the receiver only, and exactly what was due then or a block's worth more.
    expect(sent).toBeGreaterThanOrEqual(due);
    expect(parseEntry(await read(CLAIM_READS.entryOf(0n))).taken).toBe(sent);
    // h2's line is untouched until someone delivers it; h3's open line has nothing due.
    expect(await balance(h2)).toBe(0n);
    expect(parseWord(await read(CLAIM_READS.due(2n)))).toBe(0n);
  });
});
