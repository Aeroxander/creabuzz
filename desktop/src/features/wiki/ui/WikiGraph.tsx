/**
 * The page-link graph: `[[wikilinks]]` and `#tags` between wiki pages.
 *
 * Ported from the web client's SVG spiral graph (web/src/features/wiki/
 * ui/WikiGraph.tsx); the desktop already draws graphs as SVG (the org
 * canvas's edge layer), so the same clean pattern applies here — no canvas
 * dependency. Real pages are solid nodes, referenced-but-missing pages are
 * hollow.
 */
import { useMemo } from "react";

import { extractLinks, type WikiPage } from "../lib/pageIndex";

interface GraphNode {
  id: string;
  x: number;
  y: number;
  page?: WikiPage;
}

export function WikiGraph({ pages }: { pages: readonly WikiPage[] }) {
  const { nodes, edges, width, height } = useMemo(() => {
    const byId = new Map<string, GraphNode>();
    let index = 0;
    const addNode = (id: string, page?: WikiPage) => {
      if (byId.has(id)) return;
      const angle = index * 2.399963;
      const radius = 40 + index * 14;
      byId.set(id, {
        id,
        x: 300 + radius * Math.cos(angle),
        y: 300 + radius * Math.sin(angle),
        page,
      });
      index += 1;
    };
    for (const page of pages) addNode(page.key, page);
    const links: Array<{ from: string; to: string }> = [];
    for (const page of pages) {
      for (const link of extractLinks(page.content)) {
        addNode(link);
        links.push({ from: page.key, to: link });
      }
    }
    return { nodes: byId, edges: links, width: 600, height: 600 };
  }, [pages]);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="wiki-graph">
      <p className="mb-2 text-2xs text-muted-foreground">
        {nodes.size} nodes · {edges.length} links · from [[wiki links]] and
        #tags
      </p>
      <svg
        aria-label="Wiki knowledge graph: pages and links between them"
        className="h-[560px] w-full max-w-[640px] rounded-md border bg-background"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {edges.map((edge) => {
          const a = nodes.get(edge.from);
          const b = nodes.get(edge.to);
          if (!a || !b) return null;
          return (
            <line
              className="stroke-foreground/25"
              key={`${edge.from}→${edge.to}`}
              strokeWidth={1}
              x1={a.x}
              x2={b.x}
              y1={a.y}
              y2={b.y}
            />
          );
        })}
        {[...nodes.values()].map((node) => (
          <g key={node.id}>
            <circle
              className={
                node.page
                  ? node.page.kind === "agent"
                    ? "fill-primary/80"
                    : "fill-status-review/80"
                  : "fill-muted-foreground/30"
              }
              cx={node.x}
              cy={node.y}
              r={node.page ? 14 : 7}
            />
            <text
              className="fill-foreground/70 text-2xs"
              x={node.x + (node.page ? 20 : 12)}
              y={node.y + 3}
            >
              {node.id}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
