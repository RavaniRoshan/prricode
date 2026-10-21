/**
 * Provider credential **references**, and the **five authentication flows**
 * that produce them.
 *
 * The **project's** rule (plan §Global Constraints, "Credentials are references
 * only") is that a credential is a *reference* and never a value: the provider
 * catalog must not select or read secrets, and must not choose a destination for
 * them. This module keeps that separation in code:
 *
 *   - `credentialStatus` inspects **presence** only. It never returns a secret,
 *     and for a keychain reference it never touches the keychain at all, so a
 *     listing can never trigger an OS prompt.
 *   - This module resolves **nothing**. This implementation's single resolution point is
 *     `resolveConnectionCredential` in `src/provider/registry.ts`, and it is
 *     **module-private** there: the exported surface of the provider module
 *     offers no unguarded resolution that a future caller — CC-006's driver
 *     layer included — could reach by accident and bypass the
 *     untrusted-endpoint guard with. The one real call site of a resolution is
 *     that guarded entry point, and no listing or catalog code path resolves
 *     anything.
 *
 * ## What the target does, and what this implementation adds
 *
 * The target (audit §2.1) records exactly this about credentials: each route
 * "resolves credentials in a distinct order (bearer-token env var → skip-auth →
 * AWS credential chain → provider-chain resolver)". That is the whole of the
 * observed behavior — a **per-route credential resolution order**.
 *
 * The three-kind `CredentialRef` below — an environment variable name, a file
 * path, or an OS credential-store key — is a **implementation design**. The audit records
 * no reference abstraction, no file-path credential and no OS-credential-store
 * credential, and none of the three is attributed to the target. This implementation adds
 * them as a product extension and labels them as such here and wherever they
 * surface.
 *
 * The keychain backend shells out to the platform CLI. `keytar` was archived in
 * 2022, and a native binding is a hard conflict with the self-contained binary
 * this implementation ships, so the CLI layer is the only backend that is installed; the
 * `KeychainBackend` interface keeps the layered shape so a native backend can be
 * added later without changing a single call site.
 *
 * ## The five authentication flows (the second half of this module)
 *
 * Everything below the reference model is the **authentication surface**: the
 * five sign-in paths the target has — first-party, local, MCP, SEP-990 and
 * host/device/org — with their credential kinds, their storage, their state
 * machines, their discriminators and their validation.
 *
 * **This implementation has no account and no login.** There is no OAuth
 * client, no device flow, no OIDC provider and no token store here. What is
 * reproduced is the **shape**: the discriminators, the state machines, the
 * validation, the credential kinds and the storage. Every flow **refuses** when
 * it is invoked, and every refusal **names the capability it needed**. Nothing
 * here pretends to authenticate, and nothing here writes a credential.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (each route resolves
 * credentials in a distinct order: bearer-token environment variable → skip-auth →
 * AWS credential chain → provider-chain resolver) and the plan's Global
 * Constraints ("Credentials are references only"); and, for the flows, the pinned
 * build's own source — `chunk-1kkch1sj.js` (the first-party flow), `chunk-dvjkd4rv.js`
 * (the local endpoint table), `chunk-f2n7zke5.js` and `chunk-f8pz14g5.js` (the MCP
 * flow), `chunk-3kc8svea.js` (the SEP-990 flow) and `chunk-grnjpsdz.js` and
 * `chunk-c9s0jh80.js` (the host/device/org flow). The conformance table is
 * `docs/compatibility/provider-catalog.md`.
 */

import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

// The environment reader lives in `src/provider/routes.ts`: it is the provider
// module's single environment reader, so the route flags and the credential
// references cannot disagree about what counts as set or about trimming.
import { readEnvValue } from './routes.js';

/**
 * A credential **reference**. It names where a secret lives; it never contains
 * one.
 *
 * **Implementation design** — see the file header: the audit records only a per-route
 * credential resolution order, and neither this abstraction nor any of the three
 * kinds below is attributed to the target.
 *
 *   - `env` — the name of an environment variable;
 *   - `file` — the path of a file holding the secret. `format` records how the
 *     driver layer is expected to use it (`raw` for a bare secret, `bearer` for
 *     one that travels as an `Authorization: Bearer` token). It is metadata for
 *     the driver, not a transformation: the guarded resolver in
 *     `src/provider/registry.ts` returns the file's content either way;
 *   - `keychain` — an OS credential-store entry, named by service and account.
 */
export type CredentialRef =
  | { kind: 'env'; name: string }
  | { kind: 'file'; path: string; format: 'raw' | 'bearer' }
  | { kind: 'keychain'; service: string; account: string };

/** Whether a value is a well-formed credential reference. */
export function isCredentialRef(value: unknown): value is CredentialRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Partial<CredentialRef>;
  if (ref.kind === 'env') {
    return typeof ref.name === 'string' && ref.name.trim() !== '';
  }
  if (ref.kind === 'file') {
    return (
      typeof ref.path === 'string' &&
      ref.path.trim() !== '' &&
      (ref.format === 'raw' || ref.format === 'bearer')
    );
  }
  if (ref.kind === 'keychain') {
    return (
      typeof ref.service === 'string' &&
      ref.service.trim() !== '' &&
      typeof ref.account === 'string' &&
      ref.account.trim() !== ''
    );
  }
  return false;
}

/**
 * The status of a credential reference.
 *
 *   - `configured` — the reference names something that is present: the
 *     environment variable is set, the file exists and is readable, or the
 *     keychain reference is complete. For a keychain reference this reports the
 *     **reference's** presence, not the secret's;
 *   - `missing` — nothing is there;
 *   - `unreadable` — something is there but cannot be read.
 */
export type CredentialStatus = 'configured' | 'missing' | 'unreadable';

/** The result of resolving a credential reference. */
export interface ResolvedCredential {
  present: boolean;
  value?: string;
}

/** The status of an environment reference. */
function envStatus(env: NodeJS.ProcessEnv | undefined, name: string): CredentialStatus {
  return readEnvValue(env, name) === undefined ? 'missing' : 'configured';
}

/**
 * The status of a file reference.
 *
 * The file's **content** is never read: existence and readability are checked
 * with `stat` and `access`, so a status check never pulls a secret into memory.
 */
async function fileStatus(filePath: string): Promise<CredentialStatus> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return 'unreadable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    return 'unreadable';
  }
  return 'configured';
}

/** The status of a keychain reference — the **reference's** presence only. */
function keychainStatus(ref: { service: string; account: string }): CredentialStatus {
  const complete =
    typeof ref.service === 'string' &&
    ref.service.trim() !== '' &&
    typeof ref.account === 'string' &&
    ref.account.trim() !== '';
  return complete ? 'configured' : 'missing';
}

/**
 * Report whether a credential reference is present.
 *
 * This never returns a secret, and it never reads the OS credential store: a
 * keychain reference is judged by its own completeness, so a listing operation
 * can never trigger an OS prompt.
 */
export async function credentialStatus(
  ref: CredentialRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialStatus> {
  switch (ref.kind) {
    case 'env':
      return envStatus(env, ref.name);
    case 'file':
      return fileStatus(ref.path);
    case 'keychain':
      return keychainStatus(ref);
    default: {
      const unknown: never = ref;
      throw new Error(`unknown credential reference kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/** The result of a keychain lookup. */
export interface KeychainLookupResult {
  found: boolean;
  value?: string;
}

/**
 * A backend that can look a secret up in an OS credential store.
 *
 * The interface is the seam that keeps the *layered* backend shape the plan
 * calls for: a native backend can be registered without changing any call site.
 */
export interface KeychainBackend {
  readonly name: string;
  lookup(service: string, account: string): Promise<KeychainLookupResult>;
}

const execFileAsync = promisify(execFile);

/** How long a keychain CLI lookup may take before it is abandoned. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * The platform CLI commands that can look a secret up, in the order this implementation
 * tries them.
 *
 * macOS uses `security find-generic-password`; Linux uses `secret-tool` from
 * libsecret. Both are invoked **without a shell**, so a service or account name
 * can never be interpreted as a command.
 */
function keychainCommands(service: string, account: string): Array<{ file: string; args: string[] }> {
  switch (process.platform) {
    case 'darwin':
      return [
        {
          file: 'security',
          args: ['find-generic-password', '-w', '-s', service, '-a', account],
        },
      ];
    case 'linux':
      return [
        {
          file: 'secret-tool',
          args: ['lookup', 'service', service, 'account', account],
        },
      ];
    default:
      // No primary source was found for a credential-store path on this platform
      // (research report §8.2), so this implementation reports "not found" rather than
      // guessing at a layout.
      return [];
  }
}

/**
 * The default backend: the platform credential-store CLI.
 *
 * The native-module layer is not shipped — `keytar` was archived in 2022 and a
 * native binding conflicts with this implementation's self-contained binary — so this CLI
 * layer is the one that runs.
 */
export const cliKeychainBackend: KeychainBackend = {
  name: 'platform-cli',
  async lookup(service: string, account: string): Promise<KeychainLookupResult> {
    for (const command of keychainCommands(service, account)) {
      try {
        const { stdout } = await execFileAsync(command.file, command.args, {
          timeout: KEYCHAIN_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        });
        const value = typeof stdout === 'string' ? stdout.trim() : '';
        if (value !== '') return { found: true, value };
      } catch {
        // A missing CLI, a missing entry, or a refused access all mean the same
        // thing here: this backend cannot supply a value. The next candidate
        // (if any) gets a turn.
      }
    }
    return { found: false };
  },
};

let keychainBackend: KeychainBackend = cliKeychainBackend;

/**
 * Replace the keychain backend, or restore the default with `null`.
 *
 * This is the seam the security test uses to prove that `credentialStatus` never
 * reads the keychain. It is not a way to configure a secret store: a backend
 * only ever *looks up* a value that the reference already names.
 */
export function setKeychainBackend(backend: KeychainBackend | null): void {
  keychainBackend = backend ?? cliKeychainBackend;
}

/**
 * The keychain backend that is currently installed.
 *
 * The resolver reads the backend through this accessor, so the backend that is
 * installed at the moment of the lookup is the one that is used.
 */
export function currentKeychainBackend(): KeychainBackend {
  return keychainBackend;
}

// ---------------------------------------------------------------------------
// The five authentication flows
// ---------------------------------------------------------------------------

/**
 * The **five** authentication flows the target has.
 *
 * **REA observed.** The target's own command tree, its own modules and its own
 * endpoint tables carry five distinct sign-in paths, and they are not five
 * spellings of one path: they differ in who issues the credential, in what the
 * credential is, in where it is stored, and in what the flow needs in order to
 * run.
 *
 *   - `firstParty` — a sign-in against the first-party authorization endpoint
 *     (`https://claude.com/cai/oauth/authorize` and
 *     `https://platform.claude.com/oauth/authorize`), yielding an OAuth access
 *     token and a refresh token;
 *   - `local` — the same machine against the **local** endpoint table
 *     (`CLAUDE_LOCAL_OAUTH_API_BASE` and friends), which is a different
 *     client id, a different token endpoint and a different credential file
 *     suffix;
 *   - `mcp` — a per-server OAuth sign-in, driven by the server's own RFC 8414
 *     metadata, whose credential is stored under the server's own name;
 *   - `sep990` — the XAA (SEP-990) IdP OIDC sign-in, whose credential is an
 *     `id_token` from a third-party identity provider;
 *   - `hostDeviceOrg` — the credential the **host application** hands over, the
 *     **trusted device** enrollment, and the **organization** sign-in pin.
 *
 * Evidence: `chunk-1kkch1sj.js` (first party), `chunk-dvjkd4rv.js` (local),
 * `chunk-f2n7zke5.js` and `chunk-f8pz14g5.js` (MCP), `chunk-3kc8svea.js`
 * (SEP-990), `chunk-grnjpsdz.js` and `chunk-c9s0jh80.js` (host/device/org).
 */
export type AuthFlowKind = 'firstParty' | 'local' | 'mcp' | 'sep990' | 'hostDeviceOrg';

/** The five flows, in the order this implementation names them. */
export const AUTH_FLOW_KINDS: readonly AuthFlowKind[] = Object.freeze([
  'firstParty',
  'local',
  'mcp',
  'sep990',
  'hostDeviceOrg',
] as const);

/**
 * The credential kinds the five flows carry.
 *
 * **REA observed** — each kind is a record the target actually stores or a
 * variable it actually reads.
 */
export type AuthCredentialKind =
  /** An OAuth access token and its refresh token. */
  | 'oauth'
  /** An API key. */
  | 'apiKey'
  /** The `id_token` a SEP-990 identity provider issues. */
  | 'idToken'
  /** The client secret a SEP-990 identity provider expects. */
  | 'clientSecret'
  /** A credential the host application supplies through an environment variable. */
  | 'hostEnv'
  /** A trusted-device token. */
  | 'trustedDevice'
  /** A session-ingress token. */
  | 'sessionIngress'
  /** An MCP server's own OAuth token. */
  | 'mcpOAuth';

/** Where a credential of that kind lives. */
export type AuthCredentialStorage =
  /**
   * The target's **secure storage** — the keychain-backed store, whose
   * plaintext backend is the credential file.
   */
  | 'secureStorage'
  /** The target's credential file, `<configDir>/.credentials.json`. */
  | 'credentialsFile'
  /** The OS credential store. */
  | 'keychain'
  /** An environment variable. */
  | 'environment'
  /** A settings document. */
  | 'settings'
  /** A file of the credential's own. */
  | 'file';

/**
 * One credential kind, and where it lives.
 *
 * A descriptor names a credential; it never holds one. The `recordKey` is the
 * key the target writes into its secure storage, and the
 * `environmentVariable` is the variable the target reads the credential from.
 */
export interface AuthCredentialDescriptor {
  kind: AuthCredentialKind;
  storage: AuthCredentialStorage;
  /** The key the target writes into its secure storage, when it has one. */
  recordKey?: string;
  /** The environment variable the target reads the credential from, when it has one. */
  environmentVariable?: string;
  /** The file that backs the credential, when it has one. */
  fileName?: string;
}

/**
 * The credential kinds, with the target's own record keys and variable names.
 *
 * **REA observed.** The record keys come from the target's own secure storage:
 * `claudeAiOauth` for the OAuth record, `mcpXaaIdp` for the cached
 * `id_token`s, `mcpXaaIdpConfig` for the IdP client secrets, and
 * `trustedDeviceToken` for the device token.
 *
 * The trusted-device variable is `CLAUDE_TRUSTED_DEVICE_TOKEN` — **not**
 * `CLAUDE_CODE_TRUSTED_DEVICE_TOKEN`. The untouched-surface record has the
 * wrong name, and the name is load-bearing: it is the variable the target
 * reads, so an implementation that used the other spelling would never see the
 * token.
 */
export const AUTH_CREDENTIALS: readonly AuthCredentialDescriptor[] = Object.freeze([
  {
    kind: 'oauth',
    storage: 'secureStorage',
    recordKey: 'claudeAiOauth',
    environmentVariable: 'CLAUDE_CODE_OAUTH_TOKEN',
  },
  { kind: 'apiKey', storage: 'environment', environmentVariable: 'ANTHROPIC_API_KEY' },
  {
    kind: 'idToken',
    storage: 'secureStorage',
    recordKey: 'mcpXaaIdp',
  },
  {
    kind: 'clientSecret',
    storage: 'secureStorage',
    recordKey: 'mcpXaaIdpConfig',
    environmentVariable: 'MCP_XAA_IDP_CLIENT_SECRET',
  },
  {
    kind: 'hostEnv',
    storage: 'environment',
    environmentVariable: 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  },
  {
    kind: 'trustedDevice',
    storage: 'secureStorage',
    recordKey: 'trustedDeviceToken',
    environmentVariable: 'CLAUDE_TRUSTED_DEVICE_TOKEN',
  },
  {
    kind: 'sessionIngress',
    storage: 'file',
    environmentVariable: 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
    fileName: '.session_ingress_token',
  },
  {
    kind: 'mcpOAuth',
    storage: 'secureStorage',
    fileName: 'mcp-needs-auth-cache.json',
  },
] as const);

/**
 * One authentication flow, as the target has it.
 *
 * The `states` are the states of the target's own state machine for that flow.
 * The `requiredCapability` is what this implementation needs in order to run
 * the flow — and it needs none of them, so every flow refuses.
 */
export interface AuthFlowDescriptor {
  kind: AuthFlowKind;
  /** The names the target itself uses for the flow. */
  targetNames: readonly string[];
  /** The credential kinds the flow can produce. */
  credentialKinds: readonly AuthCredentialKind[];
  /** The states of the flow's state machine. */
  states: readonly string[];
  /** The capability this implementation needs in order to run the flow. */
  requiredCapability: string;
  /** The refusal the flow carries. */
  refusal: string;
}

/**
 * The states of the first-party sign-in machine.
 *
 * **REA observed** in `chunk-50adnhax.js`: the states the interactive `/login`
 * machine moves through.
 */
export const FIRST_PARTY_AUTH_STATES: readonly string[] = Object.freeze([
  'idle',
  'ready_to_start',
  'console_method',
  'platform_setup',
  'waiting_for_login',
  'polling',
  'about_to_retry',
  'success',
  'storage_failed',
  'error',
  'account_on_hold',
  'confirm_account',
] as const);

/** The states of the SEP-990 sign-in machine. */
export const SEP990_AUTH_STATES: readonly string[] = Object.freeze([
  'url_input',
  'connecting',
  'trust_prompt',
  'polling',
  'token_cached',
  'error',
] as const);

/** The states of the MCP sign-in machine. */
export const MCP_AUTH_STATES: readonly string[] = Object.freeze([
  'server_not_found',
  'server_pending_approval',
  'server_rejected',
  'server_config_error',
  'unsupported_transport',
  'anthropic_hosted',
  'claudeai_proxy',
  'no_login_required',
  'awaiting_redirect',
  'cancelled',
  'succeeded',
] as const);

/** The states of the host / device / org machine. */
export const HOST_DEVICE_ORG_AUTH_STATES: readonly string[] = Object.freeze([
  'host_managed',
  'device_enrollment_required',
  'device_enrollment_disabled',
  'org_pinned',
  'not_applicable',
] as const);

/**
 * The five flows, with their credential kinds and their states.
 *
 * The **first-party** and **local** flows share their states: they are the same
 * machine over two different endpoint tables, and the target switches between
 * the tables rather than between two machines.
 */
export const AUTH_FLOWS: Readonly<Record<AuthFlowKind, AuthFlowDescriptor>> = Object.freeze({
  firstParty: {
    kind: 'firstParty',
    targetNames: ['claude auth login', 'claude auth status', 'claude auth logout', 'setup-token'],
    credentialKinds: ['oauth', 'apiKey'],
    states: FIRST_PARTY_AUTH_STATES,
    requiredCapability: 'oauth-authorization-code',
    refusal:
      'the first-party sign-in needs the capability "oauth-authorization-code": an OAuth ' +
      'authorization-code exchange with a registered OAuth client and a browser to complete ' +
      'it. This build ships no OAuth client and no browser, so the sign-in cannot be performed.',
  },
  local: {
    kind: 'local',
    targetNames: [
      'local OAuth endpoint table',
      'CLAUDE_LOCAL_OAUTH_API_BASE',
      'CLAUDE_LOCAL_OAUTH_APPS_BASE',
      'CLAUDE_LOCAL_OAUTH_CONSOLE_BASE',
    ],
    credentialKinds: ['oauth', 'apiKey'],
    states: FIRST_PARTY_AUTH_STATES,
    requiredCapability: 'local-oauth-server',
    refusal:
      'the local sign-in needs the capability "local-oauth-server": a local OAuth server ' +
      '(CLAUDE_LOCAL_OAUTH_API_BASE, CLAUDE_LOCAL_OAUTH_APPS_BASE, CLAUDE_LOCAL_OAUTH_CONSOLE_BASE) ' +
      'and a client registered with it. This build ships neither, so the sign-in cannot be performed.',
  },
  mcp: {
    kind: 'mcp',
    targetNames: ['claude mcp login', 'claude mcp logout'],
    credentialKinds: ['mcpOAuth', 'oauth'],
    states: MCP_AUTH_STATES,
    requiredCapability: 'mcp-server-oauth-registration',
    refusal:
      'the MCP sign-in needs the capability "mcp-server-oauth-registration": the server\'s own ' +
      'OAuth registration (its RFC 8414 metadata) and a browser to complete the redirect. This ' +
      'build ships neither, so the sign-in cannot be performed.',
  },
  sep990: {
    kind: 'sep990',
    targetNames: ['claude mcp xaa setup', 'claude mcp xaa login', 'claude mcp xaa show', 'claude mcp xaa clear'],
    credentialKinds: ['idToken', 'clientSecret'],
    states: SEP990_AUTH_STATES,
    requiredCapability: 'oidc-identity-provider',
    refusal:
      'the SEP-990 sign-in needs the capability "oidc-identity-provider": an OIDC identity ' +
      'provider to discover and to issue an id_token. This build ships none, so the sign-in ' +
      'cannot be performed.',
  },
  hostDeviceOrg: {
    kind: 'hostDeviceOrg',
    targetNames: ['CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_TRUSTED_DEVICE_TOKEN', 'forceLoginMethod'],
    credentialKinds: ['hostEnv', 'trustedDevice', 'oauth'],
    states: HOST_DEVICE_ORG_AUTH_STATES,
    requiredCapability: 'host-application-or-enrolled-device',
    refusal:
      'the host sign-in needs the capability "host-application-or-enrolled-device": the host ' +
      'application that launched the agent to supply a credential, or a device enrolled with ' +
      'the organization. This build has neither, so the sign-in cannot be performed.',
  },
});

/**
 * The refusal a flow carries when it is invoked without the capability it needs.
 *
 * **This implementation has no account and no login.** There is no OAuth
 * client, no device flow, no OIDC provider and no token store here, so every
 * flow refuses — and every refusal names the capability it needed, so a reader
 * knows exactly what is missing rather than being told that "login failed".
 */
export interface AuthFlowRefusal {
  kind: AuthFlowKind;
  /** The capability the flow needed. */
  capability: string;
  /** The message the refusal carries. */
  message: string;
}

/**
 * Begin a flow — and refuse it.
 *
 * The function never performs a sign-in. It reports the refusal the flow
 * carries, which names the capability that is missing.
 */
export function beginAuthFlow(kind: AuthFlowKind): AuthFlowRefusal {
  // The lookup is **own-property** guarded: a caller-supplied name that
  // collides with an `Object.prototype` member (`constructor`, `toString`, …)
  // must be refused rather than resolving to the inherited member.
  if (!Object.hasOwn(AUTH_FLOWS, kind)) {
    throw new Error(`unknown authentication flow: ${JSON.stringify(kind)}`);
  }
  const flow = AUTH_FLOWS[kind];
  return { kind: flow.kind, capability: flow.requiredCapability, message: flow.refusal };
}

// ---------------------------------------------------------------------------
// The discriminators
// ---------------------------------------------------------------------------

/**
 * The login methods the target can be pinned to.
 *
 * **REA observed** — `forceLoginMethod` is an enum of exactly three names
 * (`chunk-c9s0jh80.js`): `"claudeai"` for the subscription, `"console"`
 * for Console billing, and `"gateway"` for the Cloud gateway device flow.
 */
export type LoginMethod = 'claudeai' | 'console' | 'gateway';

/** The three login methods. */
export const LOGIN_METHODS: readonly LoginMethod[] = Object.freeze([
  'claudeai',
  'console',
  'gateway',
] as const);

/** The input to the login-method discriminator. */
export interface LoginMethodInput {
  /**
   * The forced method the machine **resolves** to.
   *
   * The target reads it from a resolver that returns `"gateway"` when the host
   * application manages the machine, and otherwise returns the declared method
   * **except** `"gateway"`, which it suppresses. When this field is absent the
   * resolver is computed from `declared` and `hostManaged`.
   */
  forced?: LoginMethod | undefined;
  /** The forced method the managed settings **declare**. */
  declared?: LoginMethod | undefined;
  /** Whether the host application manages this machine. */
  hostManaged?: boolean | undefined;
  /** The `--console` flag. */
  console?: boolean | undefined;
  /** The `--claudeai` flag. */
  claudeai?: boolean | undefined;
}

/** What the login-method discriminator decided. */
export interface LoginMethodDecision {
  /** The method the sign-in uses. */
  method: LoginMethod;
  /** Whether a method was forced, rather than taken from the flags. */
  forced: boolean;
  /**
   * Whether the declared method and the chosen one **disagree**.
   *
   * The target computes this by comparing the sign-in's "this is the
   * subscription" flag against the declared method's own answer to the same
   * question, and it uses the answer to decide whether the organization pin
   * still applies.
   */
  contradicted: boolean;
}

/**
 * Resolve the forced login method.
 *
 * **REA observed** — the target's resolver returns `"gateway"` when the host
 * application manages the machine, and otherwise returns the declared method
 * **except** `"gateway"`, which it suppresses: a machine that is not
 * host-managed cannot sign in through a Cloud gateway.
 */
export function resolveForcedLoginMethod(
  declared?: LoginMethod | undefined,
  hostManaged = false,
): LoginMethod | undefined {
  if (hostManaged) return 'gateway';
  return declared === 'gateway' ? undefined : declared;
}

/**
 * Decide which login method a sign-in uses.
 *
 * The forced method wins over the flags; without one, `--console` selects the
 * Console method and everything else selects the subscription method.
 */
export function classifyLoginMethod(input: LoginMethodInput): LoginMethodDecision {
  const resolved =
    input.forced !== undefined
      ? input.forced
      : resolveForcedLoginMethod(input.declared, input.hostManaged === true);
  const chosen: LoginMethod = resolved ?? (input.console === true ? 'console' : 'claudeai');
  const loginWithClaudeAi = resolved !== undefined ? resolved === 'claudeai' : input.console !== true;
  const contradicted =
    input.declared !== undefined && loginWithClaudeAi !== (input.declared === 'claudeai');
  return { method: chosen, forced: resolved !== undefined, contradicted };
}

/** The kinds of MCP server the target's own classifier produces. */
export type McpServerAuthKind =
  /** A connector whose credentials live on the vendor's own site. */
  | 'claudeai-proxy'
  /** A server whose transport has no OAuth at all. */
  | 'unsupported-transport'
  /** A server the vendor hosts itself. */
  | 'anthropic-hosted'
  /** An ordinary remote server with its own OAuth. */
  | 'oauth';

/**
 * The hosts the target refuses local OAuth against.
 *
 * **REA observed** — `chunk-f8pz14g5.js` carries exactly three, and a feature
 * flag (`tengu_mcp_local_oauth_blocked_hosts`) may replace the list.
 */
export const MCP_BLOCKED_LOCAL_OAUTH_HOSTS: readonly string[] = Object.freeze([
  'microsoft365.mcp.claude.com',
  'gmail.mcp.claude.com',
  'gcal.mcp.claude.com',
] as const);

/** The shape of an MCP server record the classifiers read. */
export interface McpServerShape {
  /** The transport: `stdio`, `sse`, `http`, or `claudeai-proxy`. */
  type: string;
  /** The remote URL, for a remote server. */
  url?: string | undefined;
  /** The static headers, for a remote server. */
  headers?: Record<string, string> | undefined;
  /** The configuration scope the record came from. */
  scope?: string | undefined;
}

/** The result of the MCP server classifier. */
export interface McpServerAuthDecision {
  kind: McpServerAuthKind;
  /** The transport, for an unsupported one. */
  transport?: string;
  /** The refusal, for a vendor-hosted server. */
  message?: string;
}

/** Normalise a host the way the target's blocked-host set does. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * Classify an MCP server, the way the target's own classifier does.
 *
 * **REA observed** — `chunk-f8pz14g5.js`:
 *
 *   1. a `claudeai-proxy` server is a connector;
 *   2. a server whose transport is neither `sse` nor `http` has no OAuth at
 *      all, and the transport is reported with it;
 *   3. a server on one of the blocked hosts is hosted by the vendor;
 *   4. anything else is an ordinary OAuth server.
 */
export function classifyMcpServerAuth(
  name: string,
  server: McpServerShape,
): McpServerAuthDecision {
  if (server.type === 'claudeai-proxy') {
    return { kind: 'claudeai-proxy' };
  }
  if (server.type !== 'sse' && server.type !== 'http') {
    return { kind: 'unsupported-transport', transport: server.type ?? 'stdio' };
  }
  if (isBlockedMcpHost(server.url)) {
    return { kind: 'anthropic-hosted', message: anthropicHostedMessage(name, server.scope) };
  }
  return { kind: 'oauth' };
}

/** Whether a URL is on one of the blocked hosts. */
export function isBlockedMcpHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = normalizeHost(new URL(url).hostname);
    return MCP_BLOCKED_LOCAL_OAUTH_HOSTS.some((blocked) => normalizeHost(blocked) === host);
  } catch {
    return false;
  }
}

/**
 * The vendor-hosted server's refusal.
 *
 * The target appends a removal hint when the record's scope is one a user can
 * remove it from, and it caps the whole message at 1024 characters.
 */
export function anthropicHostedMessage(name: string, scope?: string): string {
  const base =
    `"${name}" is Anthropic-hosted and doesn't support local OAuth. ` +
    'Connect it via Settings → Connectors on claude.ai (requires `claude login`), ' +
    "then it'll be available here automatically.";
  const removable = scope === 'local' || scope === 'project' || scope === 'user';
  if (!removable) return base;
  const withHint = `${base} Remove the stale entry with: \`claude mcp remove ${name}\``;
  return [...withHint].length <= 1024 ? withHint : base;
}

/**
 * The sources of a credential an MCP server can use.
 *
 * **REA observed** — `chunk-f2n7zke5.js`. Each non-`none` value means there is
 * **no login to perform**: the server already has a credential.
 */
export type McpAuthSource =
  /** The configuration carries an `Authorization` header. */
  | 'static_auth_header'
  /** The first-party credential authenticates it. */
  | 'first_party_auth'
  /** The stored design credential authenticates it. */
  | 'first_party_design_auth'
  /** Nothing else supplies one. */
  | 'none';

/** The facts the MCP auth-source classifier reads. */
export interface McpAuthSourceInput {
  /** Whether the active route is the first-party one. */
  firstPartyRoute?: boolean | undefined;
  /** Whether a first-party access token exists. */
  hasFirstPartyToken?: boolean | undefined;
  /** Whether a stored design credential exists. */
  hasDesignCredential?: boolean | undefined;
}

/** The first-party host the target's own check admits. */
const FIRST_PARTY_MCP_HOST = 'api.anthropic.com';

/** The first-party paths the target's own check admits. */
const FIRST_PARTY_MCP_PATHS: readonly string[] = Object.freeze([
  '/v1/design/',
  '/v1/claude/test/',
  '/v1/pages/mcp',
] as const);

/** Whether a URL is one the first-party credential authenticates. */
export function isFirstPartyMcpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.host !== FIRST_PARTY_MCP_HOST) return false;
    return FIRST_PARTY_MCP_PATHS.some((prefix) =>
      prefix.endsWith('/') ? parsed.pathname.startsWith(prefix) : parsed.pathname === prefix,
    );
  } catch {
    return false;
  }
}

/** Whether a URL is a first-party **design** URL. */
export function isDesignMcpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return isFirstPartyMcpUrl(url) && parsed.pathname.startsWith('/v1/design/');
  } catch {
    return false;
  }
}

/**
 * Decide where an MCP server's credential comes from.
 *
 * **REA observed** — the target checks the static header first, then the
 * first-party credential, then the design credential.
 */
export function classifyMcpAuthSource(
  server: McpServerShape,
  input: McpAuthSourceInput = {},
): McpAuthSource {
  const headers = server.headers ?? {};
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    return 'static_auth_header';
  }
  if (input.firstPartyRoute === true && isFirstPartyMcpUrl(server.url)) {
    if (input.hasFirstPartyToken === true) return 'first_party_auth';
    if (isDesignMcpUrl(server.url) && input.hasDesignCredential === true) {
      return 'first_party_design_auth';
    }
  }
  return 'none';
}

/** The context the flow detector reads. */
export interface AuthFlowContext {
  /** The environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The login method the managed settings pin. */
  forceLoginMethod?: LoginMethod | undefined;
  /** The organization UUID the managed settings pin. */
  forceLoginOrgUUID?: string | readonly string[] | undefined;
  /** The SEP-990 IdP record, when one is configured. */
  xaaIdp?: { issuer: string; clientId: string; callbackPort?: number } | undefined;
  /** The MCP servers that could need a sign-in. */
  mcpServers?: readonly McpServerShape[] | undefined;
}

/**
 * Decide which of the five flows apply.
 *
 * The first-party flow always applies: it is the route every run falls back to.
 * The other four apply when the environment, the managed settings or the
 * configuration says so.
 *
 * The **local** flow is decided by the three `CLAUDE_LOCAL_OAUTH_*_BASE`
 * variables — the local endpoint table's own inputs. The two switches
 * `USE_LOCAL_OAUTH` and `USE_STAGING_OAUTH` are **not** part of the rule: in
 * the pinned build the environment-kind function returns the literal `"prod"`,
 * so those two names appear only in the settings `env` allow-lists and never
 * select the local table. Counting them would claim a behaviour the target
 * does not have.
 */
export function detectAuthFlows(context: AuthFlowContext = {}): AuthFlowKind[] {
  const env = context.env ?? {};
  const flows: AuthFlowKind[] = [];

  flows.push('firstParty');

  if (
    readEnvValue(env, 'CLAUDE_LOCAL_OAUTH_API_BASE') !== undefined ||
    readEnvValue(env, 'CLAUDE_LOCAL_OAUTH_APPS_BASE') !== undefined ||
    readEnvValue(env, 'CLAUDE_LOCAL_OAUTH_CONSOLE_BASE') !== undefined
  ) {
    flows.push('local');
  }

  if (context.mcpServers !== undefined && context.mcpServers.length > 0) {
    flows.push('mcp');
  }

  if (context.xaaIdp !== undefined) {
    flows.push('sep990');
  }

  if (
    readEnvValue(env, 'CLAUDE_CODE_HOST_AUTH_ENV_VAR') !== undefined ||
    readEnvValue(env, 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST') !== undefined ||
    readEnvValue(env, 'CLAUDE_TRUSTED_DEVICE_TOKEN') !== undefined ||
    context.forceLoginOrgUUID !== undefined ||
    context.forceLoginMethod === 'gateway'
  ) {
    flows.push('hostDeviceOrg');
  }

  return flows;
}

// ---------------------------------------------------------------------------
// The validation the target performs
// ---------------------------------------------------------------------------

/**
 * The endpoints `CLAUDE_CODE_CUSTOM_OAUTH_URL` may point at.
 *
 * **REA observed** — `chunk-dvjkd4rv.js` carries exactly three.
 */
export const APPROVED_CUSTOM_OAUTH_URLS: readonly string[] = Object.freeze([
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
] as const);

/** The loopback hosts a plain-`http` issuer is allowed on. */
const LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
] as const);

/**
 * Check a SEP-990 issuer.
 *
 * The target requires `https:` — except on loopback, where a local identity
 * provider runs without a certificate.
 */
export function validateXaaIssuer(issuer: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return `Error: --issuer must be a valid URL (got "${issuer}")`;
  }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname)) return undefined;
  return `Error: --issuer must use https:// (got "${parsed.protocol}//${parsed.host}")`;
}

/** Check a fixed loopback callback port. */
export function validateCallbackPort(port: unknown): string | undefined {
  if (port === undefined || port === null) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return 'Error: --callback-port must be an integer in [1, 65535]';
  }
  return undefined;
}

/**
 * Check the IdP client secret.
 *
 * The secret is read from the **environment**, never from the command line, so
 * asking for it without the variable set is an error.
 */
export function validateXaaClientSecret(
  requested: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!requested) return undefined;
  if (readEnvValue(env, 'MCP_XAA_IDP_CLIENT_SECRET') === undefined) {
    return 'Error: --client-secret requires MCP_XAA_IDP_CLIENT_SECRET env var';
  }
  return undefined;
}

/** Check that the XAA feature is enabled at all. */
export function validateXaaEnabled(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (readEnvValue(env, 'CLAUDE_CODE_ENABLE_XAA') === undefined) {
    return 'Error: --xaa requires CLAUDE_CODE_ENABLE_XAA=1 in your environment';
  }
  return undefined;
}

/** The input to the `--xaa` requirement check. */
export interface XaaServerRequirements {
  /** Whether `--xaa` was passed at all. */
  enabled: boolean;
  /** The `--client-id` value. */
  clientId?: string | undefined;
  /** Whether `--client-secret` was passed. */
  clientSecret?: boolean | undefined;
  /** Whether the SEP-990 IdP is configured. */
  idpConfigured?: boolean | undefined;
}

/**
 * Check what an `--xaa` server is still missing.
 *
 * The target lists the missing pieces in a fixed order and refuses with all of
 * them at once.
 */
export function validateXaaServerRequirements(
  input: XaaServerRequirements,
): string | undefined {
  if (!input.enabled) return undefined;
  const missing: string[] = [];
  if (!input.clientId) missing.push('--client-id');
  if (!input.clientSecret) missing.push('--client-secret');
  if (input.idpConfigured !== true) {
    missing.push("'claude mcp xaa setup' (settings.xaaIdp not configured)");
  }
  if (missing.length === 0) return undefined;
  return `Error: --xaa requires: ${missing.join(', ')}`;
}

/**
 * Check the mutually exclusive login flags.
 *
 * The target refuses `--console` together with `--claudeai` before anything
 * else happens.
 */
export function validateLoginFlags(input: {
  console?: boolean | undefined;
  claudeai?: boolean | undefined;
}): string | undefined {
  if (input.console === true && input.claudeai === true) {
    return 'Error: --console and --claudeai cannot be used together.';
  }
  return undefined;
}

/**
 * Check a custom OAuth endpoint.
 *
 * The target admits exactly three, and refuses anything else with the message
 * below.
 */
export function validateCustomOAuthUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.replace(/\/+$/, '');
  if (APPROVED_CUSTOM_OAUTH_URLS.includes(trimmed)) return undefined;
  return 'CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.';
}

/**
 * Check the scopes that must accompany a refresh token.
 *
 * A refresh token is useless without the scopes it was issued with, so the
 * target refuses to use one alone.
 */
export function validateRefreshTokenScopes(scopes: string | undefined): string | undefined {
  if (scopes !== undefined && scopes.trim() !== '') return undefined;
  return (
    'CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.\n' +
    'Set it to the space-separated scopes the refresh token was issued with\n' +
    '(e.g. "user:inference" or "user:profile user:inference user:sessions:claude_code user:mcp_servers").'
  );
}

/**
 * Check a sign-in that came back from the authorization server.
 *
 * The target refuses a sign-in that cannot be used, and refuses it for one of
 * three reasons, in this order: no inference access, no refresh token, or no
 * expiry to refresh on time.
 */
export function validateSignInScopes(
  scopes: readonly string[],
  hasRefreshToken: boolean,
  expiresAt: number | null | undefined,
): string | undefined {
  if (!scopes.includes('user:inference')) {
    return "The organization didn't grant inference access to this sign-in, so PRRICODE can't use it.";
  }
  if (!hasRefreshToken) {
    return 'The sign-in came back without a refresh token, so it would stop working within hours. Try again.';
  }
  if (expiresAt === null || expiresAt === undefined || !Number.isFinite(expiresAt)) {
    return "The sign-in came back without the token's expiry, so it can't be refreshed on time. Try again.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The first-party credential-kind discriminator
// ---------------------------------------------------------------------------

/**
 * The credential kinds the target's own `auth status` command reports.
 *
 * **REA observed** — `chunk-1kkch1sj.js` derives exactly these six, in a
 * fixed priority order.
 */
export type FirstPartyAuthMethod =
  /** Nothing is configured. */
  | 'none'
  /** The session is served by a third party. */
  | 'third_party'
  /** A sign-in against the subscription. */
  | 'claude.ai'
  /** A key the helper script produces. */
  | 'api_key_helper'
  /** An OAuth token that is not one of the two above. */
  | 'oauth_token'
  /** An API key. */
  | 'api_key';

/** The six credential kinds the first-party flow reports. */
export const FIRST_PARTY_AUTH_METHODS: readonly FirstPartyAuthMethod[] = Object.freeze([
  'none',
  'third_party',
  'claude.ai',
  'api_key_helper',
  'oauth_token',
  'api_key',
] as const);

/** The input to the first-party credential-kind discriminator. */
export interface FirstPartyAuthMethodInput {
  /**
   * Whether a stored token exists.
   *
   * This is the target's own `hasToken`, and it is **not** the same fact as
   * the token *source*: a source names where a token comes from, and this says
   * whether one is there.
   */
  hasToken?: boolean | undefined;
  /** Whether the session is served by a third party. */
  thirdParty?: boolean | undefined;
  /**
   * Whether the session uses a Cloud gateway and has no gateway login.
   *
   * The target treats that case as **not** third-party: the gateway is its own
   * thing.
   */
  gatewayWithoutLogin?: boolean | undefined;
  /** The token source — `claude.ai`, `apiKeyHelper`, `none`, or another name. */
  tokenSource?: string | undefined;
  /** The API-key source — `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, or `none`. */
  apiKeySource?: string | undefined;
  /**
   * Whether the environment holds an `ANTHROPIC_API_KEY` **and** the key helper
   * did not produce one.
   *
   * The target's own conjunction: an environment key that the helper also
   * produces is not counted twice.
   */
  environmentApiKey?: boolean | undefined;
  /** Whether the key helper is configured while the token source is `none`. */
  helperWithoutToken?: boolean | undefined;
}

/** What the first-party credential-kind discriminator decided. */
export interface FirstPartyAuthDecision {
  /** The credential kind. */
  authMethod: FirstPartyAuthMethod;
  /** Whether the session counts as signed in. */
  loggedIn: boolean;
}

/**
 * Decide which credential kind a session holds, and whether it counts as
 * signed in.
 *
 * **REA observed** — the target's own order:
 *
 *   1. a third-party session is `third_party`, and a gateway session with no
 *      gateway login is `none`;
 *   2. the token source decides: `claude.ai`, then `api_key_helper`, then
 *      `oauth_token` for any other source that is not `none`;
 *   3. the API-key source decides: `api_key` for `ANTHROPIC_API_KEY`, for an
 *      environment key, or for the `/login managed key` source, and
 *      `api_key_helper` when the helper is configured and there is no token.
 */
export function classifyFirstPartyAuth(
  input: FirstPartyAuthMethodInput,
): FirstPartyAuthDecision {
  const tokenSource = input.tokenSource ?? 'none';
  const apiKeySource = input.apiKeySource ?? 'none';
  const environmentApiKey = input.environmentApiKey === true;

  let authMethod: FirstPartyAuthMethod;
  if (input.thirdParty === true) {
    authMethod = input.gatewayWithoutLogin === true ? 'none' : 'third_party';
  } else if (tokenSource === 'claude.ai') {
    authMethod = 'claude.ai';
  } else if (tokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper';
  } else if (tokenSource !== 'none') {
    authMethod = 'oauth_token';
  } else if (
    apiKeySource === 'ANTHROPIC_API_KEY' ||
    environmentApiKey ||
    apiKeySource === '/login managed key'
  ) {
    authMethod = 'api_key';
  } else if (apiKeySource === 'apiKeyHelper' && input.helperWithoutToken === true) {
    authMethod = 'api_key_helper';
  } else {
    authMethod = 'none';
  }

  const loggedIn =
    input.gatewayWithoutLogin !== true &&
    (input.hasToken === true ||
      apiKeySource !== 'none' ||
      environmentApiKey ||
      input.thirdParty === true);

  return { authMethod, loggedIn };
}

/**
 * The shape of the target's `auth status` document.
 *
 * **REA observed** — `chunk-1kkch1sj.js` emits exactly these members, and the
 * optional ones only when they apply.
 */
export interface FirstPartyAuthStatus {
  loggedIn: boolean;
  authMethod: FirstPartyAuthMethod;
  apiProvider: string;
  analyticsDisabled: boolean;
  projectsDirectory: string | null;
  configDirectory: string;
  forcedLoginMethod?: LoginMethod;
  allowedProviders?: readonly string[];
  apiKeySource?: string | null;
  email?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
}

// ---------------------------------------------------------------------------
// The credential store
// ---------------------------------------------------------------------------

/**
 * The states a read of the target's credential file can report.
 *
 * **REA observed** — `chunk-mm3r1yz6.js`.
 */
export type CredentialStoreState =
  /** There is no credential file. */
  | 'absent'
  /** The file is there but could not be read; the state carries the code. */
  | 'read-failed'
  /** The file is not a credential file: too large, not JSON, or not a file. */
  | 'corrupt'
  /** The path is a symlink, and the target does not follow it. */
  | 'refused-symlink'
  /** The file was read. */
  | 'present';

/**
 * The shape of the target's credential store.
 *
 * **REA observed** — `chunk-mm3r1yz6.js`:
 *
 *   - the file is `<configuration root>/.credentials.json`;
 *   - it is written with mode `0600`;
 *   - it is opened with `O_NOFOLLOW`, so a symlink is **refused** rather than
 *     followed;
 *   - it is read with a **1 MiB** ceiling, and a larger file is `corrupt`.
 *
 * The file is the **plaintext backend** of the target's secure storage — the
 * same records the keychain backend holds, in a file instead of the OS
 * credential store.
 *
 * **This implementation ships no token store.** Nothing here writes a
 * credential: the descriptor records the *shape* the target uses, so a reader
 * of this implementation knows where a credential would live and how it would
 * be protected.
 */
export interface CredentialStoreDescriptor {
  /** The file name, under the configuration root. */
  fileName: string;
  /** The mode the target writes it with. */
  mode: number;
  /** The largest credential file the target reads. */
  maxBytes: number;
  /** The states a read can report. */
  states: readonly CredentialStoreState[];
  /** The record keys the target writes into it. */
  recordKeys: readonly string[];
  /** The suffixes of the single-credential files the target also reads. */
  fileSuffixes: readonly string[];
  /** The storage backends the target can use. */
  backends: readonly CredentialStorageBackend[];
  /** How a sign-in's credential landed. */
  sessionAuthValues: readonly SessionAuth[];
  /** The file that backs the MCP OAuth auth cache. */
  authCacheFileName: string;
}

/**
 * The credential **storage backends** the target can use.
 *
 * **REA observed** — `chunk-dt3pd9ft.js` carries exactly five, and the
 * telemetry maps any other name to `"other"`.
 */
export type CredentialStorageBackend =
  | 'keychain'
  | 'plaintext'
  | 'windows-credman'
  | 'keychain-with-plaintext-fallback'
  | 'windows-credman-with-plaintext-fallback';

/** The five storage backends. */
export const CREDENTIAL_STORAGE_BACKENDS: readonly CredentialStorageBackend[] = Object.freeze([
  'keychain',
  'plaintext',
  'windows-credman',
  'keychain-with-plaintext-fallback',
  'windows-credman-with-plaintext-fallback',
] as const);

/**
 * How a sign-in's credential landed.
 *
 * **REA observed** — the target reports exactly three:
 *
 *   - `fresh` — the credential was stored by this sign-in;
 *   - `previous` — the browser completed the sign-in but the new credential
 *     could not be stored, so the previous one is still in use;
 *   - `none` — there is no usable credential.
 */
export type SessionAuth = 'fresh' | 'previous' | 'none';

/** The three values. */
export const SESSION_AUTH_VALUES: readonly SessionAuth[] = Object.freeze([
  'fresh',
  'previous',
  'none',
] as const);

/** The target's credential store, as a shape. */
export const CREDENTIAL_STORE: CredentialStoreDescriptor = Object.freeze({
  fileName: '.credentials.json',
  mode: 0o600,
  maxBytes: 1_048_576,
  states: Object.freeze([
    'absent',
    'read-failed',
    'corrupt',
    'refused-symlink',
    'present',
  ] as const),
  recordKeys: Object.freeze([
    'claudeAiOauth',
    'mcpXaaIdp',
    'mcpXaaIdpConfig',
    'trustedDeviceToken',
  ] as const),
  fileSuffixes: Object.freeze([
    '.oauth_token',
    '.api_key',
    '.session_ingress_token',
  ] as const),
  backends: CREDENTIAL_STORAGE_BACKENDS,
  sessionAuthValues: SESSION_AUTH_VALUES,
  authCacheFileName: 'mcp-needs-auth-cache.json',
});

/**
 * The exit code the target's `auth status` command reports.
 *
 * **REA observed** — `chunk-1kkch1sj.js` exits `0` when the session is signed
 * in and `1` when it is not.
 */
export function authStatusExitCode(loggedIn: boolean): 0 | 1 {
  return loggedIn ? 0 : 1;
}

/**
 * The key an MCP server's OAuth token is stored under.
 *
 * **REA observed** — the target derives it from the server's name and a
 * fingerprint of the server's own configuration: the canonical JSON of
 * `{type, url, headers}` (headers defaulting to `{}`), a SHA-256 of it, and
 * the **first sixteen hex characters** of the digest. The key is
 * `<server name>|<fingerprint>`.
 *
 * The canonical JSON is a plain `JSON.stringify` in **insertion order**, so
 * `type` comes first, then `url`, then `headers`; an absent `url` is dropped
 * by the serialiser, exactly as it is in the target.
 */
export function mcpAuthCacheKey(
  serverName: string,
  config: { type: string; url?: string | undefined; headers?: Record<string, string> | undefined },
): string {
  const canonical = JSON.stringify({
    type: config.type,
    url: config.url,
    headers: config.headers || {},
  });
  const fingerprint = createHash('sha256').update(canonical).digest('hex').substring(0, 16);
  return `${serverName}|${fingerprint}`;
}

// ---------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an issuer the way the target keys its SEP-990 cache.
 *
 * **REA observed** — the target strips the trailing slashes from the path,
 * lower-cases the host and re-serialises; when the issuer does not parse, it
 * strips the trailing slashes from the raw text and leaves the rest alone.
 */
export function authIssuerKey(issuer: string): string {
  try {
    const url = new URL(issuer);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.host = url.host.toLowerCase();
    return url.toString();
  } catch {
    return issuer.replace(/\/+$/, '');
  }
}

/**
 * Read the expiry out of an `id_token`, in milliseconds.
 *
 * Returns `undefined` when the token carries no usable `exp` — the caller then
 * applies the fallback.
 */
export function idTokenExpiryMs(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
    );
    if (typeof payload !== 'object' || payload === null) return undefined;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The expiry to cache an `id_token` under.
 *
 * The target falls back to **one hour** when the token carries no `exp`.
 */
export function idTokenCacheExpiryMs(jwt: string, now: number = Date.now()): number {
  return idTokenExpiryMs(jwt) ?? now + 3_600_000;
}

/**
 * The margin the target keeps before it treats a cached `id_token` as expired.
 *
 * A token with less than a minute left is treated as absent.
 */
export const ID_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Whether a cached `id_token` is still usable.
 *
 * The target returns `undefined` for a token with less than the margin left,
 * so a near-expiry token is treated as absent.
 */
export function isCachedIdTokenUsable(
  entry: { expiresAt: number; idToken: string } | undefined,
  now: number = Date.now(),
): boolean {
  if (!entry) return false;
  if (entry.expiresAt - now <= ID_TOKEN_EXPIRY_MARGIN_MS) return false;
  return entry.idToken !== '';
}
