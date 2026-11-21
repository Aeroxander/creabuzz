import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  projectEvent,
  wrap,
} from "../../../tests/helpers/money-harness";
import { chainIdentity } from "../../../tests/helpers/numbers-fixture";
import { parseProject, type RecordEvent } from "../project/project-record";
import BrainRow from "./BrainRow";
import { CHUNK_CHARS, type GitCopy } from "./brain-read";
import { KIND_REPO_ANNOUNCEMENT } from "./brain-repo";

const [, FOUNDER, ID] = COORDINATE.split(":");
let who: string | null = "a".repeat(64);
let announced: { tags: string[][] }[] = [];
let opened = 0;
let copy: () => Promise<GitCopy>;
let readAsked: unknown[] = [];

vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: who }),
}));
vi.mock("../../lib/relay", () => ({
  read: async (filter: unknown) => {
    readAsked.push(filter);
    return announced.map((a, i) => ({
      id: `${i}`.padStart(64, "0"),
      pubkey: FOUNDER_KEY,
      kind: KIND_REPO_ANNOUNCEMENT,
      created_at: 10,
      content: "",
      ...a,
    }));
  },
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (action: () => void) => {
    if (who) action();
    else needAccount += 1;
    return Boolean(who);
  },
}));
vi.mock("./brain-git", () => ({
  gitTools: {
    open: async () => {
      opened += 1;
      return copy();
    },
  },
}));
const FOUNDER_KEY = "b".repeat(64);
let needAccount = 0;

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

function files(entries: Record<string, string>): () => Promise<GitCopy> {
  return async () => ({
    list: async (path) =>
      path === "playbooks"
        ? Object.keys(entries)
            .filter((f) => f.startsWith("playbooks/"))
            .map((f) => ({ name: f.slice(10), file: true }))
        : [],
    read: async (path) => {
      const text = entries[path];
      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);
      return { size: bytes.length, bytes };
    },
    close: async () => {},
  });
}

const BOUND = [
  {
    tags: [
      ["d", `brain-${ID}`],
      ["buzz-channel", "c"],
    ],
  },
];

beforeEach(() => {
  who = "a".repeat(64);
  announced = [];
  opened = 0;
  needAccount = 0;
  readAsked = [];
  copy = files({});
});
afterEach(cleanup);

describe("the project's brain on its page", () => {
  it("shows nothing to a reader when the project has no brain", async () => {
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    await waitFor(() => expect(readAsked).toHaveLength(1));
    expect(screen.queryByTestId("brain-row")).toBeNull();
  });

  it("shows the founder one line about keeping a brain, with how", async () => {
    wrap(<BrainRow isFounder project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-setup-open"));
    const steps = await screen.findByTestId("brain-steps");
    expect(steps.textContent).toContain("buzz launchpad brain init");
    // The repository id the reader looks for is the one the steps tell the founder to make.
    expect(steps.textContent).toContain(`--id brain-${ID} `);
    expect(opened).toBe(0);
  });

  it("opens the set-up steps on arrival for a founder who said yes in Start, and not for a reader", async () => {
    wrap(<BrainRow isFounder project={lantern()} setupOpen />);
    expect(await screen.findByTestId("brain-steps")).toBeTruthy();
    cleanup();
    wrap(<BrainRow isFounder={false} project={lantern()} setupOpen />);
    await waitFor(() => expect(readAsked).toHaveLength(2));
    expect(screen.queryByTestId("brain-steps")).toBeNull();
  });

  it("asks for the founder's repository by its id and nothing else", async () => {
    announced = BOUND;
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    await screen.findByTestId("brain-open");
    expect(readAsked).toEqual([
      {
        kinds: [KIND_REPO_ANNOUNCEMENT],
        authors: [FOUNDER],
        "#d": [`brain-${ID}`],
        limit: 5,
      },
    ]);
  });

  it("fetches no file until the person opens the notes", async () => {
    announced = BOUND;
    copy = files({ "facts.md": "The app is free." });
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    await screen.findByTestId("brain-open");
    expect(opened).toBe(0);
    fireEvent.click(screen.getByTestId("brain-open"));
    expect(await screen.findByText("The app is free.")).toBeTruthy();
    expect(opened).toBe(1);
  });

  it("sends a person with no account to make one, and reads nothing", async () => {
    who = null;
    announced = BOUND;
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-open"));
    expect(needAccount).toBe(1);
    expect(opened).toBe(0);
  });

  it("draws a file as plain text: markup in it is words, never an element", async () => {
    announced = BOUND;
    const evil =
      '# Hi\n<img src="x" onerror="window.__ran=1"><script>window.__ran=2</script>';
    copy = files({ "facts.md": evil });
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-open"));
    const text = await screen.findByTestId("brain-text");
    expect(text.textContent).toBe(evil);
    expect(text.querySelector("img, script, a")).toBeNull();
    expect((window as unknown as { __ran?: number }).__ran).toBeUndefined();
  });

  it("cuts a long file and reads on one press at a time", async () => {
    announced = BOUND;
    const long = `${"line of words\n".repeat(1000)}THE END`;
    copy = files({ "facts.md": long });
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-open"));
    const text = await screen.findByTestId("brain-text");
    expect(text.textContent?.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(text.textContent).not.toContain("THE END");
    const more = screen.getByRole("button", { name: "Read on: facts.md" });
    for (
      let i = 0;
      i < 10 && screen.queryByRole("button", { name: "Read on: facts.md" });
      i++
    )
      fireEvent.click(
        screen.getByRole("button", { name: "Read on: facts.md" }),
      );
    expect(more).toBeTruthy();
    expect(screen.getByTestId("brain-text").textContent).toBe(long);
  });

  it("opens one file at a time, the first to begin with, and the buttons have distinct names", async () => {
    announced = BOUND;
    copy = files({ "AGENTS.md": "first words", "facts.md": "second words" });
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-open"));
    const first = await screen.findByRole("button", { name: /AGENTS\.md/ });
    const second = screen.getByRole("button", { name: /facts\.md/ });
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(second);
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(first.getAttribute("aria-expanded")).toBe("false");
    // The closed one's words are not on the screen for a reader (hidden).
    expect(screen.getByText("first words").closest("[hidden]")).not.toBeNull();
  });

  it("says plainly when the notes are not written yet", async () => {
    announced = BOUND;
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-open"));
    expect(
      await screen.findByText("The notes are not written yet."),
    ).toBeTruthy();
  });

  it.each([
    [403, "not open to you"],
    [404, "not open to you"],
    [401, "Sign in"],
  ])("tells a refusal (%s) in plain words and offers Try again", async (statusCode, words) => {
    announced = BOUND;
    copy = async () => {
      throw Object.assign(new Error("HTTP Error: 403"), {
        code: "HttpError",
        data: { statusCode },
      });
    };
    wrap(<BrainRow isFounder={false} project={lantern()} />);
    fireEvent.click(await screen.findByTestId("brain-open"));
    const alert = await screen.findByTestId("brain-failure");
    expect(alert.textContent).toContain(words);
    expect(alert.textContent).not.toMatch(/HTTP|403|404|git/);
    // Try again asks again (and a second refusal is told again, never looped).
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(opened).toBe(2));
  });

  it("tells a founder whose repository is not attached to a room why nobody can read it", async () => {
    announced = [{ tags: [["d", `brain-${ID}`]] }];
    wrap(<BrainRow isFounder project={lantern()} />);
    expect(await screen.findByTestId("brain-unbound")).toBeTruthy();
  });
});
