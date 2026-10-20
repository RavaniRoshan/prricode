/**
 * Contract test for the read-only classifier.
 *
 * Evidence: the REA record
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-read-only-classifier.md`,
 * which quotes the target's source, and the `CC-010b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins the **decision**: which commands are read-only, which are
 * refused, and which are not.
 *
 * **The `ask` behaviour is not exercised.** The target's UNC-path test is a
 * **Windows** test — it returns false on every other platform — so a Linux
 * session never reaches it, and neither does this implementation. The
 * behaviour is part of the classifier's vocabulary, and it is unreachable here
 * for the same reason it is unreachable in the target.
 */

import { describe, expect, it } from 'vitest';

import {
  FIND_ACTION_FLAGS,
  GLOB_SAFE_COMMANDS,
  READ_ONLY_COMMANDS,
  READ_ONLY_COMMAND_PAIRS,
  SAFE_ENVIRONMENT_VARIABLES,
  classifyReadOnlyCommand,
  isReadOnlyCommand,
  notReadOnlyReason,
} from '../../src/tools/readonly.js';

/** The options every classification uses: a session with no live variables. */
const NO_LIVE_VARIABLES = { sessionEnvVarKeys: [] };

describe('the read-only classifier', () => {
  it('calls the argv allowlist read-only', () => {
    for (const command of [
      'cal',
      'uptime',
      'cat file',
      'head file',
      'tail file',
      'wc -l file',
      'stat file',
      'strings file',
      'hexdump file',
      'od file',
      'nl file',
      'id',
      'uname',
      'free',
      'df',
      'du',
      'locale',
      'groups',
      'nproc',
      'basename /a/b',
      'dirname /a/b',
      'realpath /a/b',
      'cut -d: -f1 file',
      'paste a b',
      'tr a-z A-Z',
      'column -t file',
      'tac file',
      'rev file',
      'fold -w 80 file',
      'expand file',
      'unexpand file',
      'fmt file',
      'comm a b',
      'cmp a b',
      'numfmt 1000',
      'readlink file',
      'diff a b',
      'true',
      'false',
      'sleep 1',
      'which node',
      'type ls',
      'expr 1 + 1',
      'seq 1 10',
      'tsort',
      'pr file',
      'docker ps',
      'docker images',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, true]);
    }
  });

  it('calls the per-command rules read-only', () => {
    for (const command of [
      'echo hello',
      'printf "%s\\n" hello',
      'ls',
      'ls -la',
      'pwd',
      'whoami',
      'alias',
      'cd /tmp',
      'find . -name "*.txt"',
      'history',
      'history 5',
      'arch',
      'arch --help',
      'ifconfig',
      'ifconfig eth0',
      'claude -h',
      'claude --help',
      'node -v',
      'node --version',
      'python --version',
      'python3 --version',
      'ip addr',
      'uniq',
      'jq . file',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, true]);
    }
  });

  it('calls the known-command table read-only', () => {
    for (const command of [
      'git log',
      'git status',
      'git diff',
      'git show',
      'git blame file',
      'git ls-files',
      'git worktree list',
      'grep pattern file',
      'egrep pattern file',
      'fgrep pattern file',
      'rg pattern',
      'sha256sum file',
      'md5sum file',
      'sort file',
      'ps',
      'date',
      'hostname',
      'tree',
      'netstat',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, true]);
    }
  });

  it('accepts a known command whose flags are on its allowlist', () => {
    for (const command of [
      'git log --oneline',
      'git log -n 5',
      'git diff --stat',
      'git status --short',
      'grep -rn pattern .',
      'grep -A 3 pattern file',
      'sort -u file',
      'sha256sum -c sums',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, true]);
    }
  });

  it('refuses a known command whose flags are not on its allowlist', () => {
    for (const command of [
      'git commit -m message',
      'git add -A',
      'git push origin main',
      'sed -i "s/a/b/" file',
      'grep --output=out pattern file',
      'sort -o out file',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, false]);
    }
  });

  it('refuses a command that is not on the list', () => {
    for (const command of [
      'rm -rf /',
      'rm file',
      'mv a b',
      'cp a b',
      'touch file',
      'mkdir dir',
      'curl https://example.com',
      'wget https://example.com',
      'sh script.sh',
      'bash script.sh',
      'cat file | sh',
      'git push',
      'git commit -m message',
      'chmod +x file',
      'sed -i "s/a/b/" file',
      'tee file',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, false]);
    }
  });

  it('refuses a command with an output redirection', () => {
    for (const command of [
      'echo hello > out.txt',
      'echo hello >> out.txt',
      'cat file > out.txt',
      'cat file 1> out.txt',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, false]);
    }
  });

  it('allows a redirection the target allows', () => {
    for (const command of [
      'cat file 2>&1',
      'cat file > /dev/null',
      'cat file < input.txt',
      'cat file <<EOF',
      'cat file <<<here',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, true]);
    }
  });

  it('refuses a redirect to a /dev/tcp or a /dev/udp target', () => {
    expect(isReadOnlyCommand('cat < /dev/tcp/1.2.3.4/80', NO_LIVE_VARIABLES)).toBe(false);
    expect(isReadOnlyCommand('cat < /dev/udp/1.2.3.4/53', NO_LIVE_VARIABLES)).toBe(false);
  });

  it('refuses an inline environment variable that is not known-safe', () => {
    expect(isReadOnlyCommand('FOO=1 ls', NO_LIVE_VARIABLES)).toBe(false);
    expect(isReadOnlyCommand('PATH=/tmp ls', NO_LIVE_VARIABLES)).toBe(false);
  });

  it('allows an inline environment variable that is known-safe', () => {
    for (const name of SAFE_ENVIRONMENT_VARIABLES) {
      expect([name, isReadOnlyCommand(`${name}=value ls`, NO_LIVE_VARIABLES)]).toEqual([name, true]);
    }
  });

  it('refuses an unquoted variable expansion', () => {
    expect(isReadOnlyCommand('ls $HOME', NO_LIVE_VARIABLES)).toBe(false);
    // A quoted expansion is text, not an expansion.
    expect(isReadOnlyCommand("ls '$HOME'", NO_LIVE_VARIABLES)).toBe(true);
  });

  it('refuses a ~name argument', () => {
    expect(isReadOnlyCommand('ls ~root', NO_LIVE_VARIABLES)).toBe(false);
    // The home directory itself is not another user's.
    expect(isReadOnlyCommand('ls ~', NO_LIVE_VARIABLES)).toBe(true);
  });

  it('refuses a find with an action flag', () => {
    for (const flag of FIND_ACTION_FLAGS) {
      expect([flag, isReadOnlyCommand(`find . ${flag} x`, NO_LIVE_VARIABLES)]).toEqual([flag, false]);
    }
    expect(isReadOnlyCommand('find . -exec rm {} \\;', NO_LIVE_VARIABLES)).toBe(false);
  });

  it('refuses a git command that carries a config flag', () => {
    expect(isReadOnlyCommand('git -c core.pager=cat log', NO_LIVE_VARIABLES)).toBe(false);
    expect(isReadOnlyCommand('git --exec-path=/tmp log', NO_LIVE_VARIABLES)).toBe(false);
    expect(isReadOnlyCommand('git --config-env=x=y log', NO_LIVE_VARIABLES)).toBe(false);
  });

  it('refuses a command with a subshell or a compound statement', () => {
    for (const command of [
      '$(rm -rf /)',
      '`rm -rf /`',
      '(rm -rf /)',
      'if true; then ls; fi',
      'for f in a b; do ls "$f"; done',
      'while true; do ls; done',
      'case x in x) ls;; esac',
    ]) {
      expect([command, isReadOnlyCommand(command, NO_LIVE_VARIABLES)]).toEqual([command, false]);
    }
  });

  it('refuses a command that defers execution with a background &', () => {
    expect(isReadOnlyCommand('ls &', NO_LIVE_VARIABLES)).toBe(false);
    expect(isReadOnlyCommand('ls & ls', NO_LIVE_VARIABLES)).toBe(false);
    // A redirection is not a background operator.
    expect(isReadOnlyCommand('ls &> /dev/null', NO_LIVE_VARIABLES)).toBe(true);
  });

  it('refuses a bare assignment to a live environment variable', () => {
    const live = { sessionEnvVarKeys: ['FOO'] };
    const verdict = classifyReadOnlyCommand('FOO=1', live);
    expect(verdict.behavior).toBe('passthrough');
    expect(verdict.message).toContain('Bare assignment');
  });

  it('refuses a command whose text contains an unquoted glob outside the glob-safe set', () => {
    expect(isReadOnlyCommand('ls *.txt', NO_LIVE_VARIABLES)).toBe(true);
    expect(isReadOnlyCommand('cat *.txt', NO_LIVE_VARIABLES)).toBe(true);
    expect(isReadOnlyCommand('rm *.txt', NO_LIVE_VARIABLES)).toBe(false);
  });

  it('reports the element it could not verify', () => {
    const reason = notReadOnlyReason('cat file && rm other', NO_LIVE_VARIABLES);
    expect(reason?.part).toBe('rm other');
    expect(reason?.message).toBe(
      'Command is not read-only, requires further permission checks',
    );
  });

  it('reports no reason for a read-only command', () => {
    expect(notReadOnlyReason('ls', NO_LIVE_VARIABLES)).toBeUndefined();
  });

  it('reports the target\'s reasons', () => {
    expect(classifyReadOnlyCommand('x'.repeat(10_001), NO_LIVE_VARIABLES).message).toBe(
      'Command too long for read-only analysis',
    );
    expect(classifyReadOnlyCommand('$(ls)', NO_LIVE_VARIABLES).message).toBe(
      'Not a simple read-only command: contains a subshell',
    );
    expect(classifyReadOnlyCommand('ls &', NO_LIVE_VARIABLES).message).toBe(
      'Not a simple read-only command: `&` defers execution past approval-time checks',
    );
    expect(classifyReadOnlyCommand('ls $HOME', NO_LIVE_VARIABLES).message).toBe(
      'Command contains unquoted variable expansion',
    );
    expect(classifyReadOnlyCommand('cd /tmp && git log', NO_LIVE_VARIABLES).message).toBe(
      'Compound commands with cd and git require permission checks for enhanced security',
    );
  });

  it('reads a command of the length the target reads', () => {
    const padding = 'x'.repeat(10_000 - 'ls '.length);
    expect(classifyReadOnlyCommand(`ls ${padding}`, NO_LIVE_VARIABLES).behavior).toBe('allow');
  });

  it('carries the target\'s tables', () => {
    expect(READ_ONLY_COMMANDS).toContain('cat');
    expect(READ_ONLY_COMMANDS).toContain('docker ps');
    expect(READ_ONLY_COMMANDS).not.toContain('grep');
    expect(READ_ONLY_COMMAND_PAIRS).toContainEqual(['node', '-v']);
    expect(GLOB_SAFE_COMMANDS).toContain('grep');
    expect(GLOB_SAFE_COMMANDS).not.toContain('rm');
    expect(SAFE_ENVIRONMENT_VARIABLES).toContain('LANG');
    expect(SAFE_ENVIRONMENT_VARIABLES).not.toContain('PATH');
  });
});
