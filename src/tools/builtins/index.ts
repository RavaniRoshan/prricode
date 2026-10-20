/**
 * The built-in tools: the set this implementation ships, and the seam that registers them.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 and §2.5, and the
 * `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The ten built-in tools are the ones the plan names: `Read`, `Write`, `Edit`,
 * `Bash`, `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `NotebookEdit` and `Task`.
 *
 * **Each tool gets its own file.** A tool's permission check, its input
 * validation and its execution belong together, and a file per tool keeps the
 * change to one tool from touching another.
 *
 * **The tools are built with the session's dependencies**, so the rules, the mode
 * and the prompt are the session's and not a global.
 */

import type { ToolDefinition, ToolRegistry } from '../registry.js';

import { createBashTool } from './bash.js';
import { createEditTool } from './edit.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createNotebookEditTool } from './notebookedit.js';
import { createReadTool } from './read.js';
import { createTaskTool } from './task.js';
import { createTodoWriteTool } from './todowrite.js';
import { createWebFetchTool } from './webfetch.js';
import { createWriteTool } from './write.js';
import type { BuiltinToolDeps } from './shared.js';

/** The names of the built-in tools, in registration order. */
export const BUILTIN_TOOL_NAMES: readonly string[] = Object.freeze([
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'Write',
]);

/**
 * Create the built-in tools.
 *
 * The order is the order the names are listed in, and it is the order the registry
 * holds them in.
 */
export function createBuiltinTools(deps: BuiltinToolDeps): ToolDefinition[] {
  return [
    createBashTool(deps),
    createEditTool(deps),
    createGlobTool(deps),
    createGrepTool(deps),
    createNotebookEditTool(deps),
    createReadTool(deps),
    createTaskTool(deps),
    createTodoWriteTool(deps),
    createWebFetchTool(deps),
    createWriteTool(deps),
  ];
}

/**
 * Register the built-in tools.
 *
 * The registry holds them in the order {@link createBuiltinTools} returns them.
 */
export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinToolDeps): ToolRegistry {
  for (const tool of createBuiltinTools(deps)) {
    registry.register(tool);
  }
  return registry;
}

export { createBashTool } from './bash.js';
export { createEditTool } from './edit.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createNotebookEditTool } from './notebookedit.js';
export { createReadTool } from './read.js';
export { createTaskTool } from './task.js';
export { createTodoWriteTool } from './todowrite.js';
export { createWebFetchTool } from './webfetch.js';
export { createWriteTool } from './write.js';
export type { BuiltinToolDeps } from './shared.js';
