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
} from "@/shared/constants/kinds";
import { TIMELINE_CONTENT_KINDS } from "@/features/channels/use-channel-messages";
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

  isRunning(): boolean {
    return this.state === "running";
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") return;
    this.setState("starting");
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
        const unsubs = this.channelIds.map((channelId) =>
          subscribeChannel(
            relayWsUrl(),
            {
              kinds: TIMELINE_CONTENT_KINDS,
              "#h": [channelId],
            } satisfies NostrFilter,
            {
              onEvent: (event) => void this.onMention(event),
            },
          ),
        );
        this.unsubscribeMentions = () => {
          for (const unsubscribe of unsubs) unsubscribe();
        };
      }
      this.unsubscribeTasks = subscribeChannel(
        relayWsUrl(),
        {
          kinds: [KIND_AGENT_TASK],
          "#p": [getAgentPubkey()],
        } satisfies NostrFilter,
        { onEvent: (event) => void this.onTaskAssigned(event) },
      );
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
    void this.announce("offline").catch(() => {
      // best-effort offline beacon
    });
    this.setState("stopped");
  }

  private setState(state: AgentLifecycleState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }

  private async announce(status: "available" | "busy" | "offline") {
    const pubkey = getAgentPubkey();
    const capabilities = {
      name: AGENT_NAME,
      runtype: "browser",
      status,
      tools: ["chat", "wiki", "search"],
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

  private async onMention(event: NostrEvent) {
    if (event.pubkey === getAgentPubkey()) return;
    if (!MENTION_PATTERN.test(event.content)) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    if (Date.now() - this.lastReplyAt < MENTION_REPLY_COOLDOWN_MS) return;
    this.lastReplyAt = Date.now();

    this.setState("running");
    void this.announce("busy").catch(() => {});

    try {
      const context = await this.loadChannelContext(channelId);
      const answer = await this.askLlm(
        `You are ${AGENT_NAME}, a browser-hosted fleet agent in a Buzz community channel. ` +
          "Answer the last message concisely. Use the channel context below.",
        `${context}\n\nSomeone wrote: ${event.content}`,
      );
      await this.postTurn(channelId, answer);
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

  private async onTaskAssigned(event: NostrEvent) {
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    await this.postTurn(
      channelId,
      `📋 Task received: ${event.content.slice(0, 200)} — starting work (browser agent).`,
    );
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
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty LLM response");
    return content;
  }

  private async postTurn(channelId: string | undefined, content: string) {
    const tags: string[][] = [];
    if (channelId) tags.push(["h", channelId]);
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
