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
 *     credential back does not get it into the output;
 *   - a connection whose credential cannot be resolved is reported as unusable
 *     **for that connection only** — the other connections are unaffected —
 *     and the active-connection resolution refuses to select it and **names it**
 *     in the error;
 *   - `catalog list` groups the models by family and shows the **per-route**
 *     model ids; a model the active route does not serve is shown as
 *     **unavailable for that route** rather than hidden;
 *   - `catalog search` filters by id **and** by display name;
 *   - a catalog **refresh** rewrites the catalog's own metadata and never the
 *     connection's id, name, route or credential reference; a **user override**
 *     of a catalog-owned field survives the refresh;
 *   - the same operations are available as `--provider list`-style
 *     non-interactive flags, with machine-readable output;
 *   - the extension is labelled wherever it surfaces.
 *
 * The credential is a **reference** throughout: an environment variable name, a
 * file path, or an OS credential-store key. The test never puts a secret into a
 * fixture as a value — the value only ever appears in the *environment* the
 * command is handed, and the assertion is that it never comes back out.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createProviderRegistry,
  type Connection,
  type ProviderRegistry,
} from '../../src/provider/registry.js';
import { setKeychainBackend } from '../../src/provider/credentials.js';
import {
  providerCommand,
  resolveActiveConnection,
  type CommandResult,
} from '../../src/cli/commands/provider.js';
import {
  catalogCommand,
  createCatalogStore,
  type CatalogStore,
} from '../../src/cli/commands/catalog.js';
import {
  providerPickerLines,
  providerPickerModel,
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

  it('provider list shows no credential value for a file reference either', async () => {
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

  it('catalog show describes one model and reports an unknown one', async () => {    const registry = createProviderRegistry([connection()]);

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
});
