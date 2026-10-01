import { index, route, rootRoute } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  index("index.tsx"),
  route("/invite/$code", "invite.$code.tsx"),
  route("/feed", "feed.tsx"),
  route("/feed/$noteId", "feed.$noteId.tsx"),
  route("/bookmarks", "bookmarks.tsx"),
  route("/p/$id", "p.$id.tsx"),
  route("/tag/$tag", "tag.$tag.tsx"),
  route("/repos", "repos.tsx"),
  route("/repos/$repoId", "repos.$repoId.tsx"),
  route("/repos/$repoId/blob/$", "repos.$repoId.blob.$.tsx"),
]);
