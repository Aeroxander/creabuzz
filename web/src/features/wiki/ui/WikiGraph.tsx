import { useRef } from "react";

import { extractLinks, type WikiPage } from "../use-wiki-pages";

interface Node {
  id: string;
  x: number;
  y: number;
  page?: WikiPage;
}

export function WikiGraph({ pages }: { pages: WikiPage[] }) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Build nodes (pages + referenced-but-missing pages) on a spiral.
  const nodes = new Map<string, Node>();
  let idx = 0;
  const addNode = (id: string, page?: WikiPage) => {
    if (nodes.has(id)) return;
    const angle = idx * 2.399963;
    const radius = 40 + idx * 14;
    nodes.set(id, {
      id,
      x: 300 + radius * Math.cos(angle),
      y: 300 + radius * Math.sin(angle),
      page,
    });
    idx += 1;
  };
  for (const page of pages) addNode(page.slug, page);
  const edges = new Set<string>();
  for (const page of pages) {
    for (const link of extractLinks(page.content)) {
      addNode(link);
      edges.add(`${page.slug}→${link}`);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <p className="mb-2 text-xs text-black/45 dark:text-white/45">
        {nodes.size} nodes · {edges.size} links · from [[wiki links]] and #tags
      </p>
      <svg
        ref={svgRef}
        viewBox="0 0 600 600"
        role="img"
        aria-label="Wiki knowledge graph: pages and links between them"
        className="h-[560px] w-full max-w-[640px] rounded-md border border-black/10 bg-white dark:border-white/10 dark:bg-white/5"
        data-testid="wiki-graph"
      >
        {[...edges].map(([from, to]) => {
          const a = nodes.get(from);
          const b = nodes.get(to);
          if (!a || !b) return null;
          return (
            <line
              key={`${from}→${to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="rgba(120,120,120,0.35)"
              strokeWidth={1}
            />
          );
        })}
        {[...nodes.values()].map((node) => (
          <g key={node.id}>
            <circle
              cx={node.x}
              cy={node.y}
              r={node.page ? 14 : 7}
              fill={node.page ? "#7c6ff0" : "#bbb"}
              opacity={0.85}
            />
            <text
              x={node.x + (node.page ? 20 : 12)}
              y={node.y + 3}
              fontSize={10}
              fill="currentColor"
            >
              {node.id}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
