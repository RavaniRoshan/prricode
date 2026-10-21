/**
 * The slash-command registry.
 *
 * Evidence: the `CC-030` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and the record it names —
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-untouched-surfaces.md`
 * §G2 and §3.3 ("The slash-command registry") — together with
 * `findings-terminal-ui.md` §11 ("The slash commands") for the argument hints
 * and for the composer's `/`-overlay.
 *
 * ## What this module is
 *
 * The target's **in-session command registry**: the list of the commands a
 * user types as `/name` inside a session. The target registers the commands in
 * one contiguous region of `chunk-4jsg44k7.js`, and every entry carries a
 * **name**, a **description**, an **argument hint**, a list of **aliases**, a
 * **type** (`local` | `local-jsx` | `prompt`) and the place the target puts it.
 *
 * This module holds that registry, the lookups over it, and the dispatch that
 * runs a command the user typed.
 *
 * ## The target's data is reproduced; the target's name is not
 *
 * Every name, description, alias, argument hint and offset below is the
 * target's own. The one thing that is **not** the target's is the target's
 * *product name*: where the target's own text names its product, this
 * implementation says **PRRICODE**. The target's *environment variables*,
 * *model ids*, *API hosts* and *file names* keep the target's names, because
 * those are the data the implementation has to speak to.
 *
 * ## The commands this implementation has, and the ones it does not
 *
 * The target registers far more commands than this implementation can run, and
 * a command that pretends to run is worse than one that refuses. So the
 * registry is **complete** — every command the target registers is here, with
 * the target's own data — and the **dispatch** splits the commands into three:
 *
 *   - the ones this implementation **runs** (the reports, the session
 *     commands, and the two manager commands this implementation owns);
 *   - the ones this implementation **refuses**, each with a refusal that names
 *     the capability it needs and does not have;
 *   - the ones whose **name the target computes** (a plugin command, an
 *     enterprise command, a prompt the MCP server contributes), which are
 *     recorded as templates rather than as commands.
 *
 * ## The numbers
 *
 * The record counts "122 command objects, 92 distinct command names". Reading
 * the same bundle with a parser rather than with a pattern finds **123 command
 * definitions** — 118 of type `local`/`local-jsx` and 5 of type `prompt` — with
 * **100 distinct names**. The difference is the record's own extraction: it
 * missed the six definitions whose `type` field is the **last** member of the
 * object literal (`ultraplan`, `ultrareview`, `passes`, `sandbox`, `chrome` and
 * the `vim` stub `qYt` generates), and it excluded the `prompt`-type commands.
 * The reconciliation is written down in
 * `docs/compatibility/command-surface.md`.
 */

import { loadSettings } from '../../config/loader.js';
import {
  allOutputStyles,
  currentOutputStyle,
  isOutputStyleQueryWord,
  isRemoteOrRelayedSession,
  outputStyleSelection,
  writeOutputStyleSetting,
} from '../../config/outputStyles.js';
import { mergeMergedSettings } from '../../config/tiers.js';
import { createSkillRegistry } from '../../extensions/skills/registry.js';
import { RESTRICT_PERSONAL_CONFIG_ENV } from '../../permissions/decision.js';
import { builtinCatalog, findModel, listModels } from '../../provider/catalog.js';
import type { ProviderRegistry } from '../../provider/registry.js';
import { REWIND_MISSING_CAPABILITY } from '../../session/checkpoints.js';
import type { SessionEvent } from '../../session/event.js';
import { resolveSessionTarget, type SessionStore } from '../../session/store.js';

import {
  managerArgumentsOf,
  providerManagerCommand,
  type LoadedManagerState,
  type ManagerCommandOptions,
} from './manager.js';
import { errorMessageOf, failure, PROVIDER_EXTENSION_LABEL, renderTable, usageError, type CommandResult } from './shared.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of command the target's registry holds.
 *
 * **Observed** (`chunk-4jsg44k7.js`, the registry region). A `local` command
 * runs in the process, a `local-jsx` command renders a component of the
 * terminal UI, and a `prompt` command expands into a prompt for the model.
 */
export type SlashCommandType = 'local' | 'local-jsx' | 'prompt';

/**
 * One command of the registry.
 *
 * The **offset** is the byte offset of the command's definition in the
 * target's own source file, so every row of the registry can be checked
 * against the bundle. It is absent for the commands this implementation owns:
 * the target has no such commands.
 */
export interface SlashCommand {
  /** The name the user types, without the leading slash. */
  readonly name: string;
  /** The kind of command the target registers it as. */
  readonly type: SlashCommandType;
  /** The description the target's menu shows. */
  readonly description: string;
  /** The other names the command answers to. */
  readonly aliases: readonly string[];
  /** The hint the target's menu shows for the command's argument. */
  readonly argumentHint?: string;
  /** Where the target puts the command, in the target's own source. */
  readonly offset?: number;
  /** Whether the target hides the command from its menu. */
  readonly hidden: boolean;
  /**
   * Whether the command is this implementation's own.
   *
   * The target registers **no** provider manager and **no** catalog browser,
   * so `/provider` and `/catalog` are a **project extension** — and they say
   * so, everywhere they surface.
   */
  readonly extension: boolean;
  /**
   * The message the UI shows while a **prompt** command's prompt is built.
   *
   * The target's own value, for the target's own prompt commands.
   */
  readonly progressMessage?: string;
  /** The length of the prompt's content. */
  readonly contentLength?: number;
  /** Where the command came from. */
  readonly source?: PromptCommandSource;
  /** Whether the model may invoke the command on its own. */
  readonly disableModelInvocation?: boolean;
  /** The name the UI shows, when it differs from the command's name. */
  readonly userFacingName?: string;
  /** The policy the command is gated on, when it is gated on one. */
  readonly policyGate?: { readonly policy: string };
  /** What the command needs of the session. */
  readonly requires?: { readonly workspace?: boolean };
}

/**
 * Where a **prompt** command came from.
 *
 * The target's own vocabulary (`chunk-4jsg44k7.js:2207432`).
 */
export type PromptCommandSource = 'builtin' | 'plugin' | 'mcp' | 'memoryStore' | 'bundled';

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The shape the target's own table is written in.
 *
 * The table is the **data**, and it is kept in the target's own shape so that
 * a row can be compared with the bundle without a translation step. The
 * members the target leaves out are optional here for the same reason.
 */
interface TargetCommandDefinition {
  readonly name: string;
  readonly type: SlashCommandType;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly argumentHint?: string;
  readonly offset: number;
  readonly hidden?: boolean;
  readonly progressMessage?: string;
  readonly contentLength?: number;
  readonly source?: PromptCommandSource;
  readonly disableModelInvocation?: boolean;
  readonly userFacingName?: string;
  readonly policyGate?: { readonly policy: string };
  readonly requires?: { readonly workspace?: boolean };
}

/**
 * The target's registry, one entry per **definition**.
 *
 * The target registers a command more than once when it has two forms — a
 * `local` one and a `local-jsx` one — and the two carry different
 * descriptions. Every definition is kept, so the registry says what the
 * target says.
 *
 * The rows are in the target's own order: the order of the bundle.
 */
const TARGET_DEFINITIONS: readonly TargetCommandDefinition[] = [
  { name: 'add-dir', type: 'local', description: 'Add a new working directory', argumentHint: '<path>', offset: 1532071 },
  { name: 'add-dir', type: 'local-jsx', description: 'Add a new working directory', argumentHint: '<path>', offset: 1532319 },
  { name: 'cloud-plugins', type: 'local-jsx', description: 'Choose whether cloud sessions use the plugins enabled on this machine', offset: 1532508 },
  { name: 'auto-mode-setup', type: 'local', description: 'Teach auto mode about your environment, plus optional rule tweaks', argumentHint: '[--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose | --expect-sha256 <64-hex> --apply-file <path>)', offset: 1672692 },
  { name: 'auto-mode-setup', type: 'local-jsx', description: 'Teach auto mode about your environment, plus optional rule tweaks', offset: 1673079 },
  { name: 'artifacts', type: 'local-jsx', description: 'Browse your published and shared artifacts', offset: 1673275 },
  { name: 'autofix-pr', type: 'local-jsx', description: 'Monitor and autofix any issues with the current PR', offset: 1673587 },
  { name: 'btw', type: 'local-jsx', description: 'Ask a quick side question without interrupting the main conversation', argumentHint: '[question]', offset: 1673882 },
  { name: 'feedback', type: 'local-jsx', description: 'Send feedback to Anthropic or report a bug', argumentHint: '[report]', offset: 1674161 },
  { name: 'bug', type: 'local-jsx', description: 'Report a bug or share your conversation', aliases: ['share'], argumentHint: '[report]', offset: 1674324 },
  { name: 'cd', type: 'local-jsx', description: 'Move this session to a new working directory', argumentHint: '<path>', offset: 1674497 },
  { name: 'clear', type: 'local', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', aliases: ['reset', 'new'], argumentHint: '[name]', offset: 1674623 },
  { name: 'color', type: 'local-jsx', description: 'Set the prompt bar color for this session', argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]', offset: 1674919 },
  { name: 'color', type: 'local', description: 'Set the prompt bar color for this session', argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]', offset: 1675197 },
  { name: 'copy', type: 'local-jsx', description: "Copy PRRICODE's last response to clipboard (or /copy N for the Nth-latest)", offset: 1675477 },
  { name: 'desktop', type: 'local-jsx', description: 'Continue the current session in PRRICODE Desktop', aliases: ['app'], offset: 1675688 },
  {
    name: 'commit-push-pr',
    type: 'prompt',
    description: 'Commit, push, and open a PR',
    offset: 1680337,
    progressMessage: 'creating commit and PR',
    contentLength: 0,
    source: 'builtin',
    disableModelInvocation: false,
    userFacingName: 'commit-push-pr',
  },
  { name: 'compact', type: 'local', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', offset: 1680970 },
  { name: 'autocompact', type: 'local-jsx', description: 'Set how full the context gets before auto-summarizing', argumentHint: '[auto|<tokens>]', offset: 1681288 },
  { name: 'autocompact', type: 'local', description: 'Configure the auto-compact window size', argumentHint: '[auto|<tokens>]', offset: 1681512 },
  { name: 'config', type: 'local-jsx', description: 'Open settings', aliases: ['settings'], argumentHint: '[key=value]', offset: 1681838 },
  { name: 'config', type: 'local', description: 'Set a setting by key', aliases: ['settings'], argumentHint: 'key=value', offset: 1682125 },
  { name: 'vim', type: 'local-jsx', description: 'Editor mode moved to /config', offset: 1682590, hidden: true },
  { name: 'output-style', type: 'local-jsx', description: 'Output style moved to /config', offset: 1682619, hidden: true },
  { name: 'output-style', type: 'local', description: 'List output styles or switch to one', argumentHint: '[style]', offset: 1682677 },
  { name: 'context', type: 'local-jsx', description: 'Visualize current context usage as a colored grid', argumentHint: '[all]', offset: 1682944 },
  { name: 'context', type: 'local', description: 'Show current context usage', offset: 1683132 },
  { name: 'diff', type: 'local-jsx', description: 'View uncommitted changes and per-turn diffs', offset: 1683329 },
  { name: 'memory', type: 'local-jsx', description: 'Edit CLAUDE.md files and memory settings', offset: 1683636 },
  { name: 'pause-memory', type: 'local', description: 'Pause account memory and local auto-memory for this session (run again to turn both back on)', aliases: ['memory-pause', 'toggle-memory'], offset: 1683783 },
  { name: 'help', type: 'local-jsx', description: 'Show help and available commands', offset: 1684242 },
  { name: 'ide', type: 'local-jsx', description: 'Manage IDE integrations and show status', argumentHint: '[open]', offset: 1684388 },
  { name: 'import', type: 'local-jsx', description: 'Import config from another AI coding agent', argumentHint: '[codex|gemini|cursor] [--dry-run]', offset: 1685427 },
  { name: 'import', type: 'local', description: 'Import config from another AI coding agent', offset: 1685626 },
  {
    name: 'init',
    type: 'prompt',
    description: 'Initialize a new CLAUDE.md file with codebase documentation',
    offset: 1710438,
    progressMessage: 'analyzing your codebase',
    contentLength: 0,
    source: 'builtin',
    disableModelInvocation: false,
    userFacingName: 'init',
  },
  { name: 'keybindings', type: 'local', description: 'Open your keyboard shortcuts file', offset: 1710831 },
  { name: 'design-consent', type: 'local', description: 'Grant PRRICODE agent access to your Design projects', offset: 1711037 },
  { name: 'design-revoke', type: 'local', description: 'Revoke PRRICODE agent access to your Design projects', offset: 1711253 },
  { name: 'design-login', type: 'local-jsx', description: 'Authorize design-system access for /design-sync with your claude.ai account', offset: 1711478 },
  { name: 'login', type: 'local-jsx', description: 'Sign in with your Anthropic account', offset: 1711655 },
  { name: 'logout', type: 'local-jsx', description: 'Sign out from your Anthropic account', offset: 1711869 },
  { name: 'install-github-app', type: 'local-jsx', description: 'Set up PRRICODE GitHub Actions for a repository', offset: 1712098 },
  { name: 'install-slack-app', type: 'local', description: 'Install the PRRICODE Slack app', offset: 1712308 },
  { name: 'mcp', type: 'local', description: 'Manage MCP servers', argumentHint: '[reconnect|enable|disable [<server>|all]]', offset: 1712550 },
  { name: 'mcp', type: 'local-jsx', description: 'Manage MCP servers', argumentHint: '[reconnect (<server>|all)|enable|disable [<server>|all]]', offset: 1712813 },
  { name: 'mobile', type: 'local-jsx', description: 'Show QR code to download the PRRICODE mobile app', aliases: ['ios', 'android'], offset: 1713003 },
  { name: 'voice', type: 'local', description: 'Toggle voice mode', argumentHint: '[hold|tap|off]', offset: 1713208 },
  { name: 'powerup', type: 'local-jsx', description: 'Discover PRRICODE features through quick interactive lessons', offset: 1713435 },
  { name: 'release-notes', type: 'local-jsx', description: 'View release notes', offset: 1713573 },
  { name: 'rename', type: 'local-jsx', description: 'Rename the current conversation', aliases: ['name'], argumentHint: '[name]', offset: 1713680 },
  { name: 'rename', type: 'local', description: 'Rename the current conversation', aliases: ['name'], argumentHint: '[name]', offset: 1713872 },
  { name: 'resume', type: 'local-jsx', description: 'Resume a previous conversation', aliases: ['continue'], argumentHint: '[conversation id or search term]', offset: 1714138 },
  { name: 'setup-bedrock', type: 'local-jsx', description: 'Reconfigure Amazon Bedrock authentication, region, or model pins', offset: 1714460 },
  { name: 'setup-vertex', type: 'local-jsx', description: 'Reconfigure Google Vertex AI authentication, project, region, or model pins', offset: 1714674 },
  { name: 'ultrareview', type: 'local-jsx', description: 'Start a cloud agent that finds and verifies bugs in your branch', offset: 1715113 },
  { name: 'ultrareview', type: 'local', description: 'Start a cloud agent that finds and verifies bugs in your branch', offset: 1715206 },
  { name: 'session', type: 'local-jsx', description: 'Show cloud session URL and QR code', aliases: ['remote'], offset: 1715398 },
  { name: 'scroll-speed', type: 'local-jsx', description: 'Adjust mouse wheel scroll speed', offset: 1715691 },
  { name: 'skills', type: 'local-jsx', description: 'List available skills', offset: 1715905 },
  { name: 'status', type: 'local-jsx', description: 'Show PRRICODE status including version, model, account, API connectivity, and tool statuses', offset: 1716040 },
  { name: 'tasks', type: 'local-jsx', description: 'View and manage everything running in the background', aliases: ['bashes'], offset: 1716229 },
  {
    name: 'team-onboarding',
    type: 'prompt',
    description: 'Help teammates ramp on PRRICODE with a guide from your usage',
    offset: 1728733,
    progressMessage: 'scanning usage data',
    contentLength: 0,
    source: 'builtin',
    disableModelInvocation: true,
    userFacingName: 'team-onboarding',
    policyGate: { policy: 'allow_team_onboarding' },
    requires: { workspace: true },
  },
  { name: 'teleport', type: 'local-jsx', description: 'Send this session to the cloud, or resume one from claude.ai', aliases: ['tp'], offset: 1729848 },
  { name: 'terminal-setup', type: 'local-jsx', description: 'Check terminal setup (Shift+Enter is natively supported in <Terminal>)', offset: 1750833 },
  { name: 'ultraplan', type: 'local-jsx', description: 'Draft an editable plan in a cloud session', argumentHint: '<prompt>', offset: 2176592 },
  { name: 'usage', type: 'local-jsx', description: 'Show session cost, plan usage, and activity stats', aliases: ['cost', 'stats'], argumentHint: undefined, offset: 2176852 },
  { name: 'usage', type: 'local', description: "Show session cost, plan usage, and what's contributing to your limits", aliases: ['cost', 'stats'], offset: 2177045 },
  { name: 'skill-doctor', type: 'local-jsx', description: 'Show which loaded skills are unused and costing context', offset: 2177353 },
  { name: 'skill-doctor', type: 'local', description: 'Show which loaded skills are unused and costing context', offset: 2177505 },
  { name: 'theme', type: 'local-jsx', description: 'Change the theme', offset: 2177761 },
  { name: 'tui', type: 'local-jsx', description: 'Set the terminal UI renderer (default | fullscreen)', argumentHint: '[default|fullscreen]', offset: 2177892 },
  { name: 'permissions', type: 'local-jsx', description: 'Manage allow and deny tool permission rules', aliases: ['allowed-tools'], offset: 2178040 },
  { name: 'plan', type: 'local-jsx', description: 'Enable plan mode or view the current session plan', argumentHint: '[open|<description>]', offset: 2178228 },
  { name: 'fast', type: 'local-jsx', description: 'Toggle fast mode', argumentHint: '[on|off]', offset: 2178393 },
  { name: 'fast', type: 'local', description: 'Toggle fast mode', argumentHint: '[on|off]', offset: 2178602 },
  { name: 'passes', type: 'local-jsx', description: 'Share a free week of PRRICODE with friends', offset: 2178835 },
  { name: 'privacy-settings', type: 'local-jsx', description: 'View and update your privacy settings', offset: 2179115 },
  { name: 'hooks', type: 'local-jsx', description: 'View hook configurations for tool events', offset: 2179263 },
  { name: 'loops', type: 'local-jsx', description: 'List, create, and delete loops', offset: 2179410 },
  { name: 'branch', type: 'local-jsx', description: 'Create a branch of the current conversation at this point', argumentHint: '[name]', offset: 2179533 },
  { name: 'fork', type: 'local-jsx', description: 'Spawn a background agent that inherits the full conversation', argumentHint: '<directive>', offset: 2179715 },
  { name: 'fork', type: 'local-jsx', description: 'Copy this conversation into a new background session and keep working here', argumentHint: '[prompt]', offset: 2179915 },
  { name: 'subtask', type: 'local-jsx', description: 'Send a subagent off with your full context; its result comes back here', argumentHint: '<task>', offset: 2180087 },
  { name: 'agents', type: 'local', description: '(removed) Ask PRRICODE to create/manage subagents, or edit .claude/agents/', offset: 2180645 },
  { name: 'plugin', type: 'local-jsx', description: 'Manage PRRICODE plugins', aliases: ['plugins', 'marketplace'], offset: 2180883 },
  { name: 'reload-plugins', type: 'local', description: 'Activate pending plugin changes in the current session', argumentHint: '[--force]', offset: 2181162 },
  { name: 'reload-skills', type: 'local', description: 'Pick up skills added or changed on disk during this session', offset: 2181431 },
  { name: 'rewind', type: 'local', description: 'Restore the code and/or conversation to a previous point', aliases: ['checkpoint', 'undo'], argumentHint: '', offset: 2181653 },
  { name: 'heapdump', type: 'local', description: 'Dump the JS heap to the Desktop; on Linux with no Desktop folder, the home directory', offset: 2181917 },
  { name: 'version', type: 'local-jsx', description: "Show this session's version (autoupdate may have a newer one)", offset: 2182482 },
  { name: 'version', type: 'local', description: 'Print the version this session is running (not what autoupdate downloaded)', offset: 2184202 },
  { name: 'sandbox', type: 'local-jsx', description: 'sandbox disabled (⏎ to configure)', argumentHint: 'exclude "command pattern"', offset: 2184846 },
  { name: 'chrome', type: 'local-jsx', description: 'Open PRRICODE in Chrome settings', offset: 2185676 },
  { name: 'stickers', type: 'local', description: 'Order PRRICODE stickers', offset: 2185876 },
  { name: 'radio', type: 'local', description: 'Listen to PRRICODE FM lo-fi radio', offset: 2186029 },
  { name: 'advisor', type: 'local-jsx', description: 'Let PRRICODE consult a stronger model at key moments', argumentHint: '[fable|opus|sonnet|off]', offset: 2186184 },
  { name: 'advisor', type: 'local', description: 'Let PRRICODE consult a stronger model at key moments', argumentHint: '[fable|opus|sonnet|off]', offset: 2186497 },
  { name: 'exit', type: 'local-jsx', description: 'Exit the CLI', aliases: ['quit'], offset: 2188723 },
  { name: 'exit', type: 'local', description: 'Exit the CLI', offset: 2188893 },
  { name: 'restart', type: 'local', description: 'Restart PRRICODE and keep this session', aliases: ['update'], offset: 2191266 },
  { name: 'export', type: 'local-jsx', description: 'Export the current conversation to a file or clipboard', argumentHint: '[filename]', offset: 2191649 },
  { name: 'model', type: 'local', description: 'Set the AI model for PRRICODE', argumentHint: '<model>', offset: 2191811 },
  { name: 'model', type: 'local-jsx', description: 'Set the AI model for PRRICODE', argumentHint: '[model]', offset: 2192025 },
  { name: 'remote-env', type: 'local-jsx', description: 'Choose the default environment for cloud agents', offset: 2192240 },
  { name: '__remote-workflow', type: 'local', description: 'Run the workflow script delivered in this session environment (server-launched sessions only)', offset: 2192465 },
  { name: 'workflow-launch-exec', type: 'local', description: 'Execute a server-launched workflow handoff (workflow_launch event sessions only)', offset: 2192759 },
  { name: 'upgrade', type: 'local-jsx', description: 'Upgrade to Max for higher rate limits and more Opus', offset: 2193043 },
  { name: 'usage-credits', type: 'local-jsx', description: 'Configure usage credits or request them from your admin when you hit a limit', offset: 2193217 },
  { name: 'usage-credits', type: 'local', description: 'Configure usage credits or request them from your admin when you hit a limit', offset: 2193396 },
  { name: 'extra-usage', type: 'local-jsx', description: 'Renamed to /usage-credits', offset: 2193645 },
  { name: 'extra-usage', type: 'local', description: 'Renamed to /usage-credits', offset: 2193783 },
  { name: 'pro-trial-expired', type: 'local-jsx', description: 'Options shown when the Pro plan PRRICODE trial has ended', offset: 2193967 },
  { name: 'rate-limit-options', type: 'local-jsx', description: 'Manage usage limits and upgrade options', offset: 2194113 },
  { name: 'low-priority', type: 'local', description: 'Continue now at lower priority after reaching your session limit; run again to stop', offset: 2194269 },
  { name: 'limit-reset', type: 'local-jsx', description: 'Reset your session limit now and keep working; once a week, still counts toward your weekly limit', offset: 2198975 },
  { name: 'claim-credit', type: 'local', description: 'Open the page of the offer shown at start-up', offset: 2199245 },
  {
    name: 'statusline',
    type: 'prompt',
    description: "Set up PRRICODE's status line UI",
    offset: 2199474,
    progressMessage: 'setting up statusLine',
    contentLength: 0,
    source: 'builtin',
    disableModelInvocation: true,
    userFacingName: 'statusline',
    requires: { workspace: true },
  },
  { name: 'effort', type: 'local-jsx', description: 'Set effort level for model usage', argumentHint: '[low|medium|high|xhigh|max|auto]', offset: 2200547 },
  { name: 'effort', type: 'local', description: 'Set effort level for model usage', argumentHint: '[low|medium|high|xhigh|max|auto]', offset: 2200739 },
  { name: 'wellbeing', type: 'local-jsx', description: 'Configure optional break reminders and quiet-hours nudges', aliases: ['breaks', 'break-reminder', 'downtime'], offset: 2200983 },
  { name: 'focus', type: 'local-jsx', description: 'Toggle focus view: just your prompt, summary, and response', offset: 2201202 },
  { name: 'focus', type: 'local', description: 'Toggle focus view: just your prompt, summary, and response', argumentHint: '[on|off]', offset: 2202790 },
  {
    name: 'insights',
    type: 'prompt',
    description: 'Generate a report analyzing your PRRICODE sessions',
    offset: 2204406,
    progressMessage: 'analyzing your sessions',
    contentLength: 0,
    source: 'builtin',
    disableModelInvocation: true,
    userFacingName: 'insights',
    policyGate: { policy: 'allow_insights' },
    requires: { workspace: true },
  },
];

/**
 * The commands this implementation owns.
 *
 * The target registers **neither**: it has no provider manager and no catalog
 * browser (the audit's "important negative finding"). They are a **project
 * extension**, and the registry says so — the entry carries the extension
 * flag, and every surface that shows it says so too.
 */
const EXTENSION_DEFINITIONS: readonly TargetCommandDefinition[] = [
  {
    name: 'provider',
    type: 'local',
    description: 'Manage the provider connections and their credentials',
    argumentHint: '<verb> [options]',
    offset: 0,
  },
  {
    name: 'catalog',
    type: 'local',
    description: 'Browse the model catalogs of the provider connections',
    argumentHint: '<verb> [options]',
    offset: 0,
  },
];

/**
 * Every command definition of the registry.
 *
 * The target's own definitions come first, in the target's own order; the two
 * commands this implementation owns come after them.
 */
export const SLASH_COMMAND_DEFINITIONS: readonly SlashCommand[] = [
  ...TARGET_DEFINITIONS.map((definition) => toCommand(definition)),
  ...EXTENSION_DEFINITIONS.map((definition) => toCommand(definition, true)),
];

/**
 * The registry the commands are looked up in: **one entry per name**.
 *
 * Where the target registers a command twice, the **first** definition wins —
 * the order of the bundle — unless the first is a **hidden** one, in which
 * case the first **visible** definition wins. The second definition stays in
 * {@link SLASH_COMMAND_DEFINITIONS}.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = firstOfEachName(SLASH_COMMAND_DEFINITIONS);

/**
 * The registry's own commands — the ones the target registers.
 *
 * The two commands this implementation owns are **not** in this list: they
 * are a project extension, and a table of the target's commands must not
 * carry them.
 */
export const TARGET_SLASH_COMMANDS: readonly SlashCommand[] = SLASH_COMMANDS.filter(
  (command) => !command.extension,
);

/**
 * The commands whose **name the target computes**.
 *
 * The target registers a command under a name it builds at run time: a plugin
 * command (`chunk-4jsg44k7.js:50437`), an enterprise command
 * (`:2187476`), a prompt the MCP server contributes, and the two commands
 * `qYt` generates for the settings that moved to `/config`. They are
 * recorded here rather than as commands, because their names are not known
 * until the session runs.
 */
export const TEMPLATE_COMMAND_NAMES: readonly string[] = [
  'n.name (a plugin command)',
  'e.name (an enterprise command)',
  'e (a generated settings stub)',
  'y (a prompt an MCP server contributes)',
];

/* -------------------------------------------------------------------------- */
/* The lookups                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The commands, keyed by every name they answer to.
 *
 * A `Map` and not a plain object: a command's name is **data**, and
 * `Object.prototype` carries members called `constructor`, `toString` and
 * `__proto__`.
 */
const COMMANDS_BY_NAME: ReadonlyMap<string, SlashCommand> = (() => {
  const table = new Map<string, SlashCommand>();
  for (const command of SLASH_COMMANDS) {
    table.set(command.name, command);
    for (const alias of command.aliases) {
      if (!table.has(alias)) table.set(alias, command);
    }
  }
  return table;
})();

/**
 * The command a name — or an alias — names.
 *
 * @returns the command, or `undefined` when no command answers to the name.
 */
export function slashCommandOf(name: string): SlashCommand | undefined {
  return COMMANDS_BY_NAME.get(name);
}

/**
 * The names of the commands the registry holds.
 *
 * The list is the **overlay's** list: the composer's `/`-overlay shows the
 * commands the registry holds, and this is that list.
 */
export function slashCommandNames(): readonly string[] {
  return SLASH_COMMANDS.map((command) => command.name);
}

/**
 * The word a line of typed text names, when the line is a command.
 *
 * The line must **start** with a slash, and the word is the text up to the
 * first space. A line that names no command is not a command, and the caller
 * sends it to the model.
 */
export function slashCommandWord(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const word = space === -1 ? body : body.slice(0, space);
  return word === '' ? undefined : word;
}

/**
 * Whether a line of typed text names a command of the registry.
 */
export function isSlashCommand(text: string): boolean {
  const word = slashCommandWord(text);
  return word !== undefined && slashCommandOf(word) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* The capabilities                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The capability each command this implementation does not run needs.
 *
 * The phrase names the thing that is **missing**, so a refusal says what
 * would have to exist for the command to run. It is a *capability* and not a
 * verdict: the command is not refused because it is dangerous or unwanted,
 * but because this implementation has no such thing.
 */
const MISSING_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  ['add-dir', 'way to give the session another working directory'],
  ['advisor', 'way to consult a stronger model'],
  ['agents', 'editor for the subagent files'],
  ['artifacts', 'published artifacts'],
  ['auto-mode-setup', 'auto-mode environment wizard'],
  ['autocompact', 'automatic compaction window'],
  ['autofix-pr', 'pull-request tracker'],
  ['branch', 'conversation branching'],
  ['btw', 'side-question channel'],
  ['bug', 'channel to report a bug'],
  ['cd', 'way to change the working directory of a running session'],
  ['chrome', 'browser extension'],
  ['claim-credit', 'credit offer'],
  ['cloud-plugins', 'cloud sessions'],
  ['color', 'prompt-bar colour setting'],
  ['commit-push-pr', 'built-in commit-and-pull-request prompt'],
  ['copy', 'clipboard access'],
  ['desktop', 'desktop client to hand the session to'],
  ['design-consent', 'Design service'],
  ['design-login', 'Design service'],
  ['design-revoke', 'Design service'],
  ['diff', 'diff panel'],
  ['effort', 'effort setting'],
  ['exit', 'way to leave the session from inside it'],
  ['extra-usage', 'usage credits'],
  ['export', 'export of the conversation'],
  ['fast', 'fast mode'],
  ['feedback', 'channel to send feedback'],
  ['focus', 'focus view'],
  ['fork', 'background sessions'],
  ['heapdump', 'heap dump'],
  ['hooks', 'view of the hook configuration'],
  ['ide', 'IDE integration client'],
  ['import', "reader for another agent's configuration"],
  ['init', 'built-in codebase-documentation prompt'],
  ['insights', 'built-in session-insights prompt'],
  ['install-github-app', 'GitHub Actions installer'],
  ['install-slack-app', 'Slack app installer'],
  ['keybindings', 'keyboard-shortcuts file'],
  ['limit-reset', 'session-limit reset'],
  ['loops', 'loop scheduler'],
  ['login', 'account sign-in'],
  ['logout', 'account sign-in'],
  ['low-priority', 'lower-priority queue'],
  ['mcp', 'MCP server manager'],
  ['memory', 'memory editor'],
  ['mobile', 'mobile client to pair with'],
  ['passes', 'referral programme'],
  ['pause-memory', 'account memory service'],
  ['permissions', 'permission-rule editor'],
  ['plan', 'session plan'],
  ['plugin', 'plugin and marketplace manager'],
  ['powerup', 'interactive lessons'],
  ['privacy-settings', 'privacy-settings editor'],
  ['pro-trial-expired', 'trial-expiry options'],
  ['radio', 'radio stream'],
  ['rate-limit-options', 'rate-limit options'],
  ['release-notes', 'release notes'],
  ['reload-plugins', 'plugin registry'],
  ['reload-skills', 'live skill registry'],
  ['remote-env', 'cloud environment'],
  ['rename', 'title for the conversation'],
  ['restart', 'restart of the process'],
  ['rewind', REWIND_MISSING_CAPABILITY],
  ['sandbox', 'sandbox configuration editor'],
  ['scroll-speed', 'terminal scroll-speed setting'],
  ['session', 'cloud session'],
  ['setup-bedrock', 'Bedrock setup flow'],
  ['setup-vertex', 'Vertex setup flow'],
  ['statusline', 'status-line setup agent'],
  ['stickers', 'sticker catalogue'],
  ['subtask', 'hand-off to a subagent'],
  ['tasks', 'background-task registry'],
  ['team-onboarding', 'built-in team-onboarding prompt'],
  ['teleport', 'cloud session'],
  ['terminal-setup', "probe of the terminal's capabilities"],
  ['theme', 'theme picker'],
  ['tui', 'choice of terminal renderer'],
  ['ultraplan', 'cloud planning agent'],
  ['ultrareview', 'cloud review agent'],
  ['upgrade', 'subscription upgrade'],
  ['usage-credits', 'usage credits'],
  ['vim', 'editor mode'],
  ['voice', 'voice input'],
  ['wellbeing', 'break reminders'],
  ['workflow-launch-exec', 'server-launched workflow'],
  ['__remote-workflow', 'server-launched workflow'],
]);

/**
 * The refusal a command this implementation does not run gets.
 *
 * The refusal **names the capability**: a user who types `/teleport` learns
 * that the command needs a cloud session, and not merely that the command is
 * unknown.
 *
 * **Implementation choice** (the wording). The target refuses nothing here —
 * it has the capability — so the wording is this implementation's own.
 */
export function slashCommandRefusal(command: SlashCommand): CommandResult {
  const capability = MISSING_CAPABILITIES.get(command.name);
  const need =
    capability === undefined
      ? 'a capability this implementation does not have'
      : capability;
  return failure(
    `The '/${command.name}' command is not implemented here: this implementation has no ${need}.`,
  );
}

/* -------------------------------------------------------------------------- */
/* The context                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a command needs to run.
 *
 * The **host** owns the session, so the session's own lifecycle — starting a
 * new session, resuming another one, compacting the conversation — is a seam
 * the host supplies and the commands call. A command never reaches into the
 * host's state.
 */
export interface SlashCommandContext {
  /** The session's store. */
  readonly store: SessionStore;
  /** The session's working directory. */
  readonly cwd: string;
  /** The session's configuration directory. */
  readonly configDir: string;
  /** The session's id. */
  readonly sessionId: string;
  /** The model the session runs on. */
  readonly model: string;
  /** The version the session runs. */
  readonly version: string;
  /** The session's records, in the order they happened. */
  readonly events: readonly SessionEvent[];
  /** The environment the session runs in. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The manager's state, loaded when a command needs it.
   *
   * The state is a file, and a command that does not touch the manager never
   * reads it.
   */
  readonly managerState: () => Promise<LoadedManagerState>;
  /**
   * The options the manager's commands run with, for the state they run
   * against.
   *
   * The options carry the catalog table, and the catalog table is part of the
   * state — so the options are built **from** the state, and a command that
   * never reaches the manager never builds them.
   */
  readonly managerOptions: (state: LoadedManagerState) => ManagerCommandOptions;
  /** Set the model the session runs on. */
  readonly setModel?: (model: string) => void;
  /** Start a new session with an empty context. */
  readonly startSession?: (name?: string) => Promise<void>;
  /** Resume a session by its id. */
  readonly resumeSession?: (sessionId: string) => Promise<void>;
  /** Compact the conversation and report the summary. */
  readonly compactSession?: (instructions?: string) => Promise<string | undefined>;
  /**
   * Whether the message that reached the command was **dispatched over a
   * bridge** — Remote Control.
   *
   * The target's remote predicate is `dispatchedOverBridge === true ||
   * submissionVerifiedSlackHumanTurn === true`, so the two flags are carried
   * separately here too, and the predicate is the target's.
   */
  readonly dispatchedOverBridge?: boolean;
  /**
   * Whether the message that reached the command was submitted by a
   * **verified Slack human turn**.
   */
  readonly submissionVerifiedSlackHumanTurn?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The dispatch                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run the command a line of typed text names.
 *
 * @returns the result of the command, or `undefined` when the line names no
 *   command — the caller then sends the line to the model, the way the
 *   target sends a line that names no command.
 */
export async function runSlashCommand(
  text: string,
  context: SlashCommandContext,
): Promise<CommandResult | undefined> {
  const word = slashCommandWord(text);
  if (word === undefined) return undefined;
  const command = slashCommandOf(word);
  if (command === undefined) return undefined;

  const trimmed = text.trimStart();
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const rest = space === -1 ? '' : body.slice(space + 1);
  const args = managerArgumentsOf(rest);
  if (args === undefined) {
    return usageError('the command has an unterminated quote');
  }

  return dispatch(command, args, context);
}

/**
 * Run one command.
 *
 * The switch is the whole of the dispatch: the commands this implementation
 * runs are here, and every other command is **refused** with the capability
 * it needs.
 */
async function dispatch(
  command: SlashCommand,
  args: readonly string[],
  context: SlashCommandContext,
): Promise<CommandResult> {
  switch (command.name) {
    case 'help':
      return helpCommand(context);
    case 'version':
      return versionCommand(context);
    case 'model':
      return modelCommand(args, context);
    case 'status':
      return statusCommand(context);
    case 'usage':
      return usageCommand(context);
    case 'context':
      return contextCommand(context);
    case 'config':
      return configCommand(context);
    case 'output-style':
      return outputStyleCommand(args, context);
    case 'skill-doctor':
      return skillDoctorCommand(context);
    case 'skills':
      return skillsCommand(context);
    case 'clear':
      return clearCommand(args, context);
    case 'compact':
      return compactCommand(args, context);
    case 'resume':
      return resumeCommand(args, context);
    case 'provider':
    case 'catalog':
      return managerCommand(command.name, args, context);
    default:
      return slashCommandRefusal(command);
  }
}

/* -------------------------------------------------------------------------- */
/* The commands                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The help: the registry, and every command in it.
 *
 * The target's `/help` "shows help and available commands"; the list it shows
 * is the registry's list, and this implementation's list is the registry's
 * list too. The two commands this implementation owns are marked as the
 * extension they are.
 */
function helpCommand(context: SlashCommandContext): CommandResult {
  const rows = SLASH_COMMANDS.map((command) => {
    const aliases = command.aliases.length === 0 ? '' : ` (${command.aliases.join(', ')})`;
    const name = `/${command.name}${aliases}`;
    const description = command.extension ? `${command.description} (${PROVIDER_EXTENSION_LABEL})` : command.description;
    return [name, command.argumentHint ?? '', description];
  });
  const lines = renderTable(['Command', 'Argument', 'Description'], rows);
  const header = `The commands (${TARGET_SLASH_COMMANDS.length} of the target, ${SLASH_COMMANDS.length - TARGET_SLASH_COMMANDS.length} of this implementation):`;
  return { exitCode: 0, stdout: `${header}\n${lines.join('\n')}\n`, stderr: '' };
}

/**
 * The version this session is running.
 *
 * The target's `/version` prints "the version this session is running (not
 * what autoupdate downloaded)". This implementation has no autoupdate, so
 * the version is the one the package declares.
 */
function versionCommand(context: SlashCommandContext): CommandResult {
  return { exitCode: 0, stdout: `${context.version}\n`, stderr: '' };
}

/**
 * The models the catalog offers, and the model the session runs on.
 *
 * The target's `/model` **sets** the model. This implementation sets it too:
 * with an argument it sets the model, and without one it **lists** the models
 * the catalog offers — which is the list the target's model picker shows.
 */
function modelCommand(args: readonly string[], context: SlashCommandContext): CommandResult {
  const wanted = args.join(' ').trim();
  if (wanted === '') {
    const models = listModels(builtinCatalog);
    const rows = models.map((model) => [model.id, model.displayName, model.family]);
    const lines = renderTable(['Model', 'Name', 'Family'], rows);
    return {
      exitCode: 0,
      stdout: `The models the catalog offers (${models.length}); the session runs ${context.model}:\n${lines.join('\n')}\n`,
      stderr: '',
    };
  }

  const model = findModel(builtinCatalog, wanted) ?? listModels(builtinCatalog).find((entry) => entry.displayName === wanted);
  if (model === undefined) {
    return usageError(`the model '${wanted}' is not in the catalog`);
  }
  if (context.setModel === undefined) {
    return failure("The model cannot be changed from inside a session: this implementation has no model switch.");
  }
  context.setModel(model.id);
  return { exitCode: 0, stdout: `The session now runs ${model.id}.\n`, stderr: '' };
}

/**
 * The status of the session.
 *
 * The target's `/status` shows "version, model, account, API connectivity, and
 * tool statuses". This implementation has no account and no connectivity
 * probe, so it reports the version, the model, the working directory, the
 * session and the provider connection — and says which of the target's rows
 * it cannot show.
 */
async function statusCommand(context: SlashCommandContext): Promise<CommandResult> {
  const rows: string[][] = [
    ['Version', context.version],
    ['Model', context.model],
    ['Working directory', context.cwd],
    ['Session', context.sessionId],
  ];

  try {
    const state = await context.managerState();
    const active = state.registry.active();
    rows.push([
      'Provider',
      active === undefined
        ? 'none is active'
        : `${active.name} (${active.route}, credential: ${active.credential.kind})`,
    ]);
  } catch {
    rows.push(['Provider', 'the provider state could not be read']);
  }

  rows.push(['Account', 'not shown: this implementation has no account service']);
  rows.push(['API connectivity', 'not shown: this implementation does not probe the provider']);

  const lines = renderTable(['Setting', 'Value'], rows);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/**
 * The session's activity.
 *
 * The target's `/usage` shows "session cost, plan usage, and activity stats".
 * This implementation prices nothing and holds no plan, so it reports the
 * **activity** — the records, the turns and the tool calls the transcript
 * holds — and says that the cost is not measured.
 */
function usageCommand(context: SlashCommandContext): CommandResult {
  const events = context.events;
  const turns = events.filter((event) => event.t === 'user_message').length;
  const answers = events.filter((event) => event.t === 'assistant_message').length;
  const calls = events.filter((event) => event.t === 'tool_call').length;
  const compactions = events.filter((event) => event.t === 'compaction').length;

  const rows: string[][] = [
    ['Records', `${events.length}`],
    ['Turns', `${turns}`],
    ['Answers', `${answers}`],
    ['Tool calls', `${calls}`],
    ['Compactions', `${compactions}`],
    ['Cost', 'not measured: this implementation\'s session transcript does not carry the token usage'],
    ['Plan usage', 'not shown: this implementation has no plan service'],
  ];
  const lines = renderTable(['Statistic', 'Value'], rows);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/**
 * The context the session carries.
 *
 * The target's `/context` shows "current context usage". This implementation
 * does not count tokens, so it reports the size it can measure — the records
 * and the characters — and says that the token count is not measured.
 */
function contextCommand(context: SlashCommandContext): CommandResult {
  const events = context.events;
  const characters = events.reduce((total, event) => total + JSON.stringify(event).length, 0);
  const rows: string[][] = [
    ['Records', `${events.length}`],
    ['Characters', `${characters}`],
    ['Tokens', 'not measured: this implementation does not count tokens'],
  ];
  const lines = renderTable(['Measure', 'Value'], rows);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/**
 * The output styles, and the active one.
 *
 * The target's `/output-style` "List output styles or switch to one". This
 * implementation lists the **built-in** styles and the **file** styles, and
 * saves the choice to the project's **local** settings file — `.claude/settings.local.json`
 * — the way the target does.
 *
 * The target's own wording is used: the list, the unknown-style line, the
 * already-set line and the set line.
 *
 * Over a **remote or relayed** session the target lets the session pick **only
 * the built-in styles**, and appends its own note to the command's output. The
 * predicate, the note and the label the current style carries are the target's
 * own — `chunk-720ca63b.js:1447` and `chunk-4jsg44k7.js:2269007`.
 */
async function outputStyleCommand(
  args: readonly string[],
  context: SlashCommandContext,
): Promise<CommandResult> {
  const styles = await allOutputStyles({ cwd: context.cwd, configRoot: context.configDir });
  const settings = loadSettings({
    cwd: context.cwd,
    configDir: context.configDir,
    restricted: context.env[RESTRICT_PERSONAL_CONFIG_ENV] !== undefined,
  });
  const current = currentOutputStyle(mergeMergedSettings(settings.tiers) as Record<string, unknown>);

  const remote = isRemoteOrRelayedSession(context);
  const selection = outputStyleSelection(styles, current, remote);
  const note = selection.note === undefined ? '' : `\n${selection.note}`;

  const wanted = args.join(' ').trim();
  if (wanted === '' || isOutputStyleQueryWord(wanted)) {
    const rows = selection.styles.map((style) => {
      const marker = style.name === current ? ' (current)' : '';
      return style.description === ''
        ? `- ${style.name}${marker}`
        : `- ${style.name}${marker}: ${style.description}`;
    });
    const head = `Output style: ${selection.currentLabel}`;
    return {
      exitCode: 0,
      stdout: `${head}\n\nAvailable styles:\n${rows.join('\n')}\n\nUsage: /output-style <style>${note}\n`,
      stderr: '',
    };
  }

  const chosen = selection.styles.find((style) => style.name.toLowerCase() === wanted.toLowerCase());
  if (chosen === undefined) {
    const names = selection.styles.map((style) => style.name).join(', ');
    return usageError(`Unknown output style "${wanted}". Available styles: ${names}${note}`);
  }

  if (chosen.name === current) {
    return { exitCode: 0, stdout: `Output style is already ${chosen.name}\n`, stderr: '' };
  }

  try {
    await writeOutputStyleSetting(context.cwd, chosen.name);
  } catch (error) {
    return failure(`Could not save output style: ${errorMessageOf(error)}`);
  }
  return { exitCode: 0, stdout: `Output style set to ${chosen.name}\n`, stderr: '' };
}

/**
 * The configuration the session runs with.
 *
 * The target's `/config` opens the settings and sets a setting by key. This
 * implementation **shows** the configuration: the tier that contributed each
 * key, and the merged document the session runs with. Setting a key is a
 * different job — the settings writer is a different milestone — and this
 * command does not pretend to do it.
 */
function configCommand(context: SlashCommandContext): CommandResult {
  const settings = loadSettings({
    cwd: context.cwd,
    configDir: context.configDir,
    restricted: context.env[RESTRICT_PERSONAL_CONFIG_ENV] !== undefined,
  });

  const rows: string[][] = [];
  for (const [source, tier] of settings.tiers) {
    rows.push([source, `${Object.keys((tier.value ?? {}) as Record<string, unknown>).length} keys`]);
  }
  if (rows.length === 0) rows.push(['(none)', 'no settings tier contributed']);

  const merged = mergeMergedSettings(settings.tiers);
  const lines = renderTable(['Tier', 'Contribution'], rows);
  const document = JSON.stringify(merged, null, 2);
  return {
    exitCode: 0,
    stdout: `${lines.join('\n')}\n\nThe merged settings:\n${document}\n`,
    stderr: '',
  };
}

/**
 * The skills the session loaded.
 *
 * The target's `/skill-doctor` shows "which loaded skills are unused and
 * costing context". This implementation does not track a skill's use, so it
 * lists the skills and says that the usage is not tracked.
 */
function skillDoctorCommand(context: SlashCommandContext): CommandResult {
  const registry = createSkillRegistry({ cwd: context.cwd, configDir: context.configDir });
  const skills = registry.list();
  const rows = skills.map((skill) => [skill.name, skill.description ?? '', skill.source ?? '']);
  if (rows.length === 0) rows.push(['(none)', 'no skill was found', '']);
  const lines = renderTable(['Skill', 'Description', 'Source'], rows);
  const footer = 'Usage is not tracked: this implementation does not record which skills a session used.';
  return { exitCode: 0, stdout: `${lines.join('\n')}\n\n${footer}\n`, stderr: '' };
}

/**
 * The skills the session may use.
 *
 * The target's `/skills` "lists available skills"; this implementation lists
 * the skills it found.
 */
function skillsCommand(context: SlashCommandContext): CommandResult {
  const registry = createSkillRegistry({ cwd: context.cwd, configDir: context.configDir });
  const skills = registry.list();
  const rows = skills.map((skill) => [skill.name, skill.description ?? '']);
  if (rows.length === 0) rows.push(['(none)', 'no skill was found']);
  const lines = renderTable(['Skill', 'Description'], rows);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/**
 * A new session with an empty context.
 *
 * The target's `/clear` "starts a new session with empty context; the
 * previous session stays on disk (resumable with /resume)". The previous
 * session stays on disk here too: the store keeps the transcript, and the
 * new session gets its own id.
 */
async function clearCommand(args: readonly string[], context: SlashCommandContext): Promise<CommandResult> {
  if (context.startSession === undefined) {
    return failure('The session cannot be cleared: this implementation has no way to start a new session.');
  }
  const name = args.join(' ').trim();
  await context.startSession(name === '' ? undefined : name);
  return { exitCode: 0, stdout: 'A new session was started; the previous one stays on disk.\n', stderr: '' };
}

/**
 * A summarised session.
 *
 * The target's `/compact` "frees up context by summarizing the conversation
 * so far". The summary is a **model** output — this implementation never
 * writes one itself — so the command asks the session for it and marks the
 * boundary with it.
 */
async function compactCommand(args: readonly string[], context: SlashCommandContext): Promise<CommandResult> {
  if (context.compactSession === undefined) {
    return failure(
      'The conversation cannot be compacted: this implementation has no provider-backed summarisation in the command path.',
    );
  }
  const instructions = args.join(' ').trim();
  const summary = await context.compactSession(instructions === '' ? undefined : instructions);
  if (summary === undefined) {
    return failure('The conversation was not compacted: the model produced no summary.');
  }
  return { exitCode: 0, stdout: `The conversation was compacted; the summary is ${summary.length} characters long.\n`, stderr: '' };
}

/**
 * A resumed session.
 *
 * The target's `/resume` "resumes a previous conversation". This
 * implementation resumes one by its **id** or by an **exact title**, the way
 * its own `--resume` does.
 */
async function resumeCommand(args: readonly string[], context: SlashCommandContext): Promise<CommandResult> {
  const target = args.join(' ').trim();
  if (target === '') {
    return usageError('the command needs a conversation id or title');
  }
  if (context.resumeSession === undefined) {
    return failure('The conversation cannot be resumed: this implementation has no way to open another session.');
  }
  const summaries = await context.store.list({ cwd: context.cwd });
  const resolution = resolveSessionTarget(summaries, target);
  if (resolution.kind !== 'found') {
    return failure(resolution.kind === 'ambiguous' ? resolution.message : resolution.message);
  }
  await context.resumeSession(resolution.summary.sessionId);
  return { exitCode: 0, stdout: `The session ${resolution.summary.sessionId} was resumed.\n`, stderr: '' };
}

/**
 * The manager's commands.
 *
 * `/provider` and `/catalog` are this implementation's own — the target
 * registers neither — and they run the manager the same way the command line
 * runs it.
 */
async function managerCommand(
  name: string,
  args: readonly string[],
  context: SlashCommandContext,
): Promise<CommandResult> {
  const state = await context.managerState();
  return providerManagerCommand([name, ...args], state.registry, context.managerOptions(state));
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A definition, as the registry holds it.
 */
function toCommand(definition: TargetCommandDefinition, extension = false): SlashCommand {
  return {
    name: definition.name,
    type: definition.type,
    description: definition.description,
    aliases: definition.aliases ?? [],
    ...(definition.argumentHint === undefined ? {} : { argumentHint: definition.argumentHint }),
    ...(extension ? {} : { offset: definition.offset }),
    hidden: definition.hidden ?? false,
    extension,
    ...(definition.progressMessage === undefined
      ? {}
      : { progressMessage: definition.progressMessage }),
    ...(definition.contentLength === undefined ? {} : { contentLength: definition.contentLength }),
    ...(definition.source === undefined ? {} : { source: definition.source }),
    ...(definition.disableModelInvocation === undefined
      ? {}
      : { disableModelInvocation: definition.disableModelInvocation }),
    ...(definition.userFacingName === undefined ? {} : { userFacingName: definition.userFacingName }),
    ...(definition.policyGate === undefined ? {} : { policyGate: definition.policyGate }),
    ...(definition.requires === undefined ? {} : { requires: definition.requires }),
  };
}

/**
 * The first definition of each name, in the registry's order.
 *
 * Where the target registers a command twice, the **first** definition wins —
 * the order of the bundle — unless it is a **hidden** one, in which case the
 * first **visible** definition wins: the target registers `/output-style`
 * twice, once as a hidden "moved to `/config`" stub and once as the command
 * itself, and the menu shows the command.
 */
function firstOfEachName(definitions: readonly SlashCommand[]): SlashCommand[] {
  const index = new Map<string, number>();
  const commands: SlashCommand[] = [];
  for (const command of definitions) {
    const at = index.get(command.name);
    if (at === undefined) {
      index.set(command.name, commands.length);
      commands.push(command);
      continue;
    }
    const kept = commands[at];
    if (kept !== undefined && kept.hidden && !command.hidden) commands[at] = command;
  }
  return commands;
}
