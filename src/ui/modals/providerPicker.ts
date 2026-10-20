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
 *     credential cannot be resolved is listed with its status, so the user can
 *     see which entry is broken and pick another.
 *
 * ## Why the module has no imports
 *
 * The picker is a **model**, not a renderer: it turns a list of entries into
 * the lines a terminal shows and manages the selection. The Ink application
 * (`src/ui/app.ts`) owns the rendering and the key handling, and the manager
 * command owns the entries. Keeping this module free of both means the two
 * surfaces cannot disagree about what a connection is, and it keeps the picker
 * testable without a terminal.
 */

/**
 * The label the picker carries.
 *
 * **Project requirement** (plan §Global Constraints): the extension "must be
 * labelled as an extension everywhere it surfaces (UI, `--help`, docs,
 * compatibility matrix)". The wording matches the command surfaces'.
 */
export const PROVIDER_PICKER_NOTICE =
  'The multi-provider manager is a project extension, not part of the reference agent.';

/** The shorter form of the label, used in the heading. */
export const PROVIDER_PICKER_LABEL = 'project extension - not part of the reference agent';

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
 * **status** — never a value.
 */
export function providerPickerLines(model: ProviderPickerModel): string[] {
  const rows = model.entries.map((entry) => [
    entry.id,
    entry.name,
    entry.route,
    entry.baseUrl,
    entry.credentialReference,
    entry.credentialStatus,
  ]);
  const table = renderTable(['ID', 'NAME', 'ROUTE', 'BASE URL', 'CREDENTIAL', 'STATUS'], rows);

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

/**
 * Render a table.
 *
 * The columns are padded to their widest cell, so the rows line up and each
 * record stays on one line.
 */
function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = headers.map((header) => header.length);
  for (const row of rows) {
    for (let index = 0; index < headers.length; index += 1) {
      const cell = row[index] ?? '';
      const current = widths[index] ?? 0;
      if (cell.length > current) widths[index] = cell.length;
    }
  }

  const render = (cells: readonly string[]): string =>
    headers
      .map((_, index) => (cells[index] ?? '').padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  return [render(headers), ...rows.map((row) => render(row))];
}

/** Clamp a number into a range. */
function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}
