/**
 * Asking the manager for a draft: one signed POST to the server's `/llm/manager/draft`, as the founder. The answer is
 * read strictly (a shape the app does not know is "unreadable", never half shown), and a refusal becomes the server's
 * own sentence. The draft is for the founder to read: nothing here posts, signs or pays anything.
 */
import { makeNip98AuthHeader } from "@creaton/core/client/nip98.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import { timedFetchStreamed } from "@creaton/core/client/timed-fetch.ts";
import { MANAGER_PROBLEM, refusalWords } from "./manager-copy";

const MANAGER_DRAFT_PATH = "/llm/manager/draft";

/** How long one draft may take: the AI service can be slow, a server that never answers still ends. */
const DRAFT_TIMEOUT_MS = 120_000;

/** The most the app sends: the same bounds the server holds. */
export const ITEMS_MAX = 30;
export const ANSWER_MAX = 1_000;
const ANSWERS_MAX = 5;

/** One drafted line and what it cites (`r1` a record, `a1` an answer, `f1` a line of facts, `d1` of decisions). */
export interface DraftLine {
  text: string;
  from: string[];
  records: string[];
}

/** A question the manager will not answer: who to ask, drafted. */
interface NeedsPerson {
  topic: string;
  ask: string;
  from: string[];
}

export interface ManagerDraft {
  /** What was read, in the server's words. */
  read: string;
  thisWeek: DraftLine[];
  notDoing: DraftLine[];
  whatHappened: DraftLine[];
  needsAPerson: NeedsPerson[];
  dropped: number;
  blocked: number;
  /** Inputs not read because they looked like instructions to an AI. */
  setAside: number;
  canBeWrong: string;
  notice: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const count = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;

function lines(value: unknown): DraftLine[] | null {
  if (!Array.isArray(value)) return null;
  const out: DraftLine[] = [];
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry.text !== "string" ||
      !isStrings(entry.from) ||
      !isStrings(entry.records)
    )
      return null;
    out.push({ text: entry.text, from: entry.from, records: entry.records });
  }
  return out;
}

function people(value: unknown): NeedsPerson[] | null {
  if (!Array.isArray(value)) return null;
  const out: NeedsPerson[] = [];
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry.topic !== "string" ||
      typeof entry.ask !== "string" ||
      !isStrings(entry.from)
    )
      return null;
    out.push({ topic: entry.topic, ask: entry.ask, from: entry.from });
  }
  return out;
}

/** The draft from the server's JSON, or null when it is not the `creaton.manager.v1` shape. */
export function parseDraft(body: unknown): ManagerDraft | null {
  if (!isObject(body) || body.schema !== "creaton.manager.v1") return null;
  const thisWeek = lines(body.this_week);
  const notDoing = lines(body.not_doing);
  const whatHappened = lines(body.what_happened);
  const needsAPerson = people(body.needs_a_person);
  if (!thisWeek || !notDoing || !whatHappened || !needsAPerson) return null;
  if (typeof body.read !== "string") return null;
  return {
    read: body.read,
    thisWeek,
    notDoing,
    whatHappened,
    needsAPerson,
    dropped: count(body.dropped),
    blocked: count(body.blocked),
    setAside: Array.isArray(body.set_aside) ? body.set_aside.length : 0,
    canBeWrong: typeof body.can_be_wrong === "string" ? body.can_be_wrong : "",
    notice: typeof body.notice === "string" ? body.notice : "",
  };
}

export interface DraftRequest {
  /** The project's address, `37001:<founder>:<id>`. */
  project: string;
  /** Ids of the project's records the page already loaded (the server reads them itself, from its own copy). */
  items: string[];
  /** What the founder said when asked, at most five short answers. */
  answers: string[];
}

/** The request's body: bounded the way the server bounds it, answers trimmed and empty ones dropped. */
export function draftBody(request: DraftRequest): string {
  return JSON.stringify({
    project: request.project,
    items: request.items.slice(0, ITEMS_MAX),
    answers: request.answers
      .map((a) => a.trim().slice(0, ANSWER_MAX))
      .filter((a) => a !== "")
      .slice(0, ANSWERS_MAX),
  });
}

/** Ask for a draft. Throws an Error whose message is plain words for the founder. */
export async function askManager(
  request: DraftRequest,
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>,
): Promise<ManagerDraft> {
  const url = `${relayHttpBaseUrl()}${MANAGER_DRAFT_PATH}`;
  const body = draftBody(request);
  const auth = await makeNip98AuthHeader(url, "POST", { body });
  const response = await timedFetchStreamed(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body,
    timeoutMs: DRAFT_TIMEOUT_MS,
    fetchImpl,
  }).catch(() => {
    // A timeout, a dropped connection: nobody answered. The draft is optional, so this is all it says.
    throw new Error(MANAGER_PROBLEM.noAnswer);
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(refusalWords(response.status, json));
  const draft = parseDraft(json);
  if (!draft) throw new Error(MANAGER_PROBLEM.unreadable);
  return draft;
}
