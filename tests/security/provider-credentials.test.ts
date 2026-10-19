/**
 * Security test for provider credential references.
 *
 * The project's rule is that a credential is a **reference** and never a value:
 * the provider catalog must not select or read secrets, and must not choose a
 * destination for them. This test pins the three consequences:
 *
 *   1. `credentialStatus` reports **presence** only and never returns a value;
 *   2. `resolveCredential` is the single resolution point — the only function that
 *      returns a secret — and listing a registry never calls it;
 *   3. `credentialStatus` on a **keychain** reference reports the reference's
 *      presence without ever reading the keychain, so a listing can never trigger
 *      an OS prompt.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (providers) and the
 * project's credential rule (plan §Global Constraints).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  credentialStatus,
  resolveCredential,
  setKeychainBackend,
  type KeychainBackend,
} from '../../src/provider/credentials.js';
import { createProviderRegistry, type Connection } from '../../src/provider/registry.js';

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
    expect(typeof status).toBe('string');
    expect(status).not.toContain(SECRET);
    expect(Object.values(status)).not.toContain(SECRET);
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
