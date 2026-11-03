// Helpers for the stack test (deploy/test/stack.test.mjs). CI AND LOCAL TESTS ONLY.
//
// `docker compose` against exactly one test project (COMPOSE_PROJECT_NAME), with the minimal
// environment of lib.mjs plus a fresh APP_KEY and the folder of the run's throw-away certificates,
// the requests of the probe service (deploy/test/probe.mjs), and small builders for the test's
// payloads. Nothing here prints a password, a token, a key or a code: answers are shown through
// redact().
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

import { CI_ENV, CI_OVERRIDE, COMPOSE_FILE, DEPLOY_DIR, REPO_ROOT, minimalEnv, readText } from './lib.mjs';

/** What docker compose accepts as a project name. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The stack under test, from the environment:
 *   COMPOSE_PROJECT_NAME  required: the project the test builds, starts and removes again
 *   STACK_COMPOSE_FILES   optional: comma-separated compose files (relative to deploy/), for
 *                         checking another version of deploy/; default the production compose
 *                         and the CI override
 *   STACK_ENV_FILE        optional: the env file; default deploy/ci.env
 *   STACK_KEEP=1          optional: leave the stack running for inspection (remove it by hand
 *                         with `docker compose -p <name> down -v`)
 */
export function stackSettings(env = process.env) {
  const project = env.COMPOSE_PROJECT_NAME ?? '';
  if (!PROJECT_NAME.test(project)) {
    throw new Error('COMPOSE_PROJECT_NAME is required (lower-case letters, digits, - and _): the test builds, '
      + 'starts and removes the stack of exactly that project, so it must be a name of its own');
  }
  const files = (env.STACK_COMPOSE_FILES ? env.STACK_COMPOSE_FILES.split(',') : [COMPOSE_FILE, CI_OVERRIDE])
    .map((f) => path.resolve(DEPLOY_DIR, f.trim()));
  const envFile = env.STACK_ENV_FILE ? path.resolve(env.STACK_ENV_FILE) : CI_ENV;
  return { project, files, envFile, keep: env.STACK_KEEP === '1' };
}

/** A Laravel key for this run only: never stored, never printed. */
export function freshAppKey() {
  return `base64:${crypto.randomBytes(32).toString('base64')}`;
}

/** A password for a throw-away account of this run: letters and digits, never printed. */
export function freshPassword() {
  return `Stack-${crypto.randomBytes(12).toString('base64url')}-7q`;
}

export class Stack {
  constructor(settings) {
    this.settings = settings;
    this.project = settings.project;
    // Compose prefers a variable of the calling environment over the env file: APP_KEY and
    // ORIGIN_TLS_DIR (usePki) are the only ones passed this way (a fresh key and fresh
    // certificates per run), and every compose call carries them, so a later `up` never sees a
    // different configuration.
    this.env = { ...minimalEnv(), APP_KEY: freshAppKey() };
  }

  /**
   * The run's throw-away PKI (lib.mjs throwawayPki): caddy loads the edge's files from its folder
   * as ORIGIN_TLS_DIR, and the probe presents the client certificate of Authenticated Origin Pulls
   * and checks the edge's certificate, in Cloudflare's place.
   */
  usePki(pki) {
    this.pki = pki;
    this.env.ORIGIN_TLS_DIR = pki.edgeDir;
  }

  baseArgs(profiles = []) {
    const args = ['compose', '-p', this.project, '--project-directory', DEPLOY_DIR, '--env-file', this.settings.envFile];
    for (const f of this.settings.files) args.push('-f', f);
    for (const p of profiles) args.push('--profile', p);
    return args;
  }

  /** `docker compose <args>`: { status, stdout, stderr }. `env` adds variables for this call only. */
  compose(args, { profiles = [], input, env = {}, timeout = 15 * 60_000 } = {}) {
    const r = spawnSync('docker', [...this.baseArgs(profiles), ...args], {
      env: { ...this.env, ...env },
      encoding: 'utf8',
      input,
      timeout,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}\n${r.error.message}` };
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  /** `docker compose exec -T` in one service (as its own user unless `user` is given). */
  exec(service, command, { user, input, index, env, profiles } = {}) {
    const args = ['exec', '-T'];
    if (index) args.push('--index', String(index));
    if (user) args.push('--user', user);
    return this.compose([...args, service, ...command], { input, env, profiles });
  }

  /** A shell script in one service. */
  sh(service, script, options = {}) {
    return this.exec(service, ['sh', '-c', script], options);
  }

  /** The services of the rendered configuration, all profiles included. */
  services() {
    const r = this.compose(['config', '--services'], { profiles: ['tools', 'test'] });
    if (r.status !== 0) throw new Error(`docker compose config failed (exit ${r.status}): ${r.stderr.trim()}`);
    return r.stdout.trim().split(/\r?\n/).filter(Boolean);
  }

  /** `docker inspect` of every container of the project (running or not). */
  containers() {
    const ids = spawnSync('docker', ['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${this.project}`], {
      env: minimalEnv(), encoding: 'utf8',
    }).stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return [];
    const r = spawnSync('docker', ['inspect', ...ids], { env: minimalEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`docker inspect failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout);
  }

  /** The containers of one service. */
  containersOf(service) {
    return this.containers().filter((c) => c.Config?.Labels?.['com.docker.compose.service'] === service);
  }

  /** `docker image inspect`. */
  image(ref) {
    const r = spawnSync('docker', ['image', 'inspect', ref], { env: minimalEnv(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`docker image inspect failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout)[0];
  }

  /**
   * Sends requests from one probe container (1 to 3: three addresses on the edge network, like
   * three of Cloudflare's edge nodes) and returns { address, results }. A JSON body is parsed into
   * `json` where it is JSON.
   */
  probe(requests, { index = 1 } = {}) {
    const job = JSON.stringify({ tls: this.pki?.client, requests });
    const r = this.exec('probe', ['node', '/checks/probe.mjs'], { index, input: job, profiles: ['test'] });
    if (r.status !== 0) throw new Error(`probe ${index} failed (exit ${r.status}): ${r.stderr.trim()}`);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    for (const res of out.results) {
      if (typeof res.body === 'string') {
        try {
          res.json = JSON.parse(res.body);
        } catch {
          res.json = undefined;
        }
      }
    }
    return out;
  }

  /** One request from probe `index`. */
  request(spec, index = 1) {
    return this.probe([spec], { index }).results[0];
  }
}

/** A request for the probe: JSON in and out, with an optional bearer token. */
export function apiRequest(method, urlPath, { token, json, headers = {}, body, bodyBase64 } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let text = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    text = JSON.stringify(json);
  }
  return { method, path: urlPath, headers: h, body: text, bodyBase64 };
}

/**
 * An answer as text for an assertion message: status and the start of the body, with the value
 * of every token-, password-, code- or secret-like JSON field replaced.
 */
export function redact(res) {
  if (!res) return 'no answer';
  if (res.error) return `error ${res.error}`;
  const body = String(res.body ?? '')
    .replace(/("[^"]*(?:token|password|code|secret|challenge|key)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/\b\d+\|[A-Za-z0-9]{20,}\b/g, '[redacted token]')
    .slice(0, 400);
  return `${res.status} ${body}`;
}

/** A header of an answer (the probe hands Node's lower-case header object through). */
export function header(res, name) {
  const v = res?.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A valid RGB PNG of one colour (8x8 by default): bytes for uploads and planted files. */
export function png(color = [0xfe, 0x2c, 0x55], size = 8) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => color).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A multipart/form-data body: { contentType, body } (fields as text, files as bytes). */
export function multipart(fields = {}, files = []) {
  const boundary = `----goenn-stack-${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`, 'utf8'));
    parts.push(f.bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * A list from api/app/Support/Uploads.php, the one writer of the uploads
 * (`public const NAME = ['a', 'b'];`): the folder names.
 */
export function storageList(name) {
  const text = readText(path.join(REPO_ROOT, 'api', 'app', 'Support', 'Uploads.php'));
  const list = new RegExp(`public const ${name} = \\[([^\\]]+)\\];`).exec(text)?.[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1));
  if (!list?.length) throw new Error(`cannot read ${name} in api/app/Support/Uploads.php`);
  return list;
}

/**
 * The default rules of one scope of a named limiter in api/config/ratelimits.php, e.g.
 * laravelLimit('password-forgot', 'ip') -> '5/600,20/3600' (max/seconds, comma-separated).
 */
export function laravelLimit(limiter, scope) {
  const text = readText(path.join(REPO_ROOT, 'api', 'config', 'ratelimits.php'));
  const block = new RegExp(`'${limiter}' => \\[([\\s\\S]*?)\\],`).exec(text)?.[1] ?? '';
  const spec = new RegExp(`'${scope}' => RateLimitRules::env\\('[A-Z0-9_]+', '([^']+)'\\)`).exec(block)?.[1];
  if (!spec) throw new Error(`cannot read the ${scope} rules of ${limiter} in api/config/ratelimits.php`);
  return spec;
}

/** Waits until `check()` returns a truthy value (polling); throws with `what` after `ms`. */
export async function waitFor(what, check, { ms = 180_000, every = 2000 } = {}) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
}
