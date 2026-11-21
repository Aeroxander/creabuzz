import { Link, useNavigate } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { useMutes } from "../../lib/mutes";
import { nameOf, pictureOf, useProfiles } from "../../lib/profiles";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { ProjectCard } from "../home/ProjectCard";
import { useHomeProjects } from "../home/use-home";
import { PostList } from "../posts/PostList";
import { HIDES_UNKNOWN } from "../room/room-words";
import { useHidden, useVisiblePosts } from "../safety/use-hidden";
import {
  personHits,
  postHits,
  projectHits,
  searchable,
  searchWords,
  topicOfQuery,
  topTopics,
} from "./search-logic";
import {
  NO_PEOPLE,
  NO_POSTS,
  NO_PROJECTS,
  PEOPLE_FAILED,
  PEOPLE_TITLE,
  POSTS_FAILED,
  POSTS_HIDDEN,
  POSTS_PARTLY,
  POSTS_TITLE,
  PROJECTS_FAILED,
  PROJECTS_TITLE,
  SEARCH_HINT,
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
  SEARCH_TITLE,
  SEARCH_TOO_SHORT,
  SEARCHING,
  TOPICS_FAILED,
  TOPICS_NONE,
  TOPICS_TITLE,
  topicLink,
  TRY_AGAIN,
} from "./search-words";
import {
  usePeopleSearch,
  usePostServerSearch,
  useRecentScan,
} from "./use-search";

/** How long typing waits before the search goes to the server (one search per pause, not per letter). */
const TYPING_PAUSE_MS = 350;

/** Search: people, projects and posts by their words, and a topic by its `#`. The words typed are kept in the address. */
export function SearchPage({ q }: { q: string }) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const go = useCallback(
    (next: string) =>
      void navigate({ to: "/search", search: { q: next }, replace: true }),
    [navigate],
  );
  // One search per pause in typing; the address follows what was typed.
  useEffect(() => {
    if (text === q) return;
    const timer = window.setTimeout(() => go(text), TYPING_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [text, q, go]);
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="search-page"
    >
      <BackHeader title={SEARCH_TITLE} />
      <search>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            go(text);
          }}
        >
          <Field
            autoComplete="off"
            autoFocus={q === ""}
            data-testid="search-input"
            enterKeyHint="search"
            hint={
              text.trim() !== "" && !searchable(text)
                ? SEARCH_TOO_SHORT
                : undefined
            }
            label={SEARCH_LABEL}
            maxLength={100}
            onChange={(event) => setText(event.target.value)}
            placeholder={SEARCH_PLACEHOLDER}
            type="search"
            value={text}
          />
        </form>
      </search>
      <Results query={q} />
    </main>
  );
}

function Results({ query }: { query: string }) {
  const topic = topicOfQuery(query);
  if (topic)
    return (
      <Link
        className="glass glass-text flex min-h-14 items-center gap-3 rounded-2xl px-4 font-semibold"
        data-testid="search-topic-link"
        params={{ tag: topic }}
        to="/tag/$tag"
      >
        <Hash aria-hidden="true" className="text-mint-ink" size={20} />
        {topicLink(topic)}
      </Link>
    );
  if (!searchable(query)) return <Start />;
  return <Found query={query.trim()} />;
}

const HEADING = "text-sm font-semibold uppercase tracking-wider text-muted";

/** Before anything is typed: what to type, and the topics people are using. */
function Start() {
  const scan = useRecentScan();
  const visible = useVisiblePosts(scan.data);
  const topics = topTopics(visible.shown, 12);
  return (
    <>
      <p className="px-1 text-sm text-muted" data-testid="search-hint">
        {SEARCH_HINT}
      </p>
      <section aria-labelledby="search-topics" className="flex flex-col gap-3">
        <h2 className={HEADING} id="search-topics">
          {TOPICS_TITLE}
        </h2>
        {scan.isError ? (
          <div
            className="flex flex-col items-start gap-2"
            data-testid="search-topics-failed"
          >
            <p className="text-sm text-muted" role="status">
              {TOPICS_FAILED}
            </p>
            <Button
              onClick={() => void scan.refetch()}
              size="sm"
              variant="secondary"
            >
              {TRY_AGAIN}
            </Button>
          </div>
        ) : scan.isPending || !visible.ready ? (
          <p className="text-sm text-muted" role="status">
            {SEARCHING}
          </p>
        ) : topics.length === 0 ? (
          <p className="text-sm text-muted" data-testid="search-topics-none">
            {TOPICS_NONE}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="search-topics">
            {topics.map(({ tag, people }) => (
              <li key={tag}>
                <Link
                  className="glass glass-text inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold"
                  params={{ tag }}
                  to="/tag/$tag"
                >
                  #{tag}
                  <span className="sr-only">
                    , {people} {people === 1 ? "person" : "people"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Found({ query }: { query: string }) {
  const words = searchWords(query);
  return (
    <>
      <PeopleResults query={query} words={words} />
      <ProjectResults words={words} />
      <PostResults query={query} words={words} />
    </>
  );
}

function Status({
  failed,
  retry,
  testId,
  children,
}: {
  failed?: boolean;
  retry?: () => void;
  testId: string;
  children: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2" data-testid={testId}>
      <p className="text-sm text-muted" role="status">
        {children}
      </p>
      {failed && retry ? (
        <Button onClick={retry} size="sm" variant="secondary">
          {TRY_AGAIN}
        </Button>
      ) : null}
    </div>
  );
}

function PeopleResults({ query, words }: { query: string; words: string[] }) {
  const mutes = useMutes();
  const found = usePeopleSearch(query, true);
  const people = found.data ? personHits(found.data, words, mutes.muted) : [];
  const profiles = found.data;
  return (
    <section aria-labelledby="search-people" className="flex flex-col gap-3">
      <h2 className={HEADING} id="search-people">
        {PEOPLE_TITLE}
      </h2>
      {found.isError ? (
        <Status
          failed
          retry={() => void found.refetch()}
          testId="search-people-failed"
        >
          {PEOPLE_FAILED}
        </Status>
      ) : found.isPending ? (
        <Status testId="search-people-loading">{SEARCHING}</Status>
      ) : people.length === 0 ? (
        <Status testId="search-people-none">{NO_PEOPLE}</Status>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="search-people">
          {people.map((pubkey) => (
            <li key={pubkey}>
              <Link
                className="glass glass-text flex min-h-14 items-center gap-3 rounded-2xl px-3 py-2"
                data-testid="search-person"
                params={{ pubkey }}
                to="/u/$pubkey"
              >
                <Avatar
                  name={nameOf(profiles, pubkey)}
                  picture={pictureOf(profiles, pubkey)}
                  pubkey={pubkey}
                />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {nameOf(profiles, pubkey)}
                  </span>
                  {profiles?.[pubkey]?.about?.trim() ? (
                    <span className="line-clamp-1 block text-sm text-muted">
                      {profiles[pubkey].about}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectResults({ words }: { words: string[] }) {
  const projects = useHomeProjects();
  const hits = projects.data ? projectHits(projects.data, words) : [];
  const profiles = useProfiles(hits.map((p) => p.author)).data;
  return (
    <section aria-labelledby="search-projects" className="flex flex-col gap-3">
      <h2 className={HEADING} id="search-projects">
        {PROJECTS_TITLE}
      </h2>
      {projects.isError ? (
        <Status
          failed
          retry={() => void projects.refetch()}
          testId="search-projects-failed"
        >
          {PROJECTS_FAILED}
        </Status>
      ) : projects.isPending ? (
        <Status testId="search-projects-loading">{SEARCHING}</Status>
      ) : hits.length === 0 ? (
        <Status testId="search-projects-none">{NO_PROJECTS}</Status>
      ) : (
        <div className="flex flex-col gap-3" data-testid="search-projects">
          {hits.map((project) => (
            <ProjectCard
              key={project.coordinate}
              profiles={profiles}
              project={project}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PostResults({ query, words }: { query: string; words: string[] }) {
  const scan = useRecentScan();
  const server = usePostServerSearch(query, true);
  const hidden = useHidden();
  // The posts found, as every other list shows posts: none a room keeps, none from a person hidden, none reported.
  const hits = postHits(scan.data ?? [], server.data ?? [], words);
  const visible = useVisiblePosts(hits);
  // The scan is what a fresh server can be searched by; without it the answer is not "no posts".
  const failed = scan.isError && server.isError;
  const pending =
    !failed && (scan.isPending || server.isPending || !hidden.ready);
  return (
    <section aria-labelledby="search-posts" className="flex flex-col gap-3">
      <h2 className={HEADING} id="search-posts">
        {POSTS_TITLE}
      </h2>
      {failed ? (
        <Status
          failed
          retry={() => {
            void scan.refetch();
            void server.refetch();
          }}
          testId="search-posts-failed"
        >
          {POSTS_FAILED}
        </Status>
      ) : pending ? (
        <Status testId="search-posts-loading">{SEARCHING}</Status>
      ) : (
        <>
          {hidden.unknown ? (
            <p
              className="text-sm text-muted"
              data-testid="search-hides-unknown"
            >
              {HIDES_UNKNOWN}
            </p>
          ) : null}
          {scan.isError || server.isError ? (
            <Status
              failed
              retry={() => {
                if (scan.isError) void scan.refetch();
                if (server.isError) void server.refetch();
              }}
              testId="search-posts-partly"
            >
              {POSTS_PARTLY}
            </Status>
          ) : null}
          {visible.shown.length === 0 ? (
            <Status testId="search-posts-none">{NO_POSTS}</Status>
          ) : (
            <PostList events={visible.shown} testId="search-posts" />
          )}
          {visible.hidden > 0 ? (
            <p className="text-sm text-muted" data-testid="search-posts-hidden">
              {POSTS_HIDDEN(visible.hidden)}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
