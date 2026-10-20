/**
 * The packaged executable's entry point.
 *
 * The CLI's own entry is `runCommand` in `src/cli/command.ts`. A **compiled**
 * binary needs a file Bun can turn into an executable, and that file does three
 * things the library layer deliberately does not:
 *
 *   - it **reads the command line** and hands the parsed arguments to the
 *     command;
 *   - it **resolves the configuration directory** the run uses;
 *   - it **leaves the process with the command's exit code**.
 *
 * The file is thin on purpose: every behaviour it does not own belongs to
 * `src/`, and this implementation's own rules — the tiered settings, the permission
 * service, the session store — are reached through the command, not around it.
 *
 * ## The install path
 *
 * The installed binary **creates its configuration directory** with
 * **restrictive permissions** (`0o700`) and **reports the directory it will
 * use** on the **first run**. The directory is the one the session store, the
 * settings loader and the multi-provider manager's state file all live under,
 * so it is created **before** the command runs and not by the command: a
 * `--version` that never touches the disk still leaves the installation in a
 * state the next run can use.
 *
 * `CLAUDE_CONFIG_DIR` **relocates** the directory. The variable is the
 * implementation's **own**: the audit records the target's storage root (`~/.claude`)
 * and not a variable that relocates it, so this implementation names its own and says
 * so rather than claiming the target's spelling.
 *
 * ## The fake-provider seam
 *
 * The packaged binary must be able to run `--print` **without a network and
 * without a credential** — that is what the packaging test does, and it is
 * the only way to observe a packaged turn at all. The seam is an environment
 * variable that names a **loopback** endpoint:
 *
 * - `CLAUDE_CODE_FAKE_PROVIDER_URL` — the base URL of a fake provider. The
 *   packaged run sends its request there instead of to the route's own base
 *   URL. **Only a loopback host is accepted**: a value that names any other
 *   host is **refused**, so the seam can never become a way to send a
 *   credential somewhere it does not belong.
 * - The seam **resolves no credential**. The command only ever uses a
 *   credential a caller hands it, and this entry hands it none, so a request
 *   that leaves through the seam carries no `x-api-key` and no `authorization`
 *   header.
 *
 * **Implementation choice.** The target has no such seam, and this one is a packaging
 * convenience rather than a product feature. It is **loopback-only** and it
 * carries no secret, and it is documented in `docs/compatibility/packaging.md`.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseArgs } from '../src/cli/args.js';
import { runCommand } from '../src/cli/command.js';
import { anthropicDriver } from '../src/provider/drivers/anthropic.js';
import { anthropicPathFor, joinUrl } from '../src/provider/drivers/types.js';
import type { ProviderDriver, ProviderRequest } from '../src/provider/drivers/types.js';
import { defaultConfigDir } from '../src/session/store.js';

/* -------------------------------------------------------------------------- */
/* The environment variables the entry honours                                  */
/* -------------------------------------------------------------------------- */

/** The environment variable that **relocates** the configuration directory. */
export const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** The environment variable that names a **loopback fake provider**. */
export const FAKE_PROVIDER_ENV = 'CLAUDE_CODE_FAKE_PROVIDER_URL';

/* -------------------------------------------------------------------------- */
/* The configuration directory                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The mode the configuration directory carries.
 *
 * `0o700`: the owner may read, write and enter it, and **nobody else** may.
 * The configuration directory holds the settings, the session transcripts and
 * the multi-provider manager's state, so a directory another user could read
 * would leak every one of them. The audit records `0o600` for the settings
 * file the directory holds; the directory itself is tighter still, because the
 * directory is what decides who may read the files in it.
 */
export const CONFIG_DIR_MODE = 0o700;

/** The first-run report's prefix. */
export const FIRST_RUN_REPORT = 'First run: the configuration directory';

/**
 * The configuration directory the run uses.
 *
 * `CLAUDE_CONFIG_DIR` **relocates** it; without the variable the run uses the
 * implementation's default — `~/.claude`, the storage root the audit records.
 *
 * **Implementation choice.** The audit records the target's storage root and not the
 * name of the variable that relocates it, so this implementation names its own and says
 * so here rather than claiming the target's spelling.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv): string {
  const relocated = readEnvValue(env, CONFIG_DIR_ENV);
  if (relocated !== undefined) return path.resolve(relocated);
  return defaultConfigDir();
}

/** What the preparation of the configuration directory produced. */
export interface PreparedConfigDir {
  /** The directory the run uses. */
  path: string;
  /** Whether **this** run created it — the first run. */
  created: boolean;
}

/**
 * Prepare the configuration directory.
 *
 * The directory is created with the restrictive mode, and the mode is then set
 * **explicitly**: `mkdir`'s mode is filtered through the process's umask, and
 * a directory that already existed may carry a wider one — and the
 * configuration directory must not be world-readable either way.
 */
export function prepareConfigDir(dir: string): PreparedConfigDir {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  chmodSync(dir, CONFIG_DIR_MODE);
  return { path: dir, created: !existed };
}

/**
 * The first-run report.
 *
 * It names the directory the run will use, so that a user who moved it — or
 * one who never knew where it was — can see it. It goes to the **standard
 * error**, so that it never mixes with the answer a `--print` run writes to
 * the standard output.
 */
export function firstRunReport(dir: string): string {
  return `${FIRST_RUN_REPORT} ${dir} was created (mode 0700).\n`;
}

/* -------------------------------------------------------------------------- */
/* The fake provider                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether a value names a **loopback** endpoint.
 *
 * The seam is loopback-only, so this is the check that keeps it that way: a
 * value that names any other host — including one that resolves to a private
 * address — is refused.
 */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  // The whole of `127.0.0.0/8` is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The driver a fake provider is reached through.
 *
 * It is the **real** first-party driver with one member replaced: the URL it
 * builds. Everything else — the headers, the body, the SSE parser, the error
 * classifier — is the production driver's, so a run against a fake provider
 * exercises the production path and not a test double of it.
 */
export function fakeProviderDriver(baseUrl: string): ProviderDriver {
  return {
    ...anthropicDriver,
    buildUrl(request: ProviderRequest): string {
      const suffix =
        request.operation === 'count_tokens' ? '/v1/messages/count_tokens' : anthropicPathFor(request);
      return joinUrl(baseUrl, suffix);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'an unknown error';
}

/**
 * Run the command line.
 *
 * @returns the exit code the process ends with.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const env = process.env;

  // The **install path** runs first: the configuration directory is created
  // with its restrictive mode, and the first run reports the directory it will
  // use. The command then runs against that directory — the session store,
  // the settings loader and the multi-provider manager's state all live
  // under it.
  const configDir = resolveConfigDir(env);
  let prepared: PreparedConfigDir;
  try {
    prepared = prepareConfigDir(configDir);
  } catch (error) {
    process.stderr.write(
      `Error: the configuration directory '${configDir}' could not be created: ${messageOf(error)}\n`,
    );
    return 1;
  }
  if (prepared.created) process.stderr.write(firstRunReport(prepared.path));

  // The fake provider is resolved **before** the command runs, so that a value
  // the seam refuses is refused before anything is set up.
  const fakeProvider = readEnvValue(env, FAKE_PROVIDER_ENV);
  let driver: ProviderDriver | undefined;
  if (fakeProvider !== undefined) {
    if (!isLoopbackUrl(fakeProvider)) {
      process.stderr.write(
        `Error: the '${FAKE_PROVIDER_ENV}' variable must name a loopback endpoint (127.0.0.1, ::1 or localhost).\n`,
      );
      return 2;
    }
    driver = fakeProviderDriver(fakeProvider);
  }

  const parsed = parseArgs([...argv], { isTTY: process.stdout.isTTY === true });
  return runCommand(parsed, {
    configDir,
    env,
    ...(driver === undefined ? {} : { driver }),
  });
}

/**
 * Read an environment variable.
 *
 * The read is an **own-property** check, so a name that collides with an
 * inherited member of `Object.prototype` is reported as unset rather than
 * resolving to the inherited member. A value that carries only whitespace
 * counts as unset.
 */
function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!Object.hasOwn(env, name)) return undefined;
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* -------------------------------------------------------------------------- */
/* The process                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run the entry and set the process's exit code.
 *
 * The exit code is the command's own: `0` when it finished, `1` when it
 * failed, and `2` when the arguments were wrong.
 */
async function entry(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

await entry();
