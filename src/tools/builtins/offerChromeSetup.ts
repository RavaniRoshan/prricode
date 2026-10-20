/**
 * The `OfferChromeSetup` tool: the one-time setup of the browser.
 *
 * Evidence: the target's own tool, read out of the pinned build — the name, the
 * search hint and the four result strings at `chunk-trdsqzmr.js:5983`
 * (`:6007`, `:6167`, `:6278`, `:6929`, `:7366`, `:7537`, `:7878`), and the tool
 * definition itself at `chunk-705mhzj8.js:25060` (the schemas at `:24797` and
 * `:24942`, the permission check at `:25881`, the call at `:25964`). The full
 * reading is `/home/shiva/opt/reference-agent-rea/analysis/findings-browser.md`.
 *
 * **What the target's tool does.** The target shows the user a **setup card**
 * and blocks until they answer. The answer is one of three outcomes:
 * `connected`, `not_now` or `no_attempt_yet`. The target calls the tool only
 * when a browser tool has just reported that the extension is not connected,
 * when the task genuinely needs a page the user is signed in to, and when the
 * offer has not been made before in that task.
 *
 * **There is no setup card here.** This implementation has no browser
 * extension, no extension account connection and no interactive setup surface,
 * so the tool **refuses** and names the capability it needs. The tool's name,
 * its description, its long prompt, its input schema and its four result
 * strings are the target's own, and they are reproduced — with the product's own
 * name replaced by `PRRICODE`.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **refusal** is this implementation's own. The target has a setup
 *     card, so the target never refuses; here the refusal is a typed
 *     `capabilityUnavailable` that names the capability the tool needed.
 *   - The **outcome vocabulary** is the target's own — `connected`, `not_now`
 *     and `no_attempt_yet` — and it is exported, but no outcome is ever
 *     produced here: the tool refuses before it can answer.
 *   - The **input schema** does not close its object, because the target's own
 *     schema is a loose object (`chunk-pcsjg1ve.js:1736`): an argument the
 *     schema does not name is accepted, exactly as the target accepts it.
 */

import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { ToolContext } from '../../permissions/decision.js';

import {
  capabilityRefusal,
  checkToolPermissions,
  recheckToolPermissions,
  type BuiltinToolDeps,
} from './shared.js';

/** The outcomes the target's setup tool can report. */
export type OfferChromeSetupOutcome = 'connected' | 'not_now' | 'no_attempt_yet';

/**
 * The input schema of the `OfferChromeSetup` tool.
 *
 * `chunk-705mhzj8.js:24797` — the target's own schema: one optional `reason`,
 * at most 200 characters.
 */
export const OFFER_CHROME_SETUP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      maxLength: 200,
      description: "A short phrase naming what the task needs the user's own browser for.",
    },
  },
  required: [],
} as const;

/** The output schema of the `OfferChromeSetup` tool. */
export const OFFER_CHROME_SETUP_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['connected', 'not_now', 'no_attempt_yet'],
    },
  },
  required: ['outcome'],
} as const;

/**
 * The target's own one-line description of the tool.
 *
 * `chunk-trdsqzmr.js:6167`.
 */
export const OFFER_CHROME_SETUP_DESCRIPTION =
  'Offer the user the one-time setup of PRRICODE in Chrome, so this task can use their own signed-in browser.';

/**
 * The target's own long prompt — the text the model is shown when the tool is
 * offered.
 *
 * `chunk-trdsqzmr.js:6278`.
 */
export const OFFER_CHROME_SETUP_PROMPT = `Offer the user the one-time setup of PRRICODE in Chrome so this task can use their own signed-in browser: their accounts, cookies and open tabs. The call shows the user a setup card and blocks until they respond.

Call it only when ALL of these hold: a PRRICODE in Chrome tool call in this task has just reported that the browser extension is not connected; the task genuinely needs a page the user is signed in to, or their existing tabs (for public pages use the built-in browser or web fetch instead); and you have not offered before in this task. Pass a short \`reason\` naming what the task needs their browser for.

The result is one of: connected (PRRICODE in Chrome is now connected: continue the task with the browser tools), or not_now (the user chose not to set it up now, or nobody could answer: carry on with the built-in browser or without a browser, and do not offer again in this task unless the user asks). Treat a rejected call the same way as not_now.`;

/**
 * The target's own search hint — the `whenToUse` of the tool.
 *
 * `chunk-trdsqzmr.js:6007`.
 */
export const OFFER_CHROME_SETUP_WHEN_TO_USE =
  'Offer the user PRRICODE in Chrome setup after a PRRICODE in Chrome tool reports the extension is not connected and the task needs their own signed-in browser';

/**
 * The message the target's own permission check asks with.
 *
 * `chunk-705mhzj8.js:25881`.
 */
export const OFFER_CHROME_SETUP_ASK_MESSAGE = 'Set up PRRICODE in Chrome?';

/**
 * The result text the target reports when the setup **succeeded**.
 *
 * `chunk-trdsqzmr.js:6929`.
 */
export const OFFER_CHROME_SETUP_CONNECTED_MESSAGE =
  'PRRICODE in Chrome is now connected. Continue the task with the browser tools.';

/**
 * The result text the target reports when the setup **did not happen**.
 *
 * `chunk-trdsqzmr.js:7366`.
 */
export const OFFER_CHROME_SETUP_NOT_NOW_MESSAGE =
  'PRRICODE in Chrome was not set up now. Carry on with the built-in browser or without a browser, and do not offer Chrome setup again in this task unless the user asks.';

/**
 * The result text the target reports when the user is on the mobile app, where
 * the setup cannot happen.
 *
 * `chunk-trdsqzmr.js:7537`.
 */
export const OFFER_CHROME_SETUP_MOBILE_MESSAGE =
  'The user is on the PRRICODE mobile app, where PRRICODE in Chrome cannot be set up, so no offer was shown. Carry on with the built-in browser or without a browser; you may tell the user that PRRICODE in Chrome can only be set up on a computer. Do not offer Chrome setup again in this task unless the user asks or says they are at a computer.';

/**
 * The message the target reports when no browser tool has been attempted yet.
 *
 * `chunk-trdsqzmr.js:7878`.
 */
export const OFFER_CHROME_SETUP_NO_ATTEMPT_MESSAGE =
  'Try a PRRICODE in Chrome tool first (for example tabs_context_mcp); offer setup only if it reports that the browser extension is not connected.';

/** The capability the setup tool needs: the interactive setup card. */
const SETUP_CAPABILITY = 'browser extension setup card';

/** The input of the `OfferChromeSetup` tool. */
export interface OfferChromeSetupInput {
  /** A short phrase naming what the task needs the user's own browser for. */
  reason?: string;
}

/**
 * Create the `OfferChromeSetup` tool.
 *
 * **It refuses.** There is no setup card behind it.
 */
export function createOfferChromeSetupTool(
  deps: BuiltinToolDeps,
): ToolDefinition<OfferChromeSetupInput, { outcome: OfferChromeSetupOutcome }> {
  return {
    name: 'OfferChromeSetup',
    description: OFFER_CHROME_SETUP_DESCRIPTION,
    inputSchema: OFFER_CHROME_SETUP_INPUT_SCHEMA,
    mutatesFiles: false,

    async checkPermissions(_input, ctx: ToolContext) {
      const decision = await checkToolPermissions(ctx, deps);
      // The target's own check is an **ask** with its own message; a deny rule
      // and an allow rule still speak first.
      if (decision.behavior !== 'ask') return decision;
      return {
        ...decision,
        reason: OFFER_CHROME_SETUP_ASK_MESSAGE,
        message: OFFER_CHROME_SETUP_ASK_MESSAGE,
      };
    },

    async recheckPermission(_input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, deps);
    },

    async validateInput(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
          ok: false,
          message: "The 'reason' argument must be a string.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      const record = input as Record<string, unknown>;
      if (!Object.hasOwn(record, 'reason') || record['reason'] === undefined) {
        return { ok: true };
      }
      const reason = record['reason'];
      if (typeof reason !== 'string') {
        return {
          ok: false,
          message: "The 'reason' argument must be a string.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      if (reason.length > 200) {
        return {
          ok: false,
          message: "The 'reason' argument must be at most 200 characters.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(_input, _ctx) {
      throw capabilityRefusal('OfferChromeSetup', SETUP_CAPABILITY);
    },
  };
}
