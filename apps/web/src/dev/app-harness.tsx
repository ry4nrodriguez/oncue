/**
 * The whole application, signed in, for local development. Only Clerk's
 * browser SDK is stood in for: the gate is told the user is signed in, while
 * the Worker verifies the `/dev/sign-in` cookie with its unmodified
 * `verifyClerkSession`, so nothing in the product is bypassed. A 401 from
 * `/api/me` redirects to `/dev/sign-in`. Dev only;
 * `scripts/check-no-dev-harness.mjs` fails the build if this enters it.
 */
import { ClerkProvider } from "@clerk/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { IdentityGate } from "../features/auth/AuthGate";
import { LoadingScreen } from "../features/auth/LoadingScreen";
import { CLERK_APPEARANCE } from "../lib/clerk-appearance";
import { ThemeProvider } from "../lib/theme";
import { createAppRouter } from "../routes/routes";
import "../styles/globals.css";

const router = createAppRouter();

function Harness() {
  const [cookieState, setCookieState] = useState<"checking" | "present" | "absent">("checking");
  useEffect(() => {
    void fetch("/api/me").then((response) => {
      setCookieState(response.status === 401 ? "absent" : "present");
    });
  }, []);

  // The product's loading screen while `/api/me` is pending.
  if (cookieState === "checking") {
    return <LoadingScreen />;
  }
  if (cookieState === "absent") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p className="text-[14px]">
          Not signed in locally.{" "}
          <a className="underline" href="/dev/sign-in">
            Sign in as the local subject
          </a>
          .
        </p>
      </main>
    );
  }
  return (
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      appearance={CLERK_APPEARANCE}
    >
      <IdentityGate isLoaded isSignedIn>
        {() => <RouterProvider router={router} />}
      </IdentityGate>
    </ClerkProvider>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found");
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <Harness />
    </ThemeProvider>
  </StrictMode>,
);
