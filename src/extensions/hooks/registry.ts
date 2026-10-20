/**
 * The hook registry: the closed event list, the per-event execution
 * classification, the handler types, and the registry that holds a session's
 * hooks.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("Hook event
 * matrix") and the `CC-012` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The event surface is closed
 *
 * The target's hook events are exactly **33**, and the list is reproduced
 * verbatim from the plan's Global Constraints:
 *
 * ```
 * PreToolUse           PostToolUse          PostToolUseFailure  PostToolBatch
 * UserPromptSubmit     UserPromptExpansion  Stop                StopFailure
 * SubagentStart        SubagentStop         PermissionDenied    PermissionRequest
 * SessionStart         SessionEnd           Notification         Setup
 * PreCompact           PostCompact          PreModelSwitch      PostModelSwitch
 * TeammateIdle         TaskCreated          TaskCompleted       Elicitation
 * ElicitationResult    ConfigChange         WorktreeCreate      WorktreeRemove
 * InstructionsLoaded   CwdChanged           FileChanged         DirectoryAdded
 * MessageDisplay
 * ```
 *
 * The audit splits the surface in two: the **decision-capable** events (its
 * `yL` set) and the **execution-classified** events (its `wL` table). The two
 * sets are disjoint and together they are the 33 events, so every event is
 * exactly one of the two.
 *
 * ## `StatusLine` and `FileSuggestion` are not hook events
 *
 * The target's static analysis surfaced two more names, and they are
 * **settings-level display handlers**: a `type: "command"` handler whose output
 * is rendered and never decides anything. This implementation keeps them in their own
 * list (`DISPLAY_HANDLERS`) and out of `HOOK_EVENTS`, so they can never be
 * registered as a hook event and can never be a decision point.
 *
 * ## The registry is a `Map`
 *
 * The event name, the matcher, the tool name and the hook id are all
 * **caller-supplied data**, so every lookup is keyed by a `Map` and never
 * resolves an inherited member of `Object.prototype`: `for('constructor')` and
 * `for('__proto__')` both return an empty list. The one table that is a plain
 * object — the execution classification — is read with `Object.hasOwn`, so
 * `executionClass('constructor')` is `undefined` and not `Object`.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - **A hook for an event that does not exist is refused** rather than
 *     ignored. A typo in a settings file is a configuration error, and a
 *     silently ignored hook is a hook that never fires.
 *   - **An `mcp_tool` hook must name its server.** The audit observes that such a
 *     hook carries a `server` field, and the registry collects the servers that
 *     contribute `mcp_tool` hooks; a hook without a server could not be
 *     collected.
 *   - **`HookSpec.command` is the tool name for an `mcp_tool` hook**, because the
 *     plan keeps `command` a required member and the hook names the tool it
 *     calls there.
 *   - **The blockable events are the eleven decision-capable events plus
 *     `PermissionRequest`** — twelve in all. The audit records
 *     `PermissionRequest` as carrying a decision of its own, so this implementation
 *     treats an exit code of `2` there as a block.
 *   - **`HookSpec.type` stays the plan's two-member union** (`command` |
 *     `mcp_tool`) and the target's wider handler vocabulary
 *     (`command`, `http`, `mcp_tool`, `prompt`, `agent`) lives in
 *     `HOOK_HANDLER_TYPES`. The optional `handlerType` member carries the wider
 *     vocabulary for a settings file that names a handler this implementation cannot
 *     execute; such a hook is registered and surfaced, but the runner does not
 *     dispatch it.
 *   - **`handlerType` carries the handler kind when it is present**, and `type`
 *     carries it otherwise: the two are never read for different purposes.
 *   - **`HookSpec.severity`** is the severity of a **failure** of that hook.
 *     A failure of severity `stop` denies every tool call for the session (the
 *     permission layer's host gate in `src/permissions/decision.ts`).
 *   - **A matcher this implementation cannot compile is refused at registration.** A
 *     matcher is configuration, and a configuration error is loud; the runner
 *     still matches nothing for a matcher that does not compile, so a hook
 *     built without the registry never matches a tool by accident.
 */

import type { PermissionMode } from '../../permissions/decision.js';

import { compileMatcher } from './matcher.js';
import { effectiveHandlerType } from './schema.js';

/**
 * The runner's public surface is re-exported here, so that a consumer of the
 * hook surface has **one** entry point:
 *
 * ```ts
 * import { HOOK_EVENTS, runHooks, type HookSpec } from './extensions/hooks/registry.js';
 * ```
 *
 * The dependency runs one way only — the registry re-exports the runner, and
 * the runner knows nothing of the registry at run time (it imports the
 * registry's types with `import type`, which is erased) — so there is no
 * cycle.
 */
export {
  BLOCKED_BY_HOOK_REASON,
  DEFAULT_HOOK_TIMEOUT_MS,
  DECISION_RANKS,
  DECISION_STRICTNESS,
  applyUpdatedPermissions,
  createHookApproval,
  createPreToolUseApproval,
  emptyPermissionMap,
  hookFailureFromResults,
  mergeHookResults,
  mergePermissionRequestApproval,
  mergePermissionRequestResult,
  mergePreToolUseApproval,
  runHooks,
  type HookCommandOutcome,
  type HookDecisionValue,
  type HookPermissionMap,
  type HookResult,
  type HookRunner,
  type PermissionRequestResult,
  type RunHooksOptions,
} from './runner.js';

/**
 * The hook events, exactly **33** of them.
 *
 * The list is the plan's Global Constraints list verbatim, and it is the
 * **only** set of hook events: `StatusLine` and `FileSuggestion` are not in it.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PermissionDenied',
  'PermissionRequest',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'Setup',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
] as const;

/** A hook event. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The settings-level **display handlers**.
 *
 * They are not hook events: their output is rendered and never decides
 * anything, so they live in their own list.
 */
export const DISPLAY_HANDLERS = ['StatusLine', 'FileSuggestion'] as const;

/** A display handler's name. */
export type DisplayHandlerName = (typeof DISPLAY_HANDLERS)[number];

/**
 * The handler types the target's hook surface carries.
 *
 * `command` and `mcp_tool` are executable by this implementation; `http`, `prompt` and
 * `agent` are surfaced but not dispatched (see `HookSpec.handlerType`).
 */
export const HOOK_HANDLER_TYPES = ['command', 'http', 'mcp_tool', 'prompt', 'agent'] as const;

/** A handler type. */
export type HookHandlerType = (typeof HOOK_HANDLER_TYPES)[number];

/**
 * The per-event execution classification.
 *
 * The classification says **when** an event fires: `runs_locally` events fire
 * in the local session, `later` events fire after the main flow has started,
 * `low_value` events carry little value, and `container_internal` events are
 * the container's own bookkeeping.
 */
export type HookExecutionClass = 'runs_locally' | 'later' | 'low_value' | 'container_internal';

/**
 * The **decision-capable** events — the audit's `yL` set.
 *
 * A hook for one of these events can decide something: block a tool call,
 * stop a turn, or refuse a prompt.
 */
export const DECISION_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PermissionDenied',
] as const;

/**
 * The events that carry an execution classification — the audit's `wL` table.
 *
 * The table is disjoint from `DECISION_EVENTS`, and the two together are
 * the 33 hook events.
 */
export const HOOK_EXECUTION_CLASS: Readonly<Partial<Record<HookEvent, HookExecutionClass>>> = {
  SessionStart: 'runs_locally',
  SessionEnd: 'runs_locally',
  Notification: 'runs_locally',
  PermissionRequest: 'later',
  PreModelSwitch: 'later',
  PostModelSwitch: 'later',
  Setup: 'low_value',
  PreCompact: 'low_value',
  PostCompact: 'low_value',
  TeammateIdle: 'low_value',
  TaskCreated: 'low_value',
  TaskCompleted: 'low_value',
  Elicitation: 'low_value',
  ElicitationResult: 'low_value',
  ConfigChange: 'container_internal',
  WorktreeCreate: 'container_internal',
  WorktreeRemove: 'container_internal',
  InstructionsLoaded: 'container_internal',
  CwdChanged: 'container_internal',
  FileChanged: 'container_internal',
  DirectoryAdded: 'container_internal',
  MessageDisplay: 'container_internal',
};

/**
 * The events on which a hook's exit code `2` **blocks**.
 *
 * A blockable event is one where a block has a meaning: the tool call is
 * refused, the prompt is refused, or the turn does not stop. On every other
 * event an exit code of `2` is a non-blocking error, because there is nothing
 * to block.
 *
 * The set is the decision-capable events plus `PermissionRequest`, which the
 * audit records as carrying a decision of its own.
 */
export {
  BLOCKABLE_EVENTS,
  EVENTS_WITHOUT_MCP_SERVERS,
  effectiveHandlerType,
  isBlockableEvent,
  mcpServersAvailable,
} from './schema.js';

/**
 * The severity of a hook **failure**.
 *
 * A failure of severity `stop` denies every tool call for the session.
 */
export type HookSeverity = 'info' | 'warning' | 'error' | 'stop';

/**
 * A hook specification.
 *
 * The members the plan fixes are `event`, `matcher`, `command`, `timeoutMs`,
 * `type` and `server`; the members below them are this implementation's additions and
 * are all optional.
 */
export interface HookSpec {
  /** The event the hook runs for. */
  event: HookEvent;
  /**
   * The matcher.
   *
   * It is matched against the **tool name** for the tool events and against
   * the **MCP server name** for `Elicitation` and `ElicitationResult`. A hook
   * without a matcher runs for every call of its event.
   */
  matcher?: string;
  /**
   * The command the hook runs.
   *
   * For an `mcp_tool` hook it is the **tool name** on the MCP server.
   */
  command: string;
  /** How long the hook may run, in milliseconds. */
  timeoutMs?: number;
  /** The handler type. */
  type?: 'command' | 'mcp_tool';
  /** The MCP server, for an `mcp_tool` hook. */
  server?: string;
  /**
   * The wider handler vocabulary.
   *
   * A hook that names a handler this implementation cannot execute (`http`, `prompt`,
   * `agent`) is registered and surfaced but not dispatched by the runner.
   *
   * It carries the handler kind when it is present: the runner dispatches a
   * hook by the **effective** handler type, which is `handlerType` when it is
   * given and `type` otherwise.
   */
  handlerType?: HookHandlerType;
  /** The severity of a **failure** of this hook. */
  severity?: HookSeverity;
  /** A caller-supplied identifier, used in messages. */
  id?: string;
}

/**
 * A settings-level display handler.
 *
 * Its output is rendered and is **never** a decision.
 */
export interface DisplayHandlerSpec {
  /** The handler type; the target's display handlers are commands. */
  type: 'command';
  /** The command the handler runs. */
  command: string;
  /** How long the handler may run, in milliseconds. */
  timeoutMs?: number;
}

/** The registry of hooks. */
export interface HookRegistry {
  /** Register a hook. */
  register(spec: HookSpec): void;
  /** The hooks registered for an event. */
  for(event: HookEvent): HookSpec[];
  /** Every registered hook, in registration order. */
  all(): readonly HookSpec[];
  /**
   * The MCP servers that contribute an `mcp_tool` hook.
   *
   * The audit observes that the registry collects this set.
   */
  servers(): readonly string[];
  /** Whether a server contributes any hook at all. */
  hasServer(server: string): boolean;
  /** The hooks a server contributes. */
  forServer(server: string): HookSpec[];
  /** Register a settings-level display handler. */
  registerDisplayHandler(spec: DisplayHandlerSpec): void;
  /** The registered display handlers, in registration order. */
  displayHandlers(): readonly DisplayHandlerSpec[];
  /** The execution classification of an event, when it has one. */
  executionClass(event: HookEvent): HookExecutionClass | undefined;
}

/** A hook that cannot be registered as it stands. */
export class HookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookConfigurationError';
  }
}

const EVENT_SET: ReadonlySet<string> = new Set<string>(HOOK_EVENTS);
const DISPLAY_HANDLER_SET: ReadonlySet<string> = new Set<string>(DISPLAY_HANDLERS);

/** Whether a value is one of the 33 hook events. */
export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && EVENT_SET.has(value);
}

/** Whether a value is one of the two display handlers. */
export function isDisplayHandler(value: unknown): value is DisplayHandlerName {
  return typeof value === 'string' && DISPLAY_HANDLER_SET.has(value);
}

/** Whether an event is decision-capable. */
export function isDecisionEvent(event: HookEvent): boolean {
  return (DECISION_EVENTS as readonly string[]).includes(event);
}

/**
 * The execution classification of an event, when it has one.
 *
 * The table is a plain object, so the lookup is guarded: an event name that
 * is an inherited member of `Object.prototype` — `constructor`, `__proto__`,
 * `toString` — is **not** an event and has no classification.
 */
export function hookExecutionClass(event: HookEvent): HookExecutionClass | undefined {
  if (!Object.hasOwn(HOOK_EXECUTION_CLASS, event)) return undefined;
  return HOOK_EXECUTION_CLASS[event];
}

/**
 * Create a hook registry.
 *
 * The registry is backed by `Map`s, so an event name, a server name and a hook
 * id are **data**: none of them can resolve an inherited member of
 * `Object.prototype`.
 */
export function createHookRegistry(): HookRegistry {
  const byEvent = new Map<HookEvent, HookSpec[]>();
  const byServer = new Map<string, HookSpec[]>();
  const every: HookSpec[] = [];
  const display: DisplayHandlerSpec[] = [];

  const register = (spec: HookSpec): void => {
    if (!isHookEvent(spec.event)) {
      throw new HookConfigurationError(
        `'${String(spec.event)}' is not one of the ${HOOK_EVENTS.length} hook events.`,
      );
    }
    if (typeof spec.command !== 'string' || spec.command.length === 0) {
      throw new HookConfigurationError(
        `A ${spec.event} hook needs a command to run.`,
      );
    }
    if (spec.matcher !== undefined) {
      const compiled = compileMatcher(spec.matcher);
      if (!compiled.ok) {
        throw new HookConfigurationError(
          `The matcher of the ${spec.event} hook is not one this implementation can compile: ${compiled.reason}.`,
        );
      }
    }
    const handler = effectiveHandlerType(spec);
    if (handler === 'mcp_tool') {
      if (typeof spec.server !== 'string' || spec.server.length === 0) {
        throw new HookConfigurationError(
          `An mcp_tool hook needs the server it calls.`,
        );
      }
      const serverHooks = byServer.get(spec.server);
      if (serverHooks) serverHooks.push(spec);
      else byServer.set(spec.server, [spec]);
    }

    const eventHooks = byEvent.get(spec.event);
    if (eventHooks) eventHooks.push(spec);
    else byEvent.set(spec.event, [spec]);
    every.push(spec);
  };

  return {
    register,
    for(event: HookEvent): HookSpec[] {
      // An unknown event resolves to no hooks, and never to an inherited member.
      const hooks = byEvent.get(event);
      return hooks ? [...hooks] : [];
    },
    all(): readonly HookSpec[] {
      return [...every];
    },
    servers(): readonly string[] {
      return [...byServer.keys()];
    },
    hasServer(server: string): boolean {
      return byServer.has(server);
    },
    forServer(server: string): HookSpec[] {
      const hooks = byServer.get(server);
      return hooks ? [...hooks] : [];
    },
    registerDisplayHandler(spec: DisplayHandlerSpec): void {
      display.push(spec);
    },
    displayHandlers(): readonly DisplayHandlerSpec[] {
      return [...display];
    },
    executionClass(event: HookEvent): HookExecutionClass | undefined {
      return hookExecutionClass(event);
    },
  };
}

/**
 * The permission mode a hook payload may carry.
 *
 * The payload's `permission_mode` is one of the six modes; the type is
 * re-exported here so a caller of the hook surface does not have to reach
 * into the permission module for it.
 */
export type HookPermissionMode = PermissionMode;
