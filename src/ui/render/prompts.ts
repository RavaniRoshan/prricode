/**
 * The approval-prompt renderer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this module is
 *
 * The prompt a user answers when a tool call needs approval. The **decision
 * layer** owns the vocabulary — the behavior, the source, the reason type and
 * the reason text (`src/permissions/decision.ts`) — and this module only lays
 * that decision out for the terminal. It is **pure**: it reads no clock, touches
 * no terminal and touches no filesystem.
 *
 * ## What the prompt shows
 *
 * The prompt names the **tool**, gives the **reason** the decision carries, and
 * offers the **choices**. The reason is the decision's own: `describeReason`
 * is the one place that turns a rule, a safety check or a sub-command
 * escalation into words, and the prompt does not paraphrase it.
 *
 * A decision that is **not** an ask has no prompt to answer: a denial is
 * reported as a denial and an approval as an approval. The function renders
 * whichever of the three it is given, so a caller cannot accidentally show a
 * prompt for a call that was already settled.
 *
 * ## The choices
 *
 * The target's prompt offers three answers: yes, yes-and-do-not-ask-again, and
 * no. This implementation offers the same three.
 *
 * The middle one does **not** promise a wider grant than the permission layer
 * gives: the layer persists **one rule per sub-command that needs approval**,
 * capped at five (`src/permissions/decision.ts`), so the label names **this**
 * call and not "every command of this tool". It is not Bash-specific either:
 * a `Write` is not a command.
 *
 * ## The numbering
 *
 * The prompt numbers its choices the way a terminal menu does, so the number a
 * user types is the number the prompt shows. The list of the choices is the
 * **only** place the numbering comes from: `choiceNumber` is the number of a
 * choice and `choiceForNumber` is its inverse, and the app binds the keys
 * through the latter.
 *
 * ## What is observed and what is a implementation choice
 *
 * The audit pins the permission **vocabulary** and says nothing about how the
 * prompt is drawn. The wording of the choices, the `❯` marker, the numbering
 * and the layout are therefore **implementation choices**, and they are marked as such
 * below. This implementation deliberately does **not** name a product in the third
 * choice: it is an independent implementation, and a prompt that told the user
 * to "tell the agent what to do" would be a false claim.
 */

import { describeReason, type PermissionDecision } from '../../permissions/decision.js';

import { stripControlSequences } from './markdown.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/** The answers a user can give to an approval prompt. */
export type ApprovalChoice = 'yes' | 'yes-always' | 'no';

/**
 * The choices, in the order the prompt lists them.
 *
 * The order is the prompt's own, and the **keys** the app binds are the
 * numbers next to them.
 */
export const APPROVAL_CHOICES: readonly ApprovalChoice[] = Object.freeze([
  'yes',
  'yes-always',
  'no',
]);

/**
 * The marker in front of the selected choice.
 *
 * **Implementation choice.**
 */
export const CHOICE_MARKER = '❯';

/**
 * The number of a choice, counted from one.
 *
 * The prompt numbers its choices the way a terminal menu does, so the number a
 * user types is the number the prompt shows.
 */
export function choiceNumber(choice: ApprovalChoice): number {
  const index = APPROVAL_CHOICES.indexOf(choice);
  return index < 0 ? 1 : index + 1;
}

/**
 * The choice a number names.
 *
 * The inverse of `choiceNumber`, and the only way a typed digit becomes a
 * choice: the list is closed, so a digit outside it names nothing.
 */
export function choiceForNumber(number: number): ApprovalChoice | undefined {
  if (!Number.isInteger(number)) return undefined;
  if (number < 1 || number > APPROVAL_CHOICES.length) return undefined;
  return APPROVAL_CHOICES[number - 1];
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One choice of the prompt, as the prompt shows it.
 */
export interface ApprovalChoiceView {
  /** The number the user types to pick it. */
  readonly number: number;
  /** The choice's label. */
  readonly label: string;
  /** The marker in front of the selected choice. */
  readonly marker: string;
}

/**
 * The pieces of an approval prompt.
 */
export interface ApprovalPromptParts {
  /** The question, above the reason. */
  readonly question: string;
  /** The reason the decision carries. */
  readonly reason: string;
  /** The choices, in the order the prompt lists them; empty for a settled decision. */
  readonly choices: readonly ApprovalChoiceView[];
}

/**
 * The reason a decision carries.
 *
 * A decision that already has a reason keeps it; one that does not gets the
 * reason the decision layer derives from its vocabulary.
 */
function reasonOf(decision: PermissionDecision, toolName: string): string {
  const reason = decision.reason;
  if (reason !== undefined && reason !== '') return reason;
  return describeReason(decision, toolName);
}

/**
 * The choice labels.
 *
 * **Implementation choice.** The wording is this implementation's own; the audit records no
 * prompt text.
 */
function choiceLabels(toolName: string): readonly string[] {
  const name = toolName === '' ? 'tool' : toolName;
  return [
    'Yes',
    `Yes, and don't ask again for this ${name} call`,
    'No, and tell the assistant what to do differently',
  ];
}

/**
 * The choices, as the prompt shows them.
 *
 * **Implementation choice.** The wording is this implementation's own; the audit records no
 * prompt text.
 */
export function approvalChoices(toolName: string): readonly ApprovalChoiceView[] {
  const name = stripControlSequences(toolName);
  const labels = choiceLabels(name);
  return APPROVAL_CHOICES.map((choice, index) => ({
    number: choiceNumber(choice),
    label: labels[index] ?? '',
    marker: index === 0 ? CHOICE_MARKER : ' ',
  }));
}

/**
 * The pieces of the prompt a decision gets.
 *
 * The tool's name and the reason are **stripped** of their control sequences:
 * both reach the terminal, and the name is caller-supplied.
 */
export function approvalPromptParts(
  decision: PermissionDecision,
  toolName: string,
): ApprovalPromptParts {
  const name = stripControlSequences(toolName);
  const shown = name === '' ? 'The tool' : name;
  const reason = stripControlSequences(reasonOf(decision, shown));

  if (decision.behavior === 'deny') {
    return { question: `${shown} was denied.`, reason, choices: [] };
  }

  if (decision.behavior === 'allow') {
    return { question: `${shown} was allowed.`, reason, choices: [] };
  }

  return {
    question: `${shown} needs your approval.`,
    reason,
    choices: approvalChoices(name),
  };
}

/**
 * Render the approval prompt.
 *
 * The function is **pure**: it reads no clock, touches no terminal and touches
 * no filesystem.
 *
 * An **ask** is rendered as the prompt the user answers. A **deny** is rendered
 * as the refusal it is, and an **allow** as the approval it is — neither has a
 * question to answer, and showing one would ask the user about a call that is
 * already settled.
 */
export function renderApprovalPrompt(decision: PermissionDecision, toolName: string): string {
  const parts = approvalPromptParts(decision, toolName);

  if (parts.choices.length === 0) {
    return [parts.question, '', parts.reason].join('\n');
  }

  const lines = [parts.question, '', parts.reason, ''];
  for (const choice of parts.choices) {
    lines.push(`${choice.marker} ${choice.number}. ${choice.label}`);
  }
  return lines.join('\n');
}
