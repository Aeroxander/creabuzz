// A part of the page that throws while drawing (a chunk that did not load) is caught: it says so with a press to reload, or, for
// a helper, draws nothing; whatever is beside it stays.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHUNK_FAILED, ChunkBoundary } from "./chunk-boundary";

function Broken(): never {
  throw new Error("Failed to fetch dynamically imported module");
}
afterEach(cleanup);

describe("the chunk boundary", () => {
  it("says the part could not load and offers a reload, and leaves its neighbours alone", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <div>
        <p>beside</p>
        <ChunkBoundary>
          <Broken />
        </ChunkBoundary>
      </div>,
    );
    spy.mockRestore();
    expect(screen.getByText("beside")).toBeTruthy();
    expect(screen.getByTestId("chunk-failed").textContent).toContain(
      CHUNK_FAILED,
    );
    expect(
      screen.getByRole("button", { name: "Reload the page" }),
    ).toBeTruthy();
  });

  it("draws nothing for a helper that fails", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <ChunkBoundary quiet>
        <Broken />
      </ChunkBoundary>,
    );
    spy.mockRestore();
    expect(container.firstChild).toBeNull();
  });

  it("draws its children when nothing fails", () => {
    render(
      <ChunkBoundary>
        <p>fine</p>
      </ChunkBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });
});
