/**
 * The passkey account sends on a real EVM: a user operation signed by a software passkey in the production way, sent
 * through the real EntryPoint v0.7 and the deployed Kernel 0.3.3 stack, with the fee paid by a paymaster, changing real
 * contract state. The bundler and the sponsor are stand-ins (`stand-in-bundler.ts`); nothing the app does is. Run by
 * `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  decodeExecuteCallData,
  encodeExecuteCallData,
} from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import type { MoneyCall } from "../../src/features/money/calls";
import { moneyProblem } from "../../src/features/money/money-copy";
import { WalletStepError } from "../../src/features/money/wallet";
import { getPasskeyAssertion } from "../../../packages/creaton-core/src/account/passkey.ts";
import { call, RPC, word } from "./rpc";
import { accounts } from "./rpc";
import { pass, phoneWorld } from "./phone-world";

const run = RPC ? describe : describe.skip;

const call1 = (
  to: string,
  signature: string,
  types: string[],
  values: unknown[],
): MoneyCall => ({
  to,
  data: encodeFunctionData(signature, types as never, values as never),
  value: "0x0",
});
const mint = (token: string, to: string, amount: bigint) =>
  call1(token, "mint(address,uint256)", ["address", "uint256"], [to, amount]);
const approve = (token: string, spender: string, amount: bigint) =>
  call1(
    token,
    "approve(address,uint256)",
    ["address", "uint256"],
    [spender, amount],
  );
const transfer = (token: string, to: string, amount: bigint) =>
  call1(
    token,
    "transfer(address,uint256)",
    ["address", "uint256"],
    [to, amount],
  );
const balanceOf = (token: string, who: string) =>
  word(token, encodeFunctionData("balanceOf(address)", ["address"], [who]));
const allowance = (token: string, owner: string, spender: string) =>
  word(
    token,
    encodeFunctionData(
      "allowance(address,address)",
      ["address", "address"],
      [owner, spender],
    ),
  );
const codeOf = async (address: string) =>
  (
    (await (
      await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [address, "latest"],
        }),
      })
    ).json()) as { result: string }
  ).result;

const OTHER = "0x00000000000000000000000000000000000000b1";
const SPENDER = "0x00000000000000000000000000000000000000c2";

run(
  "the phone path on anvil: a passkey account sends, the server pays the fee",
  () => {
    it("deploys the account on its first send, runs one call, and asks for the passkey once", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, chain, bundler, authenticator } = world;
        expect(sender.isAvailable()).toBe(true);
        const account = await sender.getAddress();
        expect(await codeOf(account)).toBe("0x");
        // The same account is shown with no prompt and no chain read after it was derived once.
        expect(await sender.connectedAddress()).toBe(account);

        const calls = [mint(chain.token, account, 25n)];
        const promptsBefore = authenticator.calls.get;
        const phases: string[] = [];
        const result = await sender.sendCalls(calls, 31337, {
          onPhase: (p) => phases.push(p),
        });

        expect(result.status).toBe("confirmed");
        expect(result.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(await balanceOf(chain.token, account)).toBe(25n);
        expect(await codeOf(account)).not.toBe("0x");
        pass(
          "the first send deploys the account and changes contract state through EntryPoint (25 dollars minted to it)",
        );

        expect(authenticator.calls.get - promptsBefore).toBe(1);
        pass(
          "one passkey prompt (one signature) for the whole first send, deploy included",
        );

        // The operation on the wire carries exactly the calls given, and the first one carried the account's own deploy.
        const op = bundler.sent[0].op;
        expect(op.factory).toBeTruthy();
        expect(decodeExecuteCallData(op.callData)).toEqual(calls);
        expect(op.callData).toBe(encodeExecuteCallData(calls));
        pass(
          "the signed operation's call data decodes to exactly the calls the sheet described",
        );

        expect(phases[0]).toBe("preparing");
        expect(phases).toEqual(
          expect.arrayContaining([
            "checking",
            "signing",
            "sending",
            "confirming",
          ]),
        );
        expect(bundler.asked.map((a) => a.method)).toEqual(
          expect.arrayContaining([
            "zd_sponsorUserOperation",
            "eth_sendUserOperation",
          ]),
        );
        // The account holds no coin of its own, and nothing was asked of it: the paymaster paid.
        expect(
          BigInt(
            (
              (await (
                await fetch(RPC, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_getBalance",
                    params: [account, "latest"],
                  }),
                })
              ).json()) as { result: string }
            ).result,
          ),
        ).toBe(0n);
        pass(
          "the account held no coin and the network fee was paid by the sponsor's paymaster",
        );
      } finally {
        await world.close();
      }
    });

    it("sends two calls as one all-or-nothing operation with one passkey prompt (approve, then transfer)", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, chain, bundler, authenticator } = world;
        const account = await sender.getAddress();
        await sender.sendCalls([mint(chain.token, account, 100n)], 31337);

        const calls = [
          approve(chain.token, SPENDER, 7n),
          transfer(chain.token, OTHER, 40n),
        ];
        const sentBefore = bundler.sent.length;
        const promptsBefore = authenticator.calls.get;
        await sender.sendCalls(calls, 31337);

        expect(bundler.sent.length - sentBefore).toBe(1);
        expect(authenticator.calls.get - promptsBefore).toBe(1);
        expect(await allowance(chain.token, account, SPENDER)).toBe(7n);
        expect(await balanceOf(chain.token, OTHER)).toBe(40n);
        expect(await balanceOf(chain.token, account)).toBe(60n);
        expect(
          decodeExecuteCallData(bundler.sent.at(-1)?.op.callData ?? "0x"),
        ).toEqual(calls);
        pass(
          "two calls (approve, then transfer) landed as one operation with one passkey prompt, in order",
        );
      } finally {
        await world.close();
      }
    });

    it("maps a revert to reverted with the contract's reason, and a batch that reverts leaves nothing done", async () => {
      const [admin] = await accounts();
      // The hosted service refuses a call that would fail before it sponsors it; here it is let through so the
      // operation lands and the revert is read from its receipt.
      const world = await phoneWorld(admin, { simulate: false });
      try {
        const { sender, chain } = world;
        const account = await sender.getAddress();
        await sender.sendCalls([mint(chain.token, account, 10n)], 31337);

        const calls = [
          approve(chain.token, SPENDER, 5n),
          transfer(chain.token, OTHER, 10n ** 30n),
        ];
        let caught: unknown;
        await sender.sendCalls(calls, 31337).catch((e) => {
          caught = e;
        });
        expect(caught).toBeInstanceOf(WalletStepError);
        expect((caught as WalletStepError).reason).toBe("reverted");
        expect((caught as WalletStepError).landed).toBe(0);
        expect(await allowance(chain.token, account, SPENDER)).toBe(0n);
        pass(
          "a batch whose second call reverts lands as reverted and the first call (approve) is not kept",
        );
        // The dollar test token reverts with a plain word; it comes through as the reason, not as a bare "reverted".
        expect(
          ((caught as WalletStepError).cause as { message?: string }).message,
        ).toBe("balance");
        pass(
          "the reason the account's call gave is read from the operation's receipt and carried with the failure",
        );
      } finally {
        await world.close();
      }
    });

    it("shows the sponsor's refusal and asks for no passkey and sends nothing", async () => {
      const [admin] = await accounts();
      let refuse = false;
      const world = await phoneWorld(admin, {
        sponsorPolicy: () =>
          refuse
            ? "gas policy: the daily limit for this account was reached"
            : null,
      });
      try {
        const { sender, chain, bundler, authenticator } = world;
        const account = await sender.getAddress();
        await sender.sendCalls([mint(chain.token, account, 1n)], 31337);
        refuse = true;
        const sentBefore = bundler.sent.length;
        const promptsBefore = authenticator.calls.get;
        let caught: unknown;
        await sender
          .sendCalls([mint(chain.token, account, 1n)], 31337)
          .catch((e) => {
            caught = e;
          });
        expect(caught).toBeInstanceOf(WalletStepError);
        expect((caught as WalletStepError).reason).toBe("failed");
        expect(((caught as WalletStepError).cause as Error).name).toBe(
          "PaymasterDeniedError",
        );
        expect(bundler.sent.length).toBe(sentBefore);
        expect(authenticator.calls.get).toBe(promptsBefore);
        const words = moneyProblem(caught, "back");
        expect(words).toMatch(/free network fee was refused/);
        expect(words).not.toMatch(/gas policy|paymaster|sponsor|bundler/i);
        pass(
          "a sponsor refusal is shown in plain words, before any passkey prompt, with nothing sent",
        );
      } finally {
        await world.close();
      }
    });

    it("asks for the fee at the sponsor's own address and sends at the bundler's, each only its own", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, chain, bundlerFront, sponsorFront } = world;
        const account = await sender.getAddress();
        await sender.sendCalls([mint(chain.token, account, 3n)], 31337);
        // A bundler that is not the sponsor knows no `zd_` method: the send only works if the fee was asked elsewhere.
        expect(sponsorFront.served).toEqual(["zd_sponsorUserOperation"]);
        expect(bundlerFront.refused).toEqual([]);
        expect(bundlerFront.served).toContain("eth_sendUserOperation");
        expect(sponsorFront.refused).toEqual([]);
        pass(
          "the fee is asked for at the sponsor's own address and the operation is sent to the bundler's, never the other way",
        );
      } finally {
        await world.close();
      }
    });

    it("lands nothing when the operation is signed by another key, and says it did not go through", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender: _first, chain } = world;
        // A second credential the account does not know, signing in the production way.
        const created = (await navigator.credentials.create({
          publicKey: {
            challenge: new Uint8Array(32),
            rp: { id: "localhost", name: "t" },
            user: { id: new Uint8Array(4), name: "x", displayName: "x" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        })) as unknown as { rawId: ArrayBuffer };
        const otherId = Buffer.from(created.rawId).toString("base64url");
        const wrongKey = world.senderWith({
          getAssertion: (options) =>
            getPasskeyAssertion({ ...options, credentialId: otherId }),
        });
        const account = await wrongKey.getAddress();
        const before = await balanceOf(chain.token, account);
        let caught: unknown;
        await wrongKey
          .sendCalls([mint(chain.token, account, 5n)], 31337)
          .catch((e) => {
            caught = e;
          });
        expect(caught).toBeInstanceOf(WalletStepError);
        expect((caught as WalletStepError).reason).toBe("failed");
        expect(await balanceOf(chain.token, account)).toBe(before);
        expect(moneyProblem(caught, "back")).toMatch(/did not go through/);
        pass(
          "an operation signed by a key the account does not know is refused by the validator and nothing changes",
        );
      } finally {
        await world.close();
      }
    });

    it("refuses to sign anything but the calls it was given", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { chain, authenticator } = world;
        const calls = [
          approve(chain.token, SPENDER, 3n),
          transfer(chain.token, OTHER, 1n),
        ];
        let captured:
          | {
              callData?: string;
              beforeSign?: (op: { callData: string }) => unknown;
            }
          | undefined;
        const sender = world.senderWith({
          sendUserOp: async (request) => {
            captured = request as never;
            throw new Error("stopped here");
          },
        });
        await sender.sendCalls(calls, 31337).catch(() => {});
        expect(captured?.callData).toBe(encodeExecuteCallData(calls));
        const same = { callData: encodeExecuteCallData(calls) };
        const swapped = {
          callData: encodeExecuteCallData([calls[1], calls[0]]),
        };
        const other = {
          callData: encodeExecuteCallData([transfer(chain.token, SPENDER, 1n)]),
        };
        expect(() => captured?.beforeSign?.(same)).not.toThrow();
        expect(() => captured?.beforeSign?.(swapped)).toThrow();
        expect(() => captured?.beforeSign?.(other)).toThrow();
        expect(authenticator.calls.get).toBe(0);
        pass(
          "the check just before the passkey is asked passes the shown calls and stops reordered or different calls",
        );
      } finally {
        await world.close();
      }
    });

    it("finds an operation again after a reload: waiting, dropped, replaced, then landed", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { chain, bundler } = world;
        const sender = world.senderWith({
          receipt: { pollIntervalMs: 5, maxPolls: 3 },
        });
        const account = await sender.getAddress();
        await sender.sendCalls([mint(chain.token, account, 1n)], 31337);

        // The bundler takes it and does not send it on in time: a pending step carrying what a reload needs.
        bundler.hold(true);
        let pending: unknown;
        await sender
          .sendCalls([mint(chain.token, account, 5n)], 31337)
          .catch((e) => {
            pending = e;
          });
        expect(pending).toBeInstanceOf(WalletStepError);
        const step = pending as WalletStepError;
        expect(step.reason).toBe("pending");
        expect(step.hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(step.sent?.from).toBe(account);
        expect(Number.isSafeInteger(step.sent?.nonce)).toBe(true);
        const sent = {
          hash: step.hash as string,
          from: account,
          nonce: step.sent?.nonce ?? null,
        };

        // A new page (a new sender) asks about it.
        const afterReload = world.senderWith();
        expect(await afterReload.connectedAddress()).toBe(account);
        expect(await afterReload.outcomeOf(sent)).toBe("waiting");
        pass(
          "after a reload an operation the bundler still holds is found as waiting",
        );

        // Dropped by the bundler: gone, and nothing took its place.
        bundler.drop(sent.hash);
        expect(await afterReload.outcomeOf(sent)).toBe("unknown");
        pass(
          "an operation the bundler dropped is found as unknown, never as landed",
        );

        // Something else takes its place in the account's order: the dropped one can never land.
        bundler.hold(false);
        const other = await sender.sendCalls(
          [mint(chain.token, account, 9n)],
          31337,
        );
        expect(await afterReload.outcomeOf(sent)).toBe("replaced");
        expect(
          await afterReload.outcomeOf({
            ...sent,
            hash: other.userOpHash as string,
          }),
        ).toBe("landed");
        expect(await balanceOf(chain.token, account)).toBe(10n);
        pass(
          "when another operation took the dropped one's place it reads as replaced, and the new one as landed",
        );

        // A repeat press after a drop signs again and lands once.
        bundler.hold(true);
        const calls = [mint(chain.token, account, 2n)];
        let second: unknown;
        await sender.sendCalls(calls, 31337).catch((e) => {
          second = e;
        });
        const droppedAgain = second as WalletStepError;
        bundler.drop(droppedAgain.hash as string);
        bundler.hold(false);
        await sender.sendCalls(calls, 31337);
        expect(await balanceOf(chain.token, account)).toBe(12n);
        pass(
          "a repeat press after a dropped operation signs again and lands once",
        );

        // A held operation that is sent on later lands, and is read as landed.
        bundler.hold(true);
        let third: unknown;
        await sender
          .sendCalls([mint(chain.token, account, 3n)], 31337)
          .catch((e) => {
            third = e;
          });
        const held = third as WalletStepError;
        await bundler.release();
        expect(
          await afterReload.outcomeOf({
            hash: held.hash as string,
            from: account,
            nonce: held.sent?.nonce ?? null,
          }),
        ).toBe("landed");
        expect(await balanceOf(chain.token, account)).toBe(15n);
        pass(
          "an operation sent on after the page timed out is found as landed and counted once",
        );
      } finally {
        await world.close();
      }
    });

    it("lets only one send run at a time from one account", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, chain } = world;
        const account = await sender.getAddress();
        const first = sender.sendCalls([mint(chain.token, account, 1n)], 31337);
        const second = await sender
          .sendCalls([mint(chain.token, account, 1n)], 31337)
          .then(
            () => null,
            (e: unknown) => e,
          );
        await first;
        expect(second).toBeInstanceOf(WalletStepError);
        expect(await balanceOf(chain.token, account)).toBe(1n);
        pass(
          "a second send started while one runs is refused; the first lands once",
        );
      } finally {
        await world.close();
      }
    });

    it("reads the chain through the account's own server address", async () => {
      const [admin] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, chain } = world;
        expect(await sender.chainId()).toBe(31337);
        const account = await sender.getAddress();
        await sender.sendCalls([mint(chain.token, account, 3n)], 31337);
        const read = await sender.readCall(
          chain.token,
          encodeFunctionData("balanceOf(address)", ["address"], [account]),
        );
        expect(BigInt(read)).toBe(3n);
        expect(await sender.blockNumber()).toBeGreaterThan(0);
        const head = await sender.blockNumber();
        const logs = await sender.getLogs({
          address: chain.token,
          topics: [null],
          from: Math.max(0, head - 20),
          to: head,
        });
        expect(logs.length).toBeGreaterThan(0);
        expect(call).toBeDefined();
        pass(
          "a phone with no wallet reads the chain (balance, block, logs) through the configured node",
        );
      } finally {
        await world.close();
      }
    });
  },
);
