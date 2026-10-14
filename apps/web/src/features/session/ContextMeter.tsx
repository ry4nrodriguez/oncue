/**
 * The session's context meter: a ring and a percent under the chat box's
 * bottom-right corner that fill as the conversation fills the model's window,
 * and a popover that splits the size into exact parts. Every number comes from
 * `contextMeterOf`; nothing here counts tokens.
 */

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  type CategoryId,
  type ContextMeterView,
  compactTokens,
  formatUsd,
  OPENAI_LONG_CONTEXT_ABOVE,
  percentUsed,
  shareOf,
} from "./context-meter";

/** At these shares the ring turns caution, then danger: the harness compacts near the top. */
export const CAUTION_AT = 80;
export const DANGER_AT = 95;

/** One colour per part, so the bar and the rows agree; free space is the track. */
const CATEGORY_COLOR: Readonly<Record<CategoryId, string>> = {
  system: "bg-meter-system",
  tools: "bg-meter-tools",
  oncueTools: "bg-meter-oncue",
  conversation: "bg-meter-conversation",
};

function toneOf(percent: number): string {
  if (percent >= DANGER_AT) {
    return "text-danger";
  }
  if (percent >= CAUTION_AT) {
    return "text-caution";
  }
  return "text-muted-foreground";
}

/** The trigger's accessible name, which says what the ring shows. */
export function contextLabel(meter: ContextMeterView): string {
  if (meter.used === null) {
    return meter.window === null
      ? "Context: no answer yet"
      : `Context: no answer yet, ${compactTokens(meter.window)} window`;
  }
  if (meter.window === null) {
    return `Context: ${compactTokens(meter.used)} tokens used`;
  }
  return `Context: ${percentUsed(meter.used, meter.window)}% of ${compactTokens(meter.window)} used`;
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({ percent }: { readonly percent: number }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        strokeWidth="2.25"
        className="stroke-current text-track-fill"
      />
      {percent > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          data-testid="context-meter-fill"
          className={cn(
            "stroke-current transition-[stroke-dasharray] duration-300",
            toneOf(percent),
          )}
        />
      ) : null}
    </svg>
  );
}

interface Segment {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly color: string;
}

/** What the bar and the rows draw: the exact parts, or the size alone when there is no breakdown. */
function segmentsOf(meter: ContextMeterView): readonly Segment[] {
  if (meter.used === null) {
    return [];
  }
  if (meter.breakdown.kind === "exact") {
    return meter.breakdown.categories.map((category) => ({
      key: category.id,
      label: category.label,
      tokens: category.tokens,
      color: CATEGORY_COLOR[category.id],
    }));
  }
  return [{ key: "used", label: "Used", tokens: meter.used, color: "bg-muted-foreground" }];
}

function Bar({
  segments,
  window,
}: {
  readonly segments: readonly Segment[];
  readonly window: number | null;
}) {
  const total = window ?? segments.reduce((sum, segment) => sum + segment.tokens, 0);
  return (
    <div
      className="mt-2.5 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-track-fill"
      aria-hidden="true"
      data-testid="context-meter-bar"
    >
      {total <= 0
        ? null
        : segments.map((segment) => (
            <div
              key={segment.key}
              data-segment={segment.key}
              className={cn("h-full shrink-0 transition-[width] duration-300", segment.color)}
              style={{ width: `${Math.min(100, (segment.tokens / total) * 100)}%` }}
            />
          ))}
    </div>
  );
}

function Row({
  testId,
  color,
  label,
  tokens,
  window,
}: {
  readonly testId: string;
  readonly color: string;
  readonly label: string;
  readonly tokens: number;
  readonly window: number | null;
}) {
  return (
    <li data-testid={testId} data-value={tokens} className="flex items-center gap-2 text-[13px]">
      <span className={cn("size-2.5 shrink-0 rounded-[3px]", color)} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-text">{label}</span>
      <span className="text-text tabular-nums">{compactTokens(tokens)}</span>
      {window === null ? null : (
        <span className="w-12 text-right text-muted-foreground tabular-nums">
          {shareOf(tokens, window)}
        </span>
      )}
    </li>
  );
}

/** One line under the bar when there is no exact breakdown, saying why plainly. */
function breakdownNote(meter: ContextMeterView): string | null {
  if (meter.used === null) {
    return "Fills once the agent answers in this conversation.";
  }
  switch (meter.breakdown.kind) {
    case "pending":
      return "Breakdown appears after the next answer.";
    case "unavailable":
      return "Breakdown unavailable for now.";
    case "unsupported":
      return "A breakdown isn't available for this provider.";
    case "none":
      return "No breakdown for this answer.";
    default:
      return null;
  }
}

function noteText(meter: ContextMeterView): string | null {
  switch (meter.note?.kind) {
    case "fresh_after_resume":
      return "A new sandbox started this conversation over from a summary of the session.";
    case "compacted":
      return `The agent compacted the conversation, from ${compactTokens(meter.note.from)} to ${compactTokens(meter.note.to)} tokens.`;
    default:
      return null;
  }
}

function compactionLine(meter: ContextMeterView): string | null {
  if (meter.compactsAt === null || meter.used === null) {
    return null;
  }
  const left = Math.max(0, meter.compactsAt - meter.used);
  return `${compactTokens(left)} until auto-compact`;
}

/**
 * The gauge before a chat starts: an empty ring and "0%". It is a reading, not
 * a control, since there is no conversation yet to break down.
 */
export function ContextMeterAtRest() {
  return (
    <span
      role="img"
      aria-label="Context: 0% used"
      title="The context is empty until the first answer"
      data-testid="context-meter-at-rest"
      className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] text-muted-foreground tabular-nums"
    >
      <Ring percent={0} />
      <span aria-hidden="true">0%</span>
    </span>
  );
}

export interface ContextMeterProps {
  readonly meter: ContextMeterView;
  readonly disabled?: boolean;
}

export function ContextMeter({ meter, disabled = false }: ContextMeterProps) {
  const [expanded, setExpanded] = useState(false);
  const percent =
    meter.used === null || meter.window === null ? 0 : percentUsed(meter.used, meter.window);
  const segments = segmentsOf(meter);
  const free =
    meter.used === null || meter.window === null ? null : Math.max(0, meter.window - meter.used);
  const statusLine = breakdownNote(meter);
  const compaction = compactionLine(meter);
  const note = noteText(meter);
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={contextLabel(meter)}
        data-testid="context-meter"
        data-percent={percent}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground tabular-nums transition-colors hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 data-[popup-open]:bg-hover data-[popup-open]:text-text"
      >
        <Ring percent={percent} />
        <span aria-hidden="true">{meter.used === null ? "Context" : `${percent}%`}</span>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        aria-label="Context window"
        data-testid="context-meter-popover"
        className="w-[min(320px,calc(100vw-32px))] p-3"
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="context-meter-rows"
          data-testid="context-meter-toggle"
          onClick={() => setExpanded((open) => !open)}
          className="group -mx-1 -my-0.5 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-border"
        >
          <span className="text-[14px] text-text">Context window</span>
          {/* Muted grey on the hover fill is too faint, so it darkens with the fill. */}
          <span className="ml-auto text-[13px] text-muted-foreground tabular-nums group-hover:text-text group-focus-visible:text-text">
            {meter.used === null ? (
              meter.window === null ? null : (
                <>{compactTokens(meter.window)} window</>
              )
            ) : (
              <>
                <span
                  data-testid="context-meter-used"
                  data-value={meter.used}
                  className="text-text"
                >
                  {compactTokens(meter.used)}
                </span>
                {meter.window === null
                  ? " tokens"
                  : ` / ${compactTokens(meter.window)} (${percent}%)`}
              </>
            )}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-faint transition-transform",
              expanded ? "rotate-180" : "",
            )}
            aria-hidden="true"
          />
        </button>

        <Bar segments={segments} window={meter.window} />

        {/* Mounted while collapsed, so the header's aria-controls always names it. */}
        <ul
          id="context-meter-rows"
          data-testid="context-meter-rows"
          hidden={!expanded}
          className="mt-3 space-y-1.5"
        >
          {segments.map((segment) => (
            <Row
              key={segment.key}
              testId={`context-meter-row-${segment.key}`}
              color={segment.color}
              label={segment.label}
              tokens={segment.tokens}
              window={meter.window}
            />
          ))}
          {free === null ? null : (
            <Row
              testId="context-meter-row-free"
              color="bg-track-fill"
              label="Free space"
              tokens={free}
              window={meter.window}
            />
          )}
        </ul>

        {statusLine === null ? null : (
          <p data-testid="context-meter-status" className="mt-2 text-[12px] text-muted-foreground">
            {statusLine}
          </p>
        )}
        {compaction === null ? null : (
          <p
            data-testid="context-meter-compaction"
            className="mt-2 text-[12px] text-muted-foreground tabular-nums"
          >
            {compaction}
          </p>
        )}
        {note === null ? null : (
          <p data-testid="context-meter-note" className="mt-2 text-[12px] text-muted-foreground">
            {note}
          </p>
        )}

        {meter.costUsd === null ? null : (
          <div className="mt-3 border-border-soft border-t pt-2.5">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <p className="text-muted-foreground">Estimated cost</p>
              <p
                data-testid="context-meter-cost"
                data-value={meter.costUsd}
                className="text-text tabular-nums"
              >
                ≈ {formatUsd(meter.costUsd)}
              </p>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              An estimate for this session at list prices
              {meter.costPartial ? ", leaving out models without a listed price" : ""}.
              {meter.costLongContext
                ? ` Calls past ${compactTokens(OPENAI_LONG_CONTEXT_ABOVE)} input tokens cost more than this counts.`
                : ""}
              {meter.costLow ? " Earlier answers were recorded without cache counts." : ""} Your
              provider's bill is the record.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
