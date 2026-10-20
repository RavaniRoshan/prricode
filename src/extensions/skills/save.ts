/**
 * The skill-save protocol: how the session tells the model that a skill change
 * is — or is not — saved to the user's account.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The skill-save
 * protocol is observed") and `docs/compatibility/extension-surface.md` ("The save
 * protocol").
 *
 * ## The five guidance modes
 *
 * | Mode | The guidance |
 * |---|---|
 * | `save_tool` | "To save a skill change for the user, use the `<tool>` tool." |
 * | `propose_tool` | "To let the user save this change, call `<tool>` with the complete SKILL.md." |
 * | `send_file` | "To pass this change to the user, send them the complete SKILL.md with the `<tool>` tool." |
 * | `no_save_tool` | "This session has no tool that saves a skill to the user's account: tell the user that this change is not saved, and point them to their claude.ai settings, where skills are managed." |
 * | `report_unsaved` | "Say in your reply that this change is not saved to the user's account." |
 *
 * ## The selection rule
 *
 * "A **remote call**, or a call with an `agentId`, or a file list containing no
 * `skill.md` (compared case-insensitively by basename), all select
 * `report_unsaved`. Otherwise the session's tools are inspected: when the mode
 * would be `send_file` but there is no send-capable tool, the answer is
 * `no_save_tool`; otherwise the mode stands."
 *
 * ## The folder note
 *
 * A skill folder that holds **synced copies of the user's account skills** is
 * special: a change or a new file there is not saved to the account, the model
 * must not report it as saved, and the next account sync can overwrite or remove
 * it. The note is appended to the guidance, and only for a known mode.
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - **Which capability selects which mode.** The audit names the capability
 *     set (`review`, `card`, `cloud`, `linked`, `policy`) and the five modes,
 *     but not the mapping between them. This implementation's mapping is:
 *
 *     | Capability | Meaning |
 *     |---|---|
 *     | `cloud` | the tool saves the skill to the user's account → `save_tool` |
 *     | `card` | the tool proposes the change for the user to accept → `propose_tool` |
 *     | `linked` | the tool sends the file to the user → `send_file` |
 *     | `review` | the tool shows the change for review — a modifier, not a mode |
 *     | `policy` | the tool is governed by a policy — a modifier, not a mode |
 *
 *     `save_tool` wins over `propose_tool` when a session has both, because a
 *     tool that can save directly is the stronger capability.
 *   - **The tool named in the guidance** is the tool that carries the
 *     capability that selected the mode.
 *   - The **synced-folder test** is the caller's: the request says whether the
 *     file is inside the synced folder. This implementation does not guess it from the
 *     path, because only the account sync knows where that folder is.
 *   - The note is appended "only for a known mode" — the audit's rule. The
 *     implementation's selector returns one of the five modes by construction, so the
 *     condition holds always; the rule is kept as a **property of the
 *     selector**, and it is pinned by a test rather than by a runtime guard
 *     that can never fail.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The skill telemetry events the target emits.
 *
 * Observed: `tengu_propose_skills`, `tengu_propose_skills_read_check` and
 * `tengu_propose_skills_kept_lines`, plus a `skills_load_ms` timing event.
 */
export const SKILL_TELEMETRY_EVENTS = [
  'tengu_propose_skills',
  'tengu_propose_skills_read_check',
  'tengu_propose_skills_kept_lines',
  'skills_load_ms',
] as const;

/** One of the skill telemetry events. */
export type SkillTelemetryEvent = (typeof SKILL_TELEMETRY_EVENTS)[number];

/**
 * The read check the `propose_skills` path runs.
 *
 * Observed: "The `propose_skills` path has its own read check — it refuses a
 * proposal whose file it cannot `stat` or read, and it skips its input checks
 * for a documented reason."
 *
 * Implementation choice: the reasons below are this implementation's. The target's own reason
 * strings are not in the audit, and the audit says the path "skips its input
 * checks for a documented reason" without naming it, so this implementation's check does
 * the two steps the audit names — `stat` and read — and nothing else.
 */
export interface SkillReadCheck {
  /** Whether the proposal may go ahead. */
  ok: boolean;
  /** The reason the proposal was refused. */
  reason?: string;
}

/**
 * Run the propose-skills read check over a file.
 */
export function proposeSkillReadCheck(filePath: string): SkillReadCheck {
  try {
    statSync(filePath);
  } catch {
    return { ok: false, reason: 'the file could not be stat-ed' };
  }
  try {
    readFileSync(filePath);
  } catch {
    return { ok: false, reason: 'the file could not be read' };
  }
  return { ok: true };
}

/**
 * The capabilities a skill-saving tool can carry.
 *
 * The audit names the set; this implementation keeps it closed so a typo in a settings
 * file cannot invent a capability.
 */
export const SKILL_SAVE_CAPABILITIES = [
  'review',
  'card',
  'cloud',
  'linked',
  'policy',
] as const;

/** One of the tool capabilities. */
export type SkillSaveCapability = (typeof SKILL_SAVE_CAPABILITIES)[number];

/**
 * The five guidance modes, exactly.
 */
export const SKILL_SAVE_MODES = [
  'save_tool',
  'propose_tool',
  'send_file',
  'no_save_tool',
  'report_unsaved',
] as const;

/** One of the five guidance modes. */
export type SkillSaveMode = (typeof SKILL_SAVE_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set<string>(SKILL_SAVE_MODES);

/** Whether a value is one of the five guidance modes. */
export function isSkillSaveMode(value: unknown): value is SkillSaveMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

/**
 * The note the target appends for a file inside the folder that holds synced
 * copies of the user's account skills.
 */
export const SKILL_SYNCED_FOLDER_NOTE =
  'Note: this file is inside the folder that holds synced copies of the user\'s account skills. A change or new file here is not saved to their account, so do not report it as saved, and the next sync from their account can overwrite or remove it.';

/** A tool of the session, with the capabilities it carries. */
export interface SkillSaveTool {
  /** The tool's name, as the model calls it. */
  name: string;
  /** The capabilities the tool carries. */
  capabilities: readonly SkillSaveCapability[];
}

/** The request the guidance is computed for. */
export interface SkillSaveRequest {
  /** The files the change touches. */
  files: readonly string[];
  /** Whether the call is remote. */
  remote?: boolean;
  /** The subagent the call came from, when it came from one. */
  agentId?: string;
  /** The session's tools. */
  tools?: readonly SkillSaveTool[];
  /** Whether the change is inside the folder that holds synced account skills. */
  inSyncedFolder?: boolean;
}

/** The guidance for a skill-save request. */
export interface SkillSaveGuidance {
  /** The mode that was selected. */
  mode: SkillSaveMode;
  /** The wording for that mode. */
  guidance: string;
  /** The synced-folder note, when the file is inside that folder. */
  note?: string;
}

/**
 * Whether the file list holds a `skill.md`.
 *
 * The comparison is by **basename**, and **case-insensitive**: the target
 * compares "case-insensitively by basename".
 */
export function fileListHasSkillFile(files: readonly string[]): boolean {
  return files.some((file) => path.basename(file).toLowerCase() === 'skill.md');
}

/**
 * The mode the session's tools would select, before the send-capable check.
 */
function baseMode(tools: readonly SkillSaveTool[]): SkillSaveMode {
  if (tools.some((tool) => tool.capabilities.includes('cloud'))) return 'save_tool';
  if (tools.some((tool) => tool.capabilities.includes('card'))) return 'propose_tool';
  return 'send_file';
}

/**
 * The capability that carries a mode.
 */
function capabilityForMode(mode: SkillSaveMode): SkillSaveCapability | undefined {
  if (mode === 'save_tool') return 'cloud';
  if (mode === 'propose_tool') return 'card';
  if (mode === 'send_file') return 'linked';
  return undefined;
}

/**
 * The tool the mode's guidance names.
 */
function toolForMode(
  mode: SkillSaveMode,
  tools: readonly SkillSaveTool[],
): SkillSaveTool | undefined {
  const capability = capabilityForMode(mode);
  if (!capability) return undefined;
  return tools.find((tool) => tool.capabilities.includes(capability));
}

/**
 * Select the guidance mode for a request.
 *
 * The rule is the target's, in the target's order.
 */
export function selectSkillSaveMode(request: SkillSaveRequest): SkillSaveMode {
  if (request.remote === true) return 'report_unsaved';
  if (request.agentId !== undefined) return 'report_unsaved';
  if (!fileListHasSkillFile(request.files)) return 'report_unsaved';

  const tools = request.tools ?? [];
  const mode = baseMode(tools);
  if (mode === 'send_file' && !toolForMode('send_file', tools)) return 'no_save_tool';
  return mode;
}

/**
 * The wording of a mode.
 *
 * The wording is the target's, verbatim.
 */
export function skillSaveModeGuidance(mode: SkillSaveMode, toolName: string): string {
  switch (mode) {
    case 'save_tool':
      return `To save a skill change for the user, use the \`${toolName}\` tool.`;
    case 'propose_tool':
      return `To let the user save this change, call \`${toolName}\` with the complete SKILL.md.`;
    case 'send_file':
      return `To pass this change to the user, send them the complete SKILL.md with the \`${toolName}\` tool.`;
    case 'no_save_tool':
      return "This session has no tool that saves a skill to the user's account: tell the user that this change is not saved, and point them to their claude.ai settings, where skills are managed.";
    case 'report_unsaved':
      return "Say in your reply that this change is not saved to the user's account.";
  }
}

/**
 * The guidance for a skill-save request: the mode, its wording, and the
 * synced-folder note when the file is inside that folder.
 */
export function skillSaveGuidance(request: SkillSaveRequest): SkillSaveGuidance {
  const mode = selectSkillSaveMode(request);
  const tools = request.tools ?? [];
  const tool = toolForMode(mode, tools);
  const toolName = tool?.name ?? 'skill-save';
  const guidance = skillSaveModeGuidance(mode, toolName);

  // The note is appended only for a known mode. This implementation's selector returns
  // one of the five modes by construction — `selectSkillSaveMode` has no other
  // outcome — so the condition holds always and there is no unknown mode to
  // guard against. (Implementation choice: the audit's "only for a known mode" is a
  // rule about a mode the target's selector may fail to produce; this implementation's
  // selector cannot.)
  if (request.inSyncedFolder === true) {
    return { mode, guidance: `${guidance}\n${SKILL_SYNCED_FOLDER_NOTE}`, note: SKILL_SYNCED_FOLDER_NOTE };
  }

  return { mode, guidance };
}
