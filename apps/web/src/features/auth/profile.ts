/**
 * Who is signed in, for display only; never a permission. Read from Clerk in
 * the browser rather than `/api/me`, which carries only the ids authorization
 * is decided against. Clerk's `imageUrl` is already the GitHub or Google
 * picture, so only the no-picture fallbacks are needed.
 */

import { useUser } from "@clerk/react";

export interface Profile {
  /** Best available human name, never empty. */
  readonly name: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly imageUrl: string | null;
  /** `"github"`, `"google"`, or null when they signed up with an email. */
  readonly provider: string | null;
  /** One or two letters for when there is no picture. */
  readonly initials: string;
  readonly loaded: boolean;
}

// Two letters from a full name, one from a single word, never blank (an empty circle reads as broken).
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return (words[0]?.slice(0, 1) ?? "?").toUpperCase();
  }
  const first = words[0]?.slice(0, 1) ?? "";
  const last = words[words.length - 1]?.slice(0, 1) ?? "";
  return `${first}${last}`.toUpperCase();
}

// Full name, then username, then the email's local part, then a literal so the row is never blank while Clerk loads.
export function displayNameFrom(
  fullName: string | null | undefined,
  username: string | null | undefined,
  email: string | null | undefined,
): string {
  const full = fullName?.trim();
  if (full !== undefined && full.length > 0) {
    return full;
  }
  const handle = username?.trim();
  if (handle !== undefined && handle.length > 0) {
    return handle;
  }
  const local = email?.split("@")[0]?.trim();
  if (local !== undefined && local.length > 0) {
    return local;
  }
  return "You";
}

export function useProfile(): Profile {
  const { isLoaded, user } = useUser();

  const username = user?.username ?? null;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const name = displayNameFrom(user?.fullName, username, email);

  return {
    name,
    username,
    email,
    imageUrl: user?.imageUrl ?? null,
    // The first connected account; the MVP has one sign-in per user.
    provider: user?.externalAccounts?.[0]?.provider ?? null,
    initials: initialsOf(name),
    loaded: isLoaded,
  };
}
