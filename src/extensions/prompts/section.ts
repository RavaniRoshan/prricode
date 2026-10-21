/**
 * The **prompt section**: the extension point through which a plugin or a host
 * rewrites a section of the prompt before it is sent.
 *
 * Evidence: `chunk-4jsg44k7.js:44481` (the dispatch), `:53395` (the core handler),
 * `:41782` (the extension-point map), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §7.
 *
 * ## The target's own rule
 *
 * ```js
 * var O9n = (e, n, r) => el("prompt.section")
 *   ? Fi("prompt.section", { ...r !== void 0 && { origin: r } })({ name: e, text: n })
 *       .then((s) => s.text)
 *   : Promise.resolve(n);
 * ```
 *
 * So:
 *
 *   - with **no handler** registered for `prompt.section`, the section's text stands
 *     as it is;
 *   - with a handler, the handler receives **`{name, text}`** — the section's name
 *     and its text — and the result's **`text`** replaces it.
 *
 * The **core** handler is the identity — `(e) => ({text: e.text})` — so a host that
 * registers nothing changes nothing.
 */

import type { ExtensionPointRegistry } from '../plugins/extension-points.js';

/** What a `prompt.section` handler receives. */
export interface PromptSectionPayload {
  /** The section's name. */
  readonly name: string;
  /** The section's text. */
  readonly text: string;
  /** Where the section came from, when the caller knows. */
  readonly origin?: unknown;
}

/**
 * Compose a section of the prompt.
 *
 * The registry's `prompt.section` handler, when there is one, rewrites the text; with
 * no handler the text stands.
 *
 * **Implementation choice**: a handler that returns no text at all leaves the section
 * as it was. The target would take the missing text as it stands, which is a footgun
 * this implementation does not reproduce; the difference is recorded in
 * `docs/compatibility/remaining-surfaces.md`.
 */
export async function composePromptSection(
  registry: ExtensionPointRegistry,
  name: string,
  text: string,
  origin?: unknown,
): Promise<string> {
  if (!registry.has('prompt.section')) return text;

  const payload: PromptSectionPayload = {
    name,
    text,
    ...(origin === undefined ? {} : { origin }),
  };

  const result = await registry.invoke('prompt.section', { ...payload });
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return text;
  const composed = (result as Record<string, unknown>)['text'];
  return typeof composed === 'string' ? composed : text;
}
