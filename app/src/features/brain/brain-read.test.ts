import { describe, expect, it } from "vitest";
import {
  CHUNK_CHARS,
  FILE_MAX_BYTES,
  type GitCopy,
  type GitTools,
  plainText,
  readBrain,
  shownPart,
} from "./brain-read";
import type { BrainRepo } from "./brain-repo";

const REPO: BrainRepo = {
  id: "brain-lantern",
  owner: "b".repeat(64),
  bound: true,
};
const enc = (text: string) => new TextEncoder().encode(text);

/** A repository in memory: file paths to bytes (or a size alone for a file too big to hand over). */
function copyOf(
  files: Record<string, Uint8Array | number>,
  state: { closed: number; reads: string[] },
  failAt?: string,
): GitCopy {
  return {
    async list(path) {
      const prefix = `${path}/`;
      const names = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length));
      if (names.length === 0) return null;
      return names.map((name) => ({ name, file: !name.includes("/") }));
    },
    async read(path, maxBytes) {
      state.reads.push(path);
      if (path === failAt) throw new Error("the copy broke");
      const got = files[path];
      if (got === undefined) return null;
      const size = typeof got === "number" ? got : got.length;
      return size > maxBytes || typeof got === "number"
        ? { size, bytes: null }
        : { size, bytes: got };
    },
    async close() {
      state.closed += 1;
    },
  };
}

function tools(
  files: Record<string, Uint8Array | number>,
  failAt?: string,
): { tools: GitTools; state: { closed: number; reads: string[] } } {
  const state = { closed: 0, reads: [] as string[] };
  return {
    tools: { open: async () => copyOf(files, state, failAt) },
    state,
  };
}

describe("reading the brain", () => {
  it("lists the four top files in order, then the playbooks by name, leaving out what is not there", async () => {
    const { tools: t } = tools({
      "facts.md": enc("true things"),
      "AGENTS.md": enc("read first"),
      "playbooks/b-job.md": enc("b"),
      "playbooks/a-job.md": enc("a"),
      "playbooks/picture.png": enc("png"),
      "playbooks/deep/x.md": enc("x"),
    });
    const files = await readBrain(t, REPO);
    expect(files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "facts.md",
      "playbooks/a-job.md",
      "playbooks/b-job.md",
    ]);
  });

  it("is an empty list for a repository with no brain files", async () => {
    const { tools: t } = tools({ "src/main.rs": enc("fn main() {}") });
    expect(await readBrain(t, REPO)).toEqual([]);
  });

  it("does not show a file over the limit, and says so rather than reading half of it", async () => {
    const { tools: t } = tools({ "facts.md": FILE_MAX_BYTES + 1 });
    expect(await readBrain(t, REPO)).toEqual([
      { path: "facts.md", kind: "too-big", size: FILE_MAX_BYTES + 1 },
    ]);
  });

  it("holds the limit itself, even when a copy hands over the bytes of a file that is too big", async () => {
    const big: GitTools = {
      open: async () => ({
        list: async () => null,
        read: async (path) =>
          path === "facts.md"
            ? {
                size: FILE_MAX_BYTES + 1,
                bytes: new Uint8Array(FILE_MAX_BYTES + 1).fill(97),
              }
            : null,
        close: async () => {},
      }),
    };
    expect(await readBrain(big, REPO)).toEqual([
      { path: "facts.md", kind: "too-big", size: FILE_MAX_BYTES + 1 },
    ]);
  });

  it("does not draw a file that is not text", async () => {
    const { tools: t } = tools({
      "facts.md": new Uint8Array([104, 105, 0, 1, 2]),
      "voice.md": new Uint8Array([0xff, 0xfe, 0xfd]),
    });
    const files = await readBrain(t, REPO);
    expect(files.map((f) => f.kind)).toEqual(["not-text", "not-text"]);
  });

  it("reads at most 20 playbooks", async () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++)
      many[`playbooks/p${String(i).padStart(2, "0")}.md`] = enc("x");
    const { tools: t } = tools(many);
    expect(await readBrain(t, REPO)).toHaveLength(20);
  });

  it("closes the copy when it is done, and when a read fails", async () => {
    const ok = tools({ "facts.md": enc("a") });
    await readBrain(ok.tools, REPO);
    expect(ok.state.closed).toBe(1);
    const bad = tools({ "facts.md": enc("a") }, "facts.md");
    await expect(readBrain(bad.tools, REPO)).rejects.toThrow("the copy broke");
    expect(bad.state.closed).toBe(1);
  });
});

describe("plain text", () => {
  it("makes line ends plain and drops control and direction-changing characters", () => {
    expect(plainText("a\r\nb\rc\u0000d\u001be‮f⁦g\tx")).toBe("a\nb\ncdefg\tx");
  });
});

describe("cutting a long file", () => {
  it("shows a short file whole, with nothing to read on", () => {
    expect(shownPart("short", 0)).toEqual({ shown: "short", more: false });
  });
  it("shows the first part of a long one at a line end, and more each press, to the end", () => {
    const line = `${"w".repeat(98)}\n`;
    const text = line.repeat(100);
    const first = shownPart(text, 0);
    expect(first.more).toBe(true);
    expect(first.shown.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(first.shown.endsWith("w")).toBe(true);
    const second = shownPart(text, 1);
    expect(second.shown.length).toBeGreaterThan(first.shown.length);
    let pressed = 0;
    while (shownPart(text, pressed).more) pressed += 1;
    expect(shownPart(text, pressed).shown).toBe(text);
    expect(pressed).toBeLessThan(5);
  });
});
