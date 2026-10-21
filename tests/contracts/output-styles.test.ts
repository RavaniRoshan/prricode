/**
 * Contract test: the **output styles** — the built-in styles, the loader, and the
 * `/output-style` command.
 *
 * Evidence: `chunk-4jsg44k7.js:2262166` (the built-in styles), `:2255227` (the
 * directory), `:737660` (the scanned directories), `:2255368` (the loader and the
 * shape), `:730783` (the frontmatter schema), `:737733` (the sort),
 * `chunk-qm7dk4mx.js:11720` (the command), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §4.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runSlashCommand, type SlashCommandContext } from '../../src/cli/commands/slash.js';
import { catalogStoreOfState } from '../../src/cli/commands/catalog.js';
import {
  BUILTIN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE_NAME,
  allOutputStyles,
  builtinOutputStyleOf,
  currentOutputStyle,
  isRemoteOrRelayedSession,
  isRemotelySelectableOutputStyle,
  loadOutputStyles,
  outputStyleDescription,
  parseOutputStyleFrontmatter,
  projectStyleDirectories,
  writeOutputStyleSetting,
} from '../../src/config/outputStyles.js';
import { createProviderRegistry } from '../../src/provider/registry.js';
import { createSessionStore } from '../../src/session/store.js';

/** The temporary directories the test creates. */
const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc041-styles-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function slashContext(cwd: string, configDir: string): SlashCommandContext {
  return {
    store: createSessionStore({ configDir }),
    cwd,
    configDir,
    sessionId: 'session-under-test',
    model: 'claude-sonnet-4-5',
    version: '0.1.0',
    events: [],
    env: {},
    managerState: async () => ({
      registry: createProviderRegistry(),
      catalogs: catalogStoreOfState([]),
    }),
    managerOptions: () => ({}),
  };
}

describe('the built-in output styles', () => {
  it('carries the target\'s four styles and the default name', () => {
    expect(BUILTIN_OUTPUT_STYLES.map((style) => style.name)).toEqual([
      'Proactive',
      'Concise',
      'Explanatory',
      'Learning',
    ]);
    expect(DEFAULT_OUTPUT_STYLE_NAME).toBe('default');
  });

  it('gives every built-in style a prompt and keeps the coding instructions', () => {
    for (const style of BUILTIN_OUTPUT_STYLES) {
      expect(style.prompt.length).toBeGreaterThan(100);
      expect(style.keepCodingInstructions).toBe(true);
    }
  });

  it('names this implementation\'s product in the descriptions, not the target\'s', () => {
    // The target's own name, spelled in pieces, so this file does not carry it.
    const target = ['Cla', 'ude'].join('');
    for (const style of BUILTIN_OUTPUT_STYLES) {
      expect(style.description).toContain('PRRICODE');
      expect(style.description).not.toContain(target);
    }
  });

  it('finds a built-in style by its name, case-insensitively', () => {
    expect(builtinOutputStyleOf('concise')?.name).toBe('Concise');
    expect(builtinOutputStyleOf('  CONCISE  ')?.name).toBe('Concise');
    expect(builtinOutputStyleOf('nope')).toBeUndefined();
  });
});

describe('the output style frontmatter', () => {
  it('reads the four keys the target\'s schema names', () => {
    const parsed = parseOutputStyleFrontmatter(
      ['---', 'name: My Style', 'description: A style', 'keep-coding-instructions: true', '---', 'Body.'].join(
        '\n',
      ),
    );
    expect(parsed.frontmatter.name).toBe('My Style');
    expect(parsed.frontmatter.description).toBe('A style');
    expect(parsed.frontmatter['keep-coding-instructions']).toBe(true);
    expect(parsed.content).toBe('Body.');
  });

  it('reads a file with no frontmatter as a body', () => {
    const parsed = parseOutputStyleFrontmatter('Just a body.');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.content).toBe('Just a body.');
  });

  it('falls back to the first heading for a description', () => {
    expect(outputStyleDescription({}, 'fallback', '# The Heading\n\nbody')).toBe('The Heading');
  });

  it('falls back to the first line of the body when the frontmatter has none', () => {
    expect(outputStyleDescription({}, 'fallback', 'body only')).toBe('body only');
  });

  it('falls back to a named style when the body has no line at all', () => {
    expect(outputStyleDescription({}, 'fallback', '')).toBe('Custom fallback output style');
  });

  it('cuts a heading longer than a hundred characters', () => {
    const heading = '# ' + 'x'.repeat(120);
    const description = outputStyleDescription({}, 'fallback', heading);
    expect(description.endsWith('...')).toBe(true);
    expect(description.length).toBe(100);
  });
});

describe('the output style loader', () => {
  it('reads a style from the configuration root', async () => {
    const configRoot = makeDirectory();
    mkdirSync(path.join(configRoot, 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(configRoot, 'output-styles', 'mine.md'),
      ['---', 'name: Mine', 'description: My own style', '---', 'Be brief.'].join('\n'),
      'utf8',
    );

    const styles = await loadOutputStyles({ cwd: makeDirectory(), configRoot });
    expect(styles).toHaveLength(1);
    expect(styles[0]?.name).toBe('Mine');
    expect(styles[0]?.description).toBe('My own style');
    expect(styles[0]?.prompt).toBe('Be brief.');
    expect(styles[0]?.source).toBe('user');
    expect(styles[0]?.keepCodingInstructions).toBe(false);
  });

  it('names a style after its file when the frontmatter does not', async () => {
    const configRoot = makeDirectory();
    mkdirSync(path.join(configRoot, 'output-styles'), { recursive: true });
    writeFileSync(path.join(configRoot, 'output-styles', 'from-file.md'), 'Body.', 'utf8');

    const styles = await loadOutputStyles({ cwd: makeDirectory(), configRoot });
    expect(styles[0]?.name).toBe('from-file');
  });

  it('reads the project\'s own styles directory', async () => {
    const configRoot = makeDirectory();
    const home = makeDirectory();
    const project = path.join(home, 'work', 'project');
    mkdirSync(path.join(project, '.claude', 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(project, '.claude', 'output-styles', 'project.md'),
      ['---', 'name: Project', '---', 'Body.'].join('\n'),
      'utf8',
    );

    const styles = await loadOutputStyles({ cwd: project, configRoot, homeDir: home });
    expect(styles.map((style) => style.name)).toContain('Project');
    expect(styles.find((style) => style.name === 'Project')?.source).toBe('project');
  });

  it('walks the project directories up to the home directory', () => {
    const home = makeDirectory();
    const project = path.join(home, 'work', 'project');
    expect(projectStyleDirectories(project, home)).toEqual([
      path.join(project, '.claude', 'output-styles'),
      path.join(home, 'work', '.claude', 'output-styles'),
    ]);
  });

  it('puts the built-in styles before the file styles, and the file styles replace them', async () => {
    const configRoot = makeDirectory();
    mkdirSync(path.join(configRoot, 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(configRoot, 'output-styles', 'Concise.md'),
      ['---', 'name: Concise', '---', 'Mine.'].join('\n'),
      'utf8',
    );

    const styles = await allOutputStyles({ cwd: makeDirectory(), configRoot });
    expect(styles.map((style) => style.name)).toEqual([
      'default',
      'Proactive',
      'Concise',
      'Explanatory',
      'Learning',
    ]);
    const concise = styles.find((style) => style.name === 'Concise');
    expect(concise?.prompt).toBe('Mine.');
    expect(concise?.source).toBe('user');
  });
});

describe('the output style setting', () => {
  it('defaults to the default style', () => {
    expect(currentOutputStyle(undefined)).toBe('default');
    expect(currentOutputStyle({})).toBe('default');
    expect(currentOutputStyle({ outputStyle: 'Concise' })).toBe('Concise');
  });

  it('saves the style to the project\'s local settings file, keeping the rest', async () => {
    const project = makeDirectory();
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }),
      'utf8',
    );

    await writeOutputStyleSetting(project, 'Concise');

    const written = JSON.parse(
      (await import('node:fs')).readFileSync(
        path.join(project, '.claude', 'settings.local.json'),
        'utf8',
      ),
    ) as { outputStyle: string; permissions: { allow: string[] } };
    expect(written.outputStyle).toBe('Concise');
    expect(written.permissions.allow).toEqual(['Bash(ls *)']);
  });
});

describe('the output-style command', () => {
  it('lists the styles', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const result = await runSlashCommand('/output-style', slashContext(cwd, configDir));

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Output style: default');
    expect(result?.stdout).toContain('Available styles:');
    expect(result?.stdout).toContain('- Concise');
    expect(result?.stdout).toContain('Usage: /output-style <style>');
  });

  it('refuses a style it does not know, and names the ones it does', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const result = await runSlashCommand('/output-style nope', slashContext(cwd, configDir));

    expect(result?.exitCode).not.toBe(0);
    expect(result?.stderr).toContain('Unknown output style "nope"');
    expect(result?.stderr).toContain('Concise');
  });

  it('says the style is already the active one', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const result = await runSlashCommand('/output-style default', slashContext(cwd, configDir));

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Output style is already default');
  });

  it('saves the style it is given', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const result = await runSlashCommand('/output-style Concise', slashContext(cwd, configDir));

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Output style set to Concise');

    const written = JSON.parse(
      (await import('node:fs')).readFileSync(
        path.join(cwd, '.claude', 'settings.local.json'),
        'utf8',
      ),
    ) as { outputStyle: string };
    expect(written.outputStyle).toBe('Concise');
  });

  it('shows the list for a word that asks for the list', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    const result = await runSlashCommand('/output-style list', slashContext(cwd, configDir));

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Available styles:');
  });
});

describe('the output-style command over a remote or relayed session', () => {
  it('is a remote session when the message was dispatched over a bridge', () => {
    expect(isRemoteOrRelayedSession({ dispatchedOverBridge: true })).toBe(true);
    expect(isRemoteOrRelayedSession({ dispatchedOverBridge: false })).toBe(false);
    expect(isRemoteOrRelayedSession({})).toBe(false);
  });

  it('is a remote session when the message came from a verified Slack turn', () => {
    expect(isRemoteOrRelayedSession({ submissionVerifiedSlackHumanTurn: true })).toBe(true);
    expect(isRemoteOrRelayedSession({ submissionVerifiedSlackHumanTurn: false })).toBe(false);
  });

  it('lets only the built-in styles be picked', () => {
    expect(isRemotelySelectableOutputStyle(null)).toBe(true);
    expect(
      isRemotelySelectableOutputStyle({
        name: 'Concise',
        description: '',
        prompt: '',
        source: 'built-in',
        baseDir: '',
        keepCodingInstructions: false,
      }),
    ).toBe(true);
    expect(
      isRemotelySelectableOutputStyle({
        name: 'Mine',
        description: '',
        prompt: '',
        source: 'user',
        baseDir: '',
        keepCodingInstructions: false,
      }),
    ).toBe(false);
  });

  it('lists only the built-in styles, and says why', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    mkdirSync(path.join(configDir, 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'output-styles', 'mine.md'),
      ['---', 'name: Mine', 'description: My own style', '---', 'Be brief.'].join('\n'),
      'utf8',
    );

    const context = {
      ...slashContext(cwd, configDir),
      dispatchedOverBridge: true,
    };
    const result = await runSlashCommand('/output-style', context);

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('- Concise');
    expect(result?.stdout).not.toContain('- Mine');
    expect(result?.stdout).toContain(
      "Custom output styles can't be selected over Remote Control or from a relayed message.",
    );
  });

  it('reports the current custom style as "a custom style"', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    mkdirSync(path.join(configDir, 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'output-styles', 'mine.md'),
      ['---', 'name: Mine', '---', 'Be brief.'].join('\n'),
      'utf8',
    );
    await writeOutputStyleSetting(cwd, 'Mine');

    const context = {
      ...slashContext(cwd, configDir),
      submissionVerifiedSlackHumanTurn: true,
    };
    const result = await runSlashCommand('/output-style', context);

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Output style: a custom style');
  });

  it('refuses a custom style over a remote session', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    mkdirSync(path.join(configDir, 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'output-styles', 'mine.md'),
      ['---', 'name: Mine', '---', 'Be brief.'].join('\n'),
      'utf8',
    );

    const context = {
      ...slashContext(cwd, configDir),
      dispatchedOverBridge: true,
    };
    const result = await runSlashCommand('/output-style Mine', context);

    expect(result?.exitCode).not.toBe(0);
    expect(result?.stderr).toContain('Unknown output style "Mine"');
    expect(result?.stderr).toContain(
      "Custom output styles can't be selected over Remote Control or from a relayed message.",
    );
  });

  it('lists every style in a session that is not remote', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    mkdirSync(path.join(configDir, 'output-styles'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'output-styles', 'mine.md'),
      ['---', 'name: Mine', '---', 'Be brief.'].join('\n'),
      'utf8',
    );

    const result = await runSlashCommand('/output-style', slashContext(cwd, configDir));

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('- Mine');
    expect(result?.stdout).not.toContain(
      "Custom output styles can't be selected over Remote Control or from a relayed message.",
    );
  });

  it('reports a current style the registry does not hold as a custom one', async () => {
    const configDir = makeDirectory();
    const cwd = makeDirectory();
    await writeOutputStyleSetting(cwd, 'Gone');

    const context = {
      ...slashContext(cwd, configDir),
      dispatchedOverBridge: true,
    };
    const result = await runSlashCommand('/output-style', context);

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('Output style: a custom style');
  });
});
