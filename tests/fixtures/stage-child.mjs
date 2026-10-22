/**
 * The loader that starts the stage process.
 *
 * The stage process is a **real process** that speaks the protocol on stdin
 * and stdout, and it is the same module the test's own client uses — so the
 * test measures the protocol, not two implementations of it.
 *
 * ## Why the resolver hook
 *
 * The repository's modules import each other with the `.js` extension, which
 * is what `tsc`'s NodeNext resolution requires. Node's own TypeScript support
 * loads a `.ts` file and strips its types, but it resolves `./frames.js`
 * literally — and the file on disk is `frames.ts`. The hook below maps a
 * relative `.js` specifier onto the `.ts` file beside it, and only when there
 * is no `.js` file to find.
 *
 * ## The contract
 *
 * The process speaks the protocol on **stdin and stdout** and nothing else:
 * every byte it writes to stdout is a frame. Diagnostics go to stderr.
 */

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        throw error;
      }
    }
    return nextResolve(specifier, context);
  },
});

await import('./stage-process.ts');
