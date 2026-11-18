import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCreateChannelEvent } from "../../channels/lib/channel-create-events.ts";
import { boundChannelIds } from "../../launchpad/lib/launch-chat.ts";
import { parseLaunchRecord } from "../../launchpad/models.ts";
import {
  boardOwners,
  boardProject,
  boardsOfProject,
  boardsTheFounderRuns,
  droppedLinksNotice,
  groupBoardsByProject,
  projectKey,
  projectQualifiers,
  tieBoards,
} from "./project-boards.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noChat = { team: null, supporters: null, backers: null, board: null };

function record(over = {}) {
  return {
    id: "nebula",
    author: A,
    name: "Nebula",
    channels: [],
    chat: noChat,
    ...over,
  };
}

describe("the tie: a project's record names its boards", () => {
  it("is written as a channel tag on the record, beside the project's own rooms and board", () => {
    const chat = { ...noChat, team: id(1), supporters: id(2), board: id(3) };
    const { channels } = tieBoards(
      { channels: [], chat },
      [id(4), id(5)],
      new Set(),
    );
    // The same function the record's tags come from.
    assert.deepEqual(boundChannelIds({ channels, chat }), [
      id(1),
      id(2),
      id(3),
      id(4),
      id(5),
    ]);
  });

  it("is read back from a record the server returns", () => {
    const event = {
      id: "e".repeat(64),
      pubkey: A,
      kind: 37001,
      created_at: 100,
      tags: [
        ["d", "nebula"],
        ["name", "Nebula"],
        ["t", "dao-launchpad"],
        ["buzz-channel", id(1)],
        ["buzz-channel", id(2)],
      ],
      content: JSON.stringify({
        pitch: "x",
        stage: "draft",
        chat: { board: id(1) },
      }),
      sig: "s",
    };
    const parsed = parseLaunchRecord(event);
    assert.ok(parsed);
    const project = boardProject({ ...parsed, author: A });
    assert.deepEqual(project.channelIds, [id(1), id(2)]);
    assert.equal(project.ownBoard, id(1));
  });

  it("ignores a record that names nothing", () => {
    const project = boardProject(record());
    assert.deepEqual(project.channelIds, []);
    assert.equal(project.ownBoard, null);
  });
});

describe("tieBoards", () => {
  it("lists boards already named first, then the new ones, then other picked channels", () => {
    const result = tieBoards(
      { channels: [id(10), id(11)], chat: noChat },
      [id(20)],
      new Set([id(11)]),
    );
    assert.deepEqual(result.channels, [id(11), id(20), id(10)]);
    assert.equal(result.dropped, 0);
  });

  it("never names a channel twice and leaves the record's own rooms to the chat", () => {
    const chat = { ...noChat, supporters: id(2) };
    const result = tieBoards(
      { channels: [id(2), id(20)], chat },
      [id(20), id(20), id(2)],
      new Set(),
    );
    assert.deepEqual(result.channels, [id(20)]);
  });

  it("drops other picked channels first when the record is full, and says how many", () => {
    const chat = {
      team: id(1),
      supporters: id(2),
      backers: id(3),
      board: id(4),
    };
    const picked = [id(10), id(11), id(12)];
    const result = tieBoards(
      { channels: picked, chat },
      [id(20), id(21)],
      new Set([id(10)]),
    );
    // 8 allowed, 4 are the record's own: 4 left for 2 new + 1 board + 2 others.
    // New boards are kept first, then the board it named, then the first other pick.
    assert.deepEqual(result.channels, [id(10), id(20), id(21), id(11)]);
    assert.equal(result.dropped, 1);
  });
});

describe("tieBoards when the record is full of boards", () => {
  it("keeps the board just made and drops the last one it already named", () => {
    const chat = {
      team: id(1),
      supporters: id(2),
      backers: id(3),
      board: id(4),
    };
    const existing = [id(10), id(11), id(12), id(13)];
    const result = tieBoards(
      { channels: existing, chat },
      [id(20)],
      new Set(existing),
    );
    assert.deepEqual(result.channels, [id(10), id(11), id(12), id(20)]);
    assert.equal(result.dropped, 1);
  });
});

describe("groupBoardsByProject", () => {
  const nebula = boardProject(
    record({ channels: [id(1), id(2)], chat: { ...noChat, board: id(3) } }),
  );
  const orbit = boardProject(
    record({ id: "orbit", author: B, name: "Orbit", channels: [id(4)] }),
  );
  const boards = [
    { id: id(4) },
    { id: id(9) },
    { id: id(1) },
    { id: id(3) },
    { id: id(2) },
  ];

  it("groups boards under the project that names them, keeping the order given", () => {
    const groups = groupBoardsByProject(boards, [nebula, orbit]);
    assert.deepEqual(
      groups.map((g) => [g.project?.name ?? null, g.boards.map((b) => b.id)]),
      [
        ["Orbit", [id(4)]],
        ["Nebula", [id(1), id(3), id(2)]],
        [null, [id(9)]],
      ],
    );
  });

  it("puts boards no project names under the server, last", () => {
    const groups = groupBoardsByProject(boards, [nebula, orbit]);
    assert.equal(groups.at(-1).project, null);
    assert.deepEqual(groups.at(-1).boards, [{ id: id(9) }]);
  });

  it("falls back to the server for every board when no project names any", () => {
    const groups = groupBoardsByProject(boards, []);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].project, null);
    assert.equal(groups[0].boards.length, boards.length);
  });

  it("treats an unknown or missing tie as a server board", () => {
    // A project naming a board the server does not list changes nothing for the boards it does list.
    const ghost = boardProject(
      record({ id: "ghost", name: "Ghost", channels: [id(77)] }),
    );
    const groups = groupBoardsByProject([{ id: id(9) }], [ghost]);
    assert.deepEqual(groups, [{ project: null, boards: [{ id: id(9) }] }]);
  });

  it("gives a board two projects name to the one that made it its own board, then to the lowest key", () => {
    const named = boardProject(
      record({ id: "p1", author: A, name: "Named", channels: [id(5)] }),
    );
    const owner = boardProject(
      record({
        id: "p2",
        author: B,
        name: "Owner",
        chat: { ...noChat, board: id(5) },
      }),
    );
    const one = groupBoardsByProject([{ id: id(5) }], [named, owner]);
    assert.equal(one[0].project.name, "Owner");
    const other = boardProject(
      record({ id: "p0", author: A, name: "Other", channels: [id(5)] }),
    );
    const two = groupBoardsByProject([{ id: id(5) }], [named, other]);
    assert.equal(two[0].project.key, projectKey(A, "p0"));
    const reversed = groupBoardsByProject([{ id: id(5) }], [other, named]);
    assert.equal(reversed[0].project.key, two[0].project.key);
  });

  it("matches ids whatever their letter case", () => {
    const upper = boardProject(
      record({ channels: ["ABCDEF00-0000-4000-8000-000000000001"] }),
    );
    const groups = groupBoardsByProject(
      [{ id: "abcdef00-0000-4000-8000-000000000001" }],
      [upper],
    );
    assert.equal(groups[0].project.name, "Nebula");
    // And the other way round: the server lists it in capitals, the record in lower case.
    const lower = boardProject(
      record({ channels: ["abcdef00-0000-4000-8000-000000000001"] }),
    );
    const back = groupBoardsByProject(
      [{ id: "ABCDEF00-0000-4000-8000-000000000001" }],
      [lower],
    );
    assert.equal(back[0].project.name, "Nebula");
  });
});

describe("boardsOfProject", () => {
  it("lists a project's own board first, then the rest as the record names them, skipping rooms and missing ones", () => {
    const project = boardProject(
      record({
        channels: [id(1), id(2), id(8)],
        chat: { ...noChat, board: id(2) },
      }),
    );
    const listed = boardsOfProject(project, [
      { id: id(1) },
      { id: id(2) },
      { id: id(6) },
    ]);
    assert.deepEqual(
      listed.map((b) => b.id),
      [id(2), id(1)],
    );
  });
});

describe("a board made for a project", () => {
  it("is an ordinary board on the server: the create event carries nothing about the project", () => {
    const event = buildCreateChannelEvent({
      id: id(1),
      name: "supporters",
      visibility: "open",
      channelType: "forum",
    });
    assert.deepEqual(
      event.tags.map((t) => t[0]),
      ["h", "name", "visibility", "channel_type"],
    );
  });
});

describe("droppedLinksNotice", () => {
  it("says nothing when nothing was dropped, and counts what was in plain words", () => {
    assert.equal(droppedLinksNotice("Nebula", 0), null);
    assert.equal(
      droppedLinksNotice("Nebula", 1),
      "Nebula can link at most 8 rooms and boards, so one you linked earlier is no longer linked.",
    );
    assert.match(
      droppedLinksNotice("Nebula", 3),
      /so 3 you linked earlier are no longer linked\.$/,
    );
  });
});

const ownerRecord = (boardId, owner, at = 100) => ({
  created_at: at,
  tags: [
    ["d", boardId],
    ["p", owner, "", "owner"],
    ["p", "d".repeat(64), "", "member"],
  ],
});

describe("boardOwners", () => {
  it("lists only the owners of each board, from its newest record", () => {
    const owners = boardOwners([
      ownerRecord(id(1), A, 100),
      ownerRecord(id(1), B, 200),
      ownerRecord(id(2).toUpperCase(), A),
    ]);
    assert.deepEqual([...owners.get(id(1))], [B]);
    assert.deepEqual([...owners.get(id(2).toLowerCase())], [A]);
  });
});

describe("boards the founder runs", () => {
  it("leaves out a board the record names but its founder does not run", () => {
    const project = boardProject(
      record({ channels: [id(1), id(2)], chat: { ...noChat, board: id(3) } }),
    );
    const owners = boardOwners([
      ownerRecord(id(1), A),
      ownerRecord(id(2), B),
      ownerRecord(id(3), B),
    ]);
    const mine = boardsTheFounderRuns(project, owners);
    assert.deepEqual(mine.channelIds, [id(1)]);
    assert.equal(mine.ownBoard, null, "an own board the founder does not run");
  });

  it("counts a board with no owner read for nobody", () => {
    const project = boardProject(record({ channels: [id(1)] }));
    assert.deepEqual(boardsTheFounderRuns(project, new Map()).channelIds, []);
  });

  it("matches the founder's key whatever its letter case", () => {
    const project = boardProject(
      record({ author: A.toUpperCase(), channels: [id(1)] }),
    );
    const mine = boardsTheFounderRuns(
      project,
      boardOwners([ownerRecord(id(1), A)]),
    );
    assert.deepEqual(mine.channelIds, [id(1)]);
  });

  it("does not let another project's record pull a board out from under the one that made it", () => {
    const owners = boardOwners([ownerRecord(id(5), A)]);
    // B claims A's board as its own board, which would win the tie-break if it counted.
    const made = boardsTheFounderRuns(
      boardProject(
        record({ id: "p1", author: A, name: "Maker", channels: [id(5)] }),
      ),
      owners,
    );
    const claimer = boardsTheFounderRuns(
      boardProject(
        record({
          id: "p2",
          author: B,
          name: "Claimer",
          chat: { ...noChat, board: id(5) },
        }),
      ),
      owners,
    );
    const groups = groupBoardsByProject([{ id: id(5) }], [claimer, made]);
    assert.equal(groups[0].project.name, "Maker");
  });

  it("does not put a plain server board under a project that only names it", () => {
    const claimer = boardsTheFounderRuns(
      boardProject(record({ channels: [id(6)] })),
      boardOwners([ownerRecord(id(6), B)]),
    );
    const groups = groupBoardsByProject([{ id: id(6) }], [claimer]);
    assert.equal(groups[0].project, null);
  });
});

describe("projectQualifiers", () => {
  const names = { [A]: "Ada", [B]: "Bo" };
  const nameOf = (key) => names[key];
  const ref = (over) => {
    const r = boardProject(record(over));
    return { key: r.key, id: r.id, author: r.author, name: r.name };
  };

  it("adds nothing to a name that is alone", () => {
    const q = projectQualifiers(
      [ref({ name: "Nebula" }), ref({ id: "orbit", name: "Orbit" })],
      nameOf,
    );
    assert.deepEqual([...q.values()], [null, null]);
  });

  it("says who made each of two projects that share a name, whatever the letter case", () => {
    const one = ref({ id: "n1", author: A, name: "Nebula" });
    const two = ref({ id: "n2", author: B, name: " nebula " });
    const q = projectQualifiers([one, two], nameOf);
    assert.equal(q.get(one.key), "by Ada");
    assert.equal(q.get(two.key), "by Bo");
  });

  it("adds the project's address when one person made both", () => {
    const one = ref({ id: "n1", author: A, name: "Nebula" });
    const two = ref({ id: "n2", author: A, name: "Nebula" });
    const q = projectQualifiers([one, two], nameOf);
    assert.equal(q.get(one.key), "by Ada (n1)");
    assert.equal(q.get(two.key), "by Ada (n2)");
  });

  it("still tells two projects apart when their makers share a name and address", () => {
    const same = () => "Someone";
    const one = ref({ id: "n1", author: A, name: "Nebula" });
    const two = ref({ id: "n1", author: B, name: "Nebula" });
    const q = projectQualifiers([one, two], same);
    assert.equal(q.get(one.key), "by Someone (n1), 1 of 2");
    assert.equal(q.get(two.key), "by Someone (n1), 2 of 2");
    assert.notEqual(q.get(one.key), q.get(two.key));
  });
});
