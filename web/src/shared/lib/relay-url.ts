/** Convert a WebSocket relay URL to its HTTP equivalent. */
export function relayHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice(6)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice(5)}`;
  }
  return wsUrl;
}

/**
 * localStorage key for an explicit relay URL override.
 *
 * The web app defaults to same-origin (works when the relay itself serves the
 * bundle), but any other host — `vite preview`, a CDN, a static host — would
 * otherwise dial the wrong WebSocket endpoint and silently fall back to the
 * empty-community screen. A stored override lets users point the app at the
 * right relay without rebuilding.
 */
export const RELAY_URL_STORAGE_KEY = "buzz.relayUrl";

/** Normalize a user-supplied relay URL to a WebSocket URL (http→ws, https→wss). */
export function normalizeRelayWsUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice(7)}`;
  }
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice(8)}`;
  }
  // Bare host:ports are common enough to accept (e.g. "relay.example.com:3000").
  return `ws://${trimmed}`;
}

export function getStoredRelayWsUrl(): string | null {
  try {
    return window.localStorage.getItem(RELAY_URL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredRelayWsUrl(wsUrl: string): void {
  window.localStorage.setItem(RELAY_URL_STORAGE_KEY, wsUrl);
}

export function clearStoredRelayWsUrl(): void {
  window.localStorage.removeItem(RELAY_URL_STORAGE_KEY);
}

/**
 * Read the relay WebSocket URL, in priority order:
 * 1. `localStorage` override set from the web UI (survives reloads).
 * 2. `VITE_RELAY_URL` baked in at build time.
 * 3. Same-origin derivation (works when the relay serves the bundle itself).
 */
export function relayWsUrl(): string {
  const storedUrl = getStoredRelayWsUrl();
  if (storedUrl) return storedUrl;
  const envUrl = import.meta.env.VITE_RELAY_URL;
  if (envUrl) return envUrl;
  // Same-origin: derive from current page location (works when served from relay)
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

/** HTTP base URL for the relay (derived from the WS URL). */
export function relayHttpBaseUrl(): string {
  return relayHttpUrl(relayWsUrl());
}
