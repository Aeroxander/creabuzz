/**
 * A page's title and description for the browser tab, for search, and for the previews that read a page after it
 * has run (`og:` tags). Set while the page is open and put back when it closes.
 *
 * A link pasted into a chat app is usually read without running the page, so those previews still show the site's
 * own title until the server sends these tags itself.
 */

import { useEffect } from "react";

const TAGS: readonly {
  attr: "name" | "property";
  key: string;
  from: "title" | "description" | "url";
}[] = [
  { attr: "name", key: "description", from: "description" },
  { attr: "property", key: "og:title", from: "title" },
  { attr: "property", key: "og:description", from: "description" },
  { attr: "property", key: "og:url", from: "url" },
  { attr: "name", key: "twitter:title", from: "title" },
  { attr: "name", key: "twitter:description", from: "description" },
];

export function usePageMeta(
  meta: { title: string; description: string } | null,
) {
  const title = meta?.title;
  const description = meta?.description;
  useEffect(() => {
    if (title === undefined || description === undefined) return;
    const values = { title, description, url: window.location.href };
    const before = document.title;
    document.title = title;
    const undo = TAGS.map(({ attr, key, from }) => {
      let tag = document.head.querySelector<HTMLMetaElement>(
        `meta[${attr}="${key}"]`,
      );
      const made = tag === null;
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute(attr, key);
        document.head.appendChild(tag);
      }
      const was = tag.getAttribute("content");
      tag.setAttribute("content", values[from]);
      const kept = tag;
      return () => {
        if (made) kept.remove();
        else if (was !== null) kept.setAttribute("content", was);
      };
    });
    return () => {
      document.title = before;
      for (const put of undo) put();
    };
  }, [title, description]);
}
