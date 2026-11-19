import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_MAX,
  askManager,
  draftBody,
  ITEMS_MAX,
  parseDraft,
} from "./manager-calls";
import { leftOutWords, MANAGER_PROBLEM, refusalWords } from "./manager-copy";

vi.mock("@creaton/core/client/nip98.ts", () => ({
  makeNip98AuthHeader: async () => "Nostr signed",
}));

const GOOD = {
  schema: "creaton.manager.v1",
  loop_version: "manager-loop 1",
  read: "I read 3 records and 1 answer.",
  this_week: [{ text: "Ship the page.", from: ["r1"], records: ["aa"] }],
  not_doing: [],
  what_happened: [{ text: "Posted the page.", from: ["r2"], records: ["bb"] }],
  needs_a_person: [{ topic: "tax", ask: "Ask a tax adviser.", from: ["a1"] }],
  dropped: 2,
  blocked: 1,
  set_aside: [{ label: "r3", id: "cc", why: "x" }],
  can_be_wrong: "It can be wrong.",
  notice: "AI service.",
};

const reply = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.restoreAllMocks());

describe("the request", () => {
  it("is bounded the way the server bounds it, and drops empty answers", () => {
    const body = JSON.parse(
      draftBody({
        project: "37001:ab:x",
        items: Array.from({ length: 50 }, (_, i) => String(i)),
        answers: ["  ", "x".repeat(ANSWER_MAX + 50), "b", "c", "d", "e", "f"],
      }),
    );
    expect(body.items).toHaveLength(ITEMS_MAX);
    expect(body.answers).toHaveLength(5);
    expect(body.answers[0]).toHaveLength(ANSWER_MAX);
  });

  it("is signed and posted to the manager's route, and the draft is read", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const draft = await askManager(
      { project: "37001:ab:x", items: ["aa"], answers: [] },
      async (url, init) => {
        seen.push({ url, init });
        return reply(200, GOOD)();
      },
    );
    expect(seen[0].url.endsWith("/llm/manager/draft")).toBe(true);
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(
      "Nostr signed",
    );
    expect(draft.whatHappened[0].text).toBe("Posted the page.");
    expect(draft.setAside).toBe(1);
  });
});

describe("the answer", () => {
  it("is refused whole when it is not the shape the app knows", () => {
    expect(parseDraft({ ...GOOD, schema: "other" })).toBeNull();
    expect(parseDraft({ ...GOOD, this_week: "text" })).toBeNull();
    expect(
      parseDraft({
        ...GOOD,
        what_happened: [{ text: 1, from: [], records: [] }],
      }),
    ).toBeNull();
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft(GOOD)).not.toBeNull();
  });

  it("says unreadable for a draft it cannot read, and never shows half of it", async () => {
    await expect(
      askManager(
        { project: "p", items: [], answers: [] },
        reply(200, { ...GOOD, this_week: 5 }),
      ),
    ).rejects.toThrow(MANAGER_PROBLEM.unreadable);
  });
});

describe("a refusal", () => {
  it("is the server's own sentence", async () => {
    await expect(
      askManager(
        { project: "p", items: [], answers: [] },
        reply(403, {
          error: "Post this week's update first, then ask again.",
          code: "ai_manager_post_weekly",
        }),
      ),
    ).rejects.toThrow("Post this week's update first, then ask again.");
  });

  it("falls back to the app's sentence for its code, or for a missing route", () => {
    expect(refusalWords(429, { code: "ai_manager_own_key" })).toMatch(
      /own AI key/,
    );
    expect(refusalWords(404, null)).toBe(MANAGER_PROBLEM.notThere);
    expect(refusalWords(500, { error: "x".repeat(900) })).toBe(
      MANAGER_PROBLEM.unreadable,
    );
  });

  it("says nobody answered when the connection fails", async () => {
    await expect(
      askManager({ project: "p", items: [], answers: [] }, async () => {
        throw new TypeError("network");
      }),
    ).rejects.toThrow(MANAGER_PROBLEM.noAnswer);
  });
});

describe("what was left out", () => {
  it("is counted in plain words, and silent when nothing was", () => {
    expect(leftOutWords({ dropped: 0, blocked: 0, setAside: 0 })).toBeNull();
    expect(leftOutWords({ dropped: 2, blocked: 1, setAside: 1 })).toMatch(
      /2 lines were left out.*1 line was left out.*1 input was not read/,
    );
  });
});
