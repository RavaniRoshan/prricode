/**
 * The tool-call dispatch: the tool calls of one assistant message, the order
 * they run in, and the groups they may run in.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch) and the `CC-010b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this module is
 *
 * A provider turn produces the tool calls of one assistant message. This module
 * turns the provider's event stream into those calls, and it describes **how**
 * they are dispatched: the order, and the grouping.
 *
 * ## The scheduling rule — the target's observed rule
 *
 * **The target's scheduler is per tool, not per message.** The REA read the
 * scheduler out of the target's source (the executor `Rs` in
 * `chunk-ehmvy572.js`), and the record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-tool-scheduling.md`:
 *
 *   - every tool declares whether it is **concurrency safe**;
 *   - the **concurrency-safe** calls of one assistant message run **in
 *     parallel** — several are in flight at once;
 *   - a call that is **not** concurrency safe runs **alone** and is a
 *     **barrier**: the queue stops at it, and nothing else starts until it has
 *     finished;
 *   - the **next model request** is issued only after **every** call of that
 *     assistant message has produced its result;
 *   - the results are **emitted** in block order for the non-safe calls and in
 *     **completion order** for the concurrency-safe ones.
 *
 * The target's own gate is a queue walk: a queued call may start when nothing
 * is executing, or when every executing call is itself concurrency safe; a
 * queued call that is **not** concurrency safe and cannot start **breaks** the
 * walk, so the calls listed after it wait for it. That is exactly the
 * grouping {@link scheduleToolCalls} produces: the **maximal runs** of
 * concurrency-safe calls, with every non-safe call alone between them.
 *
 * **A tool that does not declare the flag is not concurrency safe.** That is
 * the target's own default — the flag is read inside a `try`, and the `catch`
 * says `false`.
 *
 * ## The per-tool flags
 *
 * The target's own tools declare the flag like this:
 *
 * | tool | concurrency safe |
 * |---|---|
 * | `Glob` | yes |
 * | `Grep` | yes |
 * | the notebook **read** tool | yes |
 * | `WebFetch` | yes |
 * | `Read` | yes |
 * | the MCP "wait for server" tool | no |
 * | `Bash` | only when the command is **read-only** |
 * | every other tool | no — it declares nothing |
 *
 * This implementation has **no notebook-read tool**: its `NotebookEdit`
 * mutates a file, so it is not concurrency safe by the same reasoning. Every
 * other built-in tool — `Edit`, `Write`, `Task`, `TodoWrite` — mutates or
 * delegates, so it declares nothing and is not concurrency safe.
 *
 * ## The mode-driven plan
 *
 * {@link groupToolCalls} is the **mode-driven** plan: it says whether a set of
 * calls may run together (`parallel`) or one after the other (`sequential`).
 * It is kept for the callers that ask for a mode, and the runtime's own
 * scheduling is the observed per-tool rule of {@link scheduleToolCalls}.
 */

import type { ProviderEvent } from '../provider/drivers/types.js';
import { isToolConcurrencySafe, type ToolRegistry } from '../tools/registry.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One tool call of an assistant message.
 *
 * The three members are the ones the plan fixes: the tool-use id, the tool's
 * name, and the input the model asked for.
 */
export interface ToolCall {
  /** The tool-use id. The tool result answers this id. */
  id: string;
  /** The name the model called. */
  name: string;
  /** The input the model asked for. */
  input: unknown;
}

/**
 * How the tool calls of one assistant message are dispatched.
 *
 * - `sequential` — one call at a time, in the order the calls appear.
 * - `parallel` — the calls of one group may run together.
 */
export type ToolDispatchMode = 'sequential' | 'parallel';

/**
 * The dispatch plan of a set of tool calls.
 *
 * `groups` holds the **tool-use ids** of the calls of each group, in the order
 * the calls appear.
 */
export interface ToolCallGroups {
  /**
   * Whether the calls may run together.
   *
   * It agrees with `groups` by construction: `false` means every call is its
   * own group, `true` means the calls that may run together share one group.
   */
  parallel: boolean;
  /** The groups, each a list of tool-use ids. */
  groups: string[][];
}

/**
 * One group of the observed schedule.
 *
 * A group is either a **maximal run** of concurrency-safe calls — they run
 * together — or a **single** call that is not concurrency safe, which runs
 * alone and is a barrier.
 */
export interface ScheduledGroup {
  /** The tool-use ids of the group, in the order the calls appear. */
  ids: string[];
  /**
   * Whether the calls of the group run together.
   *
   * It is `false` for a call that is not concurrency safe: that call runs
   * alone.
   */
  parallel: boolean;
}

/* -------------------------------------------------------------------------- */
/* The classifier                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The tool calls of a provider turn.
 *
 * The calls are the `tool_use` events of the stream, in the order the provider
 * emitted them. A `tool_result` event is **not** a call — it is the answer to
 * one — so it is not collected here.
 */
export function toolCallsFrom(events: ProviderEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    calls.push({ id: event.id, name: event.name, input: event.input });
  }
  return calls;
}

/**
 * Group the tool calls of one assistant message.
 *
 * The mode decides the shape, and the `parallel` flag always agrees with it:
 *
 *   - `sequential` (the default) — every call is its own group and the flag is
 *     `false`;
 *   - `parallel` — the calls that may run together share one group and the
 *     flag is `true`.
 *
 * The mode is the **only** thing that decides the shape: the calls themselves
 * carry no dependency information, so this implementation cannot derive a
 * finer grouping than "all of them" or "each of them", and it does not pretend
 * to.
 *
 * **This is the mode-driven plan.** The runtime's own scheduling is the
 * observed per-tool rule of {@link scheduleToolCalls}, which groups by the
 * tool's own concurrency-safety flag rather than by a mode.
 */
export function groupToolCalls(
  calls: ToolCall[],
  options: { mode?: ToolDispatchMode } = {},
): ToolCallGroups {
  const mode = options.mode ?? 'sequential';
  if (mode === 'parallel') {
    // Every call may run together: the calls carry no dependency information,
    // so there is nothing to split them on.
    return { parallel: true, groups: calls.length === 0 ? [] : [calls.map((call) => call.id)] };
  }
  return { parallel: false, groups: calls.map((call) => [call.id]) };
}

/**
 * Flatten a dispatch plan into the order the calls run in.
 *
 * The groups are read in order, and the calls of a group in the order they
 * appear in it. For the sequential plan this is the order the calls appear in
 * the assistant message.
 */
export function callsInPlan(calls: ToolCall[], groups: ToolCallGroups): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const call of calls) byId.set(call.id, call);
  const ordered: ToolCall[] = [];
  for (const group of groups.groups) {
    for (const id of group) {
      const call = byId.get(id);
      if (call !== undefined) ordered.push(call);
    }
  }
  return ordered;
}

/**
 * The observed schedule of the tool calls of one assistant message.
 *
 * The groups are the **maximal runs** of concurrency-safe calls, with every
 * call that is not concurrency safe alone between them:
 *
 *   - a concurrency-safe call joins the run of safe calls before it, or starts
 *     one;
 *   - a call that is not concurrency safe is **alone** and **breaks** the run:
 *     the calls after it wait for it, because it is a barrier.
 *
 * That is the target's queue walk: a queued call may start when nothing is
 * executing, or when every executing call is itself concurrency safe, and a
 * queued call that is not concurrency safe and cannot start **breaks** the
 * walk.
 *
 * The predicate is the tool's **own** flag. A tool that does not declare the
 * flag is not concurrency safe — the target's own default.
 */
export function scheduleToolCalls(
  calls: ToolCall[],
  isConcurrencySafe: (call: ToolCall) => boolean,
): ScheduledGroup[] {
  const groups: ScheduledGroup[] = [];
  for (const call of calls) {
    const safe = isConcurrencySafe(call);
    const last = groups[groups.length - 1];
    if (safe && last !== undefined && last.parallel) {
      // The call joins the run of safe calls before it.
      last.ids.push(call.id);
      continue;
    }
    // A safe call starts a run; a call that is not concurrency safe stands
    // alone, and the run after it starts fresh.
    groups.push({ ids: [call.id], parallel: safe });
  }
  return groups;
}

/**
 * The scheduling a **registry** implies.
 *
 * The predicate the runtime uses reads the flag off the tool the registry
 * holds, and a tool the registry does not hold is **not** concurrency safe.
 * This is that predicate, wrapped so that a caller — a test, or a caller that
 * wants the rule without the runtime — can ask the question directly.
 */
export function scheduleToolCallsWithRegistry(
  calls: ToolCall[],
  registry: ToolRegistry,
): ScheduledGroup[] {
  return scheduleToolCalls(calls, (call) =>
    isToolConcurrencySafe(registry.get(call.name), call.input),
  );
}
