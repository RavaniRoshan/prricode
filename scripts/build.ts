/**
 * The build: **one** self-contained executable, with no runtime dependency on
 * the host's Node.
 *
 * Owning task: `CC-018` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## Why `bun build --compile`
 *
 * The plan fixes the packaging path: **Bun's `--compile`**, not Node's
 * Single Executable Application. The two differ in three ways that matter to
 * this project:
 *
 *   - **The runtime is embedded.** The artifact carries its own runtime, so it
 *     does not need the host's Node — and it does not need the host's
 *     `node_modules` either. The artifact is **one file**.
 *   - **Node's SEA cannot ship on macOS x64**, and its tooling is still
 *     Stability 1.1.
 *   - **A Bun-built binary cannot run on Alpine by default**: Bun's Linux
 *     artifacts link against glibc, and Alpine's libc is musl. The known
 *     limits are recorded in `docs/compatibility/packaging.md`.
 *
 * ## What the build does
 *
 *   - it bundles `scripts/entry.ts` — the packaged executable's entry point —
 *     into a single executable;
 *   - it **removes the previous artifact first**, so a failed build never
 *     leaves a stale binary behind for a test to run;
 *   - it **verifies the result**: the artifact exists, it is a regular file,
 *     and the output directory holds **nothing else** — a build that left a
 *     `node_modules` tree beside it would not be self-contained.
 *
 * ## The usage
 *
 * ```
 * bun run scripts/build.ts [--outdir <dir>] [--name <name>] [--target <target>]
 * ```
 *
 * - `--outdir` — the directory the executable is written into. Default `dist`.
 * - `--name` — the name of the executable. Default `claude`.
 * - `--target` — the Bun target the executable is compiled for. Default: the
 *   host platform.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* The paths                                                                   */
/* -------------------------------------------------------------------------- */

/** The repository's root — the directory the build runs in. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The entry point the executable is built from. */
const entryPoint = path.join(repoRoot, 'scripts', 'entry.ts');

/* -------------------------------------------------------------------------- */
/* The options                                                                 */
/* -------------------------------------------------------------------------- */

/** The options the build runs with. */
interface BuildOptions {
  /** The directory the executable is written into. */
  outDir: string;
  /** The name of the executable. */
  name: string;
  /** The Bun target, when the caller names one. */
  target?: string;
}

/** The default name of the executable. */
const DEFAULT_NAME = 'agent';

/** The default output directory, relative to the repository's root. */
const DEFAULT_OUT_DIR = 'dist';

/** The usage the `--help` option prints. */
const USAGE = `Usage: bun run scripts/build.ts [options]

Options:
  --outdir <dir>    the directory the executable is written into (default: ${DEFAULT_OUT_DIR})
  --name <name>     the name of the executable (default: ${DEFAULT_NAME})
  --target <target> the Bun target the executable is compiled for, for example
                    bun-linux-arm64 (default: the host)
  --help            write this and stop
`;

/** What the command line asked for. */
type ParsedCommandLine =
  /** The build's options. */
  | { kind: 'options'; options: BuildOptions }
  /** The usage was asked for. */
  | { kind: 'help' }
  /** The command line was wrong. */
  | { kind: 'error' };

/**
 * Parse the command line.
 *
 * @returns what the command line asked for.
 */
export function parseOptions(argv: readonly string[]): ParsedCommandLine {
  let outDir = DEFAULT_OUT_DIR;
  let name = DEFAULT_NAME;
  let target: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    switch (token) {
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        return { kind: 'help' };
      case '--outdir': {
        const value = argv[index + 1];
        if (value === undefined) {
          process.stderr.write("Error: the '--outdir' option needs a directory.\n");
          return { kind: 'error' };
        }
        outDir = value;
        index += 1;
        break;
      }
      case '--name': {
        const value = argv[index + 1];
        if (value === undefined) {
          process.stderr.write("Error: the '--name' option needs a name.\n");
          return { kind: 'error' };
        }
        name = value;
        index += 1;
        break;
      }
      case '--target': {
        const value = argv[index + 1];
        if (value === undefined) {
          process.stderr.write("Error: the '--target' option needs a target.\n");
          return { kind: 'error' };
        }
        target = value;
        index += 1;
        break;
      }
      default:
        process.stderr.write(`Error: unknown option '${token}'.\n`);
        process.stderr.write(USAGE);
        return { kind: 'error' };
    }
  }

  return {
    kind: 'options',
    options: {
      outDir: path.resolve(repoRoot, outDir),
      name,
      ...(target === undefined ? {} : { target }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The build                                                                   */
/* -------------------------------------------------------------------------- */

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'an unknown error';
}

/**
 * Build the executable.
 *
 * @returns the exit code the build ends with.
 */
export function build(options: BuildOptions): number {
  if (typeof process.versions.bun !== 'string') {
    process.stderr.write(
      'Error: the build needs Bun. Run it with `bun run scripts/build.ts`.\n',
    );
    return 1;
  }

  const outFile = path.join(options.outDir, options.name);
  mkdirSync(options.outDir, { recursive: true });

  // The previous artifact is removed **first**: a failed build must not leave
  // a stale executable behind for a test to run and believe.
  rmSync(outFile, { force: true });

  const buildArgs = ['build', '--compile', `--outfile=${outFile}`];
  if (options.target !== undefined) buildArgs.push(`--target=${options.target}`);
  buildArgs.push(entryPoint);

  const result = spawnSync(process.execPath, buildArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    process.stderr.write(`Error: the build could not be started: ${messageOf(result.error)}\n`);
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(`Error: the build failed (exit ${String(result.status)}).\n`);
    return 1;
  }

  // The artifact is **verified**: it exists, it is a regular file, and the
  // output directory holds nothing else. A build that left a second file
  // beside it would not be the self-contained artifact this project ships.
  if (!existsSync(outFile)) {
    process.stderr.write(`Error: the build produced no executable at '${outFile}'.\n`);
    return 1;
  }
  const details = statSync(outFile);
  if (!details.isFile()) {
    process.stderr.write(`Error: '${outFile}' is not a regular file.\n`);
    return 1;
  }
  const entries = readdirSync(options.outDir);
  if (entries.length !== 1 || entries[0] !== options.name) {
    process.stderr.write(
      `Error: the build emitted more than the executable: ${JSON.stringify(entries)}.\n`,
    );
    return 1;
  }

  const megabytes = (details.size / (1024 * 1024)).toFixed(1);
  process.stdout.write(`Built ${outFile} (${megabytes} MiB, one file, no host Node required).\n`);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* The process                                                                 */
/* -------------------------------------------------------------------------- */

/** Run the build. */
function main(): number {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.kind === 'help') return 0;
  if (parsed.kind === 'error') return 2;
  return build(parsed.options);
}

process.exitCode = main();
