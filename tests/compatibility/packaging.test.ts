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
 * The one exception is the **build script**'s own test: it needs **two**
 * builds — one into an empty directory and a second into the same directory
 * under another name — because that pair is what proves the documented usage
 * works. Two builds cost about a second.
 *
 * ## The fake driver
 *
 * The `--print` assertion must not touch the network, and this implementation's own
 * route policy gives the first-party route **no** base-URL environment
 * variable — so the packaged binary is pointed at a **loopback** fake provider
 * through its own documented test seam (the `--fake-provider` option, see
 * `scripts/entry.ts`). The fake answers with an Anthropic-shaped SSE stream, so
 * the run exercises the **real** driver, the **real** transport, the **real**
 * SSE parser and the **real** agent loop; only the endpoint is fake.
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
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseOptions } from '../../scripts/build.js';
import { extractFakeProvider, isLoopbackUrl, resolveConfigDir } from '../../scripts/entry.js';
import { readEnvValue } from '../../src/provider/routes.js';

/* -------------------------------------------------------------------------- */
/* The paths                                                                   */
/* -------------------------------------------------------------------------- */

/** The repository's root. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The build script the suite runs. */
const buildScript = path.join(repoRoot, 'scripts', 'build.ts');

/** The name the build gives the executable. */
const binaryName = 'prricode';

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
 * It runs once, and it is the only `bun build --compile` the suite performs
 * outside the build script's own test.
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

/**
 * Whether a file carries a text.
 *
 * The file is read in **chunks**: the artifact is ninety megabytes, and the
 * suite runs beside three other ones on a small host.
 */
function fileCarries(file: string, needle: string): boolean {
  const wanted = Buffer.from(needle, 'utf8');
  const handle = openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const read = readSync(handle, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (window.includes(wanted)) return true;
      carry = window.subarray(Math.max(0, window.length - wanted.length));
    }
  } finally {
    closeSync(handle);
  }
  return false;
}

/** The files under a directory, recursively, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => entry.endsWith('.jsonl'));
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

    // **One file.** In an empty output directory the build emits the
    // executable and nothing else: a bundle that left a `node_modules` tree
    // or a second artifact beside it would not be self-contained.
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

  it('needs neither the host Node nor the host node_modules', async () => {
    // A working directory **outside** the repository: a run that resolved a
    // dependency through the repository's `node_modules` would have to reach
    // it from the working directory, and this one cannot.
    const outside = mkdtempSync(path.join(tmpdir(), 'prricode-outside-'));
    expect(outside.startsWith(repoRoot)).toBe(false);

    try {
      const emptyPath = path.join(workDir, 'empty-path');
      const result = await runBinary(['--version'], {
        cwd: outside,
        env: { PATH: emptyPath, NODE_PATH: undefined, NODE_OPTIONS: undefined },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(packageVersion());
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    // And the artifact does not carry the repository's path **at all**: the
    // bundle is closed over its own contents, so there is nothing to resolve
    // and nothing that points back at the tree it was built from.
    expect(fileCarries(binary, repoRoot)).toBe(false);
    // The search itself works: the artifact is linked against the C library,
    // so its name is in the binary.
    expect(fileCarries(binary, 'libc.so.6')).toBe(true);
  });

  it('runs --print against a fake driver', async () => {
    const provider = await startFakeProvider('the packaged binary answered');
    try {
      const result = await runBinary(['--print', '--fake-provider', provider.url, 'hello']);

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

    // The **sentence**, not a fragment of it: the help wraps the line, so the
    // whitespace is flattened before the sentence is looked for.
    const help = result.stdout.replace(/\s+/g, ' ');
    expect(help).toContain(
      'The multi-provider manager is a project extension, not part of the reference agent. It is reached through the /provider command.',
    );
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
/* The build script                                                            */
/* -------------------------------------------------------------------------- */

describe('the build script', () => {
  it('builds again into a directory that already holds an artifact', () => {
    // The directory the build runs in: a **relative** `--outdir` is resolved
    // against it, and not against the repository's root.
    const cwd = path.join(workDir, 'build-cwd');
    mkdirSync(cwd, { recursive: true });

    const first = spawnSync('bun', ['run', buildScript, '--outdir', 'out', '--name', 'first'], {
      cwd,
      encoding: 'utf8',
      timeout: 600_000,
    });
    expect(first.status).toBe(0);

    // The **second** build, into the same directory and under another name.
    // The first build's artifact is still there, and it is **not** the second
    // build's doing: a build that failed on a file a previous build left
    // behind would break the documented usage.
    const second = spawnSync('bun', ['run', buildScript, '--outdir', 'out', '--name', 'second'], {
      cwd,
      encoding: 'utf8',
      timeout: 600_000,
    });
    if (second.status !== 0) {
      throw new Error(
        `The second build failed.\nstdout:\n${second.stdout ?? ''}\nstderr:\n${second.stderr ?? ''}`,
      );
    }
    expect(second.stdout).toContain('Built ');

    // Both artifacts are there, and they are under the **caller's** directory.
    const out = path.join(cwd, 'out');
    expect(existsSync(path.join(out, 'first'))).toBe(true);
    expect(existsSync(path.join(out, 'second'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'out'))).toBe(false);
  });

  it('refuses to build without Bun', () => {
    // The build needs Bun: under Node the script says so and stops, and it
    // says so **before** it touches the output directory. The script loads
    // under Node at all — it depends on nothing but the `node:` built-ins.
    const outDir = path.join(workDir, 'no-bun');
    const result = spawnSync(process.execPath, [buildScript, '--outdir', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the build needs Bun');
    expect(existsSync(outDir)).toBe(false);
  });

  it('resolves a relative output directory against the caller\'s directory', () => {
    const parsed = parseOptions(['--outdir', 'out'], path.join('/tmp', 'caller'));
    expect(parsed).toEqual({
      kind: 'options',
      options: { outDir: path.join('/tmp', 'caller', 'out'), name: 'prricode' },
    });

    const defaulted = parseOptions([], path.join('/tmp', 'caller'));
    expect(defaulted).toEqual({
      kind: 'options',
      options: { outDir: path.join('/tmp', 'caller', 'dist'), name: 'prricode' },
    });
  });

  it('takes an option\'s value in either form', () => {
    const inline = parseOptions(
      ['--outdir=out', '--name=other', '--target=bun-linux-arm64'],
      path.join('/tmp', 'caller'),
    );
    expect(inline).toEqual({
      kind: 'options',
      options: {
        outDir: path.join('/tmp', 'caller', 'out'),
        name: 'other',
        target: 'bun-linux-arm64',
      },
    });

    const separate = parseOptions(
      ['--outdir', 'out', '--name', 'other', '--target', 'bun-linux-arm64'],
      path.join('/tmp', 'caller'),
    );
    expect(separate).toEqual(inline);
  });

  it('refuses a command line it does not understand', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(parseOptions(['--outdir'], '/tmp/caller')).toEqual({ kind: 'error' });
      expect(parseOptions(['--name'], '/tmp/caller')).toEqual({ kind: 'error' });
      expect(parseOptions(['--target'], '/tmp/caller')).toEqual({ kind: 'error' });
      expect(parseOptions(['--unknown'], '/tmp/caller')).toEqual({ kind: 'error' });
    } finally {
      stderr.mockRestore();
    }
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

  it('tightens a configuration directory that already existed', async () => {
    // A directory that is **wider** than the rule: the run must narrow it,
    // because the configuration directory must not be world-readable either
    // way.
    const configDir = path.join(workDir, 'wide', 'config');
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o755);
    expect(statSync(configDir).mode & 0o777).toBe(0o755);

    const result = await runBinary(['--version'], {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    expect(result.status).toBe(0);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
  });

  it('uses ~/.claude when no relocation is named', async () => {
    // A home of its own: the run must fall back to the **default** storage
    // root, and it must not touch the real one.
    const home = path.join(workDir, 'default-home');
    mkdirSync(home, { recursive: true });

    const result = await runBinary(['--version'], {
      env: { CLAUDE_CONFIG_DIR: undefined, HOME: home },
    });

    expect(result.status).toBe(0);
    const configDir = path.join(home, '.claude');
    expect(existsSync(configDir)).toBe(true);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    // And the first run **reports** the directory it fell back to.
    expect(result.stderr).toContain(configDir);
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

  it('relocates the session state with the configuration directory', async () => {
    const configDir = path.join(workDir, 'relocated-state', 'config');
    const home = path.join(workDir, 'relocated-state', 'home');
    const cwd = path.join(workDir, 'relocated-state', 'project');
    mkdirSync(cwd, { recursive: true });

    const provider = await startFakeProvider('the packaged binary answered');
    try {
      const result = await runBinary(['--print', '--fake-provider', provider.url, 'hello'], {
        cwd,
        env: { CLAUDE_CONFIG_DIR: configDir, HOME: home },
      });
      expect(result.status).toBe(0);

      // The **transcript** is under the relocated directory: the relocation
      // moves the state, not only the directory that is created.
      const transcripts = filesUnder(path.join(configDir, 'projects'));
      expect(transcripts.length).toBeGreaterThan(0);

      // And the default storage root was not touched.
      expect(existsSync(path.join(home, '.claude'))).toBe(false);
    } finally {
      await provider.close();
    }
  });

  it('refuses a fake provider that is not a loopback endpoint', async () => {
    // The seam is loopback-only, so a value that names any other host is
    // refused — the seam can never become a way to send a request (and a
    // credential) somewhere it does not belong.
    const result = await runBinary(['--print', '--fake-provider', 'http://example.invalid', 'hello']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must name a loopback endpoint');
    expect(result.stdout).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* The loopback check                                                          */
/* -------------------------------------------------------------------------- */

describe('the loopback check', () => {
  it('accepts a loopback endpoint', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true);
    // The whole of `127.0.0/8` is loopback.
    expect(isLoopbackUrl('http://127.0.0.2:8080')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1')).toBe(true);
  });

  it('refuses everything that is not a loopback endpoint', () => {
    // A host that merely **starts** with a loopback address.
    expect(isLoopbackUrl('http://127.0.0.1.evil.com')).toBe(false);
    // A loopback address in the **user information** of another host.
    expect(isLoopbackUrl('http://127.0.0.1@evil.com')).toBe(false);
    expect(isLoopbackUrl('http://user:127.0.0.1@evil.com')).toBe(false);
    // Another host, a private address, and a link-local one.
    expect(isLoopbackUrl('http://evil.com')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.1')).toBe(false);
    expect(isLoopbackUrl('http://169.254.169.254')).toBe(false);
    // A scheme that is not HTTP.
    expect(isLoopbackUrl('ftp://127.0.0.1')).toBe(false);
    expect(isLoopbackUrl('file:///tmp/x')).toBe(false);
    // And a value that is not a URL at all.
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The environment reader                                                      */
/* -------------------------------------------------------------------------- */

describe('the environment reader', () => {
  it('reports an inherited name as unset', () => {
    // This implementation's own rule: a name that collides with an inherited member is
    // **not** a value the run may use.
    const inherited = Object.create({
      CLAUDE_CONFIG_DIR: '/inherited',
    }) as NodeJS.ProcessEnv;

    expect(readEnvValue(inherited, 'CLAUDE_CONFIG_DIR')).toBeUndefined();
    expect(readEnvValue(inherited, 'constructor')).toBeUndefined();
    expect(readEnvValue(inherited, 'toString')).toBeUndefined();

    // And the configuration directory falls back to the default one rather
    // than to the inherited value.
    expect(resolveConfigDir(inherited)).not.toBe('/inherited');
  });

  it('reports a value that carries only whitespace as unset', () => {
    expect(readEnvValue({ CLAUDE_CONFIG_DIR: '   ' }, 'CLAUDE_CONFIG_DIR')).toBeUndefined();
    expect(readEnvValue({ CLAUDE_CONFIG_DIR: ' /tmp/x ' }, 'CLAUDE_CONFIG_DIR')).toBe('/tmp/x');
  });
});

/* -------------------------------------------------------------------------- */
/* The fake-provider option                                                    */
/* -------------------------------------------------------------------------- */

describe('the fake-provider option', () => {
  it('takes the option out of the command line', () => {
    const named = extractFakeProvider(['--print', '--fake-provider', 'http://127.0.0.1:1', 'hello']);
    expect(named).toEqual({
      kind: 'named',
      url: 'http://127.0.0.1:1',
      rest: ['--print', 'hello'],
    });

    const inline = extractFakeProvider(['--fake-provider=http://127.0.0.1:1']);
    expect(inline).toEqual({
      kind: 'named',
      url: 'http://127.0.0.1:1',
      rest: [],
    });

    const absent = extractFakeProvider(['--print', 'hello']);
    expect(absent).toEqual({ kind: 'absent', rest: ['--print', 'hello'] });
  });

  it('refuses an option that names nothing', () => {
    const missing = extractFakeProvider(['--fake-provider']);
    expect(missing.kind).toBe('invalid');

    const empty = extractFakeProvider(['--fake-provider=']);
    expect(empty.kind).toBe('invalid');
  });
});
