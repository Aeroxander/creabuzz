import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "@/app/App";
import "@fontsource-variable/figtree/wght.css";
import "@/shared/styles/globals.css";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { TypographyProvider } from "@/shared/theme/TypographyProvider";
import {
  installErrorReporting,
  reportEndpoint,
} from "@/shared/lib/error-report";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { loadServerSettings } from "@/shared/lib/server-settings";
import { timedFetchStreamed } from "@/shared/lib/timed-fetch";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";

// Off unless the build names a collector; see docs/error-reporting.md for exactly what is sent.
installErrorReporting({
  endpoint: reportEndpoint(
    import.meta.env.VITE_ERROR_REPORT_URL as string | undefined,
  ),
  target: window,
  fetchImpl: (url, init) => fetch(url, init as RequestInit),
  page: () => window.location.pathname,
  release: import.meta.env.VITE_APP_RELEASE as string | undefined,
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      networkMode: "always",
      gcTime: 5 * 60 * 1_000,
    },
    mutations: {
      networkMode: "always",
    },
  },
});

/** How long the page waits for the server's settings before it opens with the build's own: they must not hold the page. */
const SETTINGS_WAIT_MS = 3_000;

async function start() {
  // What the server says about itself (the investing switch) is known before anything draws, so no screen flips after it
  // was shown. A server that does not answer leaves the build's own switches in charge.
  await loadServerSettings(async () => {
    const response = await timedFetchStreamed(`${relayHttpBaseUrl()}/info`, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(SETTINGS_WAIT_MS),
    });
    return response.ok ? response.json() : null;
  });
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TypographyProvider>
            <TooltipProvider delayDuration={300}>
              <App />
              <Toaster />
            </TooltipProvider>
          </TypographyProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void start();
