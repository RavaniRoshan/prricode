/**
 * The provider manager command — `/provider`, and its non-interactive
 * `--provider …` form.
 *
 * **This whole surface is a project extension.** The target has **no**
 * user-managed registry of provider connections: its route selector yields
 * exactly one active route from environment flags, and the model catalog is
 * built in and provider-owned (audit §2.1, "Important negative finding"). The
 * commands here are therefore this implementation's own product surface, and every one of
 * them **says so** — in the command's own output, in its `--help`, and in the
 * machine-readable document it writes. The label is not decoration: a reader
 * must never mistake the extension for target behavior.
 *
 * ## The three rules this module exists to enforce
 *
 * 1. **Credentials are references only.** A connection carries an environment
 *    variable name, a file path, or an OS credential-store key. The commands
 *    here never read a secret into a table row, a JSON document, an error
 *    message, or a log line. The `list` output shows a **status** — resolved,
 *    unresolved, unreadable, refused — and the **reference**, never the value.
 * 2. **The status is presence, not the secret.** The status comes from
 *    `credentialStatus` (`src/provider/credentials.ts`), which inspects
 *    *presence* only and never touches the OS credential store, so a listing
 *    can never trigger an OS prompt.
 * 3. **One resolution path.** The only path from a reference to a value is
 *    `resolveConnectionCredential` (`src/provider/registry.ts`), which runs the
 *    untrusted-endpoint guard first. The `test` operation uses it — it has to,
 *    because it calls the provider — and **redacts** the value out of every
 *    message it reports.
 *
 * ## The failure isolation
 *
 * A connection whose credential cannot be resolved is **unusable for that
 * connection only**. The listing reports it and keeps going; the other
 * connections are untouched. The active-connection resolution refuses to select
 * an unusable connection and **names it** in the error, so the user is told
 * *which* connection is broken rather than being told that "something" is.
 *
 * ## What this module shares
 *
 * The result record, the extension label, the argument parser, the table
 * renderer and the state file live in `src/cli/commands/shared.ts` — one home
 * for the pieces two commands use, so the two cannot drift. See that module's
 * header for why the parser is there and not in `src/cli/args.ts`.
 */

import {
  checkCredentialDelivery,
  resolveConnectionCredential,
  resolveConnectionEndpoint,
  useConnection,
  type Connection,
  type CredentialRef,
  type ProviderRegistry,
} from '../../provider/registry.js';
import { credentialStatus } from '../../provider/credentials.js';
import { isProviderRoute, type ProviderRoute } from '../../provider/routes.js';
import { driverFor } from '../../provider/drivers/index.js';
import type { ProviderRequest } from '../../provider/drivers/types.js';
import { EXIT_FAILURE, EXIT_SUCCESS } from '../output.js';

import {
  PROVIDER_EXTENSION_LABEL,
  PROVIDER_EXTENSION_NOTICE,
  errorMessageOf,
  failure,
  flagValue,
  parseInvocation,
  renderTable,
  updateProviderStateFile,
  usageError,
  type CommandInvocation,
  type CommandResult,
} from './shared.js';

/* -------------------------------------------------------------------------- */
/* The credential view                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The status of a connection's credential **reference**.
 *
 *   - `resolved` — the reference names something that is present. For a
 *     keychain reference this reports the **reference's** completeness, because
 *     a listing never reads the OS credential store;
 *   - `unresolved` — nothing is there;
 *   - `unreadable` — something is there, but it cannot be read;
 *   - `refused` — the reference is fine, but this implementation refuses to deliver the
 *     credential to the connection's endpoint (the untrusted-endpoint guard).
 */
export type ProviderCredentialStatus = 'resolved' | 'unresolved' | 'unreadable' | 'refused';

/**
 * What the commands show about a connection's credential.
 *
 * It carries the **reference** and the **status** — never the value.
 */
export interface ProviderCredentialView {
  /** The kind of the reference. */
  kind: 'env' | 'file' | 'keychain';
  /** The reference itself — a name, a path, or a store key. Never a value. */
  reference: string;
  /** The status of the reference. */
  status: ProviderCredentialStatus;
  /** Whether the connection can be used as it stands. */
  usable: boolean;
  /** Why the connection is not usable, when it is not. */
  reason?: string;
}

/**
 * The reference of a credential, as it is shown.
 *
 * The spelling names the **kind** first, so a reader can tell an environment
 * variable name from a file path from a credential-store key at a glance.
 */
export function credentialReferenceOf(ref: CredentialRef): string {
  switch (ref.kind) {
    case 'env':
      return `env:${ref.name}`;
    case 'file':
      return `file:${ref.path}`;
    case 'keychain':
      return `keychain:${ref.service}/${ref.account}`;
    default: {
      const unknown: never = ref;
      throw new Error(`unknown credential reference kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/** The kind of a credential reference. */
function credentialKindOf(ref: CredentialRef): ProviderCredentialView['kind'] {
  return ref.kind;
}

/**
 * Why a credential reference cannot be resolved, in the words of its kind.
 *
 * The message names the **reference**, never a value.
 *
 * The keychain case is reached when the reference is **incomplete** — an empty
 * service or an empty account. The registry refuses such a connection, so the
 * command cannot produce one; the view function is exported, though, and a
 * caller that hands it a hand-built connection must still get an answer that
 * names the store entry rather than a wrong kind's wording.
 */
function unresolvedReason(ref: CredentialRef): string {
  switch (ref.kind) {
    case 'env':
      return `the environment variable ${ref.name} is not set`;
    case 'file':
      return `the credential file ${ref.path} is missing or unreadable`;
    case 'keychain':
      return `the credential-store entry ${ref.service}/${ref.account} is not configured`;
    default: {
      const unknown: never = ref;
      throw new Error(`unknown credential reference kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * What the commands show about a connection's credential.
 *
 * The status comes from `credentialStatus`, which inspects **presence** only.
 * The untrusted-endpoint guard is consulted as well, because a connection whose
 * credential would not be delivered is not usable either — and the refusal
 * names the host, which is a fact about the endpoint and not about the secret.
 */
export async function credentialViewOf(
  connection: Connection,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderCredentialView> {
  const reference = credentialReferenceOf(connection.credential);
  const kind = credentialKindOf(connection.credential);

  let status: ProviderCredentialStatus;
  let reason: string | undefined;

  const delivery = checkCredentialDelivery(connection, env);
  if (!delivery.allowed) {
    status = 'refused';
    reason = delivery.reason ?? `the credential would not be delivered to ${delivery.host}`;
  } else {
    const presence = await credentialStatus(connection.credential, env);
    if (presence === 'configured') {
      status = 'resolved';
    } else if (presence === 'missing') {
      status = 'unresolved';
      reason = unresolvedReason(connection.credential);
    } else {
      status = 'unreadable';
      reason = unresolvedReason(connection.credential);
    }
  }

  const view: ProviderCredentialView = {
    kind,
    reference,
    status,
    usable: status === 'resolved',
  };
  if (reason !== undefined) view.reason = reason;
  return view;
}

/* -------------------------------------------------------------------------- */
/* The connection view                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything the commands show about one connection.
 *
 * The shape is what the picker consumes, so the two surfaces cannot disagree
 * about what a connection is.
 */
export interface ProviderConnectionView {
  /** The connection's id. */
  id: string;
  /** The connection's display name. */
  name: string;
  /** The route the connection talks to. */
  route: ProviderRoute;
  /** The effective base URL. */
  baseUrl: string;
  /** Whether the connection is the active one. */
  active: boolean;
  /** Where the connection's catalog comes from. */
  catalogSource: Connection['catalogSource'];
  /** The credential's reference and status. Never the value. */
  credential: ProviderCredentialView;
}

/**
 * Why a connection is not usable, in one phrase.
 *
 * The **status** leads, so a reader learns *which* kind of failure it is
 * (unresolved, unreadable, refused) before the detail. The detail names the
 * reference or the host — never a value.
 */
function unusableReason(view: ProviderCredentialView): string {
  return view.reason === undefined ? view.status : `${view.status}: ${view.reason}`;
}

/**
 * The view of every connection in a registry.
 *
 * **Isolation.** One connection's failure never fails the others: a view that
 * cannot be built is reported as an unusable connection rather than thrown, so
 * a broken entry cannot hide the rest of the table.
 */
export async function connectionViewsOf(
  registry: ProviderRegistry,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderConnectionView[]> {
  const env = options.env ?? process.env;
  const views: ProviderConnectionView[] = [];

  for (const connection of registry.list()) {
    let credential: ProviderCredentialView;
    try {
      credential = await credentialViewOf(connection, env);
    } catch (error) {
      credential = {
        kind: credentialKindOf(connection.credential),
        reference: credentialReferenceOf(connection.credential),
        status: 'unreadable',
        usable: false,
        reason: `the credential reference could not be inspected: ${errorMessageOf(error)}`,
      };
    }

    let baseUrl = connection.baseUrl ?? '';
    try {
      baseUrl = resolveConnectionEndpoint(connection, env).baseUrl;
    } catch {
      // A route whose endpoint policy cannot be resolved leaves the base URL
      // empty; the row still reports the connection.
    }

    views.push({
      id: connection.id,
      name: connection.name,
      route: connection.route,
      baseUrl,
      active: connection.enabled,
      catalogSource: connection.catalogSource,
      credential,
    });
  }

  return views;
}

/* -------------------------------------------------------------------------- */
/* The active connection                                                        */
/* -------------------------------------------------------------------------- */

/** The options the active-connection resolution takes. */
export interface ActiveConnectionOptions {
  /** The environment. Defaults to the process's. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The connection a run uses.
 *
 * The registry's own `active()` decides **which** connection is active; this
 * function adds the manager's own check: an active connection whose credential
 * cannot be resolved is **not** usable, and the resolution refuses to select
 * it. The error **names the connection**, so the user is told which entry is
 * broken.
 */
export async function resolveActiveConnection(
  registry: ProviderRegistry,
  options: ActiveConnectionOptions = {},
): Promise<Connection> {
  const env = options.env ?? process.env;
  const active = registry.active();
  if (active === undefined) {
    throw new Error('no enabled provider connection');
  }

  const view = await credentialViewOf(active, env);
  if (!view.usable) {
    throw new Error(
      `the active provider connection "${active.id}" is unusable (${unusableReason(view)})`,
    );
  }
  return active;
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                    */
/* -------------------------------------------------------------------------- */

/** What a probe is asked to test. */
export interface ProviderProbeRequest {
  /** The connection under test. */
  connection: Connection;
  /** The base URL the probe targets. */
  baseUrl: string;
  /** The route the connection talks to. */
  route: ProviderRoute;
  /**
   * The resolved credential.
   *
   * The probe needs it, and it is the **only** reason the `test` operation
   * resolves a secret. It must never be put into a message, a log line, or a
   * return value that the command writes out — the command redacts it.
   */
  credential: string;
  /** The model the probe asks for. Defaults to {@link PROVIDER_PROBE_MODEL}. */
  model?: string;
}

/** What a probe reports. */
export interface ProviderProbeResult {
  /** Whether the connection answered. */
  ok: boolean;
  /** The HTTP status, when the probe got one. */
  status?: number;
  /** A message describing the outcome. Never the credential. */
  message: string;
}

/** The probe the `test` operation uses. */
export type ProviderProbe = (request: ProviderProbeRequest) => Promise<ProviderProbeResult>;

/** How long the default probe waits for an answer. */
export const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

/**
 * The shape of the probe request.
 *
 * **Observed** (audit §2.2, "Application call sites"): "API-key verification: a
 * `max_tokens: 1` request with `messages: [{ role: "user", content: "test" }]`",
 * posted to `/v1/messages` (audit §2.2: "the client posts to `/v1/messages`").
 *
 * A probe that asked the endpoint for anything else would report the wrong
 * thing: `https://api.anthropic.com/` answers a `GET /` with a **404**, so a
 * probe that reads the root path reports every healthy connection as unusable.
 */
export const PROVIDER_PROBE_MAX_TOKENS = 1;

/** The message the probe sends. */
export const PROVIDER_PROBE_MESSAGE = 'test';

/**
 * The model the probe asks for.
 *
 * The audit's verification names the request's shape but not its model; the
 * probe asks for the cheapest model this implementation's catalog knows, so the check
 * costs as little as a check can.
 */
export const PROVIDER_PROBE_MODEL = 'claude-haiku-4-5';

/**
 * The default probe: one request to the connection's endpoint.
 *
 * The request carries the credential the way the route's own driver builds
 * it, so the probe exercises the same auth shape a real request would. The
 * response is reported by its status; the credential never leaves this
 * function.
 *
 * **The shape.** The request is the audit's own **API-key verification**
 * (audit §2.2): a `POST` to `/v1/messages` with `max_tokens: 1` and the
 * message `[{ role: "user", content: "test" }]`. The **route's** driver builds
 * the URL and the body, so a route whose wire shape is its own asks its own
 * question; the first-party route — the default one — asks the audit's.
 *
 * **A 2xx is a success.** Any other status is reported: `401` and `403` as a
 * refused credential, anything else as the endpoint's own status.
 */
export async function defaultProviderProbe(request: ProviderProbeRequest): Promise<ProviderProbeResult> {
  let url: string;
  let headers: Record<string, string>;
  let body: string;
  try {
    const driver = driverFor(request.route);
    const probeRequest: ProviderRequest = {
      model: request.model ?? PROVIDER_PROBE_MODEL,
      maxTokens: PROVIDER_PROBE_MAX_TOKENS,
      messages: [{ role: 'user', content: PROVIDER_PROBE_MESSAGE }],
      tools: [],
      stream: false,
    };
    url = driver.buildUrl(probeRequest, request.baseUrl);
    const built = driver.buildBody(probeRequest, request.credential);
    headers = built.headers;
    body = typeof built.body === 'string' ? built.body : JSON.stringify(built.body);
  } catch (error) {
    return {
      ok: false,
      message: `the request could not be built: ${errorMessageOf(error)}`,
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
    });
    const status = response.status;
    // The body is **not** read: the probe reports the status, and a response
    // body is never part of the answer. It is cancelled so the socket is
    // released rather than left open.
    const stream = response.body;
    if (stream !== null) await stream.cancel().catch(() => undefined);
    if (status === 401 || status === 403) {
      return { ok: false, status, message: `the endpoint refused the credential (HTTP ${status})` };
    }
    // **A 2xx is a success** and nothing else is: a redirect is not an answer
    // the probe can use, and an error is the endpoint's own status.
    if (status >= 200 && status < 300) {
      return { ok: true, status, message: `the endpoint answered HTTP ${status}` };
    }
    return { ok: false, status, message: `the endpoint answered HTTP ${status}` };
  } catch (error) {
    return {
      ok: false,
      message: `the endpoint could not be reached: ${errorMessageOf(error)}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The options                                                                  */
/* -------------------------------------------------------------------------- */

/** The options the provider command runs with. */
export interface ProviderCommandOptions {
  /** The environment. Defaults to the process's. */
  env?: NodeJS.ProcessEnv;
  /** The probe the `test` operation uses. Defaults to {@link defaultProviderProbe}. */
  probe?: ProviderProbe;
  /**
   * Where the manager's state is kept.
   *
   * When it is set, a verb that changes the connection table writes the state
   * back, so a **later invocation** sees the change. Without it the registry
   * is the caller's own and lives only as long as the caller holds it.
   */
  statePath?: string;
  /** The model the probe asks for. */
  probeModel?: string;
}

/* -------------------------------------------------------------------------- */
/* The verbs                                                                    */
/* -------------------------------------------------------------------------- */

/** The verbs the provider command knows. */
export const PROVIDER_VERBS = ['list', 'add', 'remove', 'use', 'test'] as const;

/** One of the provider command's verbs. */
export type ProviderVerb = (typeof PROVIDER_VERBS)[number];

/** Whether a string is one of the provider command's verbs. */
function isProviderVerb(value: string): value is ProviderVerb {
  return (PROVIDER_VERBS as readonly string[]).includes(value);
}

/**
 * The flags the provider command knows.
 *
 * The value-taking flags are listed explicitly, so an unknown flag is a usage
 * error rather than a silently ignored token.
 */
const PROVIDER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--format',
  '--name',
  '--route',
  '--base-url',
  '--credential',
  '--credential-env',
  '--credential-file',
  '--credential-keychain',
  '--catalog-source',
]);

/** The flags the provider command knows that take no value. */
const PROVIDER_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--json',
  '--help',
  '--use',
  '--allow-untrusted-endpoint',
]);

/* -------------------------------------------------------------------------- */
/* The help                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The provider command's help.
 *
 * The label is in the first line, because the help is where a reader decides
 * whether the command is part of the target or part of this implementation.
 */
export const PROVIDER_COMMAND_HELP = `Usage: provider <verb> [options]  (also: --provider <verb> [options])

The multi-provider manager is a project extension, not part of the reference agent.
The target has no user-managed registry of provider connections.

Verbs:
  list                     print one row per connection: id, name, route, base URL
                           and the credential's status
  add <id>                 add a connection
  remove <id>              remove a connection
  use <id>                 make a connection the active one
  test <id>                resolve the connection's credential and test the endpoint

Options:
  --name <name>            the connection's display name (add); one word: a
                           whitespace or a control character is refused
  --route <route>          the provider route: firstParty, gateway, bedrock,
                           foundry, anthropicAws, anthropicGoogleCloud, mantle
                           or vertex (add)
  --base-url <url>         an explicit base URL (add)
  --credential-env <name>  the credential reference is an environment variable
  --credential-file <path> the credential reference is a file
  --credential-keychain <service/account>
                           the credential reference is an OS credential-store entry
  --catalog-source <src>   where the connection's model catalog comes from:
                           builtin, file or url (add)
  --allow-untrusted-endpoint
                           allow the credential to be sent to a base URL that is
                           not the provider's own vendor host (add)
  --use                    make the new connection the active one (add)
  --json                   write the machine-readable document
  --format <text|json>     the output format (json in the --provider form)
  --help                   write this help and stop

A credential is a reference, never a value: name an environment variable, a
file, or an OS credential-store entry. The commands never print a value.

A connection id is a key: 1 to 64 letters, digits, dots, dashes or
underscores, starting with a letter or a digit. It never carries a
whitespace, a control character or a path separator.
`;

/* -------------------------------------------------------------------------- */
/* The command                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run the provider manager command.
 *
 * @param args The command's arguments — the subcommand form (`list`) or the
 *   non-interactive flag form (`--provider list`).
 * @param registry The connection registry.
 * @param options The environment, the probe and the state file.
 */
export async function providerCommand(
  args: string[],
  registry: ProviderRegistry,
  options: ProviderCommandOptions = {},
): Promise<CommandResult> {
  const parsed = parseInvocation(args, {
    commandFlag: '--provider',
    commandWord: 'provider',
    valueFlags: PROVIDER_VALUE_FLAGS,
    booleanFlags: PROVIDER_BOOLEAN_FLAGS,
  });
  if (!parsed.ok) return usageError(parsed.message);
  const invocation = parsed.invocation;

  if (invocation.help || invocation.verb === undefined || invocation.verb === 'help') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: PROVIDER_COMMAND_HELP,
      stderr: '',
    };
  }

  const verb = invocation.verb;

  // A raw credential is refused before anything else happens. This implementation's rule
  // is that a credential is a **reference**; the value never enters the
  // command's own vocabulary, and the refusal never repeats it back.
  if (flagValue(invocation, '--credential') !== undefined) {
    return usageError(
      'Error: a credential is a reference, never a value. Use --credential-env, --credential-file or --credential-keychain.',
    );
  }

  if (!isProviderVerb(verb)) {
    return usageError(
      `Error: unknown provider command "${verb}". The commands are: ${PROVIDER_VERBS.join(', ')}.`,
    );
  }

  switch (verb) {
    case 'list':
      return listCommand(registry, invocation, options);
    case 'add':
      return addCommand(registry, invocation, options);
    case 'remove':
      return removeCommand(registry, invocation, options);
    case 'use':
      return useCommand(registry, invocation, options);
    case 'test':
      return testCommand(registry, invocation, options);
    default: {
      const unknown: never = verb;
      throw new Error(`unknown provider verb: ${JSON.stringify(unknown)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The verbs                                                                    */
/* -------------------------------------------------------------------------- */

/** `list` — one row per connection. */
async function listCommand(
  registry: ProviderRegistry,
  invocation: CommandInvocation,
  options: ProviderCommandOptions,
): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const views = await connectionViewsOf(registry, { env });

  const data = {
    type: 'provider.connections',
    extension: PROVIDER_EXTENSION_NOTICE,
    connections: views.map((view) => ({
      id: view.id,
      name: view.name,
      route: view.route,
      baseUrl: view.baseUrl,
      active: view.active,
      catalogSource: view.catalogSource,
      credential: {
        kind: view.credential.kind,
        reference: view.credential.reference,
        status: view.credential.status,
        usable: view.credential.usable,
        ...(view.credential.reason === undefined ? {} : { reason: view.credential.reason }),
      },
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
  lines.push(`Provider connections (${PROVIDER_EXTENSION_LABEL})`);
  lines.push('');
  if (views.length === 0) {
    lines.push('No provider connections are configured.');
  } else {
    const rows = views.map((view) => [
      view.id,
      view.active ? `${view.name} *` : view.name,
      view.route,
      view.baseUrl,
      view.credential.reference,
      view.credential.status,
    ]);
    lines.push(...renderTable(['ID', 'NAME', 'ROUTE', 'BASE URL', 'CREDENTIAL', 'STATUS'], rows));
    lines.push('');
    lines.push('* the active connection. CREDENTIAL is a reference, never a value.');
  }
  lines.push(PROVIDER_EXTENSION_NOTICE);

  return { exitCode: EXIT_SUCCESS, stdout: `${lines.join('\n')}\n`, stderr: '', data };
}

/** `add` — register a connection. */
async function addCommand(
  registry: ProviderRegistry,
  invocation: CommandInvocation,
  options: ProviderCommandOptions,
): Promise<CommandResult> {
  const env = options.env ?? process.env;

  const id = invocation.operands[0];
  if (id === undefined || id.trim() === '') {
    return usageError('Error: the provider command "add" needs a connection id.');
  }
  if (invocation.operands.length > 1) {
    return usageError('Error: the provider command "add" takes one connection id.');
  }
  const idProblem = connectionIdProblem(id);
  if (idProblem !== undefined) return usageError(idProblem);
  if (registry.get(id) !== undefined) {
    return failure(`a connection with id "${id}" already exists`);
  }

  const name = flagValue(invocation, '--name') ?? id;
  if (name.trim() === '') {
    return usageError('Error: the connection needs a non-empty name.');
  }
  const nameProblem = connectionNameProblem(name);
  if (nameProblem !== undefined) return usageError(nameProblem);

  const routeValue = flagValue(invocation, '--route') ?? 'firstParty';
  if (!isProviderRoute(routeValue)) {
    return usageError(`Error: "${routeValue}" is not a provider route.`);
  }
  const route: ProviderRoute = routeValue;

  const credential = credentialRefOf(invocation);
  if ('error' in credential) return usageError(credential.error);

  const catalogSourceValue = flagValue(invocation, '--catalog-source') ?? 'builtin';
  if (catalogSourceValue !== 'builtin' && catalogSourceValue !== 'file' && catalogSourceValue !== 'url') {
    return usageError(
      `Error: "${catalogSourceValue}" is not a catalog source. The sources are: builtin, file, url.`,
    );
  }

  const baseUrl = flagValue(invocation, '--base-url');

  const connection: Connection = {
    id,
    name,
    route,
    credential: credential.ref,
    catalogSource: catalogSourceValue,
    enabled: false,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(invocation.flags.has('--allow-untrusted-endpoint')
      ? { allowUntrustedEndpoint: true }
      : {}),
  };

  // The usability check runs **before** the connection is added, so a refused
  // `--use` leaves the registry exactly as it was.
  if (invocation.flags.has('--use')) {
    const view = await credentialViewOf(connection, env);
    if (!view.usable) {
      return failure(
        `the provider connection "${id}" is unusable (${unusableReason(view)})`,
      );
    }
  }

  try {
    registry.add(connection);
  } catch (error) {
    return failure(errorMessageOf(error));
  }

  let active = false;
  if (invocation.flags.has('--use')) {
    try {
      useConnection(registry, id);
      active = true;
    } catch (error) {
      return failure(errorMessageOf(error));
    }
  }

  const persisted = await persistConnections(registry, options);
  if (persisted !== undefined) return persisted;

  const data = {
    type: 'provider.connection',
    extension: PROVIDER_EXTENSION_NOTICE,
    connection: {
      id,
      name,
      route,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      catalogSource: catalogSourceValue,
      credential: { kind: credential.ref.kind, reference: credentialReferenceOf(credential.ref) },
      active,
    },
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
    `Added the provider connection "${id}" (${route}).`,
    PROVIDER_EXTENSION_NOTICE,
  ];
  return { exitCode: EXIT_SUCCESS, stdout: `${lines.join('\n')}\n`, stderr: '', data };
}

/** `remove` — drop a connection. */
async function removeCommand(
  registry: ProviderRegistry,
  invocation: CommandInvocation,
  options: ProviderCommandOptions,
): Promise<CommandResult> {
  const id = invocation.operands[0];
  if (id === undefined || id.trim() === '') {
    return usageError('Error: the provider command "remove" needs a connection id.');
  }

  const removed = registry.remove(id);
  if (!removed) {
    return failure(`no connection with id "${id}"`);
  }

  const persisted = await persistConnections(registry, options);
  if (persisted !== undefined) return persisted;

  const data = {
    type: 'provider.connection.removed',
    extension: PROVIDER_EXTENSION_NOTICE,
    id,
  };

  if (invocation.format === 'json') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `${JSON.stringify(data, null, 2)}\n`,
      stderr: '',
      data,
    };
  }

  return {
    exitCode: EXIT_SUCCESS,
    stdout: `Removed the provider connection "${id}".\n${PROVIDER_EXTENSION_NOTICE}\n`,
    stderr: '',
    data,
  };
}

/** `use` — make a connection the active one. */
async function useCommand(
  registry: ProviderRegistry,
  invocation: CommandInvocation,
  options: ProviderCommandOptions,
): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const id = invocation.operands[0];
  if (id === undefined || id.trim() === '') {
    return usageError('Error: the provider command "use" needs a connection id.');
  }

  const connection = registry.get(id);
  if (connection === undefined) {
    return failure(`no connection with id "${id}"`);
  }

  // The switch refuses an unusable connection, and names it.
  const view = await credentialViewOf(connection, env);
  if (!view.usable) {
    return failure(`the provider connection "${id}" is unusable (${unusableReason(view)})`);
  }

  try {
    useConnection(registry, id);
  } catch (error) {
    return failure(errorMessageOf(error));
  }

  const persisted = await persistConnections(registry, options);
  if (persisted !== undefined) return persisted;

  const data = {
    type: 'provider.active',
    extension: PROVIDER_EXTENSION_NOTICE,
    active: { id, name: connection.name, route: connection.route },
  };

  if (invocation.format === 'json') {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `${JSON.stringify(data, null, 2)}\n`,
      stderr: '',
      data,
    };
  }

  return {
    exitCode: EXIT_SUCCESS,
    stdout: `The active provider connection is now "${id}".\n${PROVIDER_EXTENSION_NOTICE}\n`,
    stderr: '',
    data,
  };
}

/** `test` — resolve the credential and test the endpoint. */
async function testCommand(
  registry: ProviderRegistry,
  invocation: CommandInvocation,
  options: ProviderCommandOptions,
): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultProviderProbe;

  const id = invocation.operands[0];
  if (id === undefined || id.trim() === '') {
    return usageError('Error: the provider command "test" needs a connection id.');
  }

  const connection = registry.get(id);
  if (connection === undefined) {
    return failure(`no connection with id "${id}"`);
  }

  // **The only resolution.** `resolveConnectionCredential` is this implementation's single
  // path from a reference to a value, and it runs the untrusted-endpoint guard
  // first. The value never leaves this function except into the probe.
  let resolved;
  try {
    resolved = await resolveConnectionCredential(connection, env);
  } catch (error) {
    // The guard's refusal names the host; it never carries the credential.
    return failure(`the provider connection "${id}" cannot be used: ${errorMessageOf(error)}`);
  }

  if (!resolved.present || resolved.value === undefined) {
    const view = await credentialViewOf(connection, env);
    return failure(
      `the provider connection "${id}" is unusable (${unusableReason(view)})`,
    );
  }

  const credential = resolved.value;

  let baseUrl: string;
  try {
    baseUrl = resolveConnectionEndpoint(connection, env).baseUrl;
  } catch (error) {
    return failure(`the provider connection "${id}" has no usable endpoint: ${errorMessageOf(error)}`);
  }

  let outcome: ProviderProbeResult;
  try {
    outcome = await probe({
      connection,
      baseUrl,
      route: connection.route,
      credential,
      ...(options.probeModel === undefined ? {} : { model: options.probeModel }),
    });
  } catch (error) {
    // The probe may have put the credential into its error; it is redacted out
    // before the message is reported.
    outcome = { ok: false, message: `the endpoint could not be reached: ${redact(errorMessageOf(error), credential)}` };
  }

  const message = redact(outcome.message, credential);
  const data = {
    type: 'provider.connection.test',
    extension: PROVIDER_EXTENSION_NOTICE,
    connection: { id, name: connection.name, route: connection.route, baseUrl },
    ok: outcome.ok,
    message,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
  };

  if (invocation.format === 'json') {
    const stdout = `${JSON.stringify(data, null, 2)}\n`;
    if (outcome.ok) return { exitCode: EXIT_SUCCESS, stdout, stderr: '', data };
    return { exitCode: EXIT_FAILURE, stdout, stderr: '', data };
  }

  if (outcome.ok) {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `The provider connection "${id}" is usable: ${message}\n${PROVIDER_EXTENSION_NOTICE}\n`,
      stderr: '',
      data,
    };
  }
  return {
    exitCode: EXIT_FAILURE,
    stdout: '',
    stderr: `The provider connection "${id}" is unusable: ${message}\n`,
    data,
  };
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/** The credential reference an `add` names, or the error that says why not. */
function credentialRefOf(
  invocation: CommandInvocation,
): { ref: CredentialRef } | { error: string } {
  const envName = flagValue(invocation, '--credential-env');
  const filePath = flagValue(invocation, '--credential-file');
  const keychain = flagValue(invocation, '--credential-keychain');

  const given = [envName, filePath, keychain].filter((value) => value !== undefined);
  if (given.length === 0) {
    return {
      error:
        'Error: the connection needs a credential reference. Use --credential-env, --credential-file or --credential-keychain.',
    };
  }
  if (given.length > 1) {
    return {
      error:
        'Error: the connection takes one credential reference. Use --credential-env, --credential-file or --credential-keychain.',
    };
  }

  if (envName !== undefined) {
    if (envName.trim() === '') {
      return { error: 'Error: the credential reference needs a non-empty environment variable name.' };
    }
    // The reference is printed in the CREDENTIAL column, so a whitespace or a
    // control character in it would split the row.
    if (hasWhitespaceOrControl(envName)) {
      return {
        error: `Error: the credential reference ${JSON.stringify(envName)} may not carry a whitespace or a control character.`,
      };
    }
    return { ref: { kind: 'env', name: envName } };
  }

  if (filePath !== undefined) {
    if (filePath.trim() === '') {
      return { error: 'Error: the credential reference needs a non-empty file path.' };
    }
    if (hasWhitespaceOrControl(filePath)) {
      return {
        error: `Error: the credential reference ${JSON.stringify(filePath)} may not carry a whitespace or a control character.`,
      };
    }
    return { ref: { kind: 'file', path: filePath, format: 'raw' } };
  }

  const entry = keychain ?? '';
  const separator = entry.indexOf('/');
  if (separator <= 0 || separator === entry.length - 1) {
    return {
      error:
        'Error: the credential reference needs an OS credential-store entry as <service>/<account>.',
    };
  }
  if (hasWhitespaceOrControl(entry)) {
    return {
      error: `Error: the credential reference ${JSON.stringify(entry)} may not carry a whitespace or a control character.`,
    };
  }
  return {
    ref: { kind: 'keychain', service: entry.slice(0, separator), account: entry.slice(separator + 1) },
  };
}

/**
 * The pattern a connection id must match.
 *
 * Conservative on purpose. An id is a **key** in a table and a token on a
 * command line: it carries no whitespace, no control character and no path
 * separator, so it can never split a table row, break a column or name a file
 * outside the configuration directory.
 */
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The problem with a connection id, or `undefined` when there is none.
 *
 * The message **names the offending value**. The value is quoted with
 * `JSON.stringify`, so a value that carries a newline is shown escaped rather
 * than breaking the line the message is on.
 */
function connectionIdProblem(id: string): string | undefined {
  if (hasWhitespaceOrControl(id)) {
    return `Error: the connection id ${JSON.stringify(id)} may not carry a whitespace or a control character.`;
  }
  if (!CONNECTION_ID_PATTERN.test(id)) {
    return (
      `Error: the connection id ${JSON.stringify(id)} is not a valid id. ` +
      'An id is 1 to 64 letters, digits, dots, dashes or underscores, and it starts with a letter or a digit.'
    );
  }
  return undefined;
}

/**
 * The problem with a connection's display name, or `undefined` when there is
 * none.
 *
 * A name is shown in a **table row**, so a whitespace in it — two of them,
 * especially — would break the row the reader parses. The name is therefore
 * one word.
 */
function connectionNameProblem(name: string): string | undefined {
  if (hasWhitespaceOrControl(name)) {
    return `Error: the connection name ${JSON.stringify(name)} may not carry a whitespace or a control character.`;
  }
  return undefined;
}

/** Whether a string carries a whitespace or a control character. */
function hasWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    // A control character is anything below the space, the space itself, and
    // the delete character. The line and paragraph separators are control
    // characters too.
    if (code <= 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Write the connection table back to the state file.
 *
 * The result is `undefined` when there is nothing to write or when the write
 * succeeded, and a **failure** when the write did not: a verb that reports
 * success while the change did not survive the process is exactly the lie the
 * state file exists to prevent.
 */
async function persistConnections(
  registry: ProviderRegistry,
  options: ProviderCommandOptions,
): Promise<CommandResult | undefined> {
  const statePath = options.statePath;
  if (statePath === undefined) return undefined;
  try {
    await updateProviderStateFile(statePath, { connections: [...registry.list()] });
  } catch (error) {
    return failure(`the provider state could not be written: ${errorMessageOf(error)}`);
  }
  return undefined;
}

/**
 * The shortest **prefix** of a secret that is redacted.
 *
 * A prefix shorter than this is too short to be a meaningful part of a
 * secret, and redacting it would take ordinary words out of the message.
 */
export const REDACTION_PREFIX_FLOOR = 8;

/**
 * Remove every occurrence of a secret from a message.
 *
 * The redaction covers **four** forms of the secret, because a probe that
 * mishandles a secret does not usually paste it back verbatim:
 *
 *   - the secret itself;
 *   - the secret **trimmed** — the resolver trims a value, so the trimmed
 *     form is the one that reaches the provider;
 *   - the secret **normalized** — its whitespace collapsed, which is what a
 *     message that re-spaces a secret looks like; the matcher folds the case
 *     too, so an upper-cased secret is the same form;
 *   - a **prefix** of any of those, down to a floor of
 *     {@link REDACTION_PREFIX_FLOOR} characters. A truncated or masked secret
 *     (`sk-ant-do-no`) is still a leak.
 *
 * The matching is **case-insensitive** and **literal**: the secret is never
 * compiled into a pattern, so a secret that carries a regular-expression
 * metacharacter cannot break the redaction (or smuggle a replacement through
 * it).
 *
 * **The prefix rule over-redacts on purpose.** A message that happens to carry
 * a prefix of the secret loses that word. A lost word is a cosmetic problem;
 * a leaked prefix is a leaked credential.
 */
export function redact(text: string, secret: string): string {
  if (secret === '') return text;
  let out = text;
  for (const form of secretForms(secret)) {
    out = replaceAllInsensitive(out, form, '[redacted]');
    for (let length = form.length - 1; length >= REDACTION_PREFIX_FLOOR; length -= 1) {
      out = replaceAllInsensitive(out, form.slice(0, length), '[redacted]');
    }
  }
  return out;
}

/**
 * The forms of a secret that are redacted.
 *
 * The longest form comes first, so the whole secret is replaced before one of
 * its prefixes is. The **case** is not a form: the matcher folds it, so a
 * form that differs only in case would be the same form.
 */
function secretForms(secret: string): string[] {
  const forms: string[] = [];
  const add = (value: string): void => {
    if (value === '') return;
    if (forms.includes(value)) return;
    forms.push(value);
  };

  const trimmed = secret.trim();
  add(secret);
  add(trimmed);
  add(collapseWhitespace(trimmed));

  return forms.sort((left, right) => right.length - left.length);
}

/** Collapse every run of whitespace into a single space. */
function collapseWhitespace(value: string): string {
  let out = '';
  let pending = false;
  for (const character of value) {
    if (isWhitespace(character)) {
      pending = out !== '';
      continue;
    }
    if (pending) {
      out += ' ';
      pending = false;
    }
    out += character;
  }
  return out;
}

/** Whether a character is a whitespace. */
function isWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f' ||
    character === '\v'
  );
}

/**
 * Replace every occurrence of a needle, ignoring case.
 *
 * The needle is **not** a pattern: the search is a plain substring search on
 * the folded strings, so a needle that carries a regular-expression
 * metacharacter is matched literally.
 */
function replaceAllInsensitive(text: string, needle: string, replacement: string): string {
  if (needle === '') return text;
  const haystack = text.toLowerCase();
  const pattern = needle.toLowerCase();
  let out = '';
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(pattern, cursor);
    if (at === -1) break;
    out += text.slice(cursor, at) + replacement;
    cursor = at + pattern.length;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
