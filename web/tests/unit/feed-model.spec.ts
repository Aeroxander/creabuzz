import { expect, test } from "@playwright/test";
import type { NostrEvent } from "../../src/shared/lib/nostr-client";
import {
  computeMeta,
  embeddedRepostTarget,
  hashtagsOf,
  lastTagValue,
  mentionEntitiesOf,
  parentIdOf,
  parseProfile,
  tagValues,
} from "../../src/features/feed/feed-model";

const hex = (c: string) => c.repeat(64);

function ev(
  over: Partial<NostrEvent> & Pick<NostrEvent, "id" | "kind">,
): NostrEvent {
  return {
    pubkey: hex("a"),
    created_at: 1000,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

test("parentIdOf prefers the reply marker, then root, then the last e tag", () => {
  const reply = ev({
    id: hex("1"),
    kind: 1,
    tags: [
      ["e", hex("2"), "", "root"],
      ["e", hex("3"), "", "reply"],
    ],
  });
  expect(parentIdOf(reply)).toBe(hex("3"));
  expect(
    parentIdOf(
      ev({ id: hex("1"), kind: 1, tags: [["e", hex("2"), "", "root"]] }),
    ),
  ).toBe(hex("2"));
  expect(
    parentIdOf(
      ev({
        id: hex("1"),
        kind: 1,
        tags: [
          ["e", hex("4")],
          ["e", hex("5")],
        ],
      }),
    ),
  ).toBe(hex("5"));
  expect(parentIdOf(ev({ id: hex("1"), kind: 1 }))).toBeNull();
});

test("hashtags are lowercased, de-duplicated and ignore mid-word #", () => {
  expect(hashtagsOf("Hi #Nostr and #nostr, #buzz_dev! a#notatag")).toEqual([
    "nostr",
    "buzz_dev",
  ]);
});

test("mention entities come only from nostr: URIs", () => {
  const text = "cc nostr:npub1abc nostr:nprofile1xyz npub1bare nostr:note1zzz";
  expect(mentionEntitiesOf(text)).toEqual(["npub1abc", "nprofile1xyz"]);
});

test("tag helpers de-duplicate and pick the last value", () => {
  const tags = [
    ["p", "a"],
    ["p", "b"],
    ["p", "a"],
    ["e", "x"],
  ];
  expect(tagValues(tags, "p")).toEqual(["a", "b"]);
  expect(lastTagValue(tags, "p")).toBe("b");
  expect(lastTagValue(tags, "t")).toBeUndefined();
});

test("parseProfile tolerates malformed JSON and blank fields", () => {
  expect(
    parseProfile(ev({ id: hex("1"), kind: 0, content: "not json" })),
  ).toEqual({
    pubkey: hex("a"),
    name: undefined,
    displayName: undefined,
    picture: undefined,
    banner: undefined,
    about: undefined,
    website: undefined,
    nip05: undefined,
  });
  const profile = parseProfile(
    ev({
      id: hex("1"),
      kind: 0,
      content: JSON.stringify({ name: " ada ", display_name: "", about: "hi" }),
    }),
  );
  expect(profile.name).toBe("ada");
  expect(profile.displayName).toBeUndefined();
  expect(profile.about).toBe("hi");
});

test("computeMeta counts likes, reposts and direct replies once each", () => {
  const target = hex("1");
  const viewer = hex("v");
  const like = ev({
    id: hex("2"),
    kind: 7,
    content: "+",
    pubkey: viewer,
    tags: [["e", target]],
  });
  const related = [
    like,
    like, // duplicate delivery must not double count
    ev({ id: hex("3"), kind: 7, content: "-", tags: [["e", target]] }),
    ev({ id: hex("4"), kind: 6, pubkey: viewer, tags: [["e", target]] }),
    ev({
      id: hex("5"),
      kind: 1,
      tags: [["e", target, "", "reply"]],
    }),
    // A deeper reply mentions the target as root only — not a direct reply.
    ev({
      id: hex("6"),
      kind: 1,
      tags: [
        ["e", target, "", "root"],
        ["e", hex("5"), "", "reply"],
      ],
    }),
  ];
  const meta = computeMeta([target], related, viewer).get(target);
  expect(meta).toEqual({
    replies: 1,
    likes: 1,
    reposts: 1,
    likedByViewer: true,
    viewerRepostId: hex("4"),
  });
});

test("an embedded repost target must carry a valid signature", () => {
  const repost = ev({
    id: hex("9"),
    kind: 6,
    tags: [["e", hex("1")]],
    content: JSON.stringify(ev({ id: hex("1"), kind: 1, content: "forged" })),
  });
  expect(embeddedRepostTarget(repost)).toBeNull();
  expect(embeddedRepostTarget(ev({ id: hex("9"), kind: 6 }))).toBeNull();
});

test("note tags: NIP-10 markers, quote q tag, mentions and hashtags", async () => {
  const { buildNoteTags } = await import("../../src/features/feed/use-feed");
  const { toNpub } = await import("../../src/shared/lib/nip19");
  const author = hex("a");
  const mentioned = hex("c");
  const text = `hi nostr:${toNpub(mentioned)} #Buzz`;

  // Reply to a reply: root + reply markers, author p tag, mention, hashtag.
  expect(
    buildNoteTags(text, { id: hex("2"), author, rootId: hex("1") }),
  ).toEqual([
    ["e", hex("1"), "", "root"],
    ["e", hex("2"), "", "reply"],
    ["p", author],
    ["p", mentioned],
    ["t", "buzz"],
  ]);

  // Reply directly to the root: a single reply marker.
  expect(
    buildNoteTags("ok", { id: hex("1"), author, rootId: hex("1") }),
  ).toEqual([
    ["e", hex("1"), "", "reply"],
    ["p", author],
  ]);

  // Quote post: q tag plus the quoted author, no duplicate p tag if mentioned too.
  expect(
    buildNoteTags(`nostr:${toNpub(author)}`, undefined, {
      id: hex("3"),
      author,
    }),
  ).toEqual([
    ["q", hex("3"), "", author],
    ["p", author],
  ]);
});
