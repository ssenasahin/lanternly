import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readTheme } from "./app/theme";
import "./styles/index.css";

// Apply the saved theme before the first paint, so a light-theme user never sees a dark flash.
applyTheme(readTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Monitoring data changes constantly; refetch when the tab regains focus.
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
