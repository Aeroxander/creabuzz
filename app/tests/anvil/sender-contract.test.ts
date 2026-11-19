/**
 * One set of expectations for the two senders, run against both on a real EVM: the wallet in the browser (the app's own
 * `injectedWallet`, over an anvil account) and the passkey account. What a screen relies on holds for both: calls land in
 * the order given, a revert is `reverted` with the contract's reason, a landed send is found `landed` by its hash, and a
 * hash the network never saw is `unknown`. Where they differ by design (a revert in a batch leaves the earlier calls done on
 * a wallet and undone on the passkey account), that is stated and checked, not hidden. Run by `scripts/phone-loop.sh`.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import type { MoneyCall } from "../../src/features/money/calls";
import {
  type MoneyWallet,
  senderKind,
  WalletStepError,
} from "../../src/features/money/wallet";
import { pass, phoneWorld } from "./phone-world";
import { accounts, RPC, word } from "./rpc";
import { walletOf } from "./steps";

const run = RPC ? describe : describe.skip;

const OTHER = "0x00000000000000000000000000000000000000d4";
const data = (
  signature: string,
  types: ("address" | "uint256")[],
  values: (string | bigint)[],
) => encodeFunctionData(signature, types, values);
const callTo = (to: string, payload: string): MoneyCall => ({
  to,
  data: payload,
  value: "0x0",
});
const balanceOf = (token: string, who: string) =>
  word(token, data("balanceOf(address)", ["address"], [who]));

run("both senders keep the same promises", () => {
  it.each([
    ["wallet"],
    ["passkey"],
  ] as const)("the %s sender: order, revert, outcome", async (kind) => {
    const [admin, walletAccount] = await accounts();
    const world = await phoneWorld(admin, { simulate: false });
    try {
      const { chain } = world;
      const sender: MoneyWallet =
        kind === "wallet" ? walletOf(walletAccount) : world.sender;
      expect(senderKind(sender)).toBe(kind);
      const account = await sender.getAddress();

      // Calls land in the order given: the mint must come first for the transfer to have anything to send.
      const result = await sender.sendCalls(
        [
          callTo(
            chain.token,
            data(
              "mint(address,uint256)",
              ["address", "uint256"],
              [account, 100n],
            ),
          ),
          callTo(
            chain.token,
            data(
              "transfer(address,uint256)",
              ["address", "uint256"],
              [OTHER, 40n],
            ),
          ),
        ],
        31337,
      );
      expect(result.status).toBe("confirmed");
      expect(await balanceOf(chain.token, OTHER)).toBe(40n);
      expect(await balanceOf(chain.token, account)).toBe(60n);
      pass(`the ${kind} sender sends calls in the order given`);

      // A landed send is found landed by the hash it returned.
      const hash = result.userOpHash ?? result.txHash;
      expect(await sender.outcomeOf({ hash, from: account, nonce: null })).toBe(
        "landed",
      );
      pass(`the ${kind} sender finds a landed send as landed`);

      // A hash the network never saw, with its place still free, is unknown (never landed, never replaced).
      const unseen = `0x${"ab".repeat(32)}`;
      const place = kind === "wallet" ? 10_000 : 10_000;
      expect(
        await sender.outcomeOf({ hash: unseen, from: account, nonce: place }),
      ).toBe("unknown");
      pass(`the ${kind} sender finds a hash the network never saw as unknown`);

      // A revert is `reverted`, carries the contract's reason, and the dollars did not move.
      let caught: unknown;
      await sender
        .sendCalls(
          [
            callTo(
              chain.token,
              data(
                "transfer(address,uint256)",
                ["address", "uint256"],
                [OTHER, 10n ** 30n],
              ),
            ),
          ],
          31337,
        )
        .catch((e) => {
          caught = e;
        });
      expect(caught).toBeInstanceOf(WalletStepError);
      expect((caught as WalletStepError).reason).toBe("reverted");
      // Both carry the contract's own revert bytes ("balance", as the token spells it), whatever else they add.
      expect(JSON.stringify((caught as WalletStepError).cause)).toContain(
        "62616c616e6365",
      );
      expect(await balanceOf(chain.token, OTHER)).toBe(40n);
      pass(
        `the ${kind} sender reports a revert as reverted with the contract's reason`,
      );

      // By design they differ in a batch: the passkey account's is all or nothing; a wallet's earlier calls stay.
      const batch = [
        callTo(
          chain.token,
          data(
            "approve(address,uint256)",
            ["address", "uint256"],
            [OTHER, 11n],
          ),
        ),
        callTo(
          chain.token,
          data(
            "transfer(address,uint256)",
            ["address", "uint256"],
            [OTHER, 10n ** 30n],
          ),
        ),
      ];
      let batchError: unknown;
      await sender.sendCalls(batch, 31337).catch((e) => {
        batchError = e;
      });
      const stopped = batchError as WalletStepError;
      expect(stopped.reason).toBe("reverted");
      const allowed = await word(
        chain.token,
        data(
          "allowance(address,address)",
          ["address", "address"],
          [account, OTHER],
        ),
      );
      if (kind === "passkey") {
        expect(stopped.landed).toBe(0);
        expect(allowed).toBe(0n);
      } else {
        expect(stopped.landed).toBe(1);
        expect(allowed).toBe(11n);
      }
      pass(
        `the ${kind} sender's batch that reverts: ${kind === "passkey" ? "nothing is kept (all or nothing)" : "the call before it stays, as the step's own `landed` count says"}`,
      );
    } finally {
      await world.close();
    }
  });
});
