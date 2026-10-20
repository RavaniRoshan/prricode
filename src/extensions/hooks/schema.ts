/**
 * The hook surface's schemas: the matcher, the payload the hooks receive, and
 * the JSON a hook writes back.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("Hook matchers",
 * "Hook outputs") and `docs/compatibility/extension-surface.md` ("The matcher
 * semantics", "The exit-code contract"), and the `CC-012` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The matcher has two modes
 *
 * The audit's matcher syntax is `/^[a-zA-Z0-9_|, -]+$/` with `|` and `,`
 * separators and `*` wildcards, and the compatibility table states the rule
 * precisely:
 *
 *   - a matcher that contains **only** letters, digits, `_`, `-`, space, `,`
 *     and `|` is an **exact-string** match (or a `|`-separated list of them);
 *   - anything else is an **unanchored JavaScript regular expression**.
 *
 * So `mcp__memory` matches nothing (it is not a tool name), while
 * `mcp__memory__.*` matches every tool of that server.
 *
 * ## The regular expression is compiled to a non-backtracking program
 *
 * A matcher is **user-written data** and a tool name is **model- or
 * user-supplied data**, so the matcher is run against text this implementation does not
 * control. Running such a pattern with `RegExp` is a denial-of-service risk:
 * a pattern like `(a+)+$` against a long run of `a`s backtracks
 * exponentially, and a plain length bound does not help — the blow-up comes
 * from the *pattern*, not from the input.
 *
 * This implementation therefore **compiles the pattern to a Thompson NFA and simulates
 * it**. The simulation is O(input × states): it never backtracks, so no
 * pattern can make it take super-linear time. The price is that the supported
 * subset is a subset of JavaScript's regular expressions; a pattern outside the
 * subset is **rejected** (it matches nothing) rather than run with a risk of
 * hanging. The supported subset is:
 *
 *   - literals, `.`, `^`, `$`;
 *   - the character classes `\d \D \w \W \s \S` and `\b \B`;
 *   - character classes `[...]` with ranges and negation;
 *   - groups `(...)` and `(?:...)`;
 *   - alternation `|`;
 *   - the quantifiers `*`, `+`, `?`, `{n}`, `{n,}` and `{n,m}`;
 *   - the escapes `\n \r \t \f \v \0`, `\xHH`, `\uHHHH`, `\u{...}`, and an
 *     escaped metacharacter.
 *
 * Lookaround, named groups and backreferences are **rejected**: they are not
 * regular, and a matcher that needs them is refused rather than run.
 *
 * ## The payload
 *
 * The payload the target hands a hook carries `session_id`, `prompt_id`,
 * `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort.level`
 * and `hook_event_name`, plus `agent_id` and `agent_type` for a subagent. The
 * payload is written to the hook's standard input as one JSON document.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - **The payload is built from the caller's input and the context**, and the
 *     context wins for the common fields. The caller's input keeps every key
 *     it brought, because the event-specific fields (`tool_name`, `tool_input`,
 *     the prompt, the MCP server name) live there.
 *   - **A `__proto__` key in the caller's input is dropped.** Copying it into
 *     the payload would set the payload's prototype, and the payload is JSON
 *     that a hook reads.
 *   - **The JSON a hook writes is read tolerantly.** A hook that writes
 *     something that is not JSON contributes nothing; it is not an error.
 */

import type { PermissionMode } from '../../permissions/decision.js';
import type { HookEvent } from './registry.js';

/**
 * The events on which a hook's exit code `2` **blocks**.
 *
 * A blockable event is one where a block has a meaning: the tool call is
 * refused, the prompt is refused, or the turn does not stop. On every other
 * event an exit code of `2` is a non-blocking error, because there is nothing
 * to block.
 *
 * The set is the decision-capable events plus `PermissionRequest`, which the
 * audit records as carrying a decision of its own.
 */
export const BLOCKABLE_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PermissionDenied',
  'PermissionRequest',
];

/** Whether an exit code of `2` blocks on an event. */
export function isBlockableEvent(event: HookEvent): boolean {
  return BLOCKABLE_EVENTS.includes(event);
}

/**
 * The events that fire **before** the session's MCP servers are available.
 *
 * An `mcp_tool` hook is skipped there: the server it names cannot be called
 * yet.
 */
export const EVENTS_WITHOUT_MCP_SERVERS: readonly HookEvent[] = ['SessionStart', 'Setup'];

/** Whether the session's MCP servers are available at an event. */
export function mcpServersAvailable(event: HookEvent): boolean {
  return !EVENTS_WITHOUT_MCP_SERVERS.includes(event);
}

// --- the matcher -----------------------------------------------------------------

/**
 * The matcher syntax that is an **exact-string** match.
 *
 * The audit's own expression: letters, digits, `_`, `|`, `,`, space and `-`.
 */
const SIMPLE_MATCHER = /^[a-zA-Z0-9_|, -]+$/;

/**
 * The longest input the matcher is run against.
 *
 * The matcher is linear in the input, so the bound is a guard against a
 * pathological tool name rather than a guard against backtracking.
 */
export const MAX_MATCH_INPUT_LENGTH = 1024;

/** The longest pattern the matcher accepts. */
export const MAX_MATCH_PATTERN_LENGTH = 1024;

/** The largest repetition count the matcher expands. */
export const MAX_MATCH_REPEAT = 64;

/** A compiled matcher. */
export interface CompiledMatcher {
  /** Which of the two modes the matcher was compiled in. */
  readonly kind: 'exact' | 'regex';
  /** Whether the matcher matches a tool name. */
  test(toolName: string): boolean;
}

/** The outcome of compiling a matcher. */
export type MatcherCompilation =
  | { ok: true; matcher: CompiledMatcher }
  | { ok: false; reason: string };

/** A matcher that cannot be compiled. */
export class MatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatcherError';
  }
}

/**
 * The compiled matchers, cached.
 *
 * A matcher is compiled once and then reused: the registry asks the same
 * matcher the same question for every tool call. The cache is bounded and is
 * cleared when it is full, so a session that names thousands of matchers
 * cannot grow it without limit.
 */
const matcherCache = new Map<string, MatcherCompilation>();
const MAX_CACHED_MATCHERS = 256;

function cachedMatcher(matcher: string): MatcherCompilation {
  const cached = matcherCache.get(matcher);
  if (cached !== undefined) return cached;
  const compiled = compileMatcher(matcher);
  if (matcherCache.size >= MAX_CACHED_MATCHERS) matcherCache.clear();
  matcherCache.set(matcher, compiled);
  return compiled;
}

/**
 * Whether a matcher matches a tool name.
 *
 * A matcher that cannot be compiled matches **nothing**: a malformed matcher is
 * rejected rather than silently treated as a literal.
 */
export function matchToolName(matcher: string, toolName: string): boolean {
  const compiled = cachedMatcher(matcher);
  if (!compiled.ok) return false;
  return compiled.matcher.test(toolName);
}

/**
 * Compile a matcher.
 *
 * The two modes are the audit's: the simple syntax is an exact-string (or
 * `|`-separated) match, and anything else is an unanchored regular
 * expression.
 */
export function compileMatcher(matcher: string): MatcherCompilation {
  if (typeof matcher !== 'string') {
    return { ok: false, reason: 'the matcher is not a string' };
  }
  if (matcher.length > MAX_MATCH_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `the matcher is longer than ${MAX_MATCH_PATTERN_LENGTH} characters`,
    };
  }
  if (matcher.length === 0) {
    return { ok: false, reason: 'the matcher is empty' };
  }

  if (SIMPLE_MATCHER.test(matcher)) {
    const alternatives = matcher
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (alternatives.length === 0) {
      return { ok: false, reason: 'the matcher names no tool' };
    }
    const names = new Set(alternatives);
    return {
      ok: true,
      matcher: {
        kind: 'exact',
        test(toolName: string): boolean {
          return names.has(toolName);
        },
      },
    };
  }

  try {
    const program = compilePattern(matcher);
    return {
      ok: true,
      matcher: {
        kind: 'regex',
        test(toolName: string): boolean {
          if (toolName.length > MAX_MATCH_INPUT_LENGTH) return false;
          return runProgram(program, toolName);
        },
      },
    };
  } catch (error) {
    const reason = error instanceof MatcherError ? error.message : 'the matcher is malformed';
    return { ok: false, reason };
  }
}

// --- the regular expression engine -----------------------------------------------

/** A test of one character. */
type CharPredicate = (char: string) => boolean;

/** The parsed form of a pattern. */
type PatternAst =
  | { kind: 'empty' }
  | { kind: 'char'; test: CharPredicate }
  | { kind: 'assert'; when: Assertion }
  | { kind: 'concat'; parts: PatternAst[] }
  | { kind: 'alt'; options: PatternAst[] }
  | { kind: 'repeat'; body: PatternAst; min: number; max: number | null };

/** The zero-width assertions this implementation supports. */
type Assertion = 'start' | 'end' | 'wordBoundary' | 'notWordBoundary';

function literal(char: string): CharPredicate {
  return (candidate: string): boolean => candidate === char;
}

function anyChar(candidate: string): boolean {
  return candidate !== '\n';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isWordChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_'
  );
}

function isSpaceChar(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

/** A member of a character class that is a single character or a shorthand. */
type EscapeMember =
  | { kind: 'char'; value: string }
  | { kind: 'predicate'; test: CharPredicate };

/** One member of a character class. */
type ClassMember = EscapeMember | { kind: 'range'; from: string; to: string };

/**
 * The pattern parser.
 *
 * It parses the supported subset of JavaScript's regular expression syntax
 * into a tree; the tree is then compiled to a Thompson NFA. Anything outside
 * the subset raises a `MatcherError`, which the compiler turns into a
 * rejection.
 */
class PatternParser {
  private readonly source: string;
  private index = 0;

  constructor(source: string) {
    this.source = source;
  }

  parse(): PatternAst {
    const ast = this.parseAlternation();
    if (this.index !== this.source.length) {
      throw new MatcherError(`unexpected '${this.peek()}' at position ${this.index}`);
    }
    return ast;
  }

  private peek(offset = 0): string {
    return this.source.charAt(this.index + offset);
  }

  private eof(): boolean {
    return this.index >= this.source.length;
  }

  private parseAlternation(): PatternAst {
    const first = this.parseConcat();
    if (this.peek() !== '|') return first;
    const options: PatternAst[] = [first];
    while (this.peek() === '|') {
      this.index += 1;
      options.push(this.parseConcat());
    }
    return { kind: 'alt', options };
  }

  private parseConcat(): PatternAst {
    const parts: PatternAst[] = [];
    while (!this.eof()) {
      const char = this.peek();
      if (char === '|' || char === ')') break;
      if (char === '*') {
        // A `*` with nothing to repeat is the target's wildcard: it matches any
        // sequence of characters.
        if (parts.length > 0) {
          throw new MatcherError(`a quantifier has nothing to repeat at position ${this.index}`);
        }
        this.index += 1;
        parts.push({ kind: 'repeat', body: { kind: 'char', test: anyChar }, min: 0, max: null });
        continue;
      }
      if (char === '+' || char === '?') {
        throw new MatcherError(`a quantifier has nothing to repeat at position ${this.index}`);
      }
      parts.push(this.parseRepeat());
    }
    if (parts.length === 0) return { kind: 'empty' };
    const first = parts[0];
    if (first === undefined) return { kind: 'empty' };
    if (parts.length === 1) return first;
    return { kind: 'concat', parts };
  }

  private parseRepeat(): PatternAst {
    const atom = this.parseAtom();
    const quantifier = this.parseQuantifier();
    if (!quantifier) return atom;

    // A lazy quantifier matches the same language, so the program does not
    // need to know about it.
    if (this.peek() === '?') this.index += 1;

    const after = this.peek();
    if (after === '*' || after === '+' || after === '?') {
      throw new MatcherError(`two quantifiers in a row at position ${this.index}`);
    }

    return { kind: 'repeat', body: atom, min: quantifier.min, max: quantifier.max };
  }

  private parseQuantifier(): { min: number; max: number | null } | undefined {
    const char = this.peek();
    if (char === '*') {
      this.index += 1;
      return { min: 0, max: null };
    }
    if (char === '+') {
      this.index += 1;
      return { min: 1, max: null };
    }
    if (char === '?') {
      this.index += 1;
      return { min: 0, max: 1 };
    }
    if (char === '{') {
      const counted = this.tryParseCounted();
      if (counted) return counted;
    }
    return undefined;
  }

  private tryParseCounted(): { min: number; max: number | null } | undefined {
    const start = this.index;
    this.index += 1;
    const digits = this.readDigits();
    if (digits === undefined || digits.length === 0) {
      this.index = start;
      return undefined;
    }
    const min = Number.parseInt(digits, 10);
    if (this.peek() === '}') {
      this.index += 1;
      return { min, max: min };
    }
    if (this.peek() === ',') {
      this.index += 1;
      const more = this.readDigits();
      if (this.peek() === '}') {
        this.index += 1;
        return { min, max: more === undefined || more.length === 0 ? null : Number.parseInt(more, 10) };
      }
    }
    this.index = start;
    return undefined;
  }

  private readDigits(): string | undefined {
    let digits = '';
    while (!this.eof()) {
      const char = this.peek();
      if (char < '0' || char > '9') break;
      digits += char;
      this.index += 1;
    }
    return digits.length > 0 ? digits : undefined;
  }

  private parseAtom(): PatternAst {
    const char = this.peek();
    if (char === '(') return this.parseGroup();
    if (char === '[') return this.parseClass();
    if (char === '.') {
      this.index += 1;
      return { kind: 'char', test: anyChar };
    }
    if (char === '^') {
      this.index += 1;
      return { kind: 'assert', when: 'start' };
    }
    if (char === '$') {
      this.index += 1;
      return { kind: 'assert', when: 'end' };
    }
    if (char === '\\') return this.parseEscape();
    if (char === ')') {
      throw new MatcherError(`unbalanced ')' at position ${this.index}`);
    }
    if (char === '*' || char === '+' || char === '?') {
      throw new MatcherError(`a quantifier has nothing to repeat at position ${this.index}`);
    }
    this.index += 1;
    return { kind: 'char', test: literal(char) };
  }

  private parseGroup(): PatternAst {
    const start = this.index;
    this.index += 1;
    if (this.peek() === '?') {
      const next = this.peek(1);
      if (next !== ':') {
        throw new MatcherError(
          `only a non-capturing group (?:...) is supported (position ${start})`,
        );
      }
      this.index += 2;
    }
    const body = this.parseAlternation();
    if (this.peek() !== ')') {
      throw new MatcherError(`unbalanced '(' at position ${start}`);
    }
    this.index += 1;
    return body;
  }

  private parseClass(): PatternAst {
    const start = this.index;
    this.index += 1;
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.index += 1;
    }

    const members: ClassMember[] = [];
    let first = true;
    for (;;) {
      if (this.eof()) {
        throw new MatcherError(`unterminated character class at position ${start}`);
      }
      const char = this.peek();
      if (char === ']' && !first) {
        this.index += 1;
        break;
      }
      first = false;

      const lower = this.readClassMember();
      if (lower === undefined) {
        throw new MatcherError(`unterminated character class at position ${start}`);
      }
      if (this.peek() === '-' && this.peek(1) !== ']' && !this.eof()) {
        this.index += 1;
        const upper = this.readClassMember();
        if (upper === undefined) {
          throw new MatcherError(`unterminated character class at position ${start}`);
        }
        if (lower.kind !== 'char' || upper.kind !== 'char') {
          throw new MatcherError(`a character range at position ${start} is not a range`);
        }
        if (upper.value < lower.value) {
          throw new MatcherError(`the character range at position ${start} is reversed`);
        }
        members.push({ kind: 'range', from: lower.value, to: upper.value });
        continue;
      }
      members.push(lower);
    }

    const test = (candidate: string): boolean => {
      let matched = false;
      for (const member of members) {
        if (member.kind === 'char') {
          if (member.value === candidate) matched = true;
          continue;
        }
        if (member.kind === 'predicate') {
          if (member.test(candidate)) matched = true;
          continue;
        }
        if (candidate >= member.from && candidate <= member.to) matched = true;
      }
      return negated ? !matched : matched;
    };
    return { kind: 'char', test };
  }

  private readClassMember(): ClassMember | undefined {
    if (this.eof()) return undefined;
    const char = this.peek();
    if (char === '\\') {
      const escaped = this.readEscapeChar();
      if (escaped === undefined) return undefined;
      return escaped;
    }
    this.index += 1;
    return { kind: 'char', value: char };
  }

  private parseEscape(): PatternAst {
    // Outside a character class `\b` is a word boundary and `\B` is its
    // negation; inside a class `\b` is the backspace character.
    const next = this.peek(1);
    if (next === 'b') {
      this.index += 2;
      return { kind: 'assert', when: 'wordBoundary' };
    }
    if (next === 'B') {
      this.index += 2;
      return { kind: 'assert', when: 'notWordBoundary' };
    }
    const escaped = this.readEscapeChar();
    if (escaped === undefined) {
      throw new MatcherError('the pattern ends with a backslash');
    }
    if (escaped.kind === 'char') {
      return { kind: 'char', test: literal(escaped.value) };
    }
    return { kind: 'char', test: escaped.test };
  }

  private readEscapeChar(): EscapeMember | undefined {
    // The backslash is the current character.
    this.index += 1;
    if (this.eof()) return undefined;
    const char = this.peek();
    this.index += 1;
    switch (char) {
      case 'd':
        return { kind: 'predicate', test: isDigit };
      case 'D':
        return { kind: 'predicate', test: (candidate: string) => !isDigit(candidate) };
      case 'w':
        return { kind: 'predicate', test: isWordChar };
      case 'W':
        return { kind: 'predicate', test: (candidate: string) => !isWordChar(candidate) };
      case 's':
        return { kind: 'predicate', test: isSpaceChar };
      case 'S':
        return { kind: 'predicate', test: (candidate: string) => !isSpaceChar(candidate) };
      case 'b':
        return { kind: 'char', value: '\b' };
      case 'n':
        return { kind: 'char', value: '\n' };
      case 'r':
        return { kind: 'char', value: '\r' };
      case 't':
        return { kind: 'char', value: '\t' };
      case 'f':
        return { kind: 'char', value: '\f' };
      case 'v':
        return { kind: 'char', value: '\v' };
      case '0':
        return { kind: 'char', value: '\0' };
      case 'x':
        return this.readHexEscape(2);
      case 'u':
        return this.readUnicodeEscape();
      default:
        if (char >= '1' && char <= '9') {
          throw new MatcherError('a backreference is not supported');
        }
        return { kind: 'char', value: char };
    }
  }

  private readHexEscape(length: number): EscapeMember {
    let hex = '';
    for (let i = 0; i < length; i += 1) {
      const char = this.peek();
      if (!/[0-9a-fA-F]/.test(char)) {
        throw new MatcherError('a hexadecimal escape is malformed');
      }
      hex += char;
      this.index += 1;
    }
    return { kind: 'char', value: String.fromCharCode(Number.parseInt(hex, 16)) };
  }

  private readUnicodeEscape(): EscapeMember {
    if (this.peek() === '{') {
      this.index += 1;
      let hex = '';
      while (!this.eof() && this.peek() !== '}') {
        const char = this.peek();
        if (!/[0-9a-fA-F]/.test(char)) {
          throw new MatcherError('a unicode escape is malformed');
        }
        hex += char;
        this.index += 1;
      }
      if (this.peek() !== '}') {
        throw new MatcherError('a unicode escape is malformed');
      }
      this.index += 1;
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code) || code > 0x10ffff) {
        throw new MatcherError('a unicode escape is out of range');
      }
      return { kind: 'char', value: String.fromCodePoint(code) };
    }
    return this.readHexEscape(4);
  }
}

/** The nodes of the compiled program. */
type NfaNode =
  | { kind: 'char'; test: CharPredicate; out: number }
  | { kind: 'assert'; when: Assertion; out: number }
  | { kind: 'split'; a: number; b: number }
  | { kind: 'empty' }
  | { kind: 'match' };

/** A compiled program. */
interface NfaProgram {
  nodes: NfaNode[];
  start: number;
  match: number;
}

/** A fragment of the program under construction. */
interface Fragment {
  start: number;
  outs: number[];
}

/** Builds the Thompson NFA. */
class NfaBuilder {
  readonly nodes: NfaNode[] = [];

  emit(node: NfaNode): number {
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  patch(outs: number[], target: number): void {
    for (const id of outs) {
      const node = this.nodes[id];
      if (node === undefined) continue;
      if (node.kind === 'split') node.b = target;
      else if (node.kind === 'char' || node.kind === 'assert') node.out = target;
    }
  }

  compile(ast: PatternAst): Fragment {
    switch (ast.kind) {
      case 'empty': {
        const id = this.emit({ kind: 'empty' });
        return { start: id, outs: [] };
      }
      case 'char': {
        const id = this.emit({ kind: 'char', test: ast.test, out: -1 });
        return { start: id, outs: [id] };
      }
      case 'assert': {
        const id = this.emit({ kind: 'assert', when: ast.when, out: -1 });
        return { start: id, outs: [id] };
      }
      case 'concat':
        return this.concat(ast.parts.map((part) => this.compile(part)));
      case 'alt':
        return this.alternate(ast.options.map((option) => this.compile(option)));
      case 'repeat':
        return this.repeat(ast);
    }
  }

  private concat(parts: Fragment[]): Fragment {
    if (parts.length === 0) return this.compile({ kind: 'empty' });
    const first = parts[0];
    if (first === undefined) return this.compile({ kind: 'empty' });
    let previous = first;
    for (let i = 1; i < parts.length; i += 1) {
      const fragment = parts[i];
      if (fragment === undefined) continue;
      this.patch(previous.outs, fragment.start);
      previous = fragment;
    }
    return { start: first.start, outs: previous.outs };
  }

  private alternate(options: Fragment[]): Fragment {
    if (options.length === 0) return this.compile({ kind: 'empty' });
    const first = options[0];
    if (first === undefined) return this.compile({ kind: 'empty' });
    if (options.length === 1) return first;

    // The options are chained through split nodes, built from the last one
    // back. The continuation of every option is the fragment's own
    // continuation, so the options' outs are **not** patched here.
    let nextStart = first.start;
    const last = options[options.length - 1];
    if (last === undefined) return first;
    nextStart = last.start;
    for (let i = options.length - 2; i >= 0; i -= 1) {
      const option = options[i];
      if (option === undefined) continue;
      const splitId = this.emit({ kind: 'split', a: option.start, b: nextStart });
      nextStart = splitId;
    }
    const outs: number[] = [];
    for (const option of options) {
      if (option === undefined) continue;
      outs.push(...option.outs);
    }
    return { start: nextStart, outs };
  }

  private repeat(ast: { body: PatternAst; min: number; max: number | null }): Fragment {
    const { body, min, max } = ast;
    if (min > MAX_MATCH_REPEAT || (max !== null && max > MAX_MATCH_REPEAT)) {
      throw new MatcherError(`a repetition count is larger than ${MAX_MATCH_REPEAT}`);
    }
    const parts: Fragment[] = [];
    for (let i = 0; i < min; i += 1) parts.push(this.compile(body));
    if (max === null) {
      parts.push(this.star(body));
    } else {
      for (let i = min; i < max; i += 1) parts.push(this.optional(body));
    }
    return this.concat(parts);
  }

  private star(body: PatternAst): Fragment {
    const splitId = this.emit({ kind: 'split', a: -1, b: -1 });
    const bodyFragment = this.compile(body);
    this.patch(bodyFragment.outs, splitId);
    const node = this.nodes[splitId];
    if (node !== undefined && node.kind === 'split') node.a = bodyFragment.start;
    return { start: splitId, outs: [splitId] };
  }

  private optional(body: PatternAst): Fragment {
    const bodyFragment = this.compile(body);
    const splitId = this.emit({ kind: 'split', a: bodyFragment.start, b: -1 });
    this.patch(bodyFragment.outs, splitId);
    return { start: splitId, outs: [splitId] };
  }
}

/** Compile a pattern into a program. */
function compilePattern(pattern: string): NfaProgram {
  const ast = new PatternParser(pattern).parse();
  const builder = new NfaBuilder();
  const fragment = builder.compile(ast);
  const matchId = builder.emit({ kind: 'match' });
  builder.patch(fragment.outs, matchId);
  return { nodes: builder.nodes, start: fragment.start, match: matchId };
}

/** Whether a zero-width assertion holds at a position. */
function assertionHolds(when: Assertion, input: string, position: number): boolean {
  switch (when) {
    case 'start':
      return position === 0;
    case 'end':
      return position === input.length;
    case 'wordBoundary':
    case 'notWordBoundary': {
      const before = position > 0 ? isWordChar(input.charAt(position - 1)) : false;
      const after = position < input.length ? isWordChar(input.charAt(position)) : false;
      const boundary = before !== after;
      return when === 'wordBoundary' ? boundary : !boundary;
    }
  }
}

/**
 * Add the states the seeds reach without consuming a character.
 *
 * The visited set is **per call**: an assertion's truth depends on the
 * position, so a state that failed an assertion at one position must be
 * re-examined at the next one.
 */
function addClosure(
  states: Set<number>,
  nodes: NfaNode[],
  input: string,
  position: number,
  seeds: Iterable<number>,
): void {
  const visited = new Set<number>();
  const stack: number[] = [];
  for (const seed of seeds) stack.push(seed);

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    if (visited.has(id)) continue;
    visited.add(id);
    states.add(id);

    const node = nodes[id];
    if (node === undefined) continue;
    if (node.kind === 'split') {
      stack.push(node.a);
      stack.push(node.b);
      continue;
    }
    if (node.kind === 'assert') {
      if (assertionHolds(node.when, input, position)) stack.push(node.out);
    }
  }
}

/**
 * Run the program against an input.
 *
 * The simulation is linear in the input and in the size of the program: it
 * keeps the set of reachable states and steps it forward. It never
 * backtracks, so no pattern can make it take super-linear time.
 */
function runProgram(program: NfaProgram, input: string): boolean {
  const { nodes, start, match } = program;
  const length = input.length;

  let current = new Set<number>();
  addClosure(current, nodes, input, 0, [start]);

  for (let position = 0; ; position += 1) {
    if (position > 0) {
      // A search: the program may start at any position.
      addClosure(current, nodes, input, position, [start]);
    }
    if (current.has(match)) return true;
    if (position >= length) return false;

    const next = new Set<number>();
    for (const id of current) {
      const node = nodes[id];
      if (node === undefined) continue;
      if (node.kind !== 'char') continue;
      if (!node.test(input.charAt(position))) continue;
      next.add(node.out);
    }
    current = next;
    addClosure(current, nodes, input, position + 1, next);
  }
}

// --- the payload -----------------------------------------------------------------

/**
 * The context a hook payload is built from.
 *
 * The members are the ones the target's payload carries, in the target's
 * snake_case spelling.
 */
export interface HookContext {
  /** The session the hook runs in. */
  session_id?: string;
  /** The prompt the hook runs for. */
  prompt_id?: string;
  /** The transcript of the session. */
  transcript_path?: string;
  /** The working directory. */
  cwd?: string;
  /** The scratchpad directory of the session. */
  scratchpad_dir?: string;
  /** The session's permission mode. */
  permission_mode?: PermissionMode;
  /** The effort level of the session. */
  effort?: { level?: string };
  /** The subagent the hook runs for. */
  agent_id?: string;
  /** The subagent's type. */
  agent_type?: string;
}

/** The payload a hook receives on its standard input. */
export interface HookPayload {
  /** The session the hook runs in. */
  session_id?: string;
  /** The prompt the hook runs for. */
  prompt_id?: string;
  /** The transcript of the session. */
  transcript_path?: string;
  /** The working directory. */
  cwd?: string;
  /** The scratchpad directory of the session. */
  scratchpad_dir?: string;
  /** The session's permission mode. */
  permission_mode?: PermissionMode;
  /** The effort level of the session. */
  effort?: { level?: string };
  /** The event the hook runs for. */
  hook_event_name: HookEvent;
  /** The subagent the hook runs for. */
  agent_id?: string;
  /** The subagent's type. */
  agent_type?: string;
  /** The event-specific fields the caller supplied. */
  [key: string]: unknown;
}

/** The common fields of the payload. */
const CONTEXT_FIELDS = [
  'session_id',
  'prompt_id',
  'transcript_path',
  'cwd',
  'scratchpad_dir',
  'permission_mode',
  'effort',
  'agent_id',
  'agent_type',
] as const;

/** Whether a value is a plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a field of a plain object.
 *
 * The field names come from the caller, so the lookup is guarded: an inherited
 * member of `Object.prototype` is never read as if it were the caller's data.
 */
export function readField(record: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(record, field)) return undefined;
  return record[field];
}

/**
 * Build the payload of a hook.
 *
 * The caller's input keeps every key it brought — the event-specific fields
 * live there — and the context wins for the common fields. The event name is
 * always the payload's `hook_event_name`.
 */
export function buildHookPayload(
  event: HookEvent,
  input: unknown,
  context?: HookContext,
): HookPayload {
  const payload: Record<string, unknown> = {};

  if (isPlainObject(input)) {
    for (const key of Object.keys(input)) {
      // `__proto__` is never copied: it would set the payload's prototype.
      if (key === '__proto__') continue;
      payload[key] = input[key];
    }
  }

  if (context) {
    const record = context as unknown as Record<string, unknown>;
    for (const field of CONTEXT_FIELDS) {
      if (!Object.hasOwn(record, field)) continue;
      const value = record[field];
      if (value === undefined) continue;
      payload[field] = value;
    }
  }

  payload['hook_event_name'] = event;
  return payload as HookPayload;
}

/**
 * The text a matcher is matched against.
 *
 * For the tool events it is the **tool name**; for `Elicitation` and
 * `ElicitationResult` it is the **MCP server name**.
 */
export function matcherSubject(event: HookEvent, payload: HookPayload): string | undefined {
  const record = payload as unknown as Record<string, unknown>;
  if (event === 'Elicitation' || event === 'ElicitationResult') {
    return firstString(record, ['mcp_server_name', 'server_name', 'server']);
  }
  return firstString(record, ['tool_name']);
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = readField(record, field);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// --- the JSON a hook writes ------------------------------------------------------

/**
 * The JSON a hook writes to its standard output.
 *
 * The shape is read tolerantly: a member of the wrong type is ignored.
 */
export interface HookJsonOutput {
  /** Whether the session should continue. */
  continue?: boolean;
  /** The reason the session stopped. */
  stopReason?: string;
  /** A message for the user. */
  systemMessage?: string;
  /** Extra context for the model. */
  additionalContext?: string;
  /** Whether the agent should retry. */
  retry?: boolean;
  /** The decision, as an object or as a word. */
  decision?: unknown;
  /** The rewritten tool input. */
  updatedInput?: unknown;
  /** The paths the hook wants to watch. */
  watchPaths?: unknown;
  /** The permissions the hook wants to change. */
  updatedPermissions?: unknown;
  /** The severity of a failure. */
  severity?: unknown;
  /** The event-specific output. */
  hookSpecificOutput?: unknown;
}

/**
 * Parse the JSON a hook wrote.
 *
 * A hook that writes nothing, or writes something that is not a JSON object,
 * contributes nothing: it is not an error.
 */
export function parseHookOutput(text: string): HookJsonOutput | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  return parsed as HookJsonOutput;
}
