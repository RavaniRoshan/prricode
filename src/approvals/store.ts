/**
 * The store — **where the rules a human's approval produced are kept**.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7 — "Approvals are
 * rules […] so a matching rule decides without asking, and a rule persists."
 *
 * **One responsibility:** keeping a rule, and reading the rules that were kept.
 * The rule's **text** is the first layer's — the same syntax, the same
 * matcher — and the store holds nothing else: a list of rule texts per list.
 *
 * ## What is an implementation choice
 *
 *   - **The store is a seam, and a file is one implementation of it.** The
 *     decision point reads the rules through the seam, so a deployment may
 *     keep them wherever it keeps its configuration. The file implementation
 *     writes one JSON document and writes it **atomically** — a temporary file
 *     and a rename — so a reader never sees half a document.
 *   - **A store that cannot be read refuses the decision.** The rules are what
 *     the decision is made of, and a decision made of rules nobody can read is
 *     a decision made of nothing. The refusal names the file and the reason,
 *     and it is a refusal — not an approval that was never granted.
 *   - **A store that cannot be written does not undo the decision.** The human
 *     allowed the call, and the call is allowed; the rule that could not be
 *     written is reported, and the next time the call will be asked about
 *     again.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { approvalRules, type ApprovalRuleSet } from './rules.js';

/**
 * A failure of the approval layer.
 *
 * The `code` is stable and machine-readable, and the `reason` is a sentence
 * that names what was missing.
 */
export class ApprovalError extends Error {
  /** The stable, machine-readable code. */
  readonly code: string;
  /** The sentence that says what was missing. */
  readonly reason: string;

  constructor(code: string, reason: string) {
    super(reason);
    this.name = 'ApprovalError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Where the rules are kept.
 *
 * The store holds the rules a human's approval produced; the rules the user
 * wrote are the caller's own and are not the store's business.
 */
export interface ApprovalRuleStore {
  /** The rules the store holds. */
  read(): Promise<ApprovalRuleSet>;
  /** Keep the rules, so that they decide the next time. */
  persist(rules: readonly string[]): Promise<void>;
}

/** The document the file store keeps. */
interface ApprovalRuleDocument {
  allow?: unknown;
  ask?: unknown;
  deny?: unknown;
}

/** Where the persisted rules are attributed to. */
export const PERSISTED_RULE_SOURCE = 'persisted';

/**
 * A store that keeps the rules in memory.
 *
 * It is the store a deployment uses when the rules live in its own
 * configuration, and it is what a test uses when the file is not the point.
 */
export function createMemoryApprovalRuleStore(
  initial: { allow?: readonly string[]; ask?: readonly string[]; deny?: readonly string[] } = {},
): ApprovalRuleStore {
  const allow = [...(initial.allow ?? [])];
  const ask = [...(initial.ask ?? [])];
  const deny = [...(initial.deny ?? [])];

  return {
    async read(): Promise<ApprovalRuleSet> {
      return approvalRules({ allow, ask, deny, source: PERSISTED_RULE_SOURCE });
    },
    async persist(rules: readonly string[]): Promise<void> {
      for (const rule of rules) {
        if (!allow.includes(rule)) allow.push(rule);
      }
    },
  };
}

/**
 * A store that keeps the rules in a JSON document.
 *
 * The document is one object with the three lists. It is written **atomically**
 * — a temporary file in the same directory and a rename — so a reader never
 * sees a half-written document, and the write is refused with a reason when
 * the directory cannot hold it.
 */
export function createFileApprovalRuleStore(filePath: string): ApprovalRuleStore {
  const resolved = path.resolve(filePath);

  return {
    async read(): Promise<ApprovalRuleSet> {
      let text: string;
      try {
        text = readFileSync(resolved, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) {
          // Nothing has been persisted yet, and that is not a failure.
          return approvalRules({ source: PERSISTED_RULE_SOURCE });
        }
        throw new ApprovalError(
          'approval/rules-unreadable',
          `the approval rules in "${resolved}" could not be read: ${messageOf(error)}`,
        );
      }

      let document: ApprovalRuleDocument;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('the document is not an object');
        }
        document = parsed as ApprovalRuleDocument;
      } catch (error) {
        throw new ApprovalError(
          'approval/rules-unreadable',
          `the approval rules in "${resolved}" could not be read: ${messageOf(error)}`,
        );
      }

      return approvalRules({
        allow: readList(document.allow),
        ask: readList(document.ask),
        deny: readList(document.deny),
        source: PERSISTED_RULE_SOURCE,
      });
    },

    async persist(rules: readonly string[]): Promise<void> {
      if (rules.length === 0) return;

      const current = await this.read();
      const allow = [...current.allow];
      const ask = [...current.ask];
      const deny = [...current.deny];
      for (const rule of rules) {
        if (!allow.includes(rule)) allow.push(rule);
      }

      const document = { allow, ask, deny };
      const temporary = `${resolved}.${process.pid}.tmp`;
      try {
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
        renameSync(temporary, resolved);
      } catch (error) {
        throw new ApprovalError(
          'approval/rules-unwritable',
          `the approval rules could not be written to "${resolved}": ${messageOf(error)}`,
        );
      }
    },
  };
}

/** The rules of a list in the document, when it holds a list of strings. */
function readList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const rules: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    rules.push(entry);
  }
  return rules;
}

/** Whether an error says that the file is not there. */
function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT';
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'the error carried no message';
}
