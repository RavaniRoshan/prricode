/**
 * The test server — a real process that speaks the protocol over stdio.
 *
 * This is the **server** half of the test: it is spawned as a child process,
 * it reads requests from its stdin and writes answers to its stdout, and every
 * byte it writes is a frame. The test's own client is the other half, and the
 * two talk over the child's pipes.
 *
 * ## What it serves
 *
 * The server serves the **product's** parts — the tools, the approvals and the
 * turns — and it deliberately does **not** serve the model: the `model`
 * capability is off, and the methods of that area answer with the capability's
 * record rather than with a result that pretends a model is there.
 *
 * The prompt of a turn decides what the turn does:
 *
 * | the prompt | what the turn does |
 * |---|---|
 * | anything else | emits an `event/message` and ends `completed` |
 * | `hold` | waits for the abort, and ends `aborted` |
 * | `unavailable` | fails with `model/unavailable` |
 *
 * The `write` tool asks the client for an approval, which is the exchange the
 * approvals are measured through.
 */

import {
  capabilityRecord,
  createDefaultCapabilityRegistry,
  createProtocolServer,
  protocolError,
  type ProtocolServer,
  type TurnRequest,
} from '../../src/protocol/index.js';

const capabilities = createDefaultCapabilityRegistry();
// The tools, the approvals and the turns are here; the model is not, and the
// capability record says so.
capabilities.register('tool', capabilityRecord(true, null));
capabilities.register('approval', capabilityRecord(true, null));

let server: ProtocolServer | null = null;
let approvalCounter = 0;

/** The turn runner. */
async function runTurn(turn: TurnRequest): Promise<{ state: 'completed' | 'aborted' }> {
  if (turn.prompt === 'unavailable') {
    // The model the turn selected is not available: the turn fails loudly and
    // is not retried against anything else.
    throw protocolError(
      'model/unavailable',
      'the model this turn selected is not available',
      { model: turn.model ?? null },
    );
  }
  if (turn.prompt === 'hold') {
    await new Promise<void>((resolve) => {
      if (turn.signal.aborted) {
        resolve();
        return;
      }
      turn.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { state: 'aborted' };
  }
  turn.emit('event/message', { text: 'the turn is working' });
  // The stages report themselves as they advance, and a stage that cannot run
  // says so in the shared shape rather than being skipped silently.
  turn.emit('event/stage', {
    stageId: 'build',
    state: 'running',
    enabled: true,
    unsupported: null,
  });
  turn.emit('event/stage', {
    stageId: 'ship',
    state: 'refused',
    enabled: false,
    unsupported: 'no deployment target is configured for this build',
  });
  return { state: 'completed' };
}

server = createProtocolServer({
  input: process.stdin,
  output: process.stdout,
  identity: 'prricode',
  peerIdentity: 'the-editor',
  capabilities,
  turnHandler: runTurn,
  handlers: {
    'tool/list': () => ({
      tools: [{ name: 'write', description: 'writes a file' }],
    }),
    'tool/describe': (params) => {
      const record = params as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : '';
      if (name !== 'write') {
        throw protocolError('tool/unknown', `no tool "${name}"`, { name });
      }
      return { name: 'write', description: 'writes a file' };
    },
    'tool/call': async (params) => {
      const record = params as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : '';
      if (name !== 'write') {
        throw protocolError('tool/unknown', `no tool "${name}"`, { name });
      }
      if (!server) throw protocolError('method/failed', 'the server is not running');
      approvalCounter += 1;
      const decision = await server.requestApproval({
        requestId: `approval_${approvalCounter}`,
        tool: 'write',
        call: record['arguments'] ?? null,
        reason: 'the rule for this tool asks before it runs',
      });
      if (decision.decision === 'deny') {
        throw protocolError('approval/denied', 'the approval was denied', {
          answerer: decision.answerer,
        });
      }
      return { content: 'the file was written', answerer: decision.answerer };
    },
  },
});

process.stdin.on('end', () => {
  process.exit(0);
});
