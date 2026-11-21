// What a search looks for and how it picks: words, a topic, posts from two sources once each, projects, people (never a hidden
// one) and the topics people use.
import { describe, expect, it } from "vitest";
import type { Project } from "../project/project-record";
import {
  MAX_PEOPLE,
  MAX_POSTS,
  MAX_WORDS,
  hasAllWords,
  personHits,
  postHits,
  projectHits,
  searchable,
  searchWords,
  topicOfQuery,
  topTopics,
} from "./search-logic";

const post = (
  id: string,
  content: string,
  at: number,
  pubkey = "a".repeat(64),
  tags: string[][] = [],
) => ({
  id: id.repeat(64).slice(0, 64),
  pubkey,
  content,
  created_at: at,
  tags,
});

describe("the words of a search", () => {
  it("lower-cases, splits on spaces and stops at six", () => {
    expect(searchWords("  Solar   LAMPS ")).toEqual(["solar", "lamps"]);
    expect(searchWords("a b c d e f g h")).toHaveLength(MAX_WORDS);
    expect(searchWords("   ")).toEqual([]);
  });

  it("asks only from two letters", () => {
    expect(searchable("a")).toBe(false);
    expect(searchable(" a ")).toBe(false);
    expect(searchable("ab")).toBe(true);
  });

  it("names a topic only for one #word", () => {
    expect(topicOfQuery("#Lamps")).toBe("lamps");
    expect(topicOfQuery("  #lamps  ")).toBe("lamps");
    expect(topicOfQuery("#a")).toBeNull();
    expect(topicOfQuery("#two words")).toBeNull();
    expect(topicOfQuery("lamps")).toBeNull();
  });

  it("needs every word, in any case, and no words matches nothing", () => {
    expect(
      hasAllWords("Solar lamps for night markets", ["solar", "markets"]),
    ).toBe(true);
    expect(hasAllWords("Solar lamps", ["solar", "wind"])).toBe(false);
    expect(hasAllWords("anything", [])).toBe(false);
  });
});

describe("posts found", () => {
  it("lists a post that both ways found once, newest first", () => {
    const a = post("1", "Lamp one", 10);
    const b = post("2", "Lamp two", 30);
    const c = post("3", "Lamp three", 20);
    const hits = postHits([a, b], [b, c], ["lamp"]);
    expect(hits.map((h) => h.id)).toEqual([b.id, c.id, a.id]);
  });

  it("keeps only posts that hold every word, even when the server returned a looser match", () => {
    const looser = post("4", "Lanterns and markets", 5);
    expect(postHits([], [looser], ["lamp"])).toEqual([]);
    expect(postHits([], [looser], ["lanterns", "markets"])).toHaveLength(1);
  });

  it("shows at most the limit", () => {
    const many = Array.from({ length: MAX_POSTS + 10 }, (_, n) =>
      post(n.toString(16).padStart(2, "0"), "lamp", n),
    );
    expect(postHits(many, [], ["lamp"])).toHaveLength(MAX_POSTS);
  });
});

const project = (name: string, pitch: string): Project =>
  ({ name, pitch, coordinate: `37001:${"f".repeat(64)}:${name}` }) as Project;

describe("projects and people found", () => {
  it("finds a project by a word of its name or line", () => {
    const list = [
      project("Lantern", "Solar lamps"),
      project("Seedbank", "Shared seeds"),
    ];
    expect(projectHits(list, ["solar"]).map((p) => p.name)).toEqual([
      "Lantern",
    ]);
    expect(projectHits(list, ["seedbank", "seeds"]).map((p) => p.name)).toEqual(
      ["Seedbank"],
    );
    expect(projectHits(list, ["nothing"])).toEqual([]);
  });

  it("finds people by name or line, leaves out one who is hidden, and cuts at the limit", () => {
    const ana = "a".repeat(64);
    const bo = "b".repeat(64);
    const found = {
      [ana]: { name: "Ana Maker", about: "Makes lamps" },
      [bo]: { display_name: "Bo Maker" },
    };
    expect(personHits(found, ["maker"], new Set())).toEqual([ana, bo]);
    expect(
      personHits(found, ["maker"], new Set([bo.toUpperCase().toLowerCase()])),
    ).toEqual([ana]);
    // The server's index may match a word in a link; what is shown holds the words typed.
    expect(
      personHits(
        { [ana]: { name: "Ana", picture: "https://x/maker.png" } },
        ["maker"],
        new Set(),
      ),
    ).toEqual([]);
    const crowd = Object.fromEntries(
      Array.from({ length: MAX_PEOPLE + 5 }, (_, n) => [
        n.toString(16).padStart(64, "0"),
        { name: "Maker" },
      ]),
    );
    expect(personHits(crowd, ["maker"], new Set())).toHaveLength(MAX_PEOPLE);
  });
});

describe("the topics people use", () => {
  it("counts each topic once per person, most people first, from tags and from the words", () => {
    const x = "a".repeat(64);
    const y = "b".repeat(64);
    const topics = topTopics(
      [
        post("1", "#lamps are good #lamps", 1, x, [["t", "lamps"]]),
        post("2", "more #lamps", 2, y),
        post("3", "#seeds", 3, x),
      ],
      5,
    );
    expect(topics).toEqual([
      { tag: "lamps", people: 2 },
      { tag: "seeds", people: 1 },
    ]);
  });

  it("never offers a room's tag as a topic, and cuts at the limit", () => {
    const topics = topTopics(
      [
        post("1", "hello", 1, "a".repeat(64), [
          ["t", `room:0x${"cd".repeat(32)}`],
        ]),
      ],
      5,
    );
    expect(topics).toEqual([]);
    const many = Array.from({ length: 30 }, (_, n) =>
      post(n.toString(16).padStart(2, "0"), `#topic${n}`, n),
    );
    expect(topTopics(many, 12)).toHaveLength(12);
  });
});
