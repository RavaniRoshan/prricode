/**
 * Contract test: the shipped **site-configuration bundle** and the resolution of the
 * auto-mode severity thresholds out of it.
 *
 * Evidence: `chunk-f27ph7ed.js:260401` (the bundle literal), `:260867` (how the bundle
 * is obtained), `chunk-4jsg44k7.js:1646178` (the built-in thresholds), `:1646348` (the
 * resolution), `:1647108` (the per-model lookup). The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §1.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEVERITY_THRESHOLDS,
  DEFAULT_SITE_CONFIG,
  EMPTY_SITE_CONFIG,
  isSeverityThreshold,
  resolveSeverity,
  resolveSeverityByModel,
  severityThresholdsFor,
} from '../../src/config/siteConfig.js';

describe('the site-configuration bundle', () => {
  it('ships the target\'s own nine members with the target\'s own values', () => {
    expect(DEFAULT_SITE_CONFIG.twoStageClassifier).toBe(true);
    expect(DEFAULT_SITE_CONFIG.sameTurnSiblingContext).toBe(true);
    expect(DEFAULT_SITE_CONFIG.editRemovalVisibility).toBe(true);
    expect(DEFAULT_SITE_CONFIG.editRemovalCap).toBe(3000);
    expect(DEFAULT_SITE_CONFIG.outcomeVisibility).toBe(false);
    expect(DEFAULT_SITE_CONFIG.repoVisibility).toBe(true);
    expect(DEFAULT_SITE_CONFIG.gitStatusType).toBe(true);
    expect(DEFAULT_SITE_CONFIG.gitStatusUploads).toBe(false);
    expect(DEFAULT_SITE_CONFIG.tagConnectorWrites).toBe(false);
  });

  it('ships the target\'s per-model threshold table', () => {
    expect(DEFAULT_SITE_CONFIG.severityByModel['claude-sonnet-5[1m]']).toEqual({ t1: 25, t2: 35 });
    expect(DEFAULT_SITE_CONFIG.severityByModel['claude-opus-4-8[1m]']).toEqual({ t1: 45, t2: 35 });
    expect(DEFAULT_SITE_CONFIG.severityByModel['claude-sonnet-5']).toEqual({ t1: 25, t2: 35 });
    expect(DEFAULT_SITE_CONFIG.severityByModel['claude-opus-4-8']).toEqual({ t1: 45, t2: 35 });
  });

  it('carries exactly the four models the target\'s table carries', () => {
    expect(Object.keys(DEFAULT_SITE_CONFIG.severityByModel)).toEqual([
      'claude-sonnet-5[1m]',
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-opus-4-8',
    ]);
  });

  it('is frozen, so a caller cannot change what every other caller reads', () => {
    expect(Object.isFrozen(DEFAULT_SITE_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SITE_CONFIG.severityByModel)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SITE_CONFIG.severityByModel['claude-sonnet-5'])).toBe(true);
  });

  it('ships an empty bundle, as the target does', () => {
    expect(EMPTY_SITE_CONFIG.severityByModel).toEqual({});
    expect(Object.isFrozen(EMPTY_SITE_CONFIG)).toBe(true);
  });
});

describe('the built-in thresholds', () => {
  it('are t1 = 15 and t2 = 20', () => {
    expect(DEFAULT_SEVERITY_THRESHOLDS).toEqual({ t1: 15, t2: 20 });
  });

  it('accept only a number in [0, 100]', () => {
    expect(isSeverityThreshold(0)).toBe(true);
    expect(isSeverityThreshold(100)).toBe(true);
    expect(isSeverityThreshold(-1)).toBe(false);
    expect(isSeverityThreshold(101)).toBe(false);
    expect(isSeverityThreshold(Number.NaN)).toBe(false);
    expect(isSeverityThreshold('25')).toBe(false);
  });
});

describe('the resolution', () => {
  it('prefers the bundle\'s per-model entry', () => {
    const resolved = resolveSeverity(DEFAULT_SITE_CONFIG, 'claude-opus-4-8');
    expect(resolved.value).toEqual({ t1: 45, t2: 35 });
    expect(resolved.source).toBe('bundle');
  });

  it('reads the long-context model id as its own entry', () => {
    const resolved = resolveSeverity(DEFAULT_SITE_CONFIG, 'claude-sonnet-5[1m]');
    expect(resolved.value).toEqual({ t1: 25, t2: 35 });
  });

  it('falls back to the model\'s aliases when the exact id is not in the table', () => {
    const resolved = resolveSeverity(DEFAULT_SITE_CONFIG, 'claude-opus-4-8-20260101', undefined, () => [
      'claude-opus-4-8',
    ]);
    expect(resolved.value).toEqual({ t1: 45, t2: 35 });
    expect(resolved.source).toBe('bundle');
  });

  it('answers nothing for a model that is in neither the table nor the aliases', () => {
    const resolved = resolveSeverity(DEFAULT_SITE_CONFIG, 'some-other-model');
    expect(resolved.value).toBeNull();
    expect(resolved.source).toBe('default');
  });

  it('answers nothing for the empty bundle', () => {
    const resolved = resolveSeverity(EMPTY_SITE_CONFIG, 'claude-opus-4-8');
    expect(resolved.value).toBeNull();
    expect(resolved.source).toBe('default');
  });

  it('prefers the bundle\'s own severity over the per-model entry', () => {
    const bundle = {
      ...DEFAULT_SITE_CONFIG,
      severityBySite: { 'site-a': { 'claude-opus-4-8': { t1: 10, t2: 12 } } },
    };
    const resolved = resolveSeverity(bundle, 'claude-opus-4-8', 'site-a');
    expect(resolved.value).toEqual({ t1: 10, t2: 12 });
    expect(resolved.source).toBe('bundle');
  });

  it('switches the thresholds off when the bundle\'s own severity is "off"', () => {
    const bundle = { ...DEFAULT_SITE_CONFIG, severityBySite: { 'site-a': 'off' } };
    const resolved = resolveSeverity(bundle, 'claude-opus-4-8', 'site-a');
    expect(resolved.value).toBeNull();
    expect(resolved.source).toBe('bundle');
  });

  it('reads the bundle\'s own severity through the model\'s aliases too', () => {
    const bundle = {
      ...DEFAULT_SITE_CONFIG,
      severityBySite: { 'site-a': { 'claude-opus-4-8': { t1: 10, t2: 12 } } },
    };
    const resolved = resolveSeverity(bundle, 'claude-opus-4-8-20260101', 'site-a', () => [
      'claude-opus-4-8',
    ]);
    expect(resolved.value).toEqual({ t1: 10, t2: 12 });
  });

  it('answers nothing when the bundle\'s own severity does not know the model', () => {
    const bundle = {
      ...DEFAULT_SITE_CONFIG,
      severityBySite: { 'site-a': { 'claude-opus-4-8': { t1: 10, t2: 12 } } },
    };
    const resolved = resolveSeverity(bundle, 'some-other-model', 'site-a');
    expect(resolved.value).toBeNull();
    expect(resolved.source).toBe('default');
  });

  it('does not read a site that is not named', () => {
    const bundle = {
      ...DEFAULT_SITE_CONFIG,
      severityBySite: { 'site-a': { 'claude-opus-4-8': { t1: 10, t2: 12 } } },
    };
    const resolved = resolveSeverity(bundle, 'claude-opus-4-8', 'site-b');
    expect(resolved.value).toEqual({ t1: 45, t2: 35 });
  });

  it('does not read an inherited member of the table', () => {
    const table = Object.create({ 'claude-opus-4-8': { t1: 99, t2: 99 } }) as Record<string, unknown>;
    expect(resolveSeverityByModel(table, 'claude-opus-4-8')).toBeUndefined();
  });

  it('exposes the value alone, as the target\'s own wrapper does', () => {
    expect(severityThresholdsFor(DEFAULT_SITE_CONFIG, 'claude-sonnet-5')).toEqual({ t1: 25, t2: 35 });
    expect(severityThresholdsFor(DEFAULT_SITE_CONFIG, 'some-other-model')).toBeNull();
  });
});
