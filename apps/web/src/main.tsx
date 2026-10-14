import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./features/auth/AuthGate";
import { CLERK_APPEARANCE } from "./lib/clerk-appearance";
import { ThemeProvider } from "./lib/theme";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found");
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (typeof publishableKey !== "string" || publishableKey.length === 0) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set");
}

createRoot(container).render(
  <StrictMode>
    {/* Above the gate, so sign-in and the blocked screen follow the theme too. */}
    <ThemeProvider>
      <ClerkProvider publishableKey={publishableKey} appearance={CLERK_APPEARANCE}>
        <AuthGate>{() => <App />}</AuthGate>
      </ClerkProvider>
    </ThemeProvider>
  </StrictMode>,
);
