import { index, route, rootRoute } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  index("index.tsx"),
  route("/c", "c.tsx"),
  route("/u/$pubkey", "u.$pubkey.tsx"),
  route("/discover", "discover.tsx"),
  route("/c/$host", "c.$host.tsx"),
  route("/identity-demo", "identity-demo.tsx"),
  route("/link-device", "link-device.tsx"),
  route("/invite/$code", "invite.$code.tsx"),
  route("/repos", "repos.tsx"),
  route("/repos/$repoId", "repos.$repoId.tsx"),
  route("/launchpad", "launchpad.tsx"),
  route("/launchpad/$launchId", "launchpad.$launchId.tsx"),
  route("/projects", "projects.tsx"),
  route("/projects/$projectId", "projects.$projectId.tsx"),
  route("/portfolio", "portfolio.tsx"),
  route("/repos/$repoId/blob/$", "repos.$repoId.blob.$.tsx"),
]);
