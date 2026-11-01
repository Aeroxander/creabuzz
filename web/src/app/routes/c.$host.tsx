import { createFileRoute } from "@tanstack/react-router";
import { CommunityHomePage } from "@/features/communities/ui/CommunityHomePage";
import { notContributorOnlyBuild } from "../lib/build-gates";

/**
 * `view` names the surface the sidebar is showing, `page` a wiki page and `work`
 * a work item. Without them a page or a task had no address at all: a decision
 * could not be linked to, and a reload lost the surface.
 */
type CommunityView = "channels" | "wiki" | "work" | "org" | "fleet" | "people";

interface CommunitySearch {
  channel?: string;
  /** Message permalink target: the row is scrolled to and highlighted. */
  message?: string;
  view?: CommunityView;
  /** Wiki page slug. */
  page?: string;
  /** Work-item id (`d` tag of its 44011 record). */
  work?: string;
  /** A post on the board in `channel`: opens its thread. */
  post?: string;
}

const VIEWS: CommunityView[] = [
  "channels",
  "wiki",
  "work",
  "org",
  "fleet",
  "people",
];

export const Route = createFileRoute("/c/$host")({
  validateSearch: (search: Record<string, unknown>): CommunitySearch => {
    // The work board is called Tasks on screen; a link that says so opens it too.
    const asked = search.view === "tasks" ? "work" : search.view;
    const known = VIEWS.includes(asked as CommunityView)
      ? (asked as CommunityView)
      : undefined;
    // AI helpers and Org (helper budgets) are not in a contributor-only build: a link to them opens the rooms.
    const view =
      (known === "fleet" || known === "org") && !notContributorOnlyBuild()
        ? undefined
        : known;
    return {
      channel: typeof search.channel === "string" ? search.channel : undefined,
      message: typeof search.message === "string" ? search.message : undefined,
      view: view === "channels" ? undefined : view,
      page: typeof search.page === "string" ? search.page : undefined,
      work: typeof search.work === "string" ? search.work : undefined,
      post: typeof search.post === "string" ? search.post : undefined,
    };
  },
  component: CommunityHomePage,
});
