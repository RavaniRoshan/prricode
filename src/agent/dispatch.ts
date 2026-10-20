/**
 * The tool-call dispatch: the tool calls of one assistant message, the order
 * they run in, and the groups they may run in.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch) and the `CC-010` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this module is
 *
 * A provider turn produces the tool calls of one assistant message. This module
 * turns the provider's event stream into those calls, and it describes **how**
 * they are dispatched: the order, and the grouping.
 *
 * ## The ordering rule — a implementation choice, not an observed target behaviour
 *
 * The plan's Step 5 says: "two tool calls in one assistant message are
 * executed **in the order they appear**, and each result is appended **before**
 * the next provider request is issued."
 *
 * **That ordering is a implementation choice.** The audit is explicit about it (§2.4,
 * "Partial", and §4 item 4): "the exact **scheduling of concurrent tool calls**
 * — whether several `tool_use` blocks in one assistant message run in parallel
 * or in sequence, and the point at which the next model request is issued — was
 * not traced"; the audit's exit-gate table repeats it: "the **scheduling order**
 * of concurrent tool calls and the point at which the next model request is
 * issued" is one of the three bounded REA residuals. It is one of the three
 * items the REA coverage audit could not close, because "every call in these
 * functions is a **member call** (`this.x(...)`), which REA does not resolve into
 * a `calls` relation".
 *
 * So this implementation does **not** claim that the target runs its tool calls
 * sequentially. It runs them sequentially because that is what the plan
 * specifies, and the plan's order is an **inference**, not an observation. The
 * ordering here is therefore labelled a implementation choice wherever it surfaces.
 *
 * ## The groups and the `parallel` flag agree
 *
 * `groupToolCalls` returns both a `parallel` flag and the groups, and the two
 * are never allowed to disagree:
 *
 *   - **sequential** — every call is its own group, so the flag is `false`;
 *   - **parallel** — the calls that may run together share one group, so the
 *     flag is `true`.
 *
 * A caller may therefore trust either one: the flag says *whether* the calls
 * may run together, and the groups say *which* ones may. The invariant is
 * pinned by the contract test.
 *
 * This implementation's **runtime** dispatches sequentially: the default mode is
 * `sequential`, and `groupToolCalls` is the classifier that says so. The
 * parallel mode is the seam a later task uses to start the calls of a group
 * concurrently; it is not the default, because the target's concurrent
 * scheduling order is a bounded residual.
 */

import type { ProviderEvent } from '../provider/drivers/types.js';

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
 * carry no dependency information, so this implementation cannot derive a finer grouping
 * than "all of them" or "each of them", and it does not pretend to.
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
 * The order the calls run in.
 *
 * **Implementation choice** (see the module header): the calls run in the order they
 * appear in the assistant message, and each call's result is appended before
 * the next provider request is issued. The target's own concurrent scheduling
 * order is one of the three bounded REA residuals and is **not** claimed.
 */
export function dispatchOrder(calls: ToolCall[]): ToolCall[] {
  return [...calls];
}

/**
 * Flatten a dispatch plan into the order the calls run in.
 *
 * The groups are read in order, and the calls of a group in the order they
 * appear in it. For the sequential plan — this implementation's default — this is the
 * order the calls appear in the assistant message.
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
