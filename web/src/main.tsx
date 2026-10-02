import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "@/app/App";
import "@fontsource-variable/figtree/wght.css";
import "@/shared/styles/globals.css";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { TypographyProvider } from "@/shared/theme/TypographyProvider";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";

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
