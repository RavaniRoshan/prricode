/**
 * The tool-name matcher: the two modes, the pattern parser, and the
 * non-backtracking engine.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("Hook
 * matchers") and `docs/compatibility/extension-surface.md` ("The matcher
 * semantics"), and the `CC-012` milestone of
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
 * pattern can make the *simulation* take super-linear time. The price is that
 * the supported subset is a subset of JavaScript's regular expressions; a
 * pattern outside the subset is **rejected** (it matches nothing) rather than
 * run with a risk of hanging. The supported subset is:
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
 * ## The compiler is bounded, and the bound is on the **whole** program
 *
 * A bounded repetition is compiled by **unrolling** it, so the size of the
 * program is the *product* of the counts of nested repetitions. The pattern
 * `(((a{64}){64}){64}){64}` is 23 characters long — far inside the pattern
 * length bound — and would expand to 16,777,216 nodes. That is a memory
 * exhaustion, which is a **worse** failure than the CPU spin the
 * non-backtracking engine exists to prevent, and the pattern is benign for a
 * real backtracking engine.
 *
 * The compiler therefore carries a **global node budget**: it emits at most
 * `MAX_MATCH_NODES` nodes and then **refuses** the matcher with a reason
 * naming the limit. The budget is on the *total* expansion, not on a single
 * repetition count, so the space the compiler uses is bounded by a constant
 * and is **linear in the length of the pattern**, never exponential in it.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - **The matcher engine supports the subset of JavaScript's regular
 *     expressions listed above.** A pattern outside the subset is refused
 *     rather than run with a risk of hanging.
 *   - **A matcher that cannot be compiled matches nothing.** A malformed
 *     matcher is a configuration error, and it is reported loudly at the
 *     point where the hook is registered; at run time a matcher that does
 *     not compile matches nothing rather than being treated as a literal.
 *   - **The repetition count is bounded at 64 and the whole program at
 *     `MAX_MATCH_NODES` nodes.** A matcher that exceeds either bound is
 *     refused with a reason naming the bound.
 *   - **An empty alternative in a simple matcher matches every tool**, the
 *     way the equivalent regular expression (`a|`) does. A matcher that
 *     names no tool at all is refused.
 *   - **The input bound is applied in both modes.** A tool name longer than
 *     `MAX_MATCH_INPUT_LENGTH` is refused, whether the matcher is an exact
 *     string or a regular expression.
 */

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

/**
 * The largest program the matcher compiler emits.
 *
 * The bound is on the **total** expansion: nested bounded repetitions
 * multiply, so a bound on a single count is not a bound on the program.
 */
export const MAX_MATCH_NODES = 2048;

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
 * Whether a tool name is within the input bound.
 *
 * The bound is applied in **both** modes: a name longer than the bound is
 * refused before the matcher looks at it.
 */
export function isInputWithinBound(toolName: string): boolean {
  return toolName.length <= MAX_MATCH_INPUT_LENGTH;
}

/**
 * Whether a matcher matches a tool name.
 *
 * A matcher that cannot be compiled matches **nothing**: a malformed matcher
 * is rejected rather than silently treated as a literal.
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
    const parts = matcher.split(/[|,]/);
    const names = new Set(parts.map((part) => part.trim()).filter((part) => part.length > 0));
    if (names.size === 0) {
      return { ok: false, reason: 'the matcher names no tool' };
    }
    // An empty alternative matches every tool, the way the equivalent regular
    // expression (`a|`) does.
    const matchesEvery = parts.some((part) => part.length === 0);
    return {
      ok: true,
      matcher: {
        kind: 'exact',
        test(toolName: string): boolean {
          if (!isInputWithinBound(toolName)) return false;
          if (matchesEvery) return true;
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
          if (!isInputWithinBound(toolName)) return false;
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

/**
 * Whether a character is whitespace, the way JavaScript's `\s` sees it.
 *
 * The set is JavaScript's: the ASCII whitespace characters, the no-break
 * space, the ogham space, the en-quad … hair-space block, the line and
 * paragraph separators, the narrow no-break space, the medium mathematical
 * space, the ideographic space and the byte order mark.
 */
function isSpaceChar(char: string): boolean {
  return (
    char === '\f' ||
    char === '\n' ||
    char === '\r' ||
    char === '\t' ||
    char === '\v' ||
    char === '\u0020' ||
    char === '\u00a0' ||
    char === '\u1680' ||
    (char >= '\u2000' && char <= '\u200a') ||
    char === '\u2028' ||
    char === '\u2029' ||
    char === '\u202f' ||
    char === '\u205f' ||
    char === '\u3000' ||
    char === '\ufeff'
  );
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

    // `[^]` is the negated **empty** class: it matches every character, the
    // newline included.
    if (negated && this.peek() === ']') {
      this.index += 1;
      return { kind: 'char', test: () => true };
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
  | { kind: 'empty'; out: number }
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

  /**
   * Emit a node.
   *
   * The **global node budget** is enforced here: a program that would grow
   * past `MAX_MATCH_NODES` nodes is refused, so the space the compiler uses
   * is bounded by the budget and never by the pattern's expansion.
   */
  emit(node: NfaNode): number {
    if (this.nodes.length >= MAX_MATCH_NODES) {
      throw new MatcherError(`the matcher expands to more than ${MAX_MATCH_NODES} nodes`);
    }
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  patch(outs: number[], target: number): void {
    for (const id of outs) {
      const node = this.nodes[id];
      if (node === undefined) continue;
      if (node.kind === 'split') node.b = target;
      else if (node.kind === 'char' || node.kind === 'assert' || node.kind === 'empty') {
        node.out = target;
      }
    }
  }

  compile(ast: PatternAst): Fragment {
    switch (ast.kind) {
      case 'empty': {
        // The empty fragment is a **zero-width** transition: it consumes
        // nothing and goes straight on, so an empty alternative matches the
        // empty string — and therefore every text, the way JavaScript's `a|`
        // does.
        const id = this.emit({ kind: 'empty', out: -1 });
        return { start: id, outs: [id] };
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
    if (node.kind === 'empty') {
      // A zero-width transition: it goes straight on to its continuation.
      stack.push(node.out);
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
