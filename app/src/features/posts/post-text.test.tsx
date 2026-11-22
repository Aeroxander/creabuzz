// A post's #topics open the posts under that topic: only a topic the post is tagged with (its first five) is a link, so a link
// always leads to a page that holds this post, and the words around it are kept exactly.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "../safety/social-harness";

vi.mock("@tanstack/react-router", async (actual) =>
  (await import("../safety/social-harness")).routerMock(actual),
);
void routerMock;

import { PostText, topicParts } from "./PostCard";

afterEach(cleanup);

describe("the topics in a post", () => {
  it("cuts the text into words and topics and keeps every character", () => {
    const text = "Lit the #lamps today, #solar!\nNext: #night-market";
    const parts = topicParts(text);
    expect(parts.map((p) => ("topic" in p ? p.label : p.text)).join("")).toBe(
      text,
    );
    expect(
      parts
        .filter((p) => "topic" in p)
        .map((p) => ("topic" in p ? p.topic : "")),
    ).toEqual(["lamps", "solar", "night-market"]);
  });

  it("makes a link of a topic and the topic is the lower-case one the page reads", () => {
    render(<PostText text="Hello #Lamps world" />);
    const link = screen.getByRole("link", { name: "#Lamps" });
    expect(link.getAttribute("href")).toBe("/tag/lamps");
  });

  it("links no more than the five topics a post is tagged with", () => {
    render(<PostText text="#aa #bb #cc #dd #ee #ff" />);
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "#aa",
      "#bb",
      "#cc",
      "#dd",
      "#ee",
    ]);
    expect(screen.getByText(/#ff/)).toBeTruthy();
  });

  it("does not link a # inside a word or a lone #", () => {
    render(<PostText text="issue#12 and # alone and #a" />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("draws what was written as text: markup in a post is shown, never run", () => {
    const text =
      '<img src=x onerror="alert(1)"><script>window.x=1</script> #lamps';
    const { container } = render(<PostText text={text} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelector("img, script")).toBeNull();
  });
});
