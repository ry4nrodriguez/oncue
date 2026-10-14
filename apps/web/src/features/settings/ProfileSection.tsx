/**
 * Settings, Profile: who is signed in, read-only. Profile changes go through
 * Clerk's verification flows (an unverified email change could take over an
 * account). There is no delete-account control; record 05 owns that policy.
 */

import { Avatar } from "@/features/auth/Avatar";
import { useProfile } from "@/features/auth/profile";

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-4 border-border-soft border-b py-3.5 last:border-b-0">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-[13px] text-text">
        {value === null || value.length === 0 ? (
          // Named rather than blank, which would read as a failure to load.
          <span className="text-faint">Not set</span>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

/** Providers arrive as lowercase slugs; this is display only. */
function providerLabel(provider: string | null): string | null {
  if (provider === null) {
    return null;
  }
  return provider === "github" ? "GitHub" : provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function ProfileSection() {
  const profile = useProfile();

  return (
    <div className="px-8 pt-10 pb-10">
      <div className="mx-auto max-w-[560px]">
        <h2 className="font-semibold text-[20px] text-text tracking-tight">Profile</h2>

        <div className="mt-6 flex items-center gap-3">
          <Avatar
            imageUrl={profile.imageUrl}
            initials={profile.initials}
            name={profile.name}
            className="size-14 text-[16px]"
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-[15px] text-text">{profile.name}</p>
            <p className="truncate text-[13px] text-muted-foreground">
              {profile.email ?? "No email on file"}
            </p>
          </div>
        </div>

        <div className="mt-8">
          <Row label="Name" value={profile.name} />
          <Row label="Username" value={profile.username} />
          <Row label="Email" value={profile.email} />
          <Row label="Signed in with" value={providerLabel(profile.provider) ?? "Email"} />
        </div>

        <p className="mt-6 text-[12.5px] text-faint leading-5">
          These come from the account you signed in with. Change them where that account lives and
          they update here.
        </p>
      </div>
    </div>
  );
}
