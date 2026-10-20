/**
 * The read-only classifier: the rule that decides whether a shell command is
 * read-only.
 *
 * Evidence: the REA record
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-read-only-classifier.md`,
 * which quotes the target's source, and the `CC-010b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this module decides
 *
 * The `Bash` tool's concurrency safety is `isReadOnly?.(e) ?? false` in the
 * target, so a command that is **read-only** may run beside another call and a
 * command that is not may not. The classifier has three behaviours:
 *
 *   - `allow` — the command is read-only;
 *   - `ask` — the command carries a **Windows UNC path**;
 *   - `passthrough` — the command is **not** read-only, and the reason says
 *     why.
 *
 * There is no `deny`: the classifier never refuses a command, it only says
 * whether the command is read-only.
 *
 * ## The rule, in the order the target applies it
 *
 *  1. **Too long** — over 10 000 characters: `passthrough`, *"Command too long
 *     for read-only analysis"*.
 *  2. **A subshell or a compound statement**: `passthrough`, *"Not a simple
 *     read-only command: contains a subshell"*.
 *  3. **A background `&`**: `passthrough`, *"Not a simple read-only command: `&`
 *     defers execution past approval-time checks"*.
 *  4. **A bare assignment to a live environment variable**: `passthrough`,
 *     *"Bare assignment to a non-allowlisted environment variable can alter
 *     behavior of subsequent commands"*.
 *  5. **An unquoted variable expansion**: `passthrough`, *"Command contains
 *     unquoted variable expansion"*.
 *  6. **A Windows UNC path**: `ask`.
 *  7. **A compound `cd` + `git` command**: `passthrough`, *"Compound commands
 *     with cd and git require permission checks for enhanced security"*.
 *  8. **Every element of the command passes the per-command test**: `allow`.
 *  9. Otherwise: `passthrough`, *"Command is not read-only, requires further
 *     permission checks"*, with the failing element named.
 *
 * The per-command test of step 8 is:
 *
 *   - **no output redirection** other than `<`, `<<`, `<&`, `<<<`, a target of
 *     `/dev/null`, or a `>&N` to a file descriptor;
 *   - **no** `/dev/tcp` or `/dev/udp` target;
 *   - **no inline environment variable** outside the known-safe list;
 *   - **no `~name` argument**;
 *   - **no UNC path** among the arguments;
 *   - and the **argv allowlist** or the **text pattern set** accepts it.
 *
 * ## What this implementation cannot reproduce
 *
 * **The target parses the command with a tree-sitter shell parser; this
 * implementation lexes it.** The shell lexer (`src/permissions/shell.ts`) gives
 * the sub-commands, their redirections and their invocations, and this
 * classifier is built on it — but a **lexer is not a parser**, and the
 * target's decisions that depend on the parse cannot be reproduced exactly.
 * They are, one by one:
 *
 *   - **The "too complex" parse.** The target refuses a command its walker
 *     cannot model, with one of 182 enumerated reasons. This implementation
 *     has no such reason: a command this implementation can lex is not
 *     "too complex".
 *   - **The subshell and compound-statement test.** The target asks its parse
 *     tree. This implementation asks the **text**: an unquoted `$(`, a
 *     backtick, `<(`, an unquoted `(` or `)`, and a compound keyword at the
 *     head of an element. The text is **coarser** than the parse, so a command
 *     the target's parse would accept can be refused here. The refusal is the
 *     safe direction: a command this implementation cannot establish as
 *     read-only is **not** read-only, which is the target's own default.
 *   - **The `env` wrapper.** The target's argv splitter strips `env` and the
 *     assignments that follow it. This implementation does the same, so an
 *     inline assignment after `env` is not seen as an inline environment
 *     variable — the target's own behaviour.
 *   - **The `xargs` wrapper.** The shell lexer's wrapper list strips a bare
 *     `xargs`; the target's classifier does **not** — `xargs` is a command of
 *     its own in the known-command table. This implementation tokenizes the
 *     argv itself, so `xargs` is never stripped.
 *   - **The per-command danger callbacks.** The target's known-command table
 *     carries an extra callback per command (`sed`'s `w` command, `man -k`,
 *     `ps e`, docker's own flags). This implementation reproduces the table's
 *     **flag allowlists** — which is what refuses a mutating flag — and not
 *     those callbacks.
 *   - **The git rules that read the session's state.** The target also refuses
 *     a git command in a directory that carries bare-repository indicators, a
 *     `.git` file that redirects elsewhere, a compound command that creates
 *     git internal files, and a git command outside the original working
 *     directory when the sandbox is on. Those rules read the session's git
 *     state and the sandbox's state, which this classifier is not given.
 *
 * ## The known-command table
 *
 * The target's table is a **known-command-with-allowlisted-flags** table: an
 * entry is read-only when the command's flags are all on the entry's
 * allowlist. The plan's summary of the rule calls the same table a *refusal
 * map* and says the text fallback refuses it; the source shows the opposite —
 * the table is consulted **before** the text patterns, and a match makes the
 * command read-only. This implementation follows the **source**: the table is a
 * positive allowlist, and a command it does not accept falls through to the
 * text patterns.
 */

import { shellSubCommandParts, splitShellCommand, type ShellRedirect } from '../permissions/shell.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the classifier decided.
 *
 * - `allow` — the command is read-only;
 * - `ask` — the command carries a Windows UNC path;
 * - `passthrough` — the command is not read-only.
 */
export type ReadOnlyBehavior = 'allow' | 'ask' | 'passthrough';

/** The classifier's verdict. */
export interface ReadOnlyVerdict {
  /** What the classifier decided. */
  behavior: ReadOnlyBehavior;
  /** Why, when it did not allow the command. */
  message?: string;
  /** The element of the command that could not be verified. */
  part?: string;
}

/** The options the classifier takes. */
export interface ReadOnlyOptions {
  /**
   * The environment variable keys that are **live** in the session.
   *
   * A bare assignment to a variable that is live — and that is not on the
   * known-safe list — alters the behaviour of the commands that follow it, so
   * the target refuses it. The process's own environment is the default.
   */
  sessionEnvVarKeys?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The tables                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The longest command the classifier analyses.
 *
 * The target's own limit.
 */
export const MAX_READ_ONLY_COMMAND_LENGTH = 10_000;

/**
 * The read-only commands — the **argv allowlist**.
 *
 * The target's own list, in the target's own order.
 */
export const READ_ONLY_COMMANDS: readonly string[] = Object.freeze([
  'docker ps',
  'docker images',
  'cal',
  'uptime',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',
  'basename',
  'dirname',
  'realpath',
  'cut',
  'paste',
  'tr',
  'column',
  'tac',
  'rev',
  'fold',
  'expand',
  'unexpand',
  'fmt',
  'comm',
  'cmp',
  'numfmt',
  'readlink',
  'diff',
  'true',
  'false',
  'sleep',
  'which',
  'type',
  'expr',
  'seq',
  'tsort',
  'pr',
]);

/**
 * The name-and-argument pairs that are read-only.
 *
 * The pair must match **exactly**: `node -v` is read-only and `node -e` is
 * not.
 */
export const READ_ONLY_COMMAND_PAIRS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['prricode', '-h']),
  Object.freeze(['prricode', '--help']),
  Object.freeze(['node', '-v']),
  Object.freeze(['node', '--version']),
  Object.freeze(['python', '--version']),
  Object.freeze(['python3', '--version']),
  Object.freeze(['ip', 'addr']),
]);

/**
 * The commands that are read-only only when they carry **no argument**.
 */
export const NO_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(['pwd', 'whoami', 'alias']);

/**
 * The `find` flags that make the command act.
 *
 * A `find` that carries one of them is not read-only.
 */
export const FIND_ACTION_FLAGS: ReadonlySet<string> = new Set([
  '-delete',
  '-rm',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fls',
  '-fprintf',
  '-files0-from',
]);

/**
 * The **glob-safe** commands.
 *
 * A command whose text carries an unquoted glob is read-only only when its
 * first word is one of these.
 */
export const GLOB_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'grep',
  'egrep',
  'fgrep',
  'diff',
  'du',
  'df',
  'echo',
  'strings',
  'hexdump',
  'od',
  'nl',
  'cut',
  'column',
  'tr',
  'tac',
  'rev',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sha256sum',
  'sha1sum',
  'md5sum',
  'cd',
]);

/**
 * The known-safe **inline** environment variables.
 *
 * An inline assignment to a variable that is not on this list is refused.
 */
export const SAFE_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set([
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
  'COLUMNS',
  'LINES',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'CI',
  'DEBIAN_FRONTEND',
  'GIT_TERMINAL_PROMPT',
]);

/** One entry of the known-command table. */
export interface KnownCommand {
  /** The flags the command may carry, and the kind of value each takes. */
  safeFlags: Readonly<Record<string, string>>;
  /**
   * Whether a `--` ends the flags.
   *
   * The target's own default is `true`; the entries that say `false` treat a
   * `--` as an ordinary (and therefore unknown) flag.
   */
  respectsDoubleDash?: boolean;
}

/**
 * The known-command table: the commands the target accepts when their flags
 * are on the entry's allowlist.
 *
 * The table, its keys and its flag allowlists are the target's own.
 */
export const KNOWN_COMMAND_FLAGS: Readonly<Record<string, KnownCommand>> = Object.freeze({
  "xargs": { safeFlags: {"-I":"{}","-n":"number","-P":"number","-L":"number","-s":"number","-E":"EOF","-0":"none","-t":"none","-r":"none","-x":"none","-d":"char"} },
  "git diff": { safeFlags: {"--stat":"none","--numstat":"none","--shortstat":"none","--name-only":"none","--name-status":"none","--color":"none","--no-color":"none","--dirstat":"none","--summary":"none","--patch-with-stat":"none","--word-diff":"none","--word-diff-regex":"string","--color-words":"none","--no-renames":"none","--no-ext-diff":"none","--check":"none","--ws-error-highlight":"string","--full-index":"none","--binary":"none","--abbrev":"number","--break-rewrites":"none","--find-renames":"none","--find-copies":"none","--find-copies-harder":"none","--irreversible-delete":"none","--diff-algorithm":"string","--histogram":"none","--patience":"none","--minimal":"none","--ignore-space-at-eol":"none","--ignore-space-change":"none","--ignore-all-space":"none","--ignore-blank-lines":"none","--inter-hunk-context":"number","--function-context":"none","--exit-code":"none","--quiet":"none","--cached":"none","--staged":"none","--pickaxe-regex":"none","--pickaxe-all":"none","--no-index":"none","--relative":"string","--diff-filter":"string","-p":"none","-u":"none","-s":"none","-M":"none","-C":"none","-B":"none","-D":"none","-l":"none","-S":"string","-G":"string","-O":"string","-R":"none"} },
  "git log": { safeFlags: {"--oneline":"none","--graph":"none","--decorate":"none","--no-decorate":"none","--date":"string","--relative-date":"none","--all":"none","--branches":"none","--tags":"none","--remotes":"none","--since":"string","--after":"string","--until":"string","--before":"string","--max-count":"number","-n":"number","--stat":"none","--numstat":"none","--shortstat":"none","--name-only":"none","--name-status":"none","--color":"none","--no-color":"none","--patch":"none","-p":"none","--no-patch":"none","--no-ext-diff":"none","-s":"none","--author":"string","--committer":"string","--grep":"string","--abbrev-commit":"none","--full-history":"none","--dense":"none","--sparse":"none","--simplify-merges":"none","--ancestry-path":"none","--source":"none","--first-parent":"none","--merges":"none","--no-merges":"none","--reverse":"none","--walk-reflogs":"none","--skip":"number","--max-age":"number","--min-age":"number","--no-min-parents":"none","--no-max-parents":"none","--follow":"none","--no-walk":"none","--left-right":"none","--cherry-mark":"none","--cherry-pick":"none","--boundary":"none","--topo-order":"none","--date-order":"none","--author-date-order":"none","--pretty":"string","--format":"string","--diff-filter":"string","-S":"string","-G":"string","--pickaxe-regex":"none","--pickaxe-all":"none"} },
  "git show": { safeFlags: {"--oneline":"none","--graph":"none","--decorate":"none","--no-decorate":"none","--date":"string","--relative-date":"none","--stat":"none","--numstat":"none","--shortstat":"none","--name-only":"none","--name-status":"none","--color":"none","--no-color":"none","--patch":"none","-p":"none","--no-patch":"none","--no-ext-diff":"none","-s":"none","--abbrev-commit":"none","--word-diff":"none","--word-diff-regex":"string","--color-words":"none","--pretty":"string","--format":"string","--first-parent":"none","--raw":"none","--diff-filter":"string","-m":"none","--quiet":"none"} },
  "git shortlog": { safeFlags: {"--all":"none","--branches":"none","--tags":"none","--remotes":"none","--since":"string","--after":"string","--until":"string","--before":"string","-s":"none","--summary":"none","-n":"none","--numbered":"none","-e":"none","--email":"none","-c":"none","--committer":"none","--group":"string","--format":"string","--no-merges":"none","--author":"string"} },
  "git reflog": { safeFlags: {"--oneline":"none","--graph":"none","--decorate":"none","--no-decorate":"none","--date":"string","--relative-date":"none","--all":"none","--branches":"none","--tags":"none","--remotes":"none","--since":"string","--after":"string","--until":"string","--before":"string","--max-count":"number","-n":"number","--author":"string","--committer":"string","--grep":"string"} },
  "git stash list": { safeFlags: {"--oneline":"none","--graph":"none","--decorate":"none","--no-decorate":"none","--date":"string","--relative-date":"none","--all":"none","--branches":"none","--tags":"none","--remotes":"none","--max-count":"number","-n":"number"} },
  "git ls-remote": { safeFlags: {"--branches":"none","-b":"none","--tags":"none","-t":"none","--heads":"none","-h":"none","--refs":"none","--quiet":"none","-q":"none","--exit-code":"none","--get-url":"none","--symref":"none","--sort":"string"} },
  "git status": { safeFlags: {"--short":"none","-s":"none","--branch":"none","-b":"none","--porcelain":"none","--long":"none","--verbose":"none","-v":"none","--untracked-files":"string","-u":"string","--ignored":"none","--ignore-submodules":"string","--column":"none","--no-column":"none","--ahead-behind":"none","--no-ahead-behind":"none","--renames":"none","--no-renames":"none","--find-renames":"string","-M":"string"} },
  "git blame": { safeFlags: {"--color":"none","--no-color":"none","-L":"string","--porcelain":"none","-p":"none","--line-porcelain":"none","--incremental":"none","--root":"none","--show-stats":"none","--show-name":"none","--show-number":"none","-n":"none","--show-email":"none","-e":"none","-f":"none","--date":"string","-w":"none","--ignore-rev":"string","--ignore-revs-file":"string","-M":"none","-C":"none","--score-debug":"none","--abbrev":"number","-s":"none","-l":"none","-t":"none"} },
  "git ls-files": { safeFlags: {"--cached":"none","-c":"none","--deleted":"none","-d":"none","--modified":"none","-m":"none","--others":"none","-o":"none","--ignored":"none","-i":"none","--stage":"none","-s":"none","--killed":"none","-k":"none","--unmerged":"none","-u":"none","--directory":"none","--no-empty-directory":"none","--eol":"none","--full-name":"none","--abbrev":"number","--debug":"none","-z":"none","-t":"none","-v":"none","-f":"none","--exclude":"string","-x":"string","--exclude-from":"string","-X":"string","--exclude-per-directory":"string","--exclude-standard":"none","--error-unmatch":"none","--recurse-submodules":"none"} },
  "git config --get": { safeFlags: {"--local":"none","--global":"none","--system":"none","--worktree":"none","--default":"string","--type":"string","--bool":"none","--int":"none","--bool-or-int":"none","--path":"none","--expiry-date":"none","-z":"none","--null":"none","--name-only":"none","--show-origin":"none","--show-scope":"none"} },
  "git remote show": { safeFlags: {"-n":"none"} },
  "git remote": { safeFlags: {"-v":"none","--verbose":"none"} },
  "git merge-base": { safeFlags: {"--is-ancestor":"none","--fork-point":"none","--octopus":"none","--independent":"none","--all":"none"} },
  "git rev-parse": { safeFlags: {"--verify":"none","--short":"string","--abbrev-ref":"none","--symbolic":"none","--symbolic-full-name":"none","--show-toplevel":"none","--show-cdup":"none","--show-prefix":"none","--git-dir":"none","--git-common-dir":"none","--absolute-git-dir":"none","--show-superproject-working-tree":"none","--is-inside-work-tree":"none","--is-inside-git-dir":"none","--is-bare-repository":"none","--is-shallow-repository":"none","--is-shallow-update":"none","--path-prefix":"none"} },
  "git rev-list": { safeFlags: {"--all":"none","--branches":"none","--tags":"none","--remotes":"none","--since":"string","--after":"string","--until":"string","--before":"string","--max-count":"number","-n":"number","--author":"string","--committer":"string","--grep":"string","--count":"none","--reverse":"none","--first-parent":"none","--ancestry-path":"none","--merges":"none","--no-merges":"none","--min-parents":"number","--max-parents":"number","--no-min-parents":"none","--no-max-parents":"none","--skip":"number","--max-age":"number","--min-age":"number","--walk-reflogs":"none","--oneline":"none","--abbrev-commit":"none","--pretty":"string","--format":"string","--abbrev":"number","--full-history":"none","--dense":"none","--sparse":"none","--source":"none","--graph":"none"} },
  "git describe": { safeFlags: {"--tags":"none","--match":"string","--exclude":"string","--long":"none","--abbrev":"number","--always":"none","--contains":"none","--first-match":"none","--exact-match":"none","--candidates":"number","--dirty":"none","--broken":"none"} },
  "git cat-file": { safeFlags: {"-t":"none","-s":"none","-p":"none","-e":"none","--batch-check":"none","--allow-undetermined-type":"none"} },
  "git for-each-ref": { safeFlags: {"--format":"string","--sort":"string","--count":"number","--contains":"string","--no-contains":"string","--merged":"string","--no-merged":"string","--points-at":"string"} },
  "git grep": { safeFlags: {"-e":"string","-E":"none","--extended-regexp":"none","-G":"none","--basic-regexp":"none","-F":"none","--fixed-strings":"none","-P":"none","--perl-regexp":"none","-i":"none","--ignore-case":"none","-v":"none","--invert-match":"none","-w":"none","--word-regexp":"none","-n":"none","--line-number":"none","-c":"none","--count":"none","-l":"none","--files-with-matches":"none","-L":"none","--files-without-match":"none","-h":"none","-H":"none","--heading":"none","--break":"none","--full-name":"none","--color":"none","--no-color":"none","-o":"none","--only-matching":"none","-A":"number","--after-context":"number","-B":"number","--before-context":"number","-C":"number","--context":"number","--and":"none","--or":"none","--not":"none","--max-depth":"number","--untracked":"none","--no-index":"none","--recurse-submodules":"none","--cached":"none","--threads":"number","-q":"none","--quiet":"none"} },
  "git stash show": { safeFlags: {"--stat":"none","--numstat":"none","--shortstat":"none","--name-only":"none","--name-status":"none","--color":"none","--no-color":"none","--patch":"none","-p":"none","--no-patch":"none","--no-ext-diff":"none","-s":"none","--word-diff":"none","--word-diff-regex":"string","--diff-filter":"string","--abbrev":"number"} },
  "git worktree list": { safeFlags: {"--porcelain":"none","-v":"none","--verbose":"none","--expire":"string"} },
  "git tag": { safeFlags: {"-l":"none","--list":"none","-n":"number","--contains":"string","--no-contains":"string","--merged":"string","--no-merged":"string","--sort":"string","--format":"string","--points-at":"string","--column":"none","--no-column":"none","-i":"none","--ignore-case":"none"} },
  "git branch": { safeFlags: {"-l":"none","--list":"none","-a":"none","--all":"none","-r":"none","--remotes":"none","-v":"none","-vv":"none","--verbose":"none","--color":"none","--no-color":"none","--column":"none","--no-column":"none","--abbrev":"number","--no-abbrev":"none","--contains":"string","--no-contains":"string","--merged":"none","--no-merged":"none","--points-at":"string","--sort":"string","--show-current":"none","-i":"none","--ignore-case":"none"} },
  "file": { safeFlags: {"--brief":"none","-b":"none","--mime":"none","-i":"none","--mime-type":"none","--mime-encoding":"none","--apple":"none","--check-encoding":"none","-c":"none","--exclude":"string","--exclude-quiet":"string","--print0":"none","-0":"none","-F":"string","--separator":"string","--help":"none","--version":"none","-v":"none","--no-dereference":"none","-h":"none","--dereference":"none","-L":"none","--keep-going":"none","-k":"none","--list":"none","-l":"none","--no-buffer":"none","-n":"none","--preserve-date":"none","-p":"none","--raw":"none","-r":"none","-s":"none","--special-files":"none"} },
  "sed": { safeFlags: {"--expression":"string","-e":"string","--quiet":"none","--silent":"none","-n":"none","--regexp-extended":"none","-r":"none","--posix":"none","-E":"none","--line-length":"number","-l":"number","--zero-terminated":"none","-z":"none","--separate":"none","-s":"none","--unbuffered":"none","-u":"none","--debug":"none","--help":"none","--version":"none"} },
  "sort": { safeFlags: {"--ignore-leading-blanks":"none","-b":"none","--dictionary-order":"none","-d":"none","--ignore-case":"none","-f":"none","--general-numeric-sort":"none","-g":"none","--human-numeric-sort":"none","-h":"none","--ignore-nonprinting":"none","-i":"none","--month-sort":"none","-M":"none","--numeric-sort":"none","-n":"none","--random-sort":"none","-R":"none","--reverse":"none","-r":"none","--sort":"string","--stable":"none","-s":"none","--unique":"none","-u":"none","--version-sort":"none","-V":"none","--zero-terminated":"none","-z":"none","--key":"string","-k":"string","--field-separator":"string","-t":"string","--check":"none","-c":"none","--check-char-order":"none","-C":"none","--merge":"none","-m":"none","--buffer-size":"string","-S":"string","--parallel":"number","--batch-size":"number","--help":"none","--version":"none"} },
  "man": { safeFlags: {"-a":"none","--all":"none","-d":"none","-f":"none","--whatis":"none","-h":"none","-k":"none","--apropos":"none","-w":"none","-S":"string","-s":"string"} },
  "help": { safeFlags: {"-d":"none"} },
  "netstat": { safeFlags: {"-a":"none","-L":"none","-l":"none","-n":"none","-f":"string","-g":"none","-i":"none","-I":"string","-s":"none","-r":"none","-m":"none","-v":"none"} },
  "ps": { safeFlags: {"-e":"none","-A":"none","-a":"none","-d":"none","-N":"none","--deselect":"none","-f":"none","-F":"none","-l":"none","-j":"none","-y":"none","-w":"none","-ww":"none","--width":"number","-c":"none","-H":"none","--forest":"none","--headers":"none","--no-headers":"none","-n":"string","--sort":"string","-L":"none","-T":"none","-m":"none","-C":"string","-G":"string","-g":"string","-p":"string","--pid":"string","-q":"string","--quick-pid":"string","-s":"string","--sid":"string","-t":"string","--tty":"string","-U":"string","-u":"string","--user":"string","--help":"none","--info":"none","-V":"none","--version":"none"} },
  "base64": { safeFlags: {"-d":"none","-D":"none","--decode":"none","-b":"number","--break":"number","-w":"number","--wrap":"number","-i":"string","--input":"string","--ignore-garbage":"none","-h":"none","--help":"none","--version":"none"} },
  "grep": { safeFlags: {"-e":"string","--regexp":"string","-f":"string","--file":"string","-F":"none","--fixed-strings":"none","-G":"none","--basic-regexp":"none","-E":"none","--extended-regexp":"none","-P":"none","--perl-regexp":"none","-i":"none","--ignore-case":"none","--no-ignore-case":"none","-v":"none","--invert-match":"none","-w":"none","--word-regexp":"none","-x":"none","--line-regexp":"none","-c":"none","--count":"none","--color":"string","--colour":"string","-L":"none","--files-without-match":"none","-l":"none","--files-with-matches":"none","-m":"number","--max-count":"number","-o":"none","--only-matching":"none","-q":"none","--quiet":"none","--silent":"none","-s":"none","--no-messages":"none","-b":"none","--byte-offset":"none","-H":"none","--with-filename":"none","-h":"none","--no-filename":"none","--label":"string","-n":"none","--line-number":"none","-T":"none","--initial-tab":"none","-u":"none","--unix-byte-offsets":"none","-Z":"none","--null":"none","-z":"none","--null-data":"none","-A":"number","--after-context":"number","-B":"number","--before-context":"number","-C":"number","--context":"number","--group-separator":"string","--no-group-separator":"none","-a":"none","--text":"none","--binary-files":"string","-I":"none","-D":"string","--devices":"string","-d":"string","--directories":"string","--exclude":"string","--exclude-from":"string","--exclude-dir":"string","--include":"string","-r":"none","--recursive":"none","-R":"none","--dereference-recursive":"none","--line-buffered":"none","-U":"none","--binary":"none","--help":"none","-V":"none","--version":"none"} },
  "egrep": { safeFlags: {"-e":"string","--regexp":"string","-f":"string","--file":"string","-F":"none","--fixed-strings":"none","-G":"none","--basic-regexp":"none","-E":"none","--extended-regexp":"none","-P":"none","--perl-regexp":"none","-i":"none","--ignore-case":"none","--no-ignore-case":"none","-v":"none","--invert-match":"none","-w":"none","--word-regexp":"none","-x":"none","--line-regexp":"none","-c":"none","--count":"none","--color":"string","--colour":"string","-L":"none","--files-without-match":"none","-l":"none","--files-with-matches":"none","-m":"number","--max-count":"number","-o":"none","--only-matching":"none","-q":"none","--quiet":"none","--silent":"none","-s":"none","--no-messages":"none","-b":"none","--byte-offset":"none","-H":"none","--with-filename":"none","-h":"none","--no-filename":"none","--label":"string","-n":"none","--line-number":"none","-T":"none","--initial-tab":"none","-u":"none","--unix-byte-offsets":"none","-Z":"none","--null":"none","-z":"none","--null-data":"none","-A":"number","--after-context":"number","-B":"number","--before-context":"number","-C":"number","--context":"number","--group-separator":"string","--no-group-separator":"none","-a":"none","--text":"none","--binary-files":"string","-I":"none","-D":"string","--devices":"string","-d":"string","--directories":"string","--exclude":"string","--exclude-from":"string","--exclude-dir":"string","--include":"string","-r":"none","--recursive":"none","-R":"none","--dereference-recursive":"none","--line-buffered":"none","-U":"none","--binary":"none","--help":"none","-V":"none","--version":"none"} },
  "fgrep": { safeFlags: {"-e":"string","--regexp":"string","-f":"string","--file":"string","-F":"none","--fixed-strings":"none","-G":"none","--basic-regexp":"none","-E":"none","--extended-regexp":"none","-P":"none","--perl-regexp":"none","-i":"none","--ignore-case":"none","--no-ignore-case":"none","-v":"none","--invert-match":"none","-w":"none","--word-regexp":"none","-x":"none","--line-regexp":"none","-c":"none","--count":"none","--color":"string","--colour":"string","-L":"none","--files-without-match":"none","-l":"none","--files-with-matches":"none","-m":"number","--max-count":"number","-o":"none","--only-matching":"none","-q":"none","--quiet":"none","--silent":"none","-s":"none","--no-messages":"none","-b":"none","--byte-offset":"none","-H":"none","--with-filename":"none","-h":"none","--no-filename":"none","--label":"string","-n":"none","--line-number":"none","-T":"none","--initial-tab":"none","-u":"none","--unix-byte-offsets":"none","-Z":"none","--null":"none","-z":"none","--null-data":"none","-A":"number","--after-context":"number","-B":"number","--before-context":"number","-C":"number","--context":"number","--group-separator":"string","--no-group-separator":"none","-a":"none","--text":"none","--binary-files":"string","-I":"none","-D":"string","--devices":"string","-d":"string","--directories":"string","--exclude":"string","--exclude-from":"string","--exclude-dir":"string","--include":"string","-r":"none","--recursive":"none","-R":"none","--dereference-recursive":"none","--line-buffered":"none","-U":"none","--binary":"none","--help":"none","-V":"none","--version":"none"} },
  "rg": { safeFlags: {"-e":"string","--regexp":"string","-f":"string","-i":"none","--ignore-case":"none","-S":"none","--smart-case":"none","-F":"none","--fixed-strings":"none","-w":"none","--word-regexp":"none","-v":"none","--invert-match":"none","-c":"none","--count":"none","-l":"none","--files-with-matches":"none","--files-without-match":"none","-n":"none","--line-number":"none","-o":"none","--only-matching":"none","-A":"number","--after-context":"number","-B":"number","--before-context":"number","-C":"number","--context":"number","-H":"none","-h":"none","--heading":"none","--no-heading":"none","-q":"none","--quiet":"none","--column":"none","-g":"string","--glob":"string","-t":"string","--type":"string","-T":"string","--type-not":"string","--type-list":"none","--hidden":"none","--no-ignore":"none","-u":"none","-m":"number","--max-count":"number","-d":"number","--max-depth":"number","-a":"none","--text":"none","-L":"none","--follow":"none","--color":"string","--json":"none","--stats":"none","--help":"none","--version":"none","--debug":"none","--":"none"} },
  "sha256sum": { safeFlags: {"-b":"none","--binary":"none","-t":"none","--text":"none","-c":"none","--check":"none","--ignore-missing":"none","--quiet":"none","--status":"none","--strict":"none","-w":"none","--warn":"none","--tag":"none","-z":"none","--zero":"none","--help":"none","--version":"none"} },
  "sha1sum": { safeFlags: {"-b":"none","--binary":"none","-t":"none","--text":"none","-c":"none","--check":"none","--ignore-missing":"none","--quiet":"none","--status":"none","--strict":"none","-w":"none","--warn":"none","--tag":"none","-z":"none","--zero":"none","--help":"none","--version":"none"} },
  "md5sum": { safeFlags: {"-b":"none","--binary":"none","-t":"none","--text":"none","-c":"none","--check":"none","--ignore-missing":"none","--quiet":"none","--status":"none","--strict":"none","-w":"none","--warn":"none","--tag":"none","-z":"none","--zero":"none","--help":"none","--version":"none"} },
  "tree": { safeFlags: {"-a":"none","-d":"none","-l":"none","-f":"none","-x":"none","-L":"number","-P":"string","-I":"string","--gitignore":"none","--gitfile":"string","--ignore-case":"none","--matchdirs":"none","--metafirst":"none","--prune":"none","--info":"none","--infofile":"string","--noreport":"none","--charset":"string","--filelimit":"number","-q":"none","-N":"none","-Q":"none","-p":"none","-u":"none","-g":"none","-s":"none","-h":"none","--si":"none","--du":"none","-D":"none","--timefmt":"string","-F":"none","--inodes":"none","--device":"none","-v":"none","-t":"none","-c":"none","-U":"none","-r":"none","--dirsfirst":"none","--filesfirst":"none","--sort":"string","-i":"none","-A":"none","-S":"none","-n":"none","-C":"none","-X":"none","-J":"none","-H":"string","--nolinks":"none","--hintro":"string","--houtro":"string","-T":"string","--hyperlink":"none","--scheme":"string","--authority":"string","--fromfile":"none","--fromtabfile":"none","--fflinks":"none","--help":"none","--version":"none"} },
  "date": { safeFlags: {"-d":"string","--date":"string","-r":"string","--reference":"string","-u":"none","--utc":"none","--universal":"none","-I":"none","--iso-8601":"string","-R":"none","--rfc-email":"none","--rfc-3339":"string","--debug":"none","--help":"none","--version":"none"} },
  "hostname": { safeFlags: {"-f":"none","--fqdn":"none","--long":"none","-s":"none","--short":"none","-i":"none","--ip-address":"none","-I":"none","--all-ip-addresses":"none","-a":"none","--alias":"none","-d":"none","--domain":"none","-A":"none","--all-fqdns":"none","-v":"none","--verbose":"none","-h":"none","--help":"none","-V":"none","--version":"none"} },
  "lsof": { safeFlags: {"-?":"none","-h":"none","-v":"none","-a":"none","-b":"none","-C":"none","-l":"none","-n":"none","-N":"none","-O":"none","-P":"none","-Q":"none","-R":"none","-t":"none","-U":"none","-V":"none","-X":"none","-H":"none","-E":"none","-F":"none","-g":"none","-i":"none","-K":"none","-L":"none","-o":"none","-r":"none","-s":"none","-S":"none","-T":"none","-x":"none","-A":"string","-c":"string","-d":"string","-e":"string","-k":"string","-p":"string","-u":"string"} },
  "pgrep": { safeFlags: {"-d":"string","--delimiter":"string","-l":"none","--list-name":"none","-a":"none","--list-full":"none","-v":"none","--inverse":"none","-w":"none","--lightweight":"none","-c":"none","--count":"none","-f":"none","--full":"none","-g":"string","--pgroup":"string","-G":"string","--group":"string","-i":"none","--ignore-case":"none","-n":"none","--newest":"none","-o":"none","--oldest":"none","-O":"string","--older":"string","-P":"string","--parent":"string","-s":"string","--session":"string","-t":"string","--terminal":"string","-u":"string","--euid":"string","-U":"string","--uid":"string","-x":"none","--exact":"none","-F":"string","--pidfile":"string","-L":"none","--logpidfile":"none","-r":"string","--runstates":"string","--ns":"string","--nslist":"string","--help":"none","-V":"none","--version":"none"} },
  "tput": { safeFlags: {"-T":"string","-V":"none","-x":"none"} },
  "ss": { safeFlags: {"-h":"none","--help":"none","-V":"none","--version":"none","-n":"none","--numeric":"none","-a":"none","--all":"none","-l":"none","--listening":"none","-o":"none","--options":"none","-e":"none","--extended":"none","-m":"none","--memory":"none","-p":"none","--processes":"none","-i":"none","--info":"none","-s":"none","--summary":"none","-4":"none","--ipv4":"none","-6":"none","--ipv6":"none","-0":"none","--packet":"none","-t":"none","--tcp":"none","-M":"none","--mptcp":"none","-S":"none","--sctp":"none","-u":"none","--udp":"none","-d":"none","--dccp":"none","-w":"none","--raw":"none","-x":"none","--unix":"none","--tipc":"none","--vsock":"none","-f":"string","--family":"string","-A":"string","--query":"string","--socket":"string","-Z":"none","--context":"none","-z":"none","--contexts":"none","-b":"none","--bpf":"none","-E":"none","--events":"none","-H":"none","--no-header":"none","-O":"none","--oneline":"none","--tipcinfo":"none","--tos":"none","--cgroup":"none","--inet-sockopt":"none"} },
  "fd": { safeFlags: {"-h":"none","--help":"none","-V":"none","--version":"none","-H":"none","--hidden":"none","-I":"none","--no-ignore":"none","--no-ignore-vcs":"none","--no-ignore-parent":"none","-s":"none","--case-sensitive":"none","-i":"none","--ignore-case":"none","-g":"none","--glob":"none","--regex":"none","-F":"none","--fixed-strings":"none","-a":"none","--absolute-path":"none","-L":"none","--follow":"none","-p":"none","--full-path":"none","-0":"none","--print0":"none","-d":"number","--max-depth":"number","--min-depth":"number","--exact-depth":"number","-t":"string","--type":"string","-e":"string","--extension":"string","-S":"string","--size":"string","--changed-within":"string","--changed-before":"string","-o":"string","--owner":"string","-E":"string","--exclude":"string","--ignore-file":"string","-c":"string","--color":"string","-j":"number","--threads":"number","--max-buffer-time":"string","--max-results":"number","-1":"none","-q":"none","--quiet":"none","--show-errors":"none","--strip-cwd-prefix":"none","--one-file-system":"none","--prune":"none","--search-path":"string","--base-directory":"string","--path-separator":"string","--batch-size":"number","--no-require-git":"none","--hyperlink":"string","--and":"string","--format":"string"} },
  "fdfind": { safeFlags: {"-h":"none","--help":"none","-V":"none","--version":"none","-H":"none","--hidden":"none","-I":"none","--no-ignore":"none","--no-ignore-vcs":"none","--no-ignore-parent":"none","-s":"none","--case-sensitive":"none","-i":"none","--ignore-case":"none","-g":"none","--glob":"none","--regex":"none","-F":"none","--fixed-strings":"none","-a":"none","--absolute-path":"none","-L":"none","--follow":"none","-p":"none","--full-path":"none","-0":"none","--print0":"none","-d":"number","--max-depth":"number","--min-depth":"number","--exact-depth":"number","-t":"string","--type":"string","-e":"string","--extension":"string","-S":"string","--size":"string","--changed-within":"string","--changed-before":"string","-o":"string","--owner":"string","-E":"string","--exclude":"string","--ignore-file":"string","-c":"string","--color":"string","-j":"number","--threads":"number","--max-buffer-time":"string","--max-results":"number","-1":"none","-q":"none","--quiet":"none","--show-errors":"none","--strip-cwd-prefix":"none","--one-file-system":"none","--prune":"none","--search-path":"string","--base-directory":"string","--path-separator":"string","--batch-size":"number","--no-require-git":"none","--hyperlink":"string","--and":"string","--format":"string"} },
  "test": { safeFlags: {"-b":"string","-c":"string","-d":"string","-e":"string","-f":"string","-g":"string","-G":"string","-h":"string","-k":"string","-L":"string","-N":"string","-O":"string","-p":"string","-r":"string","-s":"string","-S":"string","-t":"string","-u":"string","-w":"string","-x":"string","-z":"string","-n":"string","-eq":"string","-ne":"string","-lt":"string","-le":"string","-gt":"string","-ge":"string","-nt":"string","-ot":"string","-ef":"string"} },
  "docker logs": { safeFlags: {"--follow":"none","-f":"none","--tail":"string","-n":"string","--timestamps":"none","-t":"none","--since":"string","--until":"string","--details":"none"} },
  "docker inspect": { safeFlags: {"--format":"string","-f":"string","--type":"string","--size":"none","-s":"none"} },
});

/* -------------------------------------------------------------------------- */
/* The entry points                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Classify a shell command.
 *
 * The command is read-only when the verdict is `allow`.
 */
export function classifyReadOnlyCommand(
  command: string,
  options: ReadOnlyOptions = {},
): ReadOnlyVerdict {
  if (typeof command !== 'string') {
    return { behavior: 'passthrough', message: NOT_READ_ONLY_MESSAGE };
  }
  if (command.length > MAX_READ_ONLY_COMMAND_LENGTH) {
    return { behavior: 'passthrough', message: 'Command too long for read-only analysis' };
  }

  const elements = elementsOf(command);

  // A subshell or a compound statement.
  if (containsSubshell(command, elements)) {
    return { behavior: 'passthrough', message: 'Not a simple read-only command: contains a subshell' };
  }

  // A background `&`.
  if (hasBackgroundOperator(command)) {
    return {
      behavior: 'passthrough',
      message: 'Not a simple read-only command: `&` defers execution past approval-time checks',
    };
  }

  // A bare assignment to a live environment variable.
  const live = liveEnvironmentVariables(options);
  for (const element of elements) {
    for (const name of element.bareAssignments) {
      if (isLiveEnvironmentVariable(name, live)) {
        return {
          behavior: 'passthrough',
          message:
            'Bare assignment to a non-allowlisted environment variable can alter behavior of subsequent commands',
        };
      }
    }
  }

  // An unquoted variable expansion.
  if (expansionKind(command) === 'variable') {
    return { behavior: 'passthrough', message: 'Command contains unquoted variable expansion' };
  }

  // A Windows UNC path.
  if (isWindowsUncPath(command)) {
    return {
      behavior: 'ask',
      message: 'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    };
  }

  // A compound command that changes the directory and runs git.
  const changesDirectory = elements.some((element) => isDirectoryChange(element));
  const runsGit = elements.some((element) => isGitCommand(element));
  if (changesDirectory && runsGit) {
    return {
      behavior: 'passthrough',
      message: 'Compound commands with cd and git require permission checks for enhanced security',
    };
  }

  // Every element must pass the per-command test.
  const commandHasGlob = expansionKind(command) === 'glob';
  for (const element of elements) {
    if (!elementIsReadOnly(element, commandHasGlob)) {
      return {
        behavior: 'passthrough',
        message: NOT_READ_ONLY_MESSAGE,
        part: element.raw,
      };
    }
  }

  return { behavior: 'allow' };
}

/**
 * Whether a shell command is read-only.
 *
 * A command the classifier cannot establish as read-only is **not** read-only:
 * that is the target's own default.
 */
export function isReadOnlyCommand(command: string, options: ReadOnlyOptions = {}): boolean {
  return classifyReadOnlyCommand(command, options).behavior === 'allow';
}

/**
 * Why a command is not read-only.
 *
 * `undefined` when the command **is** read-only. Otherwise the reason, and the
 * element of the command that could not be verified when there is one.
 */
export function notReadOnlyReason(
  command: string,
  options: ReadOnlyOptions = {},
): { message: string; part?: string } | undefined {
  const verdict = classifyReadOnlyCommand(command, options);
  if (verdict.behavior === 'allow') return undefined;
  const message = verdict.message ?? NOT_READ_ONLY_MESSAGE;
  return verdict.part === undefined ? { message } : { message, part: verdict.part };
}

/**
 * The message the coordinator reports when a part of a command could not be
 * verified.
 *
 * The wording is the target's: the part, and the four things that may have
 * made it unverifiable.
 */
export const NOT_READ_ONLY_PART_MESSAGE =
  'the command itself, or a flag, argument, variable prefix or redirect on it, is not on the read-only list';

/* -------------------------------------------------------------------------- */
/* The internals                                                               */
/* -------------------------------------------------------------------------- */

/** The message the target reports for a command that is not read-only. */
const NOT_READ_ONLY_MESSAGE = 'Command is not read-only, requires further permission checks';

/** The redirections the target allows. */
const ALLOWED_REDIRECT_OPERATORS: ReadonlySet<string> = new Set(['<', '<<', '<&', '<<<']);

/** The compound keywords that start a compound statement. */
const COMPOUND_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  '{',
  '}',
]);

/** The commands that change the working directory. */
const DIRECTORY_CHANGE_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'chdir']);

/** The `xargs` target commands the target allows. */
const XARGS_TARGET_COMMANDS: readonly string[] = Object.freeze([
  'echo',
  'printf',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'tail',
]);

/** The `find` options that take a value. */
const FIND_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-lname',
  '-ilname',
  '-regex',
  '-iregex',
  '-wholename',
  '-iwholename',
  '-samefile',
  '-newer',
  '-anewer',
  '-cnewer',
  '-mnewer',
  '-perm',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-size',
  '-type',
  '-xtype',
  '-fstype',
  '-inum',
  '-links',
  '-used',
  '-context',
  '-amin',
  '-cmin',
  '-mmin',
  '-atime',
  '-ctime',
  '-mtime',
  '-mindepth',
  '-maxdepth',
  '-printf',
  '-regextype',
  '-D',
  '-f',
  '-flags',
  '-Bnewer',
  '-Btime',
  '-Bmin',
  '-xattrname',
]);

/** One element of a compound command. */
interface CommandElement {
  /** The element's own text, with the redirections removed. */
  text: string;
  /** The element's raw text. */
  raw: string;
  /**
   * The element's argv, with the wrappers stripped.
   *
   * The **inline environment variables** are part of it: the target's walker
   * reports them separately, and the argv of a command that carries them still
   * carries them.
   */
  argv: string[];
  /**
   * The element's command word and its arguments.
   *
   * The inline environment variables are **not** part of it: the target's
   * walker reports them apart, and the argv allowlist matches the command's
   * own words.
   */
  commandArgv: string[];
  /** The environment variables the element assigns. */
  envVars: string[];
  /** The names the element assigns when it is nothing but an assignment. */
  bareAssignments: string[];
  /** The element's redirections. */
  redirects: ShellRedirect[];
}

/** An assignment of the form `NAME=value`. */
interface Assignment {
  /** The name of the variable. */
  name: string;
}

/**
 * The elements of a compound command.
 *
 * The shell lexer splits the command and reports each element's redirections;
 * this function adds the element's argv, its inline environment variables and
 * the names it assigns when it is nothing but an assignment.
 */
function elementsOf(command: string): CommandElement[] {
  const raw = splitShellCommand(command);
  const parts = shellSubCommandParts(command);
  return raw.map((part, index) => {
    const detail = parts[index];
    const text = detail?.text ?? part;
    const argv = argvOf(text);
    const assignments = leadingAssignments(argv);
    const bare = argv.length > 0 && assignments.length === argv.length;
    return {
      text,
      raw: part.trim(),
      argv,
      commandArgv: argv.slice(assignments.length),
      envVars: assignments.map((assignment) => assignment.name),
      bareAssignments: bare ? assignments.map((assignment) => assignment.name) : [],
      redirects: detail?.redirects ?? [],
    };
  });
}

/**
 * The argv of a command, with the wrappers the target strips removed.
 *
 * The target's own list: `time`, `nohup`, `timeout`, `nice`, `stdbuf`, `env`,
 * `command`, `builtin` and `noglob`. A bare `xargs` is **not** stripped: it is
 * a command of its own in the known-command table.
 */
function argvOf(text: string): string[] {
  return stripWrappers(tokenize(text));
}

/**
 * Split a command into whitespace-separated tokens, keeping quoted text
 * intact.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let index = 0;
  const push = (): void => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };
  while (index < text.length) {
    const character = text[index] ?? '';
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
      const next = text[index + 1];
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

/**
 * Strip the wrappers the target strips before matching a command.
 */
function stripWrappers(argv: string[]): string[] {
  let current = argv;
  for (;;) {
    const first = current[0];
    if (first === undefined) break;
    const program = first.replace(/^.*[\\/]/, '');
    if (program === 'time' || program === 'nohup') {
      current = current.slice(current[1] === '--' ? 2 : 1);
      continue;
    }
    if (program === 'timeout') {
      const index = durationIndex(current);
      if (index < 0) break;
      current = current.slice(index + 1);
      continue;
    }
    if (program === 'nice') {
      if (current[1] === '-n' && current[2] !== undefined && /^-?\d+$/.test(current[2])) {
        current = current.slice(current[3] === '--' ? 4 : 3);
        continue;
      }
      if (current[1] !== undefined && /^-\d+$/.test(current[1])) {
        current = current.slice(current[2] === '--' ? 3 : 2);
        continue;
      }
      current = current.slice(current[1] === '--' ? 2 : 1);
      continue;
    }
    if (program === 'stdbuf') {
      const index = stdbufIndex(current);
      if (index < 0) break;
      current = current.slice(index);
      continue;
    }
    if (program === 'env') {
      const index = envIndex(current);
      if (index < 0) break;
      current = current.slice(index);
      continue;
    }
    if (program === 'command') {
      let index = 1;
      while (current[index] !== undefined && /^-p+$/.test(current[index] ?? '')) index += 1;
      if (current[index] === '--') index += 1;
      if (index >= current.length || (current[index] ?? '').startsWith('-')) break;
      current = current.slice(index);
      continue;
    }
    if (program === 'builtin') {
      const index = current[1] === '--' ? 2 : 1;
      if (index >= current.length) break;
      current = current.slice(index);
      continue;
    }
    if (program === 'noglob') {
      if (current.length <= 1) break;
      current = current.slice(1);
      continue;
    }
    break;
  }
  return current;
}

/** The index of a `timeout`'s duration, or `-1`. */
function durationIndex(argv: readonly string[]): number {
  let index = 1;
  while (index < argv.length) {
    const argument = argv[index] ?? '';
    if (/^--/.test(argument)) {
      if (/^--(?:foreground|preserve-status|verbose)$/.test(argument)) {
        index += 1;
        continue;
      }
      if (/^--(?:kill-after|signal)=/.test(argument)) {
        index += 1;
        continue;
      }
      if (/^--(?:kill-after|signal)$/.test(argument)) {
        index += 2;
        continue;
      }
      break;
    }
    if (/^-[vks]$/.test(argument)) {
      index += 1;
      continue;
    }
    if (/^-[ks][A-Za-z0-9_.+-]+$/.test(argument)) {
      index += 1;
      continue;
    }
    break;
  }
  const duration = argv[index];
  if (duration === undefined || !/^\d+(?:\.\d+)?[smhd]?$/.test(duration)) return -1;
  return index;
}

/** The index after a `stdbuf`'s options, or `-1`. */
function stdbufIndex(argv: readonly string[]): number {
  let index = 1;
  while (index < argv.length) {
    const argument = argv[index] ?? '';
    if (/^-[ioe][LN0-9]+$/.test(argument) || /^--[a-z-]+$/.test(argument)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/** The index after an `env`'s options and assignments, or `-1`. */
function envIndex(argv: readonly string[]): number {
  let index = 1;
  while (index < argv.length) {
    const argument = argv[index] ?? '';
    if (argument === '--') {
      index += 1;
      break;
    }
    if (argument === '-i' || argument === '-0' || argument === '--ignore-environment') {
      index += 1;
      continue;
    }
    if (argument === '-u' || argument === '--unset' || argument === '-C' || argument === '--chdir') {
      index += 2;
      continue;
    }
    if (/^--(?:unset|chdir)=/.test(argument) || argument === '-S' || argument === '--split-string') {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/**
 * The assignments at the head of an argv.
 *
 * They are the element's **inline environment variables**.
 */
function leadingAssignments(argv: readonly string[]): Assignment[] {
  const assignments: Assignment[] = [];
  for (const argument of argv) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(argument);
    if (match === null) break;
    assignments.push({ name: match[1] ?? '' });
  }
  return assignments;
}

/**
 * What the command's text expands.
 *
 * - `'variable'` — an unquoted variable expansion;
 * - `'glob'` — an unquoted glob;
 * - `false` — neither.
 */
function expansionKind(text: string): 'variable' | 'glob' | false {
  let single = false;
  let double = false;
  let backtick = false;
  let escaped = false;
  let glob = false;
  let bracket = false;
  let wordStart = true;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (escaped) {
      escaped = false;
      wordStart = false;
      continue;
    }
    if (character === '\\' && !single) {
      if (text[index + 1] === '\n') {
        index += 1;
        continue;
      }
      escaped = true;
      continue;
    }
    if (backtick) {
      if (character === '`') {
        backtick = false;
        wordStart = false;
      }
      continue;
    }
    if (character === '`' && !single) {
      backtick = true;
      wordStart = false;
      continue;
    }
    if (character === '#' && wordStart && !single && !double) {
      while (index < text.length && text[index] !== '\n') index += 1;
      wordStart = true;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      wordStart = false;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      wordStart = false;
      continue;
    }
    if (single) continue;
    if (character === '$') {
      const next = text[index + 1];
      if (next !== undefined && /[A-Za-z_@*#?!$0-9-]/.test(next)) return 'variable';
    }
    if (double) continue;
    if (' \t\n|&;()<>'.includes(character)) {
      bracket = false;
      wordStart = true;
      continue;
    }
    wordStart = false;
    if (character === '?' || character === '*') {
      glob = true;
      continue;
    }
    if (character === '[') {
      bracket = true;
      continue;
    }
    if (character === ']' && bracket) glob = true;
  }

  return glob ? 'glob' : false;
}

/**
 * Whether the command carries a subshell or a compound statement.
 *
 * The text-level stand-in for the target's parse: an unquoted `$(`, a
 * backtick, `<(`, an unquoted `(` or `)`, and a compound keyword at the head
 * of an element.
 */
function containsSubshell(command: string, elements: readonly CommandElement[]): boolean {
  if (hasUnquoted(command, '(') || hasUnquoted(command, ')')) return true;
  if (hasUnquoted(command, '`')) return true;
  if (hasUnquoted(command, '$(')) return true;
  if (hasUnquoted(command, '<(')) return true;
  for (const element of elements) {
    const first = element.commandArgv[0];
    if (first === undefined) continue;
    if (COMPOUND_KEYWORDS.has(first)) return true;
  }
  return false;
}

/**
 * Whether a character appears in the text outside quotes.
 */
function hasUnquoted(text: string, needle: string): boolean {
  let single = false;
  let double = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && !single) {
      escaped = true;
      continue;
    }
    if (single) {
      if (character === "'") single = false;
      continue;
    }
    if (double) {
      if (character === '"') double = false;
      continue;
    }
    if (character === "'") {
      single = true;
      continue;
    }
    if (character === '"') {
      double = true;
      continue;
    }
    if (text.startsWith(needle, index)) return true;
  }
  return false;
}

/**
 * Whether the command carries a background `&`.
 *
 * A `&&` is a separator and `&>` and `2>&1` are redirections; a single `&`
 * defers the command past the approval-time checks.
 */
function hasBackgroundOperator(command: string): boolean {
  let single = false;
  let double = false;
  let escaped = false;
  let index = 0;
  while (index < command.length) {
    const character = command[index] ?? '';
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (character === '\\' && !single) {
      escaped = true;
      index += 1;
      continue;
    }
    if (single) {
      if (character === "'") single = false;
      index += 1;
      continue;
    }
    if (double) {
      if (character === '"') double = false;
      index += 1;
      continue;
    }
    if (character === "'") {
      single = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      double = true;
      index += 1;
      continue;
    }
    if (character !== '&') {
      index += 1;
      continue;
    }
    const next = command[index + 1];
    if (next === '&') {
      // `&&` is a separator, and **both** of its ampersands belong to it.
      index += 2;
      continue;
    }
    if (next === '>') {
      // `&>` and `&>>` are redirections.
      index += 1;
      continue;
    }
    const previous = command[index - 1];
    if (previous === '>' && next !== undefined && /[0-9]/.test(next)) {
      // `2>&1` duplicates a descriptor.
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * The environment variables that are live in the session.
 */
function liveEnvironmentVariables(options: ReadOnlyOptions): ReadonlySet<string> | null {
  const keys = options.sessionEnvVarKeys;
  if (keys === undefined) return new Set(Object.keys(process.env));
  return new Set(keys);
}

/**
 * Whether a bare assignment names a **live** environment variable.
 *
 * `PWD` and `OLDPWD` are always live, and a variable that is not on the
 * known-safe list is live when the session's environment carries it.
 */
function isLiveEnvironmentVariable(name: string, live: ReadonlySet<string> | null): boolean {
  if (name === 'PWD' || name === 'OLDPWD') return true;
  if (SAFE_ENVIRONMENT_VARIABLES.has(name)) return false;
  return live === null || live.has(name);
}

/**
 * Whether a Windows UNC path appears in the text.
 *
 * The target's own test is a **Windows** test: on any other platform the
 * target's check returns false, so a UNC path never reaches the `ask`
 * behaviour there.
 */
function isWindowsUncPath(text: string): boolean {
  if (process.platform !== 'win32') return false;
  return /\\\\[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i.test(text);
}

/**
 * Whether the element changes the working directory.
 */
function isDirectoryChange(element: CommandElement): boolean {
  const first = element.commandArgv[0];
  if (first === undefined) return false;
  return DIRECTORY_CHANGE_COMMANDS.has(first);
}

/**
 * Whether the element runs git.
 */
function isGitCommand(element: CommandElement): boolean {
  const first = element.commandArgv[0];
  if (first !== undefined && first.replace(/^.*[\\/]/, '') === 'git') return true;
  const raw = element.raw;
  return raw === 'git' || raw.startsWith('git ');
}

/**
 * The per-command test.
 *
 * The element passes when it has no forbidden redirection, no forbidden
 * environment variable, no `~name` argument, and the argv allowlist or the
 * text pattern set accepts it.
 */
function elementIsReadOnly(element: CommandElement, commandHasGlob: boolean): boolean {
  // A bare assignment is not a command: it changes the environment of the
  // commands that follow it.
  if (element.bareAssignments.length > 0) return false;

  // The redirections.
  for (const redirect of element.redirects) {
    const { op, target } = targetRedirect(redirect);
    const allowed =
      ALLOWED_REDIRECT_OPERATORS.has(op) ||
      target === '/dev/null' ||
      (op === '>&' && target !== undefined && /^\d+$/.test(target));
    if (!allowed) return false;
    if (target !== undefined && /^\/dev\/(tcp|udp)\//.test(target)) return false;
  }

  // The inline environment variables.
  for (const name of element.envVars) {
    if (!SAFE_ENVIRONMENT_VARIABLES.has(name)) return false;
  }

  // The `~name` arguments.
  for (const argument of element.commandArgv.slice(1)) {
    if (isTildeName(argument)) return false;
  }
  for (const redirect of element.redirects) {
    if (redirect.operator !== '<') continue;
    const target = redirect.target;
    if (target !== undefined && isTildeName(target)) return false;
  }

  // The glob path: a command whose text carries an unquoted glob is read-only
  // only when its first word is glob-safe.
  const program = element.commandArgv[0] ?? '';
  const elementHasGlob = expansionKind(element.raw) === 'glob';
  const argvHasGlob = element.commandArgv.some((argument) => /[*?]|\[.*\]/.test(argument));
  if (elementHasGlob || (commandHasGlob && argvHasGlob)) {
    return GLOB_SAFE_COMMANDS.has(program);
  }

  // The argv allowlist.
  const verdict = argvAllowlist(element.commandArgv);
  if (verdict !== null) return verdict;

  // The text pattern set.
  return textFallback(element.raw);
}

/**
 * The redirection in the target's own shape.
 *
 * The shell lexer reports `2>&1` as a descriptor duplication without a
 * target; the target reports it as a `>&` to the descriptor `1`.
 */
function targetRedirect(redirect: ShellRedirect): { op: string; target: string | undefined } {
  const operator = redirect.operator;
  const descriptor = /^(\d*)(.*)$/.exec(operator);
  const rest = descriptor?.[2] ?? operator;
  if (rest.startsWith('&')) {
    const match = /^&(>?)(.*)$/.exec(rest);
    const op = match?.[1] === '>' ? '&>' : '&>>';
    return { op, target: redirect.target };
  }
  const withTarget = /^([<>]+)&(.*)$/.exec(rest);
  if (withTarget !== null) {
    return { op: `${withTarget[1] ?? ''}&`, target: withTarget[2] };
  }
  return { op: rest, target: redirect.target };
}

/**
 * Whether an argument is a `~name` argument.
 *
 * A lone `~` and a `~/` path are the home directory, not another user's.
 */
function isTildeName(argument: string): boolean {
  return /^~(?!\/|$)/.test(argument);
}

/**
 * The argv allowlist.
 *
 * `null` when the allowlist does not decide, so the text pattern set gets its
 * turn.
 */
function argvAllowlist(argv: readonly string[]): boolean | null {
  if (argv.length === 0) return false;
  const first = argv[0] ?? '';

  if (NO_ARGUMENT_COMMANDS.has(first)) return argv.length === 1;

  for (const pair of READ_ONLY_COMMAND_PAIRS) {
    if (argv.length === pair.length && argv.every((argument, index) => argument === pair[index])) {
      return true;
    }
  }

  if (READ_ONLY_COMMANDS.includes(first)) return true;

  for (const name of READ_ONLY_COMMANDS) {
    if (!name.includes(' ')) continue;
    const parts = name.split(' ');
    if (argv.length < parts.length) continue;
    if (!parts.every((part, index) => argv[index] === part)) continue;
    if (parts[0] === 'docker' && isDockerArgument(argv.slice(parts.length))) return false;
    return true;
  }

  if (first === 'echo') return true;
  if (first === 'printf') return printfAllowlist(argv);
  if (first === '[[') return doubleBracketAllowlist(argv);
  if (first === 'ls') return true;
  if (first === 'cd') return argv.length <= 2;
  if (first === 'find') return findAllowlist(argv);
  if (first === 'history') {
    return argv.length === 1 || (argv.length === 2 && /^\d+$/.test(argv[1] ?? ''));
  }
  if (first === 'arch') {
    return (
      argv.length === 1 ||
      (argv.length === 2 && (argv[1] === '-h' || argv[1] === '--help'))
    );
  }
  if (first === 'ifconfig') {
    return argv.length === 1 || (argv.length === 2 && /^[a-zA-Z]/.test(argv[1] ?? ''));
  }

  return null;
}

/**
 * Whether a docker argument is one the target refuses.
 *
 * A docker argument that names a file outside the working directory, or that
 * carries a `~`, is refused.
 */
function isDockerArgument(argv: readonly string[]): boolean {
  return argv.some((argument) => argument.includes('~') || argument.includes('://'));
}

/**
 * The `printf` rule.
 *
 * The format may not carry an expansion, and a conversion that consumes an
 * argument may only consume a number.
 */
function printfAllowlist(argv: readonly string[]): boolean {
  const second = argv[1];
  if (second !== undefined && second.startsWith('-') && second !== '--') return false;
  const start = argv[1] === '--' ? 2 : 1;
  const format = argv[start] ?? '';
  if (containsExpansion(format)) return false;
  if (format.includes('$')) return false;
  const withoutEscapes = format.replace(/%%/g, '');
  if (/%[^%a-zA-Z]*[lLhqjzZt]*\\[0-7xX]/.test(withoutEscapes)) return false;
  if (/\\[uU]/.test(withoutEscapes)) return false;
  const consumes = /%[-+ 0#']*[0-9.*]*[lLhqjzZt]*[diouxXeEfFgGaAn]/.test(withoutEscapes);
  const star = /%[^%a-zA-Z]*\*/.test(withoutEscapes);
  if (consumes || star) {
    for (let index = start + 1; index < argv.length; index += 1) {
      const argument = argv[index] ?? '';
      if (argument.includes('[')) return false;
      if (argument.includes('`')) return false;
      if (argument.includes('$(')) return false;
      if (containsExpansion(argument)) return false;
      if (!/^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)$/.test(argument)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The `[[` rule.
 *
 * The operands of a negation, a regular expression and a pattern must not
 * carry a glob.
 */
function doubleBracketAllowlist(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const operator = argv[index] ?? '';
    const operand = argv[index + 1];
    if (operator === '-v' || operator === '-R' || operator === '-t') {
      if (operand === undefined) continue;
      if (operand.includes('[') || containsExpansion(operand)) return false;
    }
  }
  return true;
}

/**
 * The `find` rule.
 *
 * A `find` that carries an action flag is not read-only, and neither is one
 * whose argument carries an expansion.
 */
function findAllowlist(argv: readonly string[]): boolean {
  let afterGlobalOption = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const wasGlobal = afterGlobalOption;
    afterGlobalOption = false;
    if (FIND_ACTION_FLAGS.has(argument)) return false;
    if (/^-[dsx]+f$/.test(argument)) return false;
    if (!wasGlobal && isFindGlobalOption(argument)) {
      afterGlobalOption = true;
      continue;
    }
    if (!wasGlobal && takesValue(argument)) {
      index += 1;
      continue;
    }
    if (containsExpansion(argument)) return false;
  }
  return true;
}

/** Whether a `find` argument is one of its global options. */
function isFindGlobalOption(argument: string): boolean {
  return /^-(?:[EHLPXdsx]*D|f|[dsx]*[EHLPX][EHLPXdsx]*f)$/.test(argument);
}

/** Whether a `find` option takes a value. */
function takesValue(argument: string): boolean {
  return (
    FIND_VALUE_OPTIONS.has(argument) ||
    /^-newer[aBcm][aBcmt]$/.test(argument) ||
    isFindGlobalOption(argument)
  );
}

/**
 * Whether an argument carries a command substitution or a variable expansion.
 */
function containsExpansion(argument: string): boolean {
  return argument.includes('$(') || argument.includes('${');
}

/**
 * The text pattern set — the fallback.
 *
 * The target's own patterns, in the target's own order: the argv allowlist
 * names first, then the extra commands.
 */
const TEXT_PATTERNS: readonly RegExp[] = Object.freeze([
  ...READ_ONLY_COMMANDS.map(
    (name) => new RegExp(`^${name}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`),
  ),
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,
  /^prricode -h$/,
  /^prricode --help$/,
  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/,
  /^pwd$/,
  /^whoami$/,
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,
  /^history(?:\s+\d+)?\s*$/,
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/,
  /^ip addr$/,
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,
  /^jq(?!.*(?:\s['"]?-[a-zA-Z]*[fL]|--from-file|--rawfile|--slurpfile|--run-tests|--library-path|\benv\b|\$ENV\b|\binclude\b|\bimport\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  /^find(?:[ \t]+(?:\\[()]|(?!-delete\b|-rm\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b|-files0-from\b)[^<>()$`|{}&;\n\r\s]|[ \t])+)?$/,
]);

/**
 * The text pattern set's fallback.
 *
 * The known-command table is consulted **first**: a command the table accepts
 * is read-only. Then the text patterns, with the `find` and `git` carve-outs.
 */
function textFallback(text: string): boolean {
  let command = stripCommandPrefixes(text).trim();
  if (command.endsWith(' 2>&1')) command = command.slice(0, -5).trim();
  if (isWindowsUncPath(command)) return false;
  if (expansionKind(command) === 'variable') return false;
  if (knownCommandAccepts(command)) return true;
  for (const pattern of TEXT_PATTERNS) {
    if (!pattern.test(command)) continue;
    if (command.startsWith('find')) {
      const withoutQuotes = command.replace(/['"\\]/g, '');
      if (
        /-delete\b|-rm\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b|-files0-from\b/.test(
          withoutQuotes,
        )
      ) {
        return false;
      }
    }
    if (command.includes('git') && /\s-c[\s=]/.test(command)) return false;
    if (command.includes('git') && /\s--exec-path[\s=]/.test(command)) return false;
    if (command.includes('git') && /\s--config-env[\s=]/.test(command)) return false;
    return true;
  }
  return false;
}

/**
 * The `command`, `builtin` and `noglob` prefixes the target strips from a
 * command's text.
 *
 * They are the shell's own words, and the text pattern set matches the command
 * behind them.
 */
const COMMAND_PREFIX = /^(?:(?:command(?:[ \t]+-p+)*|builtin)(?:[ \t]+--)?|noglob)[ \t]+(?!-)/;

/**
 * Strip the `command`, `builtin` and `noglob` prefixes from a command's text.
 */
function stripCommandPrefixes(text: string): string {
  let command = text;
  while (COMMAND_PREFIX.test(command)) {
    command = command.replace(COMMAND_PREFIX, '');
  }
  return command;
}

/**
 * Whether the known-command table accepts the command.
 *
 * The command must be one of the table's entries, and every flag it carries
 * must be on the entry's allowlist.
 */
function knownCommandAccepts(text: string): boolean {
  const argv = tokenize(text);
  if (argv.length === 0) return false;

  let entry: KnownCommand | undefined;
  let consumed = 0;
  let commandName = '';
  for (const [name, candidate] of Object.entries(KNOWN_COMMAND_FLAGS)) {
    const parts = name.split(' ');
    if (argv.length < parts.length) continue;
    let matches = true;
    for (let index = 0; index < parts.length; index += 1) {
      if (argv[index] !== parts[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    entry = candidate;
    consumed = parts.length;
    commandName = parts[0] ?? '';
    break;
  }
  if (entry === undefined) return false;

  // `git ls-remote` may not name a server option, and it may not carry an
  // operand.
  if (commandName === 'git' && argv[1] === 'ls-remote') {
    if (
      argv.some(
        (argument) =>
          argument === '-o' ||
          argument === '--server-option' ||
          argument.startsWith('--server-option='),
      )
    ) {
      return false;
    }
    let afterDoubleDash = false;
    for (let index = 2; index < argv.length; index += 1) {
      const argument = argv[index] ?? '';
      if (argument === '') continue;
      if (!afterDoubleDash && argument === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (afterDoubleDash || argument === '-' || !argument.startsWith('-')) return false;
    }
  }

  // The operands: an expansion, or a brace expansion, is refused.
  for (let index = consumed; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '') continue;
    if (argument.includes('$')) return false;
    if (argument.includes('{') && (argument.includes(',') || argument.includes('..'))) return false;
  }

  if (!flagsAccept(argv, consumed, entry, commandName)) return false;
  if (text.includes('`')) return false;
  if (
    (commandName === 'rg' ||
      commandName === 'grep' ||
      commandName === 'egrep' ||
      commandName === 'fgrep') &&
    /[\n\r]/.test(text)
  ) {
    return false;
  }
  return true;
}

/**
 * Whether every flag of the command is on the entry's allowlist.
 */
function flagsAccept(
  argv: readonly string[],
  start: number,
  entry: KnownCommand,
  commandName: string,
): boolean {
  const flags = entry.safeFlags;
  let index = start;
  while (index < argv.length) {
    const argument = argv[index] ?? '';
    if (argument === '') {
      index += 1;
      continue;
    }

    // `xargs` may only run one of the target's read-only commands.
    if (commandName === 'xargs' && (!argument.startsWith('-') || argument === '--')) {
      let target = argument;
      if (target === '--' && index + 1 < argv.length) {
        index += 1;
        target = argv[index] ?? '';
      }
      if (target !== '' && XARGS_TARGET_COMMANDS.includes(target)) break;
      return false;
    }

    if (argument === '--') {
      if (entry.respectsDoubleDash !== false) {
        index += 1;
        break;
      }
      index += 1;
      continue;
    }

    if (!isFlagToken(argument)) {
      // An operand.
      if (containsExpansion(argument)) return false;
      index += 1;
      continue;
    }

    const hasValue = argument.includes('=');
    const [flag, ...rest] = argument.split('=');
    const name = flag ?? '';
    const value = rest.join('=');
    if (name === '') return false;

    const kind = Object.hasOwn(flags, name) ? flags[name] : undefined;
    if (kind === undefined) {
      // A git revision like `-1`.
      if (commandName === 'git' && /^-\d+$/.test(name)) {
        index += 1;
        continue;
      }
      // A grep's short flag with a number, like `-A3`.
      if (
        (commandName === 'grep' ||
          commandName === 'egrep' ||
          commandName === 'fgrep' ||
          commandName === 'rg') &&
        name.startsWith('-') &&
        !name.startsWith('--') &&
        name.length > 2
      ) {
        const short = name.slice(0, 2);
        const digits = name.slice(2);
        const shortKind = Object.hasOwn(flags, short) ? flags[short] : undefined;
        if (shortKind !== undefined && /^\d+$/.test(digits)) {
          if (shortKind === 'number' || shortKind === 'string') {
            if (valueMatches(digits, shortKind)) {
              index += 1;
              continue;
            }
            return false;
          }
        }
      }
      // A bundle of short flags.
      if (name.startsWith('-') && !name.startsWith('--') && name.length > 2) {
        for (let position = 1; position < name.length; position += 1) {
          const short = `-${name[position] ?? ''}`;
          const shortKind = Object.hasOwn(flags, short) ? flags[short] : undefined;
          if (shortKind === undefined) return false;
          if (shortKind !== 'none') return false;
        }
        index += 1;
        continue;
      }
      return false;
    }

    if (kind === 'none') {
      if (hasValue) return false;
      index += 1;
      continue;
    }

    let argumentValue: string;
    if (hasValue) {
      argumentValue = value;
      index += 1;
    } else {
      const next = argv[index + 1];
      if (next === undefined || (next !== '' && isFlagToken(next))) return false;
      argumentValue = next;
      index += 2;
    }
    if (argumentValue.startsWith('$(') || argumentValue.startsWith('${')) return false;
    if (kind === 'string' && argumentValue.startsWith('-')) {
      if (name === '--sort' && commandName === 'git' && /^-[a-zA-Z]/.test(argumentValue)) {
        // The target accepts `git --sort -x`.
      } else {
        return false;
      }
    }
    if (!valueMatches(argumentValue, kind)) return false;
  }
  return true;
}

/**
 * Whether a token is a flag.
 */
function isFlagToken(token: string): boolean {
  return token.startsWith('-') && token.length > 1 && /^-[a-zA-Z0-9_-]/.test(token);
}

/**
 * Whether a flag's value matches the kind the table declares.
 *
 * - `none` — the flag takes no value;
 * - `number` — the value is a number;
 * - `string` — the value is anything;
 * - `char` — the value is one character;
 * - `{}` — the value is the literal `{}`;
 * - `EOF` — the value is the literal `EOF`.
 */
function valueMatches(value: string, kind: string): boolean {
  switch (kind) {
    case 'none':
      return false;
    case 'number':
      return /^\d+$/.test(value);
    case 'string':
      return true;
    case 'char':
      return value.length === 1;
    case '{}':
      return value === '{}';
    case 'EOF':
      return value === 'EOF';
    default:
      return false;
  }
}
