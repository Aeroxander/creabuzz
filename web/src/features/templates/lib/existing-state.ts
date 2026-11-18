/**
 * What the server already holds for a template, read from the records it sent
 * back. Pure and alias-free so `existing-state.test.mjs` drives it under
 * `node --test`.
 *
 * Applying a template writes records with a marker tag (see
 * `@creaton/core/templates/apply.ts`). To skip what is already there, we ask the
 * server for three things and fold them into one {@link ExistingState}: the
 * community's channels (by name), the records carrying this template's marker,
 * and the signer's own organization nodes and budgets.
 */

import {
  canonicalChannelName,
  type ExistingState,
  emptyExisting,
  itemKey,
  markerItem,
  type StepKind,
} from "@creaton/core/templates/apply.ts";

/** The fields of a server record this reads. */
export interface ServerRecord {
  id: string;
  kind: number;
  created_at: number;
  tags: string[][];
}

const KIND_CHANNEL_METADATA = 39000;
const KIND_MESSAGE = 9;
/** A post on a board: the first item of a board channel, in place of a chat message. */
const KIND_BOARD_POST = 45001;
const KIND_PERSONA = 30175;
const KIND_SKILL = 30180;
const KIND_WORKFLOW_DEF = 30620;
const KIND_LONG_FORM = 30023;
const KIND_WIKI_PAGE = 44001;
const KIND_ORG_NODE = 37010;
const KIND_ORG_BUDGET = 37012;

/** The kinds a template's marker can be on; the query asks for exactly these. */
export const MARKED_KINDS = [
  KIND_MESSAGE,
  KIND_BOARD_POST,
  KIND_PERSONA,
  KIND_SKILL,
  KIND_WORKFLOW_DEF,
  KIND_LONG_FORM,
  KIND_WIKI_PAGE,
] as const;

/** The org kinds whose `d` tags decide whether an org step is skipped. */
export const ORG_KINDS = [KIND_ORG_NODE, KIND_ORG_BUDGET] as const;

/** The kind of channel metadata. */
export const CHANNEL_METADATA_KIND = KIND_CHANNEL_METADATA;

function tagValue(tags: readonly (readonly string[])[], name: string): string {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return "";
}

/** Which step a marked record belongs to, from its kind and marker item. */
function stepKindOf(kind: number, item: string): StepKind | null {
  switch (kind) {
    case KIND_PERSONA:
      return "persona";
    case KIND_SKILL:
      return "skill";
    case KIND_WORKFLOW_DEF:
      return "workflow";
    // A page in the wiki (this app) or a long-form note (the command line):
    // either one means the document is already there.
    case KIND_WIKI_PAGE:
    case KIND_LONG_FORM:
      return "doc";
    case KIND_MESSAGE:
      return item === "welcome" ? "welcome" : "seed";
    // A board's first post is marked like a chat's first message.
    case KIND_BOARD_POST:
      return "seed";
    default:
      return null;
  }
}

/**
 * Fold the three reads into one state. `markerRecords` may be anything the
 * server sent back; records without this template's marker are ignored.
 */
export function buildExistingState(input: {
  templateId: string;
  channelRecords: readonly ServerRecord[];
  markerRecords: readonly ServerRecord[];
  orgRecords: readonly ServerRecord[];
}): ExistingState {
  const state = emptyExisting();

  for (const record of input.channelRecords) {
    if (record.kind !== KIND_CHANNEL_METADATA) continue;
    const name = canonicalChannelName(tagValue(record.tags, "name"));
    const id = tagValue(record.tags, "d");
    if (name !== "" && id !== "") state.channels.set(name, id);
  }

  for (const record of input.markerRecords) {
    const item = markerItem(record.tags, input.templateId);
    if (item === null) continue;
    const kind = stepKindOf(record.kind, item);
    if (kind === null) continue;
    const key = itemKey(kind, item);
    const known = state.items.get(key);
    // Keep the newest record, so a replacement is stamped after it.
    if (known && known.createdAt >= record.created_at) continue;
    state.items.set(key, {
      eventId: record.id,
      createdAt: record.created_at,
      ...(kind === "skill" ? { source: tagValue(record.tags, "source") } : {}),
    });
  }

  for (const record of input.orgRecords) {
    const d = tagValue(record.tags, "d");
    if (d === "") continue;
    if (record.kind === KIND_ORG_NODE) state.orgNodes.add(d);
    else if (record.kind === KIND_ORG_BUDGET) state.orgBudgets.add(d);
  }
  return state;
}
