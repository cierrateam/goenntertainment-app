// Static checks of the production deploy (deploy/): the compose files as docker compose renders
// them, the Caddyfile as Caddy adapts it, the env files and the helper scripts. They need Docker
// (the CLI and the pinned mysql and caddy images) but no network and no running stack.
//
//   node --test deploy/test/static.test.mjs        (npm run test:deploy runs every deploy test but
//                                                    the stack test, npm run test:deploy:stack)
//
// DEPLOY_DIR=<folder> runs the same checks against another deploy/ folder (lib.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  CI_ENV, CI_OVERRIDE, COMPOSE_FILE, DEPLOY_DIR, ENV_EXAMPLE, REPO_ROOT, RUNBOOK, THROWAWAY_PKI,
  caddyAdapt, caddyHandlers, composeAsync, dockerRun, envFileValues, inCidr, interpolations,
  ipToInt, minimalEnv, mounts, parseEnvFile, readText, removeTemp, renderConfig, requiredSettings,
  serviceImage, throwawayPki, variantEnvFile,
} from './lib.mjs';

const composeText = () => readText(path.join(DEPLOY_DIR, COMPOSE_FILE));
/**
 * The text of one service of the production compose, from its `  name:` line to the next service or
 * top-level key, with LF line ends (a Windows checkout has CRLF). For what the compose file itself
 * says, where the rendered configuration depends on the docker compose version.
 */
function serviceText(name) {
  const lines = composeText().split(/\r?\n/);
  const from = lines.indexOf('services:');
  assert.ok(from >= 0, `no services: in deploy/${COMPOSE_FILE}`);
  const start = lines.indexOf(`  ${name}:`, from);
  assert.ok(start >= 0, `no service ${name} in deploy/${COMPOSE_FILE}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {0,2}[^\s#]/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
const base = () => renderConfig({ profiles: ['tools'] });
// With the stack test's probe (profile test), so its image and settings are checked as well.
const ci = () => renderConfig({ files: [COMPOSE_FILE, CI_OVERRIDE], profiles: ['tools', 'test'] });
const ciValues = () => envFileValues(CI_ENV);
const posix = (p) => String(p).replaceAll('\\', '/');

/**
 * Every setting the production compose requires, and what kind of value it is. `decision`: a
 * business or retention decision nobody may guess (deploy/.env.example marks it DECISION and
 * names who decides). `secret`/`technical`: generated or chosen by whoever runs the server.
 */
const REQUIRED = {
  DOMAIN: 'decision',
  ORIGIN_TLS_DIR: 'technical',
  DB_PASSWORD: 'secret',
  DB_ROOT_PASSWORD: 'secret',
  APP_KEY: 'secret',
  APP_NET_PREFIX: 'technical',
  PAYMENTS_MODE: 'decision',
  EVIDENCE_RETENTION_DAYS: 'decision',
  TOKEN_RETENTION_DAYS: 'decision',
  MAIL_MAILER: 'decision',
  MAIL_GRAPH_CLIENT_ID: 'technical',
  MAIL_HOST: 'decision',
  MAIL_USERNAME: 'decision',
  MAIL_PASSWORD: 'decision',
  MAIL_FROM_ADDRESS: 'decision',
  BACKUP_DIR: 'decision',
  BACKUP_RETENTION_DAYS: 'decision',
  LOG_MAX_SIZE: 'decision',
  LOG_MAX_FILES: 'decision',
  MYSQL_BINLOG_RETENTION_DAYS: 'decision',
};
const REQUIRED_NAMES = Object.keys(REQUIRED).sort();
/**
 * Required to be present, but empty is allowed (`${NAME?}`): a mail relay without a login, and the
 * settings of the mail way that is not chosen (MAIL_HOST with graph, MAIL_GRAPH_CLIENT_ID with
 * smtp; api/docker/entrypoint.sh and the preflight require the ones the chosen way needs).
 */
const MAY_BE_EMPTY = ['MAIL_PASSWORD', 'MAIL_USERNAME', 'MAIL_HOST', 'MAIL_GRAPH_CLIENT_ID'];

const AUTH_LIMITS = [
  'REGISTER_IP', 'REGISTER_ACCOUNT', 'LOGIN_ACCOUNT_IP', 'LOGIN_IP', 'LOGIN_ACCOUNT', 'FORGOT_IP',
  'FORGOT_ACCOUNT', 'RESET_IP', 'RESET_ACCOUNT', '2FA_CHALLENGE', '2FA_IP', '2FA_ACCOUNT',
  '2FA_RESEND_IP', '2FA_RESEND_ACCOUNT', '2FA_SETUP_USER', 'ACCOUNT_SENSITIVE_USER', 'PROFILE_USER',
  '2FA_FAILURES', 'LOCK_WAIT',
];

/**
 * The only settings with a default in the production compose, and why a default is right there.
 * `value`: the default it must have, when one is fixed.
 */
const ALLOWED_DEFAULTS = {
  SANCTUM_EXPIRATION: { value: '', why: 'empty = the security default in code (30 days), listed for confirmation' },
  LOG_LEVEL: { why: 'technical: how much Laravel logs' },
  MAIL_PORT: { why: 'technical: the mail submission port, overridden for providers that differ' },
  MAIL_SCHEME: { value: '', why: 'technical: empty = derived from the port' },
  ...Object.fromEntries(AUTH_LIMITS.map((c) => [`AUTH_LIMIT_${c}`, { value: '', why: 'empty = the engineering default in code (api/config/ratelimits.php)' }])),
};

/** The Laravel services: one image (api/Dockerfile), built for each. */
const LARAVEL_SERVICES = ['api', 'scheduler', 'seed'];
/** Apache's docroot in the api image, and the folder Debian's Apache settings open (`<Directory /var/www/>`). */
const API_DOCROOT = '/var/www/api/public';
const APACHE_OPEN = '/var/www';

const servicesOf = (config) => Object.entries(config.services ?? {});
const healthTest = (s) => {
  const t = s.healthcheck?.test;
  return Array.isArray(t) ? t : t ? [t] : [];
};

/**
 * `docker run --rm --network none ...` like lib.mjs's dockerRun, without blocking: for the checks
 * that start a database server, so two of them can run side by side.
 */
function dockerRunAsync(image, { mounts: binds = [], env = {}, entrypoint, args = [] } = {}) {
  const argv = ['run', '--rm', '--network', 'none'];
  for (const m of binds) argv.push('--mount', `type=bind,src=${m.src},dst=${m.dst}${m.readonly === false ? '' : ',readonly'}`);
  for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
  if (entrypoint) argv.push('--entrypoint', entrypoint);
  argv.push(image, ...args);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { env: minimalEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** `key: value` lines of a check script's output: { key: value } (the last line of a key wins). */
function reported(stdout) {
  return Object.fromEntries(String(stdout).split(/\r?\n/).map((line) => /^([a-z][a-z ]*): ?(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
}

/** The db service's bind mounts into the image's first-start folder, in the order MySQL runs them. */
function initFiles(config = base()) {
  return (config.services.db.volumes ?? [])
    .filter((v) => v.type === 'bind' && String(v.target).startsWith('/docker-entrypoint-initdb.d/'))
    .sort((a, b) => path.posix.basename(a.target).localeCompare(path.posix.basename(b.target)));
}

// ------------------------------------------------------------------------------ settings

test('required settings: the production compose requires exactly the documented settings', () => {
  const found = requiredSettings(composeText());
  assert.ok(found.length > 0, 'no required setting found: refusing to report clean');
  console.log(`required settings: ${found.length} found, ${REQUIRED_NAMES.length} documented`);
  assert.deepEqual(found, REQUIRED_NAMES);
});

// How many missing settings one `docker compose config` names depends on its version: v5.5.1
// reports all of them in one error, v2.38.2 (on GitHub's ubuntu-24.04 runner) stops at the first
// one it meets. So this test proves that an empty env file does not render and that the error
// names a required setting, and only a documented one. That each of the settings is required, and
// named, is proven one at a time by "dropping any single required setting blocks rendering" (every
// setting removed, and every setting emptied; same result on both versions), and that these are
// all of them by "the production compose requires exactly the documented settings".
test('required settings: rendering without any env file value fails and names a required setting', async () => {
  const empty = variantEnvFile(CI_ENV, { drop: Object.keys(ciValues()) });
  try {
    assert.deepEqual(parseEnvFile(readText(empty)), [], 'the env file must be empty');
    const r = await composeAsync(['config', '--quiet'], { envFile: empty, profiles: ['tools'] });
    assert.notEqual(r.status, 0, 'docker compose config succeeded without any setting');
    const named = [...new Set([...r.stderr.matchAll(/required variable (\S+) is missing/g)].map((m) => m[1]))];
    console.log(`empty env file: ${named.length} of ${REQUIRED_NAMES.length} required settings named (how many depends on the docker compose version)`);
    assert.ok(named.length >= 1, `the error names no required setting: ${r.stderr.trim().slice(0, 300)}`);
    assert.deepEqual(named.filter((name) => !REQUIRED_NAMES.includes(name)), [], 'the error names a setting that is not documented as required');
  } finally {
    removeTemp(empty);
  }
});

test('required settings: the ci-only env file renders the compose, with and without the CI override', async () => {
  const variants = [
    { files: [COMPOSE_FILE] },
    { files: [COMPOSE_FILE], profiles: ['tools'] },
    { files: [COMPOSE_FILE, CI_OVERRIDE] },
    { files: [COMPOSE_FILE, CI_OVERRIDE], profiles: ['tools'] },
  ];
  for (const v of variants) {
    const r = await composeAsync(['config', '--quiet'], v);
    assert.equal(r.status, 0, `${JSON.stringify(v)}: ${r.stderr}`);
  }
});

test('required settings: dropping any single required setting blocks rendering', async () => {
  const cases = [];
  for (const name of REQUIRED_NAMES) {
    cases.push({ name, how: 'removed', change: { drop: [name] }, fails: true });
    cases.push({ name, how: 'empty', change: { set: { [name]: '' } }, fails: !MAY_BE_EMPTY.includes(name) });
  }
  console.log(`required settings: ${REQUIRED_NAMES.length} settings, ${cases.length} variants of deploy/ci.env`);
  const results = [];
  for (let i = 0; i < cases.length; i += 8) {
    results.push(...await Promise.all(cases.slice(i, i + 8).map(async (c) => {
      const file = variantEnvFile(CI_ENV, c.change);
      try {
        const r = await composeAsync(['config', '--quiet'], { envFile: file, profiles: ['tools'] });
        return { ...c, status: r.status, stderr: r.stderr };
      } finally {
        removeTemp(file);
      }
    })));
  }
  const wrong = results.filter((r) => (r.fails
    ? r.status === 0 || !r.stderr.includes(`required variable ${r.name} is missing`)
    : r.status !== 0)).map((r) => `${r.name} ${r.how}: exit ${r.status}`);
  assert.deepEqual(wrong, []);
});

test('required settings: only allow-listed settings have defaults', () => {
  const text = composeText();
  const { defaulted, bare } = interpolations(text);
  assert.ok(defaulted.size > 0, 'no defaulted setting found: refusing to report clean');
  console.log(`defaults: ${defaulted.size} settings with a default, ${Object.keys(ALLOWED_DEFAULTS).length} allowed`);
  assert.deepEqual([...defaulted.keys()].filter((n) => !ALLOWED_DEFAULTS[n]), [], 'defaults that are not allow-listed');
  assert.deepEqual([...bare], [], 'interpolations without a default and without :? fill in an empty value silently');
  for (const [name, values] of defaulted) {
    assert.equal(values.size, 1, `${name} has different defaults: ${[...values].join(', ')}`);
    const expected = ALLOWED_DEFAULTS[name].value;
    if (expected !== undefined) assert.equal([...values][0], expected, `${name}'s default`);
  }
  // How mail goes out is an operator decision without a default (graph or smtp; the entrypoint
  // refuses everything else, the log mailer above all, which would write every code into the
  // container log): required in every service that mails, the same in each.
  for (const name of ['api', 'scheduler']) {
    assert.match(serviceText(name), /^ {6}MAIL_MAILER: \$\{MAIL_MAILER:\?[^}\n]+\}$/m, `${name}: MAIL_MAILER is required, without a default`);
    assert.equal(base().services[name].environment.MAIL_MAILER, ciValues().MAIL_MAILER, name);
  }
});

test('required settings: PAYMENTS_MODE is required, the same in api and the scheduler, and its modes are the code\'s', () => {
  const config = base();
  const code = readText(path.join(REPO_ROOT, 'api', 'config', 'club.php'));
  assert.match(code, /'payments' => env\('PAYMENTS_MODE'/, 'api/config/club.php no longer reads PAYMENTS_MODE');
  const payments = readText(path.join(REPO_ROOT, 'api', 'app', 'Support', 'Payments.php'));
  assert.match(payments, /return self::mode\(\) === 'test';/, "payments run only in the mode 'test' (App\\Support\\Payments::enabled)");
  for (const name of ['api', 'scheduler']) {
    assert.equal(config.services[name].environment.PAYMENTS_MODE, ciValues().PAYMENTS_MODE, `${name}: PAYMENTS_MODE`);
  }
  assert.equal(config.services.seed.environment.PAYMENTS_MODE, undefined, 'the seed creates an account only');
  const preflight = readText(path.join(DEPLOY_DIR, 'scripts', 'preflight.sh'));
  assert.equal(/PAYMENTS_PATTERN='([^']+)'/.exec(preflight)?.[1], '^(off|test)$', 'the preflight accepts exactly off and test');
});

// The mailers Laravel ships besides smtp: each one stops the api image's start and fails the
// preflight. log would write every code into the container log, array would drop the mail.
const OTHER_MAILERS = ['log', 'array', 'failover', 'roundrobin', 'sendmail', 'ses', 'postmark', 'resend'];

test("mail: the api image's entrypoint stops the start without graph or smtp, or without a setting the chosen way needs", () => {
  // api/docker/entrypoint.sh (api and the scheduler) in the pinned busybox image, with a stand-in
  // php: a start that passes the checks ends in `echo started`. Fake values only.
  const client = '00000000-0000-4000-8000-00000000000b';
  const common = 'APP_KEY=base64:ci-only-not-a-secret TRUSTED_PROXIES=172.30.99.10 MAIL_FROM_ADDRESS=ci-only@example.invalid';
  const cases = {
    graph: [`MAIL_MAILER=graph MAIL_GRAPH_CLIENT_ID=${client}`, null],
    smtp: ['MAIL_MAILER=smtp MAIL_HOST=mailpit', null],
    'graph-without-client': ['MAIL_MAILER=graph MAIL_HOST=mailpit', 'MAIL_GRAPH_CLIENT_ID'],
    'smtp-without-host': [`MAIL_MAILER=smtp MAIL_GRAPH_CLIENT_ID=${client}`, 'MAIL_HOST'],
    'no-mailer': ['MAIL_HOST=mailpit', 'MAIL_MAILER'],
    ...Object.fromEntries(OTHER_MAILERS.map((mailer) => [mailer, [`MAIL_MAILER=${mailer} MAIL_HOST=mailpit`, 'MAIL_MAILER']])),
    'no-sender': ['MAIL_MAILER=smtp MAIL_HOST=mailpit MAIL_FROM_ADDRESS=', 'MAIL_FROM_ADDRESS'],
  };
  const driver = [
    'mkdir -p /var/www/api /usr/local/bin',
    "printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/php && chmod 755 /usr/local/bin/php",
    ...Object.entries(cases).map(([name, [vars]]) => `out=$(env -i PATH=/usr/local/bin:/usr/bin:/bin ${common} ${vars} sh /opt/goenn-entrypoint.sh echo started 2>&1); printf '=== %s exit %s\\n%s\\n' '${name}' "$?" "$out"`),
  ].join('\n');
  const r = dockerRun(serviceImage('storage-init'), {
    mounts: [{ src: path.join(REPO_ROOT, 'api', 'docker', 'entrypoint.sh'), dst: '/opt/goenn-entrypoint.sh' }],
    entrypoint: 'sh',
    args: ['-c', driver],
  });
  assert.equal(r.status, 0, r.stderr);
  const runs = Object.fromEntries(r.stdout.split(/^=== /m).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [, name, code] = /^(\S+) exit (\d+)$/.exec(head);
    return [name, { code: Number(code), out: rest.join('\n') }];
  }));
  assert.deepEqual(Object.keys(runs).sort(), Object.keys(cases).sort(), r.stdout);
  console.log(`mail entrypoint: ${Object.keys(cases).length} cases`);
  for (const [name, [, missing]] of Object.entries(cases)) {
    const { code, out } = runs[name];
    if (missing === null) {
      assert.equal(code, 0, `${name}:\n${out}`);
      assert.match(out, /^started$/m, `${name} did not start`);
    } else {
      assert.equal(code, 1, `${name}: the start went on:\n${out}`);
      assert.match(out, new RegExp(`ERROR: required settings missing or invalid:.*\\b${missing}\\(`), `${name}: ${missing} is not named:\n${out}`);
      assert.doesNotMatch(out, /^started$/m, `${name} started anyway`);
    }
    // Names only, never values.
    for (const value of [client, 'mailpit', 'ci-only@example.invalid']) assert.ok(!out.includes(value), `${name} printed a value`);
  }
});

test('settings are documented in .env.example (blank, with who decides), deploy/ci.env and the runbook', () => {
  const lines = readText(ENV_EXAMPLE).split(/\r?\n/);
  const example = parseEnvFile(readText(ENV_EXAMPLE));
  const ciNames = new Set(Object.keys(ciValues()));
  const runbook = readText(RUNBOOK);
  const problems = [];
  for (const name of REQUIRED_NAMES) {
    const entry = example.find((s) => s.name === name);
    if (!entry) { problems.push(`${name}: not in deploy/.env.example`); continue; }
    if (entry.value !== '') problems.push(`${name}: deploy/.env.example presets a value`);
    if (REQUIRED[name] === 'decision') {
      // The comment block the setting belongs to (contiguous non-blank lines) names the decision.
      let i = entry.line - 1;
      while (i > 0 && lines[i - 1].trim() !== '') i -= 1;
      const block = lines.slice(i, entry.line).join('\n');
      if (!/DECISION \([^)]+\)/.test(block)) problems.push(`${name}: no "DECISION (who)" in its comment block`);
    }
    if (!ciNames.has(name)) problems.push(`${name}: not in deploy/ci.env`);
    if (!new RegExp(`\`${name}(=[^\`]*)?\``).test(runbook)) problems.push(`${name}: not named in deploy/README.md`);
  }
  console.log(`documentation: ${REQUIRED_NAMES.length} required settings checked in 3 files`);
  assert.deepEqual(problems, []);
  assert.deepEqual(example.filter((s) => s.name.startsWith('ADMIN_')).map((s) => s.name), [], '.env.example assigns ADMIN_*');
});

test('ci-only env file is labelled and holds only fake values', () => {
  const text = readText(CI_ENV);
  const header = text.split(/\r?\n/).slice(0, 5).join('\n');
  assert.match(header, /CI-ONLY/);
  assert.match(header, /NOT for any real server/);
  const settings = parseEnvFile(text);
  assert.ok(settings.length > 0, 'no setting found: refusing to report clean');
  const services = new Set(Object.keys(ci().services));
  const secretName = /(password|passwd|[_-]pwd|secret|token|[_-]key)$/i;
  const fakeValue = [
    /^$/, /^\d+$/, /^\d+[kmg]$/, /^(true|false)$/, /^localhost$/, /ci-only/, /not-a-secret/,
    /^[^@\s]+@example\.invalid$/, /^(\S+\.)?example\.invalid$/,
    /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\/?$/,
    /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)(\.\d{1,3}){1,2}$/,
  ];
  // A mode of the code rather than a value, one per setting: the one that moves no real money.
  const ciModes = { PAYMENTS_MODE: 'test', MAIL_MAILER: 'smtp' };
  const problems = [];
  for (const { name, value, line } of settings) {
    if (name.startsWith('ADMIN_')) problems.push(`${line}: ${name} (admin values never live in an env file)`);
    if (secretName.test(name) && value !== '' && !value.includes('not-a-secret')) problems.push(`${line}: ${name} has no not-a-secret marker`);
    if (!fakeValue.some((re) => re.test(value)) && !services.has(value) && ciModes[name] !== value) problems.push(`${line}: ${name} does not look like a fake or ci-only value`);
  }
  console.log(`deploy/ci.env: ${settings.length} settings checked`);
  assert.deepEqual(problems, []);
});

// ------------------------------------------------------------------------------ F-10

test('F-10: deploy/ holds exactly one production compose wired caddy -> api -> db', async (t) => {
  await t.test('the only compose files are docker-compose.yml and the labelled CI override', () => {
    const files = fs.readdirSync(DEPLOY_DIR).filter((f) => /\.ya?ml$/i.test(f)).sort();
    console.log(`compose files in ${posix(DEPLOY_DIR)}: ${files.join(', ')}`);
    assert.ok(files.includes(COMPOSE_FILE), 'no docker-compose.yml');
    assert.deepEqual(files.filter((f) => f !== COMPOSE_FILE && f !== CI_OVERRIDE), [], 'a second compose file');
    for (const f of files.filter((name) => name === CI_OVERRIDE)) {
      const head = readText(path.join(DEPLOY_DIR, f)).split(/\r?\n/).slice(0, 2).join('\n');
      assert.match(head, /CI AND LOCAL TESTS ONLY - NOT FOR PRODUCTION/, `${f} must say it is not for production`);
    }
  });

  await t.test('the stack is caddy -> api (Laravel, api/) -> db, with Laravel answering every path', () => {
    const config = renderConfig({ profiles: ['tools'] });
    const services = config.services ?? {};
    for (const name of ['db', 'api', 'scheduler', 'caddy']) assert.ok(services[name], `no service ${name}`);
    assert.match(posix(services.api.build?.context), /\/api$/, 'api is not built from api/ (Laravel)');
    // One image for every Laravel service, and no other backend behind Laravel.
    for (const name of LARAVEL_SERVICES) assert.deepEqual(services[name]?.build, services.api.build, `${name} is not built like api`);
    const otherBuilds = Object.entries(services).filter(([name, s]) => s.build && !LARAVEL_SERVICES.includes(name)).map(([name]) => name);
    assert.deepEqual(otherBuilds, [], 'a service built from something other than api/');
    assert.equal(services.node, undefined, 'a node service: the stack has no backend behind Laravel');
    const fallback = Object.entries(services).filter(([, s]) => Object.keys(s.environment ?? {}).some((k) => /^NODE_/.test(k))).map(([name]) => name);
    assert.deepEqual(fallback, [], 'a service with a NODE_* setting (a fallback or an internal secret)');
    assert.match(services.db.image, /^mysql:/);
    for (const name of ['api', 'scheduler', 'seed']) assert.equal(services[name].environment.DB_HOST, 'db', name);
    // Two upstreams: the allow-listed uploads go to the media file server, everything else to
    // Laravel (the last route, without a matcher).
    const routes = siteRoutes();
    const dials = caddyHandlers(routes).filter((h) => h.handler === 'reverse_proxy').flatMap((h) => (h.upstreams ?? []).map((u) => u.dial));
    console.log(`caddy upstreams: ${dials.join(', ')}`);
    assert.deepEqual(dials.map((d) => d.split(':')[0]).sort(), ['api', 'media'], "caddy's upstreams are the Laravel service and the media file server");
    const last = routes.at(-1);
    assert.equal(last.match, undefined, 'the last route takes every request the others left');
    assert.deepEqual(caddyHandlers(last).filter((h) => h.handler === 'reverse_proxy').flatMap((h) => h.upstreams.map((u) => u.dial.split(':')[0])), ['api'], 'everything else goes to Laravel');
  });
});

/** The routes inside the site block of deploy/Caddyfile (adapted). */
function siteRoutes() {
  return caddyAdapt().apps.http.servers.srv0.routes[0].handle[0].routes;
}

/** The reverse_proxy handlers of the edge, by upstream service name: { api: [...], media: [...] }. */
function edgeProxies() {
  const out = {};
  for (const h of caddyHandlers(caddyAdapt()).filter((x) => x.handler === 'reverse_proxy')) {
    for (const u of h.upstreams ?? []) (out[u.dial.split(':')[0]] ??= []).push(h);
  }
  return out;
}

test('F-28: caddy and the api healthcheck use the port of the non-root Apache (8080)', () => {
  assert.deepEqual((edgeProxies().api ?? []).flatMap((h) => h.upstreams.map((u) => u.dial)), ['api:8080']);
  assert.ok(healthTest(base().services.api).join(' ').includes('http://127.0.0.1:8080/api/health'), 'api healthcheck');
});

// ------------------------------------------------------------------------------ F-05, F-18

test('F-05/F-18: ADMIN_EMAIL and ADMIN_PASSWORD reach only the one-off seed service', () => {
  const config = base();
  const withAdmin = servicesOf(config)
    .filter(([, s]) => Object.keys(s.environment ?? {}).some((k) => k.startsWith('ADMIN_')))
    .map(([name]) => name);
  console.log(`services: ${servicesOf(config).length}; with ADMIN_*: ${withAdmin.join(', ') || 'none'}`);
  assert.deepEqual(withAdmin, ['seed']);
  const seed = config.services.seed;
  assert.deepEqual(seed.profiles, ['tools'], 'seed must never start with `docker compose up`');
  assert.ok(!seed.restart || seed.restart === 'no', 'seed must not restart');
  // No value in the compose: they come from the operator's shell for one run.
  assert.equal(seed.environment.ADMIN_EMAIL, null);
  assert.equal(seed.environment.ADMIN_PASSWORD, null);
  // Laravel's command (App\Support\AdminAccount), on the api image, without the image's
  // entrypoint: no key, no mail login, no migrations; the database settings and the two values.
  assert.deepEqual(seed.entrypoint, ['php', 'artisan', 'admin:create']);
  assert.ok(!seed.command, 'the seed runs exactly its entrypoint');
  assert.deepEqual(seed.build, config.services.api.build);
  const extra = Object.keys(seed.environment).filter((k) => !/^(APP_ENV|APP_DEBUG|APP_TIMEZONE|LOG_CHANNEL|CACHE_STORE|DB_[A-Z]+|ADMIN_EMAIL|ADMIN_PASSWORD)$/.test(k));
  assert.deepEqual(extra, [], 'the seed gets settings beyond the database and the two admin values');
  assert.match(readText(path.join(REPO_ROOT, 'api', 'routes', 'console.php')), /Artisan::command\('admin:create'/, 'no admin:create command in api/routes/console.php');
});

test('F-05: caddy starts only after the admin gate found an admin account', () => {
  const config = base();
  assert.deepEqual(config.services.caddy.depends_on['admin-gate']?.condition, 'service_completed_successfully');
  const gate = config.services['admin-gate'];
  assert.ok(!gate.restart || gate.restart === 'no', 'the gate is a one-shot');
  assert.deepEqual(gate.entrypoint, ['bash', '/opt/deploy/admin-gate.sh']);
  assert.equal(gate.image, config.services.db.image, 'the gate uses the db image');
  const script = readText(path.join(DEPLOY_DIR, 'scripts', 'admin-gate.sh'));
  assert.match(script, /SELECT COUNT\(\*\) FROM users WHERE is_admin = 1/);
  assert.match(readText(path.join(REPO_ROOT, 'server', 'schema.sql')), /^\s+is_admin\s+TINYINT\(1\)/m, 'users.is_admin, which the gate counts');
  // The production schema comes from the migrations: they create the column the gate counts, and
  // the gate waits until api has run them.
  const migrations = fs.readdirSync(path.join(REPO_ROOT, 'api', 'database', 'migrations')).map((f) => readText(path.join(REPO_ROOT, 'api', 'database', 'migrations', f))).join('\n');
  assert.match(migrations, /->boolean\('is_admin'\)/, 'no migration creates users.is_admin');
  assert.equal(gate.depends_on?.api?.condition, 'service_healthy', 'the gate does not wait for the migrations');
});

test('F-18: no healthcheck carries a password', () => {
  const values = ciValues();
  const secrets = Object.entries(values).filter(([k, v]) => /PASSWORD|SECRET|_KEY$/.test(k) && v !== '').map(([, v]) => v);
  const checks = servicesOf(base()).filter(([, s]) => healthTest(s).length > 0);
  assert.ok(checks.length > 0, 'no healthcheck found: refusing to report clean');
  console.log(`healthchecks: ${checks.length} (${checks.map(([n]) => n).join(', ')})`);
  const problems = [];
  for (const [name, s] of checks) {
    const words = healthTest(s).join(' ');
    if (secrets.some((v) => words.includes(v))) problems.push(`${name}: contains a ci-only secret value`);
    if (/(^|\s)(-p\S|--password|-u\s*root)/.test(words) || /MYSQL_(ROOT_)?PASSWORD|MYSQL_PWD/.test(words)) problems.push(`${name}: names a password option`);
  }
  assert.deepEqual(problems, []);
});

// ------------------------------------------------------------------------------ F-29

test('F-29: uploads are mounted read-only into media, read-write into api outside its docroot, never into caddy', () => {
  const config = base();
  const all = mounts(config);
  console.log(`mounts: ${all.length} checked`);
  const binds = all.filter((m) => m.type === 'bind' && /storage/.test(posix(m.source)));
  assert.deepEqual(binds.map((m) => `${m.service}: ${posix(m.source)}`), [], 'an upload folder bound from the clone');
  const of = (source) => all.filter((m) => m.type === 'volume' && m.source === source)
    .map((m) => `${m.service}:${m.read_only ? 'ro' : 'rw'}`).sort();
  // api writes both; the scheduler's retention prune removes old evidence images.
  assert.deepEqual(of('uploads'), ['api:rw', 'backup:ro', 'media:ro', 'storage-init:rw']);
  assert.deepEqual(of('private-media'), ['api:rw', 'backup:ro', 'scheduler:rw', 'storage-init:rw']);
  // Where Laravel stores them is where they are mounted, and Apache never reaches it: outside the
  // docroot, and outside /var/www, which Debian's Apache settings open.
  const roots = { uploads: 'UPLOADS_ROOT', 'private-media': 'PRIVATE_MEDIA_ROOT' };
  for (const name of ['api', 'scheduler']) {
    const env = config.services[name].environment;
    const own = all.filter((m) => m.service === name);
    assert.deepEqual(own.filter((m) => m.type !== 'volume' || !roots[m.source]).map((m) => `${posix(m.source)} -> ${m.target}`), [], `${name} mounts something else`);
    for (const m of own) {
      assert.equal(m.target, env[roots[m.source]], `${name}: ${m.source} is mounted where ${roots[m.source]} points`);
      for (const dir of [API_DOCROOT, APACHE_OPEN]) assert.ok(!`${m.target}/`.startsWith(`${dir}/`), `${name}: ${m.source} is mounted under ${dir}`);
    }
  }
  assert.ok(config.services.api.environment.UPLOADS_ROOT && config.services.api.environment.PRIVATE_MEDIA_ROOT, 'api has no upload roots');
  // A refusal in Apache's own settings for the folder the volumes live in, should a link ever lead there.
  const conf = readText(path.join(REPO_ROOT, 'api', 'docker', 'apache.conf'));
  const parent = path.posix.dirname(config.services.api.environment.UPLOADS_ROOT);
  assert.match(conf, new RegExp(`<Directory ${parent.replaceAll('/', '\\/')}>\\s*AllowOverride None\\s*Options None\\s*Require all denied\\s*php_admin_flag engine off\\s*</Directory>`), `api/docker/apache.conf does not refuse ${parent}`);
});

test('F-29: caddy, which holds the origin key, mounts no volume another service mounts', () => {
  // Caddy follows symbolic links: a link planted in a volume someone else writes would let caddy
  // serve its own files (the origin key in /etc/caddy/origin) under an allowed name. So it shares
  // no volume at all.
  const all = mounts(base());
  const own = all.filter((m) => m.service === 'caddy' && m.type === 'volume');
  console.log(`caddy: ${own.length} volumes (${own.map((m) => m.source).join(', ')}), ${all.length} mounts of the compose checked`);
  assert.ok(own.length > 0, 'caddy mounts no volume: refusing to report clean');
  assert.deepEqual(own.map((m) => m.source).sort(), ['caddy-config', 'caddy-data']);
  const shared = all.filter((m) => m.service !== 'caddy' && own.some((o) => o.source === m.source));
  assert.deepEqual(shared.map((m) => `${m.service}: ${m.source}`), [], 'a volume of caddy is mounted elsewhere');
  const binds = all.filter((m) => m.service === 'caddy' && m.type === 'bind').map((m) => `${m.target}:${m.read_only ? 'ro' : 'rw'}`);
  assert.deepEqual(binds.sort(), ['/etc/caddy/Caddyfile:ro', '/etc/caddy/origin:ro'], "caddy's binds: the Caddyfile and the TLS folder, both read-only");
});

test('edge: the origin certificate files come from the required ORIGIN_TLS_DIR bind, read-only, never created implicitly, into caddy only', () => {
  const all = mounts(base());
  const origin = all.filter((m) => m.target === '/etc/caddy/origin');
  assert.deepEqual(origin.map((m) => `${m.service}:${m.type}:${m.read_only ? 'ro' : 'rw'}`), ['caddy:bind:ro']);
  assert.equal(posix(origin[0].source).replace(/^[A-Za-z]:/, ''), ciValues().ORIGIN_TLS_DIR, 'the bind source is ORIGIN_TLS_DIR');
  // Rendered, create_host_path depends on the docker compose version (see the BACKUP_DIR bind);
  // the compose file itself must say it, in the long syntax.
  assert.ok([undefined, false].includes(origin[0].bind?.create_host_path), `the ORIGIN_TLS_DIR bind renders create_host_path: ${JSON.stringify(origin[0].bind?.create_host_path)}`);
  assert.match(
    serviceText('caddy'),
    /^ *- type: bind\n *source: \$\{ORIGIN_TLS_DIR:\?[^\n]*\}\n *target: \/etc\/caddy\/origin\n *read_only: true\n *bind:\n *create_host_path: false *$/m,
    `deploy/${COMPOSE_FILE}: caddy's /etc/caddy/origin bind must be written in the long syntax, read-only, with create_host_path: false`,
  );
  // Nobody else sees the folder, under any name: the setting appears once in the compose, in
  // caddy's service, and no other mount renders to its path.
  const uses = composeText().split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.includes('${ORIGIN_TLS_DIR'));
  assert.equal(uses.length, 1, `ORIGIN_TLS_DIR is used ${uses.length} times in deploy/${COMPOSE_FILE}`);
  assert.ok(serviceText('caddy').includes(uses[0]), 'ORIGIN_TLS_DIR is used outside the caddy service');
  const sameSource = all.filter((m) => m.service !== 'caddy' && posix(m.source ?? '') === posix(origin[0].source));
  assert.deepEqual(sameSource.map((m) => `${m.service}: ${m.target}`), [], 'another service mounts ORIGIN_TLS_DIR');
  // The edge reads exactly these files from it (deploy/Caddyfile).
  const caddyfile = readText(path.join(DEPLOY_DIR, 'Caddyfile'));
  const files = [...new Set([...caddyfile.matchAll(/\/etc\/caddy\/origin\/([\w.-]+)/g)].map((m) => m[1]))].sort();
  console.log(`ORIGIN_TLS_DIR: mounted into caddy only, read-only; the Caddyfile reads ${files.join(', ')}`);
  assert.deepEqual(files, ['origin-cert.pem', 'origin-key.pem', 'origin-pull-ca.pem']);
});

/**
 * PUBLIC_FOLDERS, PRIVATE_FOLDERS and the allow-list pattern built from api/app/Support/Uploads.php,
 * the one writer of the uploads.
 */
function uploadAllowList() {
  const uploads = readText(path.join(REPO_ROOT, 'api', 'app', 'Support', 'Uploads.php'));
  const list = (name) => new RegExp(`public const ${name} = \\[([^\\]]+)\\];`).exec(uploads)?.[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1));
  const folders = list('PUBLIC_FOLDERS');
  const privateFolders = list('PRIVATE_FOLDERS');
  const name = /public const STORED_NAME = '\/\^(.+)\$\/';/.exec(uploads)?.[1];
  assert.ok(folders?.length && privateFolders?.length && name, 'cannot read PUBLIC_FOLDERS, PRIVATE_FOLDERS or STORED_NAME in api/app/Support/Uploads.php');
  return { folders, privateFolders, expected: `^/storage/(${folders.join('|')})/${name}$` };
}

test('F-29: caddy passes only stored public images to the media file server and answers 404 for anything else under /storage', () => {
  const { folders, privateFolders, expected } = uploadAllowList();
  const routes = siteRoutes();
  const uploadAt = routes.findIndex((r) => r.match?.[0]?.path_regexp);
  const storageAt = routes.findIndex((r) => r.match?.[0]?.path?.includes('/storage/*'));
  assert.ok(uploadAt >= 0, 'caddy has no route for uploads');
  assert.ok(storageAt > uploadAt, 'no /storage 404 after the upload route');
  assert.equal(routes[uploadAt].match[0].path_regexp.pattern, expected, 'the allow-list mirrors api/app/Support/Uploads.php');
  for (const folder of privateFolders) assert.ok(!expected.includes(folder), `private folder ${folder} is served`);
  const upload = caddyHandlers(routes[uploadAt]);
  assert.deepEqual(upload.map((h) => h.handler), ['subroute', 'headers', 'reverse_proxy']);
  // Set when the answer is written: the sandbox policy and the cache lifetime are sent whatever
  // the file server answers.
  assert.equal(upload[1].response.deferred, true, 'the upload policy is not deferred');
  assert.match(upload[1].response.set['Content-Security-Policy'][0], /default-src 'none'.*sandbox/);
  // Cloudflare caches .jpg, .png and .webp by extension (120 minutes when the origin says
  // nothing): five minutes, so a removed image leaves its cache within that time.
  assert.deepEqual(upload[1].response.set['Cache-Control'], ['public, max-age=300']);
  assert.deepEqual(upload[2].upstreams.map((u) => u.dial), ['media:8080']);
  // No other route and no error route of the edge says anything about caching: Laravel's
  // answers keep their own Cache-Control (no-cache, private; the ban evidence no-store, private).
  const isCacheControl = (name) => name.toLowerCase() === 'cache-control';
  const setsCacheControl = (h) => [h.response, h.headers?.response].some((ops) => ['set', 'add', 'replace'].some((op) => Object.keys(ops?.[op] ?? {}).some(isCacheControl)))
    || (h.handler === 'static_response' && Object.keys(h.headers ?? {}).some(isCacheControl));
  const setters = caddyHandlers(caddyAdapt()).filter(setsCacheControl);
  assert.equal(setters.length, 1, `handlers that set Cache-Control: ${setters.length}`);
  assert.equal(setters[0], upload[1], 'Cache-Control is set elsewhere than on the upload route');
  assert.deepEqual(caddyHandlers(routes[storageAt]).map((h) => [h.handler, h.status_code ?? null]), [['subroute', null], ['static_response', 404]]);
  assert.equal(routes[storageAt].match[0].path.includes('/storage'), true);
  assert.deepEqual(caddyHandlers(caddyAdapt()).filter((h) => h.handler === 'file_server'), [], 'the edge serves files itself');
  console.log(`uploads: ${folders.length} public folders passed to media, ${privateFolders.length} private folders not served`);
});

test('F-29: the media file server serves only the same allow-list from /srv and 404 for everything else', () => {
  const { expected } = uploadAllowList();
  const config = caddyAdapt(path.join(DEPLOY_DIR, 'Caddyfile.media'));
  assert.equal(config.admin?.disabled, true, 'the admin endpoint is on');
  assert.equal(config.admin?.config?.persist, false, 'media saves its configuration');
  const servers = Object.values(config.apps?.http?.servers ?? {});
  assert.equal(servers.length, 1, 'media runs exactly one server');
  const [server] = servers;
  assert.deepEqual(server.listen, [':8080'], 'media listens on 8080 only (it runs without root)');
  assert.equal(server.automatic_https?.disable, true, 'media must not manage certificates');
  assert.equal(Object.keys(config.apps).join(','), 'http', 'media runs another app (tls, pki: keys of its own)');
  const routes = server.routes;
  assert.equal(routes.length, 2, 'the allow-list and the 404 for everything else');
  assert.equal(routes[0].match?.[0]?.path_regexp?.pattern, expected, "media's allow-list mirrors api/app/Support/Uploads.php");
  const files = caddyHandlers(routes[0]);
  assert.deepEqual(files.map((h) => h.handler), ['subroute', 'vars', 'file_server']);
  assert.equal(files[1].root, '/srv');
  assert.equal(files[2].browse, undefined, 'media lists folders');
  assert.equal(routes[1].match, undefined);
  assert.deepEqual(caddyHandlers(routes[1]).map((h) => [h.handler, h.status_code ?? null]), [['subroute', null], ['static_response', 404]]);
  console.log(`media: ${routes.length} routes, allow-list ${expected}`);
});

test('F-29: media is a file server without secrets: no settings, no keys, nobody, read-only, on its own internal network', () => {
  const config = base();
  const media = config.services.media;
  assert.ok(media, 'no media service');
  assert.equal(media.image, config.services.caddy.image, 'media runs the pinned caddy image');
  assert.equal(media.user, '65534:65534', 'media runs as nobody');
  assert.equal(media.read_only, true);
  assert.deepEqual([...(media.tmpfs ?? [])].sort(), ['/config', '/data'], "caddy's data and config folders are empty and temporary");
  assert.deepEqual(media.environment ?? {}, {}, 'media gets settings');
  assert.deepEqual(media.ports ?? [], [], 'media publishes a port');
  assert.deepEqual(Object.keys(media.networks ?? {}), ['media']);
  assert.equal(config.networks.media?.internal, true, 'the media network has a way out');
  assert.deepEqual(media.cap_drop, ['ALL']);
  assert.deepEqual(media.cap_add, ['NET_BIND_SERVICE'], 'the caddy binary carries this file capability; nothing else');
  assert.ok((media.security_opt ?? []).includes('no-new-privileges:true'));
  const own = mounts(config).filter((m) => m.service === 'media')
    .map((m) => `${m.type === 'bind' ? posix(m.source).split('/').pop() : m.source} -> ${m.target}:${m.read_only ? 'ro' : 'rw'}`).sort();
  console.log(`media: ${own.length} mounts (${own.join(', ')})`);
  assert.deepEqual(own, ['Caddyfile.media -> /etc/caddy/Caddyfile:ro', 'uploads -> /srv/storage:ro']);
});

// ------------------------------------------------------------------------------ F-30

test('F-30: the Caddyfile validates and sets the security headers on normal and error routes', () => {
  // `caddy validate` loads the certificate, its key and the client CA: with throw-away files,
  // mounted where the compose mounts ORIGIN_TLS_DIR.
  const pki = throwawayPki('localhost');
  try {
    const r = dockerRun(serviceImage('caddy'), {
      mounts: [
        { src: path.join(DEPLOY_DIR, 'Caddyfile'), dst: '/etc/caddy/Caddyfile' },
        { src: pki.edgeDir, dst: '/etc/caddy/origin' },
      ],
      env: { DOMAIN: 'localhost' },
      args: ['caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /Valid configuration/);
  } finally {
    pki.remove();
  }

  const server = caddyAdapt().apps.http.servers.srv0;
  const places = { routes: server.routes, 'error routes': server.errors?.routes };
  for (const [where, list] of Object.entries(places)) {
    assert.ok(list, `no ${where}`);
    const headers = caddyHandlers(list).filter((h) => h.handler === 'headers' && h.response);
    const deferred = headers.find((h) => h.response.deferred && h.response.set?.['Strict-Transport-Security']);
    assert.ok(deferred, `${where}: no deferred security header handler`);
    const set = deferred.response.set;
    assert.ok(Number(/max-age=(\d+)/.exec(set['Strict-Transport-Security'][0])?.[1]) >= 31536000, `${where}: HSTS max-age`);
    assert.deepEqual(set['X-Content-Type-Options'], ['nosniff'], where);
    assert.deepEqual(set['X-Frame-Options'], ['DENY'], where);
    assert.ok(set['Referrer-Policy']?.[0], `${where}: Referrer-Policy`);
    assert.match(set['Permissions-Policy']?.[0] ?? '', /camera=\(\).*geolocation=\(\).*microphone=\(\)/, `${where}: Permissions-Policy`);
    assert.deepEqual([...deferred.response.delete].sort(), ['Server', 'X-Powered-By'], where);
    const csp = headers.find((h) => h.response.require?.headers && 'Content-Security-Policy' in h.response.require.headers);
    assert.match(csp?.response.set['Content-Security-Policy'][0] ?? '', /frame-ancestors 'none'/, `${where}: default CSP`);
  }
});

test("F-31: caddy takes the visitor's address from CF-Connecting-IP and sets every forwarding header Laravel trusts", () => {
  const server = caddyAdapt().apps.http.servers.srv0;
  // CF-Connecting-IP from any source: safe only because no handshake completes without
  // Cloudflare's client certificate ("every TLS connection policy requires ..." below).
  assert.deepEqual(server.trusted_proxies, { ranges: ['0.0.0.0/0', '::/0'], source: 'static' });
  assert.deepEqual(server.client_ip_headers, ['CF-Connecting-IP']);
  // Laravel trusts For, Host and Proto from caddy (api/bootstrap/app.php; TRUSTED_PROXIES is
  // caddy's address). With every source trusted, caddy would pass on what a client sent: it SETS
  // each of the three instead.
  const bootstrap = readText(path.join(REPO_ROOT, 'api', 'bootstrap', 'app.php'));
  const trusted = /trustProxies\(\s*headers:\s*([^,]+),/.exec(bootstrap)?.[1].match(/HEADER_X_FORWARDED_[A-Z]+/g)?.sort();
  assert.deepEqual(trusted, ['HEADER_X_FORWARDED_FOR', 'HEADER_X_FORWARDED_HOST', 'HEADER_X_FORWARDED_PROTO'], 'the forwarding headers Laravel trusts');
  const proxy = edgeProxies().api ?? [];
  assert.equal(proxy.length, 1);
  const set = proxy[0].headers?.request?.set ?? {};
  assert.deepEqual(set['X-Forwarded-For'], ['{http.vars.client_ip}'], 'the address Caddy took from CF-Connecting-IP');
  assert.deepEqual(set['X-Forwarded-Host'], ['{http.request.host}']);
  assert.deepEqual(set['X-Forwarded-Proto'], ['{http.request.scheme}']);
});

test('edge: every TLS connection policy requires the client certificate of the origin-pull CA; 443 only, no ACME, and no setting reaches it', () => {
  const config = caddyAdapt();
  const servers = Object.values(config.apps.http.servers);
  assert.equal(servers.length, 1, 'the edge runs one server');
  const [server] = servers;
  assert.deepEqual(server.listen, [':443'], 'the edge listens on 443 only');
  assert.equal(server.automatic_https?.disable, true, 'automatic HTTPS (ACME and the port-80 redirect) is on');
  assert.equal(server.strict_sni_host, true, 'the Host header may differ from the TLS server name');
  assert.deepEqual(server.protocols, ['h1', 'h2'], 'HTTP/3 would listen on UDP 443');
  // Every policy, the catch-all for other names and for a handshake without a name included.
  const policies = server.tls_connection_policies ?? [];
  const ca = JSON.stringify({ pem_files: ['/etc/caddy/origin/origin-pull-ca.pem'], provider: 'file' });
  console.log(`edge: ${policies.length} TLS connection policies (${policies.map((p) => p.match?.sni?.join(',') ?? 'any other name, or none').join('; ')})`);
  const open = policies.filter((p) => p.client_authentication?.mode !== 'require_and_verify' || JSON.stringify(p.client_authentication?.ca) !== ca);
  assert.deepEqual(open.map((p) => JSON.stringify(p)), [], 'a TLS policy that completes a handshake without the client certificate');
  assert.deepEqual(policies.map((p) => p.match?.sni ?? null), [['localhost'], null], 'one policy for DOMAIN and one for every other name');
  // The site for every other name answers nothing: it closes the connection.
  const routes = server.routes;
  assert.deepEqual(routes.map((r) => r.match?.[0]?.host ?? null), [['localhost'], null]);
  assert.deepEqual(caddyHandlers(routes[1]).map((h) => [h.handler, h.abort ?? null]), [['subroute', null], ['static_response', true]]);
  // The certificate pair is the files of ORIGIN_TLS_DIR; nothing is fetched, issued or stapled.
  const tls = config.apps.tls;
  assert.deepEqual(Object.keys(tls.certificates ?? {}), ['load_files'], 'certificates from somewhere else');
  assert.deepEqual(tls.certificates.load_files.map((f) => [f.certificate, f.key]), [['/etc/caddy/origin/origin-cert.pem', '/etc/caddy/origin/origin-key.pem']]);
  assert.ok(!JSON.stringify(tls).includes('"issuers"'), 'an ACME or other issuer');
  assert.equal(tls.disable_ocsp_stapling, true, 'OCSP stapling (a call out) is on');
  assert.deepEqual(Object.keys(config.apps).sort(), ['http', 'tls'], 'another app (pki: a CA of its own)');
  // No setting reaches the TLS rules: caddy gets DOMAIN only, the Caddyfile's only placeholder.
  assert.deepEqual(Object.keys(base().services.caddy.environment ?? {}), ['DOMAIN'], "caddy's settings");
  const code = readText(path.join(DEPLOY_DIR, 'Caddyfile')).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.deepEqual([...new Set([...code.matchAll(/\{\$[^}]*\}|\{env\.[^}]*\}/g)].map((m) => m[0]))], ['{$DOMAIN}'], 'a setting reaches the Caddyfile');
});

test('request bodies: 9 MB only for multipart uploads, otherwise the largest body limit of the backends', () => {
  const php = readText(path.join(REPO_ROOT, 'api', 'app', 'Http', 'Middleware', 'LimitRequestBody.php'));
  const kb = ['JSON_LIMIT_KB', 'WEBHOOK_JSON_LIMIT_KB', 'URLENCODED_LIMIT_KB']
    .map((n) => Number(new RegExp(`const ${n} = (\\d+);`).exec(php)?.[1]));
  assert.ok(kb.every((n) => n > 0), 'cannot read the limits in LimitRequestBody.php');
  // The image limit of the one upload writer (Laravel's validation rule, in kB).
  const upload = Number(/public const MAX_KB = (\d+);/.exec(readText(path.join(REPO_ROOT, 'api', 'app', 'Support', 'Uploads.php')))?.[1]) * 1024;
  const post = Number(/^post_max_size = (\d+)M/m.exec(readText(path.join(REPO_ROOT, 'api', 'docker', 'php.ini')))?.[1]) * 1024 * 1024;
  assert.ok(upload > 0 && post > 0, 'cannot read the upload limit or post_max_size');

  const limits = siteRoutes().filter((r) => r.handle?.[0]?.handler === 'request_body');
  assert.equal(limits.length, 2, 'two request_body handlers');
  const multipart = limits.find((r) => r.match?.[0]?.header?.['Content-Type']?.[0] === 'multipart/form-data*');
  const other = limits.find((r) => r.match?.[0]?.not?.[0]?.header?.['Content-Type']?.[0] === 'multipart/form-data*');
  assert.ok(multipart && other, 'one limit for multipart, one for every other body, never both');
  assert.equal(multipart.handle[0].max_size, 9000000);
  assert.ok(multipart.handle[0].max_size > upload && multipart.handle[0].max_size < post, 'between the image limit and post_max_size');
  assert.equal(other.handle[0].max_size, Math.max(...kb) * 1024, "the largest of Laravel's non-upload limits");
});

// ------------------------------------------------------------------------------ F-45, F-17

test('F-45: every service rotates its log with the required limits', () => {
  const values = ciValues();
  const services = servicesOf(base());
  assert.ok(services.length > 0);
  // The CI override's own services (the mail catcher, the stack test's probe) as well.
  const ciOnly = servicesOf(ci()).filter(([name]) => !base().services[name]);
  const wrong = [...services, ...ciOnly].filter(([, s]) => s.logging?.driver !== 'local'
    || s.logging.options?.['max-size'] !== values.LOG_MAX_SIZE
    || s.logging.options?.['max-file'] !== values.LOG_MAX_FILES).map(([n]) => n);
  console.log(`logging: ${services.length} services checked (${services.filter(([, s]) => s.restart).length} long-running), `
    + `and ${ciOnly.length} of the CI override (${ciOnly.map(([n]) => n).join(', ')})`);
  assert.ok(ciOnly.length > 0, 'no service of the CI override found');
  assert.deepEqual(wrong, []);
});

test('F-45: LOG_MAX_FILES is at least 2 wherever it is checked or explained (the local log driver refuses one file while it compresses)', () => {
  const preflight = readText(path.join(DEPLOY_DIR, 'scripts', 'preflight.sh'));
  const source = /LOG_FILES_PATTERN='([^']+)'/.exec(preflight)?.[1];
  assert.ok(source, 'cannot find LOG_FILES_PATTERN in deploy/scripts/preflight.sh');
  const pattern = new RegExp(source);
  const accepted = Array.from({ length: 1000 }, (_, n) => n).filter((n) => pattern.test(String(n)));
  console.log(`LOG_MAX_FILES: the preflight accepts ${accepted.length} of the numbers 0 to 999, from ${accepted[0]}`);
  assert.ok(accepted.length > 0, 'the preflight accepts no number: refusing to report clean');
  const min = accepted[0];
  assert.deepEqual(accepted, Array.from({ length: accepted.length }, (_, i) => min + i), 'the accepted numbers have a gap');
  // Docker's local driver compresses rotated files unless told otherwise, and then refuses
  // max-file 1 ("compression cannot be enabled when max file count is 1"): no container starts.
  const options = base().services.db.logging?.options ?? {};
  if (options.compress !== 'false') assert.ok(min >= 2, `the preflight accepts LOG_MAX_FILES=${min}, which Docker's local log driver refuses while it compresses`);
  const docs = [
    ['deploy/scripts/preflight.sh', preflight, /LOG_MAX_FILES "\$LOG_FILES_PATTERN" 'a number of files, at least (\d+)'/],
    ['deploy/.env.example', readText(ENV_EXAMPLE), /LOG_MAX_FILES: a number, at least (\d+)/],
    ['deploy/README.md', readText(RUNBOOK), /^\| `LOG_MAX_FILES` \|.*\bat least (\d+)/m],
  ];
  assert.deepEqual(docs.filter(([, text, re]) => Number(re.exec(text)?.[1]) !== min).map(([file]) => file), [], `files that give LOG_MAX_FILES another minimum than the preflight's ${min}`);
});

test('F-45: the MySQL binary log keeps the required retention, never the MySQL default or forever', () => {
  const db = base().services.db;
  assert.deepEqual(db.entrypoint, ['bash', '/opt/deploy/db-entrypoint.sh']);
  assert.deepEqual(db.command, ['mysqld']);
  assert.equal(db.environment.MYSQL_BINLOG_RETENTION_DAYS, ciValues().MYSQL_BINLOG_RETENTION_DAYS);
  // The event scheduler runs in every case: it rotates the binary log every day
  // (deploy/mysql/02-binlog-rotate.sql), and with `off` the event changes nothing.
  const cases = [
    ['1', 0, '--binlog-expire-logs-seconds=86400 --event-scheduler=ON'],
    ['30', 0, '--binlog-expire-logs-seconds=2592000 --event-scheduler=ON'],
    ['9999', 0, '--binlog-expire-logs-seconds=863913600 --event-scheduler=ON'],
    ['off', 0, '--disable-log-bin --event-scheduler=ON'],
    ...['', '0', '00', '-1', '1.5', 'abc', '10000', 'OFF', '7d', ' 7'].map((v) => [v, 2, null]),
  ];
  const script = cases.map(([v], i) => `MYSQL_BINLOG_RETENTION_DAYS=${JSON.stringify(v)} bash /opt/deploy/db-entrypoint.sh --print-command mysqld > /tmp/out 2>&1; echo "case ${i} exit $?: $(tr '\\n' ' ' < /tmp/out)"`).join('\n');
  const r = dockerRun(serviceImage('db'), {
    mounts: [{ src: path.join(DEPLOY_DIR, 'scripts', 'db-entrypoint.sh'), dst: '/opt/deploy/db-entrypoint.sh' }],
    entrypoint: 'bash',
    args: ['-c', script],
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, cases.length, r.stdout);
  console.log(`binary log retention: ${cases.length} values checked`);
  cases.forEach(([value, code, flag], i) => {
    const m = new RegExp(`^case ${i} exit (\\d+): (.*)$`).exec(lines[i]);
    assert.ok(m, lines[i]);
    assert.equal(Number(m[1]), code, `value ${JSON.stringify(value)}: ${m[2]}`);
    if (flag) assert.equal(m[2].trim(), `docker-entrypoint.sh mysqld ${flag}`);
    else assert.match(m[2], /MYSQL_BINLOG_RETENTION_DAYS must be/);
  });
});

test('F-45: the db service creates a daily binary-log rotation on its first start, and grants nothing', () => {
  const config = base();
  const db = config.services.db;
  const files = initFiles(config);
  console.log(`first-start files of db: ${files.length} (${files.map((f) => path.posix.basename(f.target)).join(', ')})`);
  assert.ok(files.length > 0, 'the db service mounts nothing into /docker-entrypoint-initdb.d: refusing to report clean');
  assert.deepEqual(files.filter((f) => f.read_only !== true).map((f) => f.target), [], 'first-start files mounted writable');
  const rotate = files.find((f) => /binlog-rotate\.sql$/.test(f.target));
  assert.ok(rotate, 'the db service mounts no binary-log rotation into /docker-entrypoint-initdb.d');
  assert.equal(posix(path.relative(DEPLOY_DIR, rotate.source)), `mysql/${path.posix.basename(rotate.target)}`, 'the rotation comes from deploy/mysql/');
  // MySQL runs these files as root, once, on an empty volume: the event runs as root, so neither
  // the app user nor the backup needs the right to flush logs.
  const sql = readText(rotate.source).split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
  const event = /^CREATE EVENT IF NOT EXISTS (\w+)\.binlog_rotate\s+ON SCHEDULE EVERY 1 DAY\b[^;]*\bDO FLUSH BINARY LOGS;\s*$/.exec(sql.trim());
  assert.ok(event, `not one daily FLUSH BINARY LOGS event:\n${sql}`);
  assert.equal(event[1], db.environment.MYSQL_DATABASE, "the event lives in the app's database");
  assert.doesNotMatch(sql, /\b(GRANT|CREATE USER|ALTER USER|SET PASSWORD)\b/i, 'the first-start file changes rights');
});

// Runs inside the pinned db image with the compose's own entrypoint and first-start files: starts
// MySQL, checks the event and the scheduler, then shortens the event to seconds (rotate every 2 s,
// delete binary-log files older than 4 s), writes and deletes a row, and waits until no
// binary-log file holds it any more. Prints `key: value` lines.
const BINLOG_ROTATION_CHECK = String.raw`set -u
bash /opt/deploy/db-entrypoint.sh mysqld > /tmp/mysqld.log 2>&1 &
ready=0
for i in $(seq 1 180); do
  if mysqladmin ping -h 127.0.0.1 --silent > /dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
echo "ready: $ready"
q() { MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -h127.0.0.1 -N -B -e "$1" 2>&1 | tr '\t\n' '  ' | sed 's/ *$//'; }
echo "settings: $(q 'SELECT @@event_scheduler, @@log_bin, @@binlog_expire_logs_seconds')"
echo "events: $(q 'SELECT COUNT(*) FROM information_schema.EVENTS')"
echo "event: $(q "SELECT CONCAT_WS('|', EVENT_SCHEMA, EVENT_NAME, STATUS, INTERVAL_VALUE, INTERVAL_FIELD, DEFINER, EVENT_DEFINITION) FROM information_schema.EVENTS")"
echo "shortened: $(q "SET GLOBAL binlog_expire_logs_seconds = 4; ALTER EVENT $MYSQL_DATABASE.binlog_rotate ON SCHEDULE EVERY 2 SECOND")"
marker="binlog-marker-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
# The marker is an account name written and removed again: account statements go to the binary log
# like a row that is written and deleted, so the check needs no table of its own.
echo "row: $(q "CREATE USER '$marker'@'localhost'; DROP USER '$marker'@'localhost'")"
holding() { grep -l -F "$marker" /var/lib/mysql/binlog.[0-9]* 2>/dev/null | wc -l; }
echo "files with the row: $(holding)"
gone=never
for i in $(seq 1 45); do
  sleep 1
  if [ "$(holding)" = 0 ]; then gone=$i; break; fi
done
echo "gone after: $gone"
echo "executed: $(q 'SELECT COUNT(*) FROM information_schema.EVENTS WHERE LAST_EXECUTED IS NOT NULL')"
echo "event errors: $(grep -c -E '\[ERROR\].*binlog_rotate' /tmp/mysqld.log)"
`;

test('F-45: on a real MySQL the rotation removes a deleted row from the binary log once the retention passed (seconds for days), and runs cleanly with the log off', async () => {
  const config = base();
  const db = config.services.db;
  const entrypoint = (db.volumes ?? []).find((v) => v.type === 'bind' && v.target === '/opt/deploy/db-entrypoint.sh');
  assert.ok(entrypoint, 'the db service does not mount scripts/db-entrypoint.sh');
  const files = initFiles(config);
  assert.ok(files.some((f) => /binlog-rotate\.sql$/.test(f.target)), 'the db service mounts no binary-log rotation into /docker-entrypoint-initdb.d');
  const start = (days) => dockerRunAsync(serviceImage('db'), {
    mounts: [entrypoint, ...files].map((v) => ({ src: v.source, dst: v.target })),
    env: { MYSQL_DATABASE: db.environment.MYSQL_DATABASE, MYSQL_ROOT_PASSWORD: 'test-only-not-a-secret-root', MYSQL_BINLOG_RETENTION_DAYS: days },
    entrypoint: 'bash',
    args: ['-c', BINLOG_ROTATION_CHECK],
  });
  const [on, off] = await Promise.all([start('1'), start('off')]);
  const event = `${db.environment.MYSQL_DATABASE}|binlog_rotate|ENABLED|1|DAY|root@localhost|FLUSH BINARY LOGS`;
  for (const [label, r] of [['1 day', on], ['off', off]]) {
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    const got = reported(r.stdout);
    console.log(`binary log ${label}: ${['settings', 'events', 'files with the row', 'gone after', 'executed', 'event errors'].map((k) => `${k} ${got[k]}`).join('; ')}`);
    assert.equal(got.ready, '1', `${label}: MySQL did not start:\n${r.stdout}`);
    assert.equal(got.events, '1', `${label}: one event`);
    assert.equal(got.event, event, `${label}: the daily rotation`);
    assert.equal(got.shortened, '', `${label}: shortening the event failed`);
    assert.equal(got.row, '', `${label}: writing the row failed`);
    assert.equal(got.executed, '1', `${label}: the event never ran`);
    assert.equal(got['event errors'], '0', `${label}: MySQL logged errors of the event`);
    if (label === 'off') {
      assert.match(got.settings, /^ON 0 \d+$/, 'off: the event scheduler runs and the binary log is off');
      assert.equal(got['files with the row'], '0');
    } else {
      assert.equal(got.settings, 'ON 1 86400', '1 day: the event scheduler runs and the binary log keeps 1 day');
      assert.ok(Number(got['files with the row']) >= 1, '1 day: the row never reached the binary log, so its removal proves nothing');
      assert.match(got['gone after'], /^\d+$/, '1 day: the deleted row stayed in the binary log for 45 s with a 4 s retention');
    }
  }
});

test("F-45: deploy/ci.env's binary-log retention differs from MySQL's default, so the stack test shows the setting took effect", () => {
  const days = ciValues().MYSQL_BINLOG_RETENTION_DAYS;
  assert.match(days, /^[1-9][0-9]*$/, 'deploy/ci.env must keep the binary log a number of days: with off the stack test cannot show that the retention took effect');
  const r = dockerRun(serviceImage('db'), { entrypoint: 'mysqld', args: ['--no-defaults', '--verbose', '--help'] });
  assert.equal(r.status, 0, r.stderr);
  const fallback = Number(/^binlog-expire-logs-seconds\s+(\d+)\s*$/m.exec(r.stdout)?.[1]);
  assert.ok(fallback > 0, "cannot read MySQL's default binlog-expire-logs-seconds from mysqld --verbose --help");
  console.log(`binary log: deploy/ci.env keeps it ${days} day(s) = ${Number(days) * 86400} s; MySQL's own default is ${fallback} s`);
  assert.notEqual(Number(days) * 86400, fallback, "deploy/ci.env uses MySQL's own default: the stack test could not tell the setting from the default");
});

test('F-17: backups go to the required BACKUP_DIR bind, never created implicitly, and to a volume in CI', () => {
  const backup = base().services.backup;
  assert.ok(backup, 'no backup service');
  const bind = backup.volumes.find((v) => v.target === '/backups');
  assert.equal(bind.type, 'bind');
  assert.equal(posix(bind.source).replace(/^[A-Za-z]:/, ''), ciValues().BACKUP_DIR);
  // What the rendered configuration says about creating the source depends on the docker compose
  // version: v5.5.1 prints `create_host_path: false` for an explicit false and leaves the key out
  // for true (and for the short syntax, which implies true); v2.38.2 (on GitHub's runner) leaves
  // it out whatever the file says. So a rendered configuration can only refuse a version that
  // prints `true`; it cannot show on its own that the source is not created.
  assert.ok([undefined, false].includes(bind.bind?.create_host_path), `the BACKUP_DIR bind renders create_host_path: ${JSON.stringify(bind.bind?.create_host_path)}; it must be false (or left out by a compose that omits it)`);
  // The compose file itself must say it, in the long syntax: the check that holds on every version.
  assert.match(
    serviceText('backup'),
    /^ *- type: bind\n *source: \$\{BACKUP_DIR:\?[^\n]*\}\n *target: \/backups\n *bind:\n *create_host_path: false *$/m,
    `deploy/${COMPOSE_FILE}: the backup service's /backups bind must be written in the long syntax with create_host_path: false (the short syntax implies true)`,
  );
  assert.equal(backup.environment.BACKUP_RETENTION_DAYS, ciValues().BACKUP_RETENTION_DAYS);
  // Root without capabilities reads the evidence images only through the www-data group, which
  // Laravel gives read access and nobody else (api/config/filesystems.php, the private disk).
  assert.deepEqual((backup.group_add ?? []).map(String), ['33'], 'the backup does not read the evidence images through the www-data group');
  assert.match(readText(path.join(REPO_ROOT, 'api', 'config', 'filesystems.php')), /'permissions' => \[\s*'file' => \['public' => 0640, 'private' => 0640\],\s*'dir' => \['public' => 0750, 'private' => 0750\],/, 'the private disk does not give owner and group, and only them, read access');
  assert.deepEqual(backup.healthcheck.test, ['CMD', 'bash', '/opt/deploy/backup.sh', '--check']);
  assert.ok(backup.restart, 'the backup service is long-running');
  const ciBackup = ci().services.backup.volumes.find((v) => v.target === '/backups');
  assert.deepEqual({ type: ciBackup.type, source: ciBackup.source }, { type: 'volume', source: 'ci-backups' });
});

test('F-17: the preflight refuses a BACKUP_DIR inside the clone, checks the edge\'s TLS files and the env file, without printing values', () => {
  const secrets = Object.entries(ciValues()).filter(([k, v]) => /PASSWORD|SECRET|_KEY$/.test(k) && v !== '').map(([, v]) => v);
  // Runs inside the db image (bash, coreutils, openssl): the file modes a check needs exist only
  // on a Linux file system. A stand-in `docker` records its arguments, so the last check's call is
  // visible without a Docker daemon in the container. The TLS files are throw-away ones
  // (deploy/test/throwaway-pki.sh, for DOMAIN=localhost as in deploy/ci.env), made in here as
  // root: the key root's with mode 600, the certificate and the CA with mode 644.
  const driver = [
    'set -u',
    'mkdir -p /work /clone/backups',
    'chmod 700 /clone/backups',
    "cat > /usr/local/bin/docker <<'EOF'",
    '#!/bin/sh',
    "printf '%s ' \"$@\" > /work/docker-args",
    'exit "${FAKE_DOCKER_STATUS:-0}"',
    'EOF',
    'chmod 755 /usr/local/bin/docker',
    'install -d -m 700 /work/backups',
    'install -d -m 755 /work/open',
    'ln -s /clone/backups /work/into-clone',
    'sh /opt/throwaway-pki.sh /work/pki localhost > /dev/null',
    'cp -a /work/pki/edge /work/tls',
    // Certificates that fit only in part: expired long ago, another name, another key; a CA that
    // expired long ago.
    "openssl req -x509 -new -key /work/pki/edge/origin-key.pem -sha256 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost' -not_before 20200101000000Z -not_after 20200102000000Z -out /work/cert-expired.pem 2>/dev/null",
    "openssl req -x509 -new -key /work/pki/edge/origin-key.pem -sha256 -subj /CN=other.example.invalid -addext 'subjectAltName=DNS:other.example.invalid' -days 1 -out /work/cert-other-name.pem 2>/dev/null",
    'openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /work/other.key 2>/dev/null',
    "openssl req -x509 -new -key /work/other.key -sha256 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost' -days 1 -out /work/cert-other-key.pem 2>/dev/null",
    "openssl req -x509 -new -key /work/other.key -sha256 -subj '/CN=expired CA' -addext 'basicConstraints=critical,CA:TRUE' -not_before 20200101000000Z -not_after 20200102000000Z -out /work/ca-expired.pem 2>/dev/null",
    'envfile() { sed -e "s|^BACKUP_DIR=.*|BACKUP_DIR=$1|" -e "s|^ORIGIN_TLS_DIR=.*|ORIGIN_TLS_DIR=${2:-/work/tls}|" /clone/deploy/ci.env > /work/prod.env; chmod 600 /work/prod.env; }',
    // A fresh copy of the good TLS files for one case, at /work/case.
    'tlscase() { rm -rf /work/case; cp -a /work/pki/edge /work/case; envfile /work/backups /work/case; }',
    "run() { out=$(bash /clone/deploy/scripts/preflight.sh \"${ENV_FILE:-/work/prod.env}\" 2>&1); code=$?; printf '=== %s exit %s\\n%s\\n' \"$1\" \"$code\" \"$out\"; }",
    'envfile /work/backups; run ok; echo "docker: $(cat /work/docker-args)"',
    'envfile relative/backups; run relative',
    'envfile /clone/backups; run inside-clone',
    'envfile /work/into-clone; run symlink-into-clone',
    'envfile /work/missing; run missing-dir',
    'envfile /work/open; run open-dir',
    'envfile /work/backups; chmod 644 /work/prod.env; run readable-env',
    "envfile /work/backups; sed -i 's/^BACKUP_RETENTION_DAYS=.*/BACKUP_RETENTION_DAYS=0/' /work/prod.env; run retention-zero",
    "envfile /work/backups; sed -i 's/^MYSQL_BINLOG_RETENTION_DAYS=.*/MYSQL_BINLOG_RETENTION_DAYS=0/' /work/prod.env; run binlog-zero",
    "envfile /work/backups; sed -i 's/^LOG_MAX_SIZE=.*/LOG_MAX_SIZE=10/' /work/prod.env; run log-size",
    "envfile /work/backups; sed -i 's/^LOG_MAX_FILES=.*/LOG_MAX_FILES=1/' /work/prod.env; run log-files-one",
    "envfile /work/backups; sed -i 's/^LOG_MAX_FILES=.*/LOG_MAX_FILES=2/' /work/prod.env; run log-files-two",
    "envfile /work/backups; sed -i 's/^EVIDENCE_RETENTION_DAYS=.*/EVIDENCE_RETENTION_DAYS=0/' /work/prod.env; run evidence-zero",
    "envfile /work/backups; sed -i 's/^TOKEN_RETENTION_DAYS=.*/TOKEN_RETENTION_DAYS=7d/' /work/prod.env; run token-days",
    "envfile /work/backups; sed -i 's/^PAYMENTS_MODE=.*/PAYMENTS_MODE=on/' /work/prod.env; run payments-on",
    "envfile /work/backups; sed -i 's/^PAYMENTS_MODE=.*/PAYMENTS_MODE=off/' /work/prod.env; run payments-off",
    "envfile /work/backups; sed -i 's/^MAIL_MAILER=.*/MAIL_MAILER=/' /work/prod.env; run mailer-empty",
    ...OTHER_MAILERS.map((mailer) => `envfile /work/backups; sed -i 's/^MAIL_MAILER=.*/MAIL_MAILER=${mailer}/' /work/prod.env; run mailer-${mailer}`),
    "envfile /work/backups; sed -i 's/^MAIL_MAILER=.*/MAIL_MAILER=graph/' /work/prod.env; run graph-no-client",
    "envfile /work/backups; sed -i -e 's/^MAIL_MAILER=.*/MAIL_MAILER=graph/' -e 's/^MAIL_GRAPH_CLIENT_ID=.*/MAIL_GRAPH_CLIENT_ID=not-a-guid/' /work/prod.env; run graph-client-not-a-guid",
    "envfile /work/backups; sed -i -e 's/^MAIL_MAILER=.*/MAIL_MAILER=graph/' -e 's/^MAIL_GRAPH_CLIENT_ID=.*/MAIL_GRAPH_CLIENT_ID=00000000-0000-4000-8000-00000000000b/' -e 's/^MAIL_HOST=.*/MAIL_HOST=/' /work/prod.env; run graph-ok",
    "envfile /work/backups; sed -i 's/^MAIL_HOST=.*/MAIL_HOST=/' /work/prod.env; run smtp-no-host",
    "envfile /work/backups; sed -i 's/^MAIL_FROM_ADDRESS=.*/MAIL_FROM_ADDRESS=not-an-address/' /work/prod.env; run sender-not-an-address",
    "envfile /work/backups; sed -i 's/^APP_NET_PREFIX=.*/APP_NET_PREFIX=172.30/' /work/prod.env; run prefix-two-parts",
    "envfile /work/backups; sed -i 's/^APP_NET_PREFIX=.*/APP_NET_PREFIX=172.30.099/' /work/prod.env; run prefix-leading-zero",
    // The TLS folder and its three files.
    'envfile /work/backups relative/tls; run tls-relative',
    'envfile /work/backups /work/no-such-folder; run tls-missing',
    'cp -a /work/pki/edge /clone/tls; envfile /work/backups /clone/tls; run tls-inside-clone',
    'tlscase; chmod 777 /work/case; run tls-open',
    'tlscase; chown 1000 /work/case; run tls-not-root',
    'tlscase; rm /work/case/origin-key.pem; run key-missing',
    'tlscase; chmod 644 /work/case/origin-key.pem; run key-readable',
    'tlscase; mv /work/case/origin-key.pem /work/key-elsewhere.pem; ln -s /work/key-elsewhere.pem /work/case/origin-key.pem; run key-link',
    'tlscase; cat /work/pki/edge/origin-cert.pem > /work/case/origin-key.pem; run key-not-a-key',
    'tlscase; rm /work/case/origin-cert.pem; run cert-missing',
    "tlscase; echo 'not a certificate' > /work/case/origin-cert.pem; run cert-not-a-certificate",
    'tlscase; cat /work/cert-expired.pem > /work/case/origin-cert.pem; run cert-expired',
    'tlscase; cat /work/cert-other-name.pem > /work/case/origin-cert.pem; run cert-other-name',
    'tlscase; cat /work/cert-other-key.pem > /work/case/origin-cert.pem; run cert-other-key',
    'tlscase; chmod 666 /work/case/origin-cert.pem; run cert-open',
    'tlscase; rm /work/case/origin-pull-ca.pem; run ca-missing',
    "tlscase; echo 'not a certificate' > /work/case/origin-pull-ca.pem; run ca-not-a-certificate",
    'tlscase; cat /work/ca-expired.pem > /work/case/origin-pull-ca.pem; run ca-expired',
    'tlscase; chmod 666 /work/case/origin-pull-ca.pem; run ca-open',
    'tlscase; chmod 400 /work/case/origin-key.pem; run key-400',
    'envfile /work/backups; DB_PASSWORD=shell-value-not-a-secret run shell-export',
    'envfile /work/backups; FAKE_DOCKER_STATUS=1 run compose-fails',
    'ENV_FILE=/work/none.env run no-env-file',
  ].join('\n');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'scripts', 'preflight.sh')), 'no deploy/scripts/preflight.sh');
  const r = dockerRun(serviceImage('db'), {
    mounts: [{ src: DEPLOY_DIR, dst: '/clone/deploy' }, { src: THROWAWAY_PKI, dst: '/opt/throwaway-pki.sh' }],
    entrypoint: 'bash',
    args: ['-c', driver],
  });
  assert.equal(r.status, 0, r.stderr);
  const runs = Object.fromEntries(r.stdout.split(/^=== /m).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [, name, code] = /^(\S+) exit (\d+)$/.exec(head);
    return [name, { code: Number(code), out: rest.join('\n') }];
  }));
  const expected = {
    ok: [0, null],
    relative: [1, 'FAIL  BACKUP_DIR is an absolute path'],
    'inside-clone': [1, 'FAIL  BACKUP_DIR lies outside this clone'],
    'symlink-into-clone': [1, 'FAIL  BACKUP_DIR lies outside this clone'],
    'missing-dir': [1, 'FAIL  BACKUP_DIR is an existing directory'],
    'open-dir': [1, 'FAIL  BACKUP_DIR belongs to root with mode 700'],
    'readable-env': [1, 'FAIL  only the owner can read the env file'],
    'retention-zero': [1, 'FAIL  BACKUP_RETENTION_DAYS has a valid form'],
    'binlog-zero': [1, 'FAIL  MYSQL_BINLOG_RETENTION_DAYS has a valid form'],
    'log-size': [1, 'FAIL  LOG_MAX_SIZE has a valid form'],
    // Docker's local log driver refuses one file while it compresses the rotated ones.
    'log-files-one': [1, 'FAIL  LOG_MAX_FILES has a valid form: a number of files, at least 2'],
    'log-files-two': [0, null],
    'evidence-zero': [1, 'FAIL  EVIDENCE_RETENTION_DAYS has a valid form: whole days, at least 1'],
    'token-days': [1, 'FAIL  TOKEN_RETENTION_DAYS has a valid form: whole days, at least 1'],
    'payments-on': [1, 'FAIL  PAYMENTS_MODE has a valid form: off or test'],
    'payments-off': [0, null],
    'mailer-empty': [1, 'FAIL  MAIL_MAILER has a valid form: graph or smtp'],
    ...Object.fromEntries(OTHER_MAILERS.map((mailer) => [`mailer-${mailer}`, [1, 'FAIL  MAIL_MAILER has a valid form: graph or smtp']])),
    'graph-no-client': [1, "FAIL  MAIL_GRAPH_CLIENT_ID has a valid form: the managed identity's client ID, a GUID"],
    'graph-client-not-a-guid': [1, "FAIL  MAIL_GRAPH_CLIENT_ID has a valid form: the managed identity's client ID, a GUID"],
    'graph-ok': [0, null],
    'smtp-no-host': [1, 'FAIL  MAIL_HOST is set (MAIL_MAILER=smtp)'],
    'sender-not-an-address': [1, 'FAIL  MAIL_FROM_ADDRESS has a valid form: an e-mail address'],
    // scripts/metadata-access.sh builds the host rules from it and refuses the same.
    'prefix-two-parts': [1, 'FAIL  APP_NET_PREFIX has a valid form: three numbers from 0 to 255'],
    'prefix-leading-zero': [1, 'FAIL  APP_NET_PREFIX has a valid form: three numbers from 0 to 255'],
    'tls-relative': [1, 'FAIL  ORIGIN_TLS_DIR is an absolute path'],
    'tls-missing': [1, 'FAIL  ORIGIN_TLS_DIR is an existing directory'],
    'tls-inside-clone': [1, 'FAIL  ORIGIN_TLS_DIR lies outside this clone'],
    'tls-open': [1, 'FAIL  ORIGIN_TLS_DIR belongs to root and only root can change it'],
    'tls-not-root': [1, 'FAIL  ORIGIN_TLS_DIR belongs to root and only root can change it'],
    'key-missing': [1, 'FAIL  ORIGIN_TLS_DIR/origin-key.pem is a file, not a symbolic link'],
    'key-readable': [1, 'FAIL  origin-key.pem belongs to root with mode 600 or 400'],
    // A link would point to a path that does not exist inside caddy's container.
    'key-link': [1, 'FAIL  ORIGIN_TLS_DIR/origin-key.pem is a file, not a symbolic link'],
    'key-not-a-key': [1, 'FAIL  origin-key.pem holds a private key'],
    'key-400': [0, null],
    'cert-missing': [1, 'FAIL  ORIGIN_TLS_DIR/origin-cert.pem is a file, not a symbolic link'],
    'cert-not-a-certificate': [1, 'FAIL  origin-cert.pem holds a certificate'],
    'cert-expired': [1, 'FAIL  origin-cert.pem has not expired (Cloudflare would answer 526)'],
    'cert-other-name': [1, 'FAIL  origin-cert.pem names DOMAIN'],
    'cert-other-key': [1, 'FAIL  origin-cert.pem belongs to origin-key.pem'],
    'cert-open': [1, 'FAIL  origin-cert.pem belongs to root and only root can change it'],
    'ca-missing': [1, 'FAIL  ORIGIN_TLS_DIR/origin-pull-ca.pem is a file, not a symbolic link'],
    'ca-not-a-certificate': [1, 'FAIL  origin-pull-ca.pem holds a certificate'],
    'ca-expired': [1, 'FAIL  origin-pull-ca.pem has not expired (every handshake with Cloudflare would fail: 525)'],
    'ca-open': [1, 'FAIL  origin-pull-ca.pem belongs to root and only root can change it'],
    'shell-export': [1, "FAIL  set in this shell as well, docker compose would use the shell's value (unset them): DB_PASSWORD"],
    'compose-fails': [1, 'FAIL  docker compose renders the production compose'],
    'no-env-file': [1, 'FAIL  the env file exists'],
  };
  // The TLS cases that break one thing fail one check: each check stands on its own.
  const single = ['tls-inside-clone', 'tls-open', 'tls-not-root', 'key-readable', 'cert-not-a-certificate', 'cert-expired', 'cert-other-name', 'cert-other-key', 'cert-open', 'ca-not-a-certificate', 'ca-expired', 'ca-open'];
  assert.deepEqual(Object.keys(runs).sort(), Object.keys(expected).sort(), r.stdout);
  console.log(`preflight: ${Object.keys(expected).length} cases`);
  for (const [name, [code, line]] of Object.entries(expected)) {
    const { out } = runs[name];
    assert.equal(runs[name].code, code, `${name}:\n${out}`);
    if (line) assert.ok(out.includes(line), `${name}: expected "${line}" in:\n${out}`);
    assert.match(out, /preflight: \d+ checks, \d+ failed/, `${name}: no total`);
    if (single.includes(name)) assert.match(out, /preflight: \d+ checks, 1 failed/, `${name}: more than one check failed:\n${out}`);
    for (const value of [...secrets, 'shell-value-not-a-secret']) assert.ok(!out.includes(value), `${name} printed a value`);
    assert.doesNotMatch(out, /-----BEGIN/, `${name} printed a key or a certificate`);
  }
  // Every check passed with the good files: the key at mode 600, and at 400 (key-400); the
  // certificate and the CA at mode 644, readable by everyone.
  assert.match(runs.ok.out, /preflight: 34 checks, 0 failed/);
  assert.match(r.stdout, /^docker: compose --project-directory \/clone\/deploy --env-file \/work\/prod\.env -f \/clone\/deploy\/docker-compose\.yml config --quiet $/m);
});

test('F-17: the backup runs nightly at 02:30 UTC and refuses an invalid retention', () => {
  const times = [
    ['2026-01-01T01:00:00Z', 5400],
    ['2026-01-01T02:29:59Z', 1],
    ['2026-01-01T02:30:00Z', 86400],
    ['2026-01-01T23:00:00Z', 12600],
  ];
  const invalid = ['', '0', '-1', '1.5', 'abc', '100000', '7 '];
  const script = [
    ...times.map(([now], i) => `echo "time ${i}: $(BACKUP_NOW=${now} bash /opt/deploy/backup.sh --seconds-until-next)"`),
    ...invalid.map((v, i) => `BACKUP_RETENTION_DAYS=${JSON.stringify(v)} DB_HOST=db DB_DATABASE=d DB_USERNAME=u DB_PASSWORD=p bash /opt/deploy/backup.sh --once > /tmp/out 2>&1; echo "retention ${i} exit $?: $(tr '\\n' ' ' < /tmp/out)"`),
  ].join('\n');
  const r = dockerRun(serviceImage('backup'), {
    mounts: [{ src: path.join(DEPLOY_DIR, 'scripts', 'backup.sh'), dst: '/opt/deploy/backup.sh' }],
    entrypoint: 'bash',
    args: ['-c', script],
  });
  assert.equal(r.status, 0, r.stderr);
  console.log(`backup schedule: ${times.length} clock times, ${invalid.length} invalid retention values`);
  times.forEach(([now, seconds], i) => assert.match(r.stdout, new RegExp(`^time ${i}: ${seconds}$`, 'm'), now));
  invalid.forEach((v, i) => assert.match(r.stdout, new RegExp(`^retention ${i} exit 2: backup: ERROR: BACKUP_RETENTION_DAYS must be`, 'm'), JSON.stringify(v)));
});

/**
 * `backup.sh --once` in the pinned backup image without a database and without network: stand-ins
 * for mysqladmin and mysqldump answer like a server that takes connections once DB_UP_AFTER
 * seconds have passed on a clock that only the stand-in `sleep` moves (it counts instead of
 * waiting). tar is GNU tar itself; TAR_MODE=change creates a file in an archived folder while tar
 * runs (at its first checkpoint, inside uploads/), TAR_MODE=broken adds a path that does not exist.
 * `once <name>` runs one case on an empty /backups and prints what happened.
 */
const BACKUP_STAND_INS = String.raw`set -u
mkdir -p /backups /data/uploads/posts /data/private-media/evidence /work
for i in $(seq 1 64); do head -c 16384 /dev/urandom > /data/uploads/posts/file-$i.png; done
head -c 100 /dev/urandom > /data/private-media/evidence/kept.png
cat > /usr/local/bin/sleep <<'EOF'
#!/bin/sh
echo "$1" >> /work/sleeps
echo $(( $(cat /work/clock) + $1 )) > /work/clock
EOF
cat > /usr/local/bin/mysqladmin <<'EOF'
#!/bin/sh
{ printf '%s ' "$@"; [ -e /tmp/backup-client.cnf ] && printf 'CLIENT-FILE '; [ -n "$MYSQL_PWD" ] && printf 'MYSQL_PWD '; echo; } >> /work/pings
[ "$(cat /work/clock)" -ge "$DB_UP_AFTER" ] && exit 0
echo "mysqladmin: connect to server at 'db' failed" >&2
exit 1
EOF
cat > /usr/local/bin/mysqldump <<'EOF'
#!/bin/sh
echo dump >> /work/dumps
if [ "$(cat /work/clock)" -lt "$DB_UP_AFTER" ]; then echo "mysqldump: Got error: 2003: Can't connect to MySQL server on 'db:3306' (111)" >&2; exit 2; fi
printf -- '-- stand-in dump\nCREATE TABLE t (id INT);\n-- Dump completed on 2026-01-01  0:00:00\n'
EOF
cat > /usr/local/bin/tar <<'EOF'
#!/bin/sh
case " $* " in
  *" -czf "*)
    case "$TAR_MODE" in
      change) exec /usr/bin/tar --checkpoint=1 --checkpoint-action=exec='touch /data/uploads/added-while-archiving' "$@" ;;
      broken) exec /usr/bin/tar "$@" no-such-folder ;;
    esac ;;
esac
exec /usr/bin/tar "$@"
EOF
chmod 755 /usr/local/bin/sleep /usr/local/bin/mysqladmin /usr/local/bin/mysqldump /usr/local/bin/tar
export BACKUP_RETENTION_DAYS=7 DB_HOST=db DB_DATABASE=d DB_USERNAME=u DB_PASSWORD=stand-in-not-a-secret TAR_MODE= DB_UP_AFTER=0
once() {
  rm -rf /backups/* /backups/.[!.]* /work/sleeps /work/pings /work/dumps /data/uploads/added-while-archiving
  echo 0 > /work/clock
  out=$(bash /opt/deploy/backup.sh --once 2>&1); code=$?
  printf '=== %s exit %s\n%s\n' "$1" "$code" "$out"
  echo "check: $(bash /opt/deploy/backup.sh --check 2>&1)"
  echo "sleeps: $(cat /work/sleeps 2>/dev/null | wc -l) of $(sort -u /work/sleeps 2>/dev/null | tr '\n' ' ')s"
  echo "pings: $(cat /work/pings 2>/dev/null | wc -l)"
  echo "ping arguments: $(sort -u /work/pings 2>/dev/null | tr '\n' '|')"
  echo "dumps: $(cat /work/dumps 2>/dev/null | wc -l)"
  latest=$(ls /backups | grep '^uploads-' | tail -n 1)
  echo "sets: $(ls /backups | grep -c '^uploads-')"
  echo "archived files: $(if [ -n "$latest" ]; then /usr/bin/tar -tzf "/backups/$latest" | grep -c -v '/$'; else echo none; fi)"
}
`;

/** The cases of BACKUP_STAND_INS: { name: { code, out, check, pings, ... } }. */
function backupCases(cases) {
  const r = dockerRun(serviceImage('backup'), {
    mounts: [{ src: path.join(DEPLOY_DIR, 'scripts', 'backup.sh'), dst: '/opt/deploy/backup.sh' }],
    entrypoint: 'bash',
    args: ['-c', `${BACKUP_STAND_INS}\n${cases.join('\n')}`],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('stand-in-not-a-secret'), 'a run printed the database password');
  return Object.fromEntries(r.stdout.split(/^=== /m).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [, name, code] = /^(\S+) exit (\d+)$/.exec(head);
    const body = rest.join('\n');
    return [name, { code: Number(code), out: body, ...reported(body.split('\n').filter((l) => !l.startsWith('backup: ')).join('\n')) }];
  }));
}

test('F-17: the backup keeps the uploads archive when files change while tar reads them, and fails on a real tar error', () => {
  const runs = backupCases(['once plain', 'export TAR_MODE=change; once change', 'export TAR_MODE=broken; once broken']);
  console.log(`tar cases: ${Object.keys(runs).length} (${Object.entries(runs).map(([n, r]) => `${n}: exit ${r.code}, ${r.sets} set(s), ${r['archived files']} archived`).join('; ')})`);
  assert.deepEqual(Object.keys(runs), ['plain', 'change', 'broken']);
  const changed = 'files were added or removed while the uploads were archived (tar exit 1); the archive is kept';
  for (const name of ['plain', 'change']) {
    const r = runs[name];
    assert.equal(r.code, 0, `${name}: the run failed:\n${r.out}`);
    assert.match(r.out, /^backup: run \S+ written: /m, `${name}: no set written`);
    assert.equal(r.sets, '1', name);
    assert.equal(r['archived files'], '65', `${name}: the archive does not hold the 65 files`);
    assert.equal(r.check, 'backup: the last run succeeded', name);
  }
  assert.ok(!runs.plain.out.includes(changed), 'plain: warned about changed files');
  assert.ok(runs.change.out.includes(`backup: ${changed}`), `change: no warning about the changed files:\n${runs.change.out}`);
  const broken = runs.broken;
  assert.notEqual(broken.code, 0, 'broken: a tar error passed');
  assert.ok(broken.out.includes('backup: ERROR: archiving the uploads failed (tar exit 2)'), `broken:\n${broken.out}`);
  assert.equal(broken.sets, '0', 'broken: a set was written');
  assert.equal(broken.check, 'backup: no successful run yet');
});

test('F-17: the backup waits for the database without credentials and for a bounded time before it dumps', () => {
  const runs = backupCases(['export DB_UP_AFTER=15; once late', 'export DB_UP_AFTER=1000000; once never']);
  console.log(`database wait: ${Object.entries(runs).map(([n, r]) => `${n}: exit ${r.code}, ${r.pings} ping(s), ${r.sleeps}, ${r.dumps} dump(s)`).join('; ')}`);
  assert.deepEqual(Object.keys(runs), ['late', 'never']);
  const { late, never } = runs;
  // Up after 15 s: three refused pings 5 s apart, the fourth answers, then the dump.
  assert.equal(late.code, 0, `late: the run did not wait for the database:\n${late.out}`);
  assert.equal(late.pings, '4');
  assert.equal(late.sleeps, '3 of 5 s');
  assert.equal(late.dumps, '1');
  assert.match(late.out, /^backup: run \S+ written: /m);
  // Never up: a bounded number of tries, no dump, a failed run the healthcheck reports.
  assert.notEqual(never.code, 0, 'never: the run succeeded without a database');
  assert.equal(never.pings, '60');
  assert.equal(never.sleeps, '59 of 5 s');
  assert.equal(never.dumps, '0', 'never: mysqldump ran against a database that did not answer');
  assert.ok(never.out.includes('backup: ERROR: the database at db did not answer (60 tries, 5 s apart)'), `never:\n${never.out}`);
  assert.equal(never.check, 'backup: no successful run yet');
  // No credentials: no user, no password, no option file, no MYSQL_PWD.
  for (const [name, r] of Object.entries(runs)) {
    const args = r['ping arguments'];
    assert.equal(args, 'ping -h db -P 3306 --connect-timeout=5 --silent |', `${name}: mysqladmin arguments`);
  }
});

test('settings checked in two places use the same patterns (preflight and the services)', () => {
  const read = (file, name) => {
    const full = path.join(DEPLOY_DIR, 'scripts', file);
    return fs.existsSync(full) ? new RegExp(`${name}='([^']+)'`).exec(readText(full))?.[1] : undefined;
  };
  const pairs = [
    ['RETENTION_PATTERN', 'backup.sh', 'RETENTION_PATTERN', 'preflight.sh'],
    ['BINLOG_RETENTION_PATTERN', 'db-entrypoint.sh', 'BINLOG_RETENTION_PATTERN', 'preflight.sh'],
    ['NET_PREFIX_PATTERN', 'metadata-access.sh', 'NET_PREFIX_PATTERN', 'preflight.sh'],
  ];
  for (const [a, fileA, b, fileB] of pairs) {
    const left = read(fileA, a);
    const right = read(fileB, b);
    assert.ok(left && right, `cannot find ${a} in ${fileA} or ${b} in ${fileB}`);
    assert.equal(left, right, `${fileA} ${a} vs ${fileB} ${b}`);
  }
});

test('scripts the containers read from the working tree keep LF line ends', () => {
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'scripts')), 'no deploy/scripts folder');
  const folder = (name) => (fs.existsSync(path.join(DEPLOY_DIR, name))
    ? fs.readdirSync(path.join(DEPLOY_DIR, name)).map((f) => path.join(DEPLOY_DIR, name, f)) : []);
  const files = [
    ...folder('scripts'),
    ...folder('mysql'),
    // systemd reads the unit on the host; a carriage return would end up in ExecStart.
    ...folder('systemd'),
    ...fs.readdirSync(DEPLOY_DIR).filter((f) => /^Caddyfile/.test(f)).map((f) => path.join(DEPLOY_DIR, f)),
  ];
  assert.ok(files.length > 1);
  assert.deepEqual(files.filter((f) => readText(f).includes('\r')).map(posix), []);
  const rel = files.map((f) => posix(path.relative(REPO_ROOT, f)));
  const r = spawnSync('git', ['-C', REPO_ROOT, 'check-attr', 'eol', '--', ...rel], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const notLf = r.stdout.trim().split('\n').filter((l) => !/: eol: lf$/.test(l));
  console.log(`line ends: ${files.length} files checked`);
  assert.deepEqual(notLf, [], '.gitattributes must pin eol=lf');
});

// ------------------------------------------------------------------------------ F-25

/** A reference is pinned when it ends in @sha256 and 64 hex digits. */
const PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/**
 * Image references of a Dockerfile: FROM images and COPY --from images (not stage names, not the
 * named build `contexts`).
 */
function dockerfileImages(text, contexts) {
  const stages = new Set();
  const refs = [];
  for (const line of text.split(/\r?\n/)) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      if (!stages.has(from[1].toLowerCase())) refs.push(from[1]);
      if (from[2]) stages.add(from[2].toLowerCase());
    }
    const copy = /^\s*COPY\s+.*--from=(\S+)/i.exec(line);
    if (copy && !stages.has(copy[1].toLowerCase()) && !contexts.includes(copy[1]) && !/^\d+$/.test(copy[1])) refs.push(copy[1]);
  }
  return refs;
}

/** `image:` values and the images of `docker run` lines in a workflow file. */
function workflowImages(text) {
  const refs = [...text.matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].map((m) => m[1]);
  const built = new Set([...text.matchAll(/docker build\b[^\n]*--tag\s+(\S+)/g)].map((m) => m[1]));
  const withValue = new Set(['-v', '--volume', '-w', '--workdir', '-e', '--env', '--network', '--name', '--mount', '-p', '--publish', '--entrypoint', '-u', '--user', '--platform']);
  for (const m of text.matchAll(/docker run\b([^\n]*)/g)) {
    const words = m[1].trim().split(/\s+/);
    let i = 0;
    while (i < words.length && words[i].startsWith('-')) i += withValue.has(words[i]) ? 2 : 1;
    const image = words[i];
    if (image && !built.has(image)) refs.push(image);
  }
  return refs;
}

test('F-25: every image in the compose files, the workflows and the Dockerfiles is pinned by digest, and copies agree', () => {
  const refs = [];
  const add = (where, list) => list.forEach((ref) => refs.push({ where, ref }));
  for (const [label, config] of [['deploy compose', base()], ['deploy compose + CI override', ci()]]) {
    add(label, servicesOf(config).filter(([, s]) => s.image).map(([, s]) => s.image));
  }
  add('dev/docker-compose.yml', [...readText(path.join(REPO_ROOT, 'dev', 'docker-compose.yml')).matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]));
  const workflows = path.join(REPO_ROOT, '.github', 'workflows');
  for (const f of fs.readdirSync(workflows).filter((n) => /\.ya?ml$/.test(n))) add(`.github/workflows/${f}`, workflowImages(readText(path.join(workflows, f))));
  // Every tracked Dockerfile (the api and server images and the CI tool image). `COPY --from=`
  // of a named build context (compose additional_contexts) reads a folder, not an image.
  const contexts = [...new Set(servicesOf(base()).flatMap(([, s]) => Object.keys(s.build?.additional_contexts ?? {})))];
  const dockerfiles = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '*Dockerfile*'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  assert.ok(dockerfiles.length > 0, 'no tracked Dockerfile found');
  for (const f of dockerfiles) add(f, dockerfileImages(readText(path.join(REPO_ROOT, f)), contexts));
  assert.ok(refs.length > 0, 'no image reference found: refusing to report clean');
  console.log(`image references in scope: ${refs.length} (${new Set(refs.map((r) => r.ref)).size} distinct) in the compose files, `
    + `the workflows and ${dockerfiles.length} Dockerfiles (${dockerfiles.join(', ')}); named build contexts: ${contexts.join(', ') || 'none'}`);
  assert.deepEqual(refs.filter((r) => !PINNED.test(r.ref)).map((r) => `${r.where}: ${r.ref}`), [], 'not pinned by digest');

  // Copies of one image tag carry one digest everywhere.
  const byTag = new Map();
  for (const { where, ref } of refs) {
    const [tag, digest] = ref.split('@');
    if (!digest) continue;
    if (!byTag.has(tag)) byTag.set(tag, new Map());
    byTag.get(tag).set(digest, [...(byTag.get(tag).get(digest) ?? []), where]);
  }
  const differing = [...byTag].filter(([, digests]) => digests.size > 1).map(([tag, digests]) => `${tag}: ${[...digests].map(([d, w]) => `${d} (${[...new Set(w)].join(', ')})`).join(' / ')}`);
  console.log(`digest agreement: ${byTag.size} pinned tags across ${dockerfiles.length} Dockerfiles, the compose files and the workflows`);
  assert.deepEqual(differing, []);
});

test('F-25: Dependabot watches the Dockerfiles and the compose files of deploy/', () => {
  const text = readText(path.join(REPO_ROOT, '.github', 'dependabot.yml'));
  const entries = text.split(/^ {2}- package-ecosystem:/m).slice(1).map((chunk) => {
    const ecosystem = chunk.split('\n')[0].trim();
    const dirs = [...chunk.matchAll(/^\s+(?:directory:\s*|-\s+)(\/\S*)\s*$/gm)].map((m) => m[1]);
    return { ecosystem, dirs };
  });
  const dirsOf = (eco) => entries.filter((e) => e.ecosystem === eco).flatMap((e) => e.dirs);
  console.log(`dependabot: ${entries.length} update entries`);
  for (const dir of ['/api', '/server', '/.github/actionlint']) assert.ok(dirsOf('docker').includes(dir), `docker ${dir}`);
  for (const dir of ['/deploy', '/dev']) assert.ok(dirsOf('docker-compose').includes(dir), `docker-compose ${dir}`);
});

// ------------------------------------------------------------------------------ networks

test('networks: only caddy publishes a port (443, IPv4), db and the jobs sit on internal networks, caddy reaches neither the scheduler nor db', () => {
  const config = base();
  const services = servicesOf(config);
  const published = services.filter(([, s]) => (s.ports ?? []).length > 0).map(([n]) => n);
  assert.deepEqual(published, ['caddy']);
  for (const p of config.services.caddy.ports) assert.equal(p.host_ip, '0.0.0.0', `port ${p.target} is published for IPv4 only`);
  // 443 for Cloudflare, nothing on 80: no ACME and no redirect (deploy/Caddyfile).
  assert.deepEqual(config.services.caddy.ports.map((p) => `${p.published}:${p.target}/${p.protocol ?? 'tcp'}`), ['443:443/tcp']);

  const nets = config.networks;
  for (const [name, n] of Object.entries(nets)) assert.equal(n.enable_ipv6, false, `${name}: IPv6`);
  const internal = (name) => nets[name]?.internal === true;
  const on = (service) => Object.keys(config.services[service].networks ?? {});
  const shared = (a, b) => on(a).filter((n) => on(b).includes(n));
  assert.deepEqual(Object.keys(nets).filter((n) => !internal(n)).sort(), ['edge', 'outbound'], 'networks with a way out');
  assert.deepEqual(services.filter(([n]) => on(n).includes('edge')).map(([n]) => n).sort(), ['api', 'caddy']);
  // The scheduler's way out (SMTP for the credit reminders), not the edge's.
  assert.deepEqual(services.filter(([n]) => on(n).includes('outbound')).map(([n]) => n), ['scheduler']);
  // The file server: caddy only, on an internal network of their own.
  assert.deepEqual(services.filter(([n]) => on(n).includes('media')).map(([n]) => n).sort(), ['caddy', 'media']);
  assert.deepEqual(on('media'), ['media']);
  assert.ok(internal('media'), 'the media network has a way out');
  assert.ok(on('db').length > 0 && on('db').every(internal), 'db sits on internal networks only');
  for (const job of ['backup', 'admin-gate', 'seed']) assert.deepEqual(on(job), ['data'], job);
  assert.equal(config.services['storage-init'].network_mode, 'none');
  assert.deepEqual(shared('caddy', 'scheduler'), []);
  assert.deepEqual(shared('caddy', 'db'), []);
  // Exactly one shared network between caddy and api: api sees caddy at one address.
  assert.deepEqual(shared('caddy', 'api'), ['edge']);
  for (const backend of ['api', 'scheduler']) assert.deepEqual(shared(backend, 'db'), ['app'], `${backend} reaches db on the app network`);
  console.log(`networks: ${Object.keys(nets).length} networks, ${services.length} services checked`);
});

/**
 * The hop from `front` to `back`: the one network both sit on and `front`'s fixed address there,
 * with that network's subnet and dynamic range. Fails when they share no network or several (then
 * the back could see the front at either address).
 */
function hop(config, front, back) {
  const on = (s) => Object.keys(config.services[s]?.networks ?? {});
  const shared = on(front).filter((n) => on(back).includes(n));
  assert.equal(shared.length, 1, `${front} and ${back} share exactly one network (they share ${shared.join(', ') || 'none'})`);
  const [network] = shared;
  const ip = config.services[front].networks[network]?.ipv4_address;
  assert.ok(ip, `${front} has a fixed address on ${network}`);
  const ipam = config.networks[network]?.ipam?.config?.[0] ?? {};
  return { network, ip, subnet: ipam.subnet, range: ipam.ip_range };
}

test("F-31: the trusted proxy address is caddy's fixed address (mirror); api's and the scheduler's are the only other fixed addresses", () => {
  const prefix = ciValues().APP_NET_PREFIX;
  for (const [label, config] of [['production', base()], ['CI', ci()]]) {
    const edge = hop(config, 'caddy', 'api');
    assert.equal(config.services.api.environment.TRUSTED_PROXIES, edge.ip, `${label}: Laravel trusts caddy's address`);
    // The scheduler serves nothing; the image's entrypoint requires the setting, and it is the same.
    assert.equal(config.services.scheduler.environment.TRUSTED_PROXIES, edge.ip, `${label}: the scheduler's TRUSTED_PROXIES`);
    // The fixed addresses: caddy's, the one Laravel trusts, and the two the host lets reach the
    // metadata endpoint (scripts/metadata-access.sh). Each comes from APP_NET_PREFIX, lies in its
    // network's fixed subnet and outside its dynamic range (no other container can take it), and
    // is not the gateway.
    const fixed = servicesOf(config).flatMap(([name, s]) => Object.entries(s.networks ?? {})
      .filter(([, n]) => n?.ipv4_address).map(([net, n]) => ({ at: `${name}@${net}`, net, ip: n.ipv4_address })));
    assert.deepEqual(fixed.map((f) => `${f.at} ${f.ip}`).sort(), [`api@edge ${prefix}.20`, `caddy@edge ${prefix}.10`, `scheduler@outbound ${prefix}.140`], `${label}: fixed addresses`);
    assert.equal(edge.ip, `${prefix}.10`, `${label}: the trusted address is caddy's`);
    for (const f of fixed) {
      const ipam = config.networks[f.net]?.ipam?.config?.[0] ?? {};
      assert.ok(ipam.subnet && inCidr(f.ip, ipam.subnet), `${label}: ${f.at} lies in ${f.net}'s fixed subnet`);
      assert.ok(ipam.ip_range && !inCidr(f.ip, ipam.ip_range), `${label}: ${f.at} lies outside ${f.net}'s dynamic range`);
      assert.notEqual(ipToInt(f.ip) % 2 ** (32 - Number(ipam.subnet.split('/')[1])), 1, `${label}: ${f.at} is the gateway`);
    }
    // The two networks with a way out share the /24 of APP_NET_PREFIX, half each.
    const ipamOf = (net) => { const c = config.networks[net]?.ipam?.config?.[0] ?? {}; return [c.subnet, c.ip_range]; };
    assert.deepEqual(ipamOf('edge'), [`${prefix}.0/25`, `${prefix}.64/26`], `${label}: edge`);
    assert.deepEqual(ipamOf('outbound'), [`${prefix}.128/25`, `${prefix}.192/26`], `${label}: outbound`);
    console.log(`${label}: caddy ${edge.ip} on ${edge.network} (TRUSTED_PROXIES); ${fixed.filter((f) => !f.at.startsWith('caddy@')).map((f) => `${f.at} ${f.ip}`).join(', ')}`);
  }
});

// ------------------------------------------------------------------------------ metadata endpoint

/**
 * A stand-in for iptables (bash): Docker's DOCKER-USER chain as the lines of a file (no file: no
 * chain), and every call recorded. It knows the three calls deploy/scripts/metadata-access.sh
 * makes: list the chain (-n -L), check a rule (-C) and insert one (-I <chain> <position>).
 */
const IPTABLES_STAND_IN = String.raw`#!/bin/bash
state=/work/DOCKER-USER
printf '%s\n' "$*" >> /work/calls
if [[ "$1" == -n && "$2" == -L ]]; then [[ "$3" == DOCKER-USER && -f "$state" ]]; exit; fi
case "$1" in
  -C) [[ "$2" == DOCKER-USER && -f "$state" ]] || exit 2; shift 2; grep -qxF -- "$*" "$state" ;;
  -I) [[ "$2" == DOCKER-USER && -f "$state" ]] || exit 2; pos=$3; shift 3
      { head -n $((pos - 1)) "$state"; printf '%s\n' "$*"; tail -n +"$pos" "$state"; } > "$state.new" && mv "$state.new" "$state" ;;
  *) echo "stand-in iptables: unexpected call: $*" >&2; exit 2 ;;
esac
`;

test("metadata endpoint: the host script lets exactly api's and the scheduler's fixed addresses through, one address each, once, and refuses a malformed APP_NET_PREFIX", () => {
  // The addresses the compose gives api and the scheduler (the only fixed ones besides caddy's).
  const config = base();
  const fixedOf = (service) => Object.values(config.services[service].networks ?? {}).map((n) => n?.ipv4_address).filter(Boolean);
  const expected = [...fixedOf('api'), ...fixedOf('scheduler')].sort();
  assert.equal(expected.length, 2, `api and the scheduler have one fixed address each: ${expected.join(', ')}`);
  const prefix = ciValues().APP_NET_PREFIX;
  // Missing, empty and malformed values of APP_NET_PREFIX: two parts, four parts, a part over
  // 255, a leading zero, a leading space.
  const bad = { missing: null, empty: '', 'two-parts': '172.30', 'four-parts': '172.30.99.0', 'over-255': '256.1.1', 'leading-zero': '172.30.099', 'leading-space': ' 172.30.99' };
  const driver = [
    'set -u',
    'mkdir -p /work',
    "cat > /usr/local/sbin/iptables <<'EOF'",
    IPTABLES_STAND_IN.trimEnd(),
    'EOF',
    'chmod 755 /usr/local/sbin/iptables',
    // The platform's rules: the drop of all container traffic to the endpoint, then the return.
    "printf '%s\\n' '-d 169.254.169.254/32 -j DROP' '-j RETURN' > /work/DOCKER-USER",
    'setenv() { if [ "$1" = __missing__ ]; then echo "DOMAIN=localhost" > /work/env; else printf "APP_NET_PREFIX=%s\\n" "$1" > /work/env; fi; }',
    "run() { : > /work/calls; out=$(bash /clone/deploy/scripts/metadata-access.sh /work/env 2>&1); code=$?; printf '=== %s exit %s\\n%s\\n--- calls\\n%s\\n--- chain\\n%s\\n' \"$1\" \"$code\" \"$out\" \"$(cat /work/calls)\" \"$(cat /work/DOCKER-USER 2>/dev/null)\"; }",
    `setenv '${prefix}'; run first`,
    'run second',
    ...Object.entries(bad).map(([name, value]) => `setenv '${value ?? '__missing__'}'; run bad-${name}`),
    `rm /work/DOCKER-USER; setenv '${prefix}'; run no-chain`,
  ].join('\n');
  const r = dockerRun(serviceImage('db'), { mounts: [{ src: DEPLOY_DIR, dst: '/clone/deploy' }], entrypoint: 'bash', args: ['-c', driver] });
  assert.equal(r.status, 0, r.stderr);
  const runs = Object.fromEntries(r.stdout.split(/^=== /m).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [, name, code] = /^(\S+) exit (\d+)$/.exec(head);
    const [out, calls, chain] = rest.join('\n').split(/^--- (?:calls|chain)$/m).map((s) => s.trim());
    return [name, { code: Number(code), out, calls: calls ? calls.split('\n') : [], chain: chain ? chain.split('\n') : [] }];
  }));
  assert.deepEqual(Object.keys(runs).sort(), ['first', 'second', ...Object.keys(bad).map((n) => `bad-${n}`), 'no-chain'].sort(), r.stdout);
  const platform = ['-d 169.254.169.254/32 -j DROP', '-j RETURN'];
  const ruleOf = (ip) => `-s ${ip}/32 -d 169.254.169.254/32 -p tcp --dport 80 -m comment --comment goenn-metadata -j ACCEPT`;

  // The first run adds one rule per address at the top, above the platform's drop.
  const { first, second } = runs;
  console.log(`metadata-access: first run ${first.out.replace(/\n/g, '; ')}; second run ${second.out.replace(/\n/g, '; ')}`);
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(first.out.split('\n').sort(), expected.map((ip) => `added: ${ip} -> 169.254.169.254:80`).sort());
  assert.deepEqual(first.chain.slice(-2), platform, 'the platform rules are no longer the last ones');
  assert.deepEqual(first.chain.slice(0, -2).sort(), expected.map(ruleOf).sort(), 'the rules above the drop');
  // Single addresses only, on both sides, never a network.
  const wide = first.chain.filter((l) => /-j ACCEPT/.test(l)).flatMap((l) => [...l.matchAll(/-[sd] (\S+)/g)].map((m) => m[1])).filter((a) => !a.endsWith('/32'));
  assert.deepEqual(wide, [], 'an ACCEPT rule names a network');
  // A second run finds them and changes nothing.
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(second.out.split('\n').sort(), expected.map((ip) => `found: ${ip} -> 169.254.169.254:80`).sort());
  assert.deepEqual(second.chain, first.chain, 'the second run changed the chain');
  assert.deepEqual(second.calls.filter((c) => c.startsWith('-I')), [], 'the second run inserted a rule');
  // A malformed or missing prefix stops before any call of iptables.
  for (const name of Object.keys(bad)) {
    const run = runs[`bad-${name}`];
    assert.notEqual(run.code, 0, `${name}: the script went on`);
    assert.deepEqual(run.calls, [], `${name}: iptables was called`);
    assert.deepEqual(run.chain, first.chain, `${name}: the chain changed`);
    assert.match(run.out, /APP_NET_PREFIX is missing or not three numbers from 0 to 255/, name);
  }
  // Without DOCKER-USER (Docker not running) it lists the chain and stops.
  assert.notEqual(runs['no-chain'].code, 0, 'no-chain: the script went on');
  assert.deepEqual(runs['no-chain'].calls, ['-n -L DOCKER-USER'], 'no-chain: more than the one look at the chain');
  assert.match(runs['no-chain'].out, /DOCKER-USER does not exist/);
});

test('metadata endpoint: the systemd unit runs the script after Docker starts, at every boot and every Docker restart', () => {
  const file = path.join(DEPLOY_DIR, 'systemd', 'goenn-metadata-access.service');
  assert.ok(fs.existsSync(file), 'no deploy/systemd/goenn-metadata-access.service');
  const unit = {};
  let section = null;
  for (const raw of readText(file).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) { section = head[1]; unit[section] = {}; continue; }
    const kv = /^(\w+)=(.*)$/.exec(line);
    assert.ok(section && kv, `not a line of a unit: ${line}`);
    (unit[section][kv[1]] ??= []).push(kv[2]);
  }
  console.log(`systemd unit: ${Object.keys(unit).join(', ')}`);
  assert.deepEqual(Object.keys(unit), ['Unit', 'Service', 'Install']);
  assert.deepEqual(unit.Unit.After, ['docker.service']);
  assert.deepEqual(unit.Unit.Requires, ['docker.service']);
  // Stopping or restarting Docker stops or restarts the unit too, and Docker's start pulls it in
  // again (WantedBy): the script runs after every start of Docker, the boot included.
  assert.deepEqual(unit.Unit.PartOf, ['docker.service']);
  assert.deepEqual(unit.Install.WantedBy, ['docker.service']);
  assert.deepEqual(unit.Service.Type, ['oneshot']);
  assert.deepEqual(unit.Service.RemainAfterExit, ['yes']);
  assert.deepEqual(unit.Service.ExecStart, ['/bin/bash @DEPLOY_DIR@/scripts/metadata-access.sh']);
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'scripts', 'metadata-access.sh')), 'the script the unit runs');
  // The runbook installs it with the placeholder replaced by the clone's deploy/ folder.
  const runbook = readText(RUNBOOK).replace(/\r\n/g, '\n');
  assert.match(runbook, /^ *sed "s\|@DEPLOY_DIR@\|\$\(pwd -P\)\|" systemd\/goenn-metadata-access\.service > \/etc\/systemd\/system\/goenn-metadata-access\.service$/m, 'the runbook does not install the unit');
  assert.match(runbook, /^ *systemctl enable --now goenn-metadata-access\.service$/m, 'the runbook does not enable the unit');
});

test('the CI override closes every network, publishes no port and sends every mail to Mailpit', () => {
  const config = ci();
  for (const [name, n] of Object.entries(config.networks)) assert.equal(n.internal, true, `${name} is internal in CI`);
  assert.deepEqual(servicesOf(config).filter(([, s]) => (s.ports ?? []).length > 0).map(([n]) => n), []);
  for (const name of ['api', 'scheduler']) {
    assert.equal(config.services[name].environment.MAIL_MAILER, 'smtp', name);
    assert.equal(config.services[name].environment.MAIL_HOST, 'mailpit', name);
    assert.equal(config.services[name].depends_on?.mailpit?.condition, 'service_healthy', name);
  }
  assert.deepEqual(Object.keys(config.services.mailpit.networks), ['app']);
});

test("the scheduler runs Laravel's schedule on the api image with api's settings; only api migrates", () => {
  const config = base();
  const { api, scheduler } = config.services;
  assert.deepEqual(scheduler.command, ['php', 'artisan', 'schedule:work']);
  assert.deepEqual(scheduler.build, api.build, 'the scheduler is not built like api');
  assert.ok(scheduler.restart, 'the scheduler is long-running');
  assert.equal(scheduler.depends_on?.api?.condition, 'service_healthy', 'the scheduler starts before the migrations ran');
  assert.equal(scheduler.healthcheck?.disable, true, "the image's healthcheck asks Apache, which does not run there");
  // Every setting both read has the same value, except where api alone serves requests.
  const shared = Object.keys(scheduler.environment).filter((k) => k in api.environment);
  const differ = shared.filter((k) => scheduler.environment[k] !== api.environment[k]);
  console.log(`scheduler: ${Object.keys(scheduler.environment).length} settings, ${shared.length} shared with api`);
  assert.ok(shared.length >= 20, `only ${shared.length} settings shared with api`);
  assert.deepEqual(differ, [], 'settings the scheduler and api read with different values');
  assert.equal(api.environment.RUN_MIGRATIONS, 'true', 'api runs the migrations');
  const migrating = servicesOf(config).filter(([, s]) => s.environment?.RUN_MIGRATIONS === 'true').map(([n]) => n);
  assert.deepEqual(migrating, ['api'], 'two services migrating at once could get in each other\'s way');
  // The retention prune's settings reach the one service that runs it.
  for (const name of ['EVIDENCE_RETENTION_DAYS', 'TOKEN_RETENTION_DAYS']) {
    assert.equal(scheduler.environment[name], ciValues()[name], `scheduler: ${name}`);
    assert.equal(api.environment[name], undefined, `api: ${name}`);
  }
  const schedule = readText(path.join(REPO_ROOT, 'api', 'routes', 'console.php'));
  for (const job of ['club:renew', 'credits:expire', 'credits:remind', 'retention:prune']) {
    assert.match(schedule, new RegExp(`Schedule::command\\('${job}'\\)`), `${job} is not on the schedule`);
  }
});

test('every deploy test file is run by exactly one npm script: test:deploy (static) or test:deploy:stack', () => {
  const scripts = JSON.parse(readText(path.join(REPO_ROOT, 'package.json'))).scripts ?? {};
  const globs = Object.fromEntries(['test:deploy', 'test:deploy:stack'].map((name) => [
    name, [...String(scripts[name] ?? '').matchAll(/"?(deploy\/test\/[^\s"]+\.test\.mjs)"?/g)].map((m) => m[1]),
  ]));
  for (const [name, list] of Object.entries(globs)) assert.ok(list.length > 0, `no deploy test glob in the npm script ${name}`);
  const files = fs.readdirSync(path.join(REPO_ROOT, 'deploy', 'test')).filter((f) => f.endsWith('.test.mjs')).sort();
  assert.ok(files.length > 0, 'no deploy test file found');
  const runBy = (file) => Object.keys(globs).filter((name) => globs[name].some((g) => path.posix.matchesGlob(`deploy/test/${file}`, g)));
  console.log(`deploy test files: ${files.length} (${files.map((f) => `${f} -> ${runBy(f).join(', ') || 'none'}`).join('; ')})`);
  assert.deepEqual(files.filter((f) => runBy(f).length !== 1), [], 'files run by no script or by both');
  assert.deepEqual(runBy('stack.test.mjs'), ['test:deploy:stack'], 'the stack test (it builds and starts the stack) runs only on its own');
});

test("the stack test's probe is a visitor on the edge network only, and only with the test profile", () => {
  const probe = ci().services.probe;
  assert.ok(probe, 'no probe service in the CI override');
  assert.deepEqual(probe.profiles, ['test'], 'the probe must never start with a plain `docker compose up`');
  assert.deepEqual(Object.keys(probe.networks ?? {}), ['edge'], 'the probe reaches caddy only');
  assert.equal(base().services.probe, undefined, 'the production compose has no probe');
  assert.deepEqual(probe.entrypoint, ['node', '/checks/probe.mjs']);
  const checks = (probe.volumes ?? []).find((v) => v.target === '/checks');
  assert.ok(checks && checks.read_only === true && /\/deploy\/test$/.test(posix(checks.source)), 'deploy/test mounted read-only at /checks');
  assert.ok(probe.read_only === true && (probe.cap_drop ?? []).includes('ALL') && probe.user === 'node', 'probe hardening');
  assert.equal(probe.environment.DOMAIN, ciValues().DOMAIN);
});

test("the stack test's probe runs the image built from server/Dockerfile, so the Node pin has one copy", () => {
  // A second `image: node:...@sha256:...` line would be a copy of server/Dockerfile's pin that
  // Dependabot updates in another pull request (docker-compose /deploy, not docker /server).
  const config = ci();
  const probe = config.services.probe;
  assert.ok(probe, 'no probe service in the CI override');
  assert.equal(probe.image, undefined, `the probe pins an image of its own: ${probe.image}`);
  assert.ok(probe.build, 'the probe is not built');
  assert.match(posix(probe.build.context), /\/server$/);
  assert.match(posix(probe.build.additional_contexts?.shared ?? ''), /\/shared$/, 'the probe is not built the way server/Dockerfile expects (shared/ as a context)');
  const pins = readText(path.join(REPO_ROOT, 'server', 'Dockerfile')).match(/^FROM\s+node:\S+@sha256:[0-9a-f]{64}/gm) ?? [];
  assert.equal(pins.length, 1, 'server/Dockerfile holds the one Node pin');
  const copies = servicesOf(config).filter(([, s]) => /^node:/.test(s.image ?? '')).map(([n, s]) => `${n}: ${s.image}`);
  console.log(`probe: built from ${posix(probe.build.context).split('/').slice(-1)[0]}/; Node images pinned in the compose files: ${copies.length}`);
  assert.deepEqual(copies, [], 'a service pins a Node image of its own');
});

test('hardening: no new privileges anywhere, and no capabilities for api, the scheduler and the jobs', () => {
  const services = servicesOf(base());
  const problems = [];
  for (const [name, s] of services) {
    if (!(s.security_opt ?? []).includes('no-new-privileges:true')) problems.push(`${name}: no-new-privileges`);
  }
  for (const name of ['api', 'scheduler', 'caddy', 'media', 'backup', 'admin-gate', 'seed']) {
    const s = base().services[name];
    if (!s) problems.push(`${name}: no such service`);
    else if (!(s.cap_drop ?? []).includes('ALL')) problems.push(`${name}: cap_drop ALL`);
  }
  for (const name of ['caddy', 'media']) {
    if (JSON.stringify(base().services[name]?.cap_add) !== '["NET_BIND_SERVICE"]') problems.push(`${name}: cap_add NET_BIND_SERVICE only`);
  }
  console.log(`hardening: ${services.length} services checked`);
  assert.deepEqual(problems, []);
});

test('compose project: no top-level name, so a server that ran an earlier compose keeps its volumes', () => {
  // Without a name, docker compose names the project after the compose file's folder, deploy/,
  // as every earlier version of this compose did: the volumes stay deploy_db-data and so on.
  const files = [COMPOSE_FILE, CI_OVERRIDE].filter((f) => fs.existsSync(path.join(DEPLOY_DIR, f)));
  assert.ok(files.length > 0, 'no compose file found: refusing to report clean');
  const named = files.filter((f) => /^name\s*:/m.test(readText(path.join(DEPLOY_DIR, f))));
  console.log(`compose files checked for a top-level name: ${files.length}; without one the project is named after the folder: ${path.basename(DEPLOY_DIR)}`);
  assert.deepEqual(named, [], 'a top-level name renames every volume and network: a server that ran an earlier compose would start on a new, empty database');
  assert.deepEqual(parseEnvFile(readText(ENV_EXAMPLE)).filter((s) => s.name === 'COMPOSE_PROJECT_NAME').map((s) => `line ${s.line}`), [], 'deploy/.env.example sets COMPOSE_PROJECT_NAME');
});
