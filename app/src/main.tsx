import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";
import { registerPasskeySigner } from "@creaton/core/account/passkey-identity.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import { loadServerSettings } from "@creaton/core/client/server-settings.ts";
import { timedFetchStreamed } from "@creaton/core/client/timed-fetch.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./app/router";
import { ToastProvider } from "./ui/toast";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      networkMode: "always",
      gcTime: 5 * 60_000,
    },
    mutations: { networkMode: "always" },
  },
});

/** How long the page waits for the server's settings before it opens without them: they must not hold the page. */
const SETTINGS_WAIT_MS = 3_000;
/** How long the page waits for the passkey signer to load before it draws anyway: a stalled download must not leave a blank page. */
const SIGNER_WAIT_MS = 3_000;

async function start() {
  // A passkey account signs through its in-memory key once unlocked; before that, signing is refused, never faked. It is
  // waited for: until it is registered the app does not know who the person is, and a reload would draw them signed out
  // (no unlock prompt) whenever the page was quicker than the signer's own load. A failed or stalled load must not hold the
  // page: it draws after a few seconds, and the surfaces that drew before the signer was ready are told when it is.
  await Promise.race([
    registerPasskeySigner().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, SIGNER_WAIT_MS)),
  ]);
  // What the server says about itself (whether investing is on) is known before anything draws, so nothing flips.
  await loadServerSettings(async () => {
    const response = await timedFetchStreamed(`${relayHttpBaseUrl()}/info`, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(SETTINGS_WAIT_MS),
    });
    return response.ok ? response.json() : null;
  });
  const root = document.getElementById("root");
  if (!root) return;
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  // Installable and opens offline: the shell only (`public/sw.js`). Not in development, where it would serve stale code.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // A server that does not serve /sw.js (the relay today, see the report's open items): the app works without it.
    });
  }
}

void start();
