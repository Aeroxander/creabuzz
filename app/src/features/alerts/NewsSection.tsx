/**
 * "News about your projects" on You (plan sections 6.3 and 6.5): what is planned, taken and finished on the projects a person
 * holds, and what they are owed, newest first, made from the signed record and never from a team member's word. Each row is
 * the project as one link, the sentence, the time, and, while money cannot move yet, a Take out that opens the project's
 * Money tab. What is listed is marked read after it renders; "Mark {n} as read" does it by hand. Never "no news" for a read
 * that failed. Shown only where the server turns investing on and a wallet shows an account.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { timeText } from "../money/numbers";
import { PLAY_MONEY_WORDS } from "../pot/pot-words";
import {
  markReadWords,
  moreEndedWords,
  moreNewsWords,
  NEWS_FAILED,
  NEWS_HEADING,
  NEWS_LOADING,
  NEWS_NONE,
  NEWS_RETRY,
  NEWS_STALE,
  NEWS_TAKE_OUT,
  NEWS_UNSEEN,
  NEWS_WEEK,
  newsLimitWords,
  plainName,
  urgentWords,
} from "./alert-words";
import type { TaskAlert } from "./alerts";
import { MOST_PROJECTS } from "./pipeline";
import { markSeen, useSeen } from "./seen";
import { type News, useNews } from "./use-news";

/** The most rows the section lists, besides every plan whose notice has not ended: those are never cut. */
const MOST_ROWS = 30;

function Row({
  alert,
  projectRef,
  fresh,
  drawTakeOut,
}: {
  alert: TaskAlert;
  projectRef: string | undefined;
  /** Not read when the list was opened. */
  fresh: boolean;
  /** Whether this row carries the button: one for each project and date, so no two controls on the page are named alike. */
  drawTakeOut: boolean;
}) {
  const navigate = useNavigate();
  const project = plainName(alert.projectName);
  const said = alert.said;
  return (
    <li
      className="flex flex-col gap-1 py-3"
      data-kind={alert.kind}
      data-testid="news-row"
      data-unseen={fresh ? "true" : "false"}
    >
      <p className="break-words text-sm" data-testid="news-sentence">
        {projectRef ? (
          <Link
            className="link font-semibold"
            params={{ ref: projectRef }}
            to="/p/$ref"
          >
            {project}
          </Link>
        ) : (
          <span className="font-semibold">{project}</span>
        )}
        {": "}
        {said}
        {fresh ? (
          <>
            {" "}
            <span className="text-2xs font-semibold uppercase tracking-wider text-mint-ink">
              {NEWS_UNSEEN}
            </span>
          </>
        ) : null}
      </p>
      <p className="text-xs text-muted">{timeText(alert.at)}</p>
      {alert.before !== null ? (
        <div className="flex flex-col items-start gap-2">
          <p className="break-words text-sm" data-testid="news-urgent">
            {urgentWords(alert.before)}
          </p>
          {drawTakeOut && projectRef ? (
            <Button
              aria-label={`${NEWS_TAKE_OUT} of ${project} before ${timeText(alert.before)}`}
              onClick={() =>
                void navigate({
                  to: "/p/$ref",
                  params: { ref: projectRef },
                  search: { tab: "money" },
                })
              }
              size="sm"
              variant="secondary"
            >
              {NEWS_TAKE_OUT}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function List({ news, pubkey }: { news: News; pubkey: string }) {
  // The alerts come with plans in their notice first, soonest end first: a cut never takes a notice a holder can still leave before.
  const urgent = news.alerts.filter((a) => a.urgent).length;
  const listed = news.alerts.slice(0, Math.max(MOST_ROWS, urgent));
  const seen = useSeen(pubkey);
  // What was unread when the list opened stays marked for this visit, though it is marked read as soon as it is drawn.
  const opened = useRef(new Set<string>());
  for (const alert of listed)
    if (!(alert.id in seen)) opened.current.add(alert.id);
  const [cleared, setCleared] = useState(false);
  const ids = news.alerts.map((a) => a.id);
  const idsNote = ids.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idsNote` stands for `listed`.
  useEffect(() => {
    if (listed.length === 0) return;
    markSeen(
      pubkey,
      listed.map((a) => a.id),
      new Set(ids),
      Math.floor(Date.now() / 1000),
    );
  }, [pubkey, idsNote]);
  const fresh = (alert: TaskAlert) => !cleared && opened.current.has(alert.id);
  const unread = listed.filter(fresh).length;
  const drawn = new Set<string>();
  const drawTakeOut = (alert: TaskAlert) => {
    const slot = `${alert.chainKey}|${alert.before}`;
    if (drawn.has(slot)) return false;
    drawn.add(slot);
    return true;
  };
  return (
    <>
      <ul className="divide-y divide-white/10" data-testid="news-list">
        {listed.map((alert) => (
          <Row
            alert={alert}
            drawTakeOut={drawTakeOut(alert)}
            fresh={fresh(alert)}
            key={alert.id}
            projectRef={news.refs.get(alert.chainKey)}
          />
        ))}
      </ul>
      {listed.length < news.alerts.length ? (
        <p className="text-sm text-muted" data-testid="news-more">
          {moreNewsWords(news.alerts.length - listed.length)}
        </p>
      ) : null}
      {news.moreEnded.map((more) => (
        <p
          className="text-sm text-muted"
          data-testid="news-more-ended"
          key={more.chainKey}
        >
          {moreEndedWords(plainName(more.projectName), more.count)}
        </p>
      ))}
      {unread > 0 ? (
        <Button
          data-testid="news-mark-read"
          onClick={() => {
            markSeen(pubkey, ids, new Set(ids), Math.floor(Date.now() / 1000));
            setCleared(true);
          }}
          size="sm"
          variant="secondary"
        >
          {markReadWords(unread)}
        </Button>
      ) : null}
    </>
  );
}

/** The section behind the wallet: nothing without an account to find news for. */
export default function NewsSection() {
  const { pubkey } = useAccount();
  const news = useNews();
  const titleId = useId();
  // Off with no wallet shown, no account signed in, or investing off: there is no news to find.
  if (!pubkey || news.status === "off") return null;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="news-section"
    >
      <h2
        className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted"
        id={titleId}
      >
        <Bell aria-hidden="true" size={16} />
        {NEWS_HEADING}
      </h2>
      <p className="text-sm text-muted" data-testid="news-play-money">
        {PLAY_MONEY_WORDS}
      </p>
      {news.status === "loading" ? (
        <Card
          aria-label={NEWS_LOADING}
          className="h-20 animate-pulse"
          data-testid="news-loading"
          role="status"
        />
      ) : news.status === "failed" ? (
        <div
          className="flex flex-col items-start gap-2"
          data-testid="news-failed"
        >
          <p className="text-sm" role="alert">
            {NEWS_FAILED}
          </p>
          <Button onClick={news.refetch} size="sm" variant="secondary">
            {NEWS_RETRY}
          </Button>
        </div>
      ) : (
        <>
          {news.alerts.length === 0 ? (
            <p className="text-sm" data-testid="news-none">
              {NEWS_NONE}
            </p>
          ) : (
            <List news={news} pubkey={pubkey} />
          )}
          {news.partial ? (
            <p className="text-sm text-muted" data-testid="news-stale">
              {NEWS_STALE}
            </p>
          ) : null}
          {news.limited ? (
            <p className="text-sm text-muted" data-testid="news-limit">
              {newsLimitWords(MOST_PROJECTS)}
            </p>
          ) : null}
          <p className="text-xs text-muted" data-testid="news-week">
            {NEWS_WEEK}
          </p>
        </>
      )}
    </section>
  );
}
