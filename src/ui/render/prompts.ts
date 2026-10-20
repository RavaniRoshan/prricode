/**
 * The approval-prompt renderer.
 *
 * Evidence: the `CC-022` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and the specification it names —
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-terminal-ui.md` §4
 * ("The approval prompt").
 *
 * ## What this module is
 *
 * The prompt a user answers when a tool call needs approval. The **decision
 * layer** owns the vocabulary — the behavior, the source, the reason type and
 * the reason text (`src/permissions/decision.ts`) — and this module only lays
 * that decision out for the terminal. It is **pure**: it reads no clock, touches
 * no terminal and touches no filesystem.
 *
 * ## The dialog is the target's dialog
 *
 * The target's dialog (§4.1 – §4.5):
 *
 *   - a **title**, bold, in the `permission` colour — `Read file` or
 *     `Edit file` for a file tool, `Bash command` for a command;
 *   - the **question**: `Do you want to proceed?`;
 *   - the **options**, with no numbers at all: a focused row shows `❯` in the
 *     `suggestion` colour and a selected row shows `✔` in the `success`
 *     colour, and every other row is dimmed;
 *   - the **input guide**, dim and italic: `enter to confirm · esc to cancel`.
 *
 * The frame itself — a rule in the `permission` colour above a column with
 * two columns of padding — is drawn by the app, because it is chrome and not
 * text.
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
 * **Implementation choice.** The target's own labels for the persistent option
 * are per-tool templates (`Yes, and don't ask again for <tool> commands in
 * <scope>`, `Yes, and allow reading from <paths> from this project`, …) and
 * the specification did not establish which template applies to which case —
 * so the clone keeps its own wording for that one option, and reproduces the
 * target's wording for the other two.
 *
 * ## The focus
 *
 * The target's confirmation context moves the focus with the arrow keys and
 * confirms with `enter` (`chunk-26sqdasq.js:2660`). The prompt therefore
 * carries a **focused** option, and the option the pointer is on is the one
 * `enter` confirms.
 */

import { describeReason, type PermissionDecision } from '../../permissions/decision.js';
import type { Segment } from '../theme.js';

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
 * **focus** the prompt moves.
 */
export const APPROVAL_CHOICES: readonly ApprovalChoice[] = Object.freeze([
  'yes',
  'yes-always',
  'no',
]);

/**
 * The marker in front of the focused choice.
 *
 * The target's `te.pointer` (`❯`, or `>` on the plain Linux terminal).
 */
export const CHOICE_MARKER = '❯';

/**
 * The marker in front of the selected choice.
 *
 * The target's `te.tick` (`✔`, or `√` on the plain Linux terminal).
 */
export const CHOICE_TICK = '✔';

/**
 * The question the target asks.
 *
 * The target's `chunk-7h94ekrj.js:25258`: `Do you want to proceed?`.
 */
export const APPROVAL_QUESTION = 'Do you want to proceed?';

/**
 * The input guide under the dialog.
 *
 * The target's default guide (`chunk-bmrbft56.js:6418`): `enter to confirm ·
 * esc to cancel`.
 */
export const APPROVAL_GUIDE = 'enter to confirm · esc to cancel';

/**
 * The number of a choice, counted from one.
 *
 * The target's options list carries **no numbers** (§4.3), so the number is
 * this implementation's own: it is the position of the choice in the closed
 * list, and `choiceForNumber` is its inverse.
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
  /** The choice this option answers with. */
  readonly value: ApprovalChoice;
  /** The choice's label. */
  readonly label: string;
  /**
   * The label's tail, which the target draws in **bold**.
   *
   * The target's third option ends with a bold `(esc)`
   * (`chunk-6bp7hdav.js:1151238`).
   */
  readonly suffix?: string | undefined;
  /** Whether the focus is on this option. */
  readonly focused: boolean;
  /** Whether this option is the selected one. */
  readonly selected: boolean;
}

/**
 * The pieces of an approval prompt.
 */
export interface ApprovalPromptParts {
  /** The title, above the question. */
  readonly title: string;
  /** The question. */
  readonly question: string;
  /** The reason the decision carries. */
  readonly reason: string;
  /** The choices, in the order the prompt lists them; empty for a settled decision. */
  readonly choices: readonly ApprovalChoiceView[];
  /** The input guide under the dialog. */
  readonly guide: string;
}

/**
 * The title of the dialog.
 *
 * The target's titles (§4.2): `Read file` for a read, `Edit file` for an
 * edit, and `Bash command` for a command.
 *
 * **Implementation choice.** The target's title for a tool that is neither a
 * file tool nor a command was not established, so the clone shows the tool's
 * own name.
 */
export function approvalTitle(toolName: string): string {
  const name = stripControlSequences(toolName);
  switch (name) {
    case 'Read':
      return 'Read file';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'Edit file';
    case 'Bash':
      return 'Bash command';
    default:
      return name === '' ? 'Tool' : name;
  }
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
 * `Yes` and `No, and tell Claude what to do differently (esc)` are the
 * target's own (§4.3).
 *
 * **Implementation choice.** The label of the persistent option is this
 * implementation's own: the target's own label is a per-tool template and the
 * specification did not establish which template applies to which case.
 */
function choiceLabels(toolName: string): readonly { label: string; suffix?: string }[] {
  const name = toolName === '' ? 'tool' : toolName;
  return [
    { label: 'Yes' },
    { label: `Yes, and don't ask again for this ${name} call` },
    { label: 'No, and tell Claude what to do differently', suffix: '(esc)' },
  ];
}

/**
 * The choices, as the prompt shows them.
 *
 * The tool's name is **stripped** here as well: the prompt strips the name
 * before it hands it over, so the choices have to strip it **themselves** to
 * be safe on their own. The hostile input the contract test uses is the
 * **OSC** form and not only the CSI one, because a scanner that knows only
 * the CSI form handles a CSI-only input exactly as well as the shared
 * scanner does.
 *
 * @param focused the index of the focused option; the first one by default.
 */
export function approvalChoices(
  toolName: string,
  focused = 0,
  selected = focused,
): readonly ApprovalChoiceView[] {
  const name = stripControlSequences(toolName);
  const labels = choiceLabels(name);
  return APPROVAL_CHOICES.map((choice, index) => {
    const text = labels[index];
    return {
      value: choice,
      label: text?.label ?? '',
      suffix: text?.suffix,
      focused: index === focused,
      selected: index === selected,
    };
  });
}

/**
 * The option's segments, as the target draws them.
 *
 * The target's option row (§4.3): the **pointer** in the `suggestion` colour
 * in front of the focused row — dimmed in front of the others — the label,
 * and the **tick** in the `success` colour behind the selected row.
 */
export function optionSegments(choice: ApprovalChoiceView): Segment[] {
  const label = choice.suffix === undefined ? choice.label : `${choice.label} ${choice.suffix}`;
  const segments: Segment[] = [
    {
      text: choice.focused ? CHOICE_MARKER : ' ',
      role: choice.focused ? 'suggestion' : undefined,
      // The target dims the pointer of a row that does not have the focus.
      dim: !choice.focused,
    },
    { text: ' ' },
    { text: label },
  ];
  if (choice.selected) {
    segments.push({ text: ' ' });
    segments.push({ text: CHOICE_TICK, role: 'success', ariaLabel: '(selected)' });
  }
  return segments;
}

/**
 * The pieces of the prompt a decision gets.
 *
 * The tool's name and the reason are **stripped** of their control sequences:
 * both reach the terminal, and the name is caller-supplied. The hostile
 * input the contract test uses is the **OSC** form and not only the CSI
 * one, because a scanner that knows only the CSI form handles a CSI-only
 * input exactly as well as the shared scanner does — and Ink's own sanitiser
 * **preserves** the OSC form.
 */
export function approvalPromptParts(
  decision: PermissionDecision,
  toolName: string,
  focused = 0,
): ApprovalPromptParts {
  const name = stripControlSequences(toolName);
  const shown = name === '' ? 'The tool' : name;
  const reason = stripControlSequences(reasonOf(decision, shown));
  const title = approvalTitle(name);

  if (decision.behavior === 'deny') {
    return { title, question: `${shown} was denied.`, reason, choices: [], guide: APPROVAL_GUIDE };
  }

  if (decision.behavior === 'allow') {
    return { title, question: `${shown} was allowed.`, reason, choices: [], guide: APPROVAL_GUIDE };
  }

  return {
    title,
    question: APPROVAL_QUESTION,
    reason,
    choices: approvalChoices(name, focused),
    guide: APPROVAL_GUIDE,
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
export function renderApprovalPrompt(
  decision: PermissionDecision,
  toolName: string,
  focused = 0,
): string {
  const parts = approvalPromptParts(decision, toolName, focused);

  if (parts.choices.length === 0) {
    return [parts.title, parts.question, '', parts.reason].join('\n');
  }

  const lines = [parts.title, parts.question, '', parts.reason, ''];
  for (const choice of parts.choices) {
    const marker = choice.focused ? CHOICE_MARKER : ' ';
    const tick = choice.selected ? CHOICE_TICK : '';
    const label = choice.suffix === undefined ? choice.label : `${choice.label} ${choice.suffix}`;
    lines.push(`${marker} ${label}${tick === '' ? '' : ` ${tick}`}`);
  }
  lines.push('');
  lines.push(parts.guide);
  return lines.join('\n');
}
