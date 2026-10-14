/**
 * The model choice inside the composer's agent chip: a model on one of the
 * workspace's connections. The Worker builds the run's `ModelRecord` from the
 * connection id, so the browser chooses a connection and a catalog model,
 * never a provider key.
 */
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { CLAUDE_CLAY_CLASS, ClaudeMark, OpenAIMark } from "@/components/brand/icons";
import { PROVIDER_LABEL } from "@/features/model-connections/connection-status";
import { INACTIVE_KEY_WORDS } from "@/features/model-connections/inactive-keys";
import { displayModelName, shortModelName } from "@/features/model-connections/model-name";
import type {
  InactiveKeyStatus,
  InactiveModelConnection,
  ModelCatalog,
  ModelProvider,
  ModelSpecSummary,
} from "@/lib/api/setup";
import { cn } from "@/lib/utils";
import {
  CONNECT_PILL,
  MENU_ROW_PROPS,
  MenuLink,
  MenuRow,
  MenuSection,
  PANEL_CHOICE_ROW,
  StaticRow,
} from "./composer-menu";
import { MODEL_CONNECTIONS_PATH } from "./composer-state";

export interface ModelChoice {
  readonly id: string;
  /** The connection's own name: provider and account hint, as the Worker labels it. */
  readonly label: string;
  /** When known, the control names the model under its provider's mark; otherwise it shows the label. */
  readonly provider?: ModelProvider | undefined;
  readonly modelId?: string | undefined;
  /** The provider's catalog; without it the connection's one `modelId` is the only row. */
  readonly models?: readonly ModelSpecSummary[] | undefined;
}

/** One row of the control: a model on a connection. */
export interface ModelRow {
  readonly key: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly name: string;
  readonly provider: ModelProvider | undefined;
  /** The connection's label, which tells two keys of one provider apart. */
  readonly label: string;
  readonly spec: ModelSpecSummary | null;
}

export function rowKey(connectionId: string, modelId: string): string {
  return `${connectionId}::${modelId}`;
}

/** The rows the control draws, in the order the connections and their catalogs came. */
export function modelRowsOf(choices: readonly ModelChoice[]): readonly ModelRow[] {
  return choices.flatMap((choice): readonly ModelRow[] => {
    if (choice.models !== undefined && choice.models.length > 0) {
      return choice.models.map((spec) => ({
        key: rowKey(choice.id, spec.modelId),
        connectionId: choice.id,
        modelId: spec.modelId,
        name: shortModelName(spec.name),
        provider: choice.provider,
        label: choice.label,
        spec,
      }));
    }
    const modelId = choice.modelId ?? "";
    return [
      {
        key: rowKey(choice.id, modelId),
        connectionId: choice.id,
        modelId,
        name: choice.modelId === undefined ? choice.label : displayModelName(choice.modelId),
        provider: choice.provider,
        label: choice.label,
        spec: null,
      },
    ];
  });
}

/** The order providers are listed in, as Settings, Model providers lists them. */
const PROVIDER_ORDER: readonly ModelProvider[] = ["anthropic", "openai"];

/** A provider whose key stopped working, as the picker needs it. */
export type InactiveKey = Pick<InactiveModelConnection, "provider" | "status">;

/**
 * A model whose provider has no working key: listed, never chosen, with the
 * way to get one. `keyStatus` says the provider holds a key that stopped
 * working, which is replaced; `null` is a provider with no key, which is
 * connected.
 */
export interface UnconnectedRow {
  readonly key: string;
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly name: string;
  readonly keyStatus: InactiveKeyStatus | null;
}

/** Models of providers the workspace has no working key for, listed with a way to get one. */
export function unconnectedRowsOf(
  choices: readonly ModelChoice[],
  catalog: ModelCatalog | undefined,
  inactiveKeys: readonly InactiveKey[] = [],
): readonly UnconnectedRow[] {
  if (catalog === undefined) {
    return [];
  }
  const connected = new Set(choices.map((choice) => choice.provider));
  return PROVIDER_ORDER.filter((provider) => !connected.has(provider)).flatMap((provider) => {
    const keyStatus = inactiveKeys.find((key) => key.provider === provider)?.status ?? null;
    return catalog[provider].map((spec) => ({
      key: `connect::${provider}::${spec.modelId}`,
      provider,
      modelId: spec.modelId,
      name: shortModelName(spec.name),
      keyStatus,
    }));
  });
}

/** The selected row, or the connection's recommended row when no model is named. */
export function selectedRowOf(
  rows: readonly ModelRow[],
  connectionId: string | null,
  modelId: string | null,
): ModelRow | undefined {
  if (connectionId === null) {
    return undefined;
  }
  const own = rows.filter((row) => row.connectionId === connectionId);
  if (modelId !== null) {
    const named = own.find((row) => row.modelId === modelId);
    if (named !== undefined) {
      return named;
    }
  }
  return own.find((row) => row.spec?.recommended === true) ?? own[0];
}

const PROVIDER_MARK: Record<ModelProvider, (props: { className?: string }) => ReactNode> = {
  // Anthropic's mark for the model, not the company: see `ClaudeMark`.
  anthropic: ClaudeMark,
  openai: OpenAIMark,
};

/** A provider's mark, as a model's row and the agent chip both draw it. */
export function RowMark({
  provider,
  className,
}: {
  provider: ModelProvider | undefined;
  className: string;
}) {
  if (provider === undefined) {
    return null;
  }
  const Mark = PROVIDER_MARK[provider];
  // The Spark ships in one colour, Clay, and inherits it from here.
  return <Mark className={cn(className, provider === "anthropic" && CLAUDE_CLAY_CLASS)} />;
}

/** "Legacy" where the provider retired the model; nothing otherwise. */
function rowTrailing(row: ModelRow): string | undefined {
  return row.spec?.status === "legacy" ? "Legacy" : undefined;
}

/**
 * Each model once. When two connections of one provider list the same model,
 * the chosen connection's row wins, else the oldest connection's (the rule
 * `HomeRoute` opens on).
 */
export function menuRowsOf(
  rows: readonly ModelRow[],
  selectedConnectionId: string | null,
): readonly ModelRow[] {
  const keep = new Map<string, ModelRow>();
  for (const row of rows) {
    if (row.provider === undefined) {
      continue;
    }
    const model = `${row.provider}::${row.modelId}`;
    // Later in the list is older, so the last one seen wins, unless the chosen one was seen.
    if (keep.get(model)?.connectionId !== selectedConnectionId) {
      keep.set(model, row);
    }
  }
  return rows.filter(
    (row) => row.provider === undefined || keep.get(`${row.provider}::${row.modelId}`) === row,
  );
}

/** What the agent chip says about the model: its row, the words shown, and the words read out. */
export interface ModelSummary {
  readonly selected: ModelRow | undefined;
  /** The chip's text. */
  readonly label: string;
  /** The model as the chip's accessible name says it. */
  readonly named: string;
}

export function modelSummaryOf(
  choices: readonly ModelChoice[],
  selectedId: string | null,
  selectedModelId: string | null,
): ModelSummary {
  const selected = selectedRowOf(modelRowsOf(choices), selectedId, selectedModelId);
  if (selected !== undefined) {
    return { selected, label: selected.name, named: selected.name };
  }
  // An id missing from the active connections was deleted or its key stopped
  // working; "Unavailable" is true of both, whether or not another key exists.
  if (selectedId !== null) {
    return { selected, label: "Model unavailable", named: "unavailable" };
  }
  return {
    selected,
    label: choices.length === 0 ? "No model connected" : "Add a model",
    named: "none",
  };
}

export interface ModelPickerProps {
  /** The workspace's own model connections, empty until one is added. */
  readonly choices: readonly ModelChoice[];
  /** The connection this send charges. */
  readonly selectedId: string | null;
  /** The model on it; `null` names the connection's recommended row. */
  readonly selectedModelId?: string | null | undefined;
  /** Absent where the choice is fixed, as on a session, whose runs keep their model. */
  readonly onSelect?: ((id: string) => void) | undefined;
  readonly onSelectModel?: ((connectionId: string, modelId: string) => void) | undefined;
  /** Called after a model is picked, so the panel that holds this list can close. */
  readonly onPicked?: (() => void) | undefined;
  /** Every provider's models, so a model with no key is listed with a Connect link. */
  readonly catalog?: ModelCatalog | undefined;
  /** Providers whose key stopped working: their models say so and link to where it is replaced. */
  readonly inactiveKeys?: readonly InactiveKey[] | undefined;
}

const MARK = "h-3.5 w-auto shrink-0";

export function ModelPicker({
  choices,
  selectedId,
  selectedModelId = null,
  onSelect,
  onSelectModel,
  onPicked,
  catalog,
  inactiveKeys,
}: ModelPickerProps) {
  const { selected, label } = modelSummaryOf(choices, selectedId, selectedModelId);
  const fixed = onSelect === undefined && onSelectModel === undefined;
  const rows = fixed ? [] : menuRowsOf(modelRowsOf(choices), selected?.connectionId ?? selectedId);
  const unconnected = fixed ? [] : unconnectedRowsOf(choices, catalog, inactiveKeys);
  // Nothing to choose from: a session's own model, or a workspace with no key
  // and no catalog to list what one would unlock.
  if (rows.length === 0 && unconnected.length === 0) {
    return (
      <MenuSection title="Model" testId="model-picker">
        <StaticRow
          label={label}
          leading={<RowMark provider={selected?.provider} className={MARK} />}
          fixed={fixed}
        />
      </MenuSection>
    );
  }
  return (
    <MenuSection title="Model" testId="model-picker" scrolls>
      {rows.map((row) => {
        const chosen = row.key === selected?.key;
        return (
          <button
            key={row.key}
            type="button"
            aria-pressed={chosen}
            data-testid="model-row"
            data-model={row.modelId}
            onClick={() => {
              onSelect?.(row.connectionId);
              onSelectModel?.(row.connectionId, row.modelId);
              onPicked?.();
            }}
            className={PANEL_CHOICE_ROW}
            {...MENU_ROW_PROPS}
          >
            <MenuRow
              label={row.name}
              trailing={rowTrailing(row)}
              leading={<RowMark provider={row.provider} className={MARK} />}
            />
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {chosen ? <Check className="size-3.5" aria-hidden="true" /> : null}
            </span>
          </button>
        );
      })}
      {/* Links, not choices: none can be chosen until a key is connected. */}
      {unconnected.map((row) =>
        row.keyStatus === null ? (
          <MenuLink
            key={row.key}
            href={MODEL_CONNECTIONS_PATH}
            className={PANEL_CHOICE_ROW}
            aria-label={`${row.name}: connect ${PROVIDER_LABEL[row.provider]}`}
            data-testid={`model-connect-${row.modelId}`}
            {...MENU_ROW_PROPS}
          >
            <MenuRow
              label={row.name}
              leading={<RowMark provider={row.provider} className={MARK} />}
            />
            <span className={CONNECT_PILL}>Connect</span>
          </MenuLink>
        ) : (
          // Greyed, with the reason in words on the row and the way to fix it beside it.
          <MenuLink
            key={row.key}
            href={MODEL_CONNECTIONS_PATH}
            className={PANEL_CHOICE_ROW}
            aria-label={`${row.name}: ${INACTIVE_KEY_WORDS[row.keyStatus].toLowerCase()}, replace the ${PROVIDER_LABEL[row.provider]} key`}
            data-testid={`model-replace-${row.modelId}`}
            {...MENU_ROW_PROPS}
          >
            <MenuRow
              label={row.name}
              muted
              trailing={INACTIVE_KEY_WORDS[row.keyStatus]}
              leading={<RowMark provider={row.provider} className={cn(MARK, "opacity-40")} />}
            />
            <span className={CONNECT_PILL}>Replace</span>
          </MenuLink>
        ),
      )}
    </MenuSection>
  );
}
