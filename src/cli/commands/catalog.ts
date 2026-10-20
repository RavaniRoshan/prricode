/**
 * The catalog browser — `catalog`, and its non-interactive `--catalog …` form.
 *
 * **This whole surface is a project extension.** The target's model catalog is
 * built in and provider-owned (audit §2.1, "Model catalog"): this implementation
 * reproduces the target's table and adds the ability to *import* one from a
 * file or a URL. The browsing surface — the grouping, the search, the
 * per-route availability, the refresh — is this implementation's own, and every command
 * **says so**.
 *
 * ## The catalog and the connection table are two records
 *
 * This is the load-bearing rule of the module. A **connection** carries routing
 * identity: an id, a name, a route, a base URL and a credential **reference**.
 * A **catalog** carries model metadata: the rows, their families, their
 * per-route provider ids. They are stored **separately**, so:
 *
 *   - a refresh may rewrite the catalog's own metadata — including a model's
 *     provider ids — and can never reach the connection's id, name, route or
 *     credential reference;
 *   - a **user override** of a catalog-owned field lives in its own record and
 *     survives a refresh, because the refresh rewrites the catalog and not the
 *     overrides.
 *
 * The store below is the second record. It is keyed by connection id, and a
 * refresh writes only the `catalog` member of a record.
 *
 * ## The catalog never touches a credential
 *
 * The catalog is a table of model metadata. Reading it, searching it and
 * refreshing it resolve **no** secret and consult **no** environment variable
 * that holds one: a model catalog has no business knowing a credential. The
 * only credential the module ever names is a **reference** — an environment
 * variable name, a file path, or an OS credential-store key — and only in the
 * JSON document, as the connection's own reference.
 *
 * ## The persistence
 *
 * A verb that changes the state — `refresh` and `override` — writes the
 * catalog table to the **state file** when one is configured, so that the
 * effect survives the process. Without a state file the caller owns the store
 * and the effect lasts as long as the caller holds it; the command says which
 * of the two it is, and never claims a durability it does not have.
 */

import { readFile } from 'node:fs/promises';

import {
  builtinCatalogFor,
  importCatalog,
  providerIdFor,
  type CatalogModel,
  type ModelCatalog,
} from '../../provider/catalog.js';
import { ROUTE_NAMES, isProviderRoute, type ProviderRoute } from '../../provider/routes.js';
import type { Connection, ProviderRegistry } from '../../provider/registry.js';
import { EXIT_FAILURE, EXIT_SUCCESS } from '../output.js';

import {
  PROVIDER_EXTENSION_LABEL,
  PROVIDER_EXTENSION_NOTICE,
  errorMessageOf,
  failure,
  flagValue,
  flagValues,
  padToWidth,
  parseInvocation,
  readProviderStateFile,
  updateProviderStateFile,
  usageError,
  type CatalogStateEntry,
  type CommandInvocation,
  type CommandResult,
} from './shared.js';

/* -------------------------------------------------------------------------- */
/* The overrides                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The user's overrides of **catalog-owned** fields.
 *
 * A catalog row's `displayName` and `providerIds` belong to the catalog: a
 * refresh rewrites them. The overrides are the user's, and they live in their
 * own record so that a refresh cannot take them away.
 *
 * The maps are `Map`s rather than plain objects because their keys are
 * **caller-supplied** — a model id and a route name — and a `Map` lookup can
 * never resolve an inherited member of `Object.prototype`.
 */
export interface CatalogOverrides {
  /** The display name the user chose, per model id. */
  displayNames: Map<string, string>;
  /** The provider ids the user chose, per model id and route. */
  providerIds: Map<string, Map<ProviderRoute, string>>;
}

/** An empty set of overrides. */
export function createCatalogOverrides(): CatalogOverrides {
  return { displayNames: new Map(), providerIds: new Map() };
}

/**
 * Apply the user's overrides to a catalog row.
 *
 * The row is copied before it is changed, so the catalog itself is never
 * mutated. An override of a field the catalog does not have adds it.
 */
export function applyCatalogOverrides(model: CatalogModel, overrides: CatalogOverrides): CatalogModel {
  const displayName = overrides.displayNames.get(model.id);
  const providerIds = overrides.providerIds.get(model.id);
  if (displayName === undefined && providerIds === undefined) return model;

  // The provider-id map is a **null-prototype** object: its keys are route
  // names, and a null prototype makes it impossible for one of them to reach
  // an inherited member of `Object.prototype`.
  const ids: Partial<Record<ProviderRoute, string>> = Object.create(null) as Partial<
    Record<ProviderRoute, string>
  >;
  Object.assign(ids, model.providerIds);

  const copy: CatalogModel = { ...model, providerIds: ids };
  if (displayName !== undefined) copy.displayName = displayName;
  if (providerIds !== undefined) {
    for (const [route, id] of providerIds) copy.providerIds[route] = id;
  }
  return copy;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One connection's catalog record.
 *
 * The two members are the two records of the module's central rule: the
 * `catalog` is rewritten by a refresh, the `overrides` are not.
 */
export interface CatalogRecord {
  /** The catalog's own rows. */
  catalog: ModelCatalog;
  /** The user's overrides of catalog-owned fields. */
  overrides: CatalogOverrides;
}

/**
 * The catalog table.
 *
 * It is a **separate record** from the connection table: the store holds
 * catalogs, the registry holds connections, and neither writes to the other.
 */
export interface CatalogStore {
  /** The record of a connection, when it has one. */
  get(connectionId: string): CatalogRecord | undefined;
  /** Write a connection's record. */
  set(connectionId: string, record: CatalogRecord): void;
  /** Drop a connection's record. */
  delete(connectionId: string): boolean;
  /** The ids of the connections that have a record. */
  ids(): readonly string[];
}

/**
 * A catalog store.
 *
 * The records are held in a `Map`, so a connection id that collides with an
 * `Object.prototype` member (`constructor`, `__proto__`, …) is a plain key and
 * not an inherited member.
 */
export function createCatalogStore(
  records: Iterable<readonly [string, CatalogRecord]> = [],
): CatalogStore {
  const table = new Map<string, CatalogRecord>();
  for (const [id, record] of records) table.set(id, record);
  return {
    get(connectionId: string): CatalogRecord | undefined {
      return table.get(connectionId);
    },
    set(connectionId: string, record: CatalogRecord): void {
      table.set(connectionId, record);
    },
    delete(connectionId: string): boolean {
      return table.delete(connectionId);
    },
    ids(): readonly string[] {
      return [...table.keys()];
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The sources                                                                  */
/* -------------------------------------------------------------------------- */

/** Where a connection's catalog is read from. */
export type CatalogSourceLocation =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string };

/**
 * The resolver that says where a connection's catalog lives.
 *
 * The connection record names the **kind** of source (`builtin`, `file` or
 * `url`); the resolver names the **place**. Keeping the place out of the
 * connection record is deliberate: the connection's identity is routing
 * identity, and a catalog's location is not routing identity.
 */
export type CatalogSourceResolver = (connection: Connection) => CatalogSourceLocation | undefined;

/* -------------------------------------------------------------------------- */
/* The options                                                                  */
/* -------------------------------------------------------------------------- */

/** The options the catalog command runs with. */
export interface CatalogCommandOptions {
  /** The environment. Defaults to the process's. */
  env?: NodeJS.ProcessEnv;
  /**
   * The catalog table.
   *
   * The caller owns it: a caller that wants a refresh to be visible to a
   * later listing passes the **same** store to both. When it is absent and a
   * state file is configured, the table is read from that file.
   */
  catalogs?: CatalogStore;
  /** Where a connection's catalog is read from. */
  sources?: CatalogSourceResolver;
  /** The fetcher a URL catalog is read with. */
  fetch?: (url: string) => Promise<{ json(): Promise<unknown> }>;
  /**
   * Where the manager's state is kept.
   *
   * When it is set, a verb that changes the catalog table writes it back, so
   * that a **later invocation** sees the change — a refresh is durable, and a
   * user's override survives it.
   */
  statePath?: string;
}

/* -------------------------------------------------------------------------- */
/* The verbs                                                                    */
/* -------------------------------------------------------------------------- */

/** The verbs the catalog command knows. */
export const CATALOG_VERBS = ['list', 'search', 'show', 'refresh', 'override'] as const;

/** One of the catalog command's verbs. */
export type CatalogVerb = (typeof CATALOG_VERBS)[number];

/** Whether a string is one of the catalog command's verbs. */
function isCatalogVerb(value: string): value is CatalogVerb {
  return (CATALOG_VERBS as readonly string[]).includes(value);
}

/**
 * The flags the catalog command knows.
 *
 * `--catalog-file` and `--catalog-url` name the place a one-off refresh reads
 * from; they do not change the connection record.
 */
const CATALOG_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--format',
  '--connection',
  '--family',
  '--display-name',
  '--provider-id',
  '--catalog-file',
  '--catalog-url',
]);

/** The flags the catalog command knows that take no value. */
const CATALOG_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['--json', '--help']);

/**
 * The catalog command's help.
 *
 * The label is in the first line, because the help is where a reader decides
 * whether the command is part of the target or part of this implementation.
 */
export const CATALOG_COMMAND_HELP = `Usage: catalog <verb> [options]  (also: --catalog <verb> [options])

The model catalog browser is a project extension, not part of the reference agent. The
target's own catalog is built in and provider-owned; this browser groups it by
family, searches it, and refreshes it from a file or a URL.

Verbs:
  list                     print the catalog, grouped by family, with the
                           per-route model ids
  search <query>           print the models whose id or display name match
  show <model>             print one model
  refresh [connection]     re-read a connection's catalog; the connection's id,
                           name, route and credential reference are never
                           touched, and the user's overrides survive
  override <model>         override a catalog-owned field for a connection:
                           --display-name <name>, --provider-id <route>=<id>

Options:
  --connection <id>        the connection the operation applies to
  --family <family>        the family the operation applies to
  --display-name <name>    the display name the user chooses (override)
  --provider-id <route=id> the provider id the user chooses (override)
  --catalog-file <path>    read the catalog from a file (refresh)
  --catalog-url <url>      read the catalog from a URL (refresh)
  --json                   write the machine-readable document
  --format <text|json>     the output format (json in the --catalog form)
  --help                   write this help and stop
`;

/* -------------------------------------------------------------------------- */
/* The command                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run the catalog browser.
 *
 * @param args The command's arguments — the subcommand form (`list`) or the
 *   non-interactive flag form (`--catalog list`).
 * @param registry The connection registry. The catalog reads the connection's
 *   **route**; it never reads a credential.
 * @param options The catalog store, the source resolver and the environment.
 */
export async function catalogCommand(
  args: string[],
  registry: ProviderRegistry,
  options: CatalogCommandOptions = {},
): Promise<CommandResult> {
  const parsed = parseInvocation(args, {
    commandFlag: '--catalog',
    commandWord: 'catalog',
    valueFlags: CATALOG_VALUE_FLAGS,
    booleanFlags: CATALOG_BOOLEAN_FLAGS,
  });
  if (!parsed.ok) return usageError(parsed.message);
  const invocation = parsed.invocation;

  if (invocation.help || invocation.verb === undefined || invocation.verb === 'help') {
    return { exitCode: EXIT_SUCCESS, stdout: CATALOG_COMMAND_HELP, stderr: '' };
  }

  const verb = invocation.verb;
  if (!isCatalogVerb(verb)) {
    return usageError(
      `Error: unknown catalog command "${verb}". The commands are: ${CATALOG_VERBS.join(', ')}.`,
    );
  }

  let store = options.catalogs;
  if (store === undefined && options.statePath !== undefined) {
    try {
      store = await catalogStoreFromStateFile(options.statePath);
    } catch (error) {
      return failure(errorMessageOf(error));
    }
  }
  const catalogs = store ?? createCatalogStore();

  switch (verb) {
    case 'list':
      return listCommand(registry, catalogs, invocation, options, undefined);
    case 'search': {
      const query = queryOf(invocation);
      if (query === undefined || query.trim() === '') {
        return usageError('Error: the catalog command "search" needs a query.');
      }
      return listCommand(registry, catalogs, invocation, options, query);
    }
    case 'show':
      return showCommand(registry, catalogs, invocation, options);
    case 'refresh':
      return refreshCommand(registry, catalogs, invocation, options);
    case 'override':
      return overrideCommand(registry, catalogs, invocation, options);
    default: {
      const unknown: never = verb;
      throw new Error(`unknown catalog verb: ${JSON.stringify(unknown)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The verbs                                                                    */
/* -------------------------------------------------------------------------- */

/** `list` and `search` — the catalog, grouped by family. */
async function listCommand(
  registry: ProviderRegistry,
  store: CatalogStore,
  invocation: CommandInvocation,
  options: CatalogCommandOptions,
  query: string | undefined,
): Promise<CommandResult> {
  const connection = await resolveConnection(registry, invocation);
  if ('error' in connection) return failure(connection.error);

  let record: CatalogRecord;
  try {
    record = await catalogRecordFor(connection.value, store, options);
  } catch (error) {
    return failure(errorMessageOf(error));
  }

  const family = flagValue(invocation, '--family');
  const models = effectiveModels(record, query, family);
  const families = groupByFamily(models);

  const data = {
    type: 'catalog.models',
    extension: PROVIDER_EXTENSION_NOTICE,
    connection: { id: connection.value.id, route: connection.value.route },
    ...(query === undefined ? {} : { query }),
    families: families.map((entry) => ({
      family: entry.family,
      models: entry.models.map((model) => modelDocument(model, connection.value.route)),
    })),
  };

  if (invocation.format === 'json') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `${JSON.stringify(data, null, 2)}\n`,
      stderr: '',
      data,
    };
  }

  const lines: string[] = [];
  lines.push(
    `Model catalog for the provider connection "${connection.value.id}" (route ${connection.value.route})`,
  );
  lines.push(`(${PROVIDER_EXTENSION_LABEL})`);
  lines.push('');
  if (families.length === 0) {
    lines.push('No models matched.');
  }
  for (const entry of families) {
    lines.push(`family ${entry.family}`);
    for (const model of entry.models) {
      lines.push(`  ${model.id}  ${model.displayName}`);
      for (const route of ROUTE_NAMES) {
        const id = providerIdFor(model, route);
        const marker = route === connection.value.route ? ' *' : '';
        lines.push(`${padToWidth(`    ${route}${marker}`, 26)} ${id ?? 'unavailable'}`);
      }
    }
    lines.push('');
  }
  lines.push('* the connection route. A model a route does not serve is unavailable for it.');
  lines.push(PROVIDER_EXTENSION_NOTICE);

  return { exitCode: EXIT_SUCCESS, stdout: `${lines.join('\n')}\n`, stderr: '', data };
}

/** `show` — one model. */
async function showCommand(
  registry: ProviderRegistry,
  store: CatalogStore,
  invocation: CommandInvocation,
  options: CatalogCommandOptions,
): Promise<CommandResult> {
  const modelId = invocation.operands[0];
  if (modelId === undefined || modelId.trim() === '') {
    return usageError('Error: the catalog command "show" needs a model id.');
  }

  const connection = await resolveConnection(registry, invocation);
  if ('error' in connection) return failure(connection.error);

  let record: CatalogRecord;
  try {
    record = await catalogRecordFor(connection.value, store, options);
  } catch (error) {
    return failure(errorMessageOf(error));
  }

  const models = effectiveModels(record, undefined, flagValue(invocation, '--family'));
  const model = models.find((entry) => entry.id === modelId);
  if (model === undefined) {
    return failure(`the catalog of connection "${connection.value.id}" has no model "${modelId}"`);
  }

  const data = {
    type: 'catalog.model',
    extension: PROVIDER_EXTENSION_NOTICE,
    connection: { id: connection.value.id, route: connection.value.route },
    model: modelDocument(model, connection.value.route),
  };

  if (invocation.format === 'json') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `${JSON.stringify(data, null, 2)}\n`,
      stderr: '',
      data,
    };
  }

  const lines: string[] = [];
  lines.push(`${model.id}  ${model.displayName}`);
  lines.push(`  family ${model.family}`);
  for (const route of ROUTE_NAMES) {
    const id = providerIdFor(model, route);
    const marker = route === connection.value.route ? ' *' : '';
    lines.push(`${padToWidth(`  ${route}${marker}`, 24)} ${id ?? 'unavailable'}`);
  }
  if (model.capabilities.length > 0) {
    lines.push(`  capabilities  ${model.capabilities.join(', ')}`);
  }
  lines.push('');
  lines.push(`(${PROVIDER_EXTENSION_LABEL})`);

  return { exitCode: EXIT_SUCCESS, stdout: `${lines.join('\n')}\n`, stderr: '', data };
}

/**
 * `refresh` — re-read a connection's catalog.
 *
 * The refresh writes the **catalog record** and nothing else. The connection
 * record is not read for anything but its id, route and catalog source, and it
 * is never written: the connection's id, name, route and credential reference
 * are the same before and after. The user's overrides live in their own
 * member of the record and are carried over unchanged.
 */
async function refreshCommand(
  registry: ProviderRegistry,
  store: CatalogStore,
  invocation: CommandInvocation,
  options: CatalogCommandOptions,
): Promise<CommandResult> {
  const named = invocation.operands[0];
  const connection = await resolveConnection(registry, invocation, named);
  if ('error' in connection) return failure(connection.error);

  const existing = store.get(connection.value.id);

  let catalog: ModelCatalog;
  try {
    catalog = await readCatalogFor(connection.value, options, invocation);
  } catch (error) {
    return failure(errorMessageOf(error));
  }

  // **The refresh writes the catalog record.** The overrides are carried over
  // from the record that was there, so a user's override of a catalog-owned
  // field survives.
  const record: CatalogRecord = {
    catalog,
    overrides: existing?.overrides ?? createCatalogOverrides(),
  };
  store.set(connection.value.id, record);

  const persisted = await persistCatalogs(store, options);
  if (persisted !== undefined) return persisted;

  const data = {
    type: 'catalog.refreshed',
    extension: PROVIDER_EXTENSION_NOTICE,
    connection: { id: connection.value.id, route: connection.value.route },
    models: catalog.models.length,
  };

  if (invocation.format === 'json') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `${JSON.stringify(data, null, 2)}\n`,
      stderr: '',
      data,
    };
  }

  const lines = [
    `Refreshed the catalog of the provider connection "${connection.value.id}": ${catalog.models.length} models.`,
    'The connection itself was not touched.',
    options.statePath === undefined
      ? 'The refresh rewrote the catalog table, and the overrides survive it.'
      : 'The refresh was written to the provider state, and the overrides survive it.',
    PROVIDER_EXTENSION_NOTICE,
  ];
  return { exitCode: EXIT_SUCCESS, stdout: `${lines.join('\n')}\n`, stderr: '', data };
}

/** `override` — the user overrides a catalog-owned field. */
async function overrideCommand(
  registry: ProviderRegistry,
  store: CatalogStore,
  invocation: CommandInvocation,
  options: CatalogCommandOptions,
): Promise<CommandResult> {
  const modelId = invocation.operands[0];
  if (modelId === undefined || modelId.trim() === '') {
    return usageError('Error: the catalog command "override" needs a model id.');
  }

  const displayName = flagValue(invocation, '--display-name');
  const providerIds = flagValues(invocation, '--provider-id');
  if (displayName === undefined && providerIds.length === 0) {
    return usageError(
      'Error: the catalog command "override" needs --display-name or --provider-id <route>=<id>.',
    );
  }

  const connection = await resolveConnection(registry, invocation);
  if ('error' in connection) return failure(connection.error);

  let record: CatalogRecord;
  try {
    record = await catalogRecordFor(connection.value, store, options);
  } catch (error) {
    return failure(errorMessageOf(error));
  }

  const model = record.catalog.models.find((entry) => entry.id === modelId);
  if (model === undefined) {
    return failure(`the catalog of connection "${connection.value.id}" has no model "${modelId}"`);
  }

  if (displayName !== undefined) {
    record.overrides.displayNames.set(modelId, displayName);
  }

  const chosen = new Map<ProviderRoute, string>();
  for (const entry of providerIds) {
    const equals = entry.indexOf('=');
    if (equals <= 0 || equals === entry.length - 1) {
      return usageError(`Error: --provider-id takes <route>=<id>, not "${entry}".`);
    }
    const route = entry.slice(0, equals);
    if (!isProviderRoute(route)) {
      return usageError(`Error: "${route}" is not a provider route.`);
    }
    chosen.set(route, entry.slice(equals + 1));
  }
  if (chosen.size > 0) {
    const existing = record.overrides.providerIds.get(modelId) ?? new Map<ProviderRoute, string>();
    for (const [route, id] of chosen) existing.set(route, id);
    record.overrides.providerIds.set(modelId, existing);
  }

  store.set(connection.value.id, record);

  const persisted = await persistCatalogs(store, options);
  if (persisted !== undefined) return persisted;

  const data = {
    type: 'catalog.override',
    extension: PROVIDER_EXTENSION_NOTICE,
    connection: { id: connection.value.id },
    model: modelId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(chosen.size === 0
      ? {}
      : { providerIds: Object.fromEntries([...chosen].map(([route, id]) => [route, id])) }),
  };

  if (invocation.format === 'json') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `${JSON.stringify(data, null, 2)}\n`,
      stderr: '',
      data,
    };
  }

  const lines = [
    `The catalog of the provider connection "${connection.value.id}" now overrides "${modelId}".`,
    'The override survives a refresh.',
    options.statePath === undefined
      ? 'The override is in the catalog table, and it survives a refresh.'
      : 'The override was written to the provider state, so it survives the process.',
    PROVIDER_EXTENSION_NOTICE,
  ];
  return { exitCode: EXIT_SUCCESS, stdout: `${lines.join('\n')}\n`, stderr: '', data };
}

/* -------------------------------------------------------------------------- */
/* The catalog records                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A connection's catalog record, read from the store or from the source.
 *
 * The store is the **cache**: a record that is there is used as it is, so a
 * refresh is the only thing that rewrites it. A connection with no record is
 * read from its source and the record is written.
 */
async function catalogRecordFor(
  connection: Connection,
  store: CatalogStore,
  options: CatalogCommandOptions,
): Promise<CatalogRecord> {
  const existing = store.get(connection.id);
  if (existing !== undefined) return existing;

  const catalog = await readCatalogFor(connection, options);
  const record: CatalogRecord = { catalog, overrides: createCatalogOverrides() };
  store.set(connection.id, record);
  return record;
}

/**
 * Read a connection's catalog from its source.
 *
 * The `builtin` source is the target's own table; a `file` source is read
 * from disk and a `url` source is fetched. Both are imported through
 * `importCatalog`, so a malformed document is refused rather than half-read.
 */
async function readCatalogFor(
  connection: Connection,
  options: CatalogCommandOptions,
  invocation?: CommandInvocation,
): Promise<ModelCatalog> {
  // A place named on the command line wins over the connection's own source
  // kind: `catalog refresh --catalog-file ./models.json` reads that file for
  // any connection.
  const named = locationFromInvocation(invocation);
  if (named !== undefined) {
    if (named.kind === 'file') return readFileCatalog(connection, named.path);
    return readUrlCatalog(connection, named.url, options);
  }

  const location = options.sources?.(connection);

  switch (connection.catalogSource) {
    case 'builtin':
      return builtinCatalogFor(connection.id);
    case 'file': {
      if (location === undefined || location.kind !== 'file') {
        throw new Error(
          `the catalog source of connection "${connection.id}" is a file, but no catalog file was given`,
        );
      }
      return readFileCatalog(connection, location.path);
    }
    case 'url': {
      if (location === undefined || location.kind !== 'url') {
        throw new Error(
          `the catalog source of connection "${connection.id}" is a URL, but no catalog URL was given`,
        );
      }
      return readUrlCatalog(connection, location.url, options);
    }
    default: {
      const unknown: never = connection.catalogSource;
      throw new Error(`unknown catalog source: ${JSON.stringify(unknown)}`);
    }
  }
}

/** Read a catalog from a file. */
async function readFileCatalog(connection: Connection, path: string): Promise<ModelCatalog> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `the catalog file of connection "${connection.id}" could not be read: ${errorMessageOf(error)}`,
    );
  }
  return importCatalog(parseCatalog(raw, connection.id), connection.id);
}

/** Read a catalog from a URL. */
async function readUrlCatalog(
  connection: Connection,
  url: string,
  options: CatalogCommandOptions,
): Promise<ModelCatalog> {
  const fetcher = options.fetch ?? defaultFetch;
  let document: unknown;
  try {
    const response = await fetcher(url);
    document = await response.json();
  } catch (error) {
    throw new Error(
      `the catalog URL of connection "${connection.id}" could not be read: ${errorMessageOf(error)}`,
    );
  }
  return importCatalog(document, connection.id);
}

/** The default fetcher of a URL catalog. */
const defaultFetch = async (url: string): Promise<{ json(): Promise<unknown> }> => {
  const response = await fetch(url);
  return { json: async () => response.json() };
};

/** The place a one-off refresh reads from, when the command names one. */
function locationFromInvocation(
  invocation: CommandInvocation | undefined,
): CatalogSourceLocation | undefined {
  if (invocation === undefined) return undefined;
  const file = flagValue(invocation, '--catalog-file');
  if (file !== undefined) return { kind: 'file', path: file };
  const url = flagValue(invocation, '--catalog-url');
  if (url !== undefined) return { kind: 'url', url };
  return undefined;
}

/** Parse a catalog document. */
function parseCatalog(raw: string, connectionId: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `the catalog of connection "${connectionId}" is not valid JSON: ${errorMessageOf(error)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The persistence                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The catalog table, in the persisted form.
 *
 * The overrides are written as **pairs** and **triples** rather than as maps,
 * because the persisted form is JSON and a JSON object cannot carry a
 * non-string key.
 */
export function catalogStateOf(store: CatalogStore): CatalogStateEntry[] {
  const entries: CatalogStateEntry[] = [];
  for (const id of store.ids()) {
    const record = store.get(id);
    if (record === undefined) continue;
    entries.push({
      connectionId: id,
      catalog: record.catalog,
      displayNames: [...record.overrides.displayNames.entries()],
      providerIds: [...record.overrides.providerIds.entries()].flatMap(([modelId, routes]) =>
        [...routes.entries()].map(([route, providerId]) => [modelId, route, providerId] as const),
      ),
    });
  }
  return entries;
}

/**
 * The catalog table the persisted form describes.
 *
 * A record whose catalog is not there is skipped: a persisted entry that
 * cannot be read is not a catalog.
 */
export function catalogStoreOfState(entries: readonly CatalogStateEntry[]): CatalogStore {
  const records: Array<readonly [string, CatalogRecord]> = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.connectionId !== 'string' || entry.connectionId === '') continue;
    if (entry.catalog === null || typeof entry.catalog !== 'object') continue;

    const overrides = createCatalogOverrides();
    for (const pair of entry.displayNames ?? []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const modelId = pair[0];
      const displayName = pair[1];
      if (typeof modelId !== 'string' || typeof displayName !== 'string') continue;
      overrides.displayNames.set(modelId, displayName);
    }
    for (const triple of entry.providerIds ?? []) {
      if (!Array.isArray(triple) || triple.length < 3) continue;
      const modelId = triple[0];
      const route = triple[1];
      const providerId = triple[2];
      if (typeof modelId !== 'string' || typeof providerId !== 'string') continue;
      if (!isProviderRoute(route)) continue;
      const routes = overrides.providerIds.get(modelId) ?? new Map<ProviderRoute, string>();
      routes.set(route, providerId);
      overrides.providerIds.set(modelId, routes);
    }

    records.push([entry.connectionId, { catalog: entry.catalog, overrides }]);
  }
  return createCatalogStore(records);
}

/**
 * The catalog table the state file holds.
 *
 * A file that is not there is an empty table: a manager that has never been
 * used has no catalogs.
 */
export async function catalogStoreFromStateFile(path: string): Promise<CatalogStore> {
  const state = await readProviderStateFile(path);
  if (state === undefined) return createCatalogStore();
  return catalogStoreOfState(state.catalogs);
}

/**
 * Write the catalog table back to the state file.
 *
 * The result is `undefined` when there is nothing to write or when the write
 * succeeded, and a **failure** when the write did not: a verb that reports a
 * durable change while the change died with the process is exactly the lie
 * the state file exists to prevent.
 */
async function persistCatalogs(
  store: CatalogStore,
  options: CatalogCommandOptions,
): Promise<CommandResult | undefined> {
  const statePath = options.statePath;
  if (statePath === undefined) return undefined;
  try {
    await updateProviderStateFile(statePath, { catalogs: catalogStateOf(store) });
  } catch (error) {
    return failure(`the provider state could not be written: ${errorMessageOf(error)}`);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The connection an operation applies to.
 *
 * The named connection wins; otherwise the **active** one is used. The active
 * connection is resolved through the registry's own `active()` and **not**
 * through the manager's credential check: browsing a catalog must not need a
 * credential, and must not read one.
 */
async function resolveConnection(
  registry: ProviderRegistry,
  invocation: CommandInvocation,
  named?: string,
): Promise<{ value: Connection } | { error: string }> {
  const id = named ?? flagValue(invocation, '--connection');
  if (id !== undefined) {
    const connection = registry.get(id);
    if (connection === undefined) return { error: `no connection with id "${id}"` };
    return { value: connection };
  }

  let active: Connection | undefined;
  try {
    active = registry.active();
  } catch (error) {
    return { error: errorMessageOf(error) };
  }
  if (active === undefined) return { error: 'no enabled provider connection' };
  return { value: active };
}

/**
 * The catalog's rows, with the user's overrides applied and the filters
 * applied.
 *
 * The filters are the search's: the query matches the model **id** or the
 * **display name**, case-insensitively, and the family matches the family
 * exactly.
 */
function effectiveModels(
  record: CatalogRecord,
  query: string | undefined,
  family: string | undefined,
): CatalogModel[] {
  let models = record.catalog.models.map((model) => applyCatalogOverrides(model, record.overrides));

  if (family !== undefined && family.trim() !== '') {
    const wanted = family.trim().toLowerCase();
    models = models.filter((model) => model.family.toLowerCase() === wanted);
  }

  if (query !== undefined && query.trim() !== '') {
    const needle = query.trim().toLowerCase();
    models = models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) || model.displayName.toLowerCase().includes(needle),
    );
  }

  return models;
}

/** The models, grouped by family, in the catalog's own order. */
function groupByFamily(models: readonly CatalogModel[]): Array<{ family: string; models: CatalogModel[] }> {
  const groups = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const existing = groups.get(model.family);
    if (existing === undefined) groups.set(model.family, [model]);
    else existing.push(model);
  }
  return [...groups].map(([family, entries]) => ({ family, models: entries }));
}

/**
 * The machine-readable form of a model.
 *
 * The per-route ids are the **served** ones; the routes that do not serve the
 * model are listed separately, so "not served" is a fact and never a guess.
 */
function modelDocument(model: CatalogModel, route: ProviderRoute): Record<string, unknown> {
  // The map is **null-prototype**: its keys are route names, and a null
  // prototype makes it impossible for one of them to reach an inherited member
  // of `Object.prototype`.
  const providerIds: Record<string, string> = Object.create(null) as Record<string, string>;
  const unavailableRoutes: string[] = [];
  for (const candidate of ROUTE_NAMES) {
    const id = providerIdFor(model, candidate);
    if (id === undefined) unavailableRoutes.push(candidate);
    else providerIds[candidate] = id;
  }
  return {
    id: model.id,
    displayName: model.displayName,
    family: model.family,
    providerIds,
    unavailableRoutes,
    activeRoute: route,
    activeRouteAvailable: providerIdFor(model, route) !== undefined,
  };
}

/** The query of a search. */
function queryOf(invocation: CommandInvocation): string | undefined {
  const query = invocation.operands[0];
  if (query === undefined) return undefined;
  return query;
}
