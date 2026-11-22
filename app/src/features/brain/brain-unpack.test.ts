// The brain download is capped at 1 MiB, but deflate expands about 1000 to 1, so what it UNPACKS to is bounded too. These tests
// drive the app's real git library (as patched in patches/isomorphic-git.patch) through the app's own `gitTools.open`, over a
// stand-in server that answers with packs made by hand, and a stand-in file store in memory. They assert on the bytes the
// inflate really produced (counted at the library's inflater, not at the guard), never on time.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyDelta,
  deflatedZeros,
  deflateSync,
  makeBrainPack,
  makePack,
  type PackEntry,
  plainEntry,
  uploadReply,
} from "../../../tests/helpers/git-pack";

const world = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  dirs: new Set<string>(["/"]),
  reply: { commit: "", parts: [] as Uint8Array[] },
  limits: undefined as { produced: number } | undefined,
  requests: 0,
}));

vi.mock("@creaton/core/client/nip98.ts", () => ({
  makeNip98AuthHeader: async () => "Nostr test",
}));
vi.mock("@creaton/core/client/relay-url.ts", () => ({
  relayHttpBaseUrl: () => "https://server.example",
}));
vi.mock("@creaton/core/client/git-http.ts", async () => {
  const { advertisement } = await import("../../../tests/helpers/git-pack");
  const lines = (parts: Uint8Array[]) => {
    let at = 0;
    const body: AsyncIterableIterator<Uint8Array> = {
      async next() {
        return at < parts.length
          ? { done: false, value: parts[at++] as Uint8Array }
          : { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return body;
      },
    };
    return body;
  };
  return {
    withGitDeadline: async (run: (http: unknown) => Promise<unknown>) =>
      run({
        request: async ({ url }: { url: string }) => {
          world.requests += 1;
          // The limits are set for the length of the download: keep a handle on them to read what was unpacked.
          world.limits = (globalThis as Record<symbol, never>)[
            Symbol.for("creaton.isomorphic-git.unpackLimits")
          ];
          const advert = url.includes("/info/refs");
          return {
            url,
            statusCode: 200,
            statusMessage: "OK",
            headers: {
              "content-type": advert
                ? "application/x-git-upload-pack-advertisement"
                : "application/x-git-upload-pack-result",
            },
            body: lines(
              advert ? [advertisement(world.reply.commit)] : world.reply.parts,
            ),
          };
        },
      }),
  };
});

/** A file store in memory with the calls the git library makes: nothing here touches a disk. */
vi.mock("@isomorphic-git/lightning-fs", () => {
  const fail = (code: string, path: string) =>
    Object.assign(new Error(`${code}: ${path}`), { code });
  const parentOf = (path: string) => path.replace(/\/[^/]*$/, "") || "/";
  // "/brain/." and "/brain/" are "/brain".
  const clean = (path: string) => {
    const parts = path.split("/").filter((part) => part !== "" && part !== ".");
    return `/${parts.join("/")}`;
  };
  const stat = (given: string) => {
    const path = clean(given);
    const file = world.files.get(path);
    const isDir = world.dirs.has(path);
    if (!file && !isDir) throw fail("ENOENT", path);
    return {
      type: isDir ? "dir" : "file",
      mode: isDir ? 0o40000 : 0o100644,
      size: file ? file.length : 0,
      ino: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    };
  };
  const promises = {
    async mkdir(given: string) {
      const path = clean(given);
      if (world.dirs.has(path) || world.files.has(path))
        throw fail("EEXIST", path);
      if (!world.dirs.has(parentOf(path))) throw fail("ENOENT", path);
      world.dirs.add(path);
    },
    async rmdir(given: string) {
      const path = clean(given);
      world.dirs.delete(path);
    },
    async writeFile(given: string, data: string | Uint8Array) {
      const path = clean(given);
      if (!world.dirs.has(parentOf(path))) throw fail("ENOENT", path);
      world.files.set(
        path,
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
    },
    async readFile(given: string, options?: { encoding?: string } | string) {
      const path = clean(given);
      const file = world.files.get(path);
      if (!file) throw fail("ENOENT", path);
      const encoding =
        typeof options === "string" ? options : options?.encoding;
      return encoding ? new TextDecoder().decode(file) : file;
    },
    async unlink(given: string) {
      const path = clean(given);
      world.files.delete(path);
    },
    async stat(path: string) {
      return stat(path);
    },
    async lstat(path: string) {
      return stat(path);
    },
    async readdir(given: string) {
      const path = clean(given);
      if (!world.dirs.has(path)) throw fail("ENOENT", path);
      const names = new Set<string>();
      for (const key of [...world.files.keys(), ...world.dirs]) {
        if (key !== path && parentOf(key) === path)
          names.add(key.slice(path === "/" ? 1 : path.length + 1));
      }
      return [...names];
    },
    async readlink(path: string) {
      throw fail("ENOENT", path);
    },
    async symlink(_target: string, path: string) {
      throw fail("ENOENT", path);
    },
    async chmod() {},
  };
  return {
    default: class {
      promises = promises;
      constructor(_name: string, options: { wipe: boolean }) {
        if (options.wipe) {
          world.files.clear();
          world.dirs.clear();
          world.dirs.add("/");
        }
      }
    },
  };
});

import { BRAIN_WORDS, brainFailureWords } from "./brain-copy";
import {
  BrainTooBigError,
  gitTools,
  UNPACK_OBJECT_MAX_BYTES,
  UNPACK_TOTAL_MAX_BYTES,
  withUnpackLimits,
} from "./brain-git";
import { readBrain } from "./brain-read";

const repo = { owner: "b".repeat(64), id: "brain" } as never;
const SENTENCE = "The project's notes are too big to show here.";
/** The most the inflater hands over in one piece, so the most a stop can overshoot by. */
const ONE_CHUNK = 16 * 1024;
const MIB = 1024 * 1024;

/** Every byte the library's inflater produced, counted at the inflater itself (not at the guard in the patch). */
let inflated = 0;
let restoreInflater: () => void = () => {};

beforeEach(() => {
  world.files.clear();
  world.dirs.clear();
  world.dirs.add("/");
  world.limits = undefined;
  world.requests = 0;
  inflated = 0;
  // The library's own copy of pako, found from the library, wrapped so every produced piece is counted.
  const fromLibrary = createRequire(
    createRequire(import.meta.url).resolve("isomorphic-git"),
  );
  const pako = fromLibrary("pako") as {
    Inflate: { prototype: { onData(chunk: Uint8Array): void } };
  };
  const original = pako.Inflate.prototype.onData;
  pako.Inflate.prototype.onData = function (chunk: Uint8Array) {
    inflated += chunk.length;
    return original.call(this, chunk);
  };
  restoreInflater = () => {
    pako.Inflate.prototype.onData = original;
  };
});

afterEach(() => restoreInflater());

function serve(pack: Uint8Array, commit = "c".repeat(40)) {
  world.reply = { commit, parts: uploadReply(pack) };
}

/** A pack whose download is small and whose one object states `stated` bytes but holds `real` zeros. */
function bomb(stated: number, real: number): Uint8Array {
  return makePack([{ type: 3, stated, deflated: deflatedZeros(real) }]);
}

async function opened(): Promise<unknown> {
  try {
    await gitTools.open(repo);
    return null;
  } catch (error) {
    return error;
  }
}

describe("an ordinary brain still reads", () => {
  it("unpacks and shows its files, with the limits well above what it needs", async () => {
    const { pack, commit } = makeBrainPack(
      {
        "AGENTS.md": "# Read this first\nUse only what is written here.\n",
        "facts.md": "The lamp is blue.\n",
      },
      { "launch.md": "Steps to launch a lamp.\n" },
    );
    serve(pack, commit);
    const files = await readBrain(gitTools, repo);
    expect(files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "facts.md",
      "playbooks/launch.md",
    ]);
    expect(files[0]).toMatchObject({ kind: "text" });
    expect((files[1] as { text: string }).text).toBe("The lamp is blue.\n");
    expect(world.limits).toBeDefined();
    expect(world.limits?.produced).toBeGreaterThan(0);
    expect(world.limits?.produced).toBeLessThan(UNPACK_TOTAL_MAX_BYTES);
  });

  it("takes the limits off again when the download ends, so a later read is not counted with it", async () => {
    const { pack, commit } = makeBrainPack({ "facts.md": "x\n" }, {});
    serve(pack, commit);
    await readBrain(gitTools, repo);
    expect(
      (globalThis as Record<symbol, unknown>)[
        Symbol.for("creaton.isomorphic-git.unpackLimits")
      ],
    ).toBeUndefined();
  });
});

describe("a small download that unpacks to far more is stopped while it inflates", () => {
  it("stops an object that states a small size and holds 256 MiB, and says so in plain words", async () => {
    const download = bomb(1000, 256 * MIB);
    expect(download.length).toBeLessThan(MIB);
    serve(download);
    const error = await opened();
    expect(error).toBeInstanceOf(BrainTooBigError);
    expect(brainFailureWords(error)).toBe(SENTENCE);
    // At most the stated size and one more piece came out of the inflater, not the 256 MiB inside.
    expect(inflated).toBeLessThanOrEqual(1000 + ONE_CHUNK);
    expect(inflated).toBeLessThan(256 * MIB);
  });

  it("refuses an object that STATES a size over the limit before inflating any of it", async () => {
    const download = bomb(UNPACK_OBJECT_MAX_BYTES + 1, 200 * MIB);
    expect(download.length).toBeLessThan(MIB);
    serve(download);
    const error = await opened();
    expect(error).toBeInstanceOf(BrainTooBigError);
    expect(brainFailureWords(error)).toBe(SENTENCE);
    expect(inflated).toBe(0);
  });

  it("stops a pack of honest objects whose sizes add up past the total", async () => {
    const each = UNPACK_OBJECT_MAX_BYTES;
    const count = UNPACK_TOTAL_MAX_BYTES / each + 4;
    const entries: PackEntry[] = Array.from({ length: count }, () => ({
      type: 3,
      stated: each,
      deflated: deflatedZeros(each),
    }));
    const download = makePack(entries);
    expect(download.length).toBeLessThan(MIB);
    serve(download);
    const error = await opened();
    expect(error).toBeInstanceOf(BrainTooBigError);
    expect(brainFailureWords(error)).toBe(SENTENCE);
    expect(world.limits?.produced).toBeLessThanOrEqual(
      UNPACK_TOTAL_MAX_BYTES + ONE_CHUNK,
    );
    // Four whole objects were left alone: the stop came at the total, not at the end of the pack.
    expect(inflated).toBeLessThanOrEqual(UNPACK_TOTAL_MAX_BYTES + ONE_CHUNK);
    expect(inflated).toBeGreaterThanOrEqual(UNPACK_TOTAL_MAX_BYTES);
  });

  it("refuses a delta that states a target over the limit before building any of it", async () => {
    const base = new Uint8Array(1000).fill(97);
    const baseEntry = plainEntry("blob", base);
    const baseBytes = makePack([baseEntry]).length - 12 - 20;
    // 100 000 copies of the base: a few hundred KB of delta that would build a 95 MiB object.
    const delta = copyDelta(1000, 100_000 * 1000, 100_000, 1000);
    const download = makePack([
      baseEntry,
      {
        type: 6,
        stated: delta.length,
        deflated: deflateSync(delta),
        backBy: baseBytes,
      },
    ]);
    expect(download.length).toBeLessThan(MIB);
    serve(download);
    // The biggest buffer the library joined together while it worked: the delta's target would be one.
    let biggest = 0;
    const concat = Buffer.concat;
    const watch = vi
      .spyOn(Buffer, "concat")
      .mockImplementation((...args: Parameters<typeof concat>) => {
        const joined = concat(...args);
        biggest = Math.max(biggest, joined.length);
        return joined;
      });
    let error: unknown;
    try {
      error = await opened();
    } finally {
      watch.mockRestore();
    }
    expect(error).toBeInstanceOf(BrainTooBigError);
    expect(brainFailureWords(error)).toBe(SENTENCE);
    // Only the base and the delta itself were inflated, and nothing near the 95 MiB it asked for was built.
    expect(inflated).toBeLessThan(MIB);
    expect(biggest).toBeLessThan(2 * MIB);
  });
});

describe("the limits", () => {
  it("are plain numbers that fit a brain's few text files", () => {
    expect(UNPACK_OBJECT_MAX_BYTES).toBe(MIB);
    expect(UNPACK_TOTAL_MAX_BYTES).toBe(8 * MIB);
    expect(brainFailureWords(new BrainTooBigError())).toBe(SENTENCE);
    expect(BRAIN_WORDS.tooBig).toBe("This file is too long to show here.");
  });

  it("let two reads run one after the other, each with its own count", async () => {
    const seen: number[] = [];
    const run = (bytes: number) =>
      withUnpackLimits(
        async () => {
          await Promise.resolve();
          seen.push(bytes);
        },
        { object: 1, total: 1, produced: 0 },
      );
    await Promise.all([run(1), run(2), run(3)]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("come off even when the download fails, and a failure that is not a limit is passed on as it was", async () => {
    const boom = new Error("the connection dropped");
    await expect(
      withUnpackLimits(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(
      (globalThis as Record<symbol, unknown>)[
        Symbol.for("creaton.isomorphic-git.unpackLimits")
      ],
    ).toBeUndefined();
  });
});
