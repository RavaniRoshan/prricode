/**
 * The extension-point registry: the fixed set of points a plugin or an SDK host
 * registers a handler for.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The extension-point
 * registry is observed") and `docs/compatibility/extension-surface.md` ("The
 * extension-point registry").
 *
 * ## The fixed set
 *
 * ```
 * tool.call        tool.check         tool.describe      command.run      command.describe
 * config.set       config.describe    telemetry.log      telemetry.mark   prompt.submit
 * prompt.fill      prompt.edit        prompt.change      prompt.autocomplete
 * prompt.suggest   prompt.section     prompt.context     prompt.attachment
 * prompt.mention   prompt.compose     agent.offer        agent.spawn      skill.prompt
 * attribution.text session.start     session.receive    session.append   session.send
 * session.compact  session.attach     session.detach     session.measure  session.end
 * turn.start       turn.step          turn.complete      ui.scroll        ui.focus
 * ```
 *
 * ## The two defaults
 *
 * - `tool.call` is given a `tool_use_id` when the caller did not supply one, of
 *   the form `toolu_<uuid without dashes>`;
 * - `telemetry.log` is given a destination of `anthropic` unless the caller
 *   asked for `collector`.
 *
 * ## The `skill.prompt` seam
 *
 * The `skill.prompt` point is where the target validates a skill's frontmatter,
 * so the registry validates it before the handler runs — with the target's exact
 * error text (see `src/extensions/skills/frontmatter.ts`). The skill the handler
 * returns then carries a `source`, **defaulting to `built-in`**.
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - Invoking a point that has **no handler** yields `undefined` rather than
 *     throwing: a host that does not implement a point is not an error.
 *   - The registry never **mutates** the caller's payload; the defaults are
 *     applied to a copy.
 *   - The `telemetry.log` destination is **normalized** to the two the audit
 *     names: `anthropic`, unless the caller asked for `collector`. A caller
 *     that asked for anything else is given `anthropic`.
 */

import { randomUUID } from 'node:crypto';

import { assertSkillFrontmatter, frontmatterValue, isPlainObject } from '../skills/frontmatter.js';
import type { ToolDefinition } from '../../tools/registry.js';

export type { ToolDefinition } from '../../tools/registry.js';

/**
 * The extension points, exactly the set the target exposes.
 */
export const EXTENSION_POINTS = [
  'tool.call',
  'tool.check',
  'tool.describe',
  'command.run',
  'command.describe',
  'config.set',
  'config.describe',
  'telemetry.log',
  'telemetry.mark',
  'prompt.submit',
  'prompt.fill',
  'prompt.edit',
  'prompt.change',
  'prompt.autocomplete',
  'prompt.suggest',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'prompt.mention',
  'prompt.compose',
  'agent.offer',
  'agent.spawn',
  'skill.prompt',
  'attribution.text',
  'session.start',
  'session.receive',
  'session.append',
  'session.send',
  'session.compact',
  'session.attach',
  'session.detach',
  'session.measure',
  'session.end',
  'turn.start',
  'turn.step',
  'turn.complete',
  'ui.scroll',
  'ui.focus',
] as const;

/** One of the extension points. */
export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

const POINT_SET: ReadonlySet<string> = new Set<string>(EXTENSION_POINTS);

/** Whether a value is one of the extension points. */
export function isExtensionPoint(value: unknown): value is ExtensionPoint {
  return typeof value === 'string' && POINT_SET.has(value);
}

/** The payload an extension point carries. */
export type ExtensionPayload = Record<string, unknown>;

/** The handler an extension point is given. */
export type ExtensionHandler = (payload: ExtensionPayload) => unknown | Promise<unknown>;

/** The registry of extension-point handlers. */
export interface ExtensionPointRegistry {
  /** Register a handler for a point. A second handler replaces the first. */
  register(point: ExtensionPoint, handler: ExtensionHandler): void;
  /** Remove the handler of a point. Returns whether there was one. */
  unregister(point: ExtensionPoint): boolean;
  /** Whether a point has a handler. */
  has(point: ExtensionPoint): boolean;
  /** The points that have a handler. */
  points(): readonly ExtensionPoint[];
  /** Invoke a point, applying the target's defaults first. */
  invoke(point: ExtensionPoint, payload?: ExtensionPayload): Promise<unknown>;
}

/**
 * The `tool_use_id` the target generates for a `tool.call`.
 *
 * The form is `toolu_<uuid without dashes>`.
 */
export function generateToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The destination `telemetry.log` defaults to.
 */
export const DEFAULT_TELEMETRY_DESTINATION = 'anthropic';

/**
 * The destination `telemetry.log` uses when the caller asks for the collector.
 */
export const COLLECTOR_TELEMETRY_DESTINATION = 'collector';

/**
 * Create an extension-point registry.
 *
 * The registry is backed by a `Map`, so a point name — which is caller-supplied
 * data in a plugin manifest — never resolves to an inherited member of
 * `Object.prototype`.
 */
export function createExtensionPointRegistry(): ExtensionPointRegistry {
  const handlers = new Map<ExtensionPoint, ExtensionHandler>();

  const applyDefaults = (point: ExtensionPoint, payload: ExtensionPayload): ExtensionPayload => {
    const effective: ExtensionPayload = { ...payload };

    if (point === 'tool.call' && effective['tool_use_id'] === undefined) {
      effective['tool_use_id'] = generateToolUseId();
    }

    if (point === 'telemetry.log') {
      const requested = effective['destination'];
      // The target gives the point a destination of `anthropic` unless the
      // caller asked for `collector`.
      if (requested !== COLLECTOR_TELEMETRY_DESTINATION) {
        effective['destination'] = DEFAULT_TELEMETRY_DESTINATION;
      }
    }

    return effective;
  };

  return {
    register(point: ExtensionPoint, handler: ExtensionHandler): void {
      handlers.set(point, handler);
    },
    unregister(point: ExtensionPoint): boolean {
      return handlers.delete(point);
    },
    has(point: ExtensionPoint): boolean {
      return handlers.has(point);
    },
    points(): readonly ExtensionPoint[] {
      return [...handlers.keys()];
    },
    async invoke(point: ExtensionPoint, payload: ExtensionPayload = {}): Promise<unknown> {
      const handler = handlers.get(point);
      if (!handler) return undefined;

      const effective = applyDefaults(point, payload);

      if (point === 'skill.prompt') {
        // The target validates the frontmatter at this point, and its error
        // text is part of the observable contract.
        assertSkillFrontmatter(effective['frontmatter']);
      }

      const result = await handler(effective);

      if (point === 'skill.prompt' && isPlainObject(result)) {
        const frontmatter = effective['frontmatter'];
        const source = frontmatterValue(frontmatter, 'source');
        return {
          ...result,
          source: typeof source === 'string' ? source : 'built-in',
        };
      }

      return result;
    },
  };
}
