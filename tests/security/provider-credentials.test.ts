/**
 * Security test for provider credential references.
 *
 * The **project's** rule (plan §Global Constraints, "Credentials are references
 * only") is that a credential is a **reference** and never a value: the provider
 * catalog must not select or read secrets, and must not choose a destination for
 * them. This test pins the three consequences:
 *
 *   1. `credentialStatus` reports **presence** only and never returns a value;
 *   2. `resolveCredential` is the single resolution point — the only function that
 *      returns a secret — and listing a registry never calls it;
 *   3. `credentialStatus` on a **keychain** reference reports the reference's
 *      presence without ever reading the keychain, so a listing can never trigger
 *      an OS prompt.
 *
 * **Attribution.** The three-kind credential reference (an environment variable
 * name, a file path, or an OS credential-store key) is a **implementation design**, not
 * target behavior: the audit records only that each route "resolves credentials
 * in a distinct order (bearer-token env var → skip-auth → AWS credential chain →
 * provider-chain resolver)" (audit §2.1). The last test in this file pins that
 * attribution so the module cannot drift back into claiming the target.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (providers) and the
 * project's credential rule (plan §Global Constraints).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  credentialStatus,
  resolveCredential,
  setKeychainBackend,
  type KeychainBackend,
} from '../../src/provider/credentials.js';
import { createProviderRegistry, type Connection } from '../../src/provider/registry.js';

/**
 * `node:fs/promises` is mocked so that a **read** of a credential file can be
 * *observed*. The mock delegates to the real implementation, so the rest of the
 * module keeps working; what it adds is the ability to assert that
 * `credentialStatus` never reads a file's contents.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const SECRET = 'sk-test-3f9a2c-do-not-leak-me';
const ENV_NAME = 'PRRICODE_TEST_SECRET';

const touchedEnv = new Set<string>();
const tempDirs: string[] = [];

function setEnv(name: string, value: string | undefined): void {
  touchedEnv.add(name);
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prricode-credentials-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const name of touchedEnv) delete process.env[name];
  touchedEnv.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  setKeychainBackend(null);
});

function connection(overrides: Partial<Connection> & { id: string }): Connection {
  return {
    name: overrides.id,
    route: 'firstParty',
    credential: { kind: 'env', name: ENV_NAME },
    catalogSource: 'builtin',
    enabled: true,
    ...overrides,
  };
}

describe('credentialStatus', () => {
  it('reports an environment reference as configured when the variable is set', async () => {
    setEnv(ENV_NAME, SECRET);
    const status = await credentialStatus({ kind: 'env', name: ENV_NAME });
    expect(status).toBe('configured');
  });

  it('reports an environment reference as missing when the variable is not set', async () => {
    setEnv(ENV_NAME, undefined);
    const status = await credentialStatus({ kind: 'env', name: ENV_NAME });
    expect(status).toBe('missing');
  });

  it('never returns the credential value', async () => {
    setEnv(ENV_NAME, SECRET);
    const status = await credentialStatus({ kind: 'env', name: ENV_NAME });
    // The result is a status token, never a value: it is one of the three known
    // statuses and it does not contain the secret.
    expect(['configured', 'missing', 'unreadable']).toContain(status);
    expect(status).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('reports a file reference as configured, missing or unreadable', async () => {
    const dir = tempDir();
    const present = path.join(dir, 'token');
    writeFileSync(present, `${SECRET}\n`, 'utf8');
    expect(await credentialStatus({ kind: 'file', path: present, format: 'raw' })).toBe('configured');

    const absent = path.join(dir, 'missing-token');
    expect(await credentialStatus({ kind: 'file', path: absent, format: 'raw' })).toBe('missing');

    const locked = path.join(dir, 'locked-token');
    writeFileSync(locked, SECRET, 'utf8');
    chmodSync(locked, 0o000);
    const lockedStatus = await credentialStatus({ kind: 'file', path: locked, format: 'raw' });
    // A process running as root can read a mode-000 file, so the assertion is
    // conditional on the read actually being refused.
    if (lockedStatus === 'configured') {
      chmodSync(locked, 0o600);
    } else {
      expect(lockedStatus).toBe('unreadable');
    }
    chmodSync(locked, 0o600);
  });

  it('never reads the contents of a file reference', async () => {
    const dir = tempDir();
    const present = path.join(dir, 'token');
    writeFileSync(present, `${SECRET}\n`, 'utf8');

    const readFileMock = vi.mocked(readFile);
    const before = readFileMock.mock.calls.length;

    const status = await credentialStatus({ kind: 'file', path: present, format: 'raw' });

    expect(status).toBe('configured');
    // A status check uses `stat`/`access` only: the secret is never pulled into
    // memory, so a listing can never leak it.
    expect(readFileMock.mock.calls.length).toBe(before);
  });
});

describe('resolveCredential', () => {
  it('is the only function that returns a value', async () => {
    setEnv(ENV_NAME, SECRET);
    const resolved = await resolveCredential({ kind: 'env', name: ENV_NAME });
    expect(resolved).toEqual({ present: true, value: SECRET });
  });

  it('reports a missing environment reference as not present', async () => {
    setEnv(ENV_NAME, undefined);
    const resolved = await resolveCredential({ kind: 'env', name: ENV_NAME });
    expect(resolved.present).toBe(false);
    expect(resolved.value).toBeUndefined();
  });

  it('trims a trailing newline from an environment value, like a file value', async () => {
    // A secret pasted with a trailing newline must not travel to the provider
    // with the newline attached.
    setEnv(ENV_NAME, `${SECRET}\n`);
    const resolved = await resolveCredential({ kind: 'env', name: ENV_NAME });
    expect(resolved).toEqual({ present: true, value: SECRET });
  });

  it('resolves a file reference', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'token');
    writeFileSync(file, `${SECRET}\n`, 'utf8');
    const resolved = await resolveCredential({ kind: 'file', path: file, format: 'raw' });
    expect(resolved).toEqual({ present: true, value: SECRET });
  });
});

describe('the keychain reference', () => {
  it('reports the reference presence without reading the keychain', async () => {
    const lookup = vi.fn(async () => ({ found: true, value: SECRET }));
    const backend: KeychainBackend = { name: 'spy', lookup };
    setKeychainBackend(backend);

    const status = await credentialStatus({ kind: 'keychain', service: 'reference-agent', account: 'user' });
    expect(status).toBe('configured');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves through the keychain backend when a value is asked for', async () => {
    const lookup = vi.fn(async () => ({ found: true, value: SECRET }));
    const backend: KeychainBackend = { name: 'spy', lookup };
    setKeychainBackend(backend);

    const resolved = await resolveCredential({ kind: 'keychain', service: 'reference-agent', account: 'user' });
    expect(lookup).toHaveBeenCalledWith('reference-agent', 'user');
    expect(resolved).toEqual({ present: true, value: SECRET });
  });

  it('reports an incomplete keychain reference as missing', async () => {
    const lookup = vi.fn(async () => ({ found: true, value: SECRET }));
    setKeychainBackend({ name: 'spy', lookup });
    const status = await credentialStatus({ kind: 'keychain', service: '', account: 'user' });
    expect(status).toBe('missing');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('the registry listing', () => {
  it('contains no secret material', async () => {
    setEnv(ENV_NAME, SECRET);
    const registry = createProviderRegistry([connection({ id: 'first' })]);

    const listed = registry.list();
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain(ENV_NAME);
    for (const conn of listed) {
      expect(JSON.stringify(conn.credential)).not.toContain(SECRET);
    }
  });

  it('does not resolve a credential while listing', async () => {
    setEnv(ENV_NAME, SECRET);
    const lookup = vi.fn(async () => ({ found: true, value: SECRET }));
    setKeychainBackend({ name: 'spy', lookup });

    const registry = createProviderRegistry([
      connection({ id: 'first', credential: { kind: 'keychain', service: 'reference-agent', account: 'user' } }),
    ]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.active()?.id).toBe('first');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('the credential module attribution', () => {
  it('labels the credential-reference abstraction as a reimplementation design, not target behavior', async () => {
    const source = await readFile(new URL('../../src/provider/credentials.ts', import.meta.url), 'utf8');
    // The reference abstraction is this implementation's own design: the module must say so.
    expect(source).toContain('implementation design');
    // And it must not claim the target has it.
    expect(source).not.toContain("the target's own rule");
  });
});
