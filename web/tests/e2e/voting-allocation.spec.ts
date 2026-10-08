import { expect, test, type Page } from "@playwright/test";
import { FOUNDER, FOUNDER_NSEC } from "../helpers/funding-fixture";

const DAO = "0x3333333333333333333333333333333333333333";
const OWNER = "0x1111111111111111111111111111111111111111";
const SOURCE = "0x2222222222222222222222222222222222222222";
const unit = 10n ** 18n;
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

async function votingWorld(
  page: Page,
  initiallyFail = false,
  executable = false,
  unopened = false,
) {
  let failed = initiallyFail;
  let spent = false;
  let allocated = 0n;
  let execution = 0;
  const sent: { to: string; data: string }[] = [];
  const coordinate = `37001:${FOUNDER}:allocations`;
  const event = (
    kind: number,
    id: string,
    tags: string[][],
    content: object,
  ) => ({
    kind,
    id,
    pubkey: FOUNDER,
    created_at: 100,
    tags,
    content: JSON.stringify(content),
    sig: "sig",
  });
  const events = [
    event(
      37001,
      "launch",
      [
        ["d", "allocations"],
        ["name", "Allocation DAO"],
        ["t", "dao-launchpad"],
      ],
      { pitch: "One voting design.", stage: "graduated" },
    ),
    event(47004, "proposal", [["a", coordinate]], {
      proposalId: "1",
      title: "Approve a budget",
      state: "open",
      kind: "futarchy-budget",
      ...(executable
        ? {
            intent: {
              op: 0,
              to: DAO,
              value: "0",
              data: "0x",
              nonce: `0x${"00".repeat(32)}`,
            },
          }
        : {}),
    }),
    event(
      47005,
      "binding",
      [
        ["a", coordinate],
        ["kind", "summon"],
        ["tx", `0x${"aa".repeat(32)}`],
      ],
      { dao: DAO },
    ),
  ];
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message[0] !== "REQ") return;
      const [, sub, ...filters] = message;
      for (const e of events)
        if (
          filters.some((f: { kinds?: number[] }) => f.kinds?.includes(e.kind))
        )
          ws.send(JSON.stringify(["EVENT", sub, e]));
      ws.send(JSON.stringify(["EOSE", sub]));
    });
  });
  await page.addInitScript(
    ({ nsec, owner }) => {
      localStorage.setItem("buzz.identity.nsec", nsec);
      localStorage.setItem("buzz.launchpad.rpc", "http://127.0.0.1:8545");
      (window as unknown as { ethereum: unknown }).ethereum = {
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: { to: string; data: string }[];
        }) => {
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_accounts" || method === "eth_requestAccounts")
            return [owner];
          if (method === "eth_sendTransaction") {
            await (
              window as unknown as {
                captureVote: (tx: unknown) => Promise<void>;
              }
            ).captureVote(params?.[0]);
            return `0x${"bb".repeat(32)}`;
          }
          throw new Error(`Unexpected wallet call: ${method}`);
        },
      };
    },
    { nsec: FOUNDER_NSEC, owner: OWNER },
  );
  await page.exposeFunction(
    "captureVote",
    (tx: { to: string; data: string }) => {
      sent.push(tx);
      spent = true;
      if (tx.data.startsWith("0x9c028176") || tx.data.startsWith("0x87906434"))
        allocated = BigInt(`0x${tx.data.slice(-64)}`);
      if (tx.data.startsWith("0xee5b2895")) execution = execution === 0 ? 1 : 3;
    },
  );
  await page.route(/^http:\/\/127\.0\.0\.1:8545/, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204 });
      return;
    }
    const body = request.postDataJSON();
    const data: string = body.params?.[0]?.data ?? "";
    let result: unknown = "0x" + word(0);
    if (body.method === "eth_chainId") result = "0x7a69";
    if (body.method === "eth_getTransactionReceipt") result = { status: "0x1" };
    if (data.startsWith("0x3e4f49e6"))
      result =
        "0x" +
        word(executable ? (execution === 1 ? 2 : execution === 3 ? 6 : 3) : 1);
    if (data.startsWith("0x3e4f49e6") && unopened && !spent)
      result = "0x" + word(0);
    if (data.startsWith("0x4bcaf6aa"))
      result = "0x" + [allocated, 0n, 0n, 0n].map(word).join("");
    if (data.startsWith("0xb1f792c9")) {
      const now = Math.floor(Date.now() / 1000);
      result =
        "0x" +
        [
          100n * unit, // voting supply
          20n * unit, // quorum
          0n, // absolute floor in favour
          6600, // share of the votes cast that must be in favour
          now + 48 * 3600,
          now + 14 * 86400,
          86400,
          12 * 3600, // hold
          0,
        ]
          .map(word)
          .join("");
    }
    if (data.startsWith("0xb1f792c9") && unopened && !spent)
      result = "0x" + word(0).repeat(9);
    if (data.startsWith("0x54b31217")) {
      if (failed) {
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "RPC unavailable" },
          },
        });
        return;
      }
      result =
        "0x" +
        [
          100n * unit - allocated,
          100n * unit,
          100n * unit,
          allocated,
          1n,
          100n * unit, // opposition is free: all of it can oppose
        ]
          .map(word)
          .join("");
    }
    await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result } });
  });
  await page.goto("/launchpad");
  await page.getByText("Allocation DAO", { exact: true }).click();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(
    page.getByText("Approve a budget", { exact: true }),
  ).toBeVisible();
  return {
    sent,
    mature: () => {
      execution = 2;
    },
    recover: () => {
      failed = false;
    },
  };
}

test("budget proposal replaces an allocation and permits withdrawal through the single Shares ballot", async ({
  page,
}) => {
  const world = await votingWorld(page);
  await expect(page.getByTestId("voting-allocation-balance")).toContainText(
    "100 free / 100 owned",
  );
  await expect(
    page.getByText(/At least 20 Shares must take part/),
  ).toBeVisible();
  await page.getByLabel("Shares to allocate").fill("101");
  await expect(page.getByTestId("proposal-vote-for")).toBeDisabled();
  await page.getByLabel("Shares to allocate").fill("70");
  await page.getByTestId("proposal-vote-for").click();
  await expect.poll(() => world.sent.length).toBe(1);
  expect(world.sent[0]).toEqual({
    to: DAO,
    from: OWNER,
    value: "0x0",
    data: "0x9c028176" + word(1) + word(1) + word(70n * unit),
  });
  await expect(page.getByTestId("voting-allocation-balance")).toContainText(
    "30 free / 100 owned · 70 allocated here · 100 can back this proposal · 100 can oppose it",
  );
  await expect(page.getByTestId("proposal-vote-for")).toBeEnabled();
  await page.getByLabel("Shares to allocate").fill("bad input");
  await page.getByTestId("proposal-vote-withdraw").click();
  await expect.poll(() => world.sent.length).toBe(2);
  expect(world.sent[1].data).toBe("0x9c028176" + word(1) + word(1) + word(0));
  await expect(page.getByTestId("voting-allocation-balance")).toContainText(
    "100 free",
  );
});

test("delegate names the source owner and unreadable allocations have a recovery path", async ({
  page,
}) => {
  const world = await votingWorld(page, true, false, true);
  await expect(
    page.getByRole("button", { name: "Retry Shares read" }),
  ).toBeVisible();
  await expect(page.getByTestId("proposal-vote-for")).toBeDisabled();
  world.recover();
  await page.getByRole("button", { name: "Retry Shares read" }).click();
  await expect(page.getByTestId("voting-allocation-balance")).toContainText(
    "100 free",
  );
  await page.getByLabel("Vote on behalf of (optional)").fill(SOURCE);
  await page.getByLabel("Shares to allocate").fill("70");
  await page.getByTestId("proposal-vote-against").click();
  await expect.poll(() => world.sent.length).toBe(1);
  expect(world.sent[0].data).toBe(
    "0x87906434" +
      SOURCE.slice(2).padStart(64, "0") +
      word(1) +
      word(0) +
      word(70n * unit),
  );
});

test("execution remains reachable when the captured timelock matures", async ({
  page,
}) => {
  const world = await votingWorld(page, false, true);
  await page.getByTestId("proposal-execute").click();
  await expect(
    page.getByText(/Waiting for this proposal's captured timelock/),
  ).toBeVisible();
  await expect(page.getByTestId("proposal-execute")).toBeHidden();
  await expect(page.getByTestId("voting-allocation-controls")).toBeVisible();
  world.mature();
  await page.reload();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await page.getByTestId("proposal-execute").click();
  await expect.poll(() => world.sent.length).toBe(2);
  expect(world.sent.every((tx) => tx.data.startsWith("0xee5b2895"))).toBe(true);
  await expect(page.getByTestId("proposal-execute")).toBeHidden();
});

test("an unopened executable intent is authenticated before voting", async ({
  page,
}) => {
  const world = await votingWorld(page, false, true, true);
  await expect(page.getByTestId("proposal-vote-for")).toBeHidden();
  await page.getByTestId("proposal-open").click();
  await expect.poll(() => world.sent.length).toBe(1);
  expect(world.sent[0].data.slice(0, 10)).toBe("0xe1d5ec31");
  await expect(page.getByTestId("proposal-vote-for")).toBeVisible();
});
