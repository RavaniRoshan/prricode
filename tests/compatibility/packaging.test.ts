/**
 * The packaging conformance: the self-contained executable, and the install
 * path it carries.
 *
 * Owning task: `CC-018` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is tested here
 *
 * The plan's two steps are two groups of assertions, and both of them need a
 * **real binary**:
 *
 *   - the built executable **starts**, **prints its version**, and **runs
 *     `--print` against a fake driver** — and the build emits a **single file**
 *     with **no runtime dependency on the host's Node**;
 *   - the installed binary **creates its configuration directory with
 *     restrictive permissions**, and the **first run reports the configuration
 *     directory it will use**.
 *
 * ## Why the build happens once
 *
 * `bun build --compile` is the expensive part: it bundles the tree and embeds
 * a runtime. The suite therefore builds **once**, in `beforeAll`, into a
 * temporary directory, and every assertion reuses that artifact. `afterAll`
 * removes the directory. A test that builds per case would take minutes; a
 * test that takes minutes is a test nobody runs.
 *
 * ## The fake driver
 *
 * The `--print` assertion must not touch the network, and this implementation's own
 * route policy gives the first-party route **no** base-URL environment
 * variable — so the packaged binary is pointed at a **loopback** fake provider
 * through its own documented test seam
 * (`CLAUDE_CODE_FAKE_PROVIDER_URL`, see `scripts/entry.ts`). The fake answers
 * with an Anthropic-shaped SSE stream, so the run exercises the **real**
 * driver, the **real** transport, the **real** SSE parser and the **real**
 * agent loop; only the endpoint is fake.
 *
 * The fake carries **no credential**: the CLI never resolves a secret by
 * itself, so the request the fake receives carries no `x-api-key` and no
 * `authorization` header. The assertion checks that too.
 *
 * ## The platform
 *
 * The binary is built for the **host** platform. What that means, and what was
 * *not* tested, is recorded in `docs/compatibility/packaging.md`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* The paths                                                                   */
/* -------------------------------------------------------------------------- */

/** The repository's root. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The build script the suite runs. */
const buildScript = path.join(repoRoot, 'scripts', 'build.ts');

/** The name the build gives the executable. */
const binaryName = 'agent';

/* -------------------------------------------------------------------------- */
/* The build                                                                   */
/* -------------------------------------------------------------------------- */

/** The temporary directory the build writes into. */
let workDir: string;

/** The directory the build writes the executable into. */
let outDir: string;

/** The executable the build produced. */
let binary: string;

/**
 * The build.
 *
 * It runs once, and it is the only `bun build --compile` the suite performs.
 */
beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'prricode-packaging-'));
  outDir = path.join(workDir, 'dist');

  const result = spawnSync('bun', ['run', buildScript, '--outdir', outDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 600_000,
  });

  if (result.status !== 0) {
    const reason = result.error === undefined ? `exit ${String(result.status)}` : result.error.message;
    throw new Error(
      `The build failed (${reason}).\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
    );
  }

  binary = path.join(outDir, binaryName);
}, 600_000);

/** Remove the build's output. */
afterAll(() => {
  if (workDir === undefined) return;
  rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** What a run of the executable produced. */
interface RunResult {
  /** The exit code, or `null` when the process was killed by a signal. */
  status: number | null;
  /** The standard output. */
  stdout: string;
  /** The standard error. */
  stderr: string;
}

/**
 * Run the executable.
 *
 * The run is **asynchronous** on purpose: a synchronous spawn would block this
 * process's event loop, and the fake provider — which lives in **this**
 * process — could then never answer the request the packaged binary makes.
 */
async function runBinary(
  args: readonly string[],
  options: { env?: Record<string, string | undefined>; cwd?: string; configDir?: string } = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        // This implementation's own configuration directory is never the user's: every
        // run in this suite names its own.
        CLAUDE_CONFIG_DIR: options.configDir ?? path.join(workDir, 'config'),
        // And neither is the user's home: a run that falls back to `~/.claude`
        // must not write into the real one.
        HOME: path.join(workDir, 'home'),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The packaged executable did not finish within 60 seconds: ${args.join(' ')}`));
    }, 60_000);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** The version the package declares. */
function packageVersion(): string {
  const raw = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('package.json is not an object.');
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('package.json carries no version.');
  return version;
}

/* -------------------------------------------------------------------------- */
/* The fake provider                                                           */
/* -------------------------------------------------------------------------- */

/** A fake provider: an Anthropic-shaped SSE stream on a loopback port. */
interface FakeProvider {
  /** The URL the packaged binary is pointed at. */
  url: string;
  /** The requests the fake received. */
  requests: { headers: Record<string, string | string[] | undefined>; body: string }[];
  /** Stop the fake. */
  close: () => Promise<void>;
}

/** Start the fake provider. */
async function startFakeProvider(text: string): Promise<FakeProvider> {
  const requests: FakeProvider['requests'] = [];

  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ headers: request.headers, body });

      const frame = (event: string, payload: unknown): string =>
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        frame('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_packaging_fake',
            model: 'packaging-fake',
            role: 'assistant',
            usage: { input_tokens: 7, output_tokens: 0 },
          },
        }),
      );
      response.write(
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }),
      );
      response.write(frame('message_stop', { type: 'message_stop' }));
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fake provider did not bind a port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* The packaging                                                               */
/* -------------------------------------------------------------------------- */

describe('the packaged executable', () => {
  it('is a single file that needs no runtime dependency on the host Node', () => {
    expect(existsSync(binary)).toBe(true);

    // **One file.** The build emits the executable and nothing else: a bundle
    // that left a `node_modules` tree or a second artifact beside it would not
    // be self-contained.
    const entries = readdirSync(outDir);
    expect(entries).toEqual([binaryName]);

    // A **native executable**, not a script: the ELF magic is the proof that
    // the host's Node is not what runs it.
    const header = readFileSync(binary).subarray(0, 4);
    expect([...header]).toEqual([0x7f, 0x45, 0x4c, 0x46]);

    // The bundle carries its runtime with it, so it is not a thin launcher.
    expect(statSync(binary).size).toBeGreaterThan(1_000_000);
  });

  it('starts and prints its version', async () => {
    // A configuration directory that already exists: the run is **not** a
    // first run, so the standard error stays empty and the version is the
    // only thing the run writes.
    const configDir = path.join(workDir, 'version', 'config');
    mkdirSync(configDir, { recursive: true });

    const result = await runBinary(['--version'], { configDir });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion());
  });

  it('starts with no Node on the PATH', async () => {
    // An empty PATH: a launcher that shelled out to `node` would fail here,
    // and so would a wrapper that needed a tool from the host's PATH.
    const emptyPath = path.join(workDir, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });

    const result = await runBinary(['--version'], {
      env: { PATH: emptyPath, NODE_PATH: undefined, NODE_OPTIONS: undefined },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion());
  });

  it('runs --print against a fake driver', async () => {
    const provider = await startFakeProvider('the packaged binary answered');
    try {
      const result = await runBinary(['--print', 'hello'], {
        env: { CLAUDE_CODE_FAKE_PROVIDER_URL: provider.url },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('the packaged binary answered');

      // The fake was reached, and the request carried **no credential**: the
      // CLI never resolves a secret by itself, and the packaged run resolved
      // none.
      expect(provider.requests.length).toBe(1);
      const headers = provider.requests[0]?.headers ?? {};
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['authorization']).toBeUndefined();

      // And the request was the **production** one: the real first-party
      // driver built an Anthropic-shaped body, so the run exercised the
      // driver, the transport, the SSE parser and the agent loop, and only
      // the endpoint was fake.
      const body = provider.requests[0]?.body ?? '';
      expect(body).toContain('"stream":true');
      expect(body).toContain('"model"');
      expect(body).toContain('"messages"');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    } finally {
      await provider.close();
    }
  });

  it('labels the multi-provider manager as a project extension in its --help', async () => {
    const result = await runBinary(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('multi-provider manager');
    expect(result.stdout).toContain('an extension, not part of the reference agent');
  });

  it('labels the multi-provider manager as a project extension where it surfaces', async () => {
    // The manager's own output carries the label too: the extension is
    // labelled **everywhere** it surfaces, not only in the help.
    const result = await runBinary(['--provider', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'The multi-provider manager is a project extension, not part of the reference agent.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The install path                                                            */
/* -------------------------------------------------------------------------- */

describe('the installed binary', () => {
  it('creates its configuration directory with restrictive permissions', async () => {
    const configDir = path.join(workDir, 'install', 'config');
    expect(existsSync(configDir)).toBe(false);

    const result = await runBinary(['--version'], {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    expect(result.status).toBe(0);
    expect(existsSync(configDir)).toBe(true);

    // The directory is **not world-readable**: the owner has it, and nobody
    // else does. The audit records `0o600` for the settings file the
    // configuration holds; the directory that holds it is tighter still,
    // because the directory is what decides who may read the files in it.
    const mode = statSync(configDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('reports the configuration directory it will use on the first run', async () => {
    const configDir = path.join(workDir, 'first-run', 'config');

    const first = await runBinary(['--version'], {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain(configDir);

    // The report is a **first-run** report: the directory exists now, so the
    // next run has nothing to report.
    const second = await runBinary(['--version'], {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain(configDir);
  });

  it('relocates the configuration directory with CLAUDE_CONFIG_DIR', async () => {
    const configDir = path.join(workDir, 'relocated', 'config');
    const home = path.join(workDir, 'relocated', 'home');

    const result = await runBinary(['--version'], {
      env: { CLAUDE_CONFIG_DIR: configDir, HOME: home },
    });

    expect(result.status).toBe(0);
    // The relocated directory is the one that was created…
    expect(existsSync(configDir)).toBe(true);
    // …and the default one was not.
    expect(existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('refuses a fake provider that is not a loopback endpoint', async () => {
    // The seam is loopback-only, so a value that names any other host is
    // refused — the seam can never become a way to send a request (and a
    // credential) somewhere it does not belong.
    const result = await runBinary(['--print', 'hello'], {
      env: { CLAUDE_CODE_FAKE_PROVIDER_URL: 'http://example.invalid' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must name a loopback endpoint');
    expect(result.stdout).toBe('');
  });
});
