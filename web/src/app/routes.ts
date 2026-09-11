import { index, route, rootRoute } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  index("index.tsx"),
  route("/c/$host", "c.$host.tsx"),
  route("/invite/$code", "invite.$code.tsx"),
  route("/repos", "repos.tsx"),
  route("/repos/$repoId", "repos.$repoId.tsx"),
  route("/launchpad", "launchpad.tsx"),
  route("/launchpad/$launchId", "launchpad.$launchId.tsx"),
  route("/repos/$repoId/blob/$", "repos.$repoId.blob.$.tsx"),
]);
