/**
 * Provider credential **references**.
 *
 * The **project's** rule (plan §Global Constraints, "Credentials are references
 * only") is that a credential is a *reference* and never a value: the provider
 * catalog must not select or read secrets, and must not choose a destination for
 * them. This module keeps that separation in code:
 *
 *   - `credentialStatus` inspects **presence** only. It never returns a secret,
 *     and for a keychain reference it never touches the keychain at all, so a
 *     listing can never trigger an OS prompt.
 *   - `resolveCredential` is the **single** resolution point. Nothing else in the
 *     implementation calls it, and in particular no listing or catalog code path does.
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
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (each route resolves
 * credentials in a distinct order: bearer-token environment variable → skip-auth →
 * AWS credential chain → provider-chain resolver) and the plan's Global
 * Constraints ("Credentials are references only").
 */

import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
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
 *     the driver, not a transformation: `resolveCredential` returns the file's
 *     content either way;
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

/**
 * Resolve a credential reference to a value.
 *
 * This is the **single** resolution point in this implementation. Listing code and catalog
 * code must call `credentialStatus` instead, and a caller that reaches for this
 * function is about to hand a secret to a provider client — which is exactly the
 * point at which the untrusted-endpoint guard in `src/provider/registry.ts` has
 * to have run. `resolveConnectionCredential` in that module is the guarded
 * entry point that runs the check and then resolves.
 *
 * Every kind is **trimmed** the same way, so a value never carries surrounding
 * whitespace to the provider.
 */
export async function resolveCredential(
  ref: CredentialRef,
  env: NodeJS.ProcessEnv = process.env,
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
      if (keychainStatus(ref) !== 'configured') return { present: false };
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
