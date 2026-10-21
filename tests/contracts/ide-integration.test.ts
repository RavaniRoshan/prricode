/**
 * Contract test for the **IDE integration** surface: the target's eighteen
 * IDEs, the lock-file protocol, and the diagnostics subsystem.
 *
 * Evidence: the target's own source, read out of the pinned build and
 * recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-ide-integration.md` —
 * every claim there carries a file and a byte offset. The milestone is
 * `CC-036` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins:
 *
 *   - the IDE registry: **eighteen** entries in the target's order, **two**
 *     kinds (three of one, fifteen of the other), and each entry's own
 *     display name and per-OS process keywords;
 *   - the editor display-name table, which is a **different** table with
 *     **twelve** entries;
 *   - the display-name resolver, including the target's own "before the first
 *     space, then the basename" rule;
 *   - the process-detection rule, per platform, including the Linux rule that
 *     does not report VS Code when AppCode or Cursor is running;
 *   - the lock directories, the Windows → WSL path mapping, the lock body in
 *     both of its forms, and the rule that the **port is the file name**;
 *   - the staleness rule, and its difference under WSL;
 *   - the discovery: the three workspace relations, the two URLs, and the
 *     rule that only an IDE whose workspace holds the session's directory is
 *     valid;
 *   - the diagnostics: the severity vocabulary, the validation rule and its
 *     counts, the baseline, the comparison, and the rendering with its
 *     truncation;
 *   - the three refusals, and the capability each of them names.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MS,
  IDE_DIAGNOSTICS_BASELINES_DISABLED_MESSAGE,
  IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MESSAGE,
  IDE_DIAGNOSTICS_FETCH_TIMEOUT_MS,
  IDE_DIAGNOSTICS_MAX_CONSECUTIVE_BASELINE_TIMEOUTS,
  IDE_CONNECTION_CAPABILITY,
  IDE_DIAGNOSTICS_CAPABILITY,
  IDE_EXTENSION_INSTALL_CAPABILITY,
  IdeCapabilityError,
  IdeDiagnosticsManager,
  newDiagnostics,
  normalizeDiagnosticSeverity,
  renderNewDiagnostics,
  validateDiagnosticsPayload,
  type IdeDiagnostic,
  type IdeDiagnosticFile,
} from '../../src/integration/ide/diagnostics.js';
import {
  IDE_DETECTION_POLL_INTERVAL_MS,
  IDE_DETECTION_WINDOW_MS,
  IDE_SKIPPED_WINDOWS_USERS,
  discoverIdes,
  envBoolean,
  envInteger,
  ideLockDirectories,
  ideLockPortFromFileName,
  ideUrl,
  isIdeLockStale,
  parseIdeLock,
  isPathInside,
  sortIdeLockFiles,
  theSingleContainingIde,
  windowsProfileToWslPath,
  workspaceRelation,
  type DiscoveredIde,
  type IdeLock,
} from '../../src/integration/ide/lockfile.js';
import {
  EDITOR_DISPLAY_NAMES,
  IDE_FAMILY_COMMANDS,
  IDE_KINDS,
  IDE_PROCESS_DETECTION_COMMANDS,
  IDE_REGISTRY,
  IDE_REGISTRY_KEYS,
  JETBRAINS_PLUGIN_DIRECTORY,
  JETBRAINS_PRODUCT_DIRECTORIES,
  VSCODE_EXTENSION_ID,
  detectIdesFromProcessList,
  ideDefinition,
  ideDisplayName,
  idePlatformFor,
  ideProcessKeywords,
  isIdeKey,
  isIdeKind,
  isIdePlatform,
  isJetBrainsFamily,
  isVSCodeFamily,
  normalizeIdeName,
} from '../../src/integration/ide/registry.js';
import { createIdeBridge } from '../../src/integration/ide/bridge.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** The temporary directories the tests create. */
const created: string[] = [];

/** A fresh temporary directory. */
function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'ide-surface-'));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** A diagnostic, with only the members the test cares about. */
function diagnostic(overrides: Partial<IdeDiagnostic> = {}): IdeDiagnostic {
  return {
    message: 'message',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The IDE registry                                                            */
/* -------------------------------------------------------------------------- */

describe('the IDE registry', () => {
  it('has exactly eighteen IDEs, in the target\'s order', () => {
    expect(IDE_REGISTRY).toHaveLength(18);
    expect([...IDE_REGISTRY_KEYS]).toEqual([
      'cursor',
      'windsurf',
      'vscode',
      'intellij',
      'pycharm',
      'webstorm',
      'phpstorm',
      'rubymine',
      'clion',
      'goland',
      'rider',
      'datagrip',
      'appcode',
      'dataspell',
      'aqua',
      'gateway',
      'fleet',
      'androidstudio',
    ]);
  });

  it('has exactly two IDE kinds, three of one and fifteen of the other', () => {
    expect([...IDE_KINDS]).toEqual(['vscode', 'jetbrains']);
    expect(IDE_REGISTRY.filter((ide) => ide.ideKind === 'vscode')).toHaveLength(3);
    expect(IDE_REGISTRY.filter((ide) => ide.ideKind === 'jetbrains')).toHaveLength(15);
    expect(isIdeKind('vscode')).toBe(true);
    expect(isIdeKind('jetbrains')).toBe(true);
    expect(isIdeKind('emacs')).toBe(false);
    expect(isIdeKind(42)).toBe(false);
  });

  it('gives every IDE its own display name and its own per-OS process keywords', () => {
    expect(
      IDE_REGISTRY.map((ide) => [
        ide.key,
        ide.displayName,
        [...ide.processKeywords.macos],
        [...ide.processKeywords.windows],
        [...ide.processKeywords.linux],
      ]),
    ).toEqual([
      ['cursor', 'Cursor', ['Cursor Helper', 'Cursor.app'], ['cursor.exe'], ['cursor']],
      [
        'windsurf',
        'Devin Desktop',
        ['Windsurf Helper', 'Windsurf.app', 'Devin Helper', 'Devin.app'],
        ['windsurf.exe', 'Devin.exe'],
        ['windsurf', 'devin-desktop'],
      ],
      [
        'vscode',
        'VS Code',
        ['Visual Studio Code', 'Code Helper'],
        ['code.exe'],
        ['code'],
      ],
      ['intellij', 'IntelliJ IDEA', ['IntelliJ IDEA'], ['idea64.exe'], ['idea', 'intellij']],
      ['pycharm', 'PyCharm', ['PyCharm'], ['pycharm64.exe'], ['pycharm']],
      ['webstorm', 'WebStorm', ['WebStorm'], ['webstorm64.exe'], ['webstorm']],
      ['phpstorm', 'PhpStorm', ['PhpStorm'], ['phpstorm64.exe'], ['phpstorm']],
      ['rubymine', 'RubyMine', ['RubyMine'], ['rubymine64.exe'], ['rubymine']],
      ['clion', 'CLion', ['CLion'], ['clion64.exe'], ['clion']],
      ['goland', 'GoLand', ['GoLand'], ['goland64.exe'], ['goland']],
      ['rider', 'Rider', ['Rider'], ['rider64.exe'], ['rider']],
      ['datagrip', 'DataGrip', ['DataGrip'], ['datagrip64.exe'], ['datagrip']],
      ['appcode', 'AppCode', ['AppCode'], ['appcode.exe'], ['appcode']],
      ['dataspell', 'DataSpell', ['DataSpell'], ['dataspell64.exe'], ['dataspell']],
      ['aqua', 'Aqua', [], ['aqua64.exe'], []],
      ['gateway', 'Gateway', [], ['gateway64.exe'], []],
      ['fleet', 'Fleet', [], ['fleet.exe'], []],
      [
        'androidstudio',
        'Android Studio',
        ['Android Studio'],
        ['studio64.exe'],
        ['android-studio'],
      ],
    ]);
  });

  it('leaves the macOS and Linux keyword lists of Aqua, Gateway and Fleet empty', () => {
    for (const key of ['aqua', 'gateway', 'fleet']) {
      const ide = ideDefinition(key);
      expect(ide?.processKeywords.macos).toEqual([]);
      expect(ide?.processKeywords.linux).toEqual([]);
      expect(ide?.processKeywords.windows).toHaveLength(1);
    }
  });

  it('resolves a key through a guard, so an inherited member is not an IDE', () => {
    expect(ideDefinition('vscode')?.displayName).toBe('VS Code');
    expect(ideDefinition('__proto__')).toBeUndefined();
    expect(ideDefinition('constructor')).toBeUndefined();
    expect(ideDefinition('toString')).toBeUndefined();
    expect(ideDefinition('')).toBeUndefined();
    expect(isIdeKey('cursor')).toBe(true);
    expect(isIdeKey('emacs')).toBe(false);
    expect(isVSCodeFamily('cursor')).toBe(true);
    expect(isVSCodeFamily('intellij')).toBe(false);
    expect(isJetBrainsFamily('intellij')).toBe(true);
    expect(isJetBrainsFamily('cursor')).toBe(false);
  });

  it('gives an unknown IDE no keywords at all', () => {
    expect(ideProcessKeywords('emacs', 'linux')).toEqual([]);
    expect(ideProcessKeywords('vscode', 'linux')).toEqual(['code']);
  });

  it('has twelve editor display names, in a table of its own', () => {
    expect(Object.keys(EDITOR_DISPLAY_NAMES)).toHaveLength(12);
    expect(EDITOR_DISPLAY_NAMES['code']).toBe('VS Code');
    expect(EDITOR_DISPLAY_NAMES['antigravity']).toBe('Antigravity');
    expect(EDITOR_DISPLAY_NAMES['start /wait notepad']).toBe('Notepad');
    expect(EDITOR_DISPLAY_NAMES['subl']).toBe('Sublime Text');
    // The editor table is not the IDE registry: it names editors the registry
    // does not know.
    expect(ideDefinition('emacs')).toBeUndefined();
  });

  it('resolves a display name the way the target does', () => {
    expect(ideDisplayName('')).toBe('IDE');
    expect(ideDisplayName('vscode')).toBe('VS Code');
    expect(ideDisplayName('code')).toBe('VS Code');
    expect(ideDisplayName('  Code  ')).toBe('VS Code');
    expect(ideDisplayName('notepad')).toBe('Notepad');
    expect(ideDisplayName('/usr/local/bin/code')).toBe('VS Code');
    // The target splits on the *first* space and takes the basename.
    expect(ideDisplayName('Visual Studio Code')).toBe('visual');
    expect(ideDisplayName('Antigravity')).toBe('Antigravity');
  });

  it('normalizes the IDE name the way the target does', () => {
    expect(normalizeIdeName('Windsurf')).toBe('Devin Desktop');
    expect(normalizeIdeName('windsurf')).toBe('Devin Desktop');
    expect(normalizeIdeName('Cursor')).toBe('Cursor');
  });

  it('has fifteen JetBrains product directories and none for the VS Code family', () => {
    expect(Object.keys(JETBRAINS_PRODUCT_DIRECTORIES)).toHaveLength(15);
    expect(JETBRAINS_PRODUCT_DIRECTORIES['intellij']).toEqual(['IntelliJIdea', 'IdeaIC']);
    expect(JETBRAINS_PRODUCT_DIRECTORIES['androidstudio']).toEqual(['AndroidStudio']);
    expect(JETBRAINS_PRODUCT_DIRECTORIES['vscode']).toBeUndefined();
    expect(JETBRAINS_PLUGIN_DIRECTORY).toBe('claude-code-jetbrains-plugin');
    expect(VSCODE_EXTENSION_ID).toBe('anthropic.claude-code');
    expect(IDE_FAMILY_COMMANDS['vscode']).toEqual(['code', 'codium']);
  });

  it('names the three operating systems the target detects on', () => {
    expect(idePlatformFor('darwin')).toBe('macos');
    expect(idePlatformFor('win32')).toBe('windows');
    expect(idePlatformFor('linux')).toBe('linux');
    expect(idePlatformFor('aix')).toBeUndefined();
    expect(isIdePlatform('macos')).toBe(true);
    expect(isIdePlatform('sunos')).toBe(false);
  });

  it('holds the target\'s own detection command for each platform', () => {
    expect(IDE_PROCESS_DETECTION_COMMANDS.macos).toContain('ps aux | grep -E');
    expect(IDE_PROCESS_DETECTION_COMMANDS.macos).toContain('Cursor Helper');
    expect(IDE_PROCESS_DETECTION_COMMANDS.windows).toContain('tasklist | findstr /I');
    expect(IDE_PROCESS_DETECTION_COMMANDS.windows).toContain('studio64.exe');
    expect(IDE_PROCESS_DETECTION_COMMANDS.linux).toContain('grep -v grep');
    expect(IDE_PROCESS_DETECTION_COMMANDS.linux).toContain('android-studio');
  });

  it('detects an IDE from a macOS process listing, case-sensitively', () => {
    expect(
      detectIdesFromProcessList(
        'shivam 100 1 0 9:00 /Applications/Cursor.app/Contents/MacOS/Cursor',
        'macos',
      ),
    ).toEqual(['cursor']);
    // The macOS keywords are matched case-sensitively.
    expect(detectIdesFromProcessList('cursor.app', 'macos')).toEqual([]);
  });

  it('detects an IDE from a Windows process listing, case-insensitively', () => {
    expect(detectIdesFromProcessList('cursor.exe   1234 Console', 'windows')).toEqual([
      'cursor',
    ]);
    expect(detectIdesFromProcessList('IDEA64.EXE  99 Console', 'windows')).toEqual([
      'intellij',
    ]);
  });

  it('detects an IDE from a Linux process listing', () => {
    expect(detectIdesFromProcessList('shivam 1 1 0 09:00 /usr/share/code/code', 'linux')).toEqual([
      'vscode',
    ]);
  });

  it('does not report VS Code on Linux when AppCode or Cursor is running', () => {
    // The Linux keyword for VS Code is `code`, and `code` is a substring of
    // `appcode`; the target guards against exactly that.
    expect(
      detectIdesFromProcessList('shivam 1 1 0 09:00 /opt/appcode/bin/appcode', 'linux'),
    ).toEqual(['appcode']);
    expect(
      detectIdesFromProcessList('shivam 1 1 0 09:00 /opt/cursor/appcode', 'linux'),
    ).not.toContain('vscode');
  });
});

/* -------------------------------------------------------------------------- */
/* The lock-file protocol                                                      */
/* -------------------------------------------------------------------------- */

describe('the IDE lock-file protocol', () => {
  it('lists the lock directories the target lists', () => {
    expect(
      ideLockDirectories({
        configRoot: '/home/u/.claude',
        homeDir: '/home/u',
        platform: 'linux',
        env: {},
      }),
    ).toEqual(['/home/u/.claude/ide']);
  });

  it('adds the home directory\'s lock directory when the root is overridden or blank', () => {
    expect(
      ideLockDirectories({
        configRoot: '/opt/config',
        homeDir: '/home/u',
        platform: 'linux',
        env: { CLAUDE_CONFIG_DIR: '/opt/config' },
      }),
    ).toEqual(['/opt/config/ide', '/home/u/.claude/ide']);

    expect(
      ideLockDirectories({
        configRoot: '',
        homeDir: '/home/u',
        platform: 'linux',
        env: {},
      }),
    ).toEqual(['ide', '/home/u/.claude/ide']);
  });

  it('adds the Windows-side directories under WSL, and skips the four shared accounts', () => {
    expect(
      ideLockDirectories({
        configRoot: '/home/u/.claude',
        homeDir: '/home/u',
        platform: 'wsl',
        env: { USERPROFILE: 'C:\\Users\\bob' },
        windowsUserNames: ['alice', ...IDE_SKIPPED_WINDOWS_USERS],
      }),
    ).toEqual([
      '/home/u/.claude/ide',
      '/mnt/c/Users/bob/.claude/ide',
      '/mnt/c/Users/alice/.claude/ide',
    ]);
  });

  it('skips exactly the four shared Windows accounts', () => {
    expect([...IDE_SKIPPED_WINDOWS_USERS]).toEqual([
      'Public',
      'Default',
      'Default User',
      'All Users',
    ]);
  });

  it('maps a Windows profile to its WSL path', () => {
    expect(windowsProfileToWslPath('C:\\Users\\shiva')).toBe('/mnt/c/Users/shiva');
    expect(windowsProfileToWslPath('D:\\work')).toBe('/mnt/d/work');
    // A path that does not start with a drive letter is not mapped.
    expect(windowsProfileToWslPath('/home/u')).toBeUndefined();
  });

  it('takes the port from the file name, not from the JSON', () => {
    expect(ideLockPortFromFileName('12345.lock')).toBe(12345);
    expect(ideLockPortFromFileName('/a/b/999.lock')).toBe(999);
    // A name that carries no number gives NaN, exactly as the target's
    // `parseInt` does.
    expect(Number.isNaN(ideLockPortFromFileName('vscode.lock'))).toBe(true);
  });

  it('reads a JSON lock file the target\'s way', () => {
    const lock = parseIdeLock(
      JSON.stringify({
        workspaceFolders: ['/w/project'],
        port: 9999,
        pid: 4242,
        ideName: 'Cursor',
        transport: 'ws',
        runningInWindows: true,
        authToken: 'token',
      }),
      '12345.lock',
    );

    expect(lock).toEqual({
      workspaceFolders: ['/w/project'],
      port: 12345,
      pid: 4242,
      ideName: 'Cursor',
      useWebSocket: true,
      runningInWindows: true,
      authToken: 'token',
    });
  });

  it('reads a body that is not JSON as a newline-delimited list of folders', () => {
    const lock = parseIdeLock('/w/one\n/w/two\n', '777.lock');

    // The target splits and trims, and keeps the trailing empty line; the
    // discovery is what skips an empty folder.
    expect(lock.workspaceFolders).toEqual(['/w/one', '/w/two', '']);
    expect(lock.port).toBe(777);
    expect(lock.useWebSocket).toBe(false);
    expect(lock.runningInWindows).toBe(false);
  });

  it('only calls the IDE running on Windows when the lock says so', () => {
    expect(parseIdeLock('{"runningInWindows":false}', '1.lock').runningInWindows).toBe(false);
    expect(parseIdeLock('{"runningInWindows":true}', '1.lock').runningInWindows).toBe(true);
    // Only the exact value `true` counts.
    expect(parseIdeLock('{"runningInWindows":"true"}', '1.lock').runningInWindows).toBe(false);
  });

  it('has three workspace relations', () => {
    expect(workspaceRelation('/w/project', '/w')).toBe('contains-cwd');
    expect(workspaceRelation('/w', '/w/project')).toBe('inside-cwd');
    expect(workspaceRelation('/a', '/b')).toBe('unrelated');
    expect(workspaceRelation('/w', '/w')).toBe('contains-cwd');
    // A sibling whose name starts the same is not inside.
    expect(workspaceRelation('/w', '/wx')).toBe('unrelated');
  });

  it('tests containment the way the target does: the candidate comes first', () => {
    expect(isPathInside('/w/project', '/w')).toBe(true);
    expect(isPathInside('/wx', '/w')).toBe(false);
    expect(isPathInside('/w', '/w')).toBe(true);
    // The target's test is case-sensitive; the case-insensitive mode is this
    // implementation's own.
    expect(isPathInside('/W/project', '/w', true)).toBe(false);
    expect(isPathInside('/W/project', '/w', false)).toBe(true);
  });

  it('orders the lock files newest first', () => {
    const sorted = sortIdeLockFiles([
      { path: '/a.lock', mtime: 10 },
      { path: '/b.lock', mtime: 30 },
      { path: '/c.lock', mtime: 20 },
    ]);
    expect(sorted.map((file) => file.path)).toEqual(['/b.lock', '/c.lock', '/a.lock']);
  });

  it('calls a lock stale when its process is dead', async () => {
    const lock: IdeLock = {
      workspaceFolders: [],
      port: 1234,
      pid: 4242,
      useWebSocket: false,
      runningInWindows: false,
    };

    await expect(
      isIdeLockStale(lock, '127.0.0.1', {
        isProcessAlive: () => false,
        canConnect: () => true,
        isWsl: false,
      }),
    ).resolves.toBe(true);
  });

  it('does not call a lock stale under WSL when the port still answers', async () => {
    const lock: IdeLock = {
      workspaceFolders: [],
      port: 1234,
      pid: 4242,
      useWebSocket: false,
      runningInWindows: false,
    };

    await expect(
      isIdeLockStale(lock, '127.0.0.1', {
        isProcessAlive: () => false,
        canConnect: () => true,
        isWsl: true,
      }),
    ).resolves.toBe(false);

    await expect(
      isIdeLockStale(lock, '127.0.0.1', {
        isProcessAlive: () => false,
        canConnect: () => false,
        isWsl: true,
      }),
    ).resolves.toBe(true);
  });

  it('calls a lock with no process stale when the port refuses', async () => {
    const lock: IdeLock = {
      workspaceFolders: [],
      port: 1234,
      useWebSocket: false,
      runningInWindows: false,
    };

    await expect(
      isIdeLockStale(lock, '127.0.0.1', {
        isProcessAlive: () => true,
        canConnect: () => false,
        isWsl: false,
      }),
    ).resolves.toBe(true);
  });

  it('builds the two urls the target builds', () => {
    const base: IdeLock = {
      workspaceFolders: [],
      port: 1234,
      useWebSocket: false,
      runningInWindows: false,
    };
    expect(ideUrl(base, '127.0.0.1')).toBe('http://127.0.0.1:1234/sse');
    expect(ideUrl({ ...base, useWebSocket: true }, '127.0.0.1')).toBe('ws://127.0.0.1:1234');
  });

  it('keeps the IDE whose workspace holds the session\'s directory', () => {
    const ides = discoverIdes({
      cwd: '/w/project',
      locks: [
        {
          workspaceFolders: ['/w'],
          port: 1234,
          ideName: 'Cursor',
          useWebSocket: false,
          runningInWindows: false,
        },
      ],
    });

    expect(ides).toEqual([
      {
        url: 'http://127.0.0.1:1234/sse',
        name: 'Cursor',
        workspaceFolders: ['/w'],
        port: 1234,
        isValid: true,
        workspaceContainsCwd: true,
        ideRunningInWindows: false,
      },
    ]);
  });

  it('drops the IDE whose workspace is unrelated, unless they are asked for', () => {
    const locks: IdeLock[] = [
      {
        workspaceFolders: ['/elsewhere'],
        port: 1234,
        ideName: 'Cursor',
        useWebSocket: false,
        runningInWindows: false,
      },
    ];

    expect(discoverIdes({ cwd: '/w/project', locks })).toEqual([]);

    const unrelated = discoverIdes({ cwd: '/w/project', locks, includeUnrelated: true });
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]?.isValid).toBe(false);
    expect(unrelated[0]?.workspaceContainsCwd).toBe(false);
  });

  it('calls the one IDE the target connects to, and only when there is exactly one', () => {
    const make = (port: number, folder: string): DiscoveredIde => ({
      url: `http://127.0.0.1:${port}/sse`,
      name: 'Cursor',
      workspaceFolders: [folder],
      port,
      isValid: true,
      workspaceContainsCwd: true,
      ideRunningInWindows: false,
    });

    expect(theSingleContainingIde([make(1, '/w')])).toBeDefined();
    expect(theSingleContainingIde([make(1, '/w'), make(2, '/w')])).toBeUndefined();
    expect(theSingleContainingIde([])).toBeUndefined();
  });

  it('waits thirty seconds for an IDE, polling every second', () => {
    expect(IDE_DETECTION_WINDOW_MS).toBe(30_000);
    expect(IDE_DETECTION_POLL_INTERVAL_MS).toBe(1_000);
  });

  it('parses a boolean environment variable the way the target does', () => {
    // The target accepts `1`, `true`, `yes` and `on`, lower-cased and
    // trimmed; everything else is false.
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on', 'ON']) {
      expect(envBoolean(value)).toBe(true);
    }
    for (const value of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(envBoolean(value)).toBe(false);
    }
  });

  it('parses an integer environment variable the way the target does', () => {
    expect(envInteger('1234')).toBe(1234);
    expect(envInteger(' 1234 ')).toBe(1234);
    expect(envInteger(undefined)).toBeUndefined();
    expect(envInteger('not a number')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The diagnostics subsystem                                                   */
/* -------------------------------------------------------------------------- */

describe('the IDE diagnostics subsystem', () => {
  it('has four severities, and five keys that name them', () => {
    expect(normalizeDiagnosticSeverity('Error')).toBe('Error');
    expect(normalizeDiagnosticSeverity('error')).toBe('Error');
    expect(normalizeDiagnosticSeverity('WARNING')).toBe('Warning');
    expect(normalizeDiagnosticSeverity('info')).toBe('Info');
    // `information` and `info` are the same severity.
    expect(normalizeDiagnosticSeverity('information')).toBe('Info');
    expect(normalizeDiagnosticSeverity('hint')).toBe('Hint');
    // A severity the target does not know is dropped, not kept as-is.
    expect(normalizeDiagnosticSeverity('critical')).toBeUndefined();
    expect(normalizeDiagnosticSeverity(42)).toBeUndefined();
  });

  it('drops a malformed file and counts it', () => {
    const result = validateDiagnosticsPayload([
      { uri: 42, diagnostics: [] },
      { uri: '/a.ts' },
      { uri: '/b.ts', diagnostics: [] },
    ]);

    expect(result.droppedFiles).toBe(3);
    expect(result.droppedDiagnostics).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('drops a malformed diagnostic and counts it', () => {
    const result = validateDiagnosticsPayload([
      { uri: '/a.ts', diagnostics: [{ message: 'no range' }] },
      {
        uri: '/b.ts',
        diagnostics: [
          { message: 'fine', range: { start: { line: 1, character: 2 } } },
          { range: { start: { line: 1, character: 2 } } },
        ],
      },
    ]);

    expect(result.droppedFiles).toBe(1);
    expect(result.droppedDiagnostics).toBe(2);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.uri).toBe('/b.ts');
  });

  it('drops a payload that is not an array', () => {
    const result = validateDiagnosticsPayload('not an array');
    expect(result.droppedPayload).toBe(true);
    expect(result.files).toEqual([]);
  });

  it('falls back to the range start when the range end is not a pair of numbers', () => {
    const result = validateDiagnosticsPayload([
      {
        uri: '/a.ts',
        diagnostics: [{ message: 'm', range: { start: { line: 3, character: 4 } } }],
      },
    ]);

    expect(result.files[0]?.diagnostics[0]?.range).toEqual({
      start: { line: 3, character: 4 },
      end: { line: 3, character: 4 },
    });
  });

  it('keeps only a string code and a string source', () => {
    const result = validateDiagnosticsPayload([
      {
        uri: '/a.ts',
        diagnostics: [
          {
            message: 'm',
            code: 42,
            source: 7,
            range: { start: { line: 0, character: 0 } },
          },
        ],
      },
    ]);

    const kept = result.files[0]?.diagnostics[0];
    expect(kept?.code).toBeUndefined();
    expect(kept?.source).toBeUndefined();
  });

  it('normalizes the severity of a surviving diagnostic', () => {
    const result = validateDiagnosticsPayload([
      {
        uri: '/a.ts',
        diagnostics: [
          {
            message: 'm',
            severity: 'information',
            range: { start: { line: 0, character: 0 } },
          },
          {
            message: 'n',
            severity: 'critical',
            range: { start: { line: 0, character: 0 } },
          },
        ],
      },
    ]);

    expect(result.files[0]?.diagnostics[0]?.severity).toBe('Info');
    expect(result.files[0]?.diagnostics[1]?.severity).toBeUndefined();
  });

  it('finds only the diagnostics that are not in the baseline', () => {
    const known = diagnostic({ message: 'known' });
    const fresh = diagnostic({ message: 'fresh' });

    const result = newDiagnostics([known], [known, fresh]);
    expect(result.map((entry) => entry.message)).toEqual(['fresh']);
  });

  it('renders the new-diagnostics block the target\'s way', () => {
    const files: IdeDiagnosticFile[] = [
      {
        uri: '/w/a.ts',
        diagnostics: [
          diagnostic({
            message: 'unused variable',
            severity: 'Error',
            range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } },
          }),
        ],
      },
    ];

    expect(renderNewDiagnostics(files)).toBe(
      '<new-diagnostics>The following new diagnostic issues were detected:\n\n' +
        'a.ts:\n' +
        '  ✘ [Line 3:4] unused variable' +
        '</new-diagnostics>',
    );
  });

  it('truncates the rendered block at four thousand characters', () => {
    const files: IdeDiagnosticFile[] = [
      {
        uri: '/w/a.ts',
        diagnostics: [diagnostic({ message: 'x'.repeat(5000) })],
      },
    ];

    const prefix = '<new-diagnostics>The following new diagnostic issues were detected:\n\n';
    const suffix = '</new-diagnostics>';
    const rendered = renderNewDiagnostics(files);

    expect(rendered.startsWith(prefix)).toBe(true);
    expect(rendered.endsWith(`${suffix}`)).toBe(true);

    const body = rendered.slice(prefix.length, rendered.length - suffix.length);
    expect(body).toHaveLength(4000);
    expect(body.endsWith('…[truncated]')).toBe(true);
  });

  it('holds the target\'s own three timeouts and its cutoff', () => {
    expect(IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MS).toBe(500);
    expect(IDE_DIAGNOSTICS_FETCH_TIMEOUT_MS).toBe(2000);
    expect(IDE_DIAGNOSTICS_MAX_CONSECUTIVE_BASELINE_TIMEOUTS).toBe(3);
    expect(IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MESSAGE).toBe('IDE diagnostics baseline timed out');
    expect(IDE_DIAGNOSTICS_BASELINES_DISABLED_MESSAGE).toBe(
      'IDE diagnostics baselines disabled after 3 consecutive timeouts',
    );
  });

  it('does not baseline the server the target leaves out', async () => {
    const calls: string[] = [];
    const manager = new IdeDiagnosticsManager(
      {},
      async (tool) => {
        calls.push(tool);
        return [{ type: 'text', text: JSON.stringify([]) }];
      },
      ['a-plugin-server-the-target-leaves-out'],
    );
    manager.initialize({
      type: 'connected',
      serverInfo: { name: 'a-plugin-server-the-target-leaves-out' },
    });

    await manager.beforeFileEdited('/w/a.ts');
    expect(calls).toEqual([]);
    expect(manager.baseline.size).toBe(0);
  });

  it('follows the target\'s lifecycle: initialize once, shutdown clears, reset keeps the counter', () => {
    const manager = new IdeDiagnosticsManager();
    manager.consecutiveBaselineTimeouts = 2;

    manager.initialize({ type: 'connected' });
    manager.initialize({ type: 'failed' });
    expect(manager.baseline.size).toBe(0);

    manager.reset();
    // The reset does not touch the cutoff counter.
    expect(manager.consecutiveBaselineTimeouts).toBe(2);

    manager.shutdown();
    expect(manager.consecutiveBaselineTimeouts).toBe(0);
  });

  it('baselines a file and reports only the diagnostics that are new', async () => {
    const replies: unknown[] = [
      [{ type: 'text', text: JSON.stringify([{ uri: 'file:///w/a.ts', diagnostics: [] }]) }],
      [
        {
          type: 'text',
          text: JSON.stringify([
            {
              uri: 'file:///w/a.ts',
              diagnostics: [
                {
                  message: 'fresh',
                  severity: 'Warning',
                  range: { start: { line: 0, character: 0 } },
                },
              ],
            },
          ]),
        },
      ],
    ];

    const manager = new IdeDiagnosticsManager({}, async () => replies.shift());
    manager.initialize({ type: 'connected' });

    await manager.beforeFileEdited('/w/a.ts');
    expect(manager.baseline.size).toBe(1);

    const fresh = await manager.getNewDiagnostics();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.uri).toBe('file:///w/a.ts');
    expect(fresh[0]?.diagnostics.map((entry) => entry.message)).toEqual(['fresh']);
  });

  it('disables the baselines after three consecutive timeouts, and says so', async () => {
    const logs: string[] = [];
    const manager = new IdeDiagnosticsManager(
      { log: (message) => logs.push(message) },
      async () => {
        throw new Error(IDE_DIAGNOSTICS_BASELINE_TIMEOUT_MESSAGE);
      },
    );

    manager.initialize({ type: 'connected' });
    for (let round = 0; round < 3; round++) {
      await manager.beforeFileEdited('/w/a.ts');
    }

    expect(manager.consecutiveBaselineTimeouts).toBe(3);
    expect(logs).toContain(IDE_DIAGNOSTICS_BASELINES_DISABLED_MESSAGE);
  });

  it('refuses a diagnostics request that has no client, and names the capability', async () => {
    const manager = new IdeDiagnosticsManager();

    await expect(manager.requestDiagnostics()).rejects.toBeInstanceOf(IdeCapabilityError);
    await expect(manager.requestDiagnostics()).rejects.toThrow(/a connected IDE client/);
  });
});

/* -------------------------------------------------------------------------- */
/* The bridge                                                                  */
/* -------------------------------------------------------------------------- */

describe('the IDE bridge and the target\'s IDE surface', () => {
  it('exposes the target\'s eighteen IDEs', () => {
    const bridge = createIdeBridge({ configDir: tempDir() });
    expect(bridge.registry()).toHaveLength(18);
    expect(bridge.ide('cursor')?.displayName).toBe('Cursor');
    expect(bridge.ide('emacs')).toBeUndefined();
  });

  it('reads a lock file the target\'s way', () => {
    const configDir = tempDir();
    mkdirSync(path.join(configDir, 'ide'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'ide', '12345.lock'),
      JSON.stringify({ workspaceFolders: ['/w'], ideName: 'Cursor', transport: 'ws' }),
    );

    const bridge = createIdeBridge({ configDir });

    expect(bridge.locks()).toEqual([
      {
        workspaceFolders: ['/w'],
        port: 12345,
        ideName: 'Cursor',
        useWebSocket: true,
        runningInWindows: false,
      },
    ]);

    const integrations = bridge.list();
    expect(integrations.map((integration) => integration.name)).toEqual(['Cursor']);
    expect(integrations[0]?.transport).toBe('websocket');
    expect(integrations[0]?.endpoint).toBe('http://127.0.0.1:12345');
  });

  it('reads the two environment variables the discovery takes', () => {
    const configDir = tempDir();
    mkdirSync(path.join(configDir, 'ide'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'ide', '12345.lock'),
      JSON.stringify({ workspaceFolders: ['/elsewhere'], ideName: 'Cursor' }),
    );

    // Without the skip, the IDE's workspace is unrelated to the session's
    // directory and it is dropped.
    const strict = createIdeBridge({ configDir, cwd: '/w/project', env: {} });
    expect(strict.ides()).toEqual([]);

    // The skip makes every lock valid.
    const skipping = createIdeBridge({
      configDir,
      cwd: '/w/project',
      env: { CLAUDE_CODE_IDE_SKIP_VALID_CHECK: '1' },
    });
    expect(skipping.ides()).toHaveLength(1);
    expect(skipping.ides()[0]?.isValid).toBe(true);

    // The variable is parsed the target's way: `0` is not a skip.
    const notSkipping = createIdeBridge({
      configDir,
      cwd: '/w/project',
      env: { CLAUDE_CODE_IDE_SKIP_VALID_CHECK: '0' },
    });
    expect(notSkipping.ides()).toEqual([]);

    // The SSE port names exactly one IDE, and it is valid.
    const named = createIdeBridge({
      configDir,
      cwd: '/w/project',
      env: { CLAUDE_CODE_SSE_PORT: '12345' },
    });
    expect(named.ides()).toHaveLength(1);
    expect(named.ides()[0]?.port).toBe(12345);
  });

  it('refuses to connect to an IDE, and names the capability', async () => {
    const bridge = createIdeBridge({ configDir: tempDir() });

    await expect(bridge.connect('vscode')).rejects.toBeInstanceOf(IdeCapabilityError);
    await expect(bridge.connect('vscode')).rejects.toThrow(IDE_CONNECTION_CAPABILITY);
    // The refusal names the IDE it was about.
    await expect(bridge.connect('vscode')).rejects.toThrow(/VS Code/);
  });

  it('refuses to ask an IDE for diagnostics, and names the capability', async () => {
    const bridge = createIdeBridge({ configDir: tempDir() });

    await expect(bridge.requestDiagnostics()).rejects.toBeInstanceOf(IdeCapabilityError);
    await expect(bridge.requestDiagnostics()).rejects.toThrow(IDE_DIAGNOSTICS_CAPABILITY);
  });

  it('refuses to install the extension, and names the capability', async () => {
    const bridge = createIdeBridge({ configDir: tempDir() });

    await expect(bridge.installExtension('cursor')).rejects.toBeInstanceOf(IdeCapabilityError);
    await expect(bridge.installExtension('cursor')).rejects.toThrow(
      IDE_EXTENSION_INSTALL_CAPABILITY,
    );
    await expect(bridge.installExtension('cursor')).rejects.toThrow(/Cursor/);
  });

  it('hands out the diagnostics manager, and it refuses too', async () => {
    const bridge = createIdeBridge({ configDir: tempDir() });
    await expect(bridge.diagnostics().requestDiagnostics()).rejects.toThrow(
      IDE_DIAGNOSTICS_CAPABILITY,
    );
  });
});
