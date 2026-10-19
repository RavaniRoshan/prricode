/**
 * The permission rule engine.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * `research/reference-agent-2.1.303-research.md` §5 (Permission models and known
 * security failures).
 *
 * **A rule is a pure predicate.** It answers "allow", "deny" or "ask", and it names
 * the rule and the tier it came from. It never rewrites the tool input: a rule that
 * silently changed what runs is exactly the defect this design avoids, so the
 * rewrite path lives in the hook layer (`src/permissions/prompts.ts`) and routes its
 * `updatedInput` through the same `PermissionDecision.updatedInput` field.
 *
 * **Precedence** is `deny` → `ask` → `allow`, **first match wins, and specificity is
 * irrelevant**: a broad deny beats a narrower allow, and an allow rule can never
 * carve an exception out of a deny. The lists are scanned in order, so the first
 * rule *in the list* that matches is the rule that matched — never a more specific
 * one that happens to appear later.
 *
 * **Compound commands** are split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and
 * every sub-command is matched independently. There is **no sub-command cap**: the
 * target had a 50-sub-command cap that silently skipped every deny check and
 * degraded to a generic, auto-approvable ask, and this implementation does not reproduce it.
 * A deny or ask rule fires when **any** sub-command matches; an allow rule approves
 * only when **every** sub-command matches.
 *
 * **Quoted text is never stripped.** The target once had a validator that removed
 * single-quoted text before checking, so a payload inside quotes passed. This implementation
 * keeps the quoted text in the sub-command it matches, and only treats an operator
 * inside quotes as a literal character.
 *
 * **Bash rules match command text, not program identity.** `Bash(curl *)` does not
 * stop `/usr/bin/curl` or `sh -c 'curl …'`; the target's own documentation calls
 * these rules "not a security boundary around the program". This implementation does not claim
 * otherwise, and nothing in the safety-check path may assume the rule engine saw the
 * program.
 *
 * **Path rules** use four anchors: `//path` (filesystem root), `~/path` (home),
 * `/path` (**relative to the settings source**, not the filesystem root) and
 * `path` / `./path` (the working directory). A deny or ask pattern that names a
 * single segment matches that segment at any depth; an allow pattern matches only
 * at the anchored depth.
 *
 * **Symlink semantics are asymmetric**: an allow rule requires **both** the
 * requested path and the resolved target to match, while a deny rule fires if
 * **either** matches. The path must also be **re-resolved after the check** — a
 * resolution taken before the check is a point-in-time fact, and this implementation exposes
 * `reResolvePath` so the write path never trusts it.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The decision `source` of a rule-produced decision is `unknown`. The target's
 *     source vocabulary (`classifier`, `hook`, `user_permanent`, `user_temporary`,
 *     `user_abort`, `user_reject`, `unknown`) has no member for "the rule engine",
 *     and inventing one would break the closed vocabulary.
 *   - A `!`-negated rule cancels a matching rule **in the same list and from the
 *     same tier**. A negation from another settings file must not cancel a rule the
 *     user wrote elsewhere.
 *   - `Tool(param:value)` is recognised as a *parameter* rule only when the prefix is
 *     an identifier and the value does not start with `/` (so `Edit(C:/x)` stays a
 *     path). A parameter rule that names the tool's primary content field
 *     (`command`, `file_path`, `path`, `url`) **cannot be applied to that field**: the
 *     rule is ignored and a warning is produced, exactly as the target does.
 *   - Glob semantics: in a *command* pattern `*` matches any characters; in a *path*
 *     pattern `*` matches within one path segment and `**` crosses segments.
 *   - Redirect targets are matched against the path rules as file operations: a
 *     write redirect (`>`, `>>`, `&>`) is checked as a write, a read redirect (`<`)
 *     as a read.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { PermissionDecision, PermissionReasonKind, ToolContext } from './decision.js';

/**
 * The rule lists a settings document exposes.
 *
 * `allow`, `deny` and `ask` are the three lists the target names (audit §2.5,
 * "Rule sources"). The remaining members are optional context the evaluator needs
 * and that the settings loader can supply; a caller that omits them gets the
 * conservative defaults (the process working directory, the home directory and the
 * tier name `settings`).
 */
export interface RuleSet {
  /** Rules that approve a call without asking. */
  allow: string[];
  /** Rules that block a call in every mode. */
  deny: string[];
  /** Rules that always prompt. */
  ask: string[];
  /** The working directory the `path` / `./path` anchors resolve against. */
  cwd?: string;
  /** The directory of the settings file the rules came from; the `/path` anchor resolves against it. */
  settingsDir?: string;
  /** The settings directory of each tier, so the `/path` anchor resolves per rule. */
  settingsDirs?: Record<string, string>;
  /** The home directory the `~/path` anchor resolves against. */
  homeDir?: string;
  /** The tier these rules came from, e.g. `userSettings`. */
  source?: string;
  /** Per-rule tier attribution, keyed by the rule text. */
  ruleSources?: Record<string, string>;
  /** Extra directories the user added; `acceptEdits` may write inside them. */
  additionalDirs?: string[];
}

/**
 * The decision a **rule** produces.
 *
 * The `updatedInput` member is typed `never` so that the rule engine cannot carry a
 * rewritten tool input, even by accident. The hook path uses `PermissionDecision`'s
 * own optional `updatedInput`.
 */
export type RuleDecision = PermissionDecision & { updatedInput?: never };

/** The three rule lists, in the order the target scans them. */
export type RuleListKind = 'deny' | 'ask' | 'allow';

/** The primary content fields the target names. */
export const PRIMARY_CONTENT_FIELDS: readonly string[] = ['command', 'file_path', 'path', 'url'];

/** The file-mutating tool set, exactly as the target names it. */
export const MUTATING_TOOL_NAMES: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];

const PRIMARY_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Read: ['file_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
  WebFetch: ['url'],
};

const PATH_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Read: ['file_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
};

const DEFAULT_PATH_FIELDS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/** The shell wrappers the target strips before matching a command. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'timeout',
  'time',
  'nice',
  'nohup',
  'stdbuf',
  'command',
  'builtin',
  'noglob',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInputField(input: unknown, field: string): unknown {
  if (!isPlainObject(input)) return undefined;
  if (!Object.hasOwn(input, field)) return undefined;
  return input[field];
}

/**
 * Read one field of a tool's input.
 *
 * The lookup is an **own-property** check: the input is caller-supplied data, and a
 * field named `constructor` or `toString` must read as absent rather than resolve
 * to an inherited member.
 */
export function readToolField(input: unknown, field: string): unknown {
  return readInputField(input, field);
}

/**
 * The primary content fields of a tool.
 *
 * The lookup is an **own-property** check: the tool name is caller-supplied data,
 * so a tool named `constructor` or `toString` must not resolve to an inherited
 * member of the table.
 */
export function primaryFieldsFor(toolName: string): readonly string[] {
  if (Object.hasOwn(PRIMARY_FIELDS_BY_TOOL, toolName)) {
    return PRIMARY_FIELDS_BY_TOOL[toolName] ?? PRIMARY_CONTENT_FIELDS;
  }
  return PRIMARY_CONTENT_FIELDS;
}

function pathFieldsFor(toolName: string): readonly string[] {
  if (Object.hasOwn(PATH_FIELDS_BY_TOOL, toolName)) {
    return PATH_FIELDS_BY_TOOL[toolName] ?? DEFAULT_PATH_FIELDS;
  }
  return DEFAULT_PATH_FIELDS;
}

/** The path a tool operates on, when it has one. */
export function extractToolPath(tool: ToolContext): string | undefined {
  for (const field of pathFieldsFor(tool.toolName)) {
    const value = readInputField(tool.input, field);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** The tool's primary content value, when it is a string. */
export function extractPrimaryValue(tool: ToolContext): string | undefined {
  for (const field of primaryFieldsFor(tool.toolName)) {
    const value = readInputField(tool.input, field);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

// --- shell parsing -------------------------------------------------------------

/**
 * Split a compound command into its sub-commands.
 *
 * The split happens on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and only
 * **outside** quotes: an operator inside a quoted string is a literal character. The
 * quoted text itself is kept, because stripping it before checking is the defect the
 * implementation must not reproduce.
 *
 * There is deliberately **no cap** on the number of sub-commands.
 */
export function splitShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let index = 0;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) parts.push(trimmed);
    current = '';
  };

  while (index < command.length) {
    const character = command[index] ?? '';
    if (quote !== null) {
      current += character;
      if (character === quote) {
        quote = null;
      } else if (character === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        }
      }
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      index += 1;
      continue;
    }
    if (character === '\\') {
      const next = command[index + 1];
      if (next !== undefined) {
        current += character + next;
        index += 2;
        continue;
      }
    }
    if (character === '&' && command[index + 1] === '&') {
      push();
      index += 2;
      continue;
    }
    if (character === '|' && command[index + 1] === '|') {
      push();
      index += 2;
      continue;
    }
    if (character === '|' && command[index + 1] === '&') {
      push();
      index += 2;
      continue;
    }
    if (character === '|' || character === ';' || character === '&') {
      push();
      index += 1;
      continue;
    }
    if (character === '\n') {
      push();
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  push();
  return parts;
}

/** A redirection found in a command. */
export interface ShellRedirect {
  /** The operator, e.g. `>`, `>>`, `<`. */
  operator: string;
  /** The redirection target, when it is a file rather than a file descriptor. */
  target: string | undefined;
  /** Whether the redirection writes to its target. */
  writes: boolean;
}

interface SplitRedirectsResult {
  /** The command with every redirection removed. */
  text: string;
  /** The redirections that were removed. */
  redirects: ShellRedirect[];
}

/**
 * Split a command into its text and its redirections.
 *
 * A redirection is a token that starts with `<` or `>`, optionally preceded by a
 * file-descriptor number. A token that also carries `&` either duplicates a file
 * descriptor (`2>&1`, which has no file target) or is the `&>` form, which writes.
 */
function splitRedirects(command: string): SplitRedirectsResult {
  const tokens = tokenizeShell(command);
  const kept: string[] = [];
  const redirects: ShellRedirect[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const operator = redirectOperator(token);
    if (operator === undefined) {
      kept.push(token);
      continue;
    }
    if (operator.kind === 'descriptor') {
      // `2>&1` — a file-descriptor duplication, not a file operation.
      redirects.push({ operator: operator.operator, target: undefined, writes: false });
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined) {
      redirects.push({ operator: operator.operator, target: undefined, writes: operator.writes });
      continue;
    }
    index += 1;
    redirects.push({ operator: operator.operator, target: next, writes: operator.writes });
  }

  return { text: kept.join(' '), redirects };
}

interface RedirectOperator {
  operator: string;
  writes: boolean;
  kind: 'file' | 'descriptor';
}

function redirectOperator(token: string): RedirectOperator | undefined {
  const match = /^(\d*)(&>>|&>|[<>]{1,3})(.*)$/.exec(token);
  if (!match) return undefined;
  const fd = match[1] ?? '';
  const operator = match[2] ?? '';
  const rest = match[3] ?? '';
  if (operator === '&>') {
    return { operator: `&${fd}>`, writes: true, kind: 'file' };
  }
  if (operator === '&>>') {
    return { operator: `&${fd}>>`, writes: true, kind: 'file' };
  }
  if (rest.startsWith('&')) {
    // `2>&1` — duplicating a descriptor, not touching a file.
    return { operator: `${fd}${operator}&${rest.slice(1)}`, writes: false, kind: 'descriptor' };
  }
  if (rest.length > 0) {
    // A target glued to the operator, e.g. `>out.txt`.
    return { operator: `${fd}${operator}`, writes: operator.startsWith('>'), kind: 'file' };
  }
  return { operator: `${fd}${operator}`, writes: operator.startsWith('>'), kind: 'file' };
}

/**
 * Split a command into whitespace-separated tokens, keeping quoted text intact.
 */
function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let index = 0;

  const push = (): void => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  while (index < command.length) {
    const character = command[index] ?? '';
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      index += 1;
      continue;
    }
    if (character === '\\') {
      const next = command[index + 1];
      if (next !== undefined) {
        current += next;
        index += 2;
        continue;
      }
    }
    if (/\s/.test(character)) {
      push();
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  push();
  return tokens;
}

/** The command with every redirection removed. */
export function stripRedirections(command: string): string {
  return splitRedirects(command).text.trim();
}

/** The redirections of a command. */
export function shellRedirects(command: string): ShellRedirect[] {
  return splitRedirects(command).redirects;
}

/**
 * Strip the shell wrappers the target strips before matching.
 *
 * `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin` and `noglob`
 * are stripped, and a bare `xargs` is stripped. `direnv exec`, `devbox run`,
 * `mise exec`, `npx` and `docker exec` are **not** stripped: the target does not
 * strip them, so a rule written for the wrapped command does not fire.
 */
export function stripWrappers(command: string): string {
  let tokens = tokenizeShell(command);
  for (;;) {
    const first = tokens[0];
    if (first === undefined) break;
    if (first === 'xargs') {
      const second = tokens[1];
      if (second !== undefined && second.startsWith('-')) break;
      tokens = tokens.slice(1);
      continue;
    }
    if (!SHELL_WRAPPERS.has(first)) break;
    tokens = tokens.slice(1);
    if (first === 'timeout') {
      const next = tokens[0];
      if (next !== undefined && /^\d+[smhd]?$/.test(next)) tokens = tokens.slice(1);
      continue;
    }
    if (first === 'nice') {
      const next = tokens[0];
      if (next !== undefined && /^-n$/.test(next)) {
        tokens = tokens.slice(1);
        const adjustment = tokens[0];
        if (adjustment !== undefined) tokens = tokens.slice(1);
      }
      continue;
    }
    if (first === 'stdbuf') {
      const next = tokens[0];
      if (next !== undefined && /^-[iome]0$/.test(next)) tokens = tokens.slice(1);
      continue;
    }
  }
  return tokens.join(' ');
}

/**
 * The sub-commands of a command, with the wrappers and the redirections stripped.
 */
export function shellSubCommands(command: string): string[] {
  return splitShellCommand(command).map((part) => stripWrappers(stripRedirections(part)));
}

/** The program and the arguments of a command, with the wrappers stripped. */
export function shellInvocation(command: string): { program: string; args: string[] } {
  const tokens = tokenizeShell(stripWrappers(command));
  const program = tokens[0] ?? '';
  return { program, args: tokens.slice(1) };
}

// --- glob matching -------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a **command** pattern.
 *
 * `*` matches any characters (including spaces and slashes) and `?` matches one
 * character. This is the command-text flavour: a command pattern is not a path
 * pattern, so it does not stop at a path separator.
 */
export function commandGlobMatch(pattern: string, value: string): boolean {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '[\\s\\S]*';
    else if (character === '?') source += '[\\s\\S]';
    else source += escapeRegExp(character);
  }
  source += '$';
  return new RegExp(source).test(value);
}

function segmentGlobMatch(pattern: string, value: string): boolean {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += escapeRegExp(character);
  }
  source += '$';
  return new RegExp(source).test(value);
}

// --- path handling -------------------------------------------------------------

/** The two paths a path rule is matched against. */
export interface PathTargets {
  /** The requested path, made absolute and normalized but **not** symlink-resolved. */
  requested: string;
  /** The resolved target, with the symlinks followed. */
  resolved: string;
}

/**
 * Resolve the deepest existing ancestor of a path and re-append the missing tail.
 *
 * A path that does not exist yet still resolves through its deepest existing
 * ancestor, so a symlinked directory in the path is followed.
 */
function resolveDeepestExisting(absolute: string): string {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2));
  return input;
}

/**
 * The requested and the resolved path of a tool's path.
 *
 * The **requested** path is the path the tool asked for; the **resolved** path is
 * where the kernel would actually end up. An allow rule requires both to match; a
 * deny rule fires when either does.
 */
export function resolvePathTargets(input: string, opts: { cwd?: string } = {}): PathTargets {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const home = homedir();
  const requested = path.resolve(cwd, expandHome(input, home));
  return { requested, resolved: resolveDeepestExisting(requested) };
}

/**
 * Re-resolve a path **after** the permission check.
 *
 * The resolution taken before the check is a point-in-time fact: a symlink can be
 * swapped between the check and the write. The write path therefore re-resolves and
 * compares, rather than trusting the earlier result.
 */
export function reResolvePath(targets: PathTargets, opts: { cwd?: string } = {}): PathTargets {
  return resolvePathTargets(targets.requested, opts);
}

/** Whether two resolutions describe the same file. */
export function sameResolution(left: PathTargets, right: PathTargets): boolean {
  return left.resolved === right.resolved;
}

interface AnchoredPattern {
  /** The anchored pattern, split into path segments. */
  segments: string[];
  /** Whether the pattern named a single segment, and therefore matches at any depth. */
  singleSegment: boolean;
}

/**
 * Anchor a path pattern.
 *
 * `//path` resolves against the filesystem root, `~/path` against the home
 * directory, `/path` against the **settings source** directory, and `path` /
 * `./path` against the working directory.
 *
 * The settings source is the tier the rule came from, so a `/path` rule in the user
 * settings and a `/path` rule in the project settings anchor differently.
 */
export function anchorPathPattern(
  pattern: string,
  rules: RuleSet,
  source?: string,
): AnchoredPattern {
  const home = rules.homeDir ?? homedir();
  const cwd = path.resolve(rules.cwd ?? process.cwd());
  const settingsDir = settingsDirFor(rules, source);

  let base: string;
  let rest: string;
  if (pattern.startsWith('//')) {
    base = '/';
    rest = pattern.slice(2);
  } else if (pattern === '~') {
    base = home;
    rest = '';
  } else if (pattern.startsWith('~/')) {
    base = home;
    rest = pattern.slice(2);
  } else if (pattern.startsWith('/')) {
    base = settingsDir;
    rest = pattern.slice(1);
  } else if (pattern.startsWith('./')) {
    base = cwd;
    rest = pattern.slice(2);
  } else {
    base = cwd;
    rest = pattern;
  }

  const joined = rest.length > 0 ? path.join(base, rest) : base;
  const restSegments = rest.split('/').filter((segment) => segment.length > 0);
  return {
    segments: joined.split('/').filter((segment) => segment.length > 0),
    singleSegment: restSegments.length === 1,
  };
}

/**
 * The settings directory a rule's `/path` anchor resolves against.
 *
 * The lookup is an **own-property** check: the tier name is caller-supplied data.
 */
function settingsDirFor(rules: RuleSet, source?: string): string {
  const cwd = path.resolve(rules.cwd ?? process.cwd());
  if (source !== undefined) {
    const dirs = rules.settingsDirs;
    if (dirs && Object.hasOwn(dirs, source)) {
      const dir = dirs[source];
      if (typeof dir === 'string') return path.resolve(dir);
    }
  }
  return path.resolve(rules.settingsDir ?? cwd);
}

function matchSegments(pattern: string[], candidate: string[], pi: number, ci: number): boolean {
  if (pi >= pattern.length) {
    // The pattern is exhausted: it names a directory, so everything under it matches.
    return true;
  }
  if (ci >= candidate.length) return false;
  const segment = pattern[pi] ?? '';
  if (segment === '**') {
    for (let skip = ci; skip <= candidate.length; skip += 1) {
      if (matchSegments(pattern, candidate, pi + 1, skip)) return true;
    }
    return false;
  }
  if (!segmentGlobMatch(segment, candidate[ci] ?? '')) return false;
  return matchSegments(pattern, candidate, pi + 1, ci + 1);
}

/**
 * Whether a path pattern matches a candidate path.
 *
 * A deny or ask pattern that names a single segment matches that segment at any
 * depth; an allow pattern matches only at the anchored depth.
 */
export function pathPatternMatches(
  pattern: string,
  candidate: string,
  rules: RuleSet,
  kind: RuleListKind,
  source?: string,
): boolean {
  const anchored = anchorPathPattern(pattern, rules, source);
  if (anchored.segments.length === 0) return false;
  const candidateSegments = candidate.split('/').filter((segment) => segment.length > 0);
  if (matchSegments(anchored.segments, candidateSegments, 0, 0)) return true;
  if (kind === 'allow' || !anchored.singleSegment) return false;
  const segment = anchored.segments[anchored.segments.length - 1] ?? '';
  return candidateSegments.some((candidateSegment) => segmentGlobMatch(segment, candidateSegment));
}

/** Whether a path lies inside a directory. */
export function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Whether a path is **critical**: deleting or replacing it would break the session
 * or the machine, not just the project.
 *
 * The audit does not enumerate the critical paths, so the list is a implementation choice: the
 * filesystem root, the home directory, the working directory and its ancestors, the
 * configuration directory, and the credential directories.
 */
export function isCriticalPath(candidate: string, rules: RuleSet): boolean {
  const resolved = path.resolve(candidate);
  const home = path.resolve(rules.homeDir ?? homedir());
  const cwd = path.resolve(rules.cwd ?? process.cwd());

  if (resolved === path.parse(resolved).root) return true;
  if (resolved === home) return true;
  if (isInsideDirectory(cwd, resolved)) return true;
  if (resolved === path.join(home, '.claude')) return true;
  if (isInsideDirectory(path.join(home, '.claude'), resolved)) return true;
  if (isInsideDirectory(path.join(home, '.ssh'), resolved)) return true;
  if (isInsideDirectory(path.join(home, '.aws'), resolved)) return true;
  if (isInsideDirectory(path.join(cwd, '.git'), resolved)) return true;
  return false;
}

// --- rule parsing --------------------------------------------------------------

interface ParsedRule {
  raw: string;
  negated: boolean;
  toolName: string;
  /** The scoped matcher of a `Tool(matcher)` rule. */
  matcher: string | undefined;
  /** The parameter name of a `Tool(param:value)` rule. */
  param: string | undefined;
  /** The parameter value of a `Tool(param:value)` rule. */
  value: string | undefined;
  /** Whether the rule could not be parsed. */
  malformed: boolean;
}

/**
 * Parse a rule.
 *
 * The forms are `Tool`, `Tool(matcher)` and `Tool(param:value)`. A leading `!`
 * marks a negation.
 */
export function parseRule(raw: string): ParsedRule {
  const trimmed = raw.trim();
  let body = trimmed;
  let negated = false;
  if (body.startsWith('!')) {
    negated = true;
    body = body.slice(1).trim();
  }

  const open = body.indexOf('(');
  if (open === -1) {
    return {
      raw,
      negated,
      toolName: body,
      matcher: undefined,
      param: undefined,
      value: undefined,
      malformed: body.length === 0,
    };
  }

  if (!body.endsWith(')')) {
    return {
      raw,
      negated,
      toolName: body.slice(0, open).trim(),
      matcher: undefined,
      param: undefined,
      value: undefined,
      malformed: true,
    };
  }

  const toolName = body.slice(0, open).trim();
  const matcher = body.slice(open + 1, -1);
  const parameter = splitParameterRule(matcher);
  return {
    raw,
    negated,
    toolName,
    matcher: parameter === undefined ? matcher : undefined,
    param: parameter?.param,
    value: parameter?.value,
    malformed: toolName.length === 0,
  };
}

/**
 * Recognise the `Tool(param:value)` form.
 *
 * The prefix must be an identifier and the value must not start with `/`, so a
 * Windows-style `Edit(C:/src)` stays a path pattern.
 */
function splitParameterRule(matcher: string): { param: string; value: string } | undefined {
  const separator = matcher.indexOf(':');
  if (separator <= 0) return undefined;
  const param = matcher.slice(0, separator);
  const value = matcher.slice(separator + 1);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(param)) return undefined;
  if (value.length === 0) return undefined;
  if (value.startsWith('/')) return undefined;
  return { param, value };
}

/** The tier a rule came from. */
export function ruleSourceOf(rules: RuleSet, raw: string): string {
  const map = rules.ruleSources;
  if (map && Object.hasOwn(map, raw)) {
    const value = map[raw];
    if (typeof value === 'string') return value;
  }
  return rules.source ?? 'settings';
}

// --- rule matching -------------------------------------------------------------

interface MatchResult {
  matched: boolean;
  /** The sub-commands or paths that caused the match. */
  offending: string[];
  /** The number of sub-commands the command was split into. */
  total: number;
}

const NO_MATCH: MatchResult = { matched: false, offending: [], total: 0 };

interface MatchContext {
  rules: RuleSet;
  tool: ToolContext;
  kind: RuleListKind;
}

function matchRule(parsed: ParsedRule, context: MatchContext): MatchResult {
  const { tool } = context;
  if (parsed.malformed) return NO_MATCH;

  const sameTool = parsed.toolName === tool.toolName;

  // The parameter form `Tool(param:value)`.
  if (parsed.param !== undefined) {
    if (!sameTool) return NO_MATCH;
    // A parameter rule that names the tool's primary content field cannot be
    // applied to that field: the rule is ignored. `collectRuleWarnings` reports the
    // ignored rule to the user.
    const primary = primaryFieldsFor(tool.toolName);
    if (primary.includes(parsed.param)) return NO_MATCH;
    const value = readInputField(tool.input, parsed.param);
    if (typeof value !== 'string') return NO_MATCH;
    return commandGlobMatch(parsed.value ?? '', value)
      ? { matched: true, offending: [value], total: 1 }
      : NO_MATCH;
  }

  if (tool.toolName === 'Bash') {
    // A shell call is matched by the Bash rules, and by the path rules of the file
    // tools for its **redirection targets**: a redirect is a file operation, so a
    // write redirect is checked against the Edit rules and a read redirect against
    // the Read rules.
    if (sameTool) return matchCommandRule(parsed, context);
    return matchRedirectTargetRule(parsed, context);
  }

  if (!sameTool) return NO_MATCH;

  if (parsed.matcher === undefined) {
    // A bare tool name matches every call of that tool.
    return { matched: true, offending: [], total: 1 };
  }

  const toolPath = extractToolPath(tool);
  if (toolPath !== undefined) {
    return matchPathRule(
      parsed.matcher,
      toolPath,
      context,
      ruleSourceOf(context.rules, parsed.raw),
    );
  }

  const primary = extractPrimaryValue(tool);
  if (primary !== undefined) {
    return commandGlobMatch(parsed.matcher, primary)
      ? { matched: true, offending: [primary], total: 1 }
      : NO_MATCH;
  }
  return NO_MATCH;
}

/** The tools whose rules describe a write to a file. */
const REDIRECT_WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

/** The tools whose rules describe a read of a file. */
const REDIRECT_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS']);

/**
 * Match a rule against the **redirection targets** of a shell command.
 *
 * A redirect is a file operation: a write redirect (`>`, `>>`, `&>`) is checked
 * against the Edit/Write rules, and a read redirect (`<`) against the Read rules.
 * Only a scoped path rule of such a tool applies; a bare tool rule means "every
 * call of that tool", not "every file write".
 */
function matchRedirectTargetRule(parsed: ParsedRule, context: MatchContext): MatchResult {
  const { tool, kind } = context;
  if (parsed.matcher === undefined) return NO_MATCH;

  const writes = REDIRECT_WRITE_TOOLS.has(parsed.toolName);
  const reads = REDIRECT_READ_TOOLS.has(parsed.toolName);
  if (!writes && !reads) return NO_MATCH;

  const command = extractPrimaryValue(tool);
  if (command === undefined) return NO_MATCH;

  const redirects = shellRedirects(command).filter(
    (redirect) => redirect.target !== undefined && redirect.writes === writes,
  );
  if (redirects.length === 0) return NO_MATCH;

  const matchedTargets: string[] = [];
  const blockedTargets: string[] = [];
  const source = ruleSourceOf(context.rules, parsed.raw);
  for (const redirect of redirects) {
    const target = redirect.target;
    if (target === undefined) continue;
    const match = matchPathRule(parsed.matcher, target, context, source);
    if (match.matched) matchedTargets.push(target);
    else blockedTargets.push(target);
  }

  if (kind === 'allow') {
    // An allow rule approves the redirects only when **every** target matches.
    if (matchedTargets.length !== redirects.length) {
      return { matched: false, offending: blockedTargets, total: redirects.length };
    }
    return { matched: true, offending: [], total: redirects.length };
  }
  // A deny or ask rule fires when **any** target matches.
  if (matchedTargets.length === 0) {
    return { matched: false, offending: [], total: redirects.length };
  }
  return { matched: true, offending: matchedTargets, total: redirects.length };
}

function matchCommandRule(parsed: ParsedRule, context: MatchContext): MatchResult {
  const command = extractPrimaryValue(context.tool);
  if (command === undefined) return NO_MATCH;
  const pattern = parsed.matcher;
  if (pattern === undefined) {
    // A bare `Bash` rule matches every shell call.
    return { matched: true, offending: [], total: 1 };
  }
  const subCommands = shellSubCommands(command);
  if (subCommands.length === 0) return NO_MATCH;

  const matching = subCommands.filter((subCommand) => commandGlobMatch(pattern, subCommand));
  if (context.kind === 'allow') {
    // An allow rule approves the chain only when **every** sub-command matches.
    const blocking = subCommands.filter((subCommand) => !commandGlobMatch(pattern, subCommand));
    return {
      matched: blocking.length === 0,
      offending: blocking,
      total: subCommands.length,
    };
  }
  // A deny or ask rule fires when **any** sub-command matches.
  return {
    matched: matching.length > 0,
    offending: matching,
    total: subCommands.length,
  };
}

function matchPathRule(
  pattern: string,
  toolPath: string,
  context: MatchContext,
  source?: string,
): MatchResult {
  const { rules, kind } = context;
  const targets = resolvePathTargets(toolPath, { cwd: rules.cwd });
  const requestedMatches = pathPatternMatches(pattern, targets.requested, rules, kind, source);
  const resolvedMatches = pathPatternMatches(pattern, targets.resolved, rules, kind, source);

  if (kind === 'allow') {
    // An allow rule requires **both** the requested path and the resolved target to
    // match: a symlink out of the allowed area must not inherit the allowance.
    const matched = requestedMatches && resolvedMatches;
    return {
      matched,
      offending: matched ? [] : [targets.requested, targets.resolved],
      total: 2,
    };
  }
  // A deny rule fires when **either** matches.
  const matched = requestedMatches || resolvedMatches;
  return {
    matched,
    offending: matched ? [requestedMatches ? targets.requested : targets.resolved] : [],
    total: 2,
  };
}

// --- the evaluator -------------------------------------------------------------

/**
 * Evaluate the rule lists against a tool call.
 *
 * The lists are scanned `deny` → `ask` → `allow`, and the first rule **in a list**
 * that matches is the rule that matched: specificity is irrelevant, and an allow
 * rule can never carve an exception out of a deny.
 *
 * Returns `undefined` when nothing matched, so the caller can escalate to a prompt.
 * The decision never carries a rewritten tool input — a rule is a pure predicate.
 */
export function evaluateRules(rules: RuleSet, tool: ToolContext): RuleDecision | undefined {
  for (const kind of ['deny', 'ask', 'allow'] as const) {
    const decision = evaluateRuleList(rules, rules[kind], kind, tool);
    if (decision) return decision;
  }
  return undefined;
}

/**
 * Evaluate one rule list.
 *
 * The exported form is the building block the mode layer uses: the deny list is
 * evaluated on its own, before the mode is taken into account, because a deny rule
 * blocks in **every** mode.
 */
export function evaluateRuleList(
  rules: RuleSet,
  list: readonly string[],
  kind: RuleListKind,
  tool: ToolContext,
): RuleDecision | undefined {
  const context: MatchContext = { rules, tool, kind };
  const negations = list.filter((entry) => parseRule(entry).negated);

  for (const entry of list) {
    const parsed = parseRule(entry);
    if (parsed.negated) continue;
    if (parsed.malformed) continue;

    const match = matchRule(parsed, context);
    if (!match.matched) continue;

    if (isCancelledByNegation(parsed, negations, context)) continue;

    return buildDecision(kind, parsed, match, rules, tool);
  }
  return undefined;
}

/**
 * Whether a matching rule is cancelled by a negation.
 *
 * A negation only cancels a rule from the **same tier**, because a negation written
 * in one settings file must not cancel a rule the user wrote in another one.
 */
function isCancelledByNegation(
  parsed: ParsedRule,
  negations: readonly string[],
  context: MatchContext,
): boolean {
  const ruleSource = ruleSourceOf(context.rules, parsed.raw);
  for (const negation of negations) {
    const negated = parseRule(negation);
    if (!negated.negated) continue;
    if (ruleSourceOf(context.rules, negated.raw) !== ruleSource) continue;
    if (matchRule(negated, context).matched) return true;
  }
  return false;
}

function buildDecision(
  kind: RuleListKind,
  parsed: ParsedRule,
  match: MatchResult,
  rules: RuleSet,
  tool: ToolContext,
): RuleDecision {
  const behavior = kind === 'deny' ? 'deny' : kind === 'ask' ? 'ask' : 'allow';
  const decision: RuleDecision = {
    behavior,
    source: 'unknown',
    reasonType: 'rule',
    reasonKind: 'rule',
    rule: { content: parsed.raw, source: ruleSourceOf(rules, parsed.raw) },
  };

  // A compound command names the offending sub-commands and counts the parts that
  // need approval; a single operation is reported as the rule that matched, but it
  // still carries the stripped sub-command it matched.
  if (tool.toolName === 'Bash' && match.offending.length > 0) {
    decision.subcommandResults = {
      commands: match.offending,
      count: match.offending.length,
      total: match.total,
    };
    if (match.total > 1 && (behavior === 'ask' || behavior === 'deny')) {
      decision.reasonKind = 'subcommandResults';
    }
  }

  decision.reason = describeReason(decision, tool.toolName);
  return decision;
}

/**
 * The warnings a tool call produces: the rules that were ignored.
 *
 * A rule that names the tool's primary content field through the `param:value` form
 * cannot be applied to that field, so it is ignored — and the user is warned,
 * because an ignored **deny** rule protects nothing. A malformed rule is ignored for
 * the same reason.
 */
export function collectRuleWarnings(rules: RuleSet, tool: ToolContext): string[] {
  const warnings: string[] = [];
  const primary = primaryFieldsFor(tool.toolName);

  for (const entry of [...rules.deny, ...rules.ask, ...rules.allow]) {
    const parsed = parseRule(entry);
    if (parsed.negated) continue;
    if (parsed.malformed) {
      warnings.push(`Permission rule '${entry}' is malformed and was ignored.`);
      continue;
    }
    if (parsed.param === undefined) continue;
    if (parsed.toolName !== tool.toolName) continue;
    if (!primary.includes(parsed.param)) continue;
    warnings.push(
      `Permission rule '${entry}' is ignored: '${parsed.param}' is the primary content field of ${tool.toolName}, so a ${tool.toolName}(<pattern>) rule is required instead.`,
    );
  }
  return warnings;
}

// --- reason text ---------------------------------------------------------------

/**
 * The user-facing text for a decision.
 *
 * The reason kinds are the ones the audit records: `rule`,
 * `subcommandResults`, `permissionPromptTool`, `sandboxOverride`, `workingDir` and
 * `safetyCheck`.
 */
export function describeReason(decision: PermissionDecision, toolName: string): string {
  const kind: PermissionReasonKind | 'other' =
    decision.reasonKind ??
    (decision.reasonType === 'rule'
      ? 'rule'
      : decision.reasonType === 'safetyCheck'
        ? 'safetyCheck'
        : 'other');

  switch (kind) {
    case 'rule':
      return describeRuleReason(decision, toolName);
    case 'subcommandResults':
      return describeSubcommandReason(decision, toolName);
    case 'permissionPromptTool':
      return `The ${toolName} tool requires approval for this command.`;
    case 'sandboxOverride':
      return 'Run outside of the sandbox';
    case 'workingDir':
      return decision.reason ?? `This ${toolName} call is allowed because it stays inside the working directory.`;
    case 'safetyCheck':
      return decision.reason ?? `A safety check refused this ${toolName} call.`;
    default:
      return decision.reason ?? `This ${toolName} call requires approval.`;
  }
}

function describeRuleReason(decision: PermissionDecision, toolName: string): string {
  const rule = decision.rule;
  if (!rule) return decision.reason ?? `This ${toolName} call requires approval.`;
  const attribution = `Permission rule '${rule.content}' from ${rule.source}`;
  if (decision.behavior === 'deny') return `${attribution} denies this ${toolName} call.`;
  if (decision.behavior === 'allow') return `${attribution} allows this ${toolName} call.`;
  return `${attribution} requires approval for this ${toolName} command.`;
}

function describeSubcommandReason(decision: PermissionDecision, toolName: string): string {
  const subcommands = decision.subcommandResults;
  if (!subcommands) return decision.reason ?? `This ${toolName} call requires approval.`;
  const rule = decision.rule;
  const attribution = rule ? `Permission rule '${rule.content}' from ${rule.source}` : 'The command';
  const list = subcommands.commands.join(', ');
  if (decision.behavior === 'deny') {
    return `${attribution} denies ${subcommands.count} of ${subcommands.total} parts of this command: ${list}.`;
  }
  return `${attribution} requires approval for ${subcommands.count} of ${subcommands.total} parts of this command: ${list}.`;
}
