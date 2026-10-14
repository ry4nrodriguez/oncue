/**
 * Settings: a fixed rail of sections on the left, the chosen one on the right.
 * It replaces the app shell so two rails never share the left edge. Each
 * section is a route, so it is linkable, survives a refresh, and gives the
 * GitHub install callback a specific landing place. Connection sections follow
 * the setup order in `worker/setup/derive.ts`.
 */

import { ArrowLeft, Box, Brain, Cpu, FolderGit2, Hand, User } from "lucide-react";
import type { ComponentType } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/utils";

interface Section {
  readonly to: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}

const SECTIONS: readonly Section[] = [
  { to: "/settings/profile", label: "Profile", icon: User },
  { to: "/settings/repositories", label: "Repositories", icon: FolderGit2 },
  { to: "/settings/model-providers", label: "Model providers", icon: Cpu },
  { to: "/settings/harnesses", label: "Harnesses", icon: Brain },
  { to: "/settings/agent-permissions", label: "Agent permissions", icon: Hand },
  { to: "/settings/modal", label: "Modal", icon: Box },
];

const ROW = "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors";

export function SettingsScreen() {
  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <nav
        aria-label="Settings sections"
        className="flex w-[232px] shrink-0 flex-col border-border border-r bg-panel px-2 py-3"
      >
        <div className="px-2 pb-3">
          <Wordmark cell={2} className="text-text" />
        </div>

        <Link to="/" className={cn(ROW, "text-muted-foreground hover:bg-hover hover:text-text")}>
          <ArrowLeft className="size-[15px] shrink-0" aria-hidden="true" />
          Back
        </Link>

        <div className="mt-3">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              className={({ isActive }) =>
                cn(
                  ROW,
                  isActive ? "bg-hover-strong text-text" : "text-muted-foreground hover:bg-hover",
                )
              }
            >
              <section.icon className="size-[15px] shrink-0" aria-hidden="true" />
              {section.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
