import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  projectEvent,
  wrap,
} from "../../../tests/helpers/money-harness";
import { chainIdentity } from "../../../tests/helpers/numbers-fixture";
import { parseProject, type RecordEvent } from "../project/project-record";
import { ManagerPanel, whatHappenedText } from "./ManagerPanel";
import type { ManagerDraft } from "./manager-calls";

const [, FOUNDER, ID] = COORDINATE.split(":");
const asked: { items: string[]; answers: string[]; project: string }[] = [];
let who: string | null = FOUNDER;
let next: () => Promise<ManagerDraft>;

vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: who }),
}));
vi.mock("../../lib/relay", () => ({
  read: async () => [
    { id: "a".repeat(64), created_at: 10, kind: 47003, tags: [], content: "" },
    { id: "b".repeat(64), created_at: 20, kind: 47003, tags: [], content: "" },
  ],
}));
vi.mock("./manager-calls", async (original) => ({
  ...(await original<typeof import("./manager-calls")>()),
  askManager: async (request: (typeof asked)[number]) => {
    asked.push(request);
    return next();
  },
}));

const DRAFT: ManagerDraft = {
  read: "I read 2 records.",
  thisWeek: [{ text: "Ship the page.", from: ["r1"], records: [] }],
  notDoing: [],
  whatHappened: [
    { text: "Posted the page.", from: ["r1"], records: [] },
    { text: "Talked to five people.", from: ["a1"], records: [] },
  ],
  needsAPerson: [{ topic: "tax", ask: "Ask a tax adviser.", from: ["a1"] }],
  dropped: 1,
  blocked: 0,
  setAside: 0,
  canBeWrong: "It can be wrong.",
  notice: "AI service.",
};

function lantern() {
  const project = parseProject(
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentity(COORDINATE).key,
    }) as RecordEvent,
  );
  if (!project) throw new Error("not a project");
  return project;
}

beforeEach(() => {
  asked.length = 0;
  who = FOUNDER;
  next = async () => DRAFT;
});
afterEach(cleanup);

describe("the manager's panel on the weekly update", () => {
  it("shows only to the person who started the project", () => {
    who = "f".repeat(64);
    wrap(
      <ManagerPanel max={500} onUse={() => undefined} project={lantern()} />,
    );
    expect(screen.queryByTestId("manager-open")).toBeNull();
    cleanup();
    who = null;
    wrap(
      <ManagerPanel max={500} onUse={() => undefined} project={lantern()} />,
    );
    expect(screen.queryByTestId("manager-open")).toBeNull();
  });

  it("asks once with the ids the page read, shows what was read and left out, and says it can be wrong", async () => {
    wrap(
      <ManagerPanel max={500} onUse={() => undefined} project={lantern()} />,
    );
    fireEvent.click(screen.getByTestId("manager-open"));
    fireEvent.change(screen.getByTestId("manager-answer"), {
      target: { value: "The venue moved." },
    });
    fireEvent.click(screen.getByTestId("manager-ask"));
    await screen.findByTestId("manager-draft");
    expect(asked).toHaveLength(1);
    expect(asked[0].project).toBe(COORDINATE);
    expect(asked[0].items).toEqual(["b".repeat(64), "a".repeat(64)]);
    expect(asked[0].answers).toEqual(["The venue moved."]);
    expect(screen.getByTestId("manager-read").textContent).toBe(
      "I read 2 records.",
    );
    expect(screen.getByTestId("manager-left-out").textContent).toMatch(
      /1 line was left out/,
    );
    expect(screen.getByTestId("manager-wrong").textContent).toMatch(
      /can be wrong.*AI service/,
    );
    expect(screen.getByTestId("manager-person").textContent).toMatch(/tax/);
  });

  it("puts the what-happened lines in the weekly box, and nothing for what is next", async () => {
    const used: string[] = [];
    wrap(
      <ManagerPanel
        max={500}
        onUse={(t) => used.push(t)}
        project={lantern()}
      />,
    );
    fireEvent.click(screen.getByTestId("manager-open"));
    fireEvent.click(screen.getByTestId("manager-ask"));
    fireEvent.click(await screen.findByTestId("manager-use"));
    expect(used).toEqual(["Posted the page.\nTalked to five people."]);
    expect(screen.queryByText(/what's next/i)).toBeNull();
    expect(whatHappenedText(DRAFT, 10)).toHaveLength(10);
  });

  it("says why when the server refuses, and posts nothing", async () => {
    next = async () => {
      throw new Error("Post this week's update first, then ask again.");
    };
    wrap(
      <ManagerPanel max={500} onUse={() => undefined} project={lantern()} />,
    );
    fireEvent.click(screen.getByTestId("manager-open"));
    fireEvent.click(screen.getByTestId("manager-ask"));
    await waitFor(() =>
      expect(screen.getByTestId("manager-problem").textContent).toBe(
        "Post this week's update first, then ask again.",
      ),
    );
    expect(screen.queryByTestId("manager-use")).toBeNull();
  });
});
