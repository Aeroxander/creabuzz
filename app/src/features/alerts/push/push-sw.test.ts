// The service worker's alerts, loaded as the browser loads it (its own file, in an isolated context with a fake worker scope).
// It shows one of three fixed sentences for a message of one exact shape, drops everything else without showing a thing,
// and a press opens the project (or Home), never an address a message could name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PUSH_TITLE, PUSH_WORDS } from "./push-words";

const SOURCE = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
const FOUNDER16 = "0123456789abcdef";
const LINK = `moss-${FOUNDER16}`;

interface Shown {
  title: string;
  options: { body: string; tag: string; data: { url: string }; icon: string };
}

/** Run the worker file in a fake scope; returns what it registered and what it showed or opened. */
function worker(
  windows: {
    url: string;
    focus: () => Promise<unknown>;
    navigate: (url: string) => Promise<unknown>;
  }[] = [],
) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const waits: Promise<unknown>[] = [];
  const scope = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    location: { origin: "https://app.example" },
    registration: {
      showNotification: async (title: string, options: Shown["options"]) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
  };
  const context = vm.createContext({
    self: scope,
    caches: {},
    URL,
    Response,
    Request,
    Object,
    JSON,
    Promise,
  });
  const exports = vm.runInContext(
    `${SOURCE}\n;({ PUSH_TITLE, PUSH_WORDS })`,
    context,
  ) as { PUSH_TITLE: string; PUSH_WORDS: Record<string, string> };
  const send = async (event: Record<string, unknown>) => {
    handlers[event.type as string]({
      ...event,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits.splice(0));
  };
  const push = (message: unknown) =>
    send({
      type: "push",
      data: {
        json: () => {
          if (message instanceof Error) throw message;
          return message;
        },
      },
    });
  return { exports, handlers, shown, opened, send, push };
}

describe("the alerts the worker shows", () => {
  it("are the app's own three sentences and title, word for word", () => {
    const { exports } = worker();
    expect(exports.PUSH_TITLE).toBe(PUSH_TITLE);
    expect(exports.PUSH_WORDS).toEqual(PUSH_WORDS);
    // The five kinds are the in-app news's planned, taken, ended, vote and moved; no other.
    expect(Object.keys(exports.PUSH_WORDS).sort()).toEqual([
      "ended",
      "moved",
      "planned",
      "taken",
      "vote",
    ]);
  });

  it.each([
    "planned",
    "taken",
    "ended",
    "vote",
    "moved",
  ] as const)("%s shows its sentence and opens the project", async (kind) => {
    const w = worker();
    await w.push({ v: 1, k: kind, r: LINK });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe(PUSH_TITLE);
    expect(w.shown[0].options.body).toBe(PUSH_WORDS[kind]);
    expect(w.shown[0].options.data.url).toBe(`/p/${LINK}`);
    expect(w.shown[0].options.tag).toBe(`${kind}:${LINK}`);
  });

  it("never shows anything the message adds: only the sentence, whatever else it carries", async () => {
    const w = worker();
    await w.push({
      v: 1,
      k: "planned",
      r: LINK,
      amount: "1,200",
      name: "Moss",
      body: "Send your money to x",
      title: "Win now",
    });
    expect(w.shown).toHaveLength(1);
    const text = JSON.stringify(w.shown[0]);
    for (const word of ["1,200", "Moss", "Send your money", "Win now"])
      expect(text).not.toContain(word);
    expect(w.shown[0].options.body).toBe(PUSH_WORDS.planned);
  });

  it.each([
    ["a message that is not JSON", new Error("not json")],
    ["a list", [1, "planned", LINK]],
    ["null", null],
    ["a string", "planned"],
    ["another version", { v: 2, k: "planned", r: LINK }],
    ["no version", { k: "planned", r: LINK }],
    ["a kind it does not know", { v: 1, k: "claim", r: LINK }],
    ["a kind that is an inherited name", { v: 1, k: "toString", r: LINK }],
    ["a kind that is not text", { v: 1, k: 1, r: LINK }],
    ["no project", { v: 1, k: "planned" }],
    [
      "a project that is an address",
      { v: 1, k: "planned", r: "https://evil.example/x" },
    ],
    ["a project with a slash", { v: 1, k: "planned", r: `a/b-${FOUNDER16}` }],
    ["a project with no founder part", { v: 1, k: "planned", r: "moss" }],
    [
      "a project with a short founder part",
      { v: 1, k: "planned", r: "moss-0123" },
    ],
    [
      "a project as a very long text",
      { v: 1, k: "planned", r: `${"a".repeat(500)}-${FOUNDER16}` },
    ],
  ])("drops %s without showing anything", async (_name, message) => {
    const w = worker();
    await w.push(message);
    expect(w.shown).toHaveLength(0);
  });

  it("a push with no data at all shows nothing", async () => {
    const w = worker();
    await w.send({ type: "push", data: null });
    expect(w.shown).toHaveLength(0);
  });
});

describe("pressing an alert", () => {
  const press = (w: ReturnType<typeof worker>, url: unknown) => {
    const close = vi.fn();
    return {
      close,
      done: w.send({
        type: "notificationclick",
        notification: { close, data: { url } },
      }),
    };
  };

  it("opens the project in a new window when the app is not open", async () => {
    const w = worker([]);
    const { close, done } = press(w, `/p/${LINK}`);
    await done;
    expect(close).toHaveBeenCalled();
    expect(w.opened).toEqual([`/p/${LINK}`]);
  });

  it("uses the window that is open: focuses it and takes it to the project", async () => {
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => ({ navigate }));
    const w = worker([
      {
        url: "https://app.example/you",
        focus,
        navigate: async () => undefined,
      } as never,
    ]);
    await press(w, `/p/${LINK}`).done;
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`/p/${LINK}`);
    expect(w.opened).toEqual([]);
  });

  it("opens a new window when the open one cannot be taken there", async () => {
    const w = worker([
      {
        url: "https://app.example/",
        focus: async () => {
          throw new Error("no");
        },
        navigate: async () => undefined,
      },
    ]);
    await press(w, `/p/${LINK}`).done;
    expect(w.opened).toEqual([`/p/${LINK}`]);
  });

  it.each([
    ["an address on another site", "https://evil.example/p/x"],
    ["a protocol-relative address", "//evil.example/p/x"],
    ["a path that is not a project's", "/you"],
    ["a project path that smuggles another", "/p//evil.example"],
    ["nothing", undefined],
    ["a number", 7],
  ])("never opens %s: it opens Home", async (_name, url) => {
    const w = worker([]);
    await press(w, url).done;
    expect(w.opened).toEqual(["/"]);
  });
});
