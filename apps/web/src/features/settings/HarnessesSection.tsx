/**
 * Settings, Harnesses: one row per harness the sandbox image installs (the
 * coding agent inside the sandbox) with its status from `harness-state.ts`. Connected keys start from
 * the identity so the page draws at once, then are read fresh so a key just
 * connected counts; a failed read keeps the identity's answer.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { GROUP, NEUTRAL_BUTTON } from "@/components/ui/button-classes";
import { HarnessMark } from "@/features/harnesses/HarnessMark";
import {
  connectLine,
  type HarnessOption,
  harnessOptions,
  keysLine,
} from "@/features/harnesses/harness-state";
import { MODEL_CONNECTIONS_PATH } from "@/features/session/composer-state";
import { listModelConnections } from "@/lib/api/model-connections";
import type { ModelProvider, RuntimeSummary } from "@/lib/api/setup";
import { cn } from "@/lib/utils";

const CONNECT = cn(NEUTRAL_BUTTON, "shrink-0 px-3 py-1.5 text-[12px]");

function Status({ harness }: { harness: HarnessOption }) {
  if (harness.state === "ready") {
    return <span className="shrink-0 text-[12px] text-positive">Ready</span>;
  }
  if (harness.state === "unavailable") {
    return <span className="shrink-0 text-[12px] text-faint">Not available yet</span>;
  }
  return (
    <>
      <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
        {connectLine(harness.providers)}
      </span>
      <Link
        to={MODEL_CONNECTIONS_PATH}
        aria-label={`${connectLine(harness.providers)} for ${harness.name}`}
        className={CONNECT}
      >
        Connect
      </Link>
    </>
  );
}

export interface HarnessesSectionProps {
  /** The harnesses this deployment enables, from the Worker; absent from an older body. */
  readonly enabled: readonly RuntimeSummary[] | undefined;
  /** The providers the identity's setup says have a key, until the fresh read answers. */
  readonly connected: ReadonlySet<ModelProvider>;
}

export function HarnessesSection({ enabled, connected: fromIdentity }: HarnessesSectionProps) {
  const [fresh, setFresh] = useState<ReadonlySet<ModelProvider> | null>(null);

  useEffect(() => {
    let cancelled = false;
    listModelConnections().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.kind === "listed") {
        setFresh(
          new Set(
            result.connections.filter((row) => row.status === "active").map((row) => row.provider),
          ),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const harnesses = harnessOptions(enabled, fresh ?? fromIdentity);

  return (
    <div className="h-full overflow-y-auto px-8 pt-12 pb-10">
      <div className="mx-auto max-w-[760px]">
        <h1 className="font-semibold text-[20px] text-text tracking-tight">Harnesses</h1>
        <p className="mt-1 text-[14px] text-muted-foreground leading-6">
          The coding agent that runs inside your sandbox. Each one drives models through your own
          provider keys; you choose one for a session beside the model.
        </p>

        <ul aria-label="Harnesses" className={cn(GROUP, "mt-6 divide-y divide-border")}>
          {harnesses.map((harness) => (
            <li
              key={harness.id}
              data-testid={`harness-${harness.id}`}
              className="flex items-center gap-3 px-4 py-3"
            >
              {/* Greyed by its mark and name, never by fading text below contrast. */}
              <HarnessMark
                id={harness.id}
                box="size-4"
                className={cn(
                  "h-4 w-auto shrink-0 text-text",
                  harness.state === "unavailable" && "opacity-40",
                )}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-[13px]",
                    harness.state === "unavailable" ? "text-muted-foreground" : "text-text",
                  )}
                >
                  {harness.name}
                </p>
                <p className="text-[12px] text-faint">{keysLine(harness.providers)}</p>
              </div>
              <Status harness={harness} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
