/**
 * The signed-in user's picture over their initials. The initials always
 * render underneath, so the circle is complete while the image loads or if
 * it 404s.
 */

import { useState } from "react";
import { cn } from "@/lib/utils";

export interface AvatarProps {
  readonly imageUrl: string | null;
  readonly initials: string;
  /** Names the person for a screen reader; the image itself is decorative. */
  readonly name: string;
  readonly className?: string;
}

export function Avatar({ imageUrl, initials, name, className }: AvatarProps) {
  const [broken, setBroken] = useState(false);

  return (
    <span
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar font-medium text-[10px] text-muted-foreground uppercase",
        className,
      )}
    >
      <span aria-hidden="true">{initials}</span>
      {imageUrl === null || broken ? null : (
        <img
          src={imageUrl}
          alt={name}
          onError={() => setBroken(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
