// The client side of the stack test (deploy/test/stack.test.mjs). CI AND LOCAL TESTS ONLY.
//
// Runs inside the `probe` service of deploy/docker-compose.ci.yml (profile `test`): a container
// on the edge network next to caddy. It plays Cloudflare: on a server only Cloudflare reaches the
// edge, presenting the client certificate of Authenticated Origin Pulls and sending the visitor's
// address in CF-Connecting-IP. It talks to caddy and nothing else.
//
//   node probe.mjs --idle     keeps the container running (the test runs the requests with exec)
//   node probe.mjs            reads one JSON job on stdin, sends its requests, prints one JSON
//                             result on stdout
//
// A job: { tls: { ca, identities: { cloudflare: { cert, key }, other: { cert, key } } },
//          requests: [request, ...] }
// `tls` holds the throw-away PEMs of this run (deploy/test/throwaway-pki.sh): the CA that signed
// the edge's origin certificate, and client certificates. A request:
//   { method = 'GET', path, headers = {}, body?: string, bodyBase64?: string, repeat?: n,
//     concurrency?: n, identity = 'cloudflare' | 'other' | 'none', servername?: string | null }
// or { connect: port } for a bare TCP connection to caddy (open or refused, nothing sent).
// `identity` is the client certificate presented ('none': no certificate). `servername` is the
// TLS server name, DOMAIN by default; null sends none. With DOMAIN the edge's certificate is
// verified against the run's CA, the way Cloudflare's Full (strict) mode does; with any other
// name it is not, because only the edge's answer to the handshake is under test. `path` is sent
// exactly as written (no clean-up of `..`, `//` or escapes). With `repeat`, the same request is
// sent n times (`concurrency` at once) and only the statuses come back.
// A result: { address, results: [{ status, headers, body, bodyBytes, bodySha256, certSha256 } |
//   { statuses: [...] } | { connected } | { error }] }. `body` is the first 64 KiB as UTF-8 text;
// `certSha256` is the fingerprint of the certificate the edge presented. The test never prints a
// body that may hold a token.
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';

const EDGE_HOST = 'caddy';
const BODY_LIMIT = 64 * 1024;

const domain = process.env.DOMAIN;

/** The probe's IPv4 addresses (one per network it sits on). */
function ownAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const agents = new Map();

/** One keep-alive agent per client certificate and server name. */
function agentFor(tls, identity, servername) {
  const id = `${identity}|${servername ?? ''}`;
  if (!agents.has(id)) {
    const client = identity === 'none' ? {} : tls?.identities?.[identity];
    if (!client) throw new Error(`no client certificate "${identity}" in the job`);
    agents.set(id, new https.Agent({
      keepAlive: true,
      maxSockets: 16,
      ca: tls.ca,
      cert: client.cert,
      key: client.key,
      rejectUnauthorized: servername === domain,
    }));
  }
  return agents.get(id);
}

/** A bare TCP connection to caddy: does anything listen on `port`? */
function connect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: EDGE_HOST, port });
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')));
    socket.on('connect', () => {
      socket.destroy();
      resolve({ connected: true });
    });
    socket.on('error', (err) => resolve({ connected: false, error: err.code ?? err.message }));
  });
}

/** One request to caddy; resolves with the answer or { error }. */
function send(tls, spec) {
  const body = spec.bodyBase64 !== undefined
    ? Buffer.from(spec.bodyBase64, 'base64')
    : spec.body !== undefined ? Buffer.from(String(spec.body), 'utf8') : null;
  const headers = { Host: domain, ...(spec.headers ?? {}) };
  if (body) headers['Content-Length'] = String(body.length);
  const identity = spec.identity ?? 'cloudflare';
  const servername = spec.servername === undefined ? domain : spec.servername;
  const options = {
    host: EDGE_HOST,
    port: 443,
    method: spec.method ?? 'GET',
    path: spec.path,
    headers,
    agent: agentFor(tls, identity, servername),
    // '' sends no server name at all.
    servername: servername ?? '',
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      let size = 0;
      const hash = crypto.createHash('sha256');
      const cert = res.socket?.getPeerCertificate?.();
      res.on('data', (chunk) => {
        hash.update(chunk);
        if (size < BODY_LIMIT) chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).subarray(0, BODY_LIMIT).toString('utf8'),
        bodyBytes: size,
        bodySha256: hash.digest('hex'),
        certSha256: cert?.fingerprint256,
      }));
      res.on('error', (err) => resolve({ error: err.code ?? err.message }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ error: err.code ?? err.message }));
    req.end(body ?? undefined);
  });
}

/** The same request `repeat` times, `concurrency` at once: the statuses in sending order. */
async function burst(tls, spec) {
  const statuses = new Array(spec.repeat);
  let next = 0;
  const worker = async () => {
    while (next < spec.repeat) {
      const i = next;
      next += 1;
      const r = await send(tls, spec);
      statuses[i] = r.error ? `error:${r.error}` : r.status;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, spec.concurrency ?? 1) }, worker));
  return { statuses };
}

async function runJob(job) {
  const results = [];
  for (const spec of job.requests ?? []) {
    if (spec.connect !== undefined) results.push(await connect(spec.connect));
    else results.push(spec.repeat ? await burst(job.tls, spec) : await send(job.tls, spec));
  }
  return { address: ownAddresses(), results };
}

if (process.argv.includes('--idle')) {
  // Stays up until the test stops the container.
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => {}, 1 << 30);
} else {
  if (!domain) {
    console.error('probe: DOMAIN is not set');
    process.exit(2);
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', async () => {
    const result = await runJob(JSON.parse(input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    for (const agent of agents.values()) agent.destroy();
  });
}
