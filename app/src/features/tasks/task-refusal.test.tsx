// When the server refuses a step on a task that has a plan on the network, the person reads a plain sentence, never the server's
// own words with their program prefix; a `retry:` is passed on as it is (a caller reads it to try again).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../project/project-record";
import { taskRefusalWords } from "./tasks-copy";
import { useTaskWrite } from "./use-tasks";

let refusal = "";
vi.mock("../../lib/relay", () => ({
  publishAsUser: async () => {
    throw new Error(refusal);
  },
  read: async () => [],
  readMulti: async () => [],
  readLatest: async () => null,
}));

const project = {
  coordinate: `37001:${"f".repeat(64)}:orbit`,
  author: "f".repeat(64),
  team: [],
} as unknown as Project;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

async function refusedWith(message: string): Promise<string> {
  refusal = message;
  const { result } = renderHook(() => useTaskWrite(project), { wrapper });
  try {
    await result.current.mutateAsync({
      record: { kind: 1, content: "", tags: [] } as never,
      failure: "failed",
    });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the write was not refused");
}

describe("a refusal about a plan on the network", () => {
  it("is told in plain words, without the server's prefix", async () => {
    const said = await refusedWith(
      "invalid: this task is planned on the network: name the account you will take it with",
    );
    expect(said).toMatch(/^This task is planned on the network, so it is paid/);
    expect(said).not.toMatch(/invalid:/);
    expect(
      await refusedWith(
        "restricted: this task's plan has ended on the network",
      ),
    ).toBe("This task's plan has ended, so it cannot be taken any more.");
  });

  it("leaves a retry, and anything it does not know, as the server said it", async () => {
    const retry =
      "retry: the network has not shown this payment to the server yet; try again in a minute";
    expect(await refusedWith(retry)).toMatch(/^retry:/);
    expect(taskRefusalWords("something else")).toBeNull();
    expect(taskRefusalWords(retry)).toBeNull();
  });

  it("every sentence the server's plan rules give has a plain one", () => {
    for (const tail of [
      "name the account you will take it with",
      "the plan on the network names another account",
      "already taken on the network by another account",
      "plan has ended on the network",
      "pay it on the network first",
      "not the payment that paid this task",
      "paid another account than the one the worker named",
      "withdraw or send back the money on the network first",
    ])
      expect(taskRefusalWords(`invalid: this task ${tail}`)).not.toBeNull();
  });
});

describe("a refusal about a task paid out of the allowance box", () => {
  const cases: [string, RegExp][] = [
    [
      "invalid: the network does not show that payment",
      /^The network does not show that payment\. Nothing is saved as paid\./,
    ],
    [
      "invalid: the worker has not named a wallet to be paid at",
      /^The worker has not named an account to be paid at/,
    ],
    [
      "invalid: the payment went to another wallet than the one the worker named",
      /^The payment went to another account than the one the worker named/,
    ],
    [
      "invalid: the payment is not what the task pays",
      /^The payment is not the amount this task pays/,
    ],
    [
      "invalid: that payment already paid another task",
      /^That payment already paid another task/,
    ],
    [
      "invalid: write the payment's transaction in lower case",
      /could not be read the way the server needs it/,
    ],
  ];
  for (const [message, words] of cases)
    it(`is told in plain words: ${message.slice(9, 50)}`, async () => {
      const said = await refusedWith(message);
      expect(said).toMatch(words);
      expect(said).not.toMatch(/invalid:|wallet/i);
      expect(taskRefusalWords(message)).toBe(said);
    });
});
