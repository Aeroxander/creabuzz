/**
 * The three places a helper can run, and what is true of each one on this
 * server right now. Alias-free; `helper-ways.test.mjs` drives it under
 * `node --test`.
 *
 * Helpers run in one of three places, and a person choosing needs to know what
 * each is and whether it will work here:
 *
 * - **In this browser tab.** Starts at once, answers through the server's AI
 *   service, and stops when the tab closes. It only works if the server has an
 *   AI service set up.
 * - **On the server.** Always on, even with every laptop closed. Whoever runs
 *   the server starts it; we can only say whether one is running.
 * - **On your computer.** The desktop app (or the command line) runs the AI
 *   tools you already use, and keeps working when this tab is closed.
 *
 * The statuses are read from what the page can see (the server's AI service,
 * the helpers that have announced themselves, this tab's own state); nothing is
 * claimed that the page cannot tell.
 */

export type WayId = "tab" | "server" | "computer";

/** Whether the server has an AI service the tab can use. */
export type GatewayStatus = "available" | "missing" | "unknown";

/** A helper that has announced itself. */
export interface AnnouncedHelper {
  name: string;
  runtype: "browser" | "desktop" | "sandbox";
  alive: boolean;
}

export type WayState =
  /** Works here and nothing is running yet. */
  | "ready"
  /** Something is running in this place. */
  | "running"
  /** Cannot work here until something changes. */
  | "unavailable"
  /** The page cannot tell. */
  | "unknown";

/** One way, in words. */
export interface Way {
  id: WayId;
  title: string;
  /** What it is, in one sentence. */
  summary: string;
  state: WayState;
  /** What is true of it right now. */
  status: string;
}

function names(helpers: readonly AnnouncedHelper[]): string {
  const list = helpers.map((h) => h.name);
  if (list.length <= 2) return list.join(" and ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

export function describeWays(input: {
  gateway: GatewayStatus;
  /** This tab's helper: stopped, starting or running, and its name when it has one. */
  tab: { state: "stopped" | "starting" | "running"; name: string | null };
  helpers: readonly AnnouncedHelper[];
}): Way[] {
  const onServer = input.helpers.filter((h) => h.runtype === "sandbox");
  const onComputers = input.helpers.filter((h) => h.runtype === "desktop");
  const serverLive = onServer.filter((h) => h.alive);
  const computerLive = onComputers.filter((h) => h.alive);

  let tab: Pick<Way, "state" | "status">;
  if (input.tab.state === "running") {
    tab = {
      state: "running",
      status: `${input.tab.name ?? "A helper"} is running in this tab.`,
    };
  } else if (input.gateway === "missing") {
    tab = {
      state: "unavailable",
      status:
        "This server has no AI service set up, so a tab helper cannot answer. Use another way, or ask whoever runs the server.",
    };
  } else if (input.gateway === "unknown") {
    tab = {
      state: "unknown",
      status: "We could not check whether this server has an AI service.",
    };
  } else {
    tab = { state: "ready", status: "Ready to start." };
  }

  let server: Pick<Way, "state" | "status">;
  if (serverLive.length > 0) {
    server = {
      state: "running",
      status: `${names(serverLive)} ${serverLive.length === 1 ? "is" : "are"} running on this server.`,
    };
  } else if (onServer.length > 0) {
    server = {
      state: "unavailable",
      status: `${names(onServer)} ${onServer.length === 1 ? "is" : "are"} set up on this server but offline right now.`,
    };
  } else {
    server = {
      state: "unavailable",
      status:
        "Nothing is running on this server yet. Whoever runs it can start one (the steps are below).",
    };
  }

  const computer: Pick<Way, "state" | "status"> =
    computerLive.length > 0
      ? {
          state: "running",
          status: `${names(computerLive)} ${computerLive.length === 1 ? "is" : "are"} running from a computer.`,
        }
      : onComputers.length > 0
        ? {
            state: "ready",
            status: `${names(onComputers)} ${onComputers.length === 1 ? "was" : "were"} started from a computer and ${onComputers.length === 1 ? "is" : "are"} offline now.`,
          }
        : { state: "ready", status: "Works with the desktop app." };

  return [
    {
      id: "tab",
      title: "In this browser tab",
      summary:
        "The quickest way to try one. It answers while this tab is open and stops when you close it.",
      ...tab,
    },
    {
      id: "server",
      title: "On the server",
      summary:
        "Always on, even when every laptop is closed. Whoever runs the server starts it.",
      ...server,
    },
    {
      id: "computer",
      title: "On your computer",
      summary:
        "The desktop app runs the AI tools you already use and keeps working when this tab is closed.",
      ...computer,
    },
  ];
}
