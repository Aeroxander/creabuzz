/**
 * Fleet view — the live agent roster and the browser-agent launch control.
 *
 * Roster = live subscription over kind:44010 capabilities events (liveness
 * via heartbeat recency). Start/stop toggles the page's browser-hosted
 * agent, which announces itself, heartbeats, and answers mentions/tasks
 * through the relay's LLM gateway.
 */

import { useEffect, useState } from "react";
import {
  Bot,
  Cpu,
  Globe,
  HardDrive,
  Play,
  Power,
  Wifi,
  WifiOff,
} from "lucide-react";

import { useAgentRoster, type AgentCapabilities } from "../use-agent-roster";
import type { Channel } from "@/features/channels/use-channels";
import { getBrowserAgent, type AgentLifecycleState } from "../browser-agent";
import { getAgentPubkey } from "@/shared/lib/agent-identity";
import { truncatePubkey } from "@/shared/lib/pubkey";

function RuntypeIcon({ runtype }: { runtype: AgentCapabilities["runtype"] }) {
  if (runtype === "browser") return <Globe className="h-3.5 w-3.5" />;
  if (runtype === "desktop") return <HardDrive className="h-3.5 w-3.5" />;
  return <Cpu className="h-3.5 w-3.5" />;
}

function AgentCard({ agent }: { agent: AgentCapabilities }) {
  const me = agent.id === getAgentPubkey();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
      <div
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
          agent.alive
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-black/5 text-black/40 dark:bg-white/10 dark:text-white/40"
        }`}
      >
        <RuntypeIcon runtype={agent.runtype} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-black dark:text-white">
            {agent.name}
          </p>
          {me ? (
            <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-black/60 dark:bg-white/10 dark:text-white/60">
              this tab
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1 text-[11px] text-black/45 dark:text-white/45">
            {agent.alive ? (
              <Wifi className="h-3 w-3 text-emerald-500" />
            ) : (
              <WifiOff className="h-3 w-3 text-black/30 dark:text-white/30" />
            )}
            {agent.alive ? "online" : "offline"}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-black/45 dark:text-white/45">
          {agent.pubkey}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium capitalize text-black/60 dark:bg-white/10 dark:text-white/60">
            {agent.runtype}
          </span>
          <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] capitalize text-black/60 dark:bg-white/10 dark:text-white/60">
            {agent.status}
          </span>
          {agent.tools.map((tool) => (
            <span
              key={tool}
              className="rounded border border-black/10 px-1.5 py-0.5 text-[10px] text-black/50 dark:border-white/10 dark:text-white/50"
            >
              {tool}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FleetView({ channels }: { channels: Channel[] }) {
  const { agents, loading } = useAgentRoster();
  const [state, setState] = useState<AgentLifecycleState>("stopped");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const agent = getBrowserAgent();
    agent.setEvents({ onStateChange: setState });
    setState(agent.getState());
    return () => agent.setEvents({});
  }, []);

  const toggle = async () => {
    const agent = getBrowserAgent();
    if (agent.isRunning()) {
      agent.stop();
      setError(null);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      agent.setChannels(channels.map((c) => c.id));
      await agent.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start agent");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-black/60 dark:text-white/60" />
        <h2 className="text-sm font-semibold text-black dark:text-white">
          Agents
        </h2>
        <span className="ml-auto text-xs text-black/45 dark:text-white/45">
          {agents.filter((a) => a.alive).length} online · {agents.length} total
        </span>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={starting}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${
            state === "running"
              ? "border border-black/15 bg-white text-black hover:bg-black/5 dark:border-white/15 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
              : "bg-black text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
          }`}
          data-testid="browser-agent-toggle"
        >
          {state === "running" ? (
            <Power className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {state === "running"
            ? "Stop tab agent"
            : starting
              ? "Starting…"
              : "Run tab agent"}
        </button>
      </header>

      {error ? (
        <p className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {state === "running" ? (
        <p className="rounded-md border border-black/10 bg-white px-3 py-2 text-xs text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
          This tab's agent is <strong>online</strong> (
          {truncatePubkey(getAgentPubkey())}). Mention{" "}
          <code className="rounded bg-black/5 px-1 py-0.5 font-mono dark:bg-white/10">
            @buzz-tab
          </code>{" "}
          in a channel to get a response.
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto">
        {loading && agents.length === 0 ? (
          <p className="text-xs text-black/45 dark:text-white/45">
            Loading roster…
          </p>
        ) : agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
            <Bot className="mx-auto mb-2 h-8 w-8 text-black/30 dark:text-white/30" />
            No agents have announced yet. Run the tab agent (or a sandbox agent)
            to join the fleet.
          </div>
        ) : (
          agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)
        )}
      </div>
    </div>
  );
}
