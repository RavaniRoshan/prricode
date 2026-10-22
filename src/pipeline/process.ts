/**
 * The process delivery — a stage served by a program speaking our protocol.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §8 and §4.
 *
 * > a process speaking this protocol over stdio, answering `tool/call`
 *
 * **One responsibility:** running one stage in another process and turning the
 * answer into the **same outcome** an in-process stage returns.
 *
 * ## The exchange
 *
 * The pipeline is the **client** here — PRRICODE is the client for the tool
 * providers it does not implement — so the call is `tool/call`, and the
 * parameters are the ones the protocol's own fixture uses:
 *
 * ```jsonc
 * { "v": "1", "id": 1, "method": "tool/call",
 *   "params": { "name": "concept", "arguments": { …the stage's input… } } }
 * ```
 *
 * The answer carries the stage's outcome, in the same three parts:
 *
 * ```jsonc
 * { "stageId": "concept", "state": "completed",
 *   "output": { "stageId": "concept", "summary": "…", "artifacts": { … } } }
 * { "stageId": "concept", "state": "refused", "reason": "…" }
 * ```
 *
 * ## Nothing is faked
 *
 * A process that dies, answers with something that is not an outcome, or
 * refuses the call is **refused with a reason** — the run reports the stage
 * and why. There is no path here that turns a broken process into a completed
 * stage.
 *
 * ## One process per call
 *
 * The stage process is started for the call and stopped after it. A stage is a
 * short unit of work, and a process that is left behind is a process nobody
 * asked for. The child's **stderr** is reported through the diagnostics
 * channel, so a stage that fails can say why in its own words.
 */

import { spawn } from 'node:child_process';

import { createProtocolClient } from '../protocol/index.js';
import {
  isStageOutput,
  stageRefusal,
  type PipelineStage,
  type StageInput,
  type StageOutcome,
  type StageRegistration,
} from './stage.js';

/** How a stage process is started. */
export interface StageProcessOptions {
  /** The program to run. */
  readonly command: string;
  /** Its arguments. */
  readonly args?: readonly string[];
  /** The directory it runs in. */
  readonly cwd?: string;
  /** Its environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long a call waits for its answer, in milliseconds. */
  readonly timeoutMs?: number;
  /** The stage's id — the tool the process answers for. */
  readonly id: string;
  /** Called with every line the process writes to its stderr. */
  readonly onDiagnostic?: (message: string) => void;
}

/** How long a call waits for its answer, when the deployment says nothing. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Register a stage served by a process.
 *
 * The registration is the **same shape** an in-process stage makes: an id, a
 * delivery, and the stage. The pipeline cannot tell them apart, and the
 * delivery is metadata for the caller.
 */
export function createProcessStage(options: StageProcessOptions): StageRegistration {
  const stage: PipelineStage = {
    id: options.id,
    title: `the stage process ${options.command}`,
    requires: [],
    run: (input) => callProcessStage(options, input),
  };
  return { id: options.id, delivery: 'process', stage };
}

/**
 * Run one stage in another process.
 *
 * The process is a **peer**: the pipeline is the client, and the process
 * answers `tool/call`.
 */
export async function callProcessStage(
  options: StageProcessOptions,
  input: StageInput,
): Promise<StageOutcome> {
  const child = spawn(options.command, [...(options.args ?? [])], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      stderr.push(trimmed);
      options.onDiagnostic?.(trimmed);
    }
  });

  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) {
    child.kill();
    return stageRefusal('the stage process was started without a pipe to talk over');
  }

  const client = createProtocolClient({
    input: stdout,
    output: stdin,
    identity: 'prricode-pipeline',
    peerIdentity: options.id,
    requestTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  try {
    const answer = await client.request<unknown>('tool/call', {
      name: options.id,
      arguments: input,
    });
    return mapStageAnswer(options.id, answer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const tail = stderr.length > 0 ? ` (the process said: ${stderr[stderr.length - 1]})` : '';
    return stageRefusal(`the stage process refused the call: ${detail}${tail}`);
  } finally {
    client.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/**
 * Turn the process's answer into an outcome.
 *
 * An answer that is not one of the two shapes is **refused with a reason** —
 * the pipeline never treats an answer it does not understand as a success.
 */
export function mapStageAnswer(stageId: string, answer: unknown): StageOutcome {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return stageRefusal('the stage process answered with something that is not a result');
  }
  const record = answer as Record<string, unknown>;
  const state = record['state'];

  if (state === 'completed') {
    const output = record['output'];
    if (!isStageOutput(output)) {
      return stageRefusal('the stage process answered with a completion that carries no output');
    }
    return { state: 'completed', output };
  }

  if (state === 'refused') {
    const reason = record['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return stageRefusal('the stage process refused without naming a reason');
    }
    return stageRefusal(reason);
  }

  return stageRefusal(`the stage process answered with a state this build does not know`);
}
