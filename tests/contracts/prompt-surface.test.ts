/**
 * Contract test: the **prompt-management surface** — the `prompt.section` extension
 * point and the `type:"prompt"` command kind.
 *
 * Evidence: `chunk-4jsg44k7.js:44481` (the dispatch), `:53395` (the core handler),
 * `:1742093` (the prompt-command factory), `:1683834`, `:1713935`, `:1732230`,
 * `:2198875`, `:2203807` (the built-in prompt commands), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §7.
 */

import { describe, expect, it } from 'vitest';

import { SLASH_COMMANDS, slashCommandOf } from '../../src/cli/commands/slash.js';
import { createExtensionPointRegistry } from '../../src/extensions/plugins/extension-points.js';
import { composePromptSection } from '../../src/extensions/prompts/section.js';

describe('the prompt section', () => {
  it('leaves the text as it is when no handler is registered', async () => {
    const registry = createExtensionPointRegistry();
    expect(await composePromptSection(registry, 'environment', 'the text')).toBe('the text');
  });

  it('hands the handler the section\'s name and its text', async () => {
    const registry = createExtensionPointRegistry();
    let seen: unknown;
    registry.register('prompt.section', (payload) => {
      seen = payload;
      return { text: 'rewritten' };
    });

    expect(await composePromptSection(registry, 'environment', 'the text')).toBe('rewritten');
    expect(seen).toMatchObject({ name: 'environment', text: 'the text' });
  });

  it('carries the origin when the caller knows one', async () => {
    const registry = createExtensionPointRegistry();
    let seen: unknown;
    registry.register('prompt.section', (payload) => {
      seen = payload;
      return { text: 'the text' };
    });

    await composePromptSection(registry, 'environment', 'the text', { kind: 'system' });
    expect(seen).toMatchObject({ origin: { kind: 'system' } });
  });

  it('leaves the text as it is when the handler rewrites nothing', async () => {
    const registry = createExtensionPointRegistry();
    registry.register('prompt.section', () => ({}));
    expect(await composePromptSection(registry, 'environment', 'the text')).toBe('the text');
  });

  it('is the identity by default, like the target\'s core handler', async () => {
    const registry = createExtensionPointRegistry();
    registry.register('prompt.section', (payload) => ({ text: payload['text'] }));
    expect(await composePromptSection(registry, 'environment', 'the text')).toBe('the text');
  });
});

describe('the prompt command kind', () => {
  it('registers exactly the target\'s five built-in prompt commands', () => {
    const prompts = SLASH_COMMANDS.filter((command) => command.type === 'prompt');
    expect(prompts.map((command) => command.name)).toEqual([
      'commit-push-pr',
      'init',
      'team-onboarding',
      'statusline',
      'insights',
    ]);
  });

  it('carries the target\'s own progress messages', () => {
    expect(slashCommandOf('commit-push-pr')?.progressMessage).toBe('creating commit and PR');
    expect(slashCommandOf('init')?.progressMessage).toBe('analyzing your codebase');
    expect(slashCommandOf('team-onboarding')?.progressMessage).toBe('scanning usage data');
    expect(slashCommandOf('statusline')?.progressMessage).toBe('setting up statusLine');
    expect(slashCommandOf('insights')?.progressMessage).toBe('analyzing your sessions');
  });

  it('carries the target\'s own invocation flags', () => {
    expect(slashCommandOf('commit-push-pr')?.disableModelInvocation).toBe(false);
    expect(slashCommandOf('init')?.disableModelInvocation).toBe(false);
    expect(slashCommandOf('team-onboarding')?.disableModelInvocation).toBe(true);
    expect(slashCommandOf('statusline')?.disableModelInvocation).toBe(true);
    expect(slashCommandOf('insights')?.disableModelInvocation).toBe(true);
  });

  it('carries the target\'s own policy gates', () => {
    expect(slashCommandOf('team-onboarding')?.policyGate).toEqual({
      policy: 'allow_team_onboarding',
    });
    expect(slashCommandOf('insights')?.policyGate).toEqual({ policy: 'allow_insights' });
    expect(slashCommandOf('commit-push-pr')?.policyGate).toBeUndefined();
  });

  it('carries the target\'s own requirements', () => {
    expect(slashCommandOf('team-onboarding')?.requires).toEqual({ workspace: true });
    expect(slashCommandOf('statusline')?.requires).toEqual({ workspace: true });
    expect(slashCommandOf('insights')?.requires).toEqual({ workspace: true });
    expect(slashCommandOf('init')?.requires).toBeUndefined();
  });

  it('carries the target\'s own source and content length', () => {
    for (const name of ['commit-push-pr', 'init', 'team-onboarding', 'statusline', 'insights']) {
      expect(slashCommandOf(name)?.source).toBe('builtin');
      expect(slashCommandOf(name)?.contentLength).toBe(0);
    }
  });
});
