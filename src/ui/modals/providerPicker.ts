/**
 * The provider picker — the interactive surface of the provider manager.
 *
 * **This whole surface is a project extension.** The target has no
 * user-managed registry of provider connections (audit §2.1, "Important negative
 * finding"): there is nothing to pick. The picker is therefore this implementation's own,
 * and it **says so** in its own heading — the label is part of the surface, not
 * a note about it.
 *
 * ## The rules the picker keeps
 *
 *   - **A credential is a reference.** The picker shows the reference and the
 *     **status** — resolved, unresolved, unreadable, refused — and never a
 *     value. There is no code path here that could show one: the entry carries
 *     a reference and a status, and nothing else.
 *   - **An unusable connection is visible, not hidden.** A connection whose
 *     credential cannot be resolved is listed with its status **and** with the
 *     fact that it cannot be used, so the user can see which entry is broken
 *     and pick another.
 *
 * ## What this module imports, and why
 *
 * The picker is a **model**, not a renderer: it turns a list of entries into
 * the lines a terminal shows and manages the selection. It imports two things
 * from the manager's shared module (`src/cli/commands/shared.ts`):
 *
 *   - the **extension label**, so the picker and the commands cannot drift
 *     apart in their wording — the picker used to keep its own copy of the
 *     sentence, and two copies of a label is one copy too many;
 *   - the **table renderer**, so the columns are padded the same way in both
 *     surfaces.
 *
 * Both are pure functions with no state, so the picker stays testable
 * without a terminal and without the commands themselves.
 *
 * ## How the entries get here
 *
 * The manager command owns the connections; the picker only shows them. The
 * bridge is {@link providerPickerEntries}, which takes the command's own
 * connection views — structurally, so the picker does not have to import the
 * command module — and turns them into the entries it renders.
 */

import {
  PROVIDER_EXTENSION_LABEL,
  PROVIDER_EXTENSION_NOTICE,
  renderTable,
} from '../../cli/commands/shared.js';

/**
 * The label the picker carries.
 *
 * **Project requirement** (plan §Global Constraints): the extension "must be
 * labelled as an extension everywhere it surfaces (UI, `--help`, docs,
 * compatibility matrix)". The wording is the command surfaces' wording: it is
 * imported, not copied.
 */
export const PROVIDER_PICKER_NOTICE = PROVIDER_EXTENSION_NOTICE;

/** The shorter form of the label, used in the heading. */
export const PROVIDER_PICKER_LABEL = PROVIDER_EXTENSION_LABEL;

/**
 * The marker of the selected entry.
 *
 * The same marker the approval prompt uses (`src/ui/render/prompts.ts`), so the
 * two interactive surfaces read alike.
 */
export const PROVIDER_PICKER_MARKER = '❯';

/**
 * One connection, as the picker shows it.
 *
 * The shape is structural: the manager command's own connection view satisfies
 * it, so the picker and the command can never drift apart.
 */
export interface ProviderPickerEntry {
  /** The connection's id. */
  id: string;
  /** The connection's display name. */
  name: string;
  /** The route the connection talks to. */
  route: string;
  /** The effective base URL. */
  baseUrl: string;
  /** Whether the connection is the active one. */
  active: boolean;
  /** Whether the connection can be used as it stands. */
  usable: boolean;
  /** The credential's status — never the credential. */
  credentialStatus: string;
  /** The credential's reference — never the credential. */
  credentialReference: string;
}

/**
 * A connection, as the manager command describes it.
 *
 * The shape is **structural** on purpose: the picker does not import the
 * command module, so the two surfaces stay independent, and the manager
 * command's own view satisfies this shape without an adapter.
 */
export interface ProviderPickerSource {
  /** The connection's id. */
  id: string;
  /** The connection's display name. */
  name: string;
  /** The route the connection talks to. */
  route: string;
  /** The effective base URL. */
  baseUrl: string;
  /** Whether the connection is the active one. */
  active: boolean;
  /** The credential's status, its reference and whether it can be used. */
  credential: {
    /** The credential's status — never the credential. */
    status: string;
    /** Whether the connection can be used as it stands. */
    usable: boolean;
    /** The credential's reference — never the credential. */
    reference: string;
  };
}

/**
 * The picker's entries, from the manager command's connection views.
 *
 * The bridge is one-directional and total: every connection becomes an entry,
 * so an unusable connection is **visible** rather than hidden.
 */
export function providerPickerEntries(
  sources: readonly ProviderPickerSource[],
): ProviderPickerEntry[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    route: source.route,
    baseUrl: source.baseUrl,
    active: source.active,
    usable: source.credential.usable,
    credentialStatus: source.credential.status,
    credentialReference: source.credential.reference,
  }));
}

/** The picker's state. */
export interface ProviderPickerModel {
  /** The heading. */
  title: string;
  /** The label the extension carries. */
  notice: string;
  /** The entries, in the order they are listed. */
  entries: readonly ProviderPickerEntry[];
  /** The index of the selected entry. */
  selectedIndex: number;
}

/**
 * The picker's model over a list of entries.
 *
 * The selection starts at the **active** connection when there is one, because
 * that is the entry the user is most likely to want, and at the first entry
 * otherwise.
 */
export function providerPickerModel(
  entries: readonly ProviderPickerEntry[],
  selectedIndex?: number,
): ProviderPickerModel {
  const activeIndex = entries.findIndex((entry) => entry.active);
  const chosen =
    selectedIndex !== undefined
      ? clamp(selectedIndex, 0, Math.max(0, entries.length - 1))
      : activeIndex >= 0
        ? activeIndex
        : 0;

  return {
    title: 'Select a provider connection',
    notice: PROVIDER_PICKER_NOTICE,
    entries: [...entries],
    selectedIndex: chosen,
  };
}

/**
 * The lines the picker shows.
 *
 * The heading carries the label, and the selected entry is marked with the
 * picker's marker. The credential column carries the **reference** and the
 * **status** — never a value — and the last column says whether the
 * connection can be used, so an unusable connection is visible as such and
 * not only as a status word.
 */
export function providerPickerLines(model: ProviderPickerModel): string[] {
  const rows = model.entries.map((entry) => [
    entry.id,
    entry.name,
    entry.route,
    entry.baseUrl,
    entry.credentialReference,
    entry.credentialStatus,
    entry.usable ? 'yes' : 'no',
  ]);
  const table = renderTable(
    ['ID', 'NAME', 'ROUTE', 'BASE URL', 'CREDENTIAL', 'STATUS', 'USABLE'],
    rows,
  );

  const lines: string[] = [];
  lines.push(`${model.title} (${PROVIDER_PICKER_LABEL})`);
  for (let index = 0; index < table.length; index += 1) {
    const line = table[index] ?? '';
    if (index === 0) {
      lines.push(line);
      continue;
    }
    const marker = index - 1 === model.selectedIndex ? PROVIDER_PICKER_MARKER : ' ';
    lines.push(`${marker} ${line}`);
  }
  if (model.entries.length === 0) {
    lines.push('No provider connections are configured.');
  }
  lines.push('CREDENTIAL is a reference, never a value.');
  lines.push(model.notice);
  return lines;
}

/**
 * The picker as one block of text.
 *
 * The lines are the picker's own; the block is what a terminal writes.
 */
export function renderProviderPicker(model: ProviderPickerModel): string {
  return providerPickerLines(model).join('\n');
}

/**
 * Move the selection.
 *
 * The movement **wraps**, so a picker of any length is navigable without a
 * special case at either end.
 */
export function moveProviderPickerSelection(
  model: ProviderPickerModel,
  delta: number,
): ProviderPickerModel {
  const count = model.entries.length;
  if (count === 0) return model;
  const next = (((model.selectedIndex + delta) % count) + count) % count;
  return { ...model, selectedIndex: next };
}

/** The selected entry, when there is one. */
export function selectedProviderPickerEntry(
  model: ProviderPickerModel,
): ProviderPickerEntry | undefined {
  return model.entries[model.selectedIndex];
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp a number into a range. */
function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}
