/**
 * The real git library behind the brain reader, ported from web/'s repository browser (`web/src/features/repos/git-client.ts`)
 * and cut down to what a read-only reader needs. It is a lazy chunk: nothing here loads until a person opens a project's
 * brain. The copy of the repository is made in the browser's own file store, read at once, and wiped when the read ends:
 * nothing of a private brain is left on a shared phone, and no module-level state outlives a read.
 */
import { makeNip98AuthHeader } from "@creaton/core/client/nip98.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import {
  type HttpClient,
  withGitDeadline,
} from "@creaton/core/client/git-http.ts";
import type { GitCopy, GitTools } from "./brain-read";
import type { BrainRepo } from "./brain-repo";

/** The most one download may bring (bytes). A brain is notes: a repository bigger than this is not a brain. */
export const DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** The download went over {@link DOWNLOAD_MAX_BYTES}. */
export class BrainTooBigError extends Error {
  constructor() {
    super("The project's files are too big to read here.");
    this.name = "BrainTooBigError";
  }
}

/** The name of the browser file store the copy is made in. */
const STORE_NAME = "creaton-brain";
const DIR = "/brain";

/** The same client, with the bytes that arrive counted: a reply past the cap ends the read. */
export function capped(http: HttpClient): HttpClient {
  let received = 0;
  return {
    async request(request) {
      const reply = await http.request(request);
      const body = reply.body;
      if (!body) return reply;
      const counted: AsyncIterableIterator<Uint8Array> = {
        async next() {
          const step = await body.next();
          if (!step.done) {
            received += step.value.byteLength;
            if (received > DOWNLOAD_MAX_BYTES) throw new BrainTooBigError();
          }
          return step;
        },
        async return() {
          return body.return ? body.return() : { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return counted;
        },
      };
      return { ...reply, body: counted };
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "NotFoundError"
  );
}

/** The git library as the reader's tools. */
export const gitTools: GitTools = {
  async open(repo: BrainRepo): Promise<GitCopy> {
    const [{ Buffer }, lightning, git] = await Promise.all([
      import("buffer"),
      import("@isomorphic-git/lightning-fs"),
      import("isomorphic-git"),
    ]);
    // The git library expects a global Buffer for pack files; the `buffer` package is the browser's.
    const scope = globalThis as { Buffer?: unknown };
    if (scope.Buffer === undefined) scope.Buffer = Buffer;
    const LightningFS = lightning.default;
    const url = `${relayHttpBaseUrl()}/git/${repo.owner}/${repo.id}.git`;
    // One header is signed for the whole read (the server checks the address it names, which is the repository's).
    const headers = { Authorization: await makeNip98AuthHeader(url, "GET") };
    // A fresh, empty store for this read; wiped again when it ends.
    let fs = new LightningFS(STORE_NAME, { wipe: true });
    try {
      await withGitDeadline((http) =>
        git.clone({
          fs,
          http: capped(http),
          dir: DIR,
          url,
          depth: 1,
          singleBranch: true,
          noTags: true,
          headers,
        }),
      );
    } catch (error) {
      fs = new LightningFS(STORE_NAME, { wipe: true });
      throw error;
    }
    const oid = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
    return {
      async list(path) {
        try {
          const { tree } = await git.readTree({
            fs,
            dir: DIR,
            oid,
            filepath: path === "" ? undefined : path,
          });
          return tree.map((entry) => ({
            name: entry.path,
            file: entry.type === "blob",
          }));
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      },
      async read(path, maxBytes) {
        try {
          const { blob } = await git.readBlob({
            fs,
            dir: DIR,
            oid,
            filepath: path,
          });
          return blob.length > maxBytes
            ? { size: blob.length, bytes: null }
            : { size: blob.length, bytes: blob };
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      },
      async close() {
        // Nothing of the files stays in the browser once they are read.
        new LightningFS(STORE_NAME, { wipe: true });
      },
    };
  },
};
