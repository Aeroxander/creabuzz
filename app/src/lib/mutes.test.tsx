// Hiding a person for yourself: the private mute list, sealed to your own key. Reading it keeps the people already hidden,
// hiding and showing again change only that person and keep what else the list holds, and a list this app cannot read is
// never overwritten.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "a".repeat(64);
const ANA = "b".repeat(64);
const BO = "c".repeat(64);
// A stand-in for the sealing: the real one needs the person's key. The shape (base64, version byte 2, long enough) is what the list's own checks need.
const seal = (plain: string) => `AgAA${btoa(plain + " ".repeat(80))}`;
const open = (sealed: string) => atob(sealed.slice(4));

let list: { content: string; tags: string[][]; created_at: number } | null =
  null;
const published: { kind: number; tags: string[][]; content: string }[] = [];
vi.mock("./account", () => ({
  useAccount: () => ({ pubkey: ME, locked: false }),
}));
vi.mock("./relay", () => ({
  readLatest: async () =>
    list ? { id: "l", pubkey: ME, kind: 10000, ...list } : null,
  publishAsUser: async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    published.push(template);
    list = { content: template.content, tags: template.tags, created_at: 9 };
  },
}));
vi.mock("@creaton/core/client/identity.ts", () => ({
  nip44EncryptAsUser: async (_peer: string, plain: string) => seal(plain),
  nip44DecryptAsUser: async (_peer: string, sealed: string) => open(sealed),
}));

import { useMutes } from "./mutes";

function hook() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMutes(), { wrapper });
}

const hidden = () =>
  (JSON.parse(open(published.at(-1)?.content ?? "")) as string[][]).map(
    (t) => t[1],
  );

beforeEach(() => {
  list = null;
  published.length = 0;
});

describe("hiding people for yourself", () => {
  it("starts with nobody hidden and says when it has read the list", async () => {
    const { result } = hook();
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.muted.size).toBe(0);
  });

  it("hides one person, keeps the others, and shows one again", async () => {
    const { result } = hook();
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.hide(ANA));
    expect(published.at(-1)?.kind).toBe(10000);
    expect(hidden()).toEqual([ANA]);
    await waitFor(() => expect(result.current.muted.has(ANA)).toBe(true));
    await act(() => result.current.hide(BO));
    expect(hidden().sort()).toEqual([ANA, BO]);
    await act(() => result.current.showAgain(ANA));
    expect(hidden()).toEqual([BO]);
    // Nothing public names the people hidden: the names are only in the sealed part.
    expect(published.at(-1)?.tags.some((t) => t[0] === "p")).toBe(false);
  });

  it("keeps the list's other entries (a muted word) when it changes", async () => {
    list = { content: "", tags: [["word", "spoiler"]], created_at: 5 };
    const { result } = hook();
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.hide(ANA));
    expect(published.at(-1)?.tags).toEqual([["word", "spoiler"]]);
  });

  it("does not overwrite a list another app saved in a form this one cannot read", async () => {
    list = {
      content: "not sealed the way this app reads",
      tags: [],
      created_at: 5,
    };
    const { result } = hook();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.readable).toBe(false);
    await expect(act(() => result.current.hide(ANA))).rejects.toThrow(
      /can't read/,
    );
    expect(published).toHaveLength(0);
  });
});
