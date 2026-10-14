/**
 * The disclosure before launch (record 08): Required, Optional, and Missing
 * secrets, read by the control plane at one commit. Optional ones start
 * unticked. Only the commit and names go back, and the control plane
 * re-derives the launch, so this card is a question, never an authority.
 */

import { KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import type { RequestedSecret, SecretRequests } from "@/lib/api/secrets";

/** What the create request carries, or null to start with no secrets at all. */
export type DisclosureAnswer = {
  readonly baseSha: string;
  readonly optional: readonly string[];
  readonly startWithoutMissing: boolean;
} | null;

function NewMark({ entry }: { entry: RequestedSecret }) {
  return entry.isNew ? (
    <span className="rounded border border-border px-1 text-[11px] text-caution">New</span>
  ) : null;
}

function Group({
  testId,
  label,
  hint,
  children,
}: {
  testId: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-[12px] text-text">
        {label} <span className="text-muted-foreground">· {hint}</span>
      </p>
      <ul className="mt-1 space-y-1">{children}</ul>
    </div>
  );
}

const NAME = "font-mono text-[12px] text-text";

export function DisclosureCard({
  repositoryName,
  branch = null,
  requests,
  onConfirm,
  onCancel,
}: {
  repositoryName: string;
  /** The branch the file was read on, when the session starts from one other than the default. */
  branch?: string | null;
  requests: Extract<SecretRequests, { kind: "declared" | "invalid" }>;
  onConfirm: (answer: DisclosureAnswer) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const readOn =
    branch === null ? null : (
      <p data-testid="disclosure-branch" className="text-[12px] text-muted-foreground">
        Read from .oncue/project.yaml on <span className="font-mono">{branch}</span>.
      </p>
    );

  if (requests.kind === "invalid") {
    return (
      <section
        data-testid="disclosure-card"
        aria-labelledby={titleId}
        className="mb-3 rounded-xl border border-border bg-surface px-3 py-2.5"
      >
        <p id={titleId} className="font-medium text-[13px] text-text">
          {repositoryName}'s project file could not be used
        </p>
        {readOn}
        <p className="mt-1 text-[12px] text-muted-foreground">
          .oncue/project.yaml, line {requests.line}: {requests.reason}. No secret is supplied from a
          file OnCue cannot read exactly.
        </p>
        <div className="flex gap-1.5 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="h-7 rounded-md border-border px-2.5 text-[12px] text-text"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(null)}
            className="h-7 rounded-md px-2.5 text-[12px]"
          >
            Start without secrets
          </Button>
        </div>
      </section>
    );
  }

  const required = requests.required.filter((entry) => entry.saved);
  const optional = requests.optional.filter((entry) => entry.saved);
  const missingRequired = requests.required.filter((entry) => !entry.saved);
  const missing = [...missingRequired, ...requests.optional.filter((entry) => !entry.saved)];
  const answer = (startWithoutMissing: boolean): DisclosureAnswer => ({
    baseSha: requests.baseSha,
    optional: ticked,
    startWithoutMissing,
  });

  return (
    <section
      data-testid="disclosure-card"
      aria-labelledby={titleId}
      className="mb-3 rounded-xl border border-border bg-surface px-3 py-2.5"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-muted-foreground"
          aria-hidden="true"
        >
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p id={titleId} className="font-medium text-[13px] text-text">
              {repositoryName} asks for development secrets
            </p>
            {readOn}
            <p className="text-[12px] text-muted-foreground">
              A secret the session is given can be read by the repository's code, and the model
              provider may see it. Nothing is supplied until you start the session.
            </p>
          </div>

          {required.length > 0 ? (
            <Group testId="disclosure-required" label="Required" hint="will be supplied">
              {required.map((entry) => (
                <li key={entry.name} className="flex items-center gap-2">
                  <span className={NAME}>{entry.name}</span>
                  <NewMark entry={entry} />
                </li>
              ))}
            </Group>
          ) : null}

          {optional.length > 0 ? (
            <Group
              testId="disclosure-optional"
              label="Optional"
              hint="supplied only if you tick it"
            >
              {optional.map((entry) => {
                const id = `${titleId}-${entry.name}`;
                return (
                  <li key={entry.name} className="flex items-center gap-2">
                    <input
                      id={id}
                      type="checkbox"
                      checked={ticked.includes(entry.name)}
                      onChange={(event) =>
                        setTicked((current) =>
                          event.target.checked
                            ? [...current, entry.name]
                            : current.filter((name) => name !== entry.name),
                        )
                      }
                    />
                    <label htmlFor={id} className={NAME}>
                      {entry.name}
                    </label>
                    <NewMark entry={entry} />
                  </li>
                );
              })}
            </Group>
          ) : null}

          {missing.length > 0 ? (
            <Group testId="disclosure-missing" label="Missing" hint="asked for, nothing saved">
              {missing.map((entry) => (
                <li key={entry.name} className="flex items-center gap-2">
                  <span className={NAME}>{entry.name}</span>
                  <NewMark entry={entry} />
                </li>
              ))}
              <li className="text-[12px] text-muted-foreground">
                Save a value under{" "}
                <Link
                  to="/settings/repositories"
                  className="text-text underline underline-offset-2"
                >
                  Settings, Repositories
                </Link>
                .
              </li>
            </Group>
          ) : null}

          {missingRequired.length > 0 ? (
            <p className="text-[12px] text-caution">
              A required secret is missing. If you start anyway, parts of the project may not run
              and this session's runs cannot end verified.
            </p>
          ) : null}

          {/* Under the text, at the left, like every other card. */}
          <div className="flex gap-1.5 pt-0.5">
            <Button
              variant="outline"
              size="sm"
              aria-describedby={titleId}
              onClick={onCancel}
              className="h-7 rounded-md border-border px-2.5 text-[12px] text-text"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              aria-describedby={titleId}
              onClick={() => onConfirm(answer(missingRequired.length > 0))}
              className="h-7 rounded-md px-2.5 text-[12px]"
            >
              {missingRequired.length > 0 ? "Start anyway" : "Start session"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
