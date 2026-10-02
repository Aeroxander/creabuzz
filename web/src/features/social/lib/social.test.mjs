/**
 * The social client's pure core under `node --test`: post shapes other Nostr
 * clients read, engagement counts, timeline rows and reposts, notifications,
 * discovery signals, NIP-17 direct messages (with real keys) and lists.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as nip44 from "nostr-tools/nip44";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure";
import { createWrap } from "nostr-tools/nip59";

import { replacementTimestamp } from "../../feed/lib/feed-events.ts";
import { withPerson } from "../../feed/lib/lists.ts";

import {
  isImageUrl,
  mentionedPubkeys,
  quotedEventIds,
  tokenize,
} from "./content.ts";
import { computeEngagement } from "./engagement.ts";
import { mentionUri, neventOf, npubOf, parseEntity } from "./entity.ts";
import {
  bookmarkedIds,
  mutedPeople,
  parsePrivateTags,
  withBookmark,
  withMuted,
} from "./lists.ts";
import {
  createDirectMessageWraps,
  dmRelays,
  groupConversations,
  openGiftWrap,
} from "./nip17.ts";
import { buildNotifications, groupNotifications } from "./notifications.ts";
import {
  buildLike,
  buildQuote,
  buildRepost,
  buildSocialPost,
  buildSocialReply,
  buildUndo,
  withMentions,
} from "./post-events.ts";
import {
  buildRows,
  embeddedRepostTarget,
  repostTargetsToFetch,
  sortNewestFirst,
} from "./timeline.ts";
import {
  mostFollowed,
  scoreNotes,
  topIds,
  trendingHashtags,
} from "./trending.ts";

const hex = (c) => c.repeat(64);
const ALICE = hex("a");
const BOB = hex("b");
const CAROL = hex("c");

function ev(over) {
  return {
    pubkey: BOB,
    created_at: 1000,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

/** A properly signed event, so signature checks have something real to verify. */
function signed(sk, template) {
  return finalizeEvent(
    { created_at: 1000, tags: [], content: "", ...template },
    sk,
  );
}

describe("entities and content", () => {
  it("parses hex keys, npub, nprofile and nevent, with or without nostr:", () => {
    assert.deepEqual(parseEntity(ALICE), { type: "pubkey", pubkey: ALICE });
    assert.deepEqual(parseEntity(`nostr:${npubOf(BOB)}`), {
      type: "pubkey",
      pubkey: BOB,
    });
    assert.deepEqual(parseEntity(neventOf(hex("1"), ALICE)), {
      type: "event",
      id: hex("1"),
      author: ALICE,
    });
    assert.equal(parseEntity("not-an-entity"), null);
    assert.equal(parseEntity("npub1garbage"), null);
  });

  it("tokenizes links, hashtags, mentions, quotes and images", () => {
    const text = `hi ${mentionUri(BOB)} #Buzz https://example.com/a.png and https://example.com/page. nostr:${neventOf(hex("2"))}`;
    const types = tokenize(text)
      .filter((t) => t.type !== "text")
      .map((t) => t.type);
    assert.deepEqual(types, ["mention", "hashtag", "image", "link", "event"]);
    const tag = tokenize("#Buzz").find((t) => t.type === "hashtag");
    assert.equal(tag.tag, "buzz");
  });

  it("keeps trailing punctuation out of a link and ignores mid-word #", () => {
    const link = tokenize("see https://example.com/x, ok").find(
      (t) => t.type === "link",
    );
    assert.equal(link.url, "https://example.com/x");
    assert.equal(
      tokenize("a#notatag").some((t) => t.type === "hashtag"),
      false,
    );
  });

  it("leaves an unparseable nostr: reference as text", () => {
    const tokens = tokenize("nostr:npub1nope");
    assert.deepEqual(tokens, [{ type: "text", text: "nostr:npub1nope" }]);
  });

  it("lists mentioned people and quoted notes once each", () => {
    const text = `${mentionUri(BOB)} ${mentionUri(BOB)} nostr:${neventOf(hex("3"))}`;
    assert.deepEqual(mentionedPubkeys(text), [BOB]);
    assert.deepEqual(quotedEventIds(text), [hex("3")]);
  });

  it("only treats real http images as images", () => {
    assert.equal(isImageUrl("https://x.test/a.JPG?w=1"), true);
    assert.equal(isImageUrl("javascript:alert(1).png"), false);
    assert.equal(isImageUrl("https://x.test/a.txt"), false);
  });
});

describe("post events", () => {
  it("a post carries hashtag and mention tags", () => {
    const post = buildSocialPost(`hello ${mentionUri(BOB)} #Buzz`);
    assert.equal(post.kind, 1);
    assert.deepEqual(post.tags, [
      ["t", "buzz"],
      ["p", BOB],
    ]);
  });

  it("does not duplicate a p tag that is already present", () => {
    const out = withMentions({
      kind: 1,
      tags: [["p", BOB]],
      content: mentionUri(BOB),
    });
    assert.equal(out.tags.filter((t) => t[0] === "p").length, 1);
  });

  it("a reply uses NIP-10 markers and notifies the people involved", () => {
    const root = ev({ id: hex("1"), kind: 1, pubkey: ALICE });
    const parent = ev({ id: hex("2"), kind: 1, pubkey: CAROL });
    const reply = buildSocialReply({ text: "agreed", root, parent });
    assert.deepEqual(reply.tags.slice(0, 2), [
      ["e", hex("1"), "", "root"],
      ["e", hex("2"), "", "reply"],
    ]);
    const people = reply.tags.filter((t) => t[0] === "p").map((t) => t[1]);
    assert.deepEqual(people.sort(), [ALICE, CAROL].sort());
  });

  it("a quote post has a q tag, a nevent link and tags the author", () => {
    const quoted = ev({ id: hex("5"), kind: 1, pubkey: ALICE });
    const quote = buildQuote({ text: "this is it", quoted });
    assert.ok(quote.tags.some((t) => t[0] === "q" && t[1] === hex("5")));
    assert.ok(quote.tags.some((t) => t[0] === "p" && t[1] === ALICE));
    assert.deepEqual(quotedEventIds(quote.content), [hex("5")]);
    assert.throws(() => buildQuote({ text: "  ", quoted }), /Write something/);
  });

  it("a repost embeds the original; an undo is a NIP-09 deletion", () => {
    const note = ev({ id: hex("6"), kind: 1, pubkey: ALICE, content: "hi" });
    const repost = buildRepost(note);
    assert.equal(repost.kind, 6);
    assert.deepEqual(repost.tags, [
      ["e", hex("6")],
      ["p", ALICE],
    ]);
    assert.equal(JSON.parse(repost.content).id, hex("6"));
    assert.deepEqual(buildUndo(hex("9"), 6), {
      kind: 5,
      tags: [
        ["e", hex("9")],
        ["k", "6"],
      ],
      content: "",
    });
  });

  it("a like is the + reaction naming the note, its author and kind", () => {
    const like = buildLike(ev({ id: hex("7"), kind: 1, pubkey: ALICE }));
    assert.equal(like.kind, 7);
    assert.equal(like.content, "+");
    assert.deepEqual(like.tags.slice(0, 3), [
      ["e", hex("7")],
      ["p", ALICE],
      ["k", "1"],
    ]);
  });
});

describe("engagement", () => {
  const target = hex("1");
  it("counts likes, reposts, quotes and direct replies once each", () => {
    const like = ev({
      id: hex("2"),
      kind: 7,
      content: "+",
      pubkey: ALICE,
      tags: [["e", target]],
    });
    const related = [
      like,
      like, // delivered twice
      ev({ id: hex("3"), kind: 7, content: "-", tags: [["e", target]] }),
      ev({ id: hex("4"), kind: 6, pubkey: ALICE, tags: [["e", target]] }),
      ev({ id: hex("5"), kind: 1, tags: [["q", target]] }),
      ev({ id: hex("6"), kind: 1, tags: [["e", target, "", "reply"]] }),
      // a deeper reply names the target only as root
      ev({
        id: hex("7"),
        kind: 1,
        tags: [
          ["e", target, "", "root"],
          ["e", hex("6"), "", "reply"],
        ],
      }),
    ];
    assert.deepEqual(computeEngagement([target], related, ALICE).get(target), {
      likes: 1,
      reposts: 1,
      quotes: 1,
      replies: 1,
      likedByViewer: true,
      viewerRepostId: hex("4"),
    });
  });

  it("starts every requested id at zero", () => {
    const out = computeEngagement([target], [], null);
    assert.equal(out.get(target).likes, 0);
    assert.equal(out.get(target).viewerRepostId, null);
  });
});

describe("timeline rows", () => {
  const authorKey = generateSecretKey();
  const author = getPublicKey(authorKey);
  const reposterKey = generateSecretKey();
  const reposter = getPublicKey(reposterKey);

  const original = signed(authorKey, {
    kind: 1,
    content: "the original",
    created_at: 100,
  });

  it("sorts newest first and drops duplicate ids", () => {
    const a = ev({ id: hex("1"), created_at: 5 });
    const b = ev({ id: hex("2"), created_at: 9 });
    assert.deepEqual(
      sortNewestFirst([a, b, a]).map((e) => e.id),
      [hex("2"), hex("1")],
    );
  });

  it("resolves a repost with an authentic embed and keeps who reposted", () => {
    const repost = signed(reposterKey, {
      kind: 6,
      created_at: 500,
      tags: [
        ["e", original.id],
        ["p", author],
      ],
      content: JSON.stringify(original),
    });
    const rows = buildRows([repost]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event.content, "the original");
    assert.deepEqual(rows[0].repostedBy, { pubkey: reposter, at: 500 });
    assert.deepEqual(repostTargetsToFetch([repost]), []);
  });

  it("ignores a forged embed and asks for the real note by id", () => {
    const forged = { ...original, content: "words in your mouth" };
    const repost = signed(reposterKey, {
      kind: 6,
      created_at: 500,
      tags: [["e", original.id]],
      content: JSON.stringify(forged),
    });
    assert.equal(embeddedRepostTarget(repost), null);
    assert.deepEqual(repostTargetsToFetch([repost]), [original.id]);
    // Without the fetched original the row is skipped, never the forgery.
    assert.deepEqual(buildRows([repost]), []);
    const rows = buildRows([repost], new Map([[original.id, original]]));
    assert.equal(rows[0].event.content, "the original");
  });

  it("shows a note once, at its newest appearance", () => {
    const repost = signed(reposterKey, {
      kind: 6,
      created_at: 900,
      tags: [["e", original.id]],
      content: JSON.stringify(original),
    });
    const rows = buildRows([original, repost]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repostedBy.at, 900);
  });

  it("reads reply position from NIP-10 tags", () => {
    const reply = ev({
      id: hex("8"),
      kind: 1,
      tags: [
        ["e", hex("1"), "", "root"],
        ["e", hex("2"), "", "reply"],
      ],
    });
    const [row] = buildRows([reply]);
    assert.equal(row.rootId, hex("1"));
    assert.equal(row.replyToId, hex("2"));
  });
});

describe("notifications", () => {
  const ME = ALICE;
  it("covers likes, reposts, quotes, replies, mentions and follows", () => {
    const events = [
      ev({
        id: hex("1"),
        kind: 7,
        content: "+",
        created_at: 10,
        tags: [["e", hex("9")]],
      }),
      ev({
        id: hex("2"),
        kind: 7,
        content: "-",
        created_at: 11,
        tags: [["e", hex("9")]],
      }),
      ev({ id: hex("3"), kind: 6, created_at: 12, tags: [["e", hex("9")]] }),
      ev({
        id: hex("4"),
        kind: 1,
        created_at: 13,
        tags: [["e", hex("9"), "", "reply"]],
      }),
      ev({ id: hex("5"), kind: 1, created_at: 14, tags: [["p", ME]] }),
      ev({ id: hex("6"), kind: 3, created_at: 15, tags: [["p", ME]] }),
      ev({ id: hex("7"), kind: 3, created_at: 16, tags: [["p", CAROL]] }),
      ev({
        id: hex("8"),
        kind: 7,
        content: "+",
        pubkey: ME,
        tags: [["e", hex("9")]],
      }),
      ev({ id: hex("a"), kind: 1, created_at: 17, tags: [["q", hex("9")]] }),
    ];
    assert.deepEqual(
      buildNotifications(events, ME).map((n) => n.kind),
      ["quote", "follow", "mention", "reply", "repost", "like"],
    );
  });

  it("keeps only each account's newest follow", () => {
    const items = buildNotifications(
      [
        ev({ id: hex("1"), kind: 3, created_at: 5, tags: [["p", ME]] }),
        ev({ id: hex("2"), kind: 3, created_at: 9, tags: [["p", ME]] }),
      ],
      ME,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].at, 9);
  });

  it("groups likes on the same note into one row", () => {
    const like = (id, who, at) =>
      ev({
        id,
        kind: 7,
        content: "+",
        pubkey: who,
        created_at: at,
        tags: [["e", hex("9")]],
      });
    const groups = groupNotifications(
      buildNotifications(
        [
          like(hex("1"), BOB, 1),
          like(hex("2"), CAROL, 2),
          like(hex("3"), BOB, 3),
        ],
        ME,
      ),
    );
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].actors, [BOB, CAROL]);
  });
});

describe("discovery signals", () => {
  it("weighs reposts and replies above likes", () => {
    const a = hex("1");
    const b = hex("2");
    const scores = scoreNotes([
      ev({ id: hex("3"), kind: 7, content: "+", tags: [["e", a]] }),
      ev({ id: hex("4"), kind: 7, content: "+", tags: [["e", a]] }),
      ev({ id: hex("5"), kind: 6, tags: [["e", b]] }),
      ev({ id: hex("6"), kind: 1, tags: [["e", b, "", "reply"]] }),
      ev({ id: hex("7"), kind: 7, content: "-", tags: [["e", a]] }),
    ]);
    assert.equal(scores.get(a), 2);
    assert.equal(scores.get(b), 4);
    assert.deepEqual(topIds(scores, 1), [b]);
  });

  it("counts a hashtag once per author", () => {
    const note = (id, who, content) =>
      ev({ id, kind: 1, pubkey: who, content });
    assert.deepEqual(
      trendingHashtags(
        [
          note(hex("1"), BOB, "#buzz #buzz again"),
          note(hex("2"), BOB, "#buzz"),
          note(hex("3"), CAROL, "#buzz #nostr"),
        ],
        5,
      ),
      [
        { tag: "buzz", count: 2 },
        { tag: "nostr", count: 1 },
      ],
    );
  });

  it("ranks who-to-follow by followers and skips excluded accounts", () => {
    const list = (author, follows, at = 1) =>
      ev({
        id: author.slice(0, 1).repeat(64) + String(at).padStart(0, "0"),
        kind: 3,
        pubkey: author,
        created_at: at,
        tags: follows.map((p) => ["p", p]),
      });
    const X = hex("x");
    const Y = hex("y");
    const result = mostFollowed(
      [
        list(BOB, [X, Y]),
        list(CAROL, [X, ALICE]),
        list(hex("d"), [X, Y]),
        list(BOB, [Y], 0), // BOB's stale list must not count twice
      ],
      new Set([ALICE]),
      5,
    );
    assert.deepEqual(result, [
      { pubkey: X, followers: 3 },
      { pubkey: Y, followers: 2 },
    ]);
  });
});

/** A signer backed by a raw key, standing in for a passkey / extension signer. */
function signerFor(sk) {
  return {
    pubkey: getPublicKey(sk),
    sign: async (template) =>
      finalizeEvent({ created_at: 1000, ...template }, sk),
    encrypt: async (peer, text) =>
      nip44.encrypt(text, nip44.getConversationKey(sk, peer)),
    decrypt: async (peer, text) =>
      nip44.decrypt(text, nip44.getConversationKey(sk, peer)),
  };
}

describe("NIP-17 direct messages", () => {
  const alice = signerFor(generateSecretKey());
  const bob = signerFor(generateSecretKey());
  const mallory = signerFor(generateSecretKey());

  it("lets the recipient and the sender each open their own wrap", async () => {
    const { toRecipient, toSelf, rumorId } = await createDirectMessageWraps(
      alice,
      bob.pubkey,
      "hello bob",
    );
    const received = await openGiftWrap(bob, toRecipient);
    assert.equal(received.content, "hello bob");
    assert.equal(received.from, alice.pubkey);
    assert.equal(received.peer, alice.pubkey);
    const sent = await openGiftWrap(alice, toSelf);
    assert.equal(sent.peer, bob.pubkey);
    assert.equal(sent.id, rumorId);
    assert.equal(received.id, rumorId);
  });

  it("hides the sender: the wrap is authored by a throwaway key", async () => {
    const { toRecipient } = await createDirectMessageWraps(
      alice,
      bob.pubkey,
      "x",
    );
    assert.equal(toRecipient.kind, 1059);
    assert.notEqual(toRecipient.pubkey, alice.pubkey);
    assert.deepEqual(toRecipient.tags, [["p", bob.pubkey]]);
    assert.ok(!toRecipient.content.includes("hello"));
  });

  it("cannot be opened by anyone else", async () => {
    const { toRecipient } = await createDirectMessageWraps(
      alice,
      bob.pubkey,
      "secret",
    );
    assert.equal(await openGiftWrap(mallory, toRecipient), null);
  });

  it("rejects a rumor that claims a different author than the seal's signer", async () => {
    const rumor = {
      kind: 14,
      created_at: 1000,
      tags: [["p", bob.pubkey]],
      content: "send money",
      pubkey: alice.pubkey,
    };
    const seal = await mallory.sign({
      kind: 13,
      tags: [],
      content: await mallory.encrypt(
        bob.pubkey,
        JSON.stringify({ ...rumor, id: getEventHash(rumor) }),
      ),
    });
    assert.equal(await openGiftWrap(bob, createWrap(seal, bob.pubkey)), null);
  });

  it("skips group conversations", async () => {
    const rumor = {
      kind: 14,
      created_at: 1000,
      tags: [
        ["p", bob.pubkey],
        ["p", mallory.pubkey],
      ],
      content: "group",
      pubkey: alice.pubkey,
    };
    const seal = await alice.sign({
      kind: 13,
      tags: [],
      content: await alice.encrypt(
        bob.pubkey,
        JSON.stringify({ ...rumor, id: getEventHash(rumor) }),
      ),
    });
    assert.equal(await openGiftWrap(bob, createWrap(seal, bob.pubkey)), null);
  });

  it("refuses an empty message", async () => {
    await assert.rejects(
      createDirectMessageWraps(alice, bob.pubkey, "   "),
      /Write something/,
    );
  });

  it("groups conversations, de-duplicating the two wraps of one message", () => {
    const m = (id, peer, at) => ({
      id,
      wrapId: `w${id}${at}`,
      from: peer,
      peer,
      content: id,
      at,
    });
    const groups = groupConversations([
      m("1", "bob", 10),
      m("1", "bob", 10),
      m("2", "bob", 30),
      m("3", "carol", 40),
      m("4", "carol", 20),
    ]);
    assert.deepEqual(
      groups.map((g) => g.peer),
      ["carol", "bob"],
    );
    assert.deepEqual(
      groups[0].messages.map((x) => x.id),
      ["4", "3"],
    );
    assert.deepEqual(
      groups[1].messages.map((x) => x.id),
      ["1", "2"],
    );
    assert.equal(groups[1].last.id, "2");
  });

  it("reads delivery relays from a kind 10050 list", () => {
    assert.deepEqual(
      dmRelays({
        tags: [
          ["relay", "wss://a.example/"],
          ["relay", "wss://a.example"],
          ["relay", "https://nope.example"],
          ["relay", "wss://b.example"],
        ],
      }),
      ["wss://a.example", "wss://b.example"],
    );
    assert.deepEqual(dmRelays(null), []);
  });
});

describe("mute and bookmark lists", () => {
  it("mutes and unmutes while keeping other tags and content", () => {
    const list = ev({
      id: hex("1"),
      kind: 10000,
      tags: [
        ["p", BOB],
        ["word", "spoiler"],
      ],
      content: "encrypted-private-part",
    });
    const muted = withMuted(list, CAROL, true);
    assert.equal(muted.kind, 10000);
    assert.deepEqual(muted.tags, [
      ["p", BOB],
      ["word", "spoiler"],
      ["p", CAROL],
    ]);
    assert.equal(muted.content, "encrypted-private-part");
    assert.deepEqual(
      withMuted({ ...list, tags: muted.tags }, BOB, false).tags,
      [
        ["word", "spoiler"],
        ["p", CAROL],
      ],
    );
    assert.deepEqual([...mutedPeople(list)], [BOB]);
  });

  it("keeps launch follows and public tags when saving a note privately", () => {
    const list = ev({
      id: hex("1"),
      kind: 10003,
      tags: [
        ["a", "37001:abc:launch"],
        ["e", hex("5")],
      ],
    });
    const next = withBookmark(list, [["e", hex("6")]], hex("7"), true);
    assert.deepEqual(next.tags, [
      ["a", "37001:abc:launch"],
      ["e", hex("5")],
    ]);
    assert.deepEqual(next.privateTags, [
      ["e", hex("6")],
      ["e", hex("7")],
    ]);
    assert.deepEqual(bookmarkedIds(list, next.privateTags), [
      hex("5"),
      hex("6"),
      hex("7"),
    ]);
  });

  it("removing a bookmark clears both the public and the private entry", () => {
    const list = ev({ id: hex("1"), kind: 10003, tags: [["e", hex("5")]] });
    const next = withBookmark(
      list,
      [
        ["e", hex("5")],
        ["e", hex("6")],
      ],
      hex("5"),
      false,
    );
    assert.deepEqual(next.tags, []);
    assert.deepEqual(next.privateTags, [["e", hex("6")]]);
  });

  it("parses private tags and rejects anything that is not a tag array", () => {
    assert.deepEqual(parsePrivateTags(null), []);
    assert.deepEqual(parsePrivateTags('[["e","x"],"junk",["e",1]]'), [
      ["e", "x"],
    ]);
    assert.throws(() => parsePrivateTags('{"a":1}'), /not a tag array/);
    assert.throws(() => parsePrivateTags("not json"));
  });
});

describe("replaceable edits", () => {
  it("always land one second after the version they replace", () => {
    assert.equal(replacementTimestamp({ created_at: 100 }, 100), 101);
    assert.equal(replacementTimestamp({ created_at: 100 }, 5000), 5000);
    assert.equal(replacementTimestamp(null, 5000), 5000);
  });

  it("so a follow then an immediate unfollow cannot lose to a same-second tie", () => {
    const now = Math.floor(Date.now() / 1000);
    const list = ev({ id: hex("1"), kind: 3, created_at: now, tags: [] });
    const followed = withPerson(list, ALICE, true);
    assert.ok(followed.created_at > list.created_at);
    const next = ev({
      id: hex("2"),
      kind: 3,
      created_at: followed.created_at,
      tags: followed.tags,
    });
    assert.ok(withPerson(next, ALICE, false).created_at > next.created_at);
  });

  it("applies to mutes and bookmarks too", () => {
    const now = Math.floor(Date.now() / 1000);
    const mutes = ev({ id: hex("1"), kind: 10000, created_at: now });
    assert.ok(withMuted(mutes, BOB, true).created_at > mutes.created_at);
    const saved = ev({ id: hex("2"), kind: 10003, created_at: now });
    assert.ok(
      withBookmark(saved, [], hex("3"), true).created_at > saved.created_at,
    );
  });
});
