/**
 * Contract test for the provider manager surfaces: the `/provider` command, the
 * catalog browser, and the provider picker.
 *
 * **The provider manager is a project extension.** The target has no user-managed
 * registry of provider connections (audit §2.1, "Important negative finding"):
 * its route selector yields exactly one active route from environment flags,
 * and its model catalog is built in and provider-owned. Everything below is
 * therefore this implementation's own product surface, and the test pins the **label**
 * the extension carries wherever it surfaces.
 *
 * What this test pins:
 *
 *   - `provider list` prints **one row per connection** — id, name, route, base
 *     URL and credential **status** — and **never** a credential value, even
 *     when the environment variable behind the reference is set;
 *   - the same holds on the **failure** path: a provider that echoes the
 *     credential back does not get it into the output — and neither does one
 *     that echoes a **truncated** or a **re-spaced** form of it;
 *   - a connection whose credential cannot be resolved is reported as unusable
 *     **for that connection only** — the other connections are unaffected —
 *     and the active-connection resolution refuses to select it and **names it**
 *     in the error;
 *   - a connection whose endpoint is **refused** by the untrusted-endpoint
 *     guard is reported as `refused`, the reason names the host, and the
 *     credential is never resolved;
 *   - the default probe asks the endpoint the **audit's own question** — a
 *     `POST` to `/v1/messages` with `max_tokens: 1` — and a 2xx is a success;
 *   - `catalog list` groups the models by family and shows the **per-route**
 *     model ids; a model the active route does not serve is shown as
 *     **unavailable for that route** rather than hidden;
 *   - `catalog search` filters by id **and** by display name;
 *   - a catalog **refresh** rewrites the catalog's own metadata and never the
 *     connection's id, name, route or credential reference; a **user override**
 *     of a catalog-owned field survives the refresh — and survives the
 *     **process**, because the state is persisted;
 *   - the same operations are available as `--provider list`-style
 *     non-interactive flags, with machine-readable output, and every one of
 *     those documents carries the extension label;
 *   - the extension is labelled wherever it surfaces.
 *
 * The credential is a **reference** throughout: an environment variable name, a
 * file path, or an OS credential-store key. The test never puts a secret into a
 * fixture as a value — the value only ever appears in the *environment* the
 * command is handed, and the assertion is that it never comes back out.
 */

import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The file reads the test's own module graph made.
 *
 * The mock is **transparent** — it records the path and delegates — so the
 * only thing it changes is that the test can assert that a credential file
 * was **never read**.
 */
const { fsReads } = vi.hoisted(() => ({ fsReads: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const original = actual.readFile as unknown as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readFile: async (...args: unknown[]): Promise<unknown> => {
      fsReads.push(String(args[0]));
      return original(...args);
    },
  } as unknown as typeof actual;
});

import {
  createProviderRegistry,
  type Connection,
  type ProviderRegistry,
} from '../../src/provider/registry.js';
import { setKeychainBackend } from '../../src/provider/credentials.js';
import {
  credentialViewOf,
  providerCommand,
  redact,
  resolveActiveConnection,
} from '../../src/cli/commands/provider.js';
import {
  catalogCommand,
  createCatalogStore,
  type CatalogStore,
} from '../../src/cli/commands/catalog.js';
import {
  loadManagerState,
  managerArgumentsOf,
  managerCommandOf,
  providerManagerCommand,
} from '../../src/cli/commands/manager.js';
import {
  displayWidth,
  readProviderStateFile,
  registryFromState,
  type CommandResult,
} from '../../src/cli/commands/shared.js';
import {
  moveProviderPickerSelection,
  providerPickerEntries,
  providerPickerLines,
  providerPickerModel,
  renderProviderPicker,
  selectedProviderPickerEntry,
  PROVIDER_PICKER_MARKER,
  type ProviderPickerEntry,
} from '../../src/ui/modals/providerPicker.js';

/** The secret the environment carries. It must never appear in any output. */
const SECRET = 'sk-ant-do-not-print-this-value-0123456789';

/** A credential reference — a name, never a value. */
const ENV_REFERENCE = { kind: 'env', name: 'PROD_TOKEN' } as const;

/** A connection, with the parts a test cares about left to the caller. */
function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'prod',
    name: 'Production',
    route: 'firstParty',
    credential: ENV_REFERENCE,
    catalogSource: 'builtin',
    enabled: true,
    ...overrides,
  };
}

/** A registry with the two connections the isolation tests use. */
function twoConnectionRegistry(): ProviderRegistry {
  return createProviderRegistry([
    connection({
      id: 'broken',
      name: 'Broken',
      credential: { kind: 'env', name: 'MISSING_TOKEN' },
      enabled: true,
    }),
    connection({
      id: 'healthy',
      name: 'Healthy',
      credential: { kind: 'env', name: 'HEALTHY_TOKEN' },
      enabled: false,
    }),
  ]);
}

/** The lines of a result's stdout. */
function linesOf(result: CommandResult): string[] {
  return result.stdout.split('\n');
}

/** The line of a result's stdout that mentions a connection id. */
function rowFor(result: CommandResult, id: string): string {
  const row = linesOf(result).find((line) => line.includes(id));
  expect(row, `no row mentions "${id}"`).toBeDefined();
  return row ?? '';
}

/**
 * The last column of a table row.
 *
 * The status has to be read **by column**: "unresolved" contains "resolved",
 * so a substring test would say that a broken connection was fine.
 */
function statusOf(row: string): string {
  const columns = row.trim().split(/\s{2,}/);
  return columns[columns.length - 1] ?? '';
}

/**
 * The display column a needle starts at.
 *
 * The table is padded by **display width**, so a needle's position in the
 * string is not its position on the screen: a wide character takes two
 * columns and one UTF-16 unit.
 */
function displayColumnOf(line: string, needle: string): number {
  const at = line.indexOf(needle);
  if (at === -1) return -1;
  return displayWidth(line.slice(0, at));
}

/**
 * The lines of the block a model occupies in the catalog listing.
 *
 * A model is listed as a header line followed by one line per route, so the
 * block is the header's following route lines.
 */
function modelBlock(result: CommandResult, modelId: string): string[] {
  const lines = linesOf(result);
  const start = lines.findIndex((line) => line.startsWith(`  ${modelId} `));
  expect(start, `no model "${modelId}" is listed`).toBeGreaterThanOrEqual(0);

  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('    ')) break;
    block.push(line);
  }
  return block;
}

/** A catalog document with one model, in the target's own shape. */
function catalogDocument(firstPartyId: string, displayName: string): unknown {
  return {
    schema_version: 1,
    models: [
      {
        id: 'test-model',
        family: 'haiku',
        display_name: displayName,
        provider_ids: {
          first_party: firstPartyId,
          bedrock: null,
        },
        max_output_tokens: { default: 1024, upper: 1024 },
        capabilities: [],
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* The local server                                                             */
/* -------------------------------------------------------------------------- */

/** A request the local server received. */
interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
  headers: IncomingHttpHeaders;
}

/** The local server the default probe talks to. */
interface LocalServer {
  /** The server's base URL. */
  url: string;
  /** The requests the server received, in order. */
  received: ReceivedRequest[];
  /** Stop the server. */
  close(): Promise<void>;
}

/**
 * A local HTTP server the default probe can talk to.
 *
 * The server is the **witness** of the probe's wire shape: it records the
 * method, the path and the body, so the test can assert what the probe
 * actually asked.
 */
async function startLocalServer(
  respond: (request: ReceivedRequest) => number,
): Promise<LocalServer> {
  const received: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const record: ReceivedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        headers: req.headers,
      };
      received.push(record);
      const status = respond(record);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
        }),
      );
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* provider list                                                                */
/* -------------------------------------------------------------------------- */

describe('the provider manager command', () => {
  it('provider list prints one row per connection with its id, name, route, base URL, and credential status', async () => {
    const registry = createProviderRegistry([
      connection(),
      connection({
        id: 'staging',
        name: 'Staging',
        route: 'bedrock',
        credential: { kind: 'env', name: 'STAGING_TOKEN' },
        enabled: false,
      }),
    ]);

    const result = await providerCommand(['list'], registry, { env: { PROD_TOKEN: SECRET } });

    expect(result.exitCode).toBe(0);

    const prod = rowFor(result, 'prod');
    expect(prod).toContain('Production');
    expect(prod).toContain('firstParty');
    expect(prod).toContain('https://api.anthropic.com');
    expect(prod).toContain('env:PROD_TOKEN');
    expect(prod).toContain('resolved');

    const staging = rowFor(result, 'staging');
    expect(staging).toContain('Staging');
    expect(staging).toContain('bedrock');
    expect(staging).toContain('env:STAGING_TOKEN');
    expect(staging).toContain('unresolved');

    // One row per connection: exactly two rows carry a connection id.
    const rows = linesOf(result).filter((line) => line.includes('env:'));
    expect(rows).toHaveLength(2);
  });

  it('provider list shows no credential value even when the underlying environment variable is set', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await providerCommand(['list'], registry, { env: { PROD_TOKEN: SECRET } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    expect(JSON.stringify(result.data ?? null)).not.toContain(SECRET);
    // The **reference** is shown; the value is not.
    expect(result.stdout).toContain('env:PROD_TOKEN');
  });

  it('provider list shows no credential value for a file reference either, and never reads the file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prricode-provider-'));
    const file = path.join(directory, 'token');
    await writeFile(file, SECRET, 'utf8');

    const registry = createProviderRegistry([
      connection({ credential: { kind: 'file', path: file, format: 'bearer' } }),
    ]);

    const result = await providerCommand(['list'], registry, { env: {} });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).toContain(`file:${file}`);
    expect(rowFor(result, 'prod')).toContain('resolved');
    // The file is **never read**: a listing inspects the file's presence, not
    // its content. An implementation that read it and printed only the status
    // would fail this assertion.
    expect(fsReads).not.toContain(file);
  });

  it('reports a connection whose credential cannot be resolved as unusable, for that connection only', async () => {
    const registry = twoConnectionRegistry();

    const result = await providerCommand(['list'], registry, {
      env: { HEALTHY_TOKEN: SECRET },
    });

    // The listing itself succeeded: one broken connection does not fail it.
    expect(result.exitCode).toBe(0);

    const broken = rowFor(result, 'broken');
    expect(statusOf(broken)).toBe('unresolved');

    const healthy = rowFor(result, 'healthy');
    expect(statusOf(healthy)).toBe('resolved');
    expect(healthy).not.toContain(SECRET);
  });

  it('reports a credential path that exists but cannot be read as unreadable', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prricode-provider-'));
    // A directory is never a readable credential file, whoever the reader is.
    const asDirectory = path.join(directory, 'token');
    await mkdir(asDirectory);

    const registry = createProviderRegistry([
      connection({ credential: { kind: 'file', path: asDirectory, format: 'bearer' } }),
    ]);

    const result = await providerCommand(['list'], registry, { env: {} });

    expect(result.exitCode).toBe(0);
    expect(statusOf(rowFor(result, 'prod'))).toBe('unreadable');
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports a credential file with no read permission as unreadable',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'prricode-provider-'));
      const file = path.join(directory, 'token');
      await writeFile(file, SECRET, 'utf8');
      await chmod(file, 0o000);

      const registry = createProviderRegistry([
        connection({ credential: { kind: 'file', path: file, format: 'bearer' } }),
      ]);

      const result = await providerCommand(['list'], registry, { env: {} });

      expect(result.exitCode).toBe(0);
      expect(statusOf(rowFor(result, 'prod'))).toBe('unreadable');
    },
  );

  it('names the credential-store entry of an incomplete reference', async () => {
    // A keychain reference is judged by its own completeness, so an empty
    // account is a reference that names nothing. The wording must be the
    // keychain's own, not another kind's.
    const view = await credentialViewOf(
      connection({ credential: { kind: 'keychain', service: 'prricode', account: '' } }),
      {},
    );

    expect(view.status).toBe('unresolved');
    expect(view.usable).toBe(false);
    expect(view.reason).toContain('prricode');
  });

  it('the active-connection resolution refuses to select an unusable connection and names it in the error', async () => {
    const registry = twoConnectionRegistry();

    await expect(
      resolveActiveConnection(registry, { env: { HEALTHY_TOKEN: SECRET } }),
    ).rejects.toThrow(/broken/);
  });

  it('provider use refuses an unusable connection and names it in the error', async () => {
    const registry = twoConnectionRegistry();

    const result = await providerCommand(['use', 'broken'], registry, {
      env: { HEALTHY_TOKEN: SECRET },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('broken');
    // The switch did not happen.
    expect(registry.get('broken')?.enabled).toBe(true);
  });

  it('provider use switches to a usable connection', async () => {
    const registry = twoConnectionRegistry();

    const result = await providerCommand(['use', 'healthy'], registry, {
      env: { HEALTHY_TOKEN: SECRET },
    });

    expect(result.exitCode).toBe(0);
    expect(registry.get('healthy')?.enabled).toBe(true);
    expect(registry.get('broken')?.enabled).toBe(false);
  });

  it('provider add registers a connection whose credential is a reference, never a value', async () => {
    const registry = createProviderRegistry([]);

    const result = await providerCommand(
      [
        'add',
        'prod',
        '--name',
        'Production',
        '--route',
        'firstParty',
        '--credential-env',
        'PROD_TOKEN',
      ],
      registry,
      { env: { PROD_TOKEN: SECRET } },
    );

    expect(result.exitCode).toBe(0);
    const added = registry.get('prod');
    expect(added?.name).toBe('Production');
    expect(added?.route).toBe('firstParty');
    expect(added?.credential).toEqual({ kind: 'env', name: 'PROD_TOKEN' });
    expect(result.stdout).not.toContain(SECRET);
  });

  it('provider add refuses a raw credential value', async () => {
    const registry = createProviderRegistry([]);

    const result = await providerCommand(
      ['add', 'prod', '--credential', SECRET],
      registry,
      { env: {} },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/reference/i);
    expect(result.stderr).not.toContain(SECRET);
    expect(registry.get('prod')).toBeUndefined();
  });

  it('provider add refuses an id that would break the connection table', async () => {
    const registry = createProviderRegistry([]);

    // A newline splits one row across two lines.
    const newline = await providerCommand(
      ['add', 'x\ny', '--credential-env', 'PROD_TOKEN'],
      registry,
      { env: {} },
    );
    expect(newline.exitCode).toBe(2);
    expect(newline.stderr).toContain('x\\ny');
    expect(registry.get('x\ny')).toBeUndefined();

    // Two spaces break the column parsing.
    const spaces = await providerCommand(
      ['add', 'x  y', '--credential-env', 'PROD_TOKEN'],
      registry,
      { env: {} },
    );
    expect(spaces.exitCode).toBe(2);
    expect(spaces.stderr).toContain('x  y');
    expect(registry.get('x  y')).toBeUndefined();

    // A path is not an id.
    const path_ = await providerCommand(
      ['add', '../../etc/passwd', '--credential-env', 'PROD_TOKEN'],
      registry,
      { env: {} },
    );
    expect(path_.exitCode).toBe(2);
    expect(path_.stderr).toContain('../../etc/passwd');
    expect(registry.get('../../etc/passwd')).toBeUndefined();

    // A tab is a control character.
    const tab = await providerCommand(
      ['add', 'x\ty', '--credential-env', 'PROD_TOKEN'],
      registry,
      { env: {} },
    );
    expect(tab.exitCode).toBe(2);
    expect(tab.stderr).toContain('x\\ty');
  });

  it('provider add refuses a name that carries a whitespace', async () => {
    const registry = createProviderRegistry([]);

    const result = await providerCommand(
      ['add', 'prod', '--name', 'My Provider', '--credential-env', 'PROD_TOKEN'],
      registry,
      { env: {} },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('My Provider');
    expect(registry.get('prod')).toBeUndefined();
  });

  it('provider add --use leaves the registry untouched when the connection is unusable', async () => {
    const registry = createProviderRegistry([]);

    const result = await providerCommand(
      ['add', 'prod', '--credential-env', 'MISSING_TOKEN', '--use'],
      registry,
      { env: {} },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('prod');
    expect(registry.get('prod')).toBeUndefined();
  });

  it('provider remove removes a connection and reports an unknown id', async () => {
    const registry = createProviderRegistry([connection()]);

    const removed = await providerCommand(['remove', 'prod'], registry, { env: {} });
    expect(removed.exitCode).toBe(0);
    expect(registry.get('prod')).toBeUndefined();

    const missing = await providerCommand(['remove', 'prod'], registry, { env: {} });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('prod');
  });

  it('provider test resolves the credential through the guarded resolver and never prints the value', async () => {
    const registry = createProviderRegistry([connection()]);

    let seen: string | undefined;
    const result = await providerCommand(['test', 'prod'], registry, {
      env: { PROD_TOKEN: SECRET },
      probe: async (request) => {
        seen = request.credential;
        return { ok: true, status: 200, message: 'the endpoint answered HTTP 200' };
      },
    });

    expect(result.exitCode).toBe(0);
    // The probe really did receive the resolved credential...
    expect(seen).toBe(SECRET);
    // ...and the command never wrote it out.
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    expect(JSON.stringify(result.data ?? null)).not.toContain(SECRET);
  });

  it('provider test reports a connection whose credential cannot be resolved, without reading a value', async () => {
    const registry = createProviderRegistry([
      connection({ credential: { kind: 'env', name: 'MISSING_TOKEN' } }),
    ]);

    let probed = false;
    const result = await providerCommand(['test', 'prod'], registry, {
      env: {},
      probe: async () => {
        probed = true;
        return { ok: true, status: 200, message: 'ok' };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('prod');
    expect(result.stderr).toContain('unresolved');
    expect(probed).toBe(false);
  });

  it('never prints a credential value, even on the failure path', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await providerCommand(['test', 'prod'], registry, {
      env: { PROD_TOKEN: SECRET },
      probe: async (request) => {
        throw new Error(`the upstream said ${request.credential}`);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stderr).toContain('[redacted]');
  });

  it('never prints a truncated form of the credential', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await providerCommand(['test', 'prod'], registry, {
      env: { PROD_TOKEN: SECRET },
      probe: async (request) => {
        throw new Error(`the upstream said ${request.credential.slice(0, 12)}`);
      },
    });

    expect(result.exitCode).toBe(1);
    // The **prefix** of the secret is a leak too.
    expect(result.stderr).not.toContain(SECRET.slice(0, 12));
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stderr).toContain('[redacted]');
  });

  it('never prints a credential that carries regular-expression metacharacters', async () => {
    const tricky = 'sk-a.*+?[](){}|^$\\';
    const registry = createProviderRegistry([connection()]);

    const result = await providerCommand(['test', 'prod'], registry, {
      env: { PROD_TOKEN: tricky },
      probe: async (request) => {
        throw new Error(`the upstream said ${request.credential}`);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('[redacted]');
    expect(result.stderr).not.toContain(tricky);
    expect(result.stdout).not.toContain(tricky);
  });

  it('redacts the trimmed and the normalized forms of a secret', () => {
    const secret = ' sk-ant  Not-Print ';

    // The **trimmed** form: the secret without its padding.
    expect(redact('sk-ant  Not-Print was said', secret)).toContain('[redacted]');
    // The **normalized** form: its whitespace collapsed.
    expect(redact('sk-ant Not-Print was said', secret)).toContain('[redacted]');
    // The normalized form, case-folded.
    expect(redact('SK-ANT NOT-PRINT was said', secret)).toContain('[redacted]');
    // The whole secret, in every form, is gone.
    expect(redact('the upstream said ' + secret, secret)).not.toContain('Not-Print');
  });

  it('labels the provider manager as a project extension wherever it surfaces', async () => {
    const registry = createProviderRegistry([connection()]);

    const list = await providerCommand(['list'], registry, { env: {} });
    expect(list.stdout.toLowerCase()).toContain('extension');

    const help = await providerCommand(['--help'], registry);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toLowerCase()).toContain('extension');
    expect(help.stdout.toLowerCase()).toContain('not a the reference agent feature');
  });

  it('shows a keychain credential as configured without ever reading the OS credential store', async () => {
    let looked = false;
    setKeychainBackend({
      name: 'test-backend',
      async lookup() {
        looked = true;
        return { found: true, value: SECRET };
      },
    });

    try {
      const registry = createProviderRegistry([
        connection({ credential: { kind: 'keychain', service: 'prricode', account: 'prod' } }),
      ]);

      const result = await providerCommand(['list'], registry, { env: {} });

      expect(result.exitCode).toBe(0);
      // The store was never read: a listing must never raise an OS prompt.
      expect(looked).toBe(false);
      expect(result.stdout).toContain('keychain:prricode/prod');
      expect(statusOf(rowFor(result, 'prod'))).toBe('resolved');
      expect(result.stdout).not.toContain(SECRET);
    } finally {
      setKeychainBackend(null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The refused endpoint                                                          */
/* -------------------------------------------------------------------------- */

describe('the untrusted-endpoint refusal, as the manager reports it', () => {
  it('reports a refused endpoint as refused, names the host, and never resolves the credential', async () => {
    let looked = false;
    setKeychainBackend({
      name: 'test-backend',
      async lookup() {
        looked = true;
        return { found: true, value: SECRET };
      },
    });

    try {
      const registry = createProviderRegistry([
        connection({
          baseUrl: 'https://evil.example.com',
          credential: { kind: 'keychain', service: 'prricode', account: 'prod' },
        }),
      ]);

      const listed = await providerCommand(['list'], registry, { env: {} });
      expect(listed.exitCode).toBe(0);
      expect(statusOf(rowFor(listed, 'prod'))).toBe('refused');

      const document = JSON.parse(
        (await providerCommand(['list', '--json'], registry, { env: {} })).stdout,
      ) as { connections: Array<{ credential: { status: string; usable: boolean; reason: string } }> };
      const credential = document.connections[0]?.credential;
      expect(credential?.status).toBe('refused');
      expect(credential?.usable).toBe(false);
      // The refusal names the **host** — a fact about the endpoint, not about
      // the secret.
      expect(credential?.reason).toContain('evil.example.com');

      let probed = false;
      const tested = await providerCommand(['test', 'prod'], registry, {
        env: {},
        probe: async () => {
          probed = true;
          return { ok: true, status: 200, message: 'ok' };
        },
      });

      expect(tested.exitCode).toBe(1);
      expect(tested.stderr).toContain('evil.example.com');
      // The endpoint was refused, so nothing was resolved and nothing was
      // asked.
      expect(probed).toBe(false);
      expect(looked).toBe(false);
      expect(tested.stderr).not.toContain(SECRET);
    } finally {
      setKeychainBackend(null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The default probe                                                             */
/* -------------------------------------------------------------------------- */

describe('the default probe', () => {
  it('asks the endpoint the audit\'s own question, and a 2xx is a success', async () => {
    const server = await startLocalServer(() => 200);

    try {
      const registry = createProviderRegistry([
        connection({ baseUrl: server.url, allowUntrustedEndpoint: true }),
      ]);

      const result = await providerCommand(['test', 'prod'], registry, {
        env: { PROD_TOKEN: SECRET },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usable');

      const request = server.received[0];
      expect(request).toBeDefined();
      // The audit's shape (audit §2.2): a POST to /v1/messages.
      expect(request?.method).toBe('POST');
      expect(request?.url).toBe('/v1/messages');

      const body = JSON.parse(request?.body ?? '{}') as {
        max_tokens?: number;
        messages?: Array<{ role?: string; content?: string }>;
        model?: string;
      };
      expect(body.max_tokens).toBe(1);
      expect(body.messages).toEqual([{ role: 'user', content: 'test' }]);
      expect(typeof body.model).toBe('string');

      // The credential travels in the route's own auth header — and nowhere
      // else.
      expect(request?.headers['x-api-key']).toBe(SECRET);
      expect(request?.body).not.toContain(SECRET);
    } finally {
      await server.close();
    }
  });

  it('reports the endpoint\'s own status when the endpoint answers with an error', async () => {
    const server = await startLocalServer(() => 404);

    try {
      const registry = createProviderRegistry([
        connection({ baseUrl: server.url, allowUntrustedEndpoint: true }),
      ]);

      const result = await providerCommand(['test', 'prod'], registry, {
        env: { PROD_TOKEN: SECRET },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('the endpoint answered HTTP 404');
      expect(server.received[0]?.method).toBe('POST');
    } finally {
      await server.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The non-interactive form                                                     */
/* -------------------------------------------------------------------------- */

describe('the non-interactive form of the provider manager', () => {
  it('exposes the same operations as --provider style flags with machine-readable output', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await providerCommand(['--provider', 'list'], registry, {
      env: { PROD_TOKEN: SECRET },
    });

    expect(result.exitCode).toBe(0);

    const document = JSON.parse(result.stdout) as {
      type: string;
      connections: Array<{ id: string; route: string; credential: { status: string } }>;
    };
    expect(document.type).toBe('provider.connections');
    expect(document.connections).toHaveLength(1);
    expect(document.connections[0]?.id).toBe('prod');
    expect(document.connections[0]?.route).toBe('firstParty');
    expect(document.connections[0]?.credential.status).toBe('resolved');
    expect(result.stdout).not.toContain(SECRET);
  });

  it('exposes the switch operation as a non-interactive flag', async () => {
    const registry = twoConnectionRegistry();

    const result = await providerCommand(['--provider', 'use', 'healthy'], registry, {
      env: { HEALTHY_TOKEN: SECRET },
    });

    expect(result.exitCode).toBe(0);
    expect(registry.get('healthy')?.enabled).toBe(true);

    const document = JSON.parse(result.stdout) as { active?: { id?: string } };
    expect(document.active?.id).toBe('healthy');
  });

  it('reports an unknown option as a usage error', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await providerCommand(['--provider', 'list', '--nope'], registry, { env: {} });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--nope');
  });

  it('exposes the catalog browser as a non-interactive flag with machine-readable output', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await catalogCommand(['--catalog', 'list'], registry);

    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout) as {
      type: string;
      connection: { id: string; route: string };
      families: Array<{ family: string; models: Array<{ id: string; unavailableRoutes: string[] }> }>;
    };
    expect(document.type).toBe('catalog.models');
    expect(document.connection.id).toBe('prod');
    expect(document.connection.route).toBe('firstParty');
    expect(document.families.length).toBeGreaterThan(0);

    const haiku = document.families.find((family) => family.family === 'haiku');
    expect(haiku).toBeDefined();
    const model = haiku?.models.find((entry) => entry.id === 'claude-3-5-haiku');
    expect(model).toBeDefined();
    // "Not served" is a fact, never a guess: the route is named.
    expect(model?.unavailableRoutes).toContain('anthropicGoogleCloud');
  });

  it('carries the extension label in every machine-readable document', async () => {
    const registry = createProviderRegistry([connection()]);
    const options = {
      env: { PROD_TOKEN: SECRET },
      probe: async () => ({ ok: true, status: 200, message: 'the endpoint answered HTTP 200' }),
    };

    const documents = [
      await providerCommand(['--provider', 'list'], registry, options),
      await providerCommand(['--provider', 'add', 'second', '--credential-env', 'SECOND_TOKEN'], registry, options),
      await providerCommand(['--provider', 'remove', 'second'], registry, options),
      await providerCommand(['--provider', 'use', 'prod'], registry, options),
      await providerCommand(['--provider', 'test', 'prod'], registry, options),
      await catalogCommand(['--catalog', 'list'], registry, options),
      await catalogCommand(['--catalog', 'search', 'haiku'], registry, options),
      await catalogCommand(['--catalog', 'show', 'claude-haiku-4-5'], registry, options),
      await catalogCommand(['--catalog', 'refresh'], registry, options),
      await catalogCommand(
        ['--catalog', 'override', 'claude-haiku-4-5', '--display-name', 'Mine'],
        registry,
        options,
      ),
    ];

    expect(documents).toHaveLength(10);
    for (const result of documents) {
      const document = JSON.parse(result.stdout) as { extension?: unknown };
      expect(document.extension).toMatch(/project extension/i);
    }
  });

  it('dispatches the --provider and the --catalog forms through one entry point', async () => {
    const registry = createProviderRegistry([connection()]);

    const provider = await providerManagerCommand(['--provider', 'list'], registry, {
      env: { PROD_TOKEN: SECRET },
    });
    expect(provider.exitCode).toBe(0);
    expect((JSON.parse(provider.stdout) as { type: string }).type).toBe('provider.connections');

    const catalog = await providerManagerCommand(['--catalog', 'list'], registry);
    expect(catalog.exitCode).toBe(0);
    expect((JSON.parse(catalog.stdout) as { type: string }).type).toBe('catalog.models');

    // The dispatch itself.
    expect(managerCommandOf(['--provider', 'list'])).toBe('provider');
    expect(managerCommandOf(['--catalog', 'list'])).toBe('catalog');
    expect(managerCommandOf(['provider', 'list'])).toBe('provider');
    expect(managerCommandOf(['--print', 'hello'])).toBeUndefined();

    // The slash command's argument text.
    expect(managerArgumentsOf('add prod --name "My Provider"')).toEqual([
      'add',
      'prod',
      '--name',
      'My Provider',
    ]);
    expect(managerArgumentsOf('add "unterminated')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The catalog                                                                  */
/* -------------------------------------------------------------------------- */

describe('the catalog command', () => {
  it('catalog list groups the models by family and shows the per-route model ids', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await catalogCommand(['list'], registry);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('family haiku');
    expect(result.stdout).toContain('claude-haiku-4-5');
    // The per-route id of the first-party route.
    expect(result.stdout).toContain('claude-haiku-4-5-20251001');
  });

  it('shows a model the active route does not serve as unavailable for that route, rather than hiding it', async () => {
    const registry = createProviderRegistry([
      connection({ route: 'anthropicGoogleCloud' }),
    ]);

    const result = await catalogCommand(['list'], registry);

    expect(result.exitCode).toBe(0);
    // The model is present...
    expect(result.stdout).toContain('claude-3-5-haiku');
    // ...and the route that does not serve it says so.
    const block = modelBlock(result, 'claude-3-5-haiku');
    const row = block.find((line) => line.includes('anthropicGoogleCloud'));
    expect(row).toBeDefined();
    expect(row).toContain('unavailable');
    // The route that does serve it names the provider's own id.
    const served = block.find((line) => line.includes('firstParty'));
    expect(served).toContain('claude-3-5-haiku-20241022');
  });

  it('catalog search filters by id and by display name', async () => {
    const registry = createProviderRegistry([connection()]);

    const byId = await catalogCommand(['search', 'haiku-4-5'], registry);
    expect(byId.exitCode).toBe(0);
    expect(byId.stdout).toContain('claude-haiku-4-5');
    expect(byId.stdout).not.toContain('claude-sonnet-4-5');

    const byName = await catalogCommand(['search', 'Haiku 4.5'], registry);
    expect(byName.exitCode).toBe(0);
    expect(byName.stdout).toContain('claude-haiku-4-5');
    expect(byName.stdout).not.toContain('claude-sonnet-4-5');
  });

  it('catalog show describes one model and reports an unknown one', async () => {
    const registry = createProviderRegistry([connection()]);

    const shown = await catalogCommand(['show', 'claude-haiku-4-5'], registry);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain('claude-haiku-4-5');
    expect(shown.stdout).toContain('Haiku 4.5');

    const missing = await catalogCommand(['show', 'no-such-model'], registry);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no-such-model');
  });

  it('catalog search needs a query', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await catalogCommand(['search'], registry);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('query');
  });

  it('labels the catalog browser as a project extension', async () => {
    const registry = createProviderRegistry([connection()]);

    const result = await catalogCommand(['list'], registry);

    expect(result.stdout.toLowerCase()).toContain('extension');
  });

  it('never resolves a credential while browsing the catalog', async () => {
    let looked = false;
    setKeychainBackend({
      name: 'test-backend',
      async lookup() {
        looked = true;
        return { found: true, value: SECRET };
      },
    });

    try {
      const registry = createProviderRegistry([
        connection({ credential: { kind: 'keychain', service: 'prricode', account: 'prod' } }),
      ]);

      const result = await catalogCommand(['list'], registry, {
        env: { PROD_TOKEN: SECRET },
      });

      expect(looked).toBe(false);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      setKeychainBackend(null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The catalog refresh                                                          */
/* -------------------------------------------------------------------------- */

describe('the catalog refresh', () => {
  /** A file-backed catalog, its path, and a shared catalog store. */
  async function fileCatalog(): Promise<{
    file: string;
    catalogs: CatalogStore;
    sources: () => { kind: 'file'; path: string };
  }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'prricode-catalog-'));
    const file = path.join(directory, 'catalog.json');
    await writeFile(file, JSON.stringify(catalogDocument('first-party-v1', 'Test Model')), 'utf8');
    return {
      file,
      catalogs: createCatalogStore(),
      sources: () => ({ kind: 'file', path: file }),
    };
  }

  it('rewrites the catalog without changing a connection id, name, route, or credential reference', async () => {
    const { file, catalogs, sources } = await fileCatalog();
    const registry = createProviderRegistry([connection({ catalogSource: 'file' })]);
    const before = structuredClone(registry.get('prod'));

    const listed = await catalogCommand(['list'], registry, { catalogs, sources });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('first-party-v1');

    await writeFile(file, JSON.stringify(catalogDocument('first-party-v2', 'Test Model')), 'utf8');

    const refreshed = await catalogCommand(['refresh'], registry, { catalogs, sources });
    expect(refreshed.exitCode).toBe(0);

    const after = registry.get('prod');
    expect(after?.id).toBe(before?.id);
    expect(after?.name).toBe(before?.name);
    expect(after?.route).toBe(before?.route);
    expect(after?.credential).toEqual(before?.credential);
    expect(after?.catalogSource).toBe(before?.catalogSource);

    const record = catalogs.get('prod');
    expect(record?.catalog.models[0]?.providerIds.firstParty).toBe('first-party-v2');

    const listedAgain = await catalogCommand(['list'], registry, { catalogs, sources });
    expect(listedAgain.stdout).toContain('first-party-v2');
    expect(listedAgain.stdout).not.toContain('first-party-v1');
  });

  it('keeps a user override of a catalog-owned field across a refresh', async () => {
    const { file, catalogs, sources } = await fileCatalog();
    const registry = createProviderRegistry([connection({ catalogSource: 'file' })]);

    const overridden = await catalogCommand(
      ['override', 'test-model', '--display-name', 'My Own Name', '--provider-id', 'firstParty=my-own-id'],
      registry,
      { catalogs, sources },
    );
    expect(overridden.exitCode).toBe(0);

    await writeFile(file, JSON.stringify(catalogDocument('first-party-v2', 'Test Model v2')), 'utf8');
    const refreshed = await catalogCommand(['refresh'], registry, { catalogs, sources });
    expect(refreshed.exitCode).toBe(0);

    const listed = await catalogCommand(['list'], registry, { catalogs, sources });
    expect(listed.stdout).toContain('My Own Name');
    expect(listed.stdout).toContain('my-own-id');
    // The catalog's own values were rewritten underneath the override.
    expect(listed.stdout).not.toContain('first-party-v2');
  });

  it('keeps a user override across a refresh in a **later** invocation, because the state is persisted', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prricode-catalog-'));
    const statePath = path.join(directory, 'providers.json');
    const catalogFile = path.join(directory, 'catalog.json');
    await writeFile(
      catalogFile,
      JSON.stringify(catalogDocument('first-party-v1', 'Test Model')),
      'utf8',
    );
    const sources = () => ({ kind: 'file', path: catalogFile }) as const;

    // **Invocation one**: the connection is added, and the state is written.
    const first = createProviderRegistry([]);
    const added = await providerCommand(
      [
        'add',
        'prod',
        '--credential-env',
        'PROD_TOKEN',
        '--catalog-source',
        'file',
        '--use',
      ],
      first,
      { env: { PROD_TOKEN: SECRET }, statePath },
    );
    expect(added.exitCode).toBe(0);
    expect(first.get('prod')).toBeDefined();

    // **Invocation two**: a fresh registry, rebuilt from the persisted state,
    // and a fresh catalog table, read from the same state.
    const secondState = await readProviderStateFile(statePath);
    expect(secondState).toBeDefined();
    const second = registryFromState(secondState ?? { version: 1, connections: [], catalogs: [] });
    expect(second.get('prod')?.route).toBe('firstParty');

    const overridden = await catalogCommand(
      ['override', 'test-model', '--display-name', 'My Name'],
      second,
      { statePath, sources: () => sources() },
    );
    expect(overridden.exitCode).toBe(0);

    // **Invocation three**: the catalog is refreshed from its source. The
    // user's override must survive it — and survive the process.
    const thirdState = await readProviderStateFile(statePath);
    const third = registryFromState(thirdState ?? { version: 1, connections: [], catalogs: [] });
    await writeFile(
      catalogFile,
      JSON.stringify(catalogDocument('first-party-v2', 'Test Model v2')),
      'utf8',
    );
    const refreshed = await catalogCommand(['refresh'], third, {
      statePath,
      sources: () => sources(),
    });
    expect(refreshed.exitCode).toBe(0);

    // **Invocation four**: a completely fresh process's worth of state, and
    // the override is still there.
    const fourthState = await readProviderStateFile(statePath);
    const fourth = registryFromState(fourthState ?? { version: 1, connections: [], catalogs: [] });
    const shown = await catalogCommand(['show', 'test-model'], fourth, {
      statePath,
      sources: () => sources(),
    });
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain('My Name');
    // The catalog's own value was rewritten underneath the override.
    expect(shown.stdout).toContain('first-party-v2');
  });

  it('loads the manager\'s state — the connections and the catalogs — from the state file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prricode-catalog-'));
    const statePath = path.join(directory, 'providers.json');
    const catalogFile = path.join(directory, 'catalog.json');
    await writeFile(
      catalogFile,
      JSON.stringify(catalogDocument('first-party-v1', 'Test Model')),
      'utf8',
    );
    const sources = () => ({ kind: 'file', path: catalogFile }) as const;

    const first = createProviderRegistry([]);
    await providerCommand(
      ['add', 'prod', '--credential-env', 'PROD_TOKEN', '--catalog-source', 'file', '--use'],
      first,
      { env: { PROD_TOKEN: SECRET }, statePath },
    );
    await catalogCommand(['override', 'test-model', '--display-name', 'My Name'], first, {
      statePath,
      sources: () => sources(),
    });

    // A **fresh** load of the state: the connections, the active one, and the
    // catalog table with the user's override in it.
    const loaded = await loadManagerState(statePath);
    expect(loaded.registry.list()).toHaveLength(1);
    expect(loaded.registry.get('prod')?.enabled).toBe(true);
    expect(loaded.catalogs.get('prod')?.overrides.displayNames.get('test-model')).toBe('My Name');

    // And the loaded state is what the manager command runs against.
    const shown = await providerManagerCommand(['--catalog', 'show', 'test-model'], loaded.registry, {
      catalogs: loaded.catalogs,
      statePath,
      sources: () => sources(),
    });
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain('My Name');
  });
});

/* -------------------------------------------------------------------------- */
/* The picker                                                                   */
/* -------------------------------------------------------------------------- */

describe('the provider picker', () => {
  const entry: ProviderPickerEntry = {
    id: 'prod',
    name: 'Production',
    route: 'firstParty',
    baseUrl: 'https://api.anthropic.com',
    active: true,
    usable: true,
    credentialStatus: 'resolved',
    credentialReference: 'env:PROD_TOKEN',
  };

  it('lists the connections with their credential status and never a credential value', () => {
    const model = providerPickerModel([entry]);
    const rendered = providerPickerLines(model).join('\n');

    expect(rendered).toContain('prod');
    expect(rendered).toContain('Production');
    expect(rendered).toContain('firstParty');
    expect(rendered).toContain('env:PROD_TOKEN');
    expect(rendered).toContain('resolved');
    expect(rendered).not.toContain(SECRET);
    // The active connection is the selected one.
    expect(rendered).toContain(PROVIDER_PICKER_MARKER);
  });

  it('labels the picker as a project extension', () => {
    const rendered = providerPickerLines(providerPickerModel([entry])).join('\n');
    expect(rendered.toLowerCase()).toContain('extension');
  });

  it('says whether a connection can be used, so an unusable one is visible as such', () => {
    const model = providerPickerModel([
      entry,
      { ...entry, id: 'broken', active: false, usable: false, credentialStatus: 'unresolved' },
    ]);
    const lines = providerPickerLines(model);

    const usable = lines.find((line) => line.includes('prod'));
    const unusable = lines.find((line) => line.includes('broken'));
    expect(usable).toMatch(/\syes$/);
    expect(unusable).toMatch(/\sno$/);
    expect(unusable).toContain('unresolved');
  });

  it('turns the manager command\'s connection views into entries', () => {
    const entries = providerPickerEntries([
      {
        id: 'prod',
        name: 'Production',
        route: 'firstParty',
        baseUrl: 'https://api.anthropic.com',
        active: true,
        credential: { status: 'resolved', usable: true, reference: 'env:PROD_TOKEN' },
      },
      {
        id: 'broken',
        name: 'Broken',
        route: 'firstParty',
        baseUrl: 'https://evil.example.com',
        active: false,
        credential: { status: 'refused', usable: false, reference: 'keychain:prricode/prod' },
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.usable).toBe(true);
    expect(entries[1]?.usable).toBe(false);
    expect(entries[1]?.credentialStatus).toBe('refused');
    // The reference, never a value.
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });

  it('renders the picker as one block of text', () => {
    const model = providerPickerModel([entry]);
    expect(renderProviderPicker(model)).toBe(providerPickerLines(model).join('\n'));
    expect(renderProviderPicker(model)).toContain(PROVIDER_PICKER_MARKER);
  });

  it('moves the selection with wrap-around', () => {
    const second: ProviderPickerEntry = { ...entry, id: 'second', active: false };
    const model = providerPickerModel([entry, second]);
    expect(model.selectedIndex).toBe(0);

    const down = moveProviderPickerSelection(model, 1);
    expect(down.selectedIndex).toBe(1);

    // Past the end, back to the first.
    const wrapped = moveProviderPickerSelection(down, 1);
    expect(wrapped.selectedIndex).toBe(0);

    // Before the beginning, back to the last.
    const up = moveProviderPickerSelection(model, -1);
    expect(up.selectedIndex).toBe(1);
  });

  it('reports the selected entry', () => {
    const model = providerPickerModel([entry]);
    expect(selectedProviderPickerEntry(model)?.id).toBe('prod');
    expect(selectedProviderPickerEntry({ ...model, selectedIndex: 7 })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The table                                                                     */
/* -------------------------------------------------------------------------- */

describe('the connection table', () => {
  it('pads its columns by display width, so a wide character does not break them', async () => {
    const registry = createProviderRegistry([
      connection({ name: '生产', credential: { kind: 'env', name: 'PROD_TOKEN' } }),
    ]);

    const result = await providerCommand(['list'], registry, { env: { PROD_TOKEN: SECRET } });

    expect(result.exitCode).toBe(0);
    const header = linesOf(result).find((line) => line.startsWith('ID'));
    const row = linesOf(result).find((line) => line.startsWith('prod'));
    expect(header).toBeDefined();
    expect(row).toBeDefined();

    // The route column starts at the same **display** column in both lines.
    expect(displayColumnOf(row ?? '', 'firstParty')).toBe(displayColumnOf(header ?? '', 'ROUTE'));
  });
});

/* -------------------------------------------------------------------------- */
/* The one home                                                                  */
/* -------------------------------------------------------------------------- */

describe('the shared pieces of the manager commands', () => {
  /** The source of a module of the manager commands. */
  async function sourceOf(name: string): Promise<string> {
    return readFile(new URL(`../../src/cli/commands/${name}.ts`, import.meta.url), 'utf8');
  }

  it('gives the command result type exactly one home', async () => {
    const provider = await sourceOf('provider');
    const catalog = await sourceOf('catalog');
    const shared = await sourceOf('shared');
    const output = await readFile(new URL('../../src/cli/output.ts', import.meta.url), 'utf8');

    // The declaration lives in the CLI's own vocabulary module; the command
    // modules **re-export** it rather than declaring a second one.
    const declarations = [provider, catalog, shared, output].filter((source) =>
      /interface CommandResult\b/.test(source),
    );
    expect(declarations).toHaveLength(1);
    expect(output).toMatch(/interface CommandResult\b/);
    expect(shared).toMatch(/export type \{ CommandResult \}/);
  });

  it('gives the shared helpers exactly one home', async () => {
    const provider = await sourceOf('provider');
    const catalog = await sourceOf('catalog');

    for (const source of [provider, catalog]) {
      expect(source).not.toMatch(/function renderTable\(/);
      expect(source).not.toMatch(/function parseInvocation\(/);
      expect(source).not.toMatch(/function usageError\(/);
      expect(source).not.toMatch(/function failure\(/);
      expect(source).not.toMatch(/function errorMessageOf\(/);
      expect(source).not.toMatch(/function flagValue\(/);
      expect(source).not.toMatch(/function flagValues\(/);
    }
  });
});
