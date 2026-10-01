/**
 * Browser-hosted fleet agent (Phase 1).
 *
 * A WebRuntime agent that lives in this tab: it advertises capabilities
 * (kind:44010, on change plus a slow keepalive), listens for channel mentions
 * and assigned tasks (kind:44011), and answers through the relay's LLM
 * gateway (`/llm/chat/completions` — the key stays server-side). It is
 * intentionally ephemeral: closing the tab takes it offline, which the
 * roster reflects within the liveness window.
 *
 * Single instance per page (`getBrowserAgent()`).
 */

import {
  KIND_AGENT_CAPABILITIES,
  KIND_AGENT_TASK,
  KIND_WIKI_PAGE,
} from "@/shared/constants/kinds";
import { TIMELINE_CONTENT_KINDS } from "@/features/channels/use-channel-messages";
import {
  shouldPublishAnnouncement,
  type PublishedAnnouncement,
} from "@/features/fleet/lib/heartbeat";
import {
  agentContextFilter,
  buildAgentTurnEvent,
} from "@/features/fleet/lib/agent-planes";
import {
  AGENT_NAME,
  TASK_PATTERN,
  answerWikiEdit,
  createWikiCopilotPolicy,
} from "@/features/fleet/lib/wiki-copilot";
import { parseTask } from "@/features/fleet/use-agent-tasks";
import {
  readMemory,
  writeMemory,
  recentChannelMemory,
  appendChannelMemory,
} from "@/features/fleet/agent-memory";
import { recordUsage } from "@/features/fleet/agent-usage";
import {
  queryEvents,
  type NostrFilter,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { getAgentPubkey, signAsAgent } from "@/shared/lib/agent-identity";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { truncatePubkey } from "@/shared/lib/pubkey";

export type AgentLifecycleState = "stopped" | "starting" | "running";

/**
 * How often the heartbeat timer LOOKS at whether to republish. It publishes
 * only on a change or once HEARTBEAT_INTERVAL_MS has passed since the last
 * publish (`shouldPublishAnnouncement`); a timer as slow as the keepalive would
 * miss it by publish latency and stretch every beat to two intervals.
 */
const HEARTBEAT_CHECK_MS = 60_000;
const MENTION_REPLY_COOLDOWN_MS = 30_000;
/** How long the roster of known agent identities is trusted. */
const KNOWN_AGENTS_TTL_MS = 10 * 60_000;
const MENTION_PATTERN = /@?buzz[- _]?tab\b|@buzz-agent\b/i;

interface BrowserAgentEvents {
  onStateChange?: (state: AgentLifecycleState) => void;
}

class BrowserAgent {
  private state: AgentLifecycleState = "stopped";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeMentions: (() => void) | null = null;
  private unsubscribeTasks: (() => void) | null = null;
  private unsubscribeWiki: (() => void) | null = null;
  private lastReplyAt = 0;
  /** True while a mention is being answered; the heartbeat reports it. */
  private busy = false;
  /** The last capabilities announcement the relay accepted. */
  private lastAnnouncement: PublishedAnnouncement | null = null;
  private events: BrowserAgentEvents = {};
  private channelIds: string[] = [];

  setEvents(events: BrowserAgentEvents): void {
    this.events = events;
  }

  getState(): AgentLifecycleState {
    return this.state;
  }

  /**
   * Set the community channels the agent listens to for mentions.
   *
   * A running agent rebinds its subscriptions: callers set the channels as
   * they load, and channels that were still empty at `start()` would otherwise
   * leave the agent deaf until it was stopped and started again.
   */
  setChannels(channelIds: string[]): void {
    const changed =
      channelIds.length !== this.channelIds.length ||
      channelIds.some((id, index) => id !== this.channelIds[index]);
    this.channelIds = channelIds;
    if (!changed || this.state !== "running") return;
    this.bindSubscriptions();
  }

  /** Team label announced in capabilities (persisted per browser). */
  setTeam(team: string | null): void {
    const value = (team ?? "").trim();
    try {
      if (value) localStorage.setItem("buzz.agent.team", value);
      else localStorage.removeItem("buzz.agent.team");
    } catch {
      // storage unavailable — announce still uses the in-memory value
    }
    this.teamOverride = value || null;
    void this.announce("available").catch(() => {});
  }

  private teamOverride: string | null = null;

  isRunning(): boolean {
    return this.state === "running";
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") return;
    this.setState("starting");
    // One agent service per browser origin: tabs race for the lock, and the
    // winner runs the fleet worker for the shared identity.
    const lock = await this.acquireOriginLock();
    if (!lock) {
      this.setState("stopped");
      throw new Error(
        "The tab agent is already running in another tab of this browser.",
      );
    }
    this.originLock = lock;
    try {
      await this.announce("available");
      this.heartbeatTimer = setInterval(() => {
        void this.announce(this.busy ? "busy" : "available").catch(() => {
          // transient publish failures are fine; the next check retries
        });
      }, HEARTBEAT_CHECK_MS);
      this.bindSubscriptions();
      this.setState("running");
    } catch (error) {
      console.error("[browser-agent] start failed", error);
      this.setState("stopped");
      throw error;
    }
  }

  /** (Re)bind the live mention, task, and wiki subscriptions. */
  private bindSubscriptions(): void {
    this.unbindSubscriptions();
    if (this.channelIds.length > 0) {
      // One socket per channel (same shape as the timeline's live pump —
      // multi-value "#h" filters are not matched by the relay).
      const liveSince = Math.floor(Date.now() / 1000) - 5;
      const unsubs = this.channelIds.map((channelId) =>
        subscribeChannel(
          relayWsUrl(),
          {
            kinds: TIMELINE_CONTENT_KINDS,
            "#h": [channelId],
            since: liveSince,
          } satisfies NostrFilter,
          {
            onEvent: (event) => void this.onMention(event),
          },
        ),
      );
      this.unsubscribeMentions = () => {
        for (const unsubscribe of unsubs) unsubscribe();
      };
      // Tasks are channel-scoped when captured (they carry the channel tag),
      // but community-global when created from the board without one. The
      // relay's scoping invariant walls global subs off from channel events
      // and vice versa, so we subscribe to both planes and route by the
      // assignee tag ourselves.
      const unsubTasks = this.channelIds.map((channelId) =>
        subscribeChannel(
          relayWsUrl(),
          {
            kinds: [KIND_AGENT_TASK],
            "#h": [channelId],
          } satisfies NostrFilter,
          { onEvent: (event) => void this.onTaskAssigned(event) },
        ),
      );
      unsubTasks.push(
        subscribeChannel(
          relayWsUrl(),
          { kinds: [KIND_AGENT_TASK] } satisfies NostrFilter,
          { onEvent: (event) => void this.onTaskAssigned(event) },
        ),
      );
      this.unsubscribeTasks = () => {
        for (const unsubscribe of unsubTasks) unsubscribe();
      };
      // Wiki copilot: answer "@buzz-tab:" inside wiki page content in-place.
      this.unsubscribeWiki = subscribeChannel(
        relayWsUrl(),
        { kinds: [KIND_WIKI_PAGE], since: liveSince } satisfies NostrFilter,
        { onEvent: (event) => void this.onWikiEdit(event) },
      );
    }
  }

  private unbindSubscriptions(): void {
    this.unsubscribeMentions?.();
    this.unsubscribeMentions = null;
    this.unsubscribeTasks?.();
    this.unsubscribeTasks = null;
    this.unsubscribeWiki?.();
    this.unsubscribeWiki = null;
  }

  stop(): void {
    if (this.state === "stopped") return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unbindSubscriptions();
    void this.announce("offline").catch(() => {
      // best-effort offline beacon
    });
    void this.originLock?.release();
    this.originLock = null;
    this.setState("stopped");
  }

  private originLock: { release(): Promise<void> } | null = null;

  private async acquireOriginLock(): Promise<{
    release(): Promise<void>;
  } | null> {
    if (typeof navigator === "undefined" || !navigator.locks) {
      return { release: async () => {} };
    }
    return new Promise<{ release(): Promise<void> } | null>((resolve) => {
      void navigator.locks.request(
        "buzz-agent",
        { ifAvailable: true },
        (lock) => {
          resolve(
            lock as {
              release(): Promise<void>;
            } | null,
          );
        },
      );
    });
  }

  private setState(state: AgentLifecycleState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }

  private async announce(status: "available" | "busy" | "offline") {
    const pubkey = getAgentPubkey();
    let team: string | null = this.teamOverride;
    if (!team) {
      try {
        team = localStorage.getItem("buzz.agent.team")?.trim() || null;
      } catch {
        team = null;
      }
    }
    const tools = ["chat", "wiki", "search"];
    // Kind 44010 is stored forever, so republish on a change (status, team,
    // tools) or as a slow keepalive — not on every timer tick.
    const fingerprint = JSON.stringify({
      name: AGENT_NAME,
      runtype: "browser",
      status,
      tools,
      team,
    });
    const nowMs = Date.now();
    if (!shouldPublishAnnouncement(this.lastAnnouncement, fingerprint, nowMs)) {
      return;
    }
    const capabilities = {
      name: AGENT_NAME,
      runtype: "browser",
      status,
      tools,
      team,
      heartbeat: Math.floor(nowMs / 1000),
    };
    const event = await signAsAgent({
      kind: KIND_AGENT_CAPABILITIES,
      tags: [["d", pubkey]],
      content: JSON.stringify(capabilities),
    });
    const result = await publishEvent(relayWsUrl(), event, {
      signAuth: signAsAgent,
    });
    if (!result.accepted) {
      throw new Error(result.message ?? "capabilities publish rejected");
    }
    // Only an accepted publish counts, so a rejected one is retried.
    this.lastAnnouncement = { fingerprint, atMs: nowMs };
  }

  private async onMention(event: NostrEvent) {
    if (event.pubkey === getAgentPubkey()) return;
    if (!MENTION_PATTERN.test(event.content)) return;
    // "@agent: <instruction>" delegates work — capture it as a task; the
    // task subscription (below) picks it up and processes it.
    if (TASK_PATTERN.test(event.content)) {
      void this.captureTask(event).catch((error) => {
        console.error("[browser-agent] task capture failed:", error);
      });
      return;
    }
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    if (Date.now() - this.lastReplyAt < MENTION_REPLY_COOLDOWN_MS) return;
    this.lastReplyAt = Date.now();

    this.setState("running");
    this.busy = true;
    void this.announce("busy").catch(() => {});

    try {
      const context = await this.loadChannelContext(channelId);
      const priorTurns = recentChannelMemory(channelId);
      const memoryBlock =
        priorTurns.length > 0
          ? `\n\nPrior turns with you in this channel:\n${priorTurns.join("\n")}`
          : "";
      const answer = await this.askLlm(
        `You are ${AGENT_NAME}, a browser-hosted fleet agent in a Creaton community channel. ` +
          "Answer the last message concisely. Use the channel context below.",
        `${context}${memoryBlock}\n\nSomeone wrote: ${event.content}`,
      );
      appendChannelMemory(channelId, event.content.slice(0, 200), answer);
      const threadParent = event.tags.find((t) => t[0] === "e")?.[1];
      await this.postTurn(channelId, answer, threadParent);
    } catch (error) {
      console.error("[browser-agent] mention failed:", error);
      await this.postTurn(
        channelId,
        `⚠️ gateway/agent error: ${error instanceof Error ? error.message : "unknown"} (echo: ${event.content.slice(0, 160)})`,
      );
    } finally {
      this.busy = false;
      void this.announce("available").catch(() => {});
    }
  }

  /**
   * Ids of task rows already handled. Bounded: the agent lives as long as the
   * tab does and the relay replays rows on every resubscribe, so an unbounded
   * set is a slow leak in a long-lived session.
   */
  private processedTaskRows = new Set<string>();
  private processedTaskOrder: string[] = [];
  private static readonly PROCESSED_TASK_LIMIT = 500;

  private rememberTaskRow(id: string): boolean {
    if (this.processedTaskRows.has(id)) return false;
    this.processedTaskRows.add(id);
    this.processedTaskOrder.push(id);
    while (this.processedTaskOrder.length > BrowserAgent.PROCESSED_TASK_LIMIT) {
      const oldest = this.processedTaskOrder.shift();
      if (oldest) this.processedTaskRows.delete(oldest);
    }
    return true;
  }

  private async onTaskAssigned(event: NostrEvent) {
    if (!this.rememberTaskRow(event.id)) return;
    const task = parseTask(event);
    if (!task) return;
    if (task.assignee !== getAgentPubkey()) return;
    // Own status-update rows (in_progress/done) are not new work. New work is
    // authored by others, or captured by us in the opening statuses.
    const ownRow = event.pubkey === getAgentPubkey();
    if (ownRow && task.status !== "open" && task.status !== "assigned") {
      return;
    }
    const channelId = task.channelId;
    try {
      await this.publishTaskUpdate(
        task.id,
        "in_progress",
        task.title,
        channelId,
        task.parentEventId ?? undefined,
      );
    } catch (error) {
      // Keep the board and the channel consistent: no "done" claim for a task
      // whose status rows the relay refuses.
      await this.postTurn(
        channelId ?? undefined,
        `⚠️ Task failed: ${error instanceof Error ? error.message : "unknown"}`,
        task.parentEventId ?? undefined,
      );
      return;
    }
    if (channelId) {
      await this.postTurn(
        channelId,
        `⚙️ Working: ${task.title}`,
        task.parentEventId ?? undefined,
      );
    }
    try {
      const prior = readMemory({ taskId: task.id });
      const prompt = prior
        ? `You already worked on this task earlier (outcome: ${prior.outcome.slice(0, 300)}). Continue from there if relevant.`
        : "This is a new task. Complete it concisely.";
      const answer = await this.askLlm(
        `You are ${AGENT_NAME}, a browser-hosted fleet agent. ${prompt}`,
        `Task: ${task.title}\n\n${task.description}`,
      );
      await this.publishTaskUpdate(
        task.id,
        "done",
        task.title,
        channelId,
        task.parentEventId ?? undefined,
      );
      writeMemory({
        taskId: task.id,
        channelId: channelId ?? undefined,
        instruction: task.title,
        outcome: answer,
      });
      await this.postTurn(
        channelId ?? undefined,
        `✅ Done: ${task.title}\n\n${answer}`,
        task.parentEventId ?? undefined,
      );
    } catch (error) {
      await this.postTurn(
        channelId ?? undefined,
        `⚠️ Task failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  /**
   * Pubkeys known to be agents (anyone who announced capabilities), so the
   * wiki copilot never answers another agent's page. Refreshed lazily; a failed
   * refresh keeps the previous set — the copilot's other guards (neutralised
   * trigger, reply tag, hourly budget) do not depend on it.
   */
  private knownAgents = new Set<string>();
  private knownAgentsAt = 0;

  private async refreshKnownAgents(): Promise<void> {
    if (Date.now() - this.knownAgentsAt < KNOWN_AGENTS_TTL_MS) return;
    // Stamp first so a failing relay is retried once per TTL, not per event.
    this.knownAgentsAt = Date.now();
    try {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_AGENT_CAPABILITIES],
        limit: 1000,
      });
      for (const event of events) this.knownAgents.add(event.pubkey);
    } catch (error) {
      console.warn("[browser-agent] could not list known agents", error);
    }
  }

  private wikiPolicy = createWikiCopilotPolicy({
    selfPubkey: () => getAgentPubkey(),
    knownAgents: () => this.knownAgents,
  });

  private async onWikiEdit(event: NostrEvent) {
    // Cheap exits first: most page events are not requests, and none of those
    // should cost a relay query.
    if (event.pubkey === getAgentPubkey()) return;
    if (!TASK_PATTERN.test(event.content)) return;
    await this.refreshKnownAgents();
    try {
      await answerWikiEdit(this.wikiPolicy, event, {
        ask: ({ slug, instruction, page }) =>
          this.askLlm(
            `You are ${AGENT_NAME}, a browser-hosted wiki copilot. A user asked you inside this wiki page. Answer concisely; the answer is appended to the page.`,
            `Wiki page "${slug}":\n\n${page}\n\nInstruction: ${instruction}`,
          ),
        publish: async (draft) => {
          const signed = await signAsAgent({
            kind: KIND_WIKI_PAGE,
            tags: draft.tags,
            content: draft.content,
          });
          const result = await publishEvent(relayWsUrl(), signed, {
            signAuth: signAsAgent,
          });
          if (!result.accepted) {
            console.warn("[browser-agent] wiki reply rejected", result.message);
          }
        },
      });
    } catch (error) {
      console.error("[browser-agent] wiki copilot failed:", error);
    }
  }

  private async captureTask(mention: NostrEvent) {
    const instruction = mention.content
      .replace(TASK_PATTERN, "")
      .trim()
      .slice(0, 400);
    const taskId = `task-${mention.id.slice(0, 16)}`;
    const channelId = mention.tags.find((t) => t[0] === "h")?.[1];
    const tags: string[][] = [["d", taskId]];
    if (channelId) tags.push(["h", channelId]);
    tags.push(["e", mention.id]);
    tags.push(["p", getAgentPubkey()]);
    const signed = await signAsAgent({
      kind: KIND_AGENT_TASK,
      tags,
      content: JSON.stringify({
        title: instruction || "Untitled task",
        description: "",
        status: "assigned",
      }),
    });
    const result = await publishEvent(relayWsUrl(), signed, {
      signAuth: signAsAgent,
    });
    if (!result.accepted) {
      console.warn("[browser-agent] task capture rejected", result.message);
    }
  }

  private async loadChannelContext(channelId: string): Promise<string> {
    const { queryEventsHttp } = await import("@/shared/lib/http-query");
    // Reads both chat planes (kind 9 history + kind 40002 v2 posts) plus
    // plain notes — see `agent-planes.ts`.
    const events = await queryEventsHttp([agentContextFilter(channelId)]);
    return events
      .slice(-10)
      .map((e) => `${truncatePubkey(e.pubkey)}: ${e.content.slice(0, 300)}`)
      .join("\n");
  }

  private async askLlm(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const url = `${relayHttpBaseUrl()}/llm/chat/completions`;
    // The gateway forwards this body to the relay's configured upstream. No
    // model name is built in (one only means something on one endpoint): the
    // operator pins it with BUZZ_LLM_MODEL on the relay, or a build sets
    // VITE_AGENT_MODEL.
    const model = import.meta.env.VITE_AGENT_MODEL;
    const body = JSON.stringify({
      ...(model ? { model } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // Reasoning models spend tokens before answering — keep the budget high
      // enough that `content` is never an empty cut-off.
      max_tokens: 4096,
    });
    const { makeNip98AuthHeader } = await import("@/shared/lib/nip98");
    const auth = await makeNip98AuthHeader(url, "POST", { body });
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body,
    });
    if (!response.ok) {
      let detail = `gateway ${response.status}`;
      try {
        const json = (await response.json()) as { error?: string };
        if (json.error) detail = json.error;
      } catch {
        // non-JSON error
      }
      throw new Error(detail);
    }
    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (json.usage) {
      recordUsage({
        prompt: json.usage.prompt_tokens ?? 0,
        completion: json.usage.completion_tokens ?? 0,
        model,
      });
    }
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty LLM response");
    return content;
  }

  private async publishTaskUpdate(
    taskId: string,
    status: string,
    title: string,
    channelId: string | null = null,
    parentEventId?: string,
  ) {
    const tags: string[][] = [
      ["d", taskId],
      ["p", getAgentPubkey()],
    ];
    // Carry the original task's channel + thread link so the update stays
    // findable in-context and the board keeps the parent e-tag.
    if (channelId) tags.push(["h", channelId]);
    if (parentEventId) tags.push(["e", parentEventId]);
    // A status row writes only what it changes: omitting the planning fields
    // (description, priority, milestone, reward…) leaves them as they were —
    // the board merges rows field by field (`lib/task-planning.ts`). Writing
    // `description: ""` here used to erase the task's description.
    const signed = await signAsAgent({
      kind: KIND_AGENT_TASK,
      tags,
      content: JSON.stringify({ title, status }),
    });
    const result = await publishEvent(relayWsUrl(), signed, {
      signAuth: signAsAgent,
    });
    if (!result.accepted) {
      // The board never saw this status. Report the failure instead of letting
      // the caller claim the task progressed.
      throw new Error(result.message ?? "task update rejected");
    }
  }

  private async postTurn(
    channelId: string | undefined,
    content: string,
    parentEventId?: string,
  ) {
    const tags: string[][] = [];
    if (channelId) tags.push(["h", channelId]);
    // Thread participation: delegation replies attach to the assignment message.
    if (parentEventId) tags.push(["e", parentEventId]);
    // Posts on the live agent wire plane (kind 9), the one every producer
    // speaks — see `agent-planes.ts`.
    const signed = await signAsAgent(buildAgentTurnEvent(content, tags));
    const result = await publishEvent(relayWsUrl(), signed, {
      signAuth: signAsAgent,
    });
    if (!result.accepted) {
      console.warn("[browser-agent] turn rejected", result);
    }
  }
}

let instance: BrowserAgent | null = null;
/** Page-wide singleton. */
export function getBrowserAgent(): BrowserAgent {
  if (!instance) instance = new BrowserAgent();
  return instance;
}
