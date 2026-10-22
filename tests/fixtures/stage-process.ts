/**
 * The stage process — a real program that speaks our protocol over stdio.
 *
 * This is the pipeline's third delivery: "a process speaking this protocol
 * over stdio, answering `tool/call`".
 *
 * ## What it is
 *
 * A **separate process**. It reads requests from its stdin and writes answers
 * to its stdout, and every byte it writes to stdout is a frame. The pipeline
 * is the **client** here — PRRICODE is the client for the tool providers it
 * does not implement — so this process answers `tool/call`.
 *
 * ## What it serves
 *
 * One stage: the `concept` stage, which the pipeline already knows. The
 * process serves it over the wire, and the answer carries the stage's outcome
 * in the shape the protocol's `tool/call` uses.
 *
 * ## Its stderr
 *
 * It says its own pid on stderr, so the test can show that the stage really
 * ran in **another process** and not in this one.
 */

import {
  capabilityRecord,
  createDefaultCapabilityRegistry,
  createProtocolServer,
  protocolError,
  type ProtocolServer,
} from '../../src/protocol/index.js';
import { createStageServices, type StageContext, type StageInput } from '../../src/pipeline/index.js';
import { createConceptStage } from '../../src/pipeline/stages/concept.js';

const capabilities = createDefaultCapabilityRegistry();
// The stage process serves tools; the model and the approvals are not its
// business, and their capability records say so.
capabilities.register('tool', capabilityRecord(true, null));

const stage = createConceptStage();
const services = createStageServices();

/** The context the stage runs in. */
function stageContext(runId: string): StageContext {
  return {
    runId,
    services,
    capabilities: services.capabilities,
    signal: new AbortController().signal,
  };
}

let server: ProtocolServer | null = null;

server = createProtocolServer({
  input: process.stdin,
  output: process.stdout,
  identity: 'the-stage-process',
  peerIdentity: 'prricode-pipeline',
  capabilities,
  handlers: {
    'tool/list': () => ({
      tools: [{ name: stage.id, description: stage.title }],
    }),
    'tool/describe': (params) => {
      const record = params as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : '';
      if (name !== stage.id) {
        throw protocolError('tool/unknown', `no tool "${name}"`, { name });
      }
      return { name: stage.id, description: stage.title };
    },
    'tool/call': async (params) => {
      const record = params as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : '';
      if (name !== stage.id) {
        throw protocolError('tool/unknown', `no tool "${name}"`, { name });
      }
      const arguments_ = record['arguments'];
      const input: StageInput =
        typeof arguments_ === 'object' && arguments_ !== null
          ? (arguments_ as StageInput)
          : { runId: 'run_1', brief: '', previous: null, outputs: {} };
      const outcome = await stage.run(input, stageContext(input.runId));
      if (outcome.state === 'completed') {
        return { stageId: stage.id, state: 'completed', output: outcome.output };
      }
      return { stageId: stage.id, state: 'refused', reason: outcome.reason };
    },
  },
});

void server;

process.stderr.write(`the stage process pid ${process.pid}\n`);
