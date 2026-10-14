/**
 * The sidebar's account row: who is signed in, the way into settings, and log
 * out. Log out is Clerk's `SignOutButton`, which clears Clerk's state and
 * cookie.
 */

import { SignOutButton } from "@clerk/react";
import { LogOut, Settings } from "lucide-react";
import { Link } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebarMenu } from "@/features/home/sidebar-menu";
import { Avatar } from "./Avatar";
import { useProfile } from "./profile";

/** Providers are lowercase slugs from Clerk; this is only for display. */
function providerLabel(provider: string | null): string | null {
  if (provider === null) {
    return null;
  }
  if (provider === "github") {
    return "GitHub";
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function UserMenu() {
  const profile = useProfile();
  const provider = providerLabel(profile.provider);
  const menu = useSidebarMenu();

  return (
    <DropdownMenu {...menu.rootProps}>
      <DropdownMenuTrigger
        {...menu.triggerProps}
        aria-label={`Account: ${profile.name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-hover"
      >
        <Avatar imageUrl={profile.imageUrl} initials={profile.initials} name={profile.name} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {profile.name}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        {...menu.contentProps}
        align="start"
        side="top"
        sideOffset={8}
        className="w-[240px] border-border bg-popover p-1.5 shadow-xl"
      >
        {/* A header, not an item: it must not be focusable or look choosable. */}
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <Avatar imageUrl={profile.imageUrl} initials={profile.initials} name={profile.name} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-text">{profile.name}</span>
            <span className="block truncate text-[12px] text-faint">
              {provider === null ? (profile.email ?? "Signed in") : `via ${provider}`}
            </span>
          </span>
        </div>

        <div className="my-1 border-border-soft border-t" />

        <DropdownMenuItem
          className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] data-[highlighted]:bg-hover"
          render={
            <Link to="/settings">
              <Settings className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
              Settings
            </Link>
          }
        />

        <SignOutButton>
          <DropdownMenuItem className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] data-[highlighted]:bg-hover">
            <LogOut className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
            Log out
          </DropdownMenuItem>
        </SignOutButton>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
