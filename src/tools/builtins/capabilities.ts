/**
 * The **capabilities** the newer tools need.
 *
 * Evidence: the target's own tool factory, read out of the pinned build, and the
 * `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A tool is a boundary between a model and a machine, and some of the target's
 * machines are not here.** The target's inventory names ninety-one tools, and a
 * number of them drive a subsystem this implementation does not have: a browser,
 * a language server, an agent team, a scheduler, a worktree manager, an MCP
 * channel, a self-hosted runner.
 *
 * **The rule this module encodes.** A tool whose capability is absent is not
 * **faked**: it keeps its name, its input schema, its permission behaviour and its
 * alias, and it **refuses** with a typed failure that names the missing
 * capability. A stub that returned a plausible answer would be worse than a
 * refusal, because the model would act on it.
 *
 * **The capabilities are seams.** The session supplies them; the tools never build
 * one themselves. That keeps the tool layer free of a dependency on the browser,
 * the language server, the team manager or the scheduler — none of which exist
 * here — and it means a session that *does* have one gets a real tool.
 *
 * Implementation choices (the target does not pin the seams, so they are marked
 * here): every interface below is this implementation's own.
 */

import type { PermissionMode } from '../../permissions/decision.js';
import type { ToolDefinition } from '../registry.js';

/* -------------------------------------------------------------------------- */
/* The user                                                                   */
/* -------------------------------------------------------------------------- */

/** One option of a question the user is asked. */
export interface UserQuestionOption {
  /** The label the user sees. */
  label: string;
  /** What the option means. */
  description?: string;
}

/** One question the user is asked. */
export interface UserQuestion {
  /** The question itself. */
  question: string;
  /** The options the user may pick from. */
  options?: UserQuestionOption[];
  /** Whether the user may answer more than one option. */
  multiSelect?: boolean;
  /** The header the question is shown under. */
  header?: string;
}

/** The answer the user gave. */
export interface UserAnswer {
  /** The option the user picked. */
  answer: string;
  /** The free-form text the user typed, when the user typed one. */
  response?: string;
}

/* -------------------------------------------------------------------------- */
/* The skills                                                                 */
/* -------------------------------------------------------------------------- */

/** A skill the session may invoke. */
export interface SkillRecord {
  /** The skill's name. */
  name: string;
  /** Where the skill came from. */
  source?: string;
  /** What the skill is for. */
  description?: string;
  /** The instructions the skill carries. */
  instructions: string;
}

/** The skill surface a session supplies. */
export interface SkillLookup {
  /** The skill with that name, or `undefined` when there is none. */
  resolve(name: string): SkillRecord | undefined;
  /** Every skill the session may invoke. */
  list(): readonly SkillRecord[];
}

/* -------------------------------------------------------------------------- */
/* The MCP resources                                                          */
/* -------------------------------------------------------------------------- */

/** A resource an MCP server exposes. */
export interface McpResourceRecord {
  /** The resource's URI. */
  uri: string;
  /** The resource's name. */
  name: string;
  /** The server that provides it. */
  server: string;
  /** The resource's MIME type. */
  mimeType?: string;
  /** What the resource is. */
  description?: string;
}

/** The content of an MCP resource. */
export interface McpResourceContent {
  /** The resource's URI. */
  uri: string;
  /** The content's MIME type. */
  mimeType?: string;
  /** The content, when it is text. */
  text?: string;
  /** Where a binary blob was saved. */
  blobSavedTo?: string;
}

/** The MCP resource surface a session supplies. */
export interface McpResourceProvider {
  /** The resources the connected servers expose. */
  listResources(server?: string): Promise<McpResourceRecord[]>;
  /** Read one resource by URI. */
  readResource(server: string, uri: string): Promise<McpResourceContent[]>;
  /** The children of a directory resource. */
  readResourceDir(server: string, uri: string): Promise<McpResourceRecord[]>;
}

/* -------------------------------------------------------------------------- */
/* The web search                                                             */
/* -------------------------------------------------------------------------- */

/** One hit of a web search. */
export interface WebSearchHit {
  /** The title of the page. */
  title: string;
  /** The URL of the page. */
  url: string;
  /** The text the search returned for the page. */
  snippet?: string;
}

/** The options of a web search. */
export interface WebSearchOptions {
  /** Only results from these domains. */
  allowedDomains?: string[];
  /** No results from these domains. */
  blockedDomains?: string[];
}

/** The web-search backend a session supplies. */
export type WebSearchBackend = (
  query: string,
  options: WebSearchOptions,
) => Promise<WebSearchHit[]>;

/* -------------------------------------------------------------------------- */
/* The background tasks                                                       */
/* -------------------------------------------------------------------------- */

/** The state of a background task. */
export type BackgroundTaskState = 'running' | 'completed' | 'failed' | 'stopped';

/** A background task the session is running. */
export interface BackgroundTask {
  /** The task's id. */
  id: string;
  /** What the task is. */
  command?: string;
  /** The task's state. */
  state: BackgroundTaskState;
  /** What the task printed. */
  output?: string;
  /** The task's exit code, when it has one. */
  exitCode?: number;
}

/** The background-task registry a session supplies. */
export interface BackgroundTaskRegistry {
  /** The task with that id, or `undefined` when there is none. */
  get(id: string): BackgroundTask | undefined;
  /** Every task the session knows about. */
  list(): readonly BackgroundTask[];
  /** Stop a running task. */
  stop(id: string): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* The memory                                                                 */
/* -------------------------------------------------------------------------- */

/** One document of a memory store. */
export interface MemoryDocument {
  /** The document's path inside the store. */
  path: string;
  /** The document's content. */
  content: string;
  /** When the document was last written. */
  updatedAt?: string;
}

/** One memory store. */
export interface MemoryStore {
  /** The store's id. */
  id: string;
  /** What the store is for. */
  description: string;
  /** Whether the store may be written. */
  writable: boolean;
  /** The path of the store's index document. */
  index: string;
}

/** The memory surface a session supplies. */
export interface MemoryProvider {
  /** The stores the session may use. */
  listStores(): readonly MemoryStore[];
  /** The documents of a store. */
  listDocuments(store: string, pathPrefix?: string): Promise<MemoryDocument[]>;
  /** One document of a store. */
  readDocument(store: string, path: string): Promise<MemoryDocument | undefined>;
  /** Write one document of a store. */
  writeDocument(store: string, path: string, content: string): Promise<MemoryDocument>;
}

/* -------------------------------------------------------------------------- */
/* The rest                                                                   */
/* -------------------------------------------------------------------------- */

/** A language server. */
export interface LanguageServer {
  /** The operation to perform. */
  perform(operation: string, filePath: string, line: number, character: number, query?: string): Promise<string>;
}

/** The agent team a session may talk to. */
export interface AgentTeam {
  /** The agents the session may send a message to. */
  list(): readonly { name: string; description?: string; agentId?: string }[];
  /** Send a message to one of them. */
  send(to: string, message: string): Promise<void>;
}

/** A job the scheduler runs. */
export interface ScheduledJob {
  /** The job's id. */
  id: string;
  /** The prompt the job fires. */
  prompt: string;
  /** When the job fires next, as an ISO timestamp. */
  nextRun: string;
  /** Whether the job fires once. */
  oneShot: boolean;
}

/** The scheduler a session supplies. */
export interface Scheduler {
  /** The jobs the scheduler holds. */
  list(): readonly ScheduledJob[];
  /** Schedule a job. */
  schedule(job: { prompt: string; cron?: string; delaySeconds?: number }): Promise<ScheduledJob>;
  /** Cancel a job. */
  cancel(id: string): Promise<boolean>;
}

/** A browser the session drives. */
export interface BrowserSession {
  /** The pages the browser holds. */
  pages(): readonly { id: string; title: string; url: string }[];
}

/** A notification the session delivers to the user. */
export interface UserNotification {
  /** The notification's text. */
  text: string;
  /** Whether the notification is also pushed to the user's phone. */
  mobile?: boolean;
}

/** The capabilities a session supplies to its tools. */
export interface ToolCapabilities {
  /** Ask the user a question and wait for the answer. */
  askUser?: (question: UserQuestion) => Promise<UserAnswer>;
  /** Deliver a message to the user. */
  sendUserMessage?: (message: string) => Promise<void>;
  /** The skills the session may invoke. */
  skills?: SkillLookup;
  /** The MCP resource surface. */
  mcp?: McpResourceProvider;
  /** The tools the registry holds, for `ToolSearch`. */
  toolCatalogue?: () => readonly ToolDefinition[];
  /** The web-search backend. */
  webSearch?: WebSearchBackend;
  /** Change the session's working directory. */
  changeDirectory?: (path: string) => Promise<string>;
  /** Switch the session's permission mode. */
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  /** End the session. */
  endConversation?: (reason: string) => Promise<void>;
  /** The background tasks the session is running. */
  backgroundTasks?: BackgroundTaskRegistry;
  /** The memory stores the session may use. */
  memory?: MemoryProvider;
  /** The language server the session may ask. */
  lsp?: LanguageServer;
  /** The agent team the session may talk to. */
  team?: AgentTeam;
  /** The scheduler the session may use. */
  schedule?: Scheduler;
  /** The browser the session may drive. */
  browser?: BrowserSession;
  /** Deliver a notification to the user. */
  notify?: (notification: UserNotification) => Promise<void>;
  /** The worktree manager the session may use. */
  worktrees?: {
    /** Create a worktree and switch the session into it. */
    enter(name?: string, path?: string): Promise<{ worktreePath: string; branch?: string }>;
    /** Leave the worktree. */
    exit(action: 'keep' | 'remove'): Promise<{ originalCwd: string; worktreePath: string }>;
  };
  /** Start a monitored process and stream its output as notifications. */
  monitor?: (input: {
    command: string;
    description?: string;
    timeoutMs?: number;
    persistent?: boolean;
  }) => Promise<{ taskId: string; timeoutMs: number; persistent?: boolean }>;
}
