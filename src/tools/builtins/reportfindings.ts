/**
 * The `ReportFindings` tool: report code-review findings as a structured list.
 *
 * Evidence: the target's `ReportFindings` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:50421`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.** The schema takes an
 * optional `level` — the target's own five: `low`, `medium`, `high`, `xhigh` and
 * `max` — and a `findings` list of **at most thirty-two** findings. Each finding
 * carries a `file` (a repo-relative path), an optional one-based `line`, a
 * `summary` (one sentence), an optional `short_summary`, a `failure_scenario`
 * (concrete inputs to wrong output), an optional `category`, an optional
 * `verdict` (`CONFIRMED` or `PLAUSIBLE`) and an optional `outcome`. The target
 * answers with `{ count, level?, findings }`.
 *
 * **The tool is read-only and concurrency safe**, exactly as the target declares
 * it: it reports what the review found and it changes nothing.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, count, level?, findings }` — is
 *     an implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  readInputField,
  recheckToolPermissions,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The most findings one call may report. */
export const MAX_REPORT_FINDINGS = 32;

/** The effort levels the review may have run at. */
export const REPORT_FINDINGS_LEVELS: readonly string[] = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** One finding of a code review. */
export interface ReviewFinding {
  /** The repo-relative path of the file the finding is in. */
  file: string;
  /** The one-based line the finding anchors to. */
  line?: number;
  /** One-sentence statement of the defect. */
  summary: string;
  /** A compressed label for a compact UI. */
  short_summary?: string;
  /** Concrete inputs to wrong output or a crash. */
  failure_scenario: string;
  /** A short kebab-case slug of the finding type. */
  category?: string;
  /** Whether the finding was confirmed or is plausible. */
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
  /** What happened to the finding when it was re-reported after a fix. */
  outcome?: 'fixed' | 'skipped' | 'no_change_needed';
}

/** The input of the `ReportFindings` tool. */
export interface ReportFindingsInput {
  /** The effort level the review ran at. */
  level?: string;
  /** The findings, most severe first. */
  findings: ReviewFinding[];
}

/** The output of the `ReportFindings` tool. */
export interface ReportFindingsOutput {
  type: 'text';
  /** A short report of what was reported. */
  text: string;
  /** The number of findings reported. */
  count: number;
  /** The effort level the review ran at. */
  level?: string;
  /** The findings. */
  findings: ReviewFinding[];
}

/** The input schema of the `ReportFindings` tool. */
export const REPORTFINDINGS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    level: {
      type: 'string',
      enum: [...REPORT_FINDINGS_LEVELS],
      description: 'Effort level the review ran at',
    },
    findings: {
      type: 'array',
      maxItems: MAX_REPORT_FINDINGS,
      description: 'Verified findings, most-severe first; empty if none survived',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Repo-relative path of the file the finding is in' },
          line: { type: 'integer', description: '1-indexed line the finding anchors to' },
          summary: { type: 'string', description: 'One-sentence statement of the defect' },
          short_summary: {
            type: 'string',
            maxLength: 60,
            description: 'Compressed label for compact UI (≤60 chars)',
          },
          failure_scenario: {
            type: 'string',
            description: 'Concrete inputs/state → wrong output/crash',
          },
          category: {
            type: 'string',
            maxLength: 40,
            description: 'Short kebab-case slug of the finding type',
          },
          verdict: {
            type: 'string',
            enum: ['CONFIRMED', 'PLAUSIBLE'],
            description: 'Set when a verify pass ran',
          },
          outcome: {
            type: 'string',
            enum: ['fixed', 'skipped', 'no_change_needed'],
            description: 'Set when re-reporting after applying fixes',
          },
        },
        required: ['file', 'summary', 'failure_scenario'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

/**
 * Create the `ReportFindings` tool.
 */
export function createReportFindingsTool(
  deps: BuiltinToolDeps,
): ToolDefinition<ReportFindingsInput, ReportFindingsOutput> {
  return {
    name: 'ReportFindings',
    description: 'Report code-review findings as a structured list.',
    inputSchema: REPORTFINDINGS_INPUT_SCHEMA,
    mutatesFiles: false,

    isConcurrencySafe(): boolean {
      return true;
    },

    async checkPermissions(_input, ctx: ToolContext) {
      return checkToolPermissions(ctx, deps);
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, ['level', 'findings']);
      if (!fields.ok) return fields;
      const level = (input as { level?: unknown }).level;
      if (level !== undefined && level !== null) {
        if (typeof level !== 'string' || !REPORT_FINDINGS_LEVELS.includes(level)) {
          return {
            ok: false,
            message: `The 'level' argument must be one of ${REPORT_FINDINGS_LEVELS.join(', ')}.`,
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
      }
      const findings = (input as { findings?: unknown }).findings;
      if (findings === undefined || findings === null) {
        return {
          ok: false,
          message: "The 'findings' argument is required.",
          errorCode: TOOL_ERROR_CODES.missingField,
        };
      }
      if (!Array.isArray(findings)) {
        return {
          ok: false,
          message: "The 'findings' argument must be an array.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      if (findings.length > MAX_REPORT_FINDINGS) {
        return {
          ok: false,
          message: `The 'findings' argument may carry at most ${MAX_REPORT_FINDINGS} findings.`,
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      for (const finding of findings) {
        const checked = checkFinding(finding);
        if (!checked.ok) return checked;
      }
      return { ok: true };
    },

    async execute(input) {
      const findings = input.findings.map((finding) => ({ ...finding }));
      return {
        type: 'text' as const,
        text:
          findings.length === 0
            ? 'No findings reported.'
            : `${findings.length} finding${findings.length === 1 ? '' : 's'} reported.`,
        count: findings.length,
        ...(input.level === undefined ? {} : { level: input.level }),
        findings,
      };
    },
  };
}

/**
 * Check one finding.
 *
 * The finding is caller-supplied data, so every field is read as an **own**
 * property.
 */
function checkFinding(
  finding: unknown,
): { ok: true } | { ok: false; message: string; errorCode: number } {
  if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
    return {
      ok: false,
      message: 'Every finding must be an object.',
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  const fields = rejectUnknownFields(finding, [
    'file',
    'line',
    'summary',
    'short_summary',
    'failure_scenario',
    'category',
    'verdict',
    'outcome',
  ]);
  if (!fields.ok) return fields;
  for (const name of ['file', 'summary', 'failure_scenario'] as const) {
    const value = readInputField(finding, name);
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        message: `Every finding needs a non-empty '${name}'.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
  }
  return { ok: true };
}
