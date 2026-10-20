/**
 * The control-request surface.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "Control-request surface" and "Directional policy"), and the `CC-011`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## Two dispatchers, not one
 *
 * The target's REA evidence contains **two distinct** control-request
 * dispatchers, and this module must not conflate them.
 *
 *   - The **host dispatcher** (`dispatchControlRequest`) handles exactly the 23
 *     host subtypes. `can_use_tool` is **not** one of them: the target's own
 *     directional-policy table classifies it as "agent-originated and cannot be
 *     sent by a host".
 *   - The **transport permission dispatcher** receives the `can_use_tool`
 *     requests that arrive from a remote peer. It already exists, in
 *     `src/permissions/prompts.ts` (`createTransportPermissionDispatcher`), with
 *     its own validation and deduplication rules. This module **wires it in**
 *     rather than duplicating it.
 *
 * `dispatchCanUseTool` is the seam between the two: it rejects a request whose
 * `request_id` is not a string with **no response** — because no response is
 * possible — and hands everything else to the transport dispatcher.
 *
 * ## The 23 host subtypes
 *
 * The list is closed and is reproduced exactly. The three MCP subtypes have
 * their own callbacks; the rest are the host's own actions and are answered
 * through the generic host seam.
 *
 * ## The error texts
 *
 *   - a required callback that is **not registered** answers with a
 *     `control_response` of subtype `error` and the message
 *     `"<subtype> is not supported in this context (callback not registered)"`;
 *   - a subtype the target rejects **by direction** answers with the target's
 *     own wording — "sent to a cloud agent by the service, not by a host",
 *     "sent to a cloud agent by the attached client, not by a host", and
 *     "agent-originated and cannot be sent by a host";
 *   - `mcp_status` answers `{ mcpServers: [] }` in the observed context;
 *   - `fork_conversation` answers
 *     `{ forked: false, error: "unsupported", reason: "requires_remote_control_server" }`
 *     when the remote control server is absent.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The generic **host seam** is `onHostRequest`. A subtype that needs a
 *     callback and has none answers with the target's own "callback not
 *     registered" text, so the wording is the same wherever the callback is
 *     missing.
 *   - A request whose `request_id` is not a string cannot be correlated, so the
 *     host dispatcher answers with an error rather than a response it could not
 *     deliver.
 *   - A control request is rejected while the process is exiting; the message
 *     says so.
 *   - `onMessage` receives the rejection notice, so a host can log or report
 *     it.
 */

import {
  createTransportPermissionDispatcher,
  type TransportPermissionDispatcher,
} from '../../permissions/prompts.js';

/* -------------------------------------------------------------------------- */
/* The subtype lists                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The 23 control-request subtypes the target's host dispatcher handles.
 *
 * The list is closed: `can_use_tool` is **not** in it.
 */
export const HOST_CONTROL_REQUEST_SUBTYPES = Object.freeze([
  'initialize',
  'set_model',
  'set_max_thinking_tokens',
  'set_permission_mode',
  'rename_session',
  'set_color',
  'file_suggestions',
  'read_file',
  'get_workspace_diff',
  'get_context_usage',
  'get_usage',
  'mcp_status',
  'mcp_authenticate',
  'mcp_oauth_callback_url',
  'mcp_reconnect',
  'interrupt',
  'apply_flag_settings',
  'mcp_set_servers',
  'stop_task',
  'background_tasks',
  'cancel_async_message',
  'side_question',
  'fork_conversation',
] as const);

/**
 * The control-request subtypes, as the plan fixes them.
 *
 * The runtime value is the closed list of 23; the declared type is
 * `readonly string[]`, so a consumer may hold it as a plain string array.
 */
export const CONTROL_REQUEST_SUBTYPES: readonly string[] = HOST_CONTROL_REQUEST_SUBTYPES;

/** The type of a control-request subtype. */
export type ControlRequestSubtype = (typeof CONTROL_REQUEST_SUBTYPES)[number];

/** The type of a subtype the host dispatcher handles. */
export type HostControlRequestSubtype = (typeof HOST_CONTROL_REQUEST_SUBTYPES)[number];

/**
 * The subtypes the **service** sends to a cloud agent, not by a host.
 */
export const SERVICE_ORIGINATED_CONTROL_SUBTYPES = Object.freeze(['mcp_tasks_changed'] as const);

/**
 * The subtypes the **attached client** sends to a cloud agent, not by a host.
 */
export const CLIENT_ORIGINATED_CONTROL_SUBTYPES = Object.freeze([
  'register_device_hooks',
  'upload_device_hook_template',
  'remote_tools_announce',
] as const);

/**
 * The **agent-originated** subtypes, which cannot be sent by a host.
 *
 * `can_use_tool` is one of them: it arrives at the transport permission
 * dispatcher, not at the host dispatcher.
 */
export const AGENT_ORIGINATED_CONTROL_SUBTYPES = Object.freeze([
  'can_use_tool',
  'hook_callback',
  'elicitation',
  'request_user_dialog',
  'oauth_token_refresh',
  'host_auth_token_refresh',
  'remote_tool_call',
  'remote_plumbing_call',
  'remote_tools_probe',
  'remote_tools_reannounce',
  'remote_control_work_secret',
] as const);

const SERVICE_ORIGINATED = new Set<string>(SERVICE_ORIGINATED_CONTROL_SUBTYPES);
const CLIENT_ORIGINATED = new Set<string>(CLIENT_ORIGINATED_CONTROL_SUBTYPES);
const AGENT_ORIGINATED = new Set<string>(AGENT_ORIGINATED_CONTROL_SUBTYPES);
const HOST_SUBTYPES = new Set<string>(HOST_CONTROL_REQUEST_SUBTYPES);

/**
 * The reason a subtype is rejected by direction, or `undefined` when it is not
 * rejected by direction.
 *
 * The wording is the target's own.
 */
export function controlRequestDirectionError(subtype: string): string | undefined {
  if (SERVICE_ORIGINATED.has(subtype)) {
    return `${subtype} is sent to a cloud agent by the service, not by a host`;
  }
  if (CLIENT_ORIGINATED.has(subtype)) {
    return `${subtype} is sent to a cloud agent by the attached client, not by a host`;
  }
  if (AGENT_ORIGINATED.has(subtype)) {
    return `${subtype} is agent-originated and cannot be sent by a host`;
  }
  return undefined;
}

/** Whether the host dispatcher handles a subtype. */
export function isHostControlRequestSubtype(subtype: string): subtype is HostControlRequestSubtype {
  return HOST_SUBTYPES.has(subtype);
}

/* -------------------------------------------------------------------------- */
/* The request and the callbacks                                              */
/* -------------------------------------------------------------------------- */

/** A control request. */
export interface ControlRequest {
  /** The request's subtype. */
  subtype: string;
  /** The id the response is correlated by. */
  request_id: string;
  /** The URL the user is sent to, for `mcp_authenticate`. */
  redirectUri?: string;
  /** The URL the OAuth provider sent the user back to. */
  callbackUrl?: string;
  /** Anything else the peer sent. */
  [key: string]: unknown;
}

/** The decision a permission handler returns. */
export interface ControlPermissionDecision {
  /** Whether the call is allowed. */
  behavior: 'allow' | 'deny';
  /** The rewritten tool input, when the handler rewrote it. */
  updatedInput?: unknown;
  /** The message shown to the user. */
  message?: string;
}

/**
 * The callbacks the dispatcher reaches for.
 *
 * The first five members are the plan's. The rest are **additive**: they are
 * the seams this implementation needs to answer the host subtypes and to wire the
 * transport dispatcher in.
 */
export interface ControlCallbacks {
  /**
   * The `mcp_authenticate` handler.
   *
   * The second argument is the request's `redirectUri`; the target's own call
   * shape is `onMcpAuthenticate(request, request.redirectUri)`.
   */
  onMcpAuthenticate?: (req: { redirectUri?: string }, redirectUri?: string) => Promise<unknown>;
  /**
   * The `mcp_oauth_callback_url` handler.
   *
   * The second argument is the request's `callbackUrl`.
   */
  onMcpOauthCallbackUrl?: (req: { callbackUrl?: string }, callbackUrl?: string) => Promise<unknown>;
  /** The `mcp_reconnect` handler. */
  onMcpReconnect?: (req: unknown) => Promise<unknown>;
  /** Notified that a permission request is waiting for a decision. */
  onPermissionRequest?: (req: unknown, requestId: string) => void;
  /** Receives a notice about a rejected control request. */
  onMessage?: (msg: unknown) => void;
  /**
   * The generic **host seam**.
   *
   * The host subtypes that are not MCP-specific are the host's own actions, and
   * this is where they are answered. Without it, the target's "callback not
   * registered" text is the answer.
   */
  onHostRequest?: (
    req: { subtype: HostControlRequestSubtype; request_id: string },
  ) => Promise<unknown> | unknown;
  /**
   * The `mcp_status` handler.
   *
   * Without it the dispatcher answers `{ mcpServers: [] }`, which is the
   * target's reply in the observed context.
   */
  onMcpStatus?: (req: unknown) => Promise<unknown> | unknown;
  /**
   * The `fork_conversation` handler.
   *
   * Without it — or without a remote control server — the dispatcher answers
   * the target's "unsupported" shape.
   */
  onForkConversation?: (req: unknown) => Promise<unknown> | unknown;
  /**
   * The permission decision the transport dispatcher asks for.
   *
   * Without it every well-formed request is **denied**: the transport
   * dispatcher fails closed.
   */
  onPermissionDecision?: (
    req: unknown,
    requestId: string,
  ) => ControlPermissionDecision | Promise<ControlPermissionDecision> | undefined;
  /**
   * The transport permission dispatcher the host already owns.
   *
   * When it is registered, `dispatchCanUseTool` hands the request to it
   * instead of building one.
   */
  transportDispatcher?: TransportPermissionDispatcher;
  /** Whether the host has a remote control server. */
  remoteControlServerAvailable?: boolean;
}

/** The options a dispatch runs with. */
export interface ControlDispatchOptions {
  /** Whether the process is exiting. */
  exiting?: boolean;
}

/** The dispatcher's answer. */
export interface ControlResponse {
  /** Whether the request was carried out. */
  subtype: 'success' | 'error';
  /** The result, for a success. */
  response?: unknown;
  /** The reason, for an error. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* The host dispatcher                                                        */
/* -------------------------------------------------------------------------- */

/** The target's error text for a callback that is not registered. */
export function callbackNotRegisteredError(subtype: string): string {
  return `${subtype} is not supported in this context (callback not registered)`;
}

function errorResponse(
  subtype: string,
  error: string,
  callbacks: ControlCallbacks,
  req: unknown,
): ControlResponse {
  callbacks.onMessage?.({ type: 'control_request_rejected', subtype, error, request: req });
  return { subtype: 'error', error };
}

/**
 * Dispatch a control request the host received.
 *
 * The dispatcher handles exactly the 23 host subtypes, and rejects the
 * agent-originated, the service-originated and the client-originated ones **by
 * direction**.
 */
export async function dispatchControlRequest(
  req: ControlRequest,
  cb: ControlCallbacks,
  opts: ControlDispatchOptions = {},
): Promise<ControlResponse> {
  const subtype = typeof req?.subtype === 'string' ? req.subtype : '';

  // 1. The directional policy. A subtype the target refuses by direction is
  //    refused here, whatever else is registered.
  const directional = controlRequestDirectionError(subtype);
  if (directional !== undefined) {
    return errorResponse(subtype, directional, cb, req);
  }

  // 2. A request that cannot be correlated cannot be answered.
  if (typeof req?.request_id !== 'string') {
    return errorResponse(
      subtype,
      'the request_id is not a string, so no response is possible',
      cb,
      req,
    );
  }

  // 3. A subtype the host dispatcher does not handle.
  if (!isHostControlRequestSubtype(subtype)) {
    return errorResponse(subtype, `${subtype} is not a supported control request subtype`, cb, req);
  }

  // 4. Control requests are rejected while the process is exiting.
  if (opts.exiting === true) {
    return errorResponse(subtype, `${subtype} is not supported while the process is exiting`, cb, req);
  }

  switch (subtype) {
    case 'mcp_authenticate': {
      const handler = cb.onMcpAuthenticate;
      if (!handler) {
        return errorResponse(subtype, callbackNotRegisteredError(subtype), cb, req);
      }
      const redirectUri = typeof req['redirectUri'] === 'string' ? req['redirectUri'] : undefined;
      const result = await handler(req, redirectUri);
      return { subtype: 'success', response: result };
    }

    case 'mcp_oauth_callback_url': {
      const handler = cb.onMcpOauthCallbackUrl;
      if (!handler) {
        return errorResponse(subtype, callbackNotRegisteredError(subtype), cb, req);
      }
      const callbackUrl = typeof req['callbackUrl'] === 'string' ? req['callbackUrl'] : undefined;
      const result = await handler(req, callbackUrl);
      return { subtype: 'success', response: result };
    }

    case 'mcp_reconnect': {
      const handler = cb.onMcpReconnect;
      if (!handler) {
        return errorResponse(subtype, callbackNotRegisteredError(subtype), cb, req);
      }
      const result = await handler(req);
      return { subtype: 'success', response: result };
    }

    case 'mcp_status': {
      // The target's reply in the observed context is an empty server list.
      const result = cb.onMcpStatus ? await cb.onMcpStatus(req) : { mcpServers: [] };
      return { subtype: 'success', response: result };
    }

    case 'fork_conversation': {
      const handler = cb.onForkConversation;
      if (!handler || cb.remoteControlServerAvailable !== true) {
        return {
          subtype: 'success',
          response: {
            forked: false,
            error: 'unsupported',
            reason: 'requires_remote_control_server',
          },
        };
      }
      const result = await handler(req);
      return { subtype: 'success', response: result };
    }

    default: {
      const handler = cb.onHostRequest;
      if (!handler) {
        return errorResponse(subtype, callbackNotRegisteredError(subtype), cb, req);
      }
      const result = await handler({ subtype, request_id: req.request_id });
      return { subtype: 'success', response: result };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The transport permission dispatcher seam                                   */
/* -------------------------------------------------------------------------- */

/** A `can_use_tool` request. */
export interface CanUseToolControlRequest {
  /** The request's subtype, when the caller carries one. */
  subtype?: unknown;
  /** The id the response is correlated by. */
  request_id: unknown;
  /** The tool the agent wants to call. */
  tool_name: string;
  /** The tool's input. */
  input: unknown;
  /** The description the peer gave. */
  description?: string;
  /** The reason the peer gave. */
  decision_reason?: string;
}

/** The outcome of dispatching one `can_use_tool` request. */
export interface CanUseToolDispatchResult {
  /** Whether the request was dropped, so no response is sent. */
  dropped: boolean;
  /** Why it was dropped. */
  reason?: string;
}

/**
 * The transport dispatchers the control surface built.
 *
 * The dispatcher is cached per callback set, so its own in-flight bookkeeping
 * survives across the calls that share it.
 */
const transportDispatchers = new WeakMap<ControlCallbacks, TransportPermissionDispatcher>();

function transportDispatcherFor(cb: ControlCallbacks): TransportPermissionDispatcher {
  const existing = transportDispatchers.get(cb);
  if (existing) return existing;
  const dispatcher = createTransportPermissionDispatcher({
    requestDecision: async (request) => {
      cb.onPermissionRequest?.(request, request.request_id);
      const decision = await cb.onPermissionDecision?.(request, request.request_id);
      if (!decision) {
        return { behavior: 'deny', message: 'No permission handler is available.' };
      }
      return decision;
    },
  });
  transportDispatchers.set(cb, dispatcher);
  return dispatcher;
}

/**
 * Dispatch a `can_use_tool` request to the **transport permission dispatcher**.
 *
 * A request whose `request_id` is not a string is dropped with **no response**,
 * because no response is possible: the response could not be correlated.
 * Everything else is handed to the transport dispatcher, which owns the
 * validation, the deduplication and the denial of a malformed request.
 */
export async function dispatchCanUseTool(
  req: CanUseToolControlRequest,
  cb: ControlCallbacks,
): Promise<CanUseToolDispatchResult> {
  const requestId = req?.request_id;
  if (typeof requestId !== 'string') {
    return {
      dropped: true,
      reason: 'the request_id is not a string, so no response is possible',
    };
  }

  // A request that carries another subtype is not a can_use_tool request, and
  // the transport dispatcher refuses it.
  if (req.subtype !== undefined && req.subtype !== 'can_use_tool') {
    return { dropped: true, reason: 'the control-request subtype is not can_use_tool' };
  }

  const dispatcher = cb.transportDispatcher ?? transportDispatcherFor(cb);

  const result = await dispatcher.dispatch({
    subtype: 'can_use_tool',
    request_id: requestId,
    tool_name: req.tool_name,
    input: req.input,
    description: req.description,
    decision_reason: req.decision_reason,
  });

  if (result.kind === 'dropped') {
    return { dropped: true, reason: result.reason };
  }
  return { dropped: false };
}
