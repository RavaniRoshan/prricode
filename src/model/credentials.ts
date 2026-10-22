/**
 * The credentials — a store keyed by *integration*, and connections that are
 * **derived** rather than stored.
 *
 * The store holds three kinds:
 *
 * | the kind | what it holds |
 * |---|---|
 * | `key` | a secret the agent holds |
 * | `oauth` | a grant the agent holds |
 * | `external` | **no secret at all** — a reference to a secret managed elsewhere |
 *
 * **The provider record has no secret field, ever.** A provider names an
 * *integration*, and the integration names the credential.
 *
 * The **connections** are derived:
 *
 * 1. the **stored** credentials for that integration, newest first;
 * 2. then the **environment variables** that are currently set, each a
 *    connection in its own right.
 *
 * The first is the active one, and the environment is a first-class peer of a
 * stored key — not a fallback, not a lesser kind.
 *
 * The **secret** lives in the operating system's credential store. Where that
 * store is not available, an **encrypted file** is used instead, and the
 * difference is reported: a caller can always ask *where* a secret came from.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §5.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CredentialReference } from './types.js';
import { defineOwn } from './merge.js';

/** The three kinds a credential may take. */
export type CredentialKind = 'key' | 'oauth' | 'external';

/** A grant the agent holds. */
export interface OAuthGrant {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

/** One stored credential. */
export interface StoredCredential {
  /** The credential's own id. */
  readonly id: string;
  /** The **integration** the credential belongs to — not a provider. */
  readonly integration: string;
  /** Which of the three kinds it is. */
  readonly kind: CredentialKind;
  /** The label the user gave it. */
  readonly label: string;
  /** When it was stored; the newest first. */
  readonly createdAt: number;
  /** The secret, for a `key`. */
  readonly secret?: string;
  /** The grant, for an `oauth`. */
  readonly grant?: OAuthGrant;
  /** The reference, for an `external` — and no secret at all. */
  readonly reference?: string;
}

/** An integration: the things a user may authenticate against. */
export interface Integration {
  readonly id: string;
  readonly name?: string;
  /** The environment variable names that are a connection for this integration. */
  readonly env: readonly string[];
}

/** The store of credentials, keyed by integration. */
export interface CredentialStore {
  /** The credentials of one integration, **newest first**. */
  list(integration: string): readonly StoredCredential[];
  /** Store a credential. */
  put(credential: StoredCredential): void;
  /** Remove a credential. */
  remove(id: string): boolean;
}

/** The in-memory store. */
export class MemoryCredentialStore implements CredentialStore {
  readonly #credentials = new Map<string, StoredCredential>();

  constructor(credentials: readonly StoredCredential[] = []) {
    for (const credential of credentials) this.put(credential);
  }

  list(integration: string): readonly StoredCredential[] {
    return [...this.#credentials.values()]
      .filter((credential) => credential.integration === integration)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  put(credential: StoredCredential): void {
    this.#credentials.set(credential.id, credential);
  }

  remove(id: string): boolean {
    return this.#credentials.delete(id);
  }
}

/** A way to reach an integration. */
export type Connection =
  | {
      readonly kind: 'credential';
      readonly id: string;
      readonly label: string;
      readonly credential: CredentialKind;
    }
  | { readonly kind: 'env'; readonly name: string };

/**
 * A connection's identity.
 *
 * It says which it is: a stored credential by its id, an environment variable
 * by its name. The identity is what stops a provider's discovered endpoints
 * from being mixed with a *different* account's credential.
 */
export function connectionIdentity(connection: Connection): string {
  return connection.kind === 'credential'
    ? `credential:${connection.id}`
    : `env:${connection.name}`;
}

/**
 * Derive an integration's connections.
 *
 * The stored credentials come first, newest first, and the environment
 * variables that are currently set come after. **The first is the active one.**
 */
export function deriveConnections(
  integration: Integration,
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): readonly Connection[] {
  const stored: Connection[] = store.list(integration.id).map((credential) => ({
    kind: 'credential',
    id: credential.id,
    label: credential.label,
    credential: credential.kind,
  }));
  const fromEnvironment: Connection[] = integration.env
    .filter((name) => {
      const value = env[name];
      return typeof value === 'string' && value !== '';
    })
    .map((name) => ({ kind: 'env', name }));
  return [...stored, ...fromEnvironment];
}

// ---------------------------------------------------------------------------
// The storage
// ---------------------------------------------------------------------------

/** Where a secret came from. */
export type SecretSource = 'keychain' | 'encrypted-file' | 'environment' | 'none';

/** A place a secret can live. */
export interface SecretStore {
  /** Where this store keeps its secrets. */
  readonly source: SecretSource;
  /** Read a secret. */
  read(id: string): Promise<string | undefined>;
  /** Write a secret. */
  write(id: string, secret: string): Promise<void>;
  /** Remove a secret. */
  remove(id: string): Promise<void>;
}

/** A backend that can look a secret up in an operating system's credential store. */
export interface KeychainBackend {
  /** The backend's own name, when it has one. */
  readonly name?: string;
  lookup(service: string, account: string): Promise<{ found: boolean; value?: string }>;
}

/** A store that reads from an operating system's credential store. */
export function createKeychainSecretStore(backend: KeychainBackend, service: string): SecretStore {
  return {
    source: 'keychain',
    async read(id: string): Promise<string | undefined> {
      const result = await backend.lookup(service, id);
      if (!result.found || typeof result.value !== 'string') return undefined;
      return result.value;
    },
    async write(): Promise<void> {
      throw new Error('the operating system credential store is read-only here');
    },
    async remove(): Promise<void> {
      throw new Error('the operating system credential store is read-only here');
    },
  };
}

/**
 * A store that keeps its secrets in an **encrypted file**.
 *
 * The file is encrypted with AES-256-GCM under a key derived from the
 * passphrase, so the secret is never readable as plain text on disk.
 */
export function createEncryptedFileSecretStore(file: string, passphrase: string): SecretStore {
  const key = scryptSync(passphrase, 'prricode-model-secret', 32);

  async function readAll(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const entries: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') defineOwn(entries, id, value);
    }
    return entries;
  }

  async function writeAll(entries: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }

  return {
    source: 'encrypted-file',
    async read(id: string): Promise<string | undefined> {
      const entries = await readAll();
      const stored = entries[id];
      if (stored === undefined) return undefined;
      const separator = stored.indexOf('.');
      if (separator <= 0) return undefined;
      const iv = Buffer.from(stored.slice(0, separator), 'base64');
      const payload = Buffer.from(stored.slice(separator + 1), 'base64');
      if (payload.length < 17) return undefined;
      const tag = payload.subarray(0, 16);
      const data = payload.subarray(16);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    },
    async write(id: string, secret: string): Promise<void> {
      const entries = await readAll();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const payload = Buffer.concat([cipher.getAuthTag(), data]);
      entries[id] = `${iv.toString('base64')}.${payload.toString('base64')}`;
      await writeAll(entries);
    },
    async remove(id: string): Promise<void> {
      const entries = await readAll();
      delete entries[id];
      await writeAll(entries);
    },
  };
}

/**
 * The store to use.
 *
 * The operating system's credential store is the medium of choice; where it is
 * not available, the **encrypted file** is used instead, and the difference is
 * reported by the store's own `source`.
 */
export function createSecretStore(options: {
  readonly keychain?: KeychainBackend;
  /** The service name the credential store keeps the secrets under. */
  readonly service?: string;
  readonly file?: string;
  readonly passphrase?: string;
}): SecretStore {
  if (options.keychain) {
    return createKeychainSecretStore(options.keychain, options.service ?? 'model');
  }
  if (options.file && options.passphrase !== undefined) {
    return createEncryptedFileSecretStore(options.file, options.passphrase);
  }
  return {
    source: 'none',
    async read(): Promise<string | undefined> {
      return undefined;
    },
    async write(): Promise<void> {
      throw new Error('no secret store is available on this host');
    },
    async remove(): Promise<void> {
      throw new Error('no secret store is available on this host');
    },
  };
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

/** The outcome of resolving a provider's credential. */
export type CredentialResolution =
  | {
      readonly ok: true;
      readonly connection: Connection;
      readonly secret: string;
      readonly source: SecretSource;
    }
  | { readonly ok: true; readonly connection: undefined; readonly secret: undefined; readonly source: 'none' }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a provider's credential reference to a secret.
 *
 * The resolution **never** invents a secret, and never falls back silently: it
 * either produces one, or it refuses with the reason.
 */
export async function resolveProviderCredential(
  reference: CredentialReference,
  integration: Integration,
  store: CredentialStore,
  secretStore: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialResolution> {
  if (reference.kind === 'none') {
    // A provider that names no integration has no credential at all: it is
    // available, and the request carries no secret.
    return { ok: true, connection: undefined, secret: undefined, source: 'none' };
  }
  if (reference.integration !== integration.id) {
    return {
      ok: false,
      reason:
        `the provider names the integration "${reference.integration}", ` +
        `but "${integration.id}" was supplied`,
    };
  }

  const connections = deriveConnections(integration, store, env);
  const active = connections[0];
  if (!active) {
    return {
      ok: false,
      reason: `the integration "${integration.id}" has no connection`,
    };
  }

  if (active.kind === 'env') {
    const value = env[active.name];
    if (typeof value !== 'string' || value === '') {
      return {
        ok: false,
        reason: `the environment variable "${active.name}" is not set`,
      };
    }
    return { ok: true, connection: active, secret: value, source: 'environment' };
  }

  const credential = store.list(integration.id).find((entry) => entry.id === active.id);
  if (!credential) {
    return { ok: false, reason: `the credential "${active.id}" is no longer in the store` };
  }

  if (credential.kind === 'external') {
    const reference = credential.reference ?? '';
    return {
      ok: false,
      reason:
        `the credential "${credential.id}" is the external reference "${reference}", ` +
        `whose secret is managed somewhere else and is not held here`,
    };
  }

  if (credential.kind === 'oauth') {
    const raw = await secretStore.read(credential.id);
    if (raw === undefined) {
      return {
        ok: false,
        reason: `the grant of the credential "${credential.id}" could not be read from the ${secretStore.source}`,
      };
    }
    let accessToken: string | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>)['accessToken'];
        if (typeof value === 'string') accessToken = value;
      }
    } catch {
      accessToken = undefined;
    }
    if (accessToken === undefined) {
      return {
        ok: false,
        reason: `the grant of the credential "${credential.id}" carries no access token`,
      };
    }
    return { ok: true, connection: active, secret: accessToken, source: secretStore.source };
  }

  const secret = await secretStore.read(credential.id);
  if (secret === undefined || secret === '') {
    return {
      ok: false,
      reason: `the secret of the credential "${credential.id}" could not be read from the ${secretStore.source}`,
    };
  }
  return { ok: true, connection: active, secret, source: secretStore.source };
}
