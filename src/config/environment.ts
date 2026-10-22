/**
 * The **environment reader**: the one place this implementation reads the
 * target's environment variables.
 *
 * ## Why the reader exists
 *
 * The target reads **1 285** environment variables (`src/config/environmentCatalogue.ts`
 * carries the surface). They are not features: they are **reference surfaces**.
 * A clone that ignores a variable the target honours behaves differently, and a
 * clone that parses one differently behaves differently too.
 *
 * So the reading has **one** implementation, and it reproduces the target's
 * rules:
 *
 *   - a value is **trimmed**, and a value that holds only whitespace counts as
 *     **unset**;
 *   - a **boolean** is read with the target's own token set, and *only* that
 *     token set;
 *   - a **flag** that the target reads by **presence** is read by presence.
 *
 * The last distinction is the one a text sweep cannot see, and it is
 * observable: the target's telemetry gate reads `DISABLE_TELEMETRY` by
 * **presence** and `DO_NOT_TRACK` with the **boolean** parse, so
 * `DO_NOT_TRACK=0` leaves telemetry on and `DISABLE_TELEMETRY=0` turns it off.
 *
 * ## The rules, and where they come from
 *
 * | rule | the target |
 * |---|---|
 * | the truthy tokens are `1`, `true`, `yes`, `on` | `chunk-c5n7mysv.js:717` (`Ne`) |
 * | the falsy tokens are `0`, `false`, `no`, `off` | `chunk-c5n7mysv.js:859` (`ws`) |
 * | the traffic mode: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` by presence, then `DISABLE_TELEMETRY` by presence, then `DO_NOT_TRACK` by the boolean parse | `chunk-kmrt4q1v.js:14089` (`fjt`) |
 * | the name of the variable that turned the traffic mode off | `chunk-kmrt4q1v.js:14412` (`ZBr`) |
 * | the configuration root is `CLAUDE_CONFIG_DIR`, or `~/.claude` | `chunk-…`, `process.env.CLAUDE_CONFIG_DIR\|\|ce()` |
 *
 * Every value is read through an **own-property** check, so a name that
 * collides with an `Object.prototype` member (`constructor`, `toString`, …) is
 * reported as unset rather than resolving to the inherited member.
 */

import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The tokens the target reads as **true**.
 *
 * **Observed** (`chunk-c5n7mysv.js:717`): the target's own boolean reader is
 * `String(e).toLowerCase().trim()` and then a membership test against
 * `["1","true","yes","on"]`. A value outside the set is **false** — the
 * reader does not treat "not false" as "true".
 */
export const TARGET_TRUE_TOKENS: readonly string[] = Object.freeze(['1', 'true', 'yes', 'on']);

/**
 * The tokens the target reads as **false**.
 *
 * **Observed** (`chunk-c5n7mysv.js:859`): the target's inverse reader is a
 * membership test against `["0","false","no","off"]`.
 */
export const TARGET_FALSE_TOKENS: readonly string[] = Object.freeze(['0', 'false', 'no', 'off']);

/**
 * Read a value the way the target reads a boolean flag.
 *
 * **Observed** (`chunk-c5n7mysv.js:717`):
 *
 * ```js
 * function Ne(e){
 *   if(!e)return!1;
 *   if(typeof e==="boolean")return e;
 *   let n=String(e).toLowerCase().trim();
 *   return["1","true","yes","on"].includes(n)
 * }
 * ```
 *
 * So an **unset** value is false, an **empty** value is false, and a value
 * outside the token set is false as well — `2` is false, and `maybe` is
 * false.
 */
export function targetFlag(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const token = value.trim().toLowerCase();
  return TARGET_TRUE_TOKENS.includes(token);
}

/**
 * Whether a value is one of the target's **explicit** false tokens.
 *
 * **Observed** (`chunk-c5n7mysv.js:859`): `["0","false","no","off"]`, compared
 * against the trimmed, lower-cased value.
 */
export function targetExplicitFalse(value: string | undefined): boolean {
  if (value === undefined) return false;
  const token = value.trim().toLowerCase();
  return TARGET_FALSE_TOKENS.includes(token);
}

/**
 * The environment, read.
 *
 * Every member takes a **name** and answers a question about it. The reader
 * holds the environment it was built from, so a caller never has to pass the
 * environment again, and two readers can never disagree about what a value
 * counts as.
 */
export interface Environment {
  /** The environment this reader reads. */
  readonly raw: NodeJS.ProcessEnv;
  /** Whether the variable is set — an own property with a string value. */
  has(name: string): boolean;
  /** The variable's text, trimmed; a value that is only whitespace is unset. */
  text(name: string): string | undefined;
  /**
   * The variable read as the target reads a **boolean flag**.
   *
   * See {@link targetFlag}: the value is false unless it is one of the
   * target's four true tokens.
   */
  flag(name: string): boolean;
  /** Whether the variable is set at all — read by **presence**, as the target does. */
  present(name: string): boolean;
  /** The variable read as an integer, or `undefined` when it is not one. */
  integer(name: string): number | undefined;
  /** The variable read as one of a fixed set of values. */
  choice<T extends string>(name: string, values: readonly T[]): T | undefined;
}

/**
 * Read an environment.
 *
 * The default is the process's own environment; a caller that has its own
 * environment — a test, a host — passes it.
 */
export function readEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const text = (name: string): string | undefined => {
    if (!Object.hasOwn(env, name)) return undefined;
    const value = env[name];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const present = (name: string): boolean => {
    if (!Object.hasOwn(env, name)) return false;
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '';
  };
  return {
    raw: env,
    has: (name) => Object.hasOwn(env, name),
    text,
    flag: (name) => targetFlag(text(name)),
    present,
    integer: (name) => {
      const value = text(name);
      if (value === undefined) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    },
    choice: <T extends string>(name: string, values: readonly T[]): T | undefined => {
      const value = text(name);
      if (value === undefined) return undefined;
      return values.find((candidate) => candidate === value);
    },
  };
}

/**
 * The traffic mode the target's telemetry runs in.
 *
 * **Observed** (`chunk-kmrt4q1v.js:14089`):
 *
 * ```js
 * function fjt(){
 *   if(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)return"essential-traffic";
 *   if(process.env.DISABLE_TELEMETRY)return"no-telemetry";
 *   if(Ne(process.env.DO_NOT_TRACK))return"no-telemetry";
 *   return"default"
 * }
 * ```
 *
 * The first two are read by **presence** and the third with the **boolean**
 * parse, so `DISABLE_TELEMETRY=0` turns telemetry off and `DO_NOT_TRACK=0`
 * leaves it on.
 */
export type TrafficMode = 'default' | 'essential-traffic' | 'no-telemetry';

/** The variable that selects the `essential-traffic` mode. */
export const TRAFFIC_ESSENTIAL_VARIABLE = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';

/** The variable that selects the `no-telemetry` mode. */
export const TRAFFIC_DISABLED_VARIABLE = 'DISABLE_TELEMETRY';

/** The variable that selects the `no-telemetry` mode, by the boolean parse. */
export const TRAFFIC_DO_NOT_TRACK_VARIABLE = 'DO_NOT_TRACK';

/**
 * The traffic mode the environment selects.
 *
 * The mode is the target's own, and the order is the target's own.
 */
export function trafficMode(env: NodeJS.ProcessEnv = process.env): TrafficMode {
  const environment = readEnvironment(env);
  if (environment.present(TRAFFIC_ESSENTIAL_VARIABLE)) return 'essential-traffic';
  if (environment.present(TRAFFIC_DISABLED_VARIABLE)) return 'no-telemetry';
  if (environment.flag(TRAFFIC_DO_NOT_TRACK_VARIABLE)) return 'no-telemetry';
  return 'default';
}

/**
 * The name of the variable that turned the traffic mode off.
 *
 * **Observed** (`chunk-kmrt4q1v.js:14412`): the target names the variable, not
 * just the mode, so a user can be told **which** switch did it.
 */
export function trafficModeReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const environment = readEnvironment(env);
  if (environment.present(TRAFFIC_ESSENTIAL_VARIABLE)) return TRAFFIC_ESSENTIAL_VARIABLE;
  if (environment.present(TRAFFIC_DISABLED_VARIABLE)) return TRAFFIC_DISABLED_VARIABLE;
  if (environment.flag(TRAFFIC_DO_NOT_TRACK_VARIABLE)) return TRAFFIC_DO_NOT_TRACK_VARIABLE;
  return undefined;
}

/**
 * Whether the traffic mode turns the target's telemetry off.
 *
 * **Observed** (`chunk-kmrt4q1v.js:14089`, `hF`): the predicate is
 * `fjt() !== "default"`, so **both** `essential-traffic` and `no-telemetry`
 * turn it off.
 */
export function telemetryIsOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return trafficMode(env) !== 'default';
}

/** The variable that holds the configuration root. */
export const CONFIG_DIRECTORY_VARIABLE = 'CLAUDE_CONFIG_DIR';

/**
 * The configuration root the target keeps its state in.
 *
 * **Observed** (audit §2.6 and the target's own source): the root is
 * `~/.claude`, and `CLAUDE_CONFIG_DIR` moves it. The target reads the variable
 * directly — `process.env.CLAUDE_CONFIG_DIR||ce()` — so a variable that is
 * set to an empty string falls back to the default.
 *
 * The path is **resolved**: a relative `CLAUDE_CONFIG_DIR` is resolved against
 * the process's working directory, because a path that is resolved twice would
 * be two different directories.
 *
 * **Implementation choice.** The target's own handling of a **relative**
 * `CLAUDE_CONFIG_DIR` is not established here. The target carries a message
 * about the variable being "empty or relative" and a configuration directory
 * that "is worked out from each of three folders"
 * (`chunk-8fgrwnc5.js:209487`), which is a rule this implementation does not
 * reproduce; this implementation resolves the path against the working
 * directory instead. The difference is named in
 * `docs/compatibility/reference-catalogues.md`.
 */
export function configurationDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const value = readEnvironment(env).text(CONFIG_DIRECTORY_VARIABLE);
  if (value === undefined) return path.join(homedir(), '.claude');
  return path.resolve(value);
}
