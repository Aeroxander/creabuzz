/**
 * Browser-hosted fleet agent (Phase 1).
 *
 * A WebRuntime agent that lives in this tab: it advertises capabilities
 * (kind:44010, with a periodic heartbeat), listens for channel mentions
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
import { parseTask } from "@/features/fleet/use-agent-tasks";
import {
  readMemory,
  writeMemory,
  recentChannelMemory,
  appendChannelMemory,
} from "@/features/fleet/agent-memory";
import { recordUsage } from "@/features/fleet/agent-usage";
import type { NostrFilter, NostrEvent } from "@/shared/lib/nostr-client";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { getAgentPubkey, signAsAgent } from "@/shared/lib/agent-identity";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { truncatePubkey } from "@/shared/lib/pubkey";

export type AgentLifecycleState = "stopped" | "starting" | "running";

const HEARTBEAT_MS = 60_000;
const MENTION_REPLY_COOLDOWN_MS = 30_000;
const AGENT_NAME = "buzz-tab";
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
  private events: BrowserAgentEvents = {};
  private channelIds: string[] = [];

  setEvents(events: BrowserAgentEvents): void {
    this.events = events;
  }

  getState(): AgentLifecycleState {
    return this.state;
  }

  /** Set the community channels the agent listens to for mentions. */
  setChannels(channelIds: string[]): void {
    this.channelIds = channelIds;
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
        void this.announce("available").catch(() => {
          // transient publish failures are fine; the next beat retries
        });
      }, HEARTBEAT_MS);
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
      this.setState("running");
    } catch (error) {
      console.error("[browser-agent] start failed", error);
      this.setState("stopped");
      throw error;
    }
  }

  stop(): void {
    if (this.state === "stopped") return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unsubscribeMentions?.();
    this.unsubscribeMentions = null;
    this.unsubscribeTasks?.();
    this.unsubscribeTasks = null;
    this.unsubscribeWiki?.();
    this.unsubscribeWiki = null;
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
    const capabilities = {
      name: AGENT_NAME,
      runtype: "browser",
      status,
      tools: ["chat", "wiki", "search"],
      team,
      heartbeat: Math.floor(Date.now() / 1000),
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
  }

  private TASK_PATTERN = new RegExp(`^@${AGENT_NAME}\s*:`, "i");

  private async onMention(event: NostrEvent) {
    if (event.pubkey === getAgentPubkey()) return;
    if (!MENTION_PATTERN.test(event.content)) return;
    // "@agent: <instruction>" delegates work — capture it as a task; the
    // task subscription (below) picks it up and processes it.
    if (this.TASK_PATTERN.test(event.content)) {
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
      void this.announce("available").catch(() => {});
    }
  }

  private processedTaskRows = new Set<string>();

  private async onTaskAssigned(event: NostrEvent) {
    if (this.processedTaskRows.has(event.id)) return;
    this.processedTaskRows.add(event.id);
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
    await this.publishTaskUpdate(
      task.id,
      "in_progress",
      task.title,
      channelId,
      task.parentEventId ?? undefined,
    );
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

  private async onWikiEdit(event: NostrEvent) {
    if (event.pubkey === getAgentPubkey()) return;
    if (!this.TASK_PATTERN.test(event.content)) return;
    const slug = event.tags.find((t) => t[0] === "d")?.[1];
    if (!slug) return;
    const instruction = event.content
      .replace(this.TASK_PATTERN, "")
      .trim()
      .slice(0, 400);
    try {
      const answer = await this.askLlm(
        `You are ${AGENT_NAME}, a browser-hosted wiki copilot. A user asked you inside this wiki page. Answer concisely; the answer is appended to the page.`,
        `Wiki page "${slug}":\n\n${event.content.slice(0, 3000)}\n\nInstruction: ${instruction}`,
      );
      if (!this.TASK_PATTERN.test(event.content)) return; // user already edited past the ask
      const updated = `${event.content}\n\n---\n> ✍️ ${AGENT_NAME}\n\n${answer.slice(0, 2000)}`;
      const signed = await signAsAgent({
        kind: KIND_WIKI_PAGE,
        tags: [["d", slug]],
        content: updated,
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsAgent,
      });
      if (!result.accepted) {
        console.warn("[browser-agent] wiki reply rejected", result.message);
      }
    } catch (error) {
      console.error("[browser-agent] wiki copilot failed:", error);
    }
  }

  private async captureTask(mention: NostrEvent) {
    const instruction = mention.content
      .replace(this.TASK_PATTERN, "")
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
    const events = await queryEventsHttp([
      { kinds: [1, 40002], "#h": [channelId], limit: 25 },
    ]);
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
    // The gateway forwards this body to the relay's configured upstream;
    // VITE_AGENT_MODEL overrides the deployment default.
    const model =
      import.meta.env.VITE_AGENT_MODEL ?? "umans-deepseek-v4-flash-0731";
    const body = JSON.stringify({
      model,
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
    // Carry the original task's channel so the update is findable in-context.
    const signed = await signAsAgent({
      kind: KIND_AGENT_TASK,
      tags,
      content: JSON.stringify({ title, description: "", status }),
    });
    const result = await publishEvent(relayWsUrl(), signed, {
      signAuth: signAsAgent,
    });
    if (!result.accepted) {
      console.warn("[browser-agent] task update rejected", result.message);
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
    const signed = await signAsAgent({
      kind: 40002,
      tags,
      content,
    });
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
