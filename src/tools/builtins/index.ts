/**
 * The built-in tools: the set this implementation ships, and the seam that registers them.
 *
 * Evidence: the target's own tool factory, read out of the pinned build, and the
 * `CC-008` and `CC-027` milestones of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The inventory is the target's.** The target defines ninety-one tools; this
 * implementation ships the ones it can implement honestly, and the ones it
 * cannot are **named** in `docs/compatibility/tool-surface.md` with the
 * capability each of them needs. A tool is never faked: a tool whose capability
 * is absent keeps its name, its schema and its permission behaviour and
 * **refuses**.
 *
 * **Each tool gets its own file.** A tool's permission check, its input
 * validation and its execution belong together, and a file per tool keeps the
 * change to one tool from touching another.
 *
 * **The tools are built with the session's dependencies**, so the rules, the mode
 * and the prompt are the session's and not a global.
 *
 * **The names are the target's, and the aliases are the target's.** The canonical
 * name of the sub-agent tool is `Agent` and `Task` is its alias; the canonical
 * names of the MCP resource tools carry the `Tool` suffix and their short forms
 * are the aliases. The registry resolves the aliases, so a call that names
 * `Task` reaches the `Agent` tool and a call that names `Brief` reaches
 * `SendUserMessage`.
 */

import type { ToolDefinition, ToolRegistry } from '../registry.js';

import { createAgentTool } from './agent.js';
import { createAskUserQuestionTool } from './askuserquestion.js';
import { createBashTool } from './bash.js';
import { createBrowserTools } from './browser.js';
import { createCdTool } from './cd.js';
import { createEditTool } from './edit.js';
import { createEndConversationTool } from './endconversation.js';
import { createEnterPlanModeTool } from './enterplanmode.js';
import { createExitPlanModeTool } from './exitplanmode.js';
import { createGetTaskTool } from './gettask.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createListAgentsTool } from './listagents.js';
import { createListMcpResourcesTool } from './listmcpresources.js';
import { createLspTool } from './lsp.js';
import { createMemoryListTool } from './memorylist.js';
import { createMemoryReadTool } from './memoryread.js';
import { createMemoryWriteTool } from './memorywrite.js';
import { createMonitorTool } from './monitor.js';
import { createMultiEditTool } from './multiedit.js';
import { createNotebookEditTool } from './notebookedit.js';
import { createNotebookReadTool } from './notebookread.js';
import { createOfferChromeSetupTool } from './offerChromeSetup.js';
import { createPowerShellTool } from './powershell.js';
import { createProposeGoalTool } from './proposegoal.js';
import { createReadMcpResourceTool } from './readmcpresource.js';
import { createReadMcpResourceDirTool } from './readmcpresourcedir.js';
import { createReadTool } from './read.js';
import { createReportFindingsTool } from './reportfindings.js';
import { createSendMessageTool } from './sendmessage.js';
import { createSendUserMessageTool } from './sendusermessage.js';
import { createSkillTool } from './skill.js';
import { createStructuredOutputTool } from './structuredoutput.js';
import { createSubagentHandbackTool } from './subagenthandback.js';
import { createTaskCreateTool } from './taskcreate.js';
import { createTaskGetTool } from './taskget.js';
import { createTaskListTool } from './tasklist.js';
import { createTaskStopTool } from './taskstop.js';
import { createTaskUpdateTool } from './taskupdate.js';
import { createTodoReadTool } from './todoread.js';
import { createTodoWriteTool } from './todowrite.js';
import { createToolSearchTool } from './toolsearch.js';
import { createWebFetchTool } from './webfetch.js';
import { createWebSearchTool } from './websearch.js';
import { createWriteTool } from './write.js';

import type { BuiltinToolDeps } from './shared.js';
import { TaskStore } from './taskstore.js';
import { TodoStore } from './todostore.js';

/** The names of the built-in tools, in registration order. */
export const BUILTIN_TOOL_NAMES: readonly string[] = Object.freeze([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Cd',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'ExitPlanMode',
  'GetTask',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'MultiEdit',
  'Monitor',
  'NotebookEdit',
  'NotebookRead',
  'OfferChromeSetup',
  'PowerShell',
  'ProposeGoal',
  'Read',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceTool',
  'ReportFindings',
  'SendMessage',
  'SendUserMessage',
  'Skill',
  'StructuredOutput',
  'SubagentHandback',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'TodoRead',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
  'memory_list',
  'memory_read',
  'memory_write',
  // The browser surface: the target's twenty-two browser tools, in the target's
  // own order (`chunk-g8377zgj.js:4271`). Every one of them refuses — there is
  // no browser behind them — and the tool names are the target's bare names.
  'javascript_tool',
  'read_page',
  'find',
  'form_input',
  'computer',
  'browser_batch',
  'navigate',
  'resize_window',
  'gif_creator',
  'upload_image',
  'get_page_text',
  'tabs_context_mcp',
  'tabs_create_mcp',
  'tabs_close_mcp',
  'read_console_messages',
  'read_network_requests',
  'shortcuts_list',
  'shortcuts_execute',
  'file_upload',
  'switch_browser',
  'list_connected_browsers',
  'select_browser',
]);

/**
 * Create the built-in tools.
 *
 * The order is the order the names are listed in, and it is the order the registry
 * holds them in.
 *
 * **The stores are shared.** The todo list and the task list are session state,
 * so the tools that read them and the tools that write them hold the **same**
 * store instance: `createBuiltinTools` builds a pair of stores when the session
 * supplies none.
 */
export function createBuiltinTools(deps: BuiltinToolDeps): ToolDefinition[] {
  const scoped: BuiltinToolDeps = {
    ...deps,
    stores: {
      todos: deps.stores?.todos ?? new TodoStore(),
      tasks: deps.stores?.tasks ?? new TaskStore(),
    },
  };

  return [
    createAgentTool(scoped),
    createAskUserQuestionTool(scoped),
    createBashTool(scoped),
    createCdTool(scoped),
    createEditTool(scoped),
    createEndConversationTool(scoped),
    createEnterPlanModeTool(scoped),
    createExitPlanModeTool(scoped),
    createGetTaskTool(scoped),
    createGlobTool(scoped),
    createGrepTool(scoped),
    createListAgentsTool(scoped),
    createListMcpResourcesTool(scoped),
    createLspTool(scoped),
    createMultiEditTool(scoped),
    createMonitorTool(scoped),
    createNotebookEditTool(scoped),
    createNotebookReadTool(scoped),
    createOfferChromeSetupTool(scoped),
    createPowerShellTool(scoped),
    createProposeGoalTool(scoped),
    createReadTool(scoped),
    createReadMcpResourceDirTool(scoped),
    createReadMcpResourceTool(scoped),
    createReportFindingsTool(scoped),
    createSendMessageTool(scoped),
    createSendUserMessageTool(scoped),
    createSkillTool(scoped),
    createStructuredOutputTool(scoped),
    createSubagentHandbackTool(scoped),
    createTaskCreateTool(scoped),
    createTaskGetTool(scoped),
    createTaskListTool(scoped),
    createTaskStopTool(scoped),
    createTaskUpdateTool(scoped),
    createTodoReadTool(scoped),
    createTodoWriteTool(scoped),
    createToolSearchTool(scoped),
    createWebFetchTool(scoped),
    createWebSearchTool(scoped),
    createWriteTool(scoped),
    createMemoryListTool(scoped),
    createMemoryReadTool(scoped),
    createMemoryWriteTool(scoped),
    // The browser surface: the target's twenty-two browser tools, in the target's
    // own order. Every one of them refuses — there is no browser behind them.
    ...createBrowserTools(scoped),
  ];
}

/**
 * Register the built-in tools.
 *
 * The registry holds them in the order {@link createBuiltinTools} returns them.
 *
 * **The catalogue the `ToolSearch` tool reads is this registry.** The seam is
 * closed here, so a session that registers the built-ins gets a `ToolSearch` that
 * searches them.
 */
export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinToolDeps): ToolRegistry {
  const scoped: BuiltinToolDeps = {
    ...deps,
    capabilities: {
      ...deps.capabilities,
      // A session that supplies its own catalogue keeps it; otherwise the
      // `ToolSearch` tool searches the registry this call fills.
      toolCatalogue: deps.capabilities?.toolCatalogue ?? (() => registry.list()),
    },
  };
  for (const tool of createBuiltinTools(scoped)) {
    registry.register(tool);
  }
  return registry;
}

export { createAgentTool } from './agent.js';
export { createAskUserQuestionTool } from './askuserquestion.js';
export { createBashTool } from './bash.js';
export {
  BROWSER_RESULT_CAPPED_TOOLS,
  BROWSER_RESULT_SIZE_CAP,
  BROWSER_SAFE_TOOL_NAMES,
  BROWSER_SELECTION_TOOL_NAMES,
  BROWSER_SESSION_TOOL_NAMES,
  BROWSER_TIMEOUTS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_SPECS,
  createBrowserTools,
  isBrowserSafeTool,
  type BrowserToolSpec,
} from './browser.js';
export { createCdTool } from './cd.js';
export { createEditTool } from './edit.js';
export { createEndConversationTool } from './endconversation.js';
export { createEnterPlanModeTool } from './enterplanmode.js';
export { createExitPlanModeTool } from './exitplanmode.js';
export { createGetTaskTool } from './gettask.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createListAgentsTool } from './listagents.js';
export { createListMcpResourcesTool } from './listmcpresources.js';
export { createLspTool } from './lsp.js';
export { createMemoryListTool } from './memorylist.js';
export { createMemoryReadTool } from './memoryread.js';
export { createMemoryWriteTool } from './memorywrite.js';
export { createMonitorTool } from './monitor.js';
export { createMultiEditTool } from './multiedit.js';
export { createNotebookEditTool, NOTEBOOK_EDIT_MODES } from './notebookedit.js';
export { createNotebookReadTool } from './notebookread.js';
export {
  OFFER_CHROME_SETUP_ASK_MESSAGE,
  OFFER_CHROME_SETUP_CONNECTED_MESSAGE,
  OFFER_CHROME_SETUP_DESCRIPTION,
  OFFER_CHROME_SETUP_INPUT_SCHEMA,
  OFFER_CHROME_SETUP_MOBILE_MESSAGE,
  OFFER_CHROME_SETUP_NOT_NOW_MESSAGE,
  OFFER_CHROME_SETUP_NO_ATTEMPT_MESSAGE,
  OFFER_CHROME_SETUP_OUTPUT_SCHEMA,
  OFFER_CHROME_SETUP_PROMPT,
  OFFER_CHROME_SETUP_WHEN_TO_USE,
  createOfferChromeSetupTool,
  type OfferChromeSetupOutcome,
} from './offerChromeSetup.js';
export { createPowerShellTool } from './powershell.js';
export { createProposeGoalTool } from './proposegoal.js';
export { createReadMcpResourceTool } from './readmcpresource.js';
export { createReadMcpResourceDirTool } from './readmcpresourcedir.js';
export { createReadTool } from './read.js';
export { createReportFindingsTool } from './reportfindings.js';
export { createSendMessageTool } from './sendmessage.js';
export { createSendUserMessageTool } from './sendusermessage.js';
export { createSkillTool } from './skill.js';
export { createStructuredOutputTool } from './structuredoutput.js';
export { createSubagentHandbackTool } from './subagenthandback.js';
export { createTaskCreateTool } from './taskcreate.js';
export { createTaskGetTool } from './taskget.js';
export { createTaskListTool } from './tasklist.js';
export { createTaskStopTool } from './taskstop.js';
export { createTaskUpdateTool } from './taskupdate.js';
export { createTodoReadTool } from './todoread.js';
export { createTodoWriteTool } from './todowrite.js';
export { createToolSearchTool } from './toolsearch.js';
export { createWebFetchTool, type WebFetchOptions } from './webfetch.js';
export { createWebSearchTool } from './websearch.js';
export { createWriteTool } from './write.js';
export type { BuiltinToolDeps, ToolStores } from './shared.js';
export type { ToolCapabilities } from './capabilities.js';
export { TaskStore } from './taskstore.js';
export { TodoStore } from './todostore.js';
