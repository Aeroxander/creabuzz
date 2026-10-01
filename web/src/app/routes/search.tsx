import { createFileRoute } from "@tanstack/react-router";
import { SearchPage } from "@/features/feed/ui/SearchPage";

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: SearchPage,
});
