/**
 * Contract test: the reference catalogues — the environment-variable surface
 * and the telemetry vocabulary.
 *
 * The two catalogues are **reference surfaces**, not features. The target reads
 * 1 285 environment variables and emits 3 084 `tengu_*` events; a clone that
 * ignores a variable the target honours behaves differently, and a clone that
 * emits a different event name is not observable in the same way.
 *
 * The tests below hold four things true:
 *
 *   1. the catalogues carry **the target's** names, and they agree with the
 *      reverse-engineering record they were generated from;
 *   2. the environment **reader** reproduces the target's parsing rules;
 *   3. the telemetry **emitter** reproduces the target's event model, and
 *      refuses an event the target does not emit;
 *   4. the variables and events that **change behaviour here** are the ones the
 *      target's rules say they are.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_DIRECTORY_VARIABLE,
  TRAFFIC_DO_NOT_TRACK_VARIABLE,
  TRAFFIC_DISABLED_VARIABLE,
  TRAFFIC_ESSENTIAL_VARIABLE,
  configurationDirectory,
  readEnvironment,
  targetExplicitFalse,
  targetFlag,
  telemetryIsOff,
  trafficMode,
  trafficModeReason,
} from '../../src/config/environment.js';
import {
  ENVIRONMENT_VARIABLE_NAMES,
  ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION,
  ENVIRONMENT_VARIABLE_SURFACE,
  isTargetEnvironmentVariable,
} from '../../src/config/environmentCatalogue.js';
import { loadSettings } from '../../src/config/loader.js';
import { documentOf } from '../../src/config/tiers.js';
import { ideLockDirectories } from '../../src/integration/ide/lockfile.js';
import {
  RESTRICT_PERSONAL_CONFIG_ENV,
  isPersonalConfigRestricted,
} from '../../src/permissions/decision.js';
import { selectRoute } from '../../src/provider/routes.js';
import {
  SESSION_CONTINUE_TELEMETRY_EVENT,
  SESSION_RESUME_PRINT_TELEMETRY_EVENT,
  SESSION_RESUMED_TELEMETRY_EVENT,
  resumeSession,
} from '../../src/session/resume.js';
import {
  DISABLE_FILE_CHECKPOINTING_ENV,
  ENABLE_SDK_FILE_CHECKPOINTING_ENV,
  checkpointingEnabled,
} from '../../src/session/checkpoints.js';
import { CARRIED_PROMPT_TELEMETRY_EVENT, createSessionStore, defaultConfigDir } from '../../src/session/store.js';
import {
  DECLARED_TELEMETRY_EVENTS,
  TELEMETRY_QUEUE_CAPACITY,
  TelemetryEmitter,
  UnknownTelemetryEventError,
  assertKnownTelemetryEvent,
  isKnownTelemetryEvent,
  propertiesOf,
  raiseTelemetryEvent,
  stripProtoFields,
} from '../../src/telemetry/emitter.js';
import {
  TELEMETRY_EVENT_NAMES,
  isTargetTelemetryEvent,
} from '../../src/telemetry/vocabulary.js';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INVENTORY = path.join(REPOSITORY, 'docs/reverse-engineering/SURFACE-INVENTORY.md');

/** The roots the tests make, so a run leaves nothing behind. */
const roots: string[] = [];

/** A temporary directory for a test. */
function makeRoot(): string {
  const root = path.join(os.tmpdir(), `prricode-catalogues-${process.pid}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

/** The rows of one section of the reverse-engineering record. */
function sectionRows(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start, `the record has no section "${heading}"`).toBeGreaterThan(-1);
  const rest = markdown.slice(start + heading.length + 3);
  const end = rest.indexOf('\n## ');
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/^\| `([^`]*)` \|$/gm)].map((match) => match[1] ?? '');
}

/* -------------------------------------------------------------------------- */
/* The environment-variable catalogue                                           */
/* -------------------------------------------------------------------------- */

describe('the environment-variable catalogue', () => {
  it('carries the target\'s 1 285 names', () => {
    expect(ENVIRONMENT_VARIABLE_NAMES).toHaveLength(1285);
  });

  it('carries names, not sentences', () => {
    for (const name of ENVIRONMENT_VARIABLE_NAMES) {
      expect(name, `"${name}" is not an environment-variable name`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it('carries no name twice', () => {
    expect(new Set(ENVIRONMENT_VARIABLE_NAMES).size).toBe(ENVIRONMENT_VARIABLE_NAMES.length);
  });

  it('is sorted, so the catalogue reads the same every time', () => {
    const sorted = [...ENVIRONMENT_VARIABLE_NAMES].sort();
    expect([...ENVIRONMENT_VARIABLE_NAMES]).toEqual(sorted);
  });

  it('agrees with the reverse-engineering record it was generated from', () => {
    const markdown = readFileSync(INVENTORY, 'utf8');
    const recorded = sectionRows(markdown, 'The environment-variable surface').sort();
    expect([...ENVIRONMENT_VARIABLE_NAMES]).toEqual(recorded);
  });

  it('answers whether the target reads a name, and never resolves an inherited member', () => {
    expect(isTargetEnvironmentVariable('CLAUDE_CONFIG_DIR')).toBe(true);
    expect(isTargetEnvironmentVariable('CLAUDE_CODE_USE_BEDROCK')).toBe(true);
    expect(isTargetEnvironmentVariable('NOT_A_REAL_VARIABLE_NAME')).toBe(false);
    // A name that collides with an `Object.prototype` member is not in the
    // surface, and the lookup must not resolve it from the prototype chain.
    expect(isTargetEnvironmentVariable('toString')).toBe(false);
    expect(isTargetEnvironmentVariable('constructor')).toBe(false);
    expect(isTargetEnvironmentVariable('hasOwnProperty')).toBe(false);
  });

  it('carries the names the derivation cannot see, with where they were read', () => {
    expect(ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION.map((entry) => entry.name)).toEqual([
      'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND',
      'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE',
    ]);
    for (const entry of ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION) {
      expect(entry.file).toMatch(/^chunk-[A-Za-z0-9]+\.js$/);
      expect(entry.offset).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      // A name the derivation cannot see is **not** in the derived list.
      expect(ENVIRONMENT_VARIABLE_NAMES).not.toContain(entry.name);
    }
  });

  it('surfaces every name it carries', () => {
    expect(ENVIRONMENT_VARIABLE_SURFACE).toHaveLength(1287);
    expect(ENVIRONMENT_VARIABLE_SURFACE).toContain('SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE');
  });
});

/* -------------------------------------------------------------------------- */
/* The environment reader                                                      */
/* -------------------------------------------------------------------------- */

describe('the environment reader', () => {
  it('trims a value and treats a blank one as unset', () => {
    const environment = readEnvironment({ NAME: '  value  ', BLANK: '   ' });
    expect(environment.text('NAME')).toBe('value');
    expect(environment.text('BLANK')).toBeUndefined();
    expect(environment.text('ABSENT')).toBeUndefined();
  });

  it('never resolves a name from the prototype chain', () => {
    const environment = readEnvironment({} as NodeJS.ProcessEnv);
    expect(environment.text('toString')).toBeUndefined();
    expect(environment.text('constructor')).toBeUndefined();
    expect(environment.has('toString')).toBe(false);
  });

  it('reads a boolean with the target\'s own token set', () => {
    // **Observed** (`chunk-c5n7mysv.js:717`): the target accepts `1`, `true`,
    // `yes` and `on` — and nothing else.
    for (const token of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(targetFlag(token), `"${token}" should be true`).toBe(true);
    }
    for (const token of ['0', 'false', 'no', 'off', '2', 'maybe', '', 'TRUEISH']) {
      expect(targetFlag(token), `"${token}" should be false`).toBe(false);
    }
    expect(targetFlag(undefined)).toBe(false);
  });

  it('reads the target\'s explicit false tokens', () => {
    expect(targetExplicitFalse('0')).toBe(true);
    expect(targetExplicitFalse('false')).toBe(true);
    expect(targetExplicitFalse('no')).toBe(true);
    expect(targetExplicitFalse('off')).toBe(true);
    expect(targetExplicitFalse('2')).toBe(false);
    expect(targetExplicitFalse(undefined)).toBe(false);
  });

  it('reads the traffic mode the way the target does', () => {
    // **Observed** (`chunk-kmrt4q1v.js:14089`): the first two variables are
    // read by **presence** and the third with the **boolean** parse.
    expect(trafficMode({})).toBe('default');
    expect(trafficMode({ [TRAFFIC_DISABLED_VARIABLE]: '1' })).toBe('no-telemetry');
    expect(trafficMode({ [TRAFFIC_DISABLED_VARIABLE]: '0' })).toBe('no-telemetry');
    expect(trafficMode({ [TRAFFIC_DO_NOT_TRACK_VARIABLE]: '1' })).toBe('no-telemetry');
    expect(trafficMode({ [TRAFFIC_DO_NOT_TRACK_VARIABLE]: '0' })).toBe('default');
    expect(trafficMode({ [TRAFFIC_ESSENTIAL_VARIABLE]: '1' })).toBe('essential-traffic');
    // The order is the target's own.
    expect(
      trafficMode({ [TRAFFIC_ESSENTIAL_VARIABLE]: '1', [TRAFFIC_DISABLED_VARIABLE]: '1' }),
    ).toBe('essential-traffic');
  });

  it('names the variable that turned the traffic mode off', () => {
    expect(trafficModeReason({ [TRAFFIC_DISABLED_VARIABLE]: '1' })).toBe(TRAFFIC_DISABLED_VARIABLE);
    expect(trafficModeReason({ [TRAFFIC_DO_NOT_TRACK_VARIABLE]: 'yes' })).toBe(
      TRAFFIC_DO_NOT_TRACK_VARIABLE,
    );
    expect(trafficModeReason({})).toBeUndefined();
  });

  it('turns the telemetry off in every mode but the default', () => {
    expect(telemetryIsOff({})).toBe(false);
    expect(telemetryIsOff({ [TRAFFIC_DISABLED_VARIABLE]: '1' })).toBe(true);
    expect(telemetryIsOff({ [TRAFFIC_ESSENTIAL_VARIABLE]: '1' })).toBe(true);
  });

  it('reads the configuration root from the target\'s variable', () => {
    expect(configurationDirectory({ [CONFIG_DIRECTORY_VARIABLE]: '/tmp/config' })).toBe(
      '/tmp/config',
    );
    // An empty variable falls back to the default, the way the target's
    // `process.env.CLAUDE_CONFIG_DIR||ce()` does.
    expect(configurationDirectory({ [CONFIG_DIRECTORY_VARIABLE]: '  ' })).toBe(
      configurationDirectory({}),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The telemetry vocabulary                                                    */
/* -------------------------------------------------------------------------- */

describe('the telemetry vocabulary', () => {
  it('carries the target\'s 3 084 distinct event names', () => {
    expect(TELEMETRY_EVENT_NAMES).toHaveLength(3084);
  });

  it('carries event names, and nothing else', () => {
    for (const name of TELEMETRY_EVENT_NAMES) {
      expect(name, `"${name}" is not an event name`).toMatch(/^tengu_[A-Za-z0-9_]+$/);
    }
  });

  it('carries no name twice', () => {
    expect(new Set(TELEMETRY_EVENT_NAMES).size).toBe(TELEMETRY_EVENT_NAMES.length);
  });

  it('agrees with the reverse-engineering record it was generated from', () => {
    const markdown = readFileSync(INVENTORY, 'utf8');
    const placements = sectionRows(markdown, 'The telemetry vocabulary');
    const names = new Set<string>();
    for (const placement of placements) {
      const quoted = /"(tengu_[A-Za-z0-9_]+)"?$/.exec(placement);
      if (quoted !== null) {
        names.add(quoted[1] ?? '');
        continue;
      }
      const afterColon = /:(tengu_[A-Za-z0-9_]+)$/.exec(placement);
      expect(afterColon, `a telemetry row is not a placement: ${placement}`).not.toBeNull();
      names.add(afterColon?.[1] ?? '');
    }
    // The record lists **(file, name) pairs** and the vocabulary holds the
    // **distinct names**: the pairs are more, because an event the target
    // ships in two chunks is listed twice.
    expect(placements.length).toBe(3554);
    expect(names.size).toBe(3084);
    expect([...TELEMETRY_EVENT_NAMES].sort()).toEqual([...names].sort());
  });

  it('answers whether the target emits an event', () => {
    expect(isTargetTelemetryEvent('tengu_session_resumed')).toBe(true);
    expect(isTargetTelemetryEvent('tengu_continue')).toBe(true);
    expect(isTargetTelemetryEvent('tengu_not_an_event')).toBe(false);
    expect(isTargetTelemetryEvent('toString')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The telemetry emitter                                                       */
/* -------------------------------------------------------------------------- */

describe('the telemetry emitter', () => {
  it('delivers an event as a name and a metadata object', () => {
    const events: { name: string; properties: Record<string, unknown> }[] = [];
    const emitter = new TelemetryEmitter({});
    emitter.attachSink({
      logEvent: (name, properties) => {
        events.push({ name, properties });
      },
    });
    emitter.logEvent('tengu_session_resumed', { success: true, entrypoint: 'print' });
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('tengu_session_resumed');
    expect(events[0]?.properties).toEqual({ success: true, entrypoint: 'print' });
  });

  it('queues an event raised before a sink arrives, and replays it', async () => {
    const events: string[] = [];
    const emitter = new TelemetryEmitter({});
    emitter.logEvent('tengu_continue', { success: true });
    expect(emitter.queuedEventCount).toBe(1);
    emitter.attachSink({
      logEvent: (name) => {
        events.push(name);
      },
    });
    // The replay is a **microtask**, the target's own scheduling.
    await Promise.resolve();
    expect(events).toEqual(['tengu_continue']);
    expect(emitter.queuedEventCount).toBe(0);
  });

  it('keeps one sink, and says so', () => {
    const emitter = new TelemetryEmitter({});
    expect(emitter.attachSink({ logEvent: () => undefined })).toBe(true);
    expect(emitter.attachSink({ logEvent: () => undefined })).toBe(false);
  });

  it('drops its oldest event when the queue is full, and counts the drop', () => {
    const emitter = new TelemetryEmitter({});
    for (let index = 0; index < TELEMETRY_QUEUE_CAPACITY; index += 1) {
      emitter.logEvent('tengu_continue', { index });
    }
    expect(emitter.queuedEventCount).toBe(TELEMETRY_QUEUE_CAPACITY);
    expect(emitter.droppedEventCount).toBe(0);
    emitter.logEvent('tengu_continue', { index: -1 });
    expect(emitter.queuedEventCount).toBe(TELEMETRY_QUEUE_CAPACITY);
    expect(emitter.droppedEventCount).toBe(1);
  });

  it('strips the _PROTO_ keys from an event\'s metadata', () => {
    expect(stripProtoFields({ a: 1, _PROTO_x: 2 })).toEqual({ a: 1 });
    expect(stripProtoFields({ a: 1 })).toEqual({ a: 1 });
  });

  it('refuses an event the target does not emit', () => {
    const emitter = new TelemetryEmitter({});
    expect(() => emitter.logEvent('tengu_not_an_event', {})).toThrow(UnknownTelemetryEventError);
    expect(() => assertKnownTelemetryEvent('session_resumed')).toThrow(UnknownTelemetryEventError);
    expect(isKnownTelemetryEvent('tengu_session_resumed')).toBe(true);
  });

  it('declares the names outside the vocabulary, and labels them', () => {
    expect(DECLARED_TELEMETRY_EVENTS.length).toBeGreaterThan(0);
    for (const declared of DECLARED_TELEMETRY_EVENTS) {
      expect(declared.kind === 'target-timing' || declared.kind === 'project-extension').toBe(true);
      expect(declared.reason.length).toBeGreaterThan(0);
      // A declared name is one the `tengu_*` vocabulary does not hold.
      expect(isTargetTelemetryEvent(declared.name)).toBe(false);
      expect(isKnownTelemetryEvent(declared.name)).toBe(true);
    }
  });

  it('suppresses the events when the traffic mode is off', () => {
    const events: string[] = [];
    const emitter = new TelemetryEmitter({ [TRAFFIC_DISABLED_VARIABLE]: '1' });
    emitter.attachSink({
      logEvent: (name) => {
        events.push(name);
      },
    });
    emitter.logEvent('tengu_continue', {});
    expect(events).toEqual([]);
    expect(emitter.suppressedEventCount).toBe(1);
    expect(emitter.mode).toBe('no-telemetry');
    expect(emitter.modeReason).toBe(TRAFFIC_DISABLED_VARIABLE);
  });

  it('raises an event through the implementation\'s own seam', () => {
    const events: { name: string; success?: boolean }[] = [];
    raiseTelemetryEvent({ name: 'tengu_continue', success: true }, (event: { name: string; success?: boolean }) => {
      events.push(event);
    });
    expect(events).toEqual([{ name: 'tengu_continue', success: true }]);
    expect(() => raiseTelemetryEvent({ name: 'nope' }, undefined)).toThrow(
      UnknownTelemetryEventError,
    );
  });

  it('splits a flat record into the target\'s pair', () => {
    expect(propertiesOf({ name: 'tengu_continue', success: true, resume_duration_ms: 3 })).toEqual({
      success: true,
      resume_duration_ms: 3,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The variables that change behaviour here                                     */
/* -------------------------------------------------------------------------- */

describe('the variables that change behaviour here', () => {
  it('reads the route flags with the target\'s boolean parse', () => {
    // **Observed** (`chunk-c5n7mysv.js:717`): the target reads
    // `Ne(process.env.CLAUDE_CODE_USE_BEDROCK)`, and `Ne` accepts `1`,
    // `true`, `yes` and `on` — and nothing else.
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('bedrock');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: 'yes' })).toBe('bedrock');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: 'on' })).toBe('bedrock');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBe('firstParty');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: 'false' })).toBe('firstParty');
    // A value outside the target's token set leaves the route **off**: the
    // target does not read "not false" as "true".
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: '2' })).toBe('firstParty');
    expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: 'maybe' })).toBe('firstParty');
  });

  it('reads the configuration root of the settings loader from the environment', () => {
    const root = makeRoot();
    const configDir = path.join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'a-model' }), 'utf8');

    // The caller does not supply a configuration root, and the environment
    // names one: the loader reads it, the way the target does.
    const loaded = loadSettings({
      cwd: root,
      env: { [CONFIG_DIRECTORY_VARIABLE]: configDir },
      restricted: false,
    });
    const user = loaded.tiers.get('userSettings');
    expect(user).toBeDefined();
    expect(documentOf(user)).toMatchObject({ model: 'a-model' });
  });

  it('reads the configuration root of the session store from the environment', () => {
    expect(defaultConfigDir({ [CONFIG_DIRECTORY_VARIABLE]: '/tmp/a-config' })).toBe(
      '/tmp/a-config',
    );
    expect(defaultConfigDir({})).toBe(defaultConfigDir({}));
  });

  it('reads every boolean switch with the target\'s boolean rule', () => {
    // The target reads these through its environment namespace, whose boolean
    // schema accepts `1`, `true`, `yes` and `on` — and nothing else. A value
    // outside that set is **false**.
    expect(isPersonalConfigRestricted({ [RESTRICT_PERSONAL_CONFIG_ENV]: '1' })).toBe(true);
    expect(isPersonalConfigRestricted({ [RESTRICT_PERSONAL_CONFIG_ENV]: 'yes' })).toBe(true);
    expect(isPersonalConfigRestricted({ [RESTRICT_PERSONAL_CONFIG_ENV]: '0' })).toBe(false);
    expect(isPersonalConfigRestricted({ [RESTRICT_PERSONAL_CONFIG_ENV]: '2' })).toBe(false);
    expect(isPersonalConfigRestricted({})).toBe(false);

    expect(checkpointingEnabled({ env: { [DISABLE_FILE_CHECKPOINTING_ENV]: '1' } })).toBe(false);
    expect(checkpointingEnabled({ env: { [DISABLE_FILE_CHECKPOINTING_ENV]: '0' } })).toBe(true);
    expect(
      checkpointingEnabled({ mode: 'host', env: { [ENABLE_SDK_FILE_CHECKPOINTING_ENV]: '1' } }),
    ).toBe(true);
    expect(
      checkpointingEnabled({ mode: 'host', env: { [ENABLE_SDK_FILE_CHECKPOINTING_ENV]: '0' } }),
    ).toBe(false);
  });

  it('reads the configuration root of the IDE lock directories as a trimmed string', () => {
    // **Observed** (`chunk-8fgrwnc5.js`): the target reads the variable
    // through its environment namespace, whose string schema trims it and
    // reports an empty value as unset — so an **empty** variable does not add
    // the home directory's lock directory.
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
        configRoot: '/opt/config',
        homeDir: '/home/u',
        platform: 'linux',
        env: { CLAUDE_CONFIG_DIR: '  ' },
      }),
    ).toEqual(['/opt/config/ide']);
  });
});

/* -------------------------------------------------------------------------- */
/* The events this implementation raises                                        */
/* -------------------------------------------------------------------------- */

describe('the events this implementation raises', () => {
  it('raises the print-mode marker with the target\'s empty payload', async () => {
    // **Observed** (`chunk-e7w77ts3.js:736480`): the target's
    // `tengu_resume_print` payload is `{}` — the event's identity is its
    // name, and the payload says nothing else.
    const root = makeRoot();
    const store = createSessionStore({ configDir: path.join(root, 'config') });
    const prints: { name: string }[] = [];
    const result = await resumeSession({
      store,
      cwd: root,
      entrypoint: 'print',
      target: 'a-session-that-does-not-exist',
      onPrintTelemetry: (event) => {
        prints.push({ ...event });
      },
    });
    expect(result.status).toBe('failed');
    expect(prints).toHaveLength(1);
    expect(prints[0]?.name).toBe('tengu_resume_print');
    expect(Object.keys(prints[0] ?? {})).toEqual(['name']);
  });

  it('raises only names the target emits', () => {
    // The names the implementation raises are typed as the target's own
    // event names, so the **compiler** holds this true; the runtime check
    // below is the second half of the same rule.
    for (const name of [
      SESSION_RESUMED_TELEMETRY_EVENT,
      SESSION_RESUME_PRINT_TELEMETRY_EVENT,
      SESSION_CONTINUE_TELEMETRY_EVENT,
      CARRIED_PROMPT_TELEMETRY_EVENT,
    ]) {
      expect(isTargetTelemetryEvent(name), `${name} is not the target's event`).toBe(true);
    }
  });
});
