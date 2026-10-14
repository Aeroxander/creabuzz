/**
 * Who holds a project's intellectual property, as the project says it, and what
 * the app is allowed to say about that.
 *
 * A token does not carry IP; a signed document does. So the record points at
 * documents (by link and fingerprint) and the app only ever states what those
 * documents are claimed to do, never that the law agrees. Three starting
 * points, each honest about what it is:
 *
 * - `open`: the work is released under an open licence. Nobody, holders
 *   included, holds exclusive rights.
 * - `founders`: no entity yet. The founders hold the IP themselves, and may
 *   have signed a commitment to assign it to an entity once one is formed.
 * - `entity`: a named legal entity holds it, through a signed assignment (which
 *   may be written to take effect only once the raise completes).
 *
 * The standing is worked out from what is on record, so a project cannot show a
 * stronger one than its documents support. A malformed document is dropped on
 * read, which can only lower the standing.
 *
 * Pure and alias-free: `ip-record.test.mjs` drives it under `node --test`.
 */

export type IpHolder = "open" | "founders" | "entity";

/** A document held elsewhere, pinned by its fingerprint so it cannot change quietly. */
export interface IpDocument {
  title: string;
  /** https link to the document. */
  url: string;
  /** SHA-256 of the document's bytes, lowercase hex. */
  sha256: string;
}

export interface IpEntity {
  name: string;
  jurisdiction: string;
  registration: string | null;
}

export interface IpRecord {
  v: 1;
  holder: IpHolder;
  /** The open licence, for `open` ("MIT", "Apache-2.0", "CC-BY-4.0"). */
  licence: string | null;
  /** The entity, for `entity`. */
  entity: IpEntity | null;
  /**
   * The signed document. For `founders` it is their commitment to assign the IP
   * to an entity once one is formed; for `entity` it is the assignment to that
   * entity.
   */
  assignment: IpDocument | null;
  /** The entity's operating agreement: how holders direct it. */
  operating: IpDocument | null;
  /** The terms a contributor accepts for their work. */
  contributorTerms: IpDocument | null;
}

export type IpStanding =
  | "unstated"
  | "open"
  | "founders-uncommitted"
  | "founders-committed"
  | "entity-unassigned"
  | "entity-on-raise"
  | "entity-assigned";

const HEX_64 = /^[0-9a-f]{64}$/;
const TITLE_MAX = 120;
const NAME_MAX = 120;
const PLACE_MAX = 80;
const LICENCE_MAX = 60;
/** A link is a pointer, not a payload: the launch record has a size limit. */
const URL_MAX = 500;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** An https link, or null. Anything else (http, a script, a file) is refused. */
export function secureUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" &&
      url.hostname !== "" &&
      url.toString().length <= URL_MAX
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** A well-formed document, or null. */
export function parseIpDocument(value: unknown): IpDocument | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const title = text(raw.title, TITLE_MAX);
  const url = secureUrl(raw.url);
  const sha256 =
    typeof raw.sha256 === "string" ? raw.sha256.trim().toLowerCase() : "";
  if (title === null || url === null || !HEX_64.test(sha256)) return null;
  return { title, url, sha256 };
}

function parseEntity(value: unknown): IpEntity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const name = text(raw.name, NAME_MAX);
  const jurisdiction = text(raw.jurisdiction, PLACE_MAX);
  if (name === null || jurisdiction === null) return null;
  return { name, jurisdiction, registration: text(raw.registration, NAME_MAX) };
}

/** The record as published, or null when it names no holder this app knows. */
export function parseIpRecord(value: unknown): IpRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.holder !== "open" &&
    raw.holder !== "founders" &&
    raw.holder !== "entity"
  ) {
    return null;
  }
  return {
    v: 1,
    holder: raw.holder,
    licence: raw.holder === "open" ? text(raw.licence, LICENCE_MAX) : null,
    entity: raw.holder === "entity" ? parseEntity(raw.entity) : null,
    assignment: parseIpDocument(raw.assignment),
    operating: raw.holder === "entity" ? parseIpDocument(raw.operating) : null,
    contributorTerms: parseIpDocument(raw.contributorTerms),
  };
}

/** What to publish: only what is present, so an absent field never reads as a promise. */
export function ipRecordContent(record: IpRecord): Record<string, unknown> {
  const content: Record<string, unknown> = { v: 1, holder: record.holder };
  if (record.holder === "open" && record.licence) {
    content.licence = record.licence;
  }
  if (record.holder === "entity" && record.entity) {
    content.entity = {
      name: record.entity.name,
      jurisdiction: record.entity.jurisdiction,
      ...(record.entity.registration
        ? { registration: record.entity.registration }
        : {}),
    };
  }
  if (record.assignment) content.assignment = record.assignment;
  if (record.holder === "entity" && record.operating) {
    content.operating = record.operating;
  }
  if (record.contributorTerms) {
    content.contributorTerms = record.contributorTerms;
  }
  return content;
}

/**
 * Where the project's IP stands. `raised` is whether the sale has completed:
 * an assignment written to take effect on the raise is only "assigned" once it
 * has.
 */
export function ipStanding(
  record: IpRecord | null,
  raised: boolean,
): IpStanding {
  if (!record) return "unstated";
  if (record.holder === "open") {
    return record.licence ? "open" : "unstated";
  }
  if (record.holder === "founders") {
    return record.assignment ? "founders-committed" : "founders-uncommitted";
  }
  if (!record.entity || !record.assignment) return "entity-unassigned";
  return raised ? "entity-assigned" : "entity-on-raise";
}

export interface IpSummary {
  headline: string;
  detail: string;
  /** Whether holders are said to direct the entity that holds the IP. Never a legal finding. */
  holdersDirect: boolean;
}

/**
 * The plain words for a standing. Every line says whose statement it is: the
 * app has read documents' fingerprints, not their law.
 */
export function ipSummary(
  standing: IpStanding,
  record: IpRecord | null,
): IpSummary {
  const entity = record?.entity?.name ?? "the entity";
  switch (standing) {
    case "unstated":
      return {
        headline: "The project hasn't said who holds its IP",
        detail:
          "Until it does, holding its token gives no claim on the code, name or other work. Ask the team.",
        holdersDirect: false,
      };
    case "open":
      return {
        headline: `Open: released under ${record?.licence ?? "an open licence"}`,
        detail:
          "Anyone may use the work under that licence, including holders. Nobody holds exclusive rights, so there is no exclusive IP for a token to represent.",
        holdersDirect: false,
      };
    case "founders-uncommitted":
      return {
        headline: "The founders hold the IP themselves",
        detail:
          "There is no entity, and no commitment to assign the IP to one is on record. Holders have no claim on it, and the founders carry the legal risk personally.",
        holdersDirect: false,
      };
    case "founders-committed":
      return {
        headline:
          "The founders hold the IP for now, and have committed to assign it",
        detail:
          "There is no entity yet. The founders say they have signed a commitment to assign the IP to an entity once one is formed (the document is linked). Until it is formed and the assignment is signed, the founders still hold it.",
        holdersDirect: false,
      };
    case "entity-unassigned":
      return {
        headline: `${entity} is named, but no assignment is on record`,
        detail:
          "The entity exists on paper, but there is no signed assignment of the IP to it. Until there is, the IP is not the entity's.",
        holdersDirect: false,
      };
    case "entity-on-raise":
      return {
        headline: `The IP is to be assigned to ${entity} when the raise completes`,
        detail:
          "The project says a signed assignment (linked) takes effect once the sale completes. If the sale does not complete, the IP stays with the founders.",
        holdersDirect: false,
      };
    case "entity-assigned":
      return {
        headline: `The IP is assigned to ${entity}`,
        detail: record?.operating
          ? "The project says the entity's operating agreement (linked) has it act on holders' decisions. That is the project's statement: read the documents, and take legal advice before relying on them."
          : "How holders direct the entity is not on record, so holding the token gives no stated say over the IP.",
        holdersDirect: record?.operating != null,
      };
  }
}

/** A document as typed into the editor: every part still a string, any of them blank. */
export interface IpDocumentDraft {
  title: string;
  url: string;
  sha256: string;
}

/** The editor's state: what a person has typed, before it is checked. */
export interface IpDraft {
  holder: IpHolder;
  licence: string;
  entityName: string;
  entityPlace: string;
  entityRegistration: string;
  assignment: IpDocumentDraft;
  operating: IpDocumentDraft;
  contributorTerms: IpDocumentDraft;
}

export const EMPTY_DOCUMENT: IpDocumentDraft = {
  title: "",
  url: "",
  sha256: "",
};

const draftDocument = (doc: IpDocument | null): IpDocumentDraft =>
  doc ? { ...doc } : { ...EMPTY_DOCUMENT };

/** The editor's starting state: what is on record, or a project with no entity yet. */
export function ipDraftFromRecord(record: IpRecord | null): IpDraft {
  return {
    holder: record?.holder ?? "founders",
    licence: record?.licence ?? "",
    entityName: record?.entity?.name ?? "",
    entityPlace: record?.entity?.jurisdiction ?? "",
    entityRegistration: record?.entity?.registration ?? "",
    assignment: draftDocument(record?.assignment ?? null),
    operating: draftDocument(record?.operating ?? null),
    contributorTerms: draftDocument(record?.contributorTerms ?? null),
  };
}

const blank = (doc: IpDocumentDraft) =>
  doc.title.trim() === "" && doc.url.trim() === "" && doc.sha256.trim() === "";

/**
 * Check a draft and make the record, or say what is wrong in plain words. A
 * document is either left entirely blank or filled in whole: a half-filled one
 * is refused, never saved as something smaller.
 */
export function ipRecordFromDraft(
  draft: IpDraft,
): { record: IpRecord } | { problem: string } {
  const documents: [string, IpDocumentDraft, boolean][] = [
    ["assignment", draft.assignment, true],
    ["operating agreement", draft.operating, draft.holder === "entity"],
    ["contributor terms", draft.contributorTerms, true],
  ];
  const parsed: (IpDocument | null)[] = [];
  for (const [name, doc, used] of documents) {
    if (!used || blank(doc)) {
      parsed.push(null);
      continue;
    }
    const checked = parseIpDocument(doc);
    if (checked === null) {
      return {
        problem: `The ${name} needs a title, an https link and a fingerprint of 64 characters, or leave all three empty.`,
      };
    }
    parsed.push(checked);
  }
  const name = text(draft.entityName, NAME_MAX);
  const place = text(draft.entityPlace, PLACE_MAX);
  const record: IpRecord = {
    v: 1,
    holder: draft.holder,
    licence: draft.holder === "open" ? text(draft.licence, LICENCE_MAX) : null,
    entity:
      draft.holder === "entity" && name !== null && place !== null
        ? {
            name,
            jurisdiction: place,
            registration: text(draft.entityRegistration, NAME_MAX),
          }
        : null,
    assignment: parsed[0],
    operating: parsed[1],
    contributorTerms: parsed[2],
  };
  const problem = ipDraftProblem(record);
  return problem === null ? { record } : { problem };
}

/** A short reason an editor draft cannot be saved, in plain words, or null. */
export function ipDraftProblem(draft: IpRecord): string | null {
  if (draft.holder === "open" && !draft.licence) {
    return "Name the licence, for example MIT or CC-BY-4.0.";
  }
  if (draft.holder === "entity") {
    if (!draft.entity) {
      return "Give the entity's name and where it is registered.";
    }
  }
  return null;
}
