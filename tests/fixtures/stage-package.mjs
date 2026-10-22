/**
 * A stage, delivered as a **package**.
 *
 * The pipeline's second delivery: "a package the agent loads". This module is
 * what such a package looks like — a module that **exports a stage** and
 * imports **nothing** from this repository.
 *
 * ## Why it imports nothing
 *
 * A stage is an **interface**, and the interface is the contract. If this
 * fixture imported the built-in stage, the test would measure that the two
 * deliveries reach the same code — which is true, and not the claim. The claim
 * is that a stage written by **somebody else**, against the same interface,
 * satisfies the same contract.
 *
 * So the stage below is written here, in plain JavaScript, from the contract
 * alone. It is the `concept` stage: the brief in, the concept out, and a
 * refusal when there is no idea.
 *
 * ## The export
 *
 * The loader looks for a `createStage` export first, then a `stage` export,
 * then a default export. This one is a `createStage` export — a **factory**,
 * so the package builds a fresh stage each time it is loaded.
 */

export function createStage() {
  return {
    id: 'concept',
    title: 'the idea, as a concept',
    requires: [],
    async run(input) {
      const brief = input && typeof input.brief === 'string' ? input.brief : '';
      const idea = brief.trim();
      if (idea.length === 0) {
        const reason = 'the run carries no idea to work from';
        return {
          state: 'refused',
          reason,
          capability: { enabled: false, unsupported: reason },
        };
      }
      return {
        state: 'completed',
        output: {
          stageId: 'concept',
          summary: `the concept of "${firstLine(idea)}"`,
          artifacts: {
            title: firstLine(idea),
            idea,
            problem: firstSentence(idea),
          },
        },
      };
    },
  };
}

/** The first line of the text, trimmed. */
function firstLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** The first sentence of the text. */
function firstSentence(text) {
  const stop = text.indexOf('. ');
  return (stop === -1 ? text : text.slice(0, stop)).trim();
}
