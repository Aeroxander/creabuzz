import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { PaymasterDeniedError } from "../../identity/lib/zerodev.ts";
import { reportingSender, sponsorFailureCause } from "./sponsor-report.ts";

function fakeSender(outcome) {
  return {
    batching: "batch",
    isAvailable: () => true,
    getAddress: async () => `0x${"ab".repeat(20)}`,
    sendCalls: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const CALLS = [{ to: `0x${"11".repeat(20)}`, data: "0x" }];

test("a refused sponsorship is reported as sponsor-refused, and the caller still gets the same error", async () => {
  const reports = [];
  const denied = new PaymasterDeniedError("spending limit reached");
  const sender = reportingSender(fakeSender(denied), (cause, error) => {
    reports.push([cause, error]);
    return true;
  });
  await assert.rejects(sender.sendCalls(CALLS), (error) => error === denied);
  assert.deepEqual(reports, [["sponsor-refused", denied]]);
  // Everything else about the sender is the same.
  assert.equal(sender.isAvailable(), true);
  assert.equal(await sender.getAddress(), `0x${"ab".repeat(20)}`);
  assert.equal(sender.batching, "batch");
});

test("a bundler failure is reported by its kind; a closed passkey prompt and a success are not reported", async () => {
  const reports = [];
  const report = (cause) => {
    reports.push(cause);
    return true;
  };
  class BundlerRpcError extends Error {
    name = "BundlerRpcError";
  }
  await assert.rejects(
    reportingSender(
      fakeSender(new BundlerRpcError("bundler: eth_sendUserOperation failed")),
      report,
    ).sendCalls(CALLS),
  );
  const closed = new Error(
    "The operation either timed out or was not allowed.",
  );
  closed.name = "NotAllowedError";
  await assert.rejects(
    reportingSender(fakeSender(closed), report).sendCalls(CALLS),
  );
  const result = {
    txHash: `0x${"22".repeat(32)}`,
    status: "confirmed",
    userOps: [],
  };
  assert.equal(
    await reportingSender(fakeSender(result), report).sendCalls(CALLS),
    result,
  );
  assert.deepEqual(reports, ["sponsor-failed-BundlerRpcError"]);
});

test("a cause is a short fixed word, whatever an error calls itself", () => {
  assert.equal(
    sponsorFailureCause({ name: `x${"y".repeat(500)} <script>` }),
    "sponsor-failed-Error",
  );
  assert.equal(sponsorFailureCause("text"), "sponsor-failed-Error");
  assert.equal(sponsorFailureCause({ name: "AbortError" }), null);
});

test("every passkey sender the launchpad makes has reporting around it", () => {
  // The seam: `makeSponsoredSender` wraps it. A page that made one directly (a screen's own sender picker did) would
  // send passkey steps whose refused sponsorships nobody hears about.
  const made = readFileSync(
    new URL("./passkey-sender.ts", import.meta.url),
    "utf8",
  );
  assert.match(made, /reportingSender\(\s*createSponsoredSender\(/);
  for (const file of ["../use-acting-account.ts", "../ui/SenderPicker.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /makeSponsoredSender\(/, file);
  }
  const root = new URL("../", import.meta.url);
  const direct = readdirSync(root, { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("passkey-sender.ts"))
    .filter((f) =>
      /createSponsoredSender\(/.test(readFileSync(new URL(f, root), "utf8")),
    );
  assert.deepEqual(direct, []);
});
