/**
 * Contract test for the control-request surface.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "Control-request surface" and "Directional policy"), and the `CC-011`
 * milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins the two things the target's REA evidence keeps apart:
 *
 *   - the **host control dispatcher**, which handles exactly the 23 host
 *     subtypes and rejects the agent-originated ones **by direction** — and
 *     `can_use_tool` is one of them;
 *   - the **transport permission dispatcher**, which already lives in
 *     `src/permissions/prompts.ts` and is *wired in* rather than duplicated.
 *
 * The callback-absence error, the `mcp_status` reply and the `fork_conversation`
 * reply are the target's, verbatim.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_ORIGINATED_CONTROL_SUBTYPES,
  CLIENT_ORIGINATED_CONTROL_SUBTYPES,
  CONTROL_REQUEST_SUBTYPES,
  HOST_CONTROL_REQUEST_SUBTYPES,
  SERVICE_ORIGINATED_CONTROL_SUBTYPES,
  controlRequestDirectionError,
  dispatchCanUseTool,
  dispatchControlRequest,
  type ControlCallbacks,
  type ControlRequest,
} from '../../src/extensions/mcp/control.js';

/** The 23 subtypes the target's host dispatcher handles. */
const EXPECTED_SUBTYPES: readonly string[] = [
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
];

function request(subtype: string, extra: Partial<ControlRequest> = {}): ControlRequest {
  return { subtype, request_id: `req-${subtype}`, ...extra };
}

/** Callbacks with every host seam registered. */
function fullCallbacks(overrides: ControlCallbacks = {}): ControlCallbacks {
  return {
    onMcpAuthenticate: vi.fn(async (_req: { redirectUri?: string }, _redirectUri?: string) => ({
      ok: true,
    })),
    onMcpOauthCallbackUrl: vi.fn(async (_req: { callbackUrl?: string }, _callbackUrl?: string) => ({
      ok: true,
    })),
    onMcpReconnect: vi.fn(async (_req: unknown) => ({ ok: true })),
    onHostRequest: vi.fn(async (_req: { subtype: string; request_id: string }) => ({ ok: true })),
    onPermissionRequest: vi.fn(),
    ...overrides,
  };
}

describe('the control-request subtype list', () => {
  it('is exactly the 23 host subtypes', () => {
    expect(CONTROL_REQUEST_SUBTYPES).toHaveLength(23);
    expect([...CONTROL_REQUEST_SUBTYPES]).toEqual([...EXPECTED_SUBTYPES]);
    expect([...HOST_CONTROL_REQUEST_SUBTYPES]).toEqual([...EXPECTED_SUBTYPES]);
  });

  it('does not contain can_use_tool', () => {
    expect(CONTROL_REQUEST_SUBTYPES).not.toContain('can_use_tool');
    expect(HOST_CONTROL_REQUEST_SUBTYPES).not.toContain('can_use_tool');
  });

  it('does not contain the agent-originated subtypes', () => {
    for (const subtype of AGENT_ORIGINATED_CONTROL_SUBTYPES) {
      expect(CONTROL_REQUEST_SUBTYPES).not.toContain(subtype);
    }
    for (const subtype of SERVICE_ORIGINATED_CONTROL_SUBTYPES) {
      expect(CONTROL_REQUEST_SUBTYPES).not.toContain(subtype);
    }
    for (const subtype of CLIENT_ORIGINATED_CONTROL_SUBTYPES) {
      expect(CONTROL_REQUEST_SUBTYPES).not.toContain(subtype);
    }
  });
});

describe('the host control dispatcher', () => {
  it('handles each of the 23 host subtypes', async () => {
    const callbacks = fullCallbacks();

    for (const subtype of EXPECTED_SUBTYPES) {
      const response = await dispatchControlRequest(request(subtype), callbacks);
      expect(response.subtype, subtype).toBe('success');
    }
  });

  it('routes mcp_authenticate to the registered callback', async () => {
    const onMcpAuthenticate = vi.fn(
      async (_req: { redirectUri?: string }, _redirectUri?: string) => ({ authenticated: true }),
    );
    const response = await dispatchControlRequest(
      request('mcp_authenticate', { redirectUri: 'https://example.com/authorize' }),
      { onMcpAuthenticate },
    );

    expect(response.subtype).toBe('success');
    expect(response.response).toEqual({ authenticated: true });
    expect(onMcpAuthenticate).toHaveBeenCalledTimes(1);
    const call = onMcpAuthenticate.mock.calls[0];
    expect(call?.[0]).toMatchObject({ subtype: 'mcp_authenticate' });
    expect(call?.[1]).toBe('https://example.com/authorize');
  });

  it('routes mcp_oauth_callback_url to the registered callback', async () => {
    const onMcpOauthCallbackUrl = vi.fn(
      async (_req: { callbackUrl?: string }, _callbackUrl?: string) => ({ received: true }),
    );
    const response = await dispatchControlRequest(
      request('mcp_oauth_callback_url', { callbackUrl: 'https://example.com/callback' }),
      { onMcpOauthCallbackUrl },
    );

    expect(response.subtype).toBe('success');
    expect(onMcpOauthCallbackUrl).toHaveBeenCalledTimes(1);
    const call = onMcpOauthCallbackUrl.mock.calls[0];
    expect(call?.[1]).toBe('https://example.com/callback');
  });

  it('routes mcp_reconnect to the registered callback', async () => {
    const onMcpReconnect = vi.fn(async (_req: unknown) => ({ reconnected: true }));
    const response = await dispatchControlRequest(request('mcp_reconnect'), { onMcpReconnect });

    expect(response.subtype).toBe('success');
    expect(response.response).toEqual({ reconnected: true });
    expect(onMcpReconnect).toHaveBeenCalledTimes(1);
  });

  it('answers mcp_status with an empty server list in the observed context', async () => {
    const response = await dispatchControlRequest(request('mcp_status'), fullCallbacks());
    expect(response.subtype).toBe('success');
    expect(response.response).toEqual({ mcpServers: [] });
  });

  it('answers fork_conversation with the unsupported shape when the remote control server is absent', async () => {
    const response = await dispatchControlRequest(request('fork_conversation'), fullCallbacks());
    expect(response.subtype).toBe('success');
    expect(response.response).toEqual({
      forked: false,
      error: 'unsupported',
      reason: 'requires_remote_control_server',
    });
  });

  it('reports the target error text when a required callback is not registered', async () => {
    const response = await dispatchControlRequest(request('mcp_authenticate'), {});
    expect(response.subtype).toBe('error');
    expect(response.error).toBe('mcp_authenticate is not supported in this context (callback not registered)');
    expect(Object.keys(response).sort()).toEqual(['error', 'subtype']);
  });

  it('reports the same error text for the other callback-bound subtypes', async () => {
    const oauth = await dispatchControlRequest(request('mcp_oauth_callback_url'), {});
    expect(oauth.error).toBe(
      'mcp_oauth_callback_url is not supported in this context (callback not registered)',
    );

    const reconnect = await dispatchControlRequest(request('mcp_reconnect'), {});
    expect(reconnect.error).toBe(
      'mcp_reconnect is not supported in this context (callback not registered)',
    );
  });

  it('rejects can_use_tool as a host-originated request', async () => {
    const callbacks = fullCallbacks();
    const response = await dispatchControlRequest(request('can_use_tool'), callbacks);

    expect(response.subtype).toBe('error');
    expect(response.error).toBe('can_use_tool is agent-originated and cannot be sent by a host');
    expect(callbacks.onHostRequest).not.toHaveBeenCalled();
    expect(callbacks.onPermissionRequest).not.toHaveBeenCalled();
  });

  it('rejects the service-originated and client-originated subtypes by direction', async () => {
    const service = await dispatchControlRequest(request('mcp_tasks_changed'), fullCallbacks());
    expect(service.error).toBe('mcp_tasks_changed is sent to a cloud agent by the service, not by a host');

    for (const subtype of CLIENT_ORIGINATED_CONTROL_SUBTYPES) {
      const response = await dispatchControlRequest(request(subtype), fullCallbacks());
      expect(response.error).toBe(
        `${subtype} is sent to a cloud agent by the attached client, not by a host`,
      );
    }
  });

  it('rejects every agent-originated subtype by direction', async () => {
    expect([...AGENT_ORIGINATED_CONTROL_SUBTYPES]).toEqual([
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
    ]);

    for (const subtype of AGENT_ORIGINATED_CONTROL_SUBTYPES) {
      const response = await dispatchControlRequest(request(subtype), fullCallbacks());
      expect(response.subtype, subtype).toBe('error');
      expect(response.error, subtype).toBe(
        `${subtype} is agent-originated and cannot be sent by a host`,
      );
    }
  });

  it('names the direction of a subtype', () => {
    expect(controlRequestDirectionError('can_use_tool')).toBe(
      'can_use_tool is agent-originated and cannot be sent by a host',
    );
    expect(controlRequestDirectionError('mcp_tasks_changed')).toBe(
      'mcp_tasks_changed is sent to a cloud agent by the service, not by a host',
    );
    expect(controlRequestDirectionError('initialize')).toBeUndefined();
  });

  it('rejects an unknown subtype', async () => {
    const response = await dispatchControlRequest(request('not_a_subtype'), fullCallbacks());
    expect(response.subtype).toBe('error');
    expect(response.error).toContain('not_a_subtype');
  });

  it('does not treat an Object.prototype member name as a known subtype', async () => {
    for (const subtype of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const response = await dispatchControlRequest(request(subtype), fullCallbacks());
      expect(response.subtype, subtype).toBe('error');
      expect(response.error, subtype).toContain('is not a supported control request subtype');
    }
  });

  it('rejects a request whose request_id is not a string', async () => {
    const response = await dispatchControlRequest(
      { subtype: 'initialize', request_id: 42 as unknown as string },
      fullCallbacks(),
    );
    expect(response.subtype).toBe('error');
    expect(response.error).toContain('request_id');
  });

  it('rejects a control request while the process is exiting', async () => {
    const response = await dispatchControlRequest(request('initialize'), fullCallbacks(), {
      exiting: true,
    });
    expect(response.subtype).toBe('error');
    expect(response.error).toContain('exiting');
  });
});

describe('the transport permission dispatcher', () => {
  it('drops a can_use_tool request whose request_id is not a string, with no response', async () => {
    const onPermissionRequest = vi.fn();
    const onPermissionDecision = vi.fn();

    const result = await dispatchCanUseTool(
      {
        request_id: 42,
        tool_name: 'Bash',
        input: { command: 'ls' },
      },
      { onPermissionRequest, onPermissionDecision },
    );

    expect(result).toEqual({ dropped: true, reason: expect.stringContaining('request_id') });
    // No response is possible, so nothing is dispatched and nothing is decided.
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(onPermissionDecision).not.toHaveBeenCalled();
  });

  it('drops a can_use_tool request whose request_id is missing', async () => {
    const result = await dispatchCanUseTool(
      { request_id: undefined, tool_name: 'Bash', input: {} },
      {},
    );
    expect(result.dropped).toBe(true);
  });

  it('dispatches a well-formed can_use_tool request', async () => {
    const onPermissionRequest = vi.fn();
    const onPermissionDecision = vi.fn(async () => ({ behavior: 'allow' as const }));

    const result = await dispatchCanUseTool(
      {
        request_id: 'req-1',
        tool_name: 'Bash',
        input: { command: 'ls' },
        description: 'list files',
        decision_reason: 'the model asked for it',
      },
      { onPermissionRequest, onPermissionDecision },
    );

    expect(result.dropped).toBe(false);
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    const [req, requestId] = onPermissionRequest.mock.calls[0] ?? [];
    expect(requestId).toBe('req-1');
    expect(req).toMatchObject({ tool_name: 'Bash' });
    expect(onPermissionDecision).toHaveBeenCalledTimes(1);
  });

  it('denies a can_use_tool request when no decision handler is registered', async () => {
    const result = await dispatchCanUseTool(
      { request_id: 'req-2', tool_name: 'Bash', input: {} },
      {},
    );
    // A denial is still a response, so the request is not dropped.
    expect(result.dropped).toBe(false);
  });

  it('drops a request that carries another subtype', async () => {
    const result = await dispatchCanUseTool(
      { subtype: 'initialize', request_id: 'req-3', tool_name: 'Bash', input: {} },
      {},
    );
    expect(result.dropped).toBe(true);
  });

  it('does not dispatch the same request id twice', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onPermissionDecision = vi.fn(async () => {
      await gate;
      return { behavior: 'deny' as const };
    });
    const callbacks: ControlCallbacks = { onPermissionDecision };

    const first = dispatchCanUseTool(
      { request_id: 'req-4', tool_name: 'Bash', input: {} },
      callbacks,
    );
    const second = await dispatchCanUseTool(
      { request_id: 'req-4', tool_name: 'Bash', input: {} },
      callbacks,
    );

    expect(second.dropped).toBe(true);
    release?.();
    await first;
  });
});

describe('the two dispatchers', () => {
  it('keeps the host dispatcher and the transport dispatcher apart', async () => {
    const hostCallbacks = fullCallbacks();

    // The host dispatcher refuses can_use_tool.
    const host = await dispatchControlRequest(request('can_use_tool'), hostCallbacks);
    expect(host.subtype).toBe('error');

    // The host dispatcher never reaches the permission seam.
    expect(hostCallbacks.onPermissionRequest).not.toHaveBeenCalled();

    // The transport dispatcher handles it.
    const transportCallbacks: ControlCallbacks = {
      onPermissionRequest: vi.fn(),
      onPermissionDecision: vi.fn(async () => ({ behavior: 'allow' as const })),
    };
    const transport = await dispatchCanUseTool(
      { request_id: 'req-5', tool_name: 'Bash', input: {} },
      transportCallbacks,
    );
    expect(transport.dropped).toBe(false);
    expect(transportCallbacks.onPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it('does not let the host dispatcher answer a transport request', async () => {
    const response = await dispatchControlRequest(request('hook_callback'), fullCallbacks());
    expect(response.subtype).toBe('error');
    expect(response.error).toBe('hook_callback is agent-originated and cannot be sent by a host');
  });
});
