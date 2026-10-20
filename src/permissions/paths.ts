/**
 * Path anchoring, path resolution and glob matching.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * `research/reference-agent-2.1.303-research.md` §5 ("Path rules").
 *
 * **One responsibility:** everything about *where* a permission rule points — the
 * four anchors, the requested/resolved pair, the glob matchers and the
 * critical-path list. The rule parsing and the rule matching live in
 * `src/permissions/rules.ts`.
 *
 * **Four anchors.** `//path` resolves against the filesystem root, `~/path`
 * against the home directory, `/path` against the **settings source** (the tier
 * the rule came from, so a `/path` rule in the user settings and a `/path` rule
 * in the project settings anchor differently) and `path` / `./path` against the
 * working directory.
 *
 * **"At any depth" means below the anchor.** A deny or ask pattern that names a
 * single segment matches that segment at any depth **below its anchor**: a
 * working-directory-anchored `Read(secrets)` matches `/work/secrets` and
 * `/work/a/secrets`, but never `/etc/secrets`. An allow pattern matches only at
 * the anchored depth.
 *
 * **Symlink semantics are asymmetric**: an allow rule requires **both** the
 * requested path and the resolved target to match, while a deny rule fires if
 * **either** matches. The asymmetry itself is enforced by the rule engine; this
 * module only resolves the two paths.
 *
 * **The glob matcher is linear and cached.** A rule pattern is *user* data and the
 * value it is matched against is *model* data, so a pattern with several `*` must
 * not be able to backtrack catastrophically against a long command. The matcher
 * is therefore a two-pointer glob matcher — no regular expression, so no
 * catastrophic backtracking — the compiled pattern is cached, and the value is
 * bounded to `MAX_GLOB_VALUE_LENGTH` characters.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The context a path rule is anchored against.
 *
 * `RuleSet` extends this, so the rule engine and the path module agree on the
 * anchor inputs without the path module depending on the rule module.
 */
export interface PathContext {
  /** The working directory the `path` / `./path` anchors resolve against. */
  cwd?: string;
  /** The directory of the settings file the rules came from; the `/path` anchor resolves against it. */
  settingsDir?: string;
  /** The settings directory of each tier, so the `/path` anchor resolves per rule. */
  settingsDirs?: Record<string, string>;
  /** The home directory the `~/path` anchor resolves against. */
  homeDir?: string;
}

/** The rule list a path pattern is matched for. */
export type PathMatchKind = 'deny' | 'ask' | 'allow';

/** The two paths a path rule is matched against. */
export interface PathTargets {
  /** The requested path, made absolute and normalized but **not** symlink-resolved. */
  requested: string;
  /** The resolved target, with the symlinks followed. */
  resolved: string;
}

/** A path pattern anchored against its source directory. */
export interface AnchoredPattern {
  /** The anchor directory the pattern resolves against. */
  base: string;
  /** The pattern's own segments, below the anchor. */
  segments: string[];
  /** Whether the pattern named a single segment, and therefore matches at any depth. */
  singleSegment: boolean;
}

/**
 * The longest value a glob match is computed over.
 *
 * A model-generated command is bounded so that a user-written pattern cannot be
 * matched against an unbounded string. A value longer than the bound is matched
 * on its prefix; this is a labelled approximation, not a claim about the target.
 */
export const MAX_GLOB_VALUE_LENGTH = 65536;

/** The number of compiled glob patterns that are cached. */
const GLOB_PATTERN_CACHE_LIMIT = 256;

type GlobToken =
  | { kind: 'literal'; value: string }
  | { kind: 'any' }
  | { kind: 'star' };

const globPatternCache = new Map<string, readonly GlobToken[]>();

/**
 * Compile a glob pattern into its tokens.
 *
 * The compiled form is cached: the pattern is user data that is matched against
 * every command of every call, and the cache is bounded so that a caller cannot
 * grow it without limit.
 */
function compileGlob(pattern: string): readonly GlobToken[] {
  const cached = globPatternCache.get(pattern);
  if (cached !== undefined) return cached;

  const tokens: GlobToken[] = [];
  for (const character of pattern) {
    if (character === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
      continue;
    }
    if (character === '?') {
      tokens.push({ kind: 'any' });
      continue;
    }
    tokens.push({ kind: 'literal', value: character });
  }
  const compiled: readonly GlobToken[] = Object.freeze(tokens);

  if (globPatternCache.size >= GLOB_PATTERN_CACHE_LIMIT) globPatternCache.clear();
  globPatternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Match a compiled glob against a value.
 *
 * The matcher is the classic two-pointer glob matcher: a `*` remembers where it
 * started and is extended one character at a time, so the work is bounded by the
 * product of the two lengths and never by an exponential backtracking. `?`
 * matches exactly one character.
 */
function matchGlob(
  tokens: readonly GlobToken[],
  value: string,
  crossesSeparator: boolean,
): boolean {
  let tokenIndex = 0;
  let valueIndex = 0;
  let starToken = -1;
  let starValue = 0;

  while (valueIndex < value.length) {
    const token = tokens[tokenIndex];
    if (token !== undefined && token.kind === 'any') {
      if (!crossesSeparator && value[valueIndex] === '/') return false;
      tokenIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (token !== undefined && token.kind === 'literal' && value[valueIndex] === token.value) {
      tokenIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (token !== undefined && token.kind === 'star') {
      starToken = tokenIndex;
      starValue = valueIndex;
      tokenIndex += 1;
      continue;
    }
    if (starToken >= 0) {
      const consumed = value[starValue] ?? '';
      if (consumed === '' || (!crossesSeparator && consumed === '/')) return false;
      starValue += 1;
      tokenIndex = starToken + 1;
      valueIndex = starValue;
      continue;
    }
    return false;
  }

  while (tokens[tokenIndex]?.kind === 'star') tokenIndex += 1;
  return tokenIndex === tokens.length;
}

/**
 * Match a **command** pattern.
 *
 * `*` matches any characters (including spaces and slashes) and `?` matches one
 * character. This is the command-text flavour: a command pattern is not a path
 * pattern, so it does not stop at a path separator.
 */
export function commandGlobMatch(pattern: string, value: string): boolean {
  const bounded = value.length > MAX_GLOB_VALUE_LENGTH ? value.slice(0, MAX_GLOB_VALUE_LENGTH) : value;
  return matchGlob(compileGlob(pattern), bounded, true);
}

/**
 * Match a **path segment** pattern.
 *
 * `*` matches within one path segment and `?` matches one character that is not
 * a path separator.
 */
function segmentGlobMatch(pattern: string, value: string): boolean {
  return matchGlob(compileGlob(pattern), value, false);
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
 * swapped between the check and the write. The write path therefore re-resolves
 * and compares, rather than trusting the earlier result.
 *
 * **This is a seam that is not yet enforced.** The permission module resolves the
 * path before the check; the tool runner (the `CC-008` milestone) owns the write
 * and must call this function and refuse the write when the resolution changed.
 * Nothing in this module calls it on the write path, so this implementation does not claim
 * the guarantee yet.
 */
export function reResolvePath(targets: PathTargets, opts: { cwd?: string } = {}): PathTargets {
  return resolvePathTargets(targets.requested, opts);
}

/**
 * The settings directory a rule's `/path` anchor resolves against.
 *
 * The lookup is an **own-property** check: the tier name is caller-supplied data.
 */
function settingsDirFor(context: PathContext, source?: string): string {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  if (source !== undefined) {
    const dirs = context.settingsDirs;
    if (dirs && Object.hasOwn(dirs, source)) {
      const dir = dirs[source];
      if (typeof dir === 'string') return path.resolve(dir);
    }
  }
  return path.resolve(context.settingsDir ?? cwd);
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
  context: PathContext,
  source?: string,
): AnchoredPattern {
  const home = context.homeDir ?? homedir();
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const settingsDir = settingsDirFor(context, source);

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

  const restSegments = rest.split('/').filter((segment) => segment.length > 0);
  return {
    base: path.resolve(base),
    segments: restSegments,
    singleSegment: restSegments.length === 1,
  };
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
 * depth **below its anchor**; an allow pattern matches only at the anchored
 * depth. A pattern that names the anchor itself (e.g. `~`) matches only the
 * anchor directory.
 */
export function pathPatternMatches(
  pattern: string,
  candidate: string,
  context: PathContext,
  kind: PathMatchKind,
  source?: string,
): boolean {
  const anchored = anchorPathPattern(pattern, context, source);
  const absolute = path.resolve(candidate);

  // The candidate must lie inside the anchor: "at any depth" is "at any depth
  // below the anchor", not "at any depth on the filesystem".
  if (!isInsideDirectory(absolute, anchored.base)) return false;

  const relative = path.relative(anchored.base, absolute);
  const relativeSegments = relative.split('/').filter((segment) => segment.length > 0);

  if (anchored.segments.length === 0) {
    // The pattern names the anchor directory itself.
    return relativeSegments.length === 0;
  }

  if (matchSegments(anchored.segments, relativeSegments, 0, 0)) return true;
  if (kind === 'allow' || !anchored.singleSegment) return false;

  // "At any depth" below the anchor.
  const segment = anchored.segments[anchored.segments.length - 1] ?? '';
  return relativeSegments.some((candidateSegment) => segmentGlobMatch(segment, candidateSegment));
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
 * The audit does not enumerate the critical paths, so the list is a implementation choice:
 * the filesystem root, the home directory, the working directory and its
 * ancestors, the configuration directory, and the credential directories.
 */
export function isCriticalPath(candidate: string, context: PathContext): boolean {
  const resolved = path.resolve(candidate);
  const home = path.resolve(context.homeDir ?? homedir());
  const cwd = path.resolve(context.cwd ?? process.cwd());

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
