/**
 * The provider connection registry.
 *
 * **This is a project extension, not target behavior.** The target has **no**
 * user-managed registry of provider connections: its route selector yields
 * exactly one active route from environment flags, and the model catalog is
 * built in and provider-owned (audit §2.1, "Important negative finding"). The
 * registry below is this implementation's deliberate product extension, and it is labelled
 * as such everywhere it surfaces.
 *
 * The design follows the precedent the research report §2 collects (Kimi Code,
 * Roo Code, OpenCode, Goose, Hermes), which is **external product context**, not
 * evidence about the target:
 *
 *   1. A connection is keyed by a **free-form name**, not by a provider type, so
 *      several connections may exist for the same route.
 *   2. The model catalog is a **separate table** from the connection table, so a
 *      catalog refresh can never rewrite a connection's identity. (The catalog
 *      itself is `src/provider/catalog.ts`, owned by CC-005.)
 *   3. The **secret store and the config record are two different layers**: a
 *      connection holds a credential *reference*, and the catalog never touches
 *      it.
 *
 * A fourth rule is this implementation's own security posture and follows the audit's
 * endpoint policy: a base URL that does not match the provider's **own** vendor
 * host is a *user-supplied endpoint*, and this implementation refuses to send a credential
 * to it unless the connection explicitly opts in. The refusal names the host.
 *
 * Because the guard is only useful if a caller *runs* it, the module exposes
 * **one guarded entry point** for obtaining a credential for a request:
 * `resolveConnectionCredential` runs the check and only then resolves the
 * reference. `checkCredentialDelivery` and `assertCredentialDelivery` remain
 * exported for callers that want the decision itself.
 *
 * The resolution itself is **module-private**: this module exports no unguarded
 * resolver, so the exported surface of the provider module offers no way to
 * obtain a secret without the guard having run. `src/provider/credentials.ts`
 * therefore exports no resolver either — it holds the credential *references*,
 * their presence status, and the keychain backend.
 *
 * The credential *reference* kinds (an environment variable name, a file path,
 * an OS credential-store key) are a **implementation design** as well — see
 * `src/provider/credentials.ts` for the attribution.
 *
 * The target's route set, dispatch order and endpoint policy are **observed** and
 * live in `src/provider/routes.ts`.
 */

import { readFile } from 'node:fs/promises';

import {
  hostOfBaseUrl,
  isProviderRoute,
  readEnvValue,
  resolveBaseUrl,
  type ProviderRoute,
} from './routes.js';
import {
  credentialStatus,
  currentKeychainBackend,
  isCredentialRef,
  type CredentialRef,
  type ResolvedCredential,
} from './credentials.js';

export type { CredentialRef, ResolvedCredential } from './credentials.js';
export type { ProviderRoute } from './routes.js';

/**
 * A configured provider connection.
 *
 * **Project extension.** The target has no such record: it has exactly one active
 * route, selected by environment flags, and a built-in catalog.
 */
export interface Connection {
  /** Stable, user-chosen identifier. */
  id: string;
  /** Free-form display name. */
  name: string;
  /** The provider route this connection talks to. */
  route: ProviderRoute;
  /** An explicit base URL; when absent, the route's policy decides. */
  baseUrl?: string;
  /**
   * A credential **reference** — an environment variable name, a file path, or an
   * OS credential-store key. It never contains a secret.
   *
   * **Implementation design** (see `src/provider/credentials.ts`): the target records
   * only a per-route credential resolution order, not a reference abstraction.
   */
  credential: CredentialRef;
  /** Where the model catalog for this connection comes from. */
  catalogSource: 'builtin' | 'file' | 'url';
  /** Whether this connection is the active one. */
  enabled: boolean;
  /**
   * **Project extension.** Opt in to sending the credential to a base URL that is
   * not the provider's own vendor host. Without it, the untrusted-endpoint
   * guard refuses to deliver the credential and names the host.
   */
  allowUntrustedEndpoint?: boolean;
}

/**
 * The connection registry.
 *
 * The target has no registry at all; this is the extension. The interface is the
 * one the plan fixes, so the switch-to-a-connection operation is exposed as the
 * free function `useConnection` rather than as a method.
 */
export interface ProviderRegistry {
  list(): readonly Connection[];
  get(id: string): Connection | undefined;
  add(conn: Connection): void;
  remove(id: string): boolean;
  /** The single enabled connection; throws when zero or more than one is enabled. */
  active(): Connection | undefined;
}

/** The catalog sources a connection may declare. */
const CATALOG_SOURCES: readonly Connection['catalogSource'][] = ['builtin', 'file', 'url'];

/**
 * Reject a malformed connection before it enters the registry.
 *
 * The checks are own-property and type based, so a connection whose `route` is
 * the string `"constructor"` is rejected rather than resolving to an inherited
 * member. The route list itself is **not** duplicated here: `isProviderRoute`
 * is the single source of truth, so a route renamed in `src/provider/routes.ts`
 * cannot be silently rejected by the registry.
 *
 * A `baseUrl` that is empty or only whitespace is **accepted** but counts as
 * *absent*: the connection then uses the route's policy (see
 * `resolveConnectionEndpoint`).
 */
function validateConnection(conn: Connection): void {
  if (typeof conn !== 'object' || conn === null) {
    throw new Error('a provider connection must be an object');
  }
  if (typeof conn.id !== 'string' || conn.id.trim() === '') {
    throw new Error('a provider connection needs a non-empty id');
  }
  if (typeof conn.name !== 'string' || conn.name.trim() === '') {
    throw new Error(`connection "${conn.id}" needs a non-empty name`);
  }
  if (!isProviderRoute(conn.route)) {
    throw new Error(`connection "${conn.id}" has an unknown provider route "${String(conn.route)}"`);
  }
  if (!isCredentialRef(conn.credential)) {
    throw new Error(`connection "${conn.id}" needs a well-formed credential reference`);
  }
  if (typeof conn.catalogSource !== 'string' || !CATALOG_SOURCES.includes(conn.catalogSource)) {
    throw new Error(`connection "${conn.id}" has an unknown catalog source "${String(conn.catalogSource)}"`);
  }
  if (conn.baseUrl !== undefined && typeof conn.baseUrl !== 'string') {
    throw new Error(`connection "${conn.id}" has a non-string base URL`);
  }
  if (typeof conn.enabled !== 'boolean') {
    throw new Error(`connection "${conn.id}" has a non-boolean enabled flag`);
  }
}

/**
 * The in-memory registry.
 *
 * `list()` and `get()` return the **live** connection records, which is what
 * lets `useConnection` switch the active connection through the plan's fixed
 * interface.
 */
export class ConnectionRegistry implements ProviderRegistry {
  readonly #connections = new Map<string, Connection>();

  constructor(connections: readonly Connection[] = []) {
    for (const conn of connections) this.add(conn);
  }

  list(): readonly Connection[] {
    return [...this.#connections.values()];
  }

  get(id: string): Connection | undefined {
    return this.#connections.get(id);
  }

  add(conn: Connection): void {
    validateConnection(conn);
    if (this.#connections.has(conn.id)) {
      throw new Error(`a connection with id "${conn.id}" already exists`);
    }
    this.#connections.set(conn.id, conn);
  }

  remove(id: string): boolean {
    return this.#connections.delete(id);
  }

  /**
   * The single enabled connection.
   *
   * The declared return type includes `undefined` because the plan fixes it, but
   * this implementation never returns `undefined`: zero enabled connections and more than
   * one enabled connection are both errors, because the target always has
   * exactly one active route.
   */
  active(): Connection | undefined {
    const enabled = this.list().filter((conn) => conn.enabled);
    if (enabled.length === 0) {
      throw new Error('no enabled provider connection');
    }
    if (enabled.length > 1) {
      const ids = enabled.map((conn) => conn.id).join(', ');
      throw new Error(`multiple enabled provider connections: ${ids}`);
    }
    return enabled[0];
  }

  /**
   * Make one connection the active one. The plan's `ProviderRegistry` interface
   * has no such method, so `useConnection` is the public entry point; this is
   * the implementation behind it.
   */
  use(id: string): Connection {
    return useConnection(this, id);
  }
}

/** Create a registry, optionally seeded with connections. */
export function createProviderRegistry(connections: readonly Connection[] = []): ProviderRegistry {
  return new ConnectionRegistry(connections);
}

/**
 * Make one connection the active one.
 *
 * The plan's `ProviderRegistry` interface has no `use` member, so this free
 * function is the switch. It flips the `enabled` flag on the live records the
 * registry hands out, so a registry implementation must return its own records
 * from `list()` — which `ConnectionRegistry` does.
 *
 * The plan's interface does **not** require `list()` to hand out live records,
 * though, so the switch is **verified** rather than merely attempted: if the
 * registry does not report the target as the enabled connection afterwards, the
 * call fails loudly instead of leaving the caller believing it switched.
 */
export function useConnection(registry: ProviderRegistry, id: string): Connection {
  const target = registry.get(id);
  if (!target) {
    throw new Error(`no connection with id "${id}"`);
  }
  for (const conn of registry.list()) {
    conn.enabled = conn.id === id;
  }
  const active = registry.list().find((conn) => conn.enabled);
  if (!active || active.id !== id) {
    throw new Error(
      `could not switch to connection "${id}": the registry did not report it as the enabled connection`,
    );
  }
  return target;
}

/** The effective endpoint of a connection, and whether it is the vendor's own host. */
export interface EndpointTrust {
  baseUrl: string;
  host: string;
  isVendorHost: boolean;
  /**
   * Every base-URL **environment variable** of the route that was supplied, in
   * the order the route's policy lists them.
   *
   * **Additive** — the plan fixes the endpoint as `{ baseUrl, isVendorHost }`,
   * and that shape still works.
   */
  suppliedBaseUrlVariables?: string[];
  /**
   * The supplied base-URL variables that are in **conflict** under the target's
   * own rule (the target's Foundry adapter refuses a base URL and a resource
   * together, audit §2.2a).
   *
   * The conflict is carried through the registry so that the driver layer
   * (CC-006) can raise the target's error from either entry point.
   */
  conflictingVariables?: string[];
}

/**
 * The effective endpoint of a connection.
 *
 * An explicit `baseUrl` wins; otherwise the route's declared base-URL
 * environment variables decide; otherwise the route's default host applies. A
 * `baseUrl` that is empty or only whitespace counts as **absent**, so such a
 * connection falls back to the route's policy.
 *
 * The `host` carries the **port** when the base URL has a non-default one, so a
 * refusal names the exact endpoint it refused.
 */
export function resolveConnectionEndpoint(
  conn: Connection,
  env: NodeJS.ProcessEnv = process.env,
): EndpointTrust {
  const explicit = typeof conn.baseUrl === 'string' ? conn.baseUrl.trim() : '';
  const resolved = resolveBaseUrl(conn.route, env, explicit === '' ? undefined : explicit);
  return {
    baseUrl: resolved.baseUrl,
    host: hostOfBaseUrl(resolved.baseUrl),
    isVendorHost: resolved.isVendorHost,
    ...(resolved.suppliedBaseUrlVariables === undefined
      ? {}
      : { suppliedBaseUrlVariables: resolved.suppliedBaseUrlVariables }),
    ...(resolved.conflictingVariables === undefined
      ? {}
      : { conflictingVariables: resolved.conflictingVariables }),
  };
}

/** Whether a credential may be delivered to a connection's endpoint. */
export interface CredentialDeliveryDecision {
  allowed: boolean;
  host: string;
  /** Why the credential was refused. Absent when the delivery is allowed. */
  reason?: string;
}

/**
 * Decide whether a connection's credential may be sent to its endpoint.
 *
 * A base URL that matches the provider's **own** vendor host is a normal
 * deployment and the credential is delivered. A base URL that does not match is
 * a **user-supplied endpoint**: this implementation refuses to send the credential to it
 * unless the connection explicitly opted in, and the refusal names the host.
 *
 * **Limits of the guard** (both documented in `src/provider/routes.ts` and
 * pinned by tests):
 *
 *   - the two Google routes accept *any* host under `*.googleapis.com`, so the
 *     guard does **not** protect them;
 *   - a base URL that is not `https:` is never vendor-trusted, so a cleartext
 *     endpoint is treated as user-supplied.
 */
export function checkCredentialDelivery(
  conn: Connection,
  env: NodeJS.ProcessEnv = process.env,
): CredentialDeliveryDecision {
  const endpoint = resolveConnectionEndpoint(conn, env);
  if (endpoint.isVendorHost) {
    return { allowed: true, host: endpoint.host };
  }
  if (conn.allowUntrustedEndpoint === true) {
    return { allowed: true, host: endpoint.host };
  }
  return {
    allowed: false,
    host: endpoint.host,
    reason:
      `refusing to send the credential of connection "${conn.id}" to the user-supplied ` +
      `endpoint "${endpoint.host}": set allowUntrustedEndpoint on the connection to opt in`,
  };
}

/**
 * Throw unless the connection's credential may be delivered to its endpoint.
 *
 * This is the call the driver layer makes immediately before it hands a secret to
 * a provider client.
 */
export function assertCredentialDelivery(
  conn: Connection,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decision = checkCredentialDelivery(conn, env);
  if (!decision.allowed) {
    throw new Error(decision.reason ?? `refusing to send the credential of connection "${conn.id}"`);
  }
}

/**
 * Resolve a credential reference to a value.
 *
 * **Module-private on purpose.** This is this implementation's single resolution point:
 * the only path to a secret. It is deliberately **not** exported, so the
 * exported surface of the provider module offers no unguarded resolution that a
 * future caller — CC-006's driver layer, for instance — could reach by
 * accident and use to bypass the untrusted-endpoint guard. The guarded entry
 * point is `resolveConnectionCredential`, below.
 *
 * Every kind is **trimmed** the same way, so a value never carries surrounding
 * whitespace to the provider.
 */
async function resolveCredential(
  ref: CredentialRef,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCredential> {
  switch (ref.kind) {
    case 'env': {
      // The shared environment reader trims, so a trailing newline in the
      // variable is not part of the secret.
      const value = readEnvValue(env, ref.name);
      return value === undefined ? { present: false } : { present: true, value };
    }
    case 'file': {
      let content: string;
      try {
        content = await readFile(ref.path, 'utf8');
      } catch {
        return { present: false };
      }
      const value = content.trim();
      return value === '' ? { present: false } : { present: true, value };
    }
    case 'keychain': {
      // The status check judges the *reference*'s completeness and never
      // touches the keychain, so an incomplete reference short-circuits here.
      if ((await credentialStatus(ref, env)) !== 'configured') return { present: false };
      const result = await currentKeychainBackend().lookup(ref.service, ref.account);
      if (!result.found || typeof result.value !== 'string' || result.value === '') {
        return { present: false };
      }
      return { present: true, value: result.value };
    }
    default: {
      const unknown: never = ref;
      throw new Error(`unknown credential reference kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * The **guarded** way to obtain a credential for a request.
 *
 * This is the documented entry point for the driver layer (CC-006's
 * `ProviderDriver.buildHeaders(req, cred)`): it runs the untrusted-endpoint
 * check **first** and only then resolves the reference, so a secret can never be
 * handed to a user-supplied host by a caller that forgot to check.
 *
 * It is also the **only** exported path to a secret: the resolver itself is
 * module-private (see above), so no caller can obtain a credential without the
 * check having run.
 *
 * When the check refuses, the error names the host that was refused.
 */
export async function resolveConnectionCredential(
  conn: Connection,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCredential> {
  assertCredentialDelivery(conn, env);
  return resolveCredential(conn.credential, env);
}
