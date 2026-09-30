import { createFileRoute } from "@tanstack/react-router";
import { CommunityHomePage } from "@/features/communities/ui/CommunityHomePage";

/**
 * `view` names the surface the sidebar is showing, `page` a wiki page and `work`
 * a work item. Without them a page or a task had no address at all: a decision
 * could not be linked to, and a reload lost the surface.
 */
export type CommunityView = "channels" | "wiki" | "work" | "org" | "fleet";

interface CommunitySearch {
  channel?: string;
  /** Message permalink target: the row is scrolled to and highlighted. */
  message?: string;
  view?: CommunityView;
  /** Wiki page slug. */
  page?: string;
  /** Work-item id (`d` tag of its 44011 record). */
  work?: string;
}

const VIEWS: CommunityView[] = ["channels", "wiki", "work", "org", "fleet"];

export const Route = createFileRoute("/c/$host")({
  validateSearch: (search: Record<string, unknown>): CommunitySearch => {
    const view = VIEWS.includes(search.view as CommunityView)
      ? (search.view as CommunityView)
      : undefined;
    return {
      channel: typeof search.channel === "string" ? search.channel : undefined,
      message: typeof search.message === "string" ? search.message : undefined,
      view: view === "channels" ? undefined : view,
      page: typeof search.page === "string" ? search.page : undefined,
      work: typeof search.work === "string" ? search.work : undefined,
    };
  },
  component: CommunityHomePage,
});
