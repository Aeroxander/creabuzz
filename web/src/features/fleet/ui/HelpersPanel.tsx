/**
 * Helpers, in plain words: the seats your project has for them, and the three
 * places one can run.
 *
 * A project made from a template has a seat per helper (The Writer, The
 * Producer…), each open until a helper takes it. From an open seat you can run
 * that helper in this tab. Under it, the three ways to run a helper (this tab,
 * the server, your computer) say what each is and whether it will work on this
 * server right now, so nobody has to know what an agent runtime is to choose.
 *
 * What is true of each way is worked out in `../lib/helper-ways.ts`; this file
 * only shows it.
 */

import { Bot, Cpu, Globe, HardDrive } from "lucide-react";

import { DESKTOP_APP } from "@/shared/lib/desktop-app";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  type AnnouncedHelper,
  describeWays,
  type GatewayStatus,
  type Way,
  type WayId,
} from "../lib/helper-ways";
import { describeSeat, type HelperSeat } from "../lib/helper-seats";
import { peekAgentPubkey } from "@/shared/lib/agent-identity";
import type { AgentCapabilities } from "../use-agent-roster";
import type { TabHelper } from "../use-tab-helper";

const WAY_ICON: Record<WayId, typeof Globe> = {
  tab: Globe,
  server: Cpu,
  computer: HardDrive,
};

const STATE_CLASS: Record<Way["state"], string> = {
  ready: "bg-primary/10 text-primary-ink",
  running: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  unavailable: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  unknown: "bg-secondary text-muted-foreground",
};

function ServerSteps() {
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">
        How to start one (for whoever runs the server)
      </summary>
      <div className="mt-2 space-y-2">
        <p>
          Run <code className="font-mono">buzz-fleet-worker</code> next to the
          server. It joins the community like any helper and keeps working with
          every laptop closed. It needs:
        </p>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <code className="font-mono">BUZZ_RELAY_URL</code>, the server's
            address,
          </li>
          <li>
            a key for the helper in{" "}
            <code className="font-mono">BUZZ_FLEET_WORKER_KEY_FILE</code>,
          </li>
          <li>
            an AI provider: either{" "}
            <code className="font-mono">BUZZ_FLEET_WORKER_LLM_URL</code> with{" "}
            <code className="font-mono">BUZZ_FLEET_WORKER_LLM_API_KEY</code>, or
            the server's own AI service through{" "}
            <code className="font-mono">BUZZ_FLEET_WORKER_GATEWAY</code>.
          </li>
        </ul>
        <p>Once it is running it shows up here within a minute.</p>
      </div>
    </details>
  );
}

function WayCard({ way, tab }: { way: Way; tab: TabHelper }) {
  const Icon = WAY_ICON[way.id];
  return (
    <li
      className="flex flex-col gap-1 rounded-xl border p-3 text-sm"
      data-testid={`helper-way-${way.id}`}
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="h-4 w-4 text-muted-foreground" />
        <h4 className="font-semibold">{way.title}</h4>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-2xs font-medium ${STATE_CLASS[way.state]}`}
          data-testid={`helper-way-${way.id}-state`}
        >
          {way.state === "ready"
            ? "Ready"
            : way.state === "running"
              ? "Running"
              : way.state === "unavailable"
                ? "Not available"
                : "Unknown"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{way.summary}</p>
      <p className="text-xs" data-testid={`helper-way-${way.id}-status`}>
        {way.status}
      </p>
      {way.id === "tab" && tab.state === "running" ? (
        <div>
          <Button onClick={tab.stop} size="sm" variant="outline">
            Stop it
          </Button>
        </div>
      ) : null}
      {way.id === "server" ? <ServerSteps /> : null}
      {/* No download link: this product has no desktop release of its own to point at yet. */}
      {way.id === "computer" && DESKTOP_APP ? (
        <p className="text-xs text-muted-foreground">
          Sign in to this community in the desktop app and start your project's
          helpers from its list.
        </p>
      ) : null}
    </li>
  );
}

export function HelpersPanel({
  seats,
  agents,
  gateway,
  tab,
}: {
  seats: HelperSeat[];
  agents: AgentCapabilities[];
  gateway: GatewayStatus;
  tab: TabHelper;
}) {
  const byPubkey = new Map(
    agents.map((a) => [a.pubkey, { name: a.name, alive: a.alive }]),
  );
  const announced: AnnouncedHelper[] = agents.map((a) => ({
    name: a.name,
    runtype: a.runtype,
    alive: a.alive,
  }));
  const ways = describeWays({
    gateway,
    tab: {
      state: tab.starting
        ? "starting"
        : tab.state === "running"
          ? "running"
          : "stopped",
      name:
        tab.persona?.name ??
        (tab.state === "running" ? "The general assistant" : null),
    },
    helpers: announced,
    desktopApp: DESKTOP_APP,
  });
  const tabPubkey = peekAgentPubkey();
  const noService = gateway === "missing";

  return (
    <div className="flex flex-col gap-4" data-testid="helpers-panel">
      {seats.length > 0 ? (
        <Card className="p-4" data-testid="helper-seats">
          <h3 className="text-sm font-semibold">Your project's helpers</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each helper has a seat on your team. An open seat is waiting for a
            helper to run.
          </p>
          <ul className="mt-3 flex flex-col divide-y divide-border/60">
            {seats.map((seat) => {
              const status = describeSeat(seat, byPubkey);
              const mine =
                tabPubkey !== null &&
                tab.state === "running" &&
                seat.occupants.includes(tabPubkey);
              return (
                <li
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                  data-testid={`helper-seat-${seat.personaId ?? seat.nodeId}`}
                  key={seat.key}
                >
                  <span className="font-medium">{seat.title}</span>
                  <span
                    className={`text-xs ${
                      status.state === "online"
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-muted-foreground"
                    }`}
                    data-testid={`helper-seat-${seat.personaId ?? seat.nodeId}-status`}
                  >
                    {status.text}
                  </span>
                  <span className="ml-auto">
                    {mine ? (
                      <Button onClick={tab.stop} size="sm" variant="outline">
                        Stop
                      </Button>
                    ) : status.state === "open" && seat.personaId ? (
                      <Button
                        data-testid={`seat-run-${seat.personaId}`}
                        disabled={tab.starting || noService}
                        onClick={() => void tab.start(seat)}
                        size="sm"
                        title={
                          noService
                            ? "This server has no AI service set up for tab helpers."
                            : undefined
                        }
                      >
                        {tab.starting ? "Starting…" : "Run in this tab"}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            A tab runs one helper at a time. To have the whole crew working at
            once, run them on the server
            {DESKTOP_APP ? " or on your computer" : ""}.
          </p>
          {tab.error ? (
            <p
              className="mt-2 text-xs text-destructive"
              data-testid="helper-start-problem"
              role="alert"
            >
              {tab.error}
            </p>
          ) : null}
          {tab.seatProblem ? (
            <p
              className="mt-2 text-xs text-destructive"
              data-testid="helper-seat-problem"
              role="alert"
            >
              {tab.seatProblem}
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card className="p-4" data-testid="add-helper">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Bot aria-hidden className="h-4 w-4" />
          Ways to run a helper
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          You can use any of these, and more than one at a time.
        </p>
        <ul className="mt-3 grid gap-3 lg:grid-cols-3">
          {ways.map((way) => (
            <WayCard key={way.id} tab={tab} way={way} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
