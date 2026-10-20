/**
 * The shell lexer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * `research/reference-agent-2.1.303-research.md` §5 ("Bash matching").
 *
 * **One responsibility:** turn a command string into the pieces a permission rule
 * matches — the sub-commands, their redirections and their invocations. The rule
 * parsing and the rule matching live in `src/permissions/rules.ts`; the paths live
 * in `src/permissions/paths.ts`.
 *
 * **Compound commands** are split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines,
 * and only **outside** quotes: an operator inside a quoted string is a literal
 * character. The quoted text itself is kept, because stripping it before checking
 * is the defect this implementation must not reproduce.
 *
 * **A redirection target is never lost.** The operator may be *glued* to its
 * target (`>/etc/passwd`) or *separated* from it (`> /etc/passwd`); both forms
 * name the same target, and a redirection is a file operation, so a lost target
 * is a bypassed file rule. The next token is therefore consumed **only** when the
 * target was not glued, and a shell operator (`&&`, `||`, `;`, `|`, `|&`, `&`) is
 * never taken as a target. A redirection that names no target at all is reported
 * with an undefined target rather than with the next command of the chain.
 *
 * **`&>` and `2>&1` do not split a command.** `&>`/`&>>` are write redirections
 * and `2>&1` duplicates a file descriptor; neither is a command separator, so a
 * command that uses one stays one sub-command.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The set of programs whose invocation **mutates a file** is a implementation choice:
 *     the audit names the file-mutating *tools* (`Edit`, `Write`, `NotebookEdit`),
 *     not the shell programs. `sed` counts only with an in-place flag.
 *   - The wrappers the target strips are exactly the ones the research lists:
 *     `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`,
 *     `noglob` and a bare `xargs`. `direnv exec`, `devbox run`, `mise exec`,
 *     `npx` and `docker exec` are **not** stripped.
 */

/** The operators a compound command is split on. */
const SHELL_OPERATORS: ReadonlySet<string> = new Set(['&&', '||', ';', '|', '|&', '&']);

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

/**
 * The programs whose invocation mutates a file.
 *
 * A implementation choice: the audit names the file-mutating **tools**, not the shell
 * programs. The set is the ordinary file-mutating shell vocabulary.
 */
const FILE_MUTATING_PROGRAMS: ReadonlySet<string> = new Set([
  'cp',
  'mv',
  'rm',
  'rmdir',
  'touch',
  'mkdir',
  'ln',
  'install',
  'dd',
  'tee',
  'truncate',
  'shred',
  'rsync',
  'chmod',
  'chown',
  'patch',
  'mktemp',
]);

/**
 * Split a compound command into its sub-commands.
 *
 * The split happens on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and only
 * **outside** quotes: an operator inside a quoted string is a literal character.
 * The quoted text itself is kept, because stripping it before checking is the
 * defect this implementation must not reproduce.
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
    if (character === '&') {
      const next = command[index + 1];
      // `&>` and `&>>` are write redirections and `2>&1` duplicates a file
      // descriptor: neither is a command separator.
      if (next === '>') {
        current += character;
        index += 1;
        continue;
      }
      if (next !== undefined && command[index - 1] === '>' && /[0-9]/.test(next)) {
        current += character;
        index += 1;
        continue;
      }
      if (next === '&') {
        push();
        index += 2;
        continue;
      }
      push();
      index += 1;
      continue;
    }
    if (character === '|') {
      if (command[index + 1] === '|' || command[index + 1] === '&') {
        push();
        index += 2;
        continue;
      }
      push();
      index += 1;
      continue;
    }
    if (character === ';' || character === '\n') {
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

/** One sub-command of a compound command. */
export interface ShellSubCommand {
  /** The sub-command with the wrappers and the redirections stripped. */
  text: string;
  /** The redirections the sub-command carries. */
  redirects: ShellRedirect[];
}

interface SplitRedirectsResult {
  /** The command with every redirection removed. */
  text: string;
  /** The redirections that were removed. */
  redirects: ShellRedirect[];
}

interface RedirectOperator {
  operator: string;
  writes: boolean;
  kind: 'file' | 'descriptor';
  /** The target glued to the operator, when the operator carried one. */
  glued: string | undefined;
}

/**
 * The operator a token starts with, when it starts with one.
 *
 * A token that carries its target glued to the operator (`>out.txt`) reports the
 * target separately, so the caller never has to guess whether the next token is
 * the target or the next command.
 */
function redirectOperator(token: string): RedirectOperator | undefined {
  const match = /^(\d*)(&>>|&>|[<>]{1,3})(.*)$/.exec(token);
  if (!match) return undefined;
  const fd = match[1] ?? '';
  const operator = match[2] ?? '';
  const rest = match[3] ?? '';
  if (operator === '&>') {
    return {
      operator: `&${fd}>`,
      writes: true,
      kind: 'file',
      glued: rest.length > 0 ? rest : undefined,
    };
  }
  if (operator === '&>>') {
    return {
      operator: `&${fd}>>`,
      writes: true,
      kind: 'file',
      glued: rest.length > 0 ? rest : undefined,
    };
  }
  if (rest.startsWith('&')) {
    // `2>&1` — duplicating a descriptor, not touching a file.
    return { operator: `${fd}${operator}&${rest.slice(1)}`, writes: false, kind: 'descriptor', glued: undefined };
  }
  return {
    operator: `${fd}${operator}`,
    writes: operator.startsWith('>'),
    kind: 'file',
    glued: rest.length > 0 ? rest : undefined,
  };
}

/**
 * Remove the surrounding quotes of a token.
 *
 * A redirection target may be quoted (`> "out file.txt"`); the quotes are part of
 * the shell syntax, not of the path.
 */
function unquote(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' || first === "'") && first === last) return token.slice(1, -1);
  return token;
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
    if (operator.glued !== undefined) {
      // The target is glued to the operator, so the next token belongs to the
      // command and is **not** consumed as a target.
      redirects.push({
        operator: operator.operator,
        target: unquote(operator.glued),
        writes: operator.writes,
      });
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || SHELL_OPERATORS.has(next)) {
      // No target: the redirection names no file, and a shell operator is never
      // taken as one.
      redirects.push({ operator: operator.operator, target: undefined, writes: operator.writes });
      continue;
    }
    index += 1;
    redirects.push({ operator: operator.operator, target: unquote(next), writes: operator.writes });
  }

  return { text: kept.join(' '), redirects };
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

/**
 * The redirections of a command.
 *
 * The redirections of every sub-command are reported, so a redirection that
 * belongs to a later part of a chain is never attributed to the first part.
 */
export function shellRedirects(command: string): ShellRedirect[] {
  return shellSubCommandParts(command).flatMap((part) => part.redirects);
}

/**
 * The sub-commands of a command, with the wrappers and the redirections stripped.
 */
export function shellSubCommands(command: string): string[] {
  return shellSubCommandParts(command).map((part) => part.text);
}

/**
 * The sub-commands of a command, each with the redirections it carries.
 *
 * The redirections are extracted from the sub-command itself, so a redirection
 * never picks up a neighbouring token of the chain as its target.
 */
export function shellSubCommandParts(command: string): ShellSubCommand[] {
  return splitShellCommand(command).map((part) => {
    const split = splitRedirects(part);
    return { text: stripWrappers(split.text.trim()), redirects: split.redirects };
  });
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

/** The program and the arguments of a command, with the wrappers stripped. */
export function shellInvocation(command: string): { program: string; args: string[] } {
  const tokens = tokenizeShell(stripWrappers(command));
  const program = tokens[0] ?? '';
  return { program, args: tokens.slice(1) };
}

/**
 * Whether an invocation mutates a file.
 *
 * `sed` counts only with an in-place flag; every other program in the mutating
 * set mutates a file whatever its arguments are.
 */
export function isFileMutatingInvocation(program: string, args: readonly string[]): boolean {
  if (FILE_MUTATING_PROGRAMS.has(program)) return true;
  if (program === 'sed') {
    return args.some((argument) => /^-[A-Za-z]*i/.test(argument) || argument.startsWith('--in-place'));
  }
  return false;
}

/**
 * Whether a sub-command mutates a file.
 *
 * A write redirection mutates a file whatever the program is, so a redirect is
 * counted here as well.
 */
export function shellSubCommandMutatesFiles(part: ShellSubCommand): boolean {
  if (part.redirects.some((redirect) => redirect.writes)) return true;
  const invocation = shellInvocation(part.text);
  return isFileMutatingInvocation(invocation.program, invocation.args);
}
