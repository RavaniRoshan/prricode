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
 *   - **The default artifact is linked against glibc**, and Alpine's libc is
 *     musl. Bun ships a **musl target** as well, so an Alpine-native artifact
 *     is one option away; the known limits are recorded in
 *     `docs/compatibility/packaging.md`.
 *
 * ## What the build does
 *
 *   - it bundles `scripts/entry.ts` — the packaged executable's entry point —
 *     into a single executable;
 *   - it **removes the previous artifact first**, so a failed build never
 *     leaves a stale binary behind for a test to run;
 *   - it **verifies the result**: the artifact exists, it is a regular file,
 *     and the build **emitted nothing else** — a build that left a
 *     `node_modules` tree beside it would not be self-contained.
 *
 * The output directory is **not** cleared: a file that was already there is
 * not this build's doing, and a second build under another name must not fail
 * on the first build's artifact.
 *
 * ## The usage
 *
 * ```
 * bun run scripts/build.ts [--outdir <dir>] [--name <name>] [--target <target>]
 * ```
 *
 * - `--outdir` — the directory the executable is written into. Default `dist`.
 *   A **relative** directory is resolved against the directory the command
 *   runs in, and not against the repository's root.
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
export interface BuildOptions {
  /** The directory the executable is written into. */
  outDir: string;
  /** The name of the executable. */
  name: string;
  /** The Bun target, when the caller names one. */
  target?: string;
}

/** The default name of the executable. */
const DEFAULT_NAME = 'agent';

/** The default output directory, relative to the caller's directory. */
const DEFAULT_OUT_DIR = 'dist';

/** The usage the `--help` option prints. */
const USAGE = `Usage: bun run scripts/build.ts [options]

Options:
  --outdir <dir>    the directory the executable is written into (default: ${DEFAULT_OUT_DIR})
                    a relative directory is resolved against the directory
                    the command runs in
  --name <name>     the name of the executable (default: ${DEFAULT_NAME})
  --target <target> the Bun target the executable is compiled for, for example
                    bun-linux-arm64 (default: the host)
  --help            write this and stop
`;

/** What the command line asked for. */
export type ParsedCommandLine =
  /** The build's options. */
  | { kind: 'options'; options: BuildOptions }
  /** The usage was asked for. */
  | { kind: 'help' }
  /** The command line was wrong. */
  | { kind: 'error' };

/**
 * Parse the command line.
 *
 * @param argv the arguments the command was given.
 * @param cwd the directory the command runs in; a relative output directory
 *   is resolved against it.
 * @returns what the command line asked for.
 */
export function parseOptions(
  argv: readonly string[],
  cwd: string = process.cwd(),
): ParsedCommandLine {
  let outDir = DEFAULT_OUT_DIR;
  let name = DEFAULT_NAME;
  let target: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--help' || token === '-h') {
      process.stdout.write(USAGE);
      return { kind: 'help' };
    }

    // An option takes its value **either** as the next argument
    // (`--name other`) **or** after an equals sign (`--name=other`).
    const separator = token.indexOf('=');
    const option = separator === -1 ? token : token.slice(0, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);

    switch (option) {
      case '--outdir': {
        const value = inline ?? argv[index + 1];
        if (value === undefined) {
          process.stderr.write("Error: the '--outdir' option needs a directory.\n");
          return { kind: 'error' };
        }
        outDir = value;
        if (inline === undefined) index += 1;
        break;
      }
      case '--name': {
        const value = inline ?? argv[index + 1];
        if (value === undefined) {
          process.stderr.write("Error: the '--name' option needs a name.\n");
          return { kind: 'error' };
        }
        name = value;
        if (inline === undefined) index += 1;
        break;
      }
      case '--target': {
        const value = inline ?? argv[index + 1];
        if (value === undefined) {
          process.stderr.write("Error: the '--target' option needs a target.\n");
          return { kind: 'error' };
        }
        target = value;
        if (inline === undefined) index += 1;
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
      outDir: path.resolve(cwd, outDir),
      name,
      ...(target === undefined ? {} : { target }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The build                                                                   */
/* -------------------------------------------------------------------------- */

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

  // What the directory held **before** the build. The directory is not
  // cleared: a file that was already there is not this build's doing, and a
  // second build under another name must not fail on the first build's
  // artifact.
  const preexisting = new Set(readdirSync(options.outDir));

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
    // The error a spawn reports is an `Error`, so it carries a message: the
    // build script does not need a second copy of the "the message of a
    // thrown value" rule that `src/cli/commands/shared.ts` owns.
    process.stderr.write(`Error: the build could not be started: ${result.error.message}\n`);
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(`Error: the build failed (exit ${String(result.status)}).\n`);
    return 1;
  }

  // The artifact is **verified**: it exists, it is a regular file, and the
  // build **emitted nothing else**. A build that left a second file beside
  // the executable would not be the self-contained artifact this project
  // ships.
  if (!existsSync(outFile)) {
    process.stderr.write(`Error: the build produced no executable at '${outFile}'.\n`);
    return 1;
  }
  const details = statSync(outFile);
  if (!details.isFile()) {
    process.stderr.write(`Error: '${outFile}' is not a regular file.\n`);
    return 1;
  }
  const emitted = readdirSync(options.outDir).filter(
    (entry) => entry !== options.name && !preexisting.has(entry),
  );
  if (emitted.length > 0) {
    process.stderr.write(
      `Error: the build emitted more than the executable: ${JSON.stringify(emitted)}.\n`,
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

/**
 * The guard.
 *
 * `import.meta.main` is **true** for the module the process was started with
 * — under Bun and under Node — and **false** for a module that was imported.
 * The build therefore runs when this file is the program and **not at all**
 * when it is imported, so the functions above can be tested.
 */
if (import.meta.main === true) {
  process.exitCode = main();
}
