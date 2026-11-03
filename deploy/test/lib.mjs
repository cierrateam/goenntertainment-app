// Helpers for the deploy tests (deploy/test/*.test.mjs).
//
// Every `docker compose` and `docker run` here gets a minimal environment and an explicit env
// file, so neither the calling shell (which may export settings, such as ANTHROPIC_BASE_URL) nor
// a stray deploy/.env can supply a value. Helper containers run with `--network none` and
// `--rm`, from the images pinned in the production compose: the tests need Docker but no
// network and leave nothing behind. Nothing here starts the stack.
//
// DEPLOY_DIR (environment) points the tests at another deploy/ folder, for example an older
// version extracted with `git archive`; the env files and the repository's other files are
// always this checkout's.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEPLOY_DIR = path.resolve(process.env.DEPLOY_DIR || path.join(REPO_ROOT, 'deploy'));
export const COMPOSE_FILE = 'docker-compose.yml';
export const CI_OVERRIDE = 'docker-compose.ci.yml';
export const CI_ENV = path.join(REPO_ROOT, 'deploy', 'ci.env');
export const ENV_EXAMPLE = path.join(REPO_ROOT, 'deploy', '.env.example');
export const RUNBOOK = path.join(REPO_ROOT, 'deploy', 'README.md');

// A project name for `docker compose config`, which creates nothing.
const PROJECT = 'goenn-deploy-static';

// What docker needs to find its configuration, plugins and daemon, and nothing else.
const PASS_THROUGH = [
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT',
  'TEMP', 'TMP', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
  'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
];

export function minimalEnv() {
  const env = {};
  for (const name of PASS_THROUGH) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/** KEY=VALUE lines of a dotenv file: [{ name, value, line }] (comments and blank lines skipped). */
export function parseEnvFile(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`line ${i + 1} is not KEY=VALUE`);
    out.push({ name: m[1], value: m[2], line: i + 1 });
  });
  return out;
}

export function envFileValues(file = CI_ENV) {
  return Object.fromEntries(parseEnvFile(readText(file)).map((s) => [s.name, s.value]));
}

/** Lines of a compose file without the comment lines (a `#` at the start of a line). */
function codeLines(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
}

/**
 * The settings a compose file requires: `${NAME:?...}` (set and not empty) or `${NAME?...}` (set,
 * may be empty), outside comment lines. `$${` is compose's escape for a literal `$`.
 */
export function requiredSettings(text) {
  const names = new Set();
  for (const line of codeLines(text)) {
    for (const m of line.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Every interpolation of a compose file, by form: required (`:?`, `?`), defaulted (`:-`, `-`,
 * with the default as written) and bare (`${NAME}` or `$NAME`, which compose fills with an empty
 * string when the setting is missing).
 */
export function interpolations(text) {
  const required = new Set();
  const defaulted = new Map();
  const bare = new Set();
  for (const line of codeLines(text)) {
    for (const m of line.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?([^}]*)\}/g)) {
      const [, name, op] = m;
      if (op === ':?' || op === '?') required.add(name);
      else if (op === ':-' || op === '-') {
        if (!defaulted.has(name)) defaulted.set(name, new Set());
        defaulted.get(name).add(m[3]);
      } else bare.add(name);
    }
    for (const m of line.matchAll(/(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g)) bare.add(m[1]);
  }
  return { required, defaulted, bare };
}

function composeArgs({ envFile = CI_ENV, files = [COMPOSE_FILE], profiles = [], deployDir = DEPLOY_DIR } = {}) {
  const args = ['compose', '-p', PROJECT, '--project-directory', deployDir, '--env-file', envFile];
  for (const f of files) args.push('-f', path.join(deployDir, f));
  for (const p of profiles) args.push('--profile', p);
  return args;
}

/** `docker compose <args>` with the minimal environment: { status, stdout, stderr }. */
export function compose(args, options = {}) {
  const r = spawnSync('docker', [...composeArgs(options), ...args], {
    env: minimalEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The same, without blocking: many renders can run side by side. */
export function composeAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...composeArgs(options), ...args], { env: minimalEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const rendered = new Map();

/** The rendered configuration (`docker compose config --format json`), parsed and cached. */
export function renderConfig(options = {}) {
  const key = JSON.stringify(options);
  if (!rendered.has(key)) {
    const r = compose(['config', '--format', 'json'], options);
    if (r.status !== 0) throw new Error(`docker compose config failed (exit ${r.status}): ${r.stderr.trim()}`);
    rendered.set(key, JSON.parse(r.stdout));
  }
  return rendered.get(key);
}

/** A copy of an env file with some settings removed or replaced: the path of a temp file. */
export function variantEnvFile(source, { drop = [], set = {} } = {}) {
  const lines = readText(source).split(/\r?\n/).filter((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    return !(m && drop.includes(m[1]));
  });
  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    return m && Object.hasOwn(set, m[1]) ? `${m[1]}=${set[m[1]]}` : line;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goenn-deploy-env-'));
  const file = path.join(dir, 'variant.env');
  fs.writeFileSync(file, out.join('\n'));
  return file;
}

export function removeTemp(file) {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

/** `docker run --rm --network none ...` with the minimal environment: { status, stdout, stderr }. */
export function dockerRun(image, { mounts = [], env = {}, entrypoint, args = [], input } = {}) {
  // Docker Desktop creates a missing bind source as an empty folder in the working tree: refuse
  // instead, so a missing file fails with its name and leaves nothing behind.
  const missing = mounts.filter((m) => !fs.existsSync(m.src)).map((m) => m.src);
  if (missing.length > 0) throw new Error(`cannot mount what does not exist: ${missing.join(', ')}`);
  const argv = ['run', '--rm', '--network', 'none'];
  if (input !== undefined) argv.push('-i');
  for (const m of mounts) argv.push('--mount', `type=bind,src=${m.src},dst=${m.dst}${m.readonly === false ? '' : ',readonly'}`);
  for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
  if (entrypoint) argv.push('--entrypoint', entrypoint);
  argv.push(image, ...args);
  const r = spawnSync('docker', argv, { env: minimalEnv(), encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The pinned image of a service in the production compose (the tests use the same pins). */
export function serviceImage(service) {
  const image = renderConfig().services?.[service]?.image;
  if (!image) throw new Error(`no image for service ${service} in ${COMPOSE_FILE}`);
  return image;
}

/** The script that makes the throw-away certificates (this checkout's copy, whatever DEPLOY_DIR is). */
export const THROWAWAY_PKI = path.join(REPO_ROOT, 'deploy', 'test', 'throwaway-pki.sh');

/**
 * A throw-away PKI in a temp folder, made by deploy/test/throwaway-pki.sh in the pinned db image
 * (openssl, no network), in place of what Cloudflare and Cierra's private CA provide on a server.
 * `edgeDir` holds what caddy loads from ORIGIN_TLS_DIR; `client` is what the stack test's probe
 * presents and trusts in Cloudflare's place (deploy/test/probe.mjs). Valid for one day; remove()
 * deletes the folder. The CA keys never leave the container.
 */
export function throwawayPki(domain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goenn-deploy-pki-'));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  // The script writes as root: in folders of this user's own, the files can be removed without root.
  for (const sub of ['edge', 'cloudflare']) fs.mkdirSync(path.join(dir, sub));
  const r = dockerRun(serviceImage('db'), {
    mounts: [{ src: THROWAWAY_PKI, dst: '/opt/throwaway-pki.sh' }, { src: dir, dst: '/pki', readonly: false }],
    entrypoint: 'sh',
    args: ['/opt/throwaway-pki.sh', '/pki', domain],
  });
  if (r.status !== 0) {
    remove();
    throw new Error(`throwaway-pki.sh failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
  const pem = (sub, name) => readText(path.join(dir, sub, name));
  return {
    dir,
    edgeDir: path.join(dir, 'edge'),
    originCert: pem('edge', 'origin-cert.pem'),
    client: {
      ca: pem('cloudflare', 'origin-ca.pem'),
      identities: {
        cloudflare: { cert: pem('cloudflare', 'client-cert.pem'), key: pem('cloudflare', 'client-key.pem') },
        other: { cert: pem('cloudflare', 'other-cert.pem'), key: pem('cloudflare', 'other-key.pem') },
      },
    },
    remove,
  };
}

const adapted = new Map();

/** `caddy adapt` of a Caddyfile in the pinned Caddy image: the JSON config, cached. */
export function caddyAdapt(caddyfile = path.join(DEPLOY_DIR, 'Caddyfile'), domain = 'localhost') {
  const key = `${caddyfile}\0${domain}`;
  if (!adapted.has(key)) {
    const r = dockerRun(serviceImage('caddy'), {
      mounts: [{ src: caddyfile, dst: '/etc/caddy/Caddyfile' }],
      env: { DOMAIN: domain },
      args: ['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    });
    if (r.status !== 0) throw new Error(`caddy adapt failed (exit ${r.status}): ${r.stderr.trim()}`);
    adapted.set(key, JSON.parse(r.stdout));
  }
  return adapted.get(key);
}

/** Every handler object in a Caddy JSON config (depth first), with the route list it sits in. */
export function caddyHandlers(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) caddyHandlers(item, out);
  } else if (node && typeof node === 'object') {
    if (typeof node.handler === 'string') out.push(node);
    for (const value of Object.values(node)) caddyHandlers(value, out);
  }
  return out;
}

/** The services of a rendered config with their (long-form) volume mounts. */
export function mounts(config) {
  return Object.entries(config.services ?? {}).flatMap(([service, s]) =>
    (s.volumes ?? []).map((v) => ({ service, ...v })));
}

/** IPv4 helpers for the network checks. */
export function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`not an IPv4 address: ${ip}`);
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

export function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ipToInt(base) / size) * size;
  const n = ipToInt(ip);
  return n >= start && n < start + size;
}
