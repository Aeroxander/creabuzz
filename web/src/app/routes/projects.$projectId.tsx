import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>) => ({
    // Node ids are unique per author, so a project address is
    // `?author=<founder hex>` — same shape as `/launchpad/$launchId`.
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
  }),
  component: ProjectDetailRoute,
});

// Wrapper stays eager for `useParams`/`useSearch`; the page body loads on
// demand like the launchpad's detail route.
const ProjectDetailPage = lazyRouteComponent(
  () => import("@/features/projects/ui/ProjectDetailPage"),
  "ProjectDetailPage",
);

function ProjectDetailRoute() {
  const { projectId } = Route.useParams();
  const { author } = Route.useSearch();
  return <ProjectDetailPage author={author} projectId={projectId} />;
}
