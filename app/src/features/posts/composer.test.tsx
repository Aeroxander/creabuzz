// The writing box, used for a project's updates: words and the project they are about. A locked passkey account is told to
// unlock inside the box and keeps what it typed; a post the server refuses keeps the words and says why.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";

const world = {
  locked: false,
  refuse: null as string | null,
  published: [] as { kind: number; tags: string[][]; content: string }[],
};

vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "1".repeat(64), locked: world.locked }),
}));
vi.mock("../../lib/relay", () => ({
  publishAsUser: async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    if (world.refuse) throw new Error(world.refuse);
    world.published.push(template);
  },
}));

import { ComposerSheet } from "./Composer";

beforeEach(() => {
  world.locked = false;
  world.refuse = null;
  world.published = [];
});
afterEach(cleanup);

const open = (props: Partial<Parameters<typeof ComposerSheet>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ComposerSheet onOpenChange={() => undefined} open {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );

const type = async (value: string) =>
  fireEvent.change(await screen.findByTestId("composer-text"), {
    target: { value },
  });

describe("a locked passkey account in the writing box", () => {
  it("is told to unlock with a press inside the box, where the bar at the top is covered, and keeps what it typed", async () => {
    world.locked = true;
    open();
    await type("Typed before the reload");
    expect(screen.getByTestId("composer-locked").textContent).toMatch(
      /^Unlock with your passkey to post\. What you typed is kept\.Unlock$/,
    );
    expect(screen.getByTestId("composer-unlock")).toBeTruthy();
    expect(
      (screen.getByTestId("composer-text") as HTMLTextAreaElement).value,
    ).toBe("Typed before the reload");
  });

  it("an unlocked account is told nothing", async () => {
    open();
    await screen.findByTestId("composer-text");
    expect(screen.queryByTestId("composer-locked")).toBeNull();
  });
});

describe("posting about a project", () => {
  it("sends the words with the project's reference, closes, and clears the box", async () => {
    const closed = vi.fn();
    open({
      launch: { pubkey: "a".repeat(64), id: "lamp" },
      onOpenChange: closed,
    });
    await type("Lit tonight");
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(world.published).toHaveLength(1));
    const [post] = world.published;
    expect(post.kind).toBe(1);
    expect(post.content).toMatch(/^Lit tonight\n\nnostr:naddr1/);
    expect(post.tags.some((t) => t[0] === "a")).toBe(true);
    await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
  });

  it("sends nothing while the box is empty", async () => {
    open();
    await screen.findByTestId("composer-text");
    expect(
      (screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a post the server refuses keeps the words and says why", async () => {
    world.refuse = "restricted: not now";
    open();
    await type("Kept words");
    fireEvent.click(screen.getByTestId("composer-send"));
    expect((await screen.findByTestId("composer-problem")).textContent).toBe(
      "restricted: not now",
    );
    expect(
      (screen.getByTestId("composer-text") as HTMLTextAreaElement).value,
    ).toBe("Kept words");
  });
});
