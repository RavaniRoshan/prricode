/**
 * The capabilities of an MCP server.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the four capability listings a
 * server exposes — its tools, its commands, its resources and its resource
 * templates — and the way they are fetched.
 *
 * The capabilities are fetched **separately** (`tools/list`, `prompts/list`,
 * `resources/list`, `resources/templates/list`) and aggregated afterwards. A
 * listing hydration path sits beside the fetch path, with a "discover prior"
 * memo, so a listing that was already discovered is not discovered again.
 */

import { readRecord } from './records.js';
import type { McpConnection } from './connection.js';

/* -------------------------------------------------------------------------- */
/* The definitions                                                            */
/* -------------------------------------------------------------------------- */

/** A tool the server exposes. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  instructions?: string;
}

/** A command (prompt) the server exposes. */
export interface McpCommandDefinition {
  name: string;
  title?: string;
  description?: string;
}

/** A resource the server exposes. */
export interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** A resource template the server exposes. */
export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** The capabilities of a server, fetched separately. */
export interface McpToolsCommandsAndResources {
  tools: McpToolDefinition[];
  commands: McpCommandDefinition[];
  resources: McpResourceDefinition[];
  resourceTemplates: McpResourceTemplateDefinition[];
}

/** A listing: everything the server exposes, known already. */
export interface McpListing extends McpToolsCommandsAndResources {
  /** The server the listing belongs to. */
  server: string;
}

/* -------------------------------------------------------------------------- */
/* The readers                                                                */
/* -------------------------------------------------------------------------- */

function readToolList(result: unknown): McpToolDefinition[] {
  const record = readRecord(result);
  const list = record?.['tools'];
  if (!Array.isArray(list)) return [];
  const tools: McpToolDefinition[] = [];
  for (const entry of list) {
    const tool = readRecord(entry);
    if (!tool) continue;
    const name = tool['name'];
    if (typeof name !== 'string' || name === '') continue;
    const definition: McpToolDefinition = { name };
    if (typeof tool['title'] === 'string') definition.title = tool['title'];
    if (typeof tool['description'] === 'string') definition.description = tool['description'];
    if (tool['inputSchema'] !== undefined) definition.inputSchema = tool['inputSchema'];
    if (typeof tool['instructions'] === 'string') definition.instructions = tool['instructions'];
    tools.push(definition);
  }
  return tools;
}

function readCommandList(result: unknown): McpCommandDefinition[] {
  const record = readRecord(result);
  const list = record?.['prompts'] ?? record?.['commands'];
  if (!Array.isArray(list)) return [];
  const commands: McpCommandDefinition[] = [];
  for (const entry of list) {
    const command = readRecord(entry);
    if (!command) continue;
    const name = command['name'];
    if (typeof name !== 'string' || name === '') continue;
    const definition: McpCommandDefinition = { name };
    if (typeof command['title'] === 'string') definition.title = command['title'];
    if (typeof command['description'] === 'string') definition.description = command['description'];
    commands.push(definition);
  }
  return commands;
}

function readResourceList(result: unknown): McpResourceDefinition[] {
  const record = readRecord(result);
  const list = record?.['resources'];
  if (!Array.isArray(list)) return [];
  const resources: McpResourceDefinition[] = [];
  for (const entry of list) {
    const resource = readRecord(entry);
    if (!resource) continue;
    const uri = resource['uri'];
    const name = resource['name'];
    if (typeof uri !== 'string' || typeof name !== 'string') continue;
    const definition: McpResourceDefinition = { uri, name };
    if (typeof resource['title'] === 'string') definition.title = resource['title'];
    if (typeof resource['description'] === 'string') definition.description = resource['description'];
    if (typeof resource['mimeType'] === 'string') definition.mimeType = resource['mimeType'];
    resources.push(definition);
  }
  return resources;
}

function readResourceTemplateList(result: unknown): McpResourceTemplateDefinition[] {
  const record = readRecord(result);
  const list = record?.['resourceTemplates'];
  if (!Array.isArray(list)) return [];
  const templates: McpResourceTemplateDefinition[] = [];
  for (const entry of list) {
    const template = readRecord(entry);
    if (!template) continue;
    const uriTemplate = template['uriTemplate'];
    const name = template['name'];
    if (typeof uriTemplate !== 'string' || typeof name !== 'string') continue;
    const definition: McpResourceTemplateDefinition = { uriTemplate, name };
    if (typeof template['title'] === 'string') definition.title = template['title'];
    if (typeof template['description'] === 'string') definition.description = template['description'];
    if (typeof template['mimeType'] === 'string') definition.mimeType = template['mimeType'];
    templates.push(definition);
  }
  return templates;
}

/* -------------------------------------------------------------------------- */
/* The fetchers                                                               */
/* -------------------------------------------------------------------------- */

/** The tools of a connected client. */
export async function fetchToolsForClient(connection: McpConnection): Promise<McpToolDefinition[]> {
  return readToolList(await connection.request('tools/list', {}));
}

/** The commands of a connected client. */
export async function fetchCommandsForClient(
  connection: McpConnection,
): Promise<McpCommandDefinition[]> {
  return readCommandList(await connection.request('prompts/list', {}));
}

/** The resources of a connected client. */
export async function fetchResourcesForClient(
  connection: McpConnection,
): Promise<McpResourceDefinition[]> {
  return readResourceList(await connection.request('resources/list', {}));
}

/** The resource templates of a connected client. */
export async function fetchResourceTemplatesForClient(
  connection: McpConnection,
): Promise<McpResourceTemplateDefinition[]> {
  return readResourceTemplateList(await connection.request('resources/templates/list', {}));
}

/** The capabilities of a connected client, fetched separately and aggregated. */
export async function getMcpToolsCommandsAndResources(
  connection: McpConnection,
): Promise<McpToolsCommandsAndResources> {
  const [tools, commands, resources, resourceTemplates] = await Promise.all([
    fetchToolsForClient(connection),
    fetchCommandsForClient(connection),
    fetchResourcesForClient(connection),
    fetchResourceTemplatesForClient(connection),
  ]);
  return { tools, commands, resources, resourceTemplates };
}

/* -------------------------------------------------------------------------- */
/* The listing hydration                                                      */
/* -------------------------------------------------------------------------- */

const discoveredServers = new Set<string>();

/** Whether a server's listing has already been discovered. */
export function getRememberedDiscoverPrior(server: string): boolean {
  return discoveredServers.has(server);
}

/**
 * Whether a listing has already been discovered.
 *
 * A listing that was already discovered is **not** discovered again.
 */
export function getListingDiscoverPrior(listing: McpListing): boolean {
  return getRememberedDiscoverPrior(listing.server);
}

/** Record that a server's listing was discovered. */
export function rememberDiscoverPrior(server: string): void {
  discoveredServers.add(server);
}

/** Hydrate the tools of a listing, and record the discover prior. */
export function hydrateToolsFromListing(listing: McpListing): McpToolDefinition[] {
  rememberDiscoverPrior(listing.server);
  return [...listing.tools];
}

/** Hydrate the commands of a listing, and record the discover prior. */
export function hydrateCommandsFromListing(listing: McpListing): McpCommandDefinition[] {
  rememberDiscoverPrior(listing.server);
  return [...listing.commands];
}
