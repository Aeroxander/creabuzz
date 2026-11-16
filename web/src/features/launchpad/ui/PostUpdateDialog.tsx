import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { DraftField, DraftFields } from "../lib/update-draft-facts";
import {
  defaultUpdateTitle,
  doneWithAccepted,
  firstPromises,
  type HelpSize,
  PART_HEADINGS,
  promisesTakeCursor,
  QUIET_WEEK,
  UPDATE_LIMITS,
  type UpdateDraft,
  type WorkLine,
} from "../lib/weekly-update";
import type { AiStarterKind } from "../lib/ai-starters";
import type { PromiseEntry } from "../lib/promises";
import type { Launch } from "../models";
import { DraftFromRecord } from "./DraftFromRecord";
import { MODAL_FOOTER_CLASS, Modal } from "./Modal";
import { StarterPromises } from "./StarterWording";
import {
  AREA_CLASS,
  HelpBlock,
  type Marks,
  PromiseAnswers,
  WorkLines,
} from "./UpdateDialogParts";

/**
 * Founder flow: one signed update into the project's feed. The cursor starts where the writing starts, in "What
 * happened this week". Three light prompts shape it (what happened, what's next, help needed); they are only prompts,
 * and "Write one note instead" swaps the first two for one open box. Asking for help adds a card people can answer with
 * "I can help"; it sits behind "Ask for help" until it is wanted.
 *
 * Each line of "What's next" is a promise for the next update. So the dialog first lists the promises earlier updates
 * made that have no answer yet (week two on), focuses the first answer, and asks for each: done, not done or changed,
 * with an optional short note. Answering is not forced ("Not answering yet" is the choice each starts on, and the way
 * to take a tapped answer back before publishing): a promise left without an answer shows as not answered, and is asked
 * about again. Once published an answer stays, and the dialog says so.
 *
 * "Title" and "In one line" are under "More options", with "Draft from the record", which asks the server's AI service
 * for a first version of what happened, the help needed and that line, from the project's own record only; it goes only
 * into boxes the founder has not written in, and "What's next" is never drafted. A title left empty is "Week of Nov 16",
 * so Publish never waits on a name.
 *
 * On an AI project's first weekly update the founder may fill "What's next" with a kind's three first promises
 * (`starters`), to edit or clear: they become promises only as part of the update the founder publishes.
 */
const NONE_ACCEPTED: readonly WorkLine[] = [];
const NO_STARTERS: readonly AiStarterKind[] = [];

export function PostUpdateDialog({
  isPublishing,
  failed,
  failedWhy,
  onClose,
  onPublish,
  due,
  onRetryDue,
  asFounder = true,
  agent = false,
  accepted = NONE_ACCEPTED,
  project,
  startAt,
  starters = NO_STARTERS,
}: {
  /** The kinds whose first promises are offered above "What's next": an AI project's first weekly update, else none. */
  starters?: readonly AiStarterKind[];
  /** Where the cursor starts: "help" opens the dialog in "Help needed" (the first-week card's "Ask for help"). */
  startAt?: "help";
  /**
   * The project, for "Draft from the record" (it reads this project's record). Without it the button is not shown: a
   * team member's update makes no promises and the draft has no founder's record to go on.
   */
  project?: Launch["record"];
  /** Work finished since the last update: offered as lines of "What happened", each one removable. */
  accepted?: readonly WorkLine[];
  /** The account posting is an agent: promises need a person, whoever's project it is. */
  agent?: boolean;
  /**
   * False for a team member who is not the founder: the update makes no promises and answers none (those are the
   * founder's alone), and the dialog says so.
   */
  asFounder?: boolean;
  /**
   * The promises still to answer, newest first. Null when they could not be read: the dialog says so and the update
   * can still be posted.
   */
  due: readonly PromiseEntry[] | null;
  onRetryDue: () => void;
  isPublishing: boolean;
  /** The last publish did not go through: said in the dialog, with what was written kept. */
  failed: boolean;
  /** The server's reason in plain words, when it refused the update with one (who may post it, and what to do). */
  failedWhy?: string | null;
  onClose: () => void;
  onPublish: (draft: UpdateDraft) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [freely, setFreely] = useState(false);
  const [done, setDone] = useState("");
  const [next, setNext] = useState("");
  const [body, setBody] = useState("");
  const [help, setHelp] = useState("");
  const [helpOpen, setHelpOpen] = useState(startAt === "help");
  const [helpSize, setHelpSize] = useState<HelpSize>("small");
  const [helpTime, setHelpTime] = useState("");
  const [marks, setMarks] = useState<Marks>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [line, setLine] = useState("");
  // A draft already says the accepted work, so the lines that would add it again are not added.
  const [covered, setCovered] = useState(false);
  const offered = accepted.filter((task) => !removed.has(task.id));
  // A founder's lines become promises: a week holds about three, and only those are sent.
  const promised = asFounder ? firstPromises(next) : { text: next, dropped: 0 };
  const headingId = useId();
  const helpBox = useRef<HTMLTextAreaElement | null>(null);
  const doneBox = useRef<HTMLTextAreaElement | null>(null);
  const firstAnswer = useRef<HTMLInputElement | null>(null);
  const askedForHelp = useRef(false);
  // Set once the founder has typed in the first two boxes: after that, nothing moves the cursor for them.
  const typed = useRef(false);
  const answers = asFounder && due ? due : [];

  // The promises can arrive after the dialog opened (they are read from the record). If the cursor is still where it
  // started and nothing was typed, it moves to the first answer: in week two the promises come first.
  const answerCount = answers.length;
  useEffect(() => {
    const active = document.activeElement;
    if (
      promisesTakeCursor({
        answers: answerCount,
        startedAtHelp: startAt === "help",
        typed: typed.current,
        cursorAtStart: active === doneBox.current || active === document.body,
      })
    )
      firstAnswer.current?.focus();
  }, [answerCount, startAt]);

  // "Ask for help" puts the cursor in the box it opens.
  useEffect(() => {
    if (helpOpen && askedForHelp.current) helpBox.current?.focus();
  }, [helpOpen]);

  // The boxes as they are now, for a draft that arrives later to check against.
  const boxes = useRef({ done, help, line });
  boxes.current = { done, help, line };
  const fillFromDraft = (next: DraftFields, filled: readonly DraftField[]) => {
    setDone(next.done);
    setHelp(next.help);
    setLine(next.line);
    if (next.help.trim() !== "") setHelpOpen(true);
    if (filled.includes("done")) setCovered(true);
  };

  // Work someone else accepted is what a draft says; work only the founder checked is the founder's to word.
  const coveredIds = new Set([
    ...removed,
    ...(covered
      ? accepted.filter((task) => task.kind !== "founder").map((t) => t.id)
      : []),
  ]);

  const publish = () =>
    void onPublish({
      title: title.trim() || defaultUpdateTitle(new Date()),
      // Only the boxes on screen are sent: words left in the hidden ones are not published behind the founder's back.
      done: freely ? "" : doneWithAccepted(done, accepted, coveredIds),
      line,
      next: freely ? "" : promised.text,
      body: freely ? body : "",
      help,
      helpSize,
      helpTime: help.trim() !== "" ? helpTime : "",
      marks: answers.flatMap((promise) => {
        const mark = marks[promise.id];
        return mark
          ? [{ promiseId: promise.id, text: promise.text, ...mark }]
          : [];
      }),
    });

  return (
    <Modal
      initialFocus={
        startAt === "help"
          ? helpBox
          : answers.length > 0
            ? firstAnswer
            : doneBox
      }
      label="Post update"
      labelledBy={headingId}
      onClose={onClose}
    >
      <h2
        className="text-lg font-semibold text-black dark:text-white"
        id={headingId}
      >
        Post update
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Everyone can read this. A few lines each week is enough.
      </p>
      {/* Not a form: Enter in a box must not publish a half-written update. */}
      <div className="mt-3 flex flex-col gap-3">
        {!asFounder ? (
          <p className="text-sm" data-testid="update-as-team" role="status">
            {agent
              ? "This account is an agent. Its update shows with the project's news under its name. It makes no promises and answers none: those need a person."
              : "You are posting as a member of this project's team. Your update shows with the project's news under your name. It makes no promises and answers none: those are the founder's."}
          </p>
        ) : due === null ? (
          <p className="text-sm" data-testid="update-due-unknown" role="status">
            Couldn't read what you said last time, so this update can't answer
            it.{" "}
            <Button
              onClick={onRetryDue}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </p>
        ) : due.length > 0 ? (
          <PromiseAnswers
            due={due}
            firstAnswer={firstAnswer}
            marks={marks}
            setMarks={setMarks}
          />
        ) : null}
        {freely ? (
          <div>
            <label className="text-sm font-medium" htmlFor="update-body">
              Your update
            </label>
            <textarea
              id="update-body"
              className={AREA_CLASS}
              maxLength={UPDATE_LIMITS.part * 2}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What you finished, who helped, and what's next."
              rows={5}
              value={body}
            />
          </div>
        ) : (
          <>
            <div>
              <label className="text-sm font-medium" htmlFor="update-done">
                {PART_HEADINGS.done}
              </label>
              <textarea
                id="update-done"
                className={AREA_CLASS}
                maxLength={UPDATE_LIMITS.part}
                onChange={(e) => {
                  typed.current = true;
                  setDone(e.target.value);
                }}
                placeholder="What you finished, and who helped."
                ref={doneBox}
                rows={3}
                value={done}
              />
              {done.trim() === "" ? (
                <Button
                  className="h-auto p-0 max-sm:min-h-11"
                  data-testid="update-quiet-week"
                  onClick={() => {
                    typed.current = true;
                    setDone(QUIET_WEEK);
                  }}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  Nothing new this week
                </Button>
              ) : null}
            </div>
            {offered.length > 0 ? (
              <WorkLines
                covered={covered}
                offered={offered}
                onLeaveOut={(id) => setRemoved((was) => new Set([...was, id]))}
                onUncover={() => setCovered(false)}
              />
            ) : null}
            <div>
              {asFounder ? (
                <StarterPromises kinds={starters} next={next} onUse={setNext} />
              ) : null}
              <label className="text-sm font-medium" htmlFor="update-next">
                {PART_HEADINGS.next}
              </label>
              <p
                className="text-xs text-muted-foreground"
                id="update-next-hint"
              >
                {asFounder
                  ? "Up to three, one per line. Next week you answer each one."
                  : "One per line. These are plans, not promises on the record: only the founder's updates make promises."}
              </p>
              <textarea
                aria-describedby="update-next-hint"
                id="update-next"
                className={AREA_CLASS}
                maxLength={UPDATE_LIMITS.part}
                onChange={(e) => {
                  typed.current = true;
                  setNext(e.target.value);
                }}
                placeholder="Invite the first ten people"
                rows={3}
                value={next}
              />
              {promised.dropped > 0 ? (
                <p
                  className="mt-1 text-xs"
                  data-testid="update-next-too-many"
                  role="status"
                >
                  Only the first three lines become promises. Keep the week
                  small enough to keep.
                </p>
              ) : null}
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-x-4">
          {/* The label says what a press does next; it is not also a pressed state, which would say it twice. */}
          <Button
            className="h-auto p-0 max-sm:min-h-11"
            data-testid="update-write-freely"
            onClick={() => setFreely((was) => !was)}
            size="sm"
            type="button"
            variant="link"
          >
            {freely ? "Use the prompts" : "Write one note instead"}
          </Button>
          {helpOpen ? null : (
            <Button
              className="h-auto p-0 max-sm:min-h-11"
              data-testid="update-ask-help"
              onClick={() => {
                askedForHelp.current = true;
                setHelpOpen(true);
              }}
              size="sm"
              type="button"
              variant="link"
            >
              Ask for help
            </Button>
          )}
        </div>
        {helpOpen ? (
          <HelpBlock
            box={helpBox}
            help={help}
            setHelp={setHelp}
            setSize={setHelpSize}
            setTime={setHelpTime}
            size={helpSize}
            time={helpTime}
          />
        ) : null}
        <details className="group" data-testid="update-more-options">
          <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium max-sm:min-h-11">
            More options
            <ChevronDown
              aria-hidden
              className="h-4 w-4 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            <div>
              <label className="text-sm font-medium" htmlFor="update-title">
                Title (optional)
              </label>
              <Input
                id="update-title"
                className="mt-1"
                maxLength={UPDATE_LIMITS.title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={defaultUpdateTitle(new Date())}
                value={title}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="update-line">
                {PART_HEADINGS.line} (optional)
              </label>
              <p
                className="text-xs text-muted-foreground"
                id="update-line-hint"
              >
                A short line for feeds and cards. Left empty, the first sentence
                of what happened is used.
              </p>
              <Input
                aria-describedby="update-line-hint"
                id="update-line"
                className="mt-1"
                maxLength={UPDATE_LIMITS.line}
                onChange={(e) => setLine(e.target.value)}
                placeholder="Sign-up works on older phones."
                value={line}
              />
            </div>
            {project && asFounder && !agent && !freely ? (
              <DraftFromRecord
                accepted={offered.filter((task) => task.kind !== "founder")}
                current={() => boxes.current}
                due={due}
                marks={marks}
                onFill={fillFromDraft}
                project={project}
              />
            ) : null}
          </div>
        </details>
        {/* The footer is carried over the card's own bottom padding (bottom -1.25rem, pb-8), so no text shows beneath its buttons. */}
        <div
          className={`${MODAL_FOOTER_CLASS} flex flex-col gap-2 pb-8`}
          style={{ bottom: "-1.25rem" }}
        >
          {failed && !isPublishing ? (
            <p
              className="text-sm text-red-700 dark:text-red-300"
              data-testid="update-publish-failed"
              role="alert"
            >
              Your update was not published. What you wrote is still here.
              {failedWhy ? ` ${failedWhy}` : null}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              className="max-sm:h-11"
              onClick={onClose}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="max-sm:h-11"
              disabled={isPublishing}
              onClick={publish}
              type="button"
            >
              {isPublishing
                ? "Publishing…"
                : failed
                  ? "Try again"
                  : "Publish update"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
