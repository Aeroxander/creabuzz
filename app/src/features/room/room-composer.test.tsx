// The room's composer on the paths that are not a mouse press on Post: a held or repeated Control+Enter posts once, words typed
// while a post is on its way are not thrown away when it lands, and an answer closed with Escape is still there when it is opened
// again (it is the only copy).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { RoomComposer } from "./RoomComposer";

vi.mock("./ConfirmAccount", () => ({ ConfirmAccount: () => null }));

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

const draw = (
  send: (text: string) => Promise<unknown>,
  over: Partial<Parameters<typeof RoomComposer>[0]> = {},
) =>
  render(
    <ToastProvider>
      <RoomComposer draftKey="p1" label="Write" send={send} {...over} />
    </ToastProvider>,
  );
const box = () =>
  screen.getByTestId("room-composer-text") as HTMLTextAreaElement;

describe("the composer", () => {
  it("posts once when Control+Enter is pressed again, or held, while the post is on its way (the keyboard waits like the button)", async () => {
    let release: () => void = () => undefined;
    const send = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    draw(send);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    // A second press that is not a repeat: only the post still on its way stops it.
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true, repeat: true });
    release();
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a held key that has not yet started a post does not start one by repeating", async () => {
    const send = vi.fn(async () => undefined);
    draw(send);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true, repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the words typed while the post was on its way, and clears only what was sent", async () => {
    let release: () => void = () => undefined;
    const send = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    draw(send);
    fireEvent.change(box(), { target: { value: "first" } });
    fireEvent.click(screen.getByTestId("room-composer-send"));
    fireEvent.change(box(), {
      target: { value: "first and a second thought" },
    });
    release();
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(box().value).toBe("first and a second thought");
    // Unchanged while it was sent: cleared, as before.
    fireEvent.change(box(), { target: { value: "plain" } });
    fireEvent.click(screen.getByTestId("room-composer-send"));
    release();
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("an answer closed with Escape comes back with its words when it is opened again", () => {
    const onCancel = vi.fn();
    draw(async () => undefined, { draftKey: "reply:me:post1", onCancel });
    fireEvent.change(box(), { target: { value: "a long considered answer" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    cleanup();
    draw(async () => undefined, { draftKey: "reply:me:post1", onCancel });
    expect(box().value).toBe("a long considered answer");
    // Another post's answer does not get them.
    cleanup();
    draw(async () => undefined, { draftKey: "reply:me:post2", onCancel });
    expect(box().value).toBe("");
  });
});
