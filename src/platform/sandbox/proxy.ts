/**
 * The network layer: the host-side proxy.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9, the research report
 * §7, and the `CC-017` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The sandbox has no network.** The launcher creates a network namespace without
 * a single interface, so the sandboxed process cannot open a socket to anything.
 * The only way out is a Unix socket that the launcher bind-mounts into the
 * sandbox, and that socket is served by the proxy **on the host**.
 *
 * **What the proxy enforces.**
 *
 *   - the **domain allowlist**: a host that is not on it is refused;
 *   - the **address classes**: a host that resolves to a loopback, a link-local or
 *     a cloud-metadata address is refused, whatever the allowlist says — that is
 *     the class the target's own sandbox is exposed to through a rebinding name;
 *   - the **address pinning**: the proxy connects to the address it resolved and
 *     validated, not to whatever the name resolves to a second later.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - A **private** address (RFC 1918, and the IPv6 unique-local range) is refused
 *     as well. The plan requires the three named classes; refusing the private
 *     ranges too is the fail-safe reading, and `blockPrivateAddresses: false` turns
 *     it off for a host that must reach an intranet service.
 *   - An **empty allowlist refuses everything.** The allowlist is a whitelist, and
 *     an empty whitelist means "nothing is allowed".
 *   - The proxy speaks the HTTP proxy protocol over the Unix socket: `CONNECT` for
 *     a tunnelled request and an absolute-URI request for a plain one.
 *   - The socket lives in a **private directory** of its own (mode `0700`), never
 *     directly in the world-writable temporary directory: a socket another local
 *     user can reach is a way into the sandbox, and a predictable name in a
 *     world-writable directory can be pre-created to break the launch.
 *
 * **The residual risk.** The proxy is a policy point, not a boundary: the sandbox
 * reaches it over a bind-mounted Unix socket, and the socket is the only way out
 * of the network namespace. A kernel privilege escalation reachable from the
 * sandbox defeats the layer, and unprivileged user namespaces widen the reachable
 * surface. Only a microVM moves the boundary below the kernel.
 */

import { lookup } from 'node:dns/promises';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** How an address is classified. */
export type AddressClass =
  | 'loopback'
  | 'link-local'
  | 'cloud-metadata'
  | 'private'
  | 'unique-local'
  | 'public'
  | 'invalid';

/** The addresses the cloud metadata services answer on. */
export const CLOUD_METADATA_ADDRESSES: readonly string[] = Object.freeze([
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

/** The host names the cloud metadata services answer on. */
export const CLOUD_METADATA_HOSTNAMES: readonly string[] = Object.freeze([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.internal',
]);

/**
 * Classify an address.
 *
 * The classes the proxy refuses are the loopback, the link-local and the
 * cloud-metadata ranges; the private and the unique-local ranges are refused too
 * unless the policy says otherwise.
 *
 * An **IPv4-mapped IPv6 address** is classified by the IPv4 address it carries:
 * `0:0:0:0:0:ffff:7f00:1` and `::ffff:127.0.0.1` are the same address, and both
 * are the loopback. The IPv4-compatible form (`::127.0.0.1`) is classified the
 * same way.
 */
export function classifyAddress(address: string): AddressClass {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (CLOUD_METADATA_ADDRESSES.includes(normalized)) return 'cloud-metadata';

  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) {
    return classifyIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6 !== undefined) {
    return classifyIpv6(ipv6);
  }

  return 'invalid';
}

/** Classify a dotted-quad IPv4 address. */
function classifyIpv4(ipv4: readonly number[]): AddressClass {
  const [a = 0, b = 0] = ipv4;
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 0) return 'invalid';
  return 'public';
}

/** Classify the eight groups of an IPv6 address. */
function classifyIpv6(ipv6: readonly number[]): AddressClass {
  if (ipv6.every((part) => part === 0)) return 'invalid';
  if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1) return 'loopback';

  // An IPv4-mapped address (`::ffff:a.b.c.d`) carries an IPv4 address in its
  // last two groups: it is classified by that address, never as a public one.
  if (ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff) {
    return classifyIpv4([(ipv6[6] ?? 0) >> 8, (ipv6[6] ?? 0) & 0xff, (ipv6[7] ?? 0) >> 8, (ipv6[7] ?? 0) & 0xff]);
  }

  // The IPv4-compatible form (`::a.b.c.d`) carries one the same way.
  if (ipv6.slice(0, 6).every((part) => part === 0)) {
    return classifyIpv4([(ipv6[6] ?? 0) >> 8, (ipv6[6] ?? 0) & 0xff, (ipv6[7] ?? 0) >> 8, (ipv6[7] ?? 0) & 0xff]);
  }

  if (((ipv6[0] ?? 0) & 0xffc0) === 0xfe80) return 'link-local';
  if (((ipv6[0] ?? 0) & 0xfe00) === 0xfc00) return 'unique-local';
  return 'public';
}

/** Whether an address is in one of the ranges the proxy always refuses. */
export function isBlockedAddress(address: string): boolean {
  const classification = classifyAddress(address);
  return (
    classification === 'loopback' ||
    classification === 'link-local' ||
    classification === 'cloud-metadata'
  );
}

/** Parse a dotted-quad IPv4 address. */
function parseIpv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number.parseInt(part, 10);
    if (value > 255) return undefined;
    numbers.push(value);
  }
  return numbers;
}

/** Parse an IPv6 address into its eight 16-bit groups. */
function parseIpv6(address: string): number[] | undefined {
  if (!address.includes(':')) return undefined;

  // The IPv4-compatible and the IPv4-mapped forms may spell their last four
  // bytes as a dotted quad (`::ffff:127.0.0.1`).
  let text = address;
  let tailGroups: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const embedded = parseIpv4(text.slice(lastColon + 1));
    if (embedded === undefined) return undefined;
    text = text.slice(0, lastColon + 1);
    tailGroups = [(embedded[0] ?? 0) << 8 | (embedded[1] ?? 0), (embedded[2] ?? 0) << 8 | (embedded[3] ?? 0)];
  }

  const [head = '', tail] = text.split('::');
  const headGroups = head.length > 0 ? head.split(':').filter((part) => part.length > 0) : [];
  const tailParts = tail === undefined ? [] : tail.split(':').filter((part) => part.length > 0);
  const groups: number[] = [];
  for (const group of headGroups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    groups.push(Number.parseInt(group, 16));
  }
  const missing = 8 - groups.length - tailParts.length - tailGroups.length;
  if (tail === undefined) {
    if (missing !== 0) return undefined;
  } else if (missing < 1) {
    return undefined;
  }
  for (let index = 0; index < missing; index += 1) groups.push(0);
  for (const group of tailParts) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    groups.push(Number.parseInt(group, 16));
  }
  groups.push(...tailGroups);
  return groups.length === 8 ? groups : undefined;
}

/** The policy the proxy enforces. */
export interface ProxyPolicy {
  /** The hosts the sandbox may reach. `'*'` allows every host. */
  allowedDomains: readonly string[];
  /** The ports the sandbox may reach; every port when the list is empty. */
  allowedPorts?: readonly number[];
  /** Whether the private address ranges are refused too. */
  blockPrivateAddresses?: boolean;
}

/** The decision about one request. */
export interface ProxyTargetDecision {
  /** Whether the request may go out. */
  allowed: boolean;
  /** Why it was refused. */
  reason?: string;
  /** The host the request named. */
  host?: string;
  /** The address the request is pinned to. */
  address?: string;
  /** The port the request named. */
  port?: number;
}

/**
 * Decide whether a request may go out.
 *
 * The address is checked before the allowlist: a name that resolves to a blocked
 * address is refused whatever the allowlist says.
 */
export function evaluateProxyTarget(input: {
  host: string;
  port: number;
  addresses: readonly string[];
  policy: ProxyPolicy;
}): ProxyTargetDecision {
  const { host, port, addresses, policy } = input;

  const ports = policy.allowedPorts ?? [];
  if (ports.length > 0 && !ports.includes(port)) {
    return { allowed: false, reason: `the port ${port} is not in the allowlist`, host, port };
  }

  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '');
  if (CLOUD_METADATA_HOSTNAMES.includes(normalizedHost)) {
    return {
      allowed: false,
      reason: `the host ${host} is a cloud-metadata name, which is never reachable from the sandbox`,
      host,
      port,
    };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `the host ${host} does not resolve`, host, port };
  }

  for (const address of addresses) {
    const classification = classifyAddress(address);
    if (
      classification === 'loopback' ||
      classification === 'link-local' ||
      classification === 'cloud-metadata'
    ) {
      return {
        allowed: false,
        reason: `the host ${host} resolves to ${address}, which is a ${classification} address`,
        host,
        port,
      };
    }
    if (
      (classification === 'private' || classification === 'unique-local') &&
      (policy.blockPrivateAddresses ?? true)
    ) {
      return {
        allowed: false,
        reason: `the host ${host} resolves to ${address}, which is a ${classification} address`,
        host,
        port,
      };
    }
    if (classification === 'invalid') {
      return {
        allowed: false,
        reason: `the host ${host} resolves to ${address}, which is not a usable address`,
        host,
        port,
      };
    }
  }

  if (!hostIsAllowed(host, addresses, policy.allowedDomains)) {
    return {
      allowed: false,
      reason: `the host ${host} is not in the allowlist`,
      host,
      port,
    };
  }

  return { allowed: true, host, address: addresses[0], port };
}

/** Whether a host is covered by the allowlist. */
function hostIsAllowed(
  host: string,
  addresses: readonly string[],
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return false;
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  for (const entry of allowedDomains) {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) continue;
    if (candidate === '*') return true;
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1);
      if (normalized.endsWith(suffix)) return true;
      continue;
    }
    if (normalized === candidate || normalized.endsWith(`.${candidate}`)) return true;
    if (addresses.includes(candidate)) return true;
  }
  return false;
}

/** One request the proxy handled. */
export interface ProxyRequestRecord {
  /** The method of the request. */
  method: string;
  /** The host the request named. */
  host: string;
  /** The port the request named. */
  port: number;
  /** Whether the proxy let it out. */
  allowed: boolean;
  /** Why the proxy refused it. */
  reason?: string;
}

/** The proxy. */
export interface SandboxProxy {
  /** The path of the Unix socket the sandbox connects to. */
  readonly socketPath: string;
  /** The requests the proxy handled. */
  readonly requests: readonly ProxyRequestRecord[];
  /** Stop the proxy and remove its socket. */
  close(): Promise<void>;
}

/** The options of the proxy. */
export interface SandboxProxyOptions {
  /** The policy the proxy enforces. */
  policy: ProxyPolicy;
  /** The path of the Unix socket; a temporary one when it is not supplied. */
  socketPath?: string;
  /** The resolver; the system one when it is not supplied. */
  resolve?: (host: string) => Promise<readonly string[]>;
}

let socketCounter = 0;

/**
 * Start the proxy.
 *
 * The proxy listens on a Unix socket. The launcher bind-mounts that socket into the
 * sandbox, so the sandboxed process reaches the proxy over the filesystem and not
 * over the network.
 *
 * The socket lives in a **private directory** (mode `0700`) of its own: a socket
 * in a world-writable directory can be connected to by another local user, and
 * its predictable name can be pre-created to break the launch. A caller that
 * names its own socket path gets that path unchanged.
 */
export async function createSandboxProxy(options: SandboxProxyOptions): Promise<SandboxProxy> {
  socketCounter += 1;
  let directory: string | undefined;
  let socketPath: string;
  if (options.socketPath !== undefined) {
    socketPath = options.socketPath;
  } else {
    directory = mkdtempSync(path.join(tmpdir(), 'agent-sandbox-proxy-'));
    chmodSync(directory, 0o700);
    socketPath = path.join(directory, `proxy-${process.pid}-${socketCounter}.sock`);
  }
  const resolveHost = options.resolve ?? defaultResolve;
  const requests: ProxyRequestRecord[] = [];

  const server = net.createServer((socket) => {
    handleConnection(socket, options.policy, resolveHost, requests);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  // The socket itself is only reachable by its owner.
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // The socket is already gone; nothing to protect.
  }

  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Resolve a host with the system resolver. */
async function defaultResolve(host: string): Promise<readonly string[]> {
  const entries = await lookup(host, { all: true });
  return entries.map((entry) => entry.address);
}

/** Read the head of an HTTP request. */
function readHead(socket: net.Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let data = '';
    const onData = (chunk: Buffer): void => {
      data += chunk.toString('utf8');
      const end = data.indexOf('\r\n\r\n');
      if (end !== -1) {
        socket.removeListener('data', onData);
        resolve(data.slice(0, end));
      }
      if (data.length > 64 * 1024) {
        socket.removeListener('data', onData);
        resolve(undefined);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => resolve(undefined));
    socket.on('close', () => resolve(undefined));
  });
}

/** Handle one client connection. */
async function handleConnection(
  socket: net.Socket,
  policy: ProxyPolicy,
  resolveHost: (host: string) => Promise<readonly string[]>,
  requests: ProxyRequestRecord[],
): Promise<void> {
  const head = await readHead(socket);
  if (head === undefined) {
    socket.destroy();
    return;
  }
  const [requestLine = ''] = head.split('\r\n');
  const [method = '', target = ''] = requestLine.split(' ');
  const { host, port } = parseTarget(method, target);

  if (host === undefined || port === undefined) {
    requests.push({ method, host: host ?? '', port: port ?? 0, allowed: false, reason: 'the request names no host' });
    refuse(socket, 'the request names no host');
    return;
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHost(host);
  } catch (error) {
    const reason = `the host ${host} does not resolve: ${error instanceof Error ? error.message : String(error)}`;
    requests.push({ method, host, port, allowed: false, reason });
    refuse(socket, reason);
    return;
  }

  const decision = evaluateProxyTarget({ host, port, addresses, policy });
  requests.push({ method, host, port, allowed: decision.allowed, ...(decision.reason === undefined ? {} : { reason: decision.reason }) });
  if (!decision.allowed) {
    refuse(socket, decision.reason ?? 'the request was refused');
    return;
  }

  const address = decision.address ?? addresses[0] ?? host;
  if (method.toUpperCase() === 'CONNECT') {
    const upstream = net.connect({ host: address, port });
    upstream.on('error', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      upstream.destroy();
    });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.pipe(upstream);
    upstream.pipe(socket);
    return;
  }

  forward(socket, method, target, head, address, port);
}

/** Parse the host and the port out of a request line. */
function parseTarget(
  method: string,
  target: string,
): { host: string | undefined; port: number | undefined } {
  if (method.toUpperCase() === 'CONNECT') {
    const separator = target.lastIndexOf(':');
    if (separator === -1) return { host: undefined, port: undefined };
    const host = target.slice(0, separator).replace(/^\[|\]$/g, '');
    const port = Number.parseInt(target.slice(separator + 1), 10);
    return Number.isFinite(port) ? { host, port } : { host: undefined, port: undefined };
  }
  try {
    const url = new URL(target);
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port === '' ? 80 : Number.parseInt(url.port, 10),
    };
  } catch {
    return { host: undefined, port: undefined };
  }
}

/** Refuse a request. */
function refuse(socket: net.Socket, reason: string): void {
  const body = JSON.stringify({ error: 'proxy_refused', reason });
  socket.end(
    [
      'HTTP/1.1 403 Forbidden',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
}

/** Forward a plain HTTP request to the pinned address. */
function forward(
  socket: net.Socket,
  method: string,
  target: string,
  head: string,
  address: string,
  port: number,
): void {
  const lines = head.split('\r\n').slice(1);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  const url = new URL(target);
  const upstream = http.request(
    {
      host: address,
      port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, host: url.host },
    },
    (response) => {
      const status = response.statusCode ?? 502;
      const statusText = response.statusMessage ?? 'Bad Gateway';
      socket.write(`HTTP/1.1 ${status} ${statusText}\r\n`);
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        socket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
      }
      socket.write('\r\n');
      response.pipe(socket);
    },
  );
  upstream.on('error', () => {
    socket.destroy();
  });
  socket.on('error', () => {
    upstream.destroy();
  });
  socket.pipe(upstream);
}
