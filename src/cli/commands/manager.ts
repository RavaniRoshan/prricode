/**
 * The manager surfaces' entry point — one call for the CLI and one call for
 * the interactive `/provider` command.
 *
 * **This whole surface is a project extension.** The target has no user-managed
 * registry of provider connections and no catalog browser (audit §2.1,
 * "Important negative finding"). The commands behind this module are the
 * implementation's own, and every one of them says so.
 *
 * ## Where the commands are reached from
 *
 * The **in-session** dispatcher is the **registry**
 * (`src/cli/commands/slash.ts`): `/provider` and `/catalog` are entries of
 * that registry, and the registry's dispatch is what a typed `/provider`
 * line runs. This module holds the two commands' own implementation, and the
 * registry calls it.
 *
 * The two entry points this module keeps — `isManagerCommand` and
 * `runManagerText` — answer the **manager's** narrower question ("is this
 * line one of *my* two commands?"), and the manager's own contract test pins
 * them. The registry's question is wider ("does this line name a command of
 * the registry?"), and it is asked by the registry.
 *
 * ## Why this module exists
 *
 * The provider manager and the catalog browser are two commands over one
 * product surface, and both are reachable in two forms: the **subcommand**
 * form (`provider list`, `catalog list`) and the **non-interactive flag**
 * form (`--provider list`, `--catalog list`). The CLI has to decide which
 * command an argument vector names, and the interactive `/provider` command
 * has to turn its own argument text into an argument vector. Doing that in
 * two places is how the two surfaces drift, so the decision lives here, once.
 *
 * The functions here are a **thin adapter** over
 * {@link providerCommand} and {@link catalogCommand}: they choose a command
 * and hand the arguments to it. They resolve nothing, read nothing and write
 * nothing themselves.
 */

import type { ProviderRegistry } from '../../provider/registry.js';

import {
  catalogCommand,
  catalogStoreOfState,
  type CatalogCommandOptions,
  type CatalogSourceResolver,
  type CatalogStore,
} from './catalog.js';
import {
  providerCommand,
  type ProviderCommandOptions,
  type ProviderProbe,
} from './provider.js';
import {
  readProviderStateFile,
  registryFromState,
  usageError,
  type CommandResult,
} from './shared.js';

/* -------------------------------------------------------------------------- */
/* The options                                                                  */
/* -------------------------------------------------------------------------- */

/** The options both manager commands take. */
export interface ManagerCommandOptions extends ProviderCommandOptions, CatalogCommandOptions {}

/* -------------------------------------------------------------------------- */
/* The dispatch                                                                 */
/* -------------------------------------------------------------------------- */

/** The manager surfaces there are. */
export const MANAGER_COMMANDS = ['provider', 'catalog'] as const;

/** One of the manager surfaces. */
export type ManagerCommand = (typeof MANAGER_COMMANDS)[number];

/**
 * The manager command an argument vector names.
 *
 * The **flag** form wins over the **word** form, because `--catalog list` is
 * unambiguous while a prompt that merely mentions "catalog" is not: the word
 * is only read when it is the **first** token, which is the placement a
 * subcommand may take.
 */
export function managerCommandOf(argv: readonly string[]): ManagerCommand | undefined {
  if (argv.includes('--provider')) return 'provider';
  if (argv.includes('--catalog')) return 'catalog';
  const first = argv[0];
  if (first === 'provider' || first === 'catalog') return first;
  return undefined;
}

/**
 * Run the manager command an argument vector names.
 *
 * With no manager command in the arguments the **provider** command runs and
 * writes its own help, which is the answer a bare `/provider` wants.
 */
export async function providerManagerCommand(
  argv: readonly string[],
  registry: ProviderRegistry,
  options: ManagerCommandOptions = {},
): Promise<CommandResult> {
  const command = managerCommandOf(argv);
  const args = [...argv];
  if (command === 'catalog') return catalogCommand(args, registry, options);
  return providerCommand(args, registry, options);
}

/* -------------------------------------------------------------------------- */
/* The state                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The manager's state, read from a state file.
 *
 * The two records come out of one file: the **connections** (routing
 * identity) and the **catalogs** (model metadata). A file that is not there
 * is an empty manager, not an error.
 */
export interface LoadedManagerState {
  /** The connection registry. */
  registry: ProviderRegistry;
  /** The catalog table. */
  catalogs: CatalogStore;
}

/**
 * Read the manager's state from a state file.
 *
 * This is the call a CLI makes **once** at start-up: the registry it returns
 * is the one the run path resolves its active connection from, and the
 * catalog table is the one the catalog command reads and writes.
 */
export async function loadManagerState(statePath: string): Promise<LoadedManagerState> {
  const state = await readProviderStateFile(statePath);
  if (state === undefined) {
    return { registry: registryFromState({ version: 1, connections: [], catalogs: [] }), catalogs: catalogStoreOfState([]) };
  }
  return { registry: registryFromState(state), catalogs: catalogStoreOfState(state.catalogs) };
}

/* -------------------------------------------------------------------------- */
/* The slash command                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The arguments of a slash command's text.
 *
 * The text is split on whitespace, and a **double-quoted** run is one
 * argument — so `/provider add prod --name "My Provider"` is three arguments
 * and a half, the way a shell would read it.
 *
 * An **unterminated** quote is a usage error rather than a guess: the text is
 * refused instead of being read as something the user did not write.
 */
/**
 * Whether a line of typed text is a manager command.
 *
 * **Project extension.** The target has no provider manager, so it has no
 * `/provider` slash command either. The interactive host asks this before it
 * treats the line as a prompt.
 */
export function isManagerCommand(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return false;
  const body = trimmed.slice(1);
  const first = body.split(/\s/, 1)[0] ?? '';
  return first === 'provider' || first === 'catalog';
}

/**
 * Run the manager command a line of typed text names.
 *
 * The line is a **slash command** — `/provider list`, `/catalog search opus` —
 * and the arguments after the command word are the manager's own. An
 * **unterminated quote** is a usage error rather than a guess: the line is
 * refused instead of being read as something the user did not write.
 *
 * A line that is **not** a manager command is **not** run: the caller sends it
 * to the model instead.
 */
export async function runManagerText(
  text: string,
  registry: ProviderRegistry,
  options: ManagerCommandOptions = {},
): Promise<CommandResult | undefined> {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const word = space === -1 ? body : body.slice(0, space);
  if (word !== 'provider' && word !== 'catalog') return undefined;
  const rest = space === -1 ? '' : body.slice(space + 1);
  const args = managerArgumentsOf(rest);
  if (args === undefined) {
    return usageError('the command has an unterminated quote');
  }
  return providerManagerCommand([word, ...args], registry, options);
}

export function managerArgumentsOf(text: string): string[] | undefined {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (const character of text) {
    if (quoted) {
      if (character === '"') {
        quoted = false;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (quoted) return undefined;
  if (started) args.push(current);
  return args;
}
