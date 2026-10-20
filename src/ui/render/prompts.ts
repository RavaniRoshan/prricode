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
 * no. This implementation offers the same three, and the middle one names the **tool**:
 * the "don't ask again" affordance persists a rule per call that needs
 * approval, and computing that rule — and capping it at five — is the
 * **permission layer's** job (`src/permissions/decision.ts`), not this
 * module's. The prompt only says which tool the answer is about.
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

/* -------------------------------------------------------------------------- */
/* The prompt                                                                  */
/* -------------------------------------------------------------------------- */

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
function choiceLabels(toolName: string): string[] {
  return [
    'Yes',
    `Yes, and don't ask again for ${toolName} commands`,
    'No, and tell the assistant what to do differently',
  ];
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
  const name = toolName === '' ? 'The tool' : toolName;
  const reason = reasonOf(decision, name);

  if (decision.behavior === 'deny') {
    return [`${name} was denied.`, '', reason].join('\n');
  }

  if (decision.behavior === 'allow') {
    return [`${name} was allowed.`, '', reason].join('\n');
  }

  const labels = choiceLabels(name);
  const lines = [`${name} wants to run this command.`, '', reason, ''];
  labels.forEach((label, index) => {
    const number = index + 1;
    const marker = index === 0 ? CHOICE_MARKER : ' ';
    lines.push(`${marker} ${number}. ${label}`);
  });
  return lines.join('\n');
}
