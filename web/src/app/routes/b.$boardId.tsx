import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const BoardPage = lazyRouteComponent(
  () => import("@/features/board/ui/BoardPage"),
  "BoardPage",
);

interface BoardSearch {
  /** The post that is open on the board. */
  post?: string;
}

export const Route = createFileRoute("/b/$boardId")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    post: typeof search.post === "string" ? search.post : undefined,
  }),
  component: BoardRoute,
});

function BoardRoute() {
  const { boardId } = Route.useParams();
  const { post } = Route.useSearch();
  return <BoardPage boardId={boardId} postId={post} />;
}
