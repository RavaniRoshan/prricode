/**
 * The `AskUserQuestion` tool: ask the user a multiple-choice question.
 *
 * Evidence: the target's `AskUserQuestion` tool, read out of the pinned build
 * (`chunk-qtrk83ae.js:12762`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own bounds, reproduced.** The target's schema takes **one to
 * four** questions, each with **two to four** options, and the target's own
 * validation message says the bounds are "hard schema constraints". A question
 * with fewer than two options has no decision in it, so it is refused with the
 * target's own wording.
 *
 * **The target's own output shape, reproduced.** The target answers with
 * `{ questions, answers, response?, annotations?, afkTimeoutMs? }`, where
 * `answers` maps the question's text to the answer string, and a multi-select
 * answer is comma-separated.
 *
 * **The dialog is a capability.** The question is answered by the user, in the
 * session's own UI. The session supplies the dialog through
 * `capabilities.askUser`, and a session that supplies none gets a **typed
 * refusal** — the tool cannot answer its own question.
 *
 * **The call is concurrency safe** and **read-only**, as the target declares it:
 * the tool asks, and it asks nothing of the machine.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **output shape** — `{ type: 'text', text, questions, answers }` — is an
 *     implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns.
 */

import { TOOL_ERROR_CODES, ToolExecutionError, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  checkToolPermissions,
  readInputField,
  recheckToolPermissions,
  rejectUnknownFields,
  type BuiltinToolDeps,
} from './shared.js';
import type { UserAnswer, UserQuestion, UserQuestionOption } from './capabilities.js';

/** The most questions one call may ask. */
export const MAX_ASK_USER_QUESTIONS = 4;

/** The fewest options a choice question may carry. */
export const MIN_ASK_USER_OPTIONS = 2;

/** The most options a choice question may carry. */
export const MAX_ASK_USER_OPTIONS = 4;

/** One question of the `AskUserQuestion` tool. */
export interface AskUserQuestionEntry {
  /** The question itself. */
  question: string;
  /** The options the user may pick from. */
  options: UserQuestionOption[];
  /** Whether the user may answer more than one option. */
  multiSelect?: boolean;
  /** The header the question is shown under. */
  header?: string;
}

/** The input of the `AskUserQuestion` tool. */
export interface AskUserQuestionInput {
  /** The questions. */
  questions: AskUserQuestionEntry[];
}

/** The output of the `AskUserQuestion` tool. */
export interface AskUserQuestionOutput {
  type: 'text';
  /** A short report of what was asked. */
  text: string;
  /** The questions that were asked. */
  questions: AskUserQuestionEntry[];
  /** The answers, keyed by the question's text. */
  answers: Record<string, string>;
}

/** The input schema of the `AskUserQuestion` tool. */
export const ASKUSERQUESTION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ASK_USER_QUESTIONS,
      description:
        'The questions to ask the user, most important first. One to four questions, each with two to four options.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask.' },
          header: { type: 'string', description: 'The header the question is shown under.' },
          multiSelect: { type: 'boolean', description: 'Whether more than one option may be picked.' },
          options: {
            type: 'array',
            minItems: MIN_ASK_USER_OPTIONS,
            maxItems: MAX_ASK_USER_OPTIONS,
            description: 'The options the user may pick from.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The label of the option.' },
                description: { type: 'string', description: 'What the option means.' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

/**
 * The message the target refuses a single-option question with.
 *
 * The target's own wording, read out of the bundle.
 */
export const SINGLE_OPTION_QUESTION_MESSAGE =
  'This call included a question with fewer than 2 options, so it was rejected and the person never saw it. If that question is open-ended, re-ask it with no options; if there is really only one path, state it as the approach you are taking and continue with the task. Do not invent a filler second option.';

/**
 * Create the `AskUserQuestion` tool.
 */
export function createAskUserQuestionTool(
  deps: BuiltinToolDeps,
): ToolDefinition<AskUserQuestionInput, AskUserQuestionOutput> {
  return {
    name: 'AskUserQuestion',
    description: 'Prompt the user with a multiple-choice question.',
    inputSchema: ASKUSERQUESTION_INPUT_SCHEMA,
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
      const fields = rejectUnknownFields(input, ['questions']);
      if (!fields.ok) return fields;
      const questions = readInputField(input, 'questions');
      if (questions === undefined || questions === null) {
        return {
          ok: false,
          message: "The 'questions' argument is required.",
          errorCode: TOOL_ERROR_CODES.missingField,
        };
      }
      if (!Array.isArray(questions)) {
        return {
          ok: false,
          message: "The 'questions' argument must be an array.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      if (questions.length < 1 || questions.length > MAX_ASK_USER_QUESTIONS) {
        return {
          ok: false,
          message: `The 'questions' argument must carry between 1 and ${MAX_ASK_USER_QUESTIONS} questions.`,
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }

      for (const entry of questions) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return {
            ok: false,
            message: 'Every question must be an object.',
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        const questionFields = rejectUnknownFields(entry, [
          'question',
          'header',
          'multiSelect',
          'options',
        ]);
        if (!questionFields.ok) return questionFields;
        const text = readInputField(entry, 'question');
        if (typeof text !== 'string' || text.length === 0) {
          return {
            ok: false,
            message: "Every question needs a non-empty 'question'.",
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        const options = readInputField(entry, 'options');
        if (!Array.isArray(options)) {
          return {
            ok: false,
            message: "Every question needs an 'options' array.",
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        if (options.length < MIN_ASK_USER_OPTIONS || options.length > MAX_ASK_USER_OPTIONS) {
          // The target's own refusal, with its own wording.
          return {
            ok: false,
            message: SINGLE_OPTION_QUESTION_MESSAGE,
            errorCode: TOOL_ERROR_CODES.invalidInput,
          };
        }
        for (const option of options) {
          if (typeof option !== 'object' || option === null || Array.isArray(option)) {
            return {
              ok: false,
              message: 'Every option must be an object.',
              errorCode: TOOL_ERROR_CODES.invalidInput,
            };
          }
          const optionFields = rejectUnknownFields(option, ['label', 'description']);
          if (!optionFields.ok) return optionFields;
          const label = readInputField(option, 'label');
          if (typeof label !== 'string' || label.length === 0) {
            return {
              ok: false,
              message: "Every option needs a non-empty 'label'.",
              errorCode: TOOL_ERROR_CODES.invalidInput,
            };
          }
        }
      }
      return { ok: true };
    },

    async execute(input) {
      const askUser = deps.capabilities?.askUser;
      if (askUser === undefined) {
        throw new ToolExecutionError(
          "The 'AskUserQuestion' tool needs a dialog that can ask the user, which this session does not have, so the call was refused.",
          TOOL_ERROR_CODES.capabilityUnavailable,
        );
      }

      const answers: Record<string, string> = {};
      for (const entry of input.questions) {
        const question: UserQuestion = {
          question: entry.question,
          options: entry.options,
          ...(entry.multiSelect === undefined ? {} : { multiSelect: entry.multiSelect }),
          ...(entry.header === undefined ? {} : { header: entry.header }),
        };
        const answer: UserAnswer = await askUser(question);
        answers[entry.question] = answer.answer;
      }

      return {
        type: 'text' as const,
        text: `Asked ${input.questions.length} question${input.questions.length === 1 ? '' : 's'}.`,
        questions: input.questions,
        answers,
      };
    },
  };
}
