// The running stack, checked through the edge. CI AND LOCAL TESTS ONLY.
//
// Builds the images, starts the whole stack of deploy/docker-compose.yml with the CI override and
// deploy/ci.env the way the runbook's first start does (backends first, the admin gate, the
// one-off seed, then the edge), checks it from the `probe` service (a visitor on the edge network,
// deploy/test/probe.mjs) and from inside the containers, and removes it again with its volumes and
// built images.
//
//   COMPOSE_PROJECT_NAME=<a name of its own> npm run test:deploy:stack
//
// Needs Docker with Compose >= 2.24.4. The image builds reach the container and package
// registries; the stack itself runs on internal networks only: no certificate authority and no
// mail provider is ever contacted (DOMAIN=localhost makes Caddy use its own internal certificate
// authority). Settings: stack-lib.mjs (stackSettings).
//
// Every account, password and key here is made up for this run and never printed; answers are
// shown through redact(). Usernames come from the server tests' fixtures (testIdentity), so the
// word filter can never refuse them by accident (server/test/test-support.test.js checks the
// prefixes used here).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import { BLOCKED_TERMS, findBlockedTerm } from '../../server/src/blocked-terms.js';
import { testIdentity, uniqueStamp } from '../../server/test/support/fixtures.js';
import { REPO_ROOT, envFileValues, readText } from './lib.mjs';
import {
  Stack, apiRequest, freshPassword, header, laravelLimit, multipart, png, redact, sha256,
  stackSettings, storageList, waitFor,
} from './stack-lib.mjs';

const settings = stackSettings();
const values = envFileValues(settings.envFile);
const domain = values.DOMAIN;
const legal = JSON.parse(readText(path.join(REPO_ROOT, 'shared', 'legal.json')));

/** The backends and jobs that start before the edge (the runbook's first `up`). */
const BACKEND = ['db', 'storage-init', 'api', 'scheduler', 'backup', 'mailpit'];
/** A stored file name as Laravel gives it (api/app/Support/Uploads.php STORED_NAME). */
const storedName = (ext) => `${crypto.randomBytes(20).toString('hex')}.${ext}`;
const MYSQL = 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" -N -B';
/** The policy of the page behind sticker and invite links (api/app/Http/Responses/OpenAppPage.php). */
const PAGE_CSP = /const CSP = "([^"]+)";/.exec(readText(path.join(REPO_ROOT, 'api', 'app', 'Http', 'Responses', 'OpenAppPage.php')))?.[1];

const stack = new Stack(settings);
/** What the start recorded, for the tests to judge. */
const S = { failed: false, steps: [] };
const started = Date.now();

/** A test that marks the run as failed (for the logs in `after`). */
function check(name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      S.failed = true;
      throw err;
    }
  });
}

function step(name, fn) {
  const t0 = Date.now();
  const result = fn();
  S.steps.push(`${name} ${Math.round((Date.now() - t0) / 1000)} s`);
  return result;
}

const tail = (text, n = 1500) => String(text ?? '').slice(-n);
/** The directives of a Cache-Control value, lower case and sorted: 'no-store, private' -> ['no-store', 'private']. */
const directives = (value) => String(value ?? '').toLowerCase().split(',').map((d) => d.trim()).filter(Boolean).sort();
/** How many answers had which status: { 404: 30 }. */
const tally = (results) => results.reduce((acc, r) => ({ ...acc, [r.status ?? r.error]: (acc[r.status ?? r.error] ?? 0) + 1 }), {});

/** State, health and exit code of the first container of a service, or null. */
function stateOf(service) {
  const c = stack.containersOf(service)[0];
  if (!c) return { exists: false, running: false, status: 'no container' };
  return {
    exists: true,
    running: c.State.Running === true,
    status: c.State.Status,
    health: c.State.Health?.Status,
    exitCode: c.State.ExitCode,
    name: c.Name.replace(/^\//, ''),
  };
}

/** One setting of a service's first container (its environment as Docker started it). */
function envOf(service, name) {
  const entry = (stack.containersOf(service)[0]?.Config?.Env ?? []).find((e) => e.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
}

/** Where Laravel keeps the uploads in its containers: { uploads, private }, from api's settings. */
function roots() {
  const uploads = envOf('api', 'UPLOADS_ROOT');
  const priv = envOf('api', 'PRIVATE_MEDIA_ROOT');
  assert.ok(uploads && priv, 'api has no UPLOADS_ROOT or PRIVATE_MEDIA_ROOT');
  return { uploads, private: priv };
}

function adminCount() {
  const r = stack.sh('db', `${MYSQL} -e "SELECT COUNT(*) FROM users WHERE is_admin = 1" "$MYSQL_DATABASE"`);
  if (r.status !== 0) throw new Error(`cannot count the admin accounts: ${r.stderr.trim()}`);
  return Number(r.stdout.trim());
}

function query(sql) {
  const r = stack.sh('db', `${MYSQL} -e "${sql}" "$MYSQL_DATABASE"`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(/\r?\n/).filter(Boolean);
}

/** Writes bytes into a container as its own user (api writes the uploads). */
function plant(service, file, bytes) {
  const r = stack.exec(service, ['sh', '-c', `cat > '${file}'`], { input: bytes });
  assert.equal(r.status, 0, `cannot plant ${file} in ${service}: ${r.stderr}`);
}

function remove(service, files) {
  if (files.length > 0) stack.exec(service, ['rm', '-f', ...files]);
}

/** A new account through the edge: { ...identity, password, token, id, user }. */
function register(prefix, index = 1) {
  const identity = testIdentity(prefix);
  const password = freshPassword();
  const res = stack.request(apiRequest('POST', '/api/register', {
    json: {
      name: identity.name,
      username: identity.username,
      email: identity.email,
      password,
      terms_version: legal.terms_version,
      confirmed_min_age: legal.min_age,
    },
  }), index);
  assert.ok([200, 201].includes(res.status), `sign-up: ${redact(res)}`);
  const token = res.json?.token;
  assert.ok(typeof token === 'string' && token.length > 10, 'sign-up returned no token');
  return { ...identity, password, token, id: res.json?.user?.id, user: res.json?.user };
}

let adminTokenCache;
function adminToken() {
  if (!adminTokenCache) {
    const res = stack.request(apiRequest('POST', '/api/login', { json: { email: S.admin.email, password: S.admin.password } }));
    assert.equal(res.status, 200, `admin sign-in: ${redact(res)}`);
    adminTokenCache = res.json?.token;
    assert.ok(adminTokenCache, 'admin sign-in returned no token');
  }
  return adminTokenCache;
}

/** A multipart request with one image, for the probe. */
function imageUpload(urlPath, token, fields, field, bytes) {
  const form = multipart(fields, [{ field, filename: 'image.png', type: 'image/png', bytes }]);
  return {
    method: 'POST',
    path: urlPath,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': form.contentType },
    bodyBase64: form.body.toString('base64'),
  };
}

before(async () => {
  try {
    await start();
  } catch (err) {
    S.failed = true;
    throw err;
  }
}, { timeout: 30 * 60_000 });

/** Builds and starts the stack the way the runbook's first start does, recording each step. */
async function start() {
  console.log(`stack: project ${stack.project}, ${settings.files.length} compose file(s), env file ${path.basename(settings.envFile)}`);
  const services = step('config', () => stack.services());
  S.services = services;
  console.log(`services: ${services.join(', ')}`);

  // api, the scheduler and the seed are built from api/Dockerfile; the probe (profile test) from
  // server/Dockerfile.
  const build = step('build', () => stack.compose(['build'], { profiles: ['tools', 'test'], timeout: 25 * 60_000 }));
  if (build.status !== 0) throw new Error(`docker compose build failed (exit ${build.status}):\n${tail(build.stderr, 4000)}`);

  // The runbook's first start: backends and jobs first, without the edge.
  const backend = BACKEND.filter((s) => services.includes(s));
  const up = step('up backends', () => stack.compose(['up', '-d', ...backend]));
  if (up.status !== 0) throw new Error(`docker compose up -d ${backend.join(' ')} failed (exit ${up.status}):\n${tail(up.stderr)}`);
  await waitFor('api to be healthy', () => stateOf('api').health === 'healthy', { ms: 6 * 60_000 });

  // What `docker compose up -d` does while no admin account exists.
  S.adminsBefore = adminCount();
  const early = step('up before seeding', () => stack.compose(['up', '-d']));
  S.upBefore = { status: early.status, stderr: early.stderr };
  S.caddyBefore = stateOf('caddy');
  S.gateBefore = stateOf('admin-gate');
  S.gateBefore.log = S.gateBefore.exists ? stack.compose(['logs', '--no-color', 'admin-gate']).stdout : '';

  // The admin, with the one-off seed service; its values live only in this compose call.
  S.admin = { email: 'ci-admin@example.invalid', password: freshPassword() };
  const adminEnv = { ADMIN_EMAIL: S.admin.email, ADMIN_PASSWORD: S.admin.password };
  const seed = step('seed', () => (services.includes('seed')
    ? stack.compose(['run', '--rm', '-T', 'seed'], { env: adminEnv, profiles: ['tools'] })
    : { status: null, stdout: '', stderr: 'no seed service in this compose' }));
  S.seed = { service: services.includes('seed') ? 'seed' : 'none', status: seed.status, stdout: tail(seed.stdout, 600), out: tail(`${seed.stdout}\n${seed.stderr}`, 600) };
  S.adminsAfter = adminCount();

  const late = step('up after seeding', () => stack.compose(['up', '-d']));
  S.upAfter = { status: late.status, stderr: late.stderr };
  S.caddyAfter = await waitFor('caddy to run', () => (stateOf('caddy').running ? stateOf('caddy') : null), { ms: 120_000 })
    .catch(() => stateOf('caddy'));

  // Three visitors with three addresses on the edge network; the third one only for the rate
  // limit check, so it starts with empty counters.
  const probes = step('probes', () => stack.compose(['up', '-d', '--scale', 'probe=3', 'probe'], { profiles: ['test'] }));
  if (probes.status !== 0) throw new Error(`cannot start the probe service (exit ${probes.status}): ${tail(probes.stderr)}`);
  await waitFor('the edge to answer /api/health', () => {
    try {
      const res = stack.request(apiRequest('GET', '/api/health'));
      return res.status === 200 && res.json?.ok === true;
    } catch {
      return false;
    }
  }, { ms: 180_000, every: 3000 });
  console.log(`start: ${S.steps.join(', ')}; ${Math.round((Date.now() - started) / 1000)} s in total`);
}

after(() => {
  if (S.failed) {
    const logs = stack.compose(['logs', '--no-color', '--tail', '200'], { profiles: ['tools', 'test'] });
    console.log(`--- logs of the stack (last 200 lines per container) ---\n${logs.stdout}${logs.stderr}`);
  }
  if (settings.keep) {
    console.log(`STACK_KEEP=1: the stack ${stack.project} keeps running; remove it with docker compose -p ${stack.project} down -v`);
  } else {
    const down = stack.compose(['down', '-v', '--remove-orphans', '--rmi', 'local'], { profiles: ['tools', 'test'] });
    console.log(`down -v --remove-orphans --rmi local: exit ${down.status}`);
  }
  console.log(`stack test: ${Math.round((Date.now() - started) / 1000)} s`);
}, { timeout: 5 * 60_000 });

// --------------------------------------------------------------------------- first start

check('F-05: the edge does not start before an admin account exists', () => {
  console.log(`before seeding: ${S.adminsBefore} admin account(s); up -d exit ${S.upBefore.status}; `
    + `caddy ${S.caddyBefore.status}; admin-gate ${S.gateBefore.status} (exit ${S.gateBefore.exitCode})`);
  console.log(`seed (${S.seed.service}): exit ${S.seed.status}; after: ${S.adminsAfter} admin account(s); up -d exit ${S.upAfter.status}; caddy ${S.caddyAfter.status}`);
  assert.equal(S.adminsBefore, 0, 'a fresh stack starts without an admin account');
  assert.equal(S.caddyBefore.running, false, `caddy was running while no admin account existed (${S.caddyBefore.status})`);
  assert.equal(S.gateBefore.exists, true, 'no admin-gate container ran before the edge');
  assert.equal(S.gateBefore.exitCode, 1, 'the admin gate refused while no admin account existed');
  assert.match(S.gateBefore.log, /no admin account yet/);
  assert.notEqual(S.upBefore.status, 0, 'docker compose up -d reported success while the edge could not start');
  assert.equal(S.seed.service, 'seed', 'the admin account is created by the one-off seed service');
  assert.equal(S.seed.status, 0, `the seed run: ${S.seed.out}`);
  assert.match(S.seed.stdout, /admin:create: account created \(is_admin = 1\)\./);
  assert.equal(S.adminsAfter, 1);
  assert.equal(S.upAfter.status, 0, `docker compose up -d after seeding: ${tail(S.upAfter.stderr, 600)}`);
  assert.equal(S.caddyAfter.running, true, `caddy after seeding: ${S.caddyAfter.status}`);
});

check('F-18: no container carries ADMIN_EMAIL or ADMIN_PASSWORD, and no seed container is left', () => {
  const all = stack.containers();
  const running = all.filter((c) => c.State.Running);
  console.log(`containers: ${all.length} in the project, ${running.length} running`);
  assert.ok(running.length >= 6, `only ${running.length} running containers`);
  const name = (c) => c.Name.replace(/^\//, '');
  const env = (c) => c.Config.Env ?? [];
  assert.deepEqual(all.filter((c) => env(c).some((e) => e.startsWith('ADMIN_'))).map(name), [], 'containers with ADMIN_* in their environment');
  assert.deepEqual(all.filter((c) => env(c).some((e) => e.includes(S.admin.password) || e.includes(S.admin.email))).map(name), [], 'containers holding the admin values');
  assert.deepEqual(all.filter((c) => c.Config.Labels?.['com.docker.compose.service'] === 'seed').map(name), [], 'a seed container was left behind');
});

check('F-18: the database healthcheck carries no password', () => {
  const db = stack.containersOf('db')[0];
  assert.ok(db, 'no db container');
  const words = db.Config.Healthcheck?.Test ?? [];
  const secrets = Object.entries(values).filter(([k, v]) => /PASSWORD|SECRET|_KEY$/.test(k) && v !== '').map(([, v]) => v);
  console.log(`db healthcheck: ${words.length} words, checked against ${secrets.length} secret values`);
  assert.ok(words.length > 1, 'the db container has no healthcheck');
  const text = words.join(' ');
  assert.equal(secrets.filter((v) => text.includes(v)).length, 0, 'the healthcheck holds a password value');
  assert.doesNotMatch(text, /(^|\s)(-p\S|--password)|MYSQL_PWD|MYSQL_(ROOT_)?PASSWORD/, 'the healthcheck names a password option');
  assert.equal(db.State.Health?.Status, 'healthy');
});

// --------------------------------------------------------------------------- the Laravel image

check('F-28: the Laravel container runs as a non-root user', () => {
  const id = stack.exec('api', ['id', '-u']);
  assert.equal(id.status, 0, id.stderr);
  const procs = stack.sh('api', "grep -H '^Uid:' /proc/[0-9]*/status 2>/dev/null; true");
  const uids = procs.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [where, ...ids] = line.split(/\s+/);
    return { where: where.replace(/:Uid:$/, ''), ids };
  });
  const api = stack.containersOf('api')[0];
  const imageUser = stack.image(api.Image).Config.User;
  console.log(`api: id -u ${id.stdout.trim()}, ${uids.length} processes, image user ${imageUser || '(none: root)'}`);
  assert.notEqual(Number(id.stdout.trim()), 0, 'api runs as root');
  assert.ok(uids.length > 0, 'no process found in api');
  assert.deepEqual(uids.filter((p) => p.ids.includes('0')).map((p) => p.where), [], 'processes with a root uid');
  assert.ok(imageUser && !/^(root|0)(:|$)/.test(imageUser), `the api image's user is ${imageUser || 'not set (root)'}`);
});

check('F-28: the Laravel image ships no Composer', () => {
  const r = stack.sh('api', 'n=0; for d in $(echo "$PATH" | tr ":" " "); do n=$((n+1)); ls "$d"/composer* 2>/dev/null; done; echo "dirs $n"');
  const lines = r.stdout.trim().split(/\r?\n/);
  const dirs = Number(/^dirs (\d+)$/.exec(lines.at(-1))?.[1]);
  console.log(`api: ${dirs} PATH directories searched for composer`);
  assert.ok(dirs > 0, 'no PATH directory searched');
  assert.deepEqual(lines.slice(0, -1).filter(Boolean), [], 'Composer in the runtime image');
  assert.notEqual(stack.sh('api', 'command -v composer').status, 0, 'command -v composer found it');
});

check("the scheduler runs Laravel's schedule as a non-root user, and its retention prune runs with the deploy's settings", () => {
  const state = stateOf('scheduler');
  assert.equal(state.running, true, `the scheduler is ${state.status}`);
  const id = stack.exec('scheduler', ['id', '-u']);
  assert.equal(id.status, 0, id.stderr);
  assert.notEqual(Number(id.stdout.trim()), 0, 'the scheduler runs as root');
  const list = stack.exec('scheduler', ['php', 'artisan', 'schedule:list']);
  assert.equal(list.status, 0, list.stderr);
  const jobs = ['club:renew', 'credits:expire', 'credits:remind', 'retention:prune'];
  console.log(`scheduler: uid ${id.stdout.trim()}; ${jobs.filter((j) => list.stdout.includes(j)).length} of ${jobs.length} jobs on the schedule`);
  assert.deepEqual(jobs.filter((j) => !list.stdout.includes(j)), [], 'jobs missing from the schedule');
  // One run now: the settings of deploy/ci.env reach it, and it prints counts only.
  const prune = stack.exec('scheduler', ['php', 'artisan', 'retention:prune']);
  assert.equal(prune.status, 0, `retention:prune: ${tail(prune.stdout + prune.stderr, 600)}`);
  assert.match(prune.stdout.trim(), /^Retention prune: tokens=\d+ twoFactorChallenges=\d+ resetLinks=\d+ cacheRows=\d+ cacheLocks=\d+ evidenceImages=\d+ filesRemoved=\d+ filesFailed=0$/);
  // The same writable private volume as api, where the prune removes old evidence images.
  const { private: priv } = roots();
  assert.equal(envOf('scheduler', 'PRIVATE_MEDIA_ROOT'), priv);
  assert.equal(stack.sh('scheduler', `test -d '${priv}/evidence' && test -w '${priv}/evidence'`).status, 0, 'the scheduler cannot write the evidence folder');
});

// --------------------------------------------------------------------------- uploads

check('F-29: a PHP file planted in any upload folder is never executed, through the edge or inside api', () => {
  const pub = storageList('PUBLIC_FOLDERS');
  const priv = storageList('PRIVATE_FOLDERS');
  const where = roots();
  const folders = [
    ...pub.map((folder) => ({ folder, dir: `${where.uploads}/${folder}` })),
    ...priv.map((folder) => ({ folder, dir: `${where.private}/${folder}` })),
  ];
  // The marker is what the file PRINTS when PHP runs it; its source holds it reversed.
  const marker = `php-ran-${crypto.randomBytes(8).toString('hex')}`;
  const source = `<?php echo strrev('${[...marker].reverse().join('')}'); ?>\n`;
  assert.ok(!source.includes(marker));
  const name = `probe-${crypto.randomBytes(6).toString('hex')}.php`;
  const planted = folders.map((f) => `${f.dir}/${name}`);
  for (const file of planted) plant('api', file, source);
  try {
    const spellings = (f) => [`/storage/${f}/${name}`, `//storage/${f}/${name}`, `/storage/./${f}/${name}`, `/storage/${f}/${name}/x`, `/STORAGE/${f}/${name}`];
    const edge = folders.flatMap((f) => spellings(f.folder));
    const res = stack.probe(edge.map((p) => apiRequest('GET', p))).results;
    console.log(`planted: ${folders.length} folders (${pub.length} public, ${priv.length} private); ${edge.length} requests through the edge, answers ${JSON.stringify(tally(res))}`);
    assert.deepEqual(res.map((r, i) => ({ p: edge[i], r })).filter(({ r }) => r.error || (r.body ?? '').includes(marker)).map(({ p, r }) => `${p}: ${redact(r)}`), [], 'PHP ran');
    assert.deepEqual(res.map((r, i) => ({ p: edge[i], r })).filter(({ r }) => r.status === 200).map(({ p, r }) => `${p}: ${r.status}`), [], 'a planted file was served');

    // Apache inside api, asked directly on its port: no path of its leads to the uploads.
    const paths = folders.map((f) => `/storage/${f.folder}/${name}`);
    const php = [
      '$out = [];',
      'foreach (array_slice($argv, 1) as $p) {',
      "  $ctx = stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 10]]);",
      "  $body = @file_get_contents('http://127.0.0.1:8080' . $p, false, $ctx);",
      "  $out[] = ['path' => $p, 'status' => $http_response_header[0] ?? 'no answer', 'ran' => str_contains((string) $body, getenv('MARKER'))];",
      '}',
      'echo json_encode($out);',
    ].join('\n');
    const inside = stack.compose(['exec', '-T', '-e', `MARKER=${marker}`, 'api', 'php', '-r', php, ...paths]);
    assert.equal(inside.status, 0, inside.stderr);
    const answers = JSON.parse(inside.stdout);
    console.log(`inside api on 8080: ${answers.length} requests (${[...new Set(answers.map((a) => a.status))].join('; ')})`);
    assert.equal(answers.length, paths.length);
    assert.deepEqual(answers.filter((a) => a.ran || / 200 /.test(a.status)).map((a) => `${a.path}: ${a.status}`), [], 'Apache served or ran a planted file');

    // api mounts the two volumes where Laravel stores the files, outside Apache's docroot and
    // outside /var/www, which Apache's own settings open; nothing else of the uploads.
    const api = stack.containersOf('api')[0];
    const uploadMounts = (api.Mounts ?? []).filter((m) => /uploads|private-media|storage/.test(`${m.Name ?? ''} ${m.Source ?? ''} ${m.Destination}`));
    console.log(`api's upload mounts: ${uploadMounts.map((m) => `${m.Name ?? m.Source} -> ${m.Destination}`).join(', ')}`);
    assert.deepEqual(uploadMounts.map((m) => m.Destination).sort(), [where.private, where.uploads].sort(), 'api mounts other upload folders');
    assert.deepEqual(uploadMounts.filter((m) => m.Destination.startsWith('/var/www/')).map((m) => m.Destination), [], 'an upload volume under /var/www');

    // And the planted public files did lie where media serves files from: the 404s above are
    // the edge refusing them, not files the file server could not see.
    const seen = stack.sh('media', `${pub.map((f) => `test -f /srv/storage/${f}/${name} && echo ${f}`).join('; ')}; true`);
    assert.deepEqual(seen.stdout.trim().split(/\s+/).filter(Boolean).sort(), [...pub].sort(), 'the planted files are in the volume media serves');
  } finally {
    remove('api', planted);
  }
});

check('F-29/F-30: a stored image is a plain file with nosniff and a sandbox CSP; private media are never served as files', () => {
  const bytes = png([0x20, 0x90, 0x60]);
  const name = storedName('png');
  const pub = storageList('PUBLIC_FOLDERS');
  const priv = storageList('PRIVATE_FOLDERS');
  const where = roots();
  const planted = [...pub.map((f) => `${where.uploads}/${f}/${name}`), ...priv.map((f) => `${where.private}/${f}/${name}`)];
  for (const file of planted) plant('api', file, bytes);
  try {
    const urls = [...pub, ...priv].map((f) => `/storage/${f}/${name}`);
    const res = stack.probe(urls.map((p) => apiRequest('GET', p))).results;
    console.log(`stored image: ${pub.length} public and ${priv.length} private folders requested through the edge`);
    pub.forEach((f, i) => {
      const r = res[i];
      assert.equal(r.status, 200, `${urls[i]}: ${redact(r)}`);
      assert.equal(header(r, 'content-type'), 'image/png', urls[i]);
      assert.equal(header(r, 'x-content-type-options'), 'nosniff', urls[i]);
      assert.match(header(r, 'content-security-policy') ?? '', /default-src 'none'.*sandbox|sandbox.*default-src 'none'/, urls[i]);
      assert.equal(r.bodySha256, sha256(bytes), `${urls[i]}: not the stored bytes`);
    });
    priv.forEach((f, j) => {
      const r = res[pub.length + j];
      assert.ok(r.status >= 400 && r.status < 500, `${urls[pub.length + j]} answered ${r.status ?? r.error}`);
      assert.notEqual(r.bodySha256, sha256(bytes), `${urls[pub.length + j]} was served`);
    });
    // The files come from media, read-only; the edge, which holds the keys, mounts no upload.
    const caddyMounts = stack.containersOf('caddy')[0]?.Mounts ?? [];
    const mediaMounts = stack.containersOf('media')[0]?.Mounts ?? [];
    const named = (list, re) => list.filter((m) => re.test(m.Name ?? '')).map((m) => m.Destination);
    assert.deepEqual(named(caddyMounts, /(uploads|private-media)$/), [], 'caddy mounts an upload volume');
    assert.deepEqual(named(mediaMounts, /private-media$/), [], 'media mounts the private media');
    const uploads = mediaMounts.find((m) => m.Destination === '/srv/storage');
    assert.ok(uploads && /uploads$/.test(uploads.Name ?? ''), 'media has no uploads volume at /srv/storage');
    assert.equal(uploads.RW, false, 'media mounts the uploads writable');
  } finally {
    remove('api', planted);
  }
});

check("F-11: an evidence image leaves the server only through Laravel's admin route, with an admin token", () => {
  const token = adminToken();
  const target = register('stackevidence');
  const viewer = register('stackviewer');
  const banned = stack.request(imageUpload(`/api/admin/users/${target.id}/ban`, token, { reason: 'Stack test evidence' }, 'evidence', png([0x30, 0x60, 0x90])));
  assert.equal(banned.status, 200, `ban with evidence: ${redact(banned)}`);
  const list = stack.request(apiRequest('GET', '/api/admin/evidence', { token }));
  assert.equal(list.status, 200, redact(list));
  const url = (list.json?.data ?? []).find((e) => e.user?.id === target.id)?.image_url ?? '';
  const prefix = `https://${domain}/api/admin/evidence-files/`;
  assert.ok(url.startsWith(prefix), `image_url ${url} is not the checked route`);
  const file = url.slice(prefix.length);
  assert.match(file, /^[0-9a-f]{40}\.(jpg|png|webp)$/);
  const [withToken, without, asViewer, asFile] = stack.probe([
    apiRequest('GET', `/api/admin/evidence-files/${file}`, { token }),
    apiRequest('GET', `/api/admin/evidence-files/${file}`),
    apiRequest('GET', `/api/admin/evidence-files/${file}`, { token: viewer.token }),
    apiRequest('GET', `/storage/evidence/${file}`),
  ]).results;
  console.log(`evidence image: admin ${withToken.status}, without a token ${without.status}, another account ${asViewer.status}, as a file ${asFile.status}`);
  assert.equal(withToken.status, 200, redact(withToken));
  assert.match(header(withToken, 'content-type') ?? '', /^image\//);
  assert.equal(header(withToken, 'x-content-type-options'), 'nosniff');
  assert.match(header(withToken, 'content-security-policy') ?? '', /sandbox/);
  // Exactly these two directives, through the edge as well: Cloudflare caches .jpg, .png and
  // .webp by extension, and only this header keeps ban evidence out of its cache.
  assert.deepEqual(directives(header(withToken, 'cache-control')), ['no-store', 'private'], `the evidence answer's Cache-Control: ${header(withToken, 'cache-control')}`);
  assert.equal(without.status, 401);
  assert.equal(asViewer.status, 403);
  assert.ok(asFile.status >= 400 && asFile.status < 500, `/storage/evidence/ answered ${asFile.status ?? asFile.error}`);
  assert.notEqual(asFile.bodySha256, withToken.bodySha256, 'the evidence image was served as a file');
  const { private: priv } = roots();
  assert.equal(stack.exec('api', ['test', '-f', `${priv}/evidence/${file}`]).status, 0, 'the evidence image is not in the private media');
  // Owner and group only (api/config/filesystems.php): the backup reads it through the group.
  assert.equal(stack.exec('api', ['stat', '-c', '%a %u %g', `${priv}/evidence/${file}`]).stdout.trim(), '640 33 33', 'the mode or owner of a stored evidence image');
  assert.equal(stack.exec('scheduler', ['test', '-f', `${priv}/evidence/${file}`]).status, 0, "the scheduler's prune cannot see the evidence image");
  assert.notEqual(stack.exec('media', ['test', '-e', `/srv/storage/evidence/${file}`]).status, 0, 'media can see the evidence image');
  assert.notEqual(stack.exec('caddy', ['test', '-e', `/srv/storage/evidence/${file}`]).status, 0, 'caddy can see the evidence image');
});

check('uploads: a symbolic link planted in the uploads volume never hands out the edge\'s private keys', () => {
  // Caddy's file server follows links, and an allowed name is all a link needs. The edge holds
  // the certificate and account keys (caddy-data; in CI the keys of Caddy's internal authority
  // for DOMAIN=localhost), so the links point there: absolute, and relative from the folder.
  const where = roots();
  const keys = [
    { folder: 'partners', target: '/data/caddy/pki/authorities/local/root.key' },
    { folder: 'offers', target: `/data/caddy/certificates/local/${domain}/${domain}.key` },
    { folder: 'avatars', target: '/data/caddy/pki/authorities/local/intermediate.key', relative: '../../../data/caddy/pki/authorities/local/intermediate.key' },
  ];
  // The keys exist at the edge: a 404 below is a refusal, not a missing target. Only a hash of
  // each key leaves the container, never the key.
  const hashes = keys.map((k) => {
    const r = stack.sh('caddy', `test -f '${k.target}' && sha256sum '${k.target}' | cut -d' ' -f1`);
    assert.equal(r.status, 0, `the edge has no ${k.target}: the check would prove nothing`);
    return r.stdout.trim();
  });
  const control = { folder: 'partners', name: storedName('png'), bytes: png([0x51, 0x52, 0x53]) };
  const links = keys.map((k) => ({ ...k, file: `${where.uploads}/${k.folder}/${storedName(k.folder === 'avatars' ? 'webp' : 'png')}` }));
  const planted = [...links.map((l) => l.file), `${where.uploads}/${control.folder}/${control.name}`];
  for (const l of links) {
    const r = stack.exec('api', ['ln', '-s', l.relative ?? l.target, l.file]);
    assert.equal(r.status, 0, `cannot plant a link at ${l.file}: ${r.stderr}`);
  }
  plant('api', `${where.uploads}/${control.folder}/${control.name}`, control.bytes);
  try {
    const urls = [...links.map((l) => l.file.replace(`${where.uploads}/`, '/storage/')), `/storage/${control.folder}/${control.name}`];
    const res = stack.probe(urls.map((p) => apiRequest('GET', p))).results;
    const served = links.map((l, i) => ({ l, r: res[i], hash: hashes[i] }))
      .filter(({ r, hash }) => r.error || r.status !== 404 || r.bodySha256 === hash || /PRIVATE KEY/.test(r.body ?? ''))
      // Status and what was found only: never the body.
      .map(({ l, r, hash }) => `${l.relative ? 'relative' : 'absolute'} link to ${l.target}: ${r.status ?? r.error}, the key's bytes ${r.bodySha256 === hash ? 'served' : 'not served'}, PRIVATE KEY in the body: ${/PRIVATE KEY/.test(r.body ?? '')}`);
    console.log(`planted links: ${links.length} (${links.filter((l) => l.relative).length} relative) to the edge's keys, answers ${JSON.stringify(tally(res.slice(0, links.length)))}; control file ${res.at(-1).status}`);
    assert.deepEqual(served, [], "the edge's private keys were served through a planted link");
    const ctl = res.at(-1);
    assert.equal(ctl.status, 200, `a stored file next to the links: ${ctl.status ?? ctl.error}`);
    assert.equal(ctl.bodySha256, sha256(control.bytes), 'the control file is not the stored bytes');
    // The links are in the volume the file server reads, and resolve to nothing there.
    const inMedia = stack.sh('media', links.map((l) => `test -L '${l.file.replace(`${where.uploads}/`, '/srv/storage/')}' && ! test -e '${l.file.replace(`${where.uploads}/`, '/srv/storage/')}' && echo ok`).join('; '));
    assert.equal(inMedia.stdout.trim().split(/\s+/).filter((w) => w === 'ok').length, links.length, `media does not see the links as dangling: ${inMedia.stderr}`);
  } finally {
    remove('api', planted);
  }
});

// --------------------------------------------------------------------------- headers

check('F-30: every kind of answer carries the security headers, and http redirects to https', () => {
  const png1 = png([0x11, 0x22, 0x33]);
  const name = storedName('png');
  const where = roots();
  plant('api', `${where.uploads}/avatars/${name}`, png1);
  try {
    const big = JSON.stringify({ email: 'x'.repeat(200 * 1024) });
    const kinds = [
      ['Laravel 200', apiRequest('GET', '/api/health'), 200],
      ['Laravel 401', apiRequest('GET', '/api/user'), 401],
      ['Laravel 405', apiRequest('GET', '/api/login'), 405],
      ['Laravel 422', apiRequest('POST', '/api/login', { json: {} }), 422],
      ['Laravel 401 on a marketplace route', apiRequest('GET', '/api/bookings'), 401],
      ['Laravel 404 for an unknown path', apiRequest('GET', `/api/stack-${crypto.randomBytes(4).toString('hex')}`), 404],
      // The page behind sticker links sends its own, narrower policy (inline styles only).
      ['Laravel page 200 (sticker link)', { method: 'GET', path: `/c/${crypto.randomBytes(10).toString('hex')}`, headers: { Accept: 'text/html' } }, 200, 'page'],
      // Both answers of the upload route keep its own, stricter policy (sandbox).
      ['caddy file 200', apiRequest('GET', `/storage/avatars/${name}`), 200, 'upload'],
      ['caddy file 404', apiRequest('GET', `/storage/avatars/${storedName('jpg')}`), 404, 'upload'],
      ['caddy 404 under /storage', apiRequest('GET', '/storage/x.php'), 404],
      ['caddy 413 body too large', apiRequest('POST', '/api/login', { body: big, headers: { 'Content-Type': 'application/json' } }), 413],
    ];
    const res = stack.probe(kinds.map(([, spec]) => spec)).results;
    assert.ok(PAGE_CSP, 'cannot read the page policy in api/app/Http/Responses/OpenAppPage.php');
    const rules = {
      'Strict-Transport-Security max-age >= 1 year': (r) => Number(/max-age=(\d+)/.exec(header(r, 'strict-transport-security') ?? '')?.[1]) >= 31536000,
      'X-Content-Type-Options nosniff': (r) => header(r, 'x-content-type-options') === 'nosniff',
      'X-Frame-Options DENY': (r) => header(r, 'x-frame-options') === 'DENY',
      'Content-Security-Policy': (r, kind) => {
        const csp = header(r, 'content-security-policy') ?? '';
        if (kind === 'upload') return /default-src 'none'/.test(csp) && /sandbox/.test(csp);
        if (kind === 'page') return csp === PAGE_CSP && /frame-ancestors 'none'/.test(csp) && !/script-src/.test(csp);
        return /frame-ancestors 'none'/.test(csp);
      },
      'Referrer-Policy no-referrer': (r) => header(r, 'referrer-policy') === 'no-referrer',
      'Permissions-Policy': (r) => /camera=\(\)/.test(header(r, 'permissions-policy') ?? '') && /geolocation=\(\)/.test(header(r, 'permissions-policy') ?? ''),
      'no Server header': (r) => header(r, 'server') === undefined,
      'no X-Powered-By header': (r) => header(r, 'x-powered-by') === undefined,
    };
    const problems = [];
    kinds.forEach(([label, , status, kind], i) => {
      const r = res[i];
      if (r.status !== status) problems.push(`${label}: status ${r.status ?? r.error}, expected ${status}`);
      for (const [rule, ok] of Object.entries(rules)) if (!ok(r, kind)) problems.push(`${label}: ${rule}`);
    });
    console.log(`headers: ${kinds.length} kinds of answer x ${Object.keys(rules).length} rules = ${kinds.length * Object.keys(rules).length} checks`);
    assert.deepEqual(problems, []);

    const redirect = stack.request({ method: 'GET', path: '/api/health', scheme: 'http' });
    assert.ok([301, 308].includes(redirect.status), `http answered ${redirect.status ?? redirect.error}`);
    assert.equal(header(redirect, 'location'), `https://${domain}/api/health`);
  } finally {
    remove('api', [`${where.uploads}/avatars/${name}`]);
  }
});

check("F-28: Apache's own redirects through the edge keep the public https address, not port 8080", () => {
  // Laravel's public/.htaccess redirects a path with a trailing slash; Apache writes the address.
  const cases = [['GET', '/api/health/'], ['GET', '/api/offers/'], ['POST', '/api/login/']];
  const res = stack.probe(cases.map(([method, p]) => apiRequest(method, p, method === 'GET' ? {} : { json: {} }))).results;
  const wrong = cases.map(([method, p], i) => ({ method, p, r: res[i], want: `https://${domain}${p.slice(0, -1)}` }))
    .filter(({ r, want }) => r.status !== 301 || header(r, 'location') !== want)
    .map(({ method, p, r, want }) => `${method} ${p}: ${r.status ?? r.error} to ${header(r, 'location')} (expected 301 to ${want})`);
  console.log(`trailing-slash redirects: ${cases.length} requests, locations ${JSON.stringify(res.map((r) => header(r, 'location')))}`);
  assert.deepEqual(wrong, [], "redirects that leave the public address (Apache's own port or scheme)");
  for (const r of res) assert.doesNotMatch(header(r, 'location') ?? '', /:8080|^http:/, 'a redirect names port 8080 or plain http');
});

check("F-30: Apache's own error pages through the edge name no server version", () => {
  // Answers Apache writes itself, not Laravel: a denied file, an encoded slash, a denied folder.
  const paths = ['/.htaccess', '/api/a%2Fb', '/icons/', '/server-status'];
  const res = stack.probe(paths.map((p) => apiRequest('GET', p))).results;
  console.log(`Apache error pages: ${paths.length} requests through the edge, answers ${JSON.stringify(res.map((r) => r.status ?? r.error))}`);
  const notApache = paths.filter((p, i) => !/<title>\d{3} [^<]+<\/title>/.test(res[i].body ?? ''));
  assert.deepEqual(notApache, [], "answers that are not Apache's own error pages: the check would prove nothing");
  const leaks = paths.map((p, i) => ({ p, r: res[i] }))
    .filter(({ r }) => /Apache\/|\(Debian\)|Server at /.test(r.body ?? '') || header(r, 'server') !== undefined)
    .map(({ p, r }) => `${p}: ${r.status} ${/<address>[^<]*<\/address>/.exec(r.body ?? '')?.[0] ?? ''} server header: ${header(r, 'server') ?? 'none'}`);
  assert.deepEqual(leaks, [], 'Apache names its version or operating system');
});

// --------------------------------------------------------------------------- one owner per path

check("F-10: every API route is answered by Laravel through the edge, and an unknown /api path gets Laravel's own 404", () => {
  const r = stack.exec('api', ['php', 'artisan', 'route:list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const routes = JSON.parse(r.stdout).filter((x) => x.uri.startsWith('api/'));
  // No route that would hand unknown paths on: Laravel answers every path itself.
  assert.deepEqual(routes.filter((x) => /\{[^}]*\?\}$/.test(x.uri) && /path|any/.test(x.uri)).map((x) => x.uri), [], 'a catch-all route under /api');
  const calls = routes.flatMap((x) => x.method.split('|').filter((m) => m !== 'HEAD').map((method) => ({ method, uri: x.uri })));
  console.log(`Laravel routes under /api: ${routes.length}; ${calls.length} method and path pairs requested through the edge`);
  assert.ok(routes.length >= 100, `only ${routes.length} Laravel routes found`);
  // A path parameter gets a value its pattern accepts (the evidence file name has one).
  const fill = (uri) => uri.replace(/\{file\}/g, `${'0'.repeat(40)}.png`).replace(/\{[^}]+\}/g, '1');
  // The calendar link answers 404 without its signature, by design (BookingController::calendar).
  const notFoundByDesign = new Set(['GET api/bookings/{id}/calendar.ics']);
  const res = stack.probe(calls.map((c) => apiRequest(c.method, `/${fill(c.uri)}`, c.method === 'GET' ? {} : { json: {} }))).results;
  const wrong = calls.map((c, i) => ({ c, r: res[i] }))
    .filter(({ c, r: a }) => a.error || a.status >= 500 || a.status === 405 || header(a, 'x-goenn-backend')
      || (a.status === 404 && !notFoundByDesign.has(`${c.method} ${c.uri}`)))
    .map(({ c, r: a }) => `${c.method} /${c.uri}: ${a.status ?? a.error} ${header(a, 'x-goenn-backend') ?? ''}`);
  console.log(`answers: ${JSON.stringify(tally(res))}`);
  assert.deepEqual(wrong, [], 'routes that did not reach their Laravel handler through the edge');
  const control = stack.request(apiRequest('GET', `/api/stack-${crypto.randomBytes(4).toString('hex')}`));
  assert.equal(control.status, 404);
  assert.deepEqual(control.json, { message: 'Nicht gefunden.' }, "an unknown /api path does not get Laravel's own answer");
  assert.equal(header(control, 'x-goenn-backend'), undefined, 'an unknown /api path went to another backend');
});

check('F-01: other spellings of a Laravel path are refused through the edge', () => {
  const user = register('stackvariant');
  const variants = ['/api/Login', '/api//login', '/api/./login', '/api/x/../login', '/api/%4Cogin', '/api/%254Cogin', '/api/login%2F'];
  const res = stack.probe([
    ...variants.map((p) => apiRequest('POST', p, { json: {} })),
    apiRequest('GET', '/api/login'),
    apiRequest('GET', '/api/offers', { token: user.token }),
  ]).results;
  console.log(`variants: ${variants.length} spellings of /api/login, answers ${JSON.stringify(tally(res.slice(0, variants.length)))}`);
  const wrong = variants.map((p, i) => ({ p, r: res[i] }))
    .filter(({ r }) => header(r, 'x-goenn-backend') || r.status !== 404)
    .map(({ p, r }) => `${p}: ${r.status ?? r.error} ${header(r, 'x-goenn-backend') ?? ''}`);
  assert.deepEqual(wrong, [], 'variants that reached a handler or did not answer 404');
  assert.equal(res[variants.length].status, 405, 'GET /api/login');
  const offers = res[variants.length + 1];
  assert.equal(offers.status, 200, `a marketplace path: ${redact(offers)}`);
  assert.ok(Array.isArray(offers.json?.data), 'the offer list is not Laravel\'s answer');
});

// --------------------------------------------------------------------------- end to end

check('F-10: the marketplace end to end through the edge: sign-up, a partner with its logo, an offer, credits in test mode', () => {
  const interests = stack.request(apiRequest('GET', '/api/interests'));
  assert.equal(interests.status, 200, redact(interests));
  assert.ok((interests.json?.data ?? []).length >= 20, 'the categories of the migrations are missing');

  const user = register('stackmarket');
  assert.equal(user.user?.club_plan, 'free', 'a new account does not start on the free plan');
  const token = adminToken();
  const partner = stack.request(apiRequest('POST', '/api/admin/partners', { token, json: { name: 'CI Kletterhalle', city: 'Göttingen', is_active: true } }));
  assert.equal(partner.status, 201, `partner: ${redact(partner)}`);
  const partnerId = partner.json?.data?.id;

  const logo = stack.request(imageUpload(`/api/admin/partners/${partnerId}/image`, token, { kind: 'logo' }, 'image', png()));
  assert.equal(logo.status, 200, `logo: ${redact(logo)}`);
  const logoUrl = logo.json?.data?.logo_url ?? '';
  assert.match(logoUrl, new RegExp(`^https://${domain.replaceAll('.', '\\.')}/storage/partners/[0-9a-f]{40}\\.png$`), `logo_url ${logoUrl}`);
  const image = stack.request(apiRequest('GET', logoUrl.slice(`https://${domain}`.length)));
  console.log(`partner ${partnerId}: logo ${image.status} ${header(image, 'content-type')} (${image.bodyBytes} bytes)`);
  assert.equal(image.status, 200, redact(image));
  assert.equal(header(image, 'content-type'), 'image/png');
  assert.equal(header(image, 'x-content-type-options'), 'nosniff');
  assert.match(header(image, 'content-security-policy') ?? '', /sandbox/);

  const offer = stack.request(apiRequest('POST', '/api/admin/offers', {
    token,
    json: { partner_id: partnerId, kind: 'activity', title: 'CI Klettern', price_cents: 2400, price_credits: 320, is_active: true },
  }));
  assert.equal(offer.status, 201, `offer: ${redact(offer)}`);
  const offers = stack.request(apiRequest('GET', '/api/offers', { token: user.token }));
  assert.equal(offers.status, 200, redact(offers));
  assert.ok((offers.json?.data ?? []).some((o) => o.id === offer.json?.data?.id), 'the new offer is not in the list');

  // deploy/ci.env runs payments in test mode: the purchase goes through without real money.
  const purchase = stack.request(apiRequest('POST', '/api/wallet/purchase', { token: user.token, json: { credits: 50 } }));
  console.log(`credits: purchase ${purchase.status}, added ${purchase.json?.data?.added}, balance ${purchase.json?.data?.balance}`);
  assert.equal(purchase.status, 201, `purchase: ${redact(purchase)}`);
  assert.ok(purchase.json.data.added >= 50, 'fewer credits than the pack');
  assert.equal(purchase.json.data.balance, purchase.json.data.added, 'the balance of a new account is not what was added');
});

check('F-14: a sign-up without the age confirmation is refused, and the word filter names a blocked username', () => {
  const identity = testIdentity('stackconsent');
  const password = freshPassword();
  const base = { name: identity.name, email: identity.email, password, terms_version: legal.terms_version };
  // A username the filter blocks on its own (a term from shared/blocked-terms.json), so the 422 is
  // about the username and nothing else.
  const term = BLOCKED_TERMS.groups.filter((g) => (g.modes ?? []).includes('username'))
    .flatMap((g) => g.substring ?? []).find((t) => /^[a-z]{4,14}$/.test(t) && findBlockedTerm(`x${t}x`, BLOCKED_TERMS, 'username'));
  assert.ok(term, 'no blocked username term found in shared/blocked-terms.json');
  const blockedName = `x${term}x${uniqueStamp()}`;
  const [noAge, blocked] = stack.probe([
    apiRequest('POST', '/api/register', { json: { ...base, username: identity.username } }),
    apiRequest('POST', '/api/register', { json: { ...base, username: blockedName, email: `filter-${identity.email}`, confirmed_min_age: legal.min_age } }),
  ], { index: 2 }).results;
  assert.equal(noAge.status, 422, redact(noAge));
  assert.ok(noAge.json?.errors?.confirmed_min_age, 'the refusal does not name confirmed_min_age');
  assert.equal(blocked.status, 422, redact(blocked));
  assert.ok(blocked.json?.errors?.username, 'the refusal does not name the username');
  assert.deepEqual(Object.keys(blocked.json.errors), ['username'], 'refused for another reason as well');
});

check('F-09: the reset code mail reaches the CI mail catcher, the code works once, and it is in no container log', async () => {
  const user = register('stackreset', 2);
  const forgot = stack.request(apiRequest('POST', '/api/forgot-password', { json: { email: user.email } }), 2);
  assert.equal(forgot.status, 200, redact(forgot));
  // Mailpit's API, asked from inside the stack (the probe cannot reach the app network).
  const fetchJson = (url) => {
    const r = stack.exec('api', ['php', '-r', 'echo file_get_contents($argv[1]);', url]);
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  };
  const search = `http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:"${user.email}"`)}`;
  const found = await waitFor('the reset mail in Mailpit', () => {
    const list = fetchJson(search);
    return list?.messages?.length ? list : null;
  }, { ms: 60_000 });
  assert.equal(found.messages.length, 1, 'one mail for the address');
  const message = fetchJson(`http://mailpit:8025/api/v1/message/${found.messages[0].ID}`);
  const codes = [...new Set([...String(message?.Text ?? '').matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map((m) => m[1]))];
  assert.equal(codes.length, 1, `the mail holds ${codes.length} six-digit numbers`);
  const [code] = codes;
  assert.ok(!String(message.Subject).includes(code), 'the subject holds the code');

  const next = freshPassword();
  const body = { email: user.email, code, password: next, password_confirmation: next };
  const reset = stack.request(apiRequest('POST', '/api/reset-password', { json: body }), 2);
  assert.equal(reset.status, 200, redact(reset));
  const again = stack.request(apiRequest('POST', '/api/reset-password', { json: { ...body, password: `${next}x`, password_confirmation: `${next}x` } }), 2);
  assert.equal(again.status, 422, 'the code worked twice');
  const login = stack.request(apiRequest('POST', '/api/login', { json: { email: user.email, password: next } }), 2);
  assert.equal(login.status, 200, `sign-in with the new password: ${redact(login)}`);

  const logs = stack.compose(['logs', '--no-color'], { profiles: ['tools', 'test'] });
  assert.equal(logs.status, 0, logs.stderr);
  const lines = logs.stdout.split(/\r?\n/);
  const services = new Set(lines.map((l) => /^(\S+?)-\d+\s+\|/.exec(l)?.[1]).filter(Boolean));
  console.log(`logs: ${lines.length} lines of ${services.size} containers searched`);
  assert.ok(lines.length > 10 && services.size >= 5, 'too few logs to search');
  // A fraction of a second (".123456") is not the code.
  const codeAt = new RegExp(`(?<![\\d.])${code}(?!\\d)`);
  const leaks = [];
  lines.forEach((line, i) => {
    const where = `${/^(\S+)\s+\|/.exec(line)?.[1] ?? '?'} line ${i + 1}`;
    if (codeAt.test(line)) leaks.push(`${where}: the reset code`);
    for (const [what, value] of [['a password', user.password], ['a password', next], ['the admin password', S.admin.password]]) {
      if (line.includes(value)) leaks.push(`${where}: ${what}`);
    }
  });
  assert.deepEqual(leaks, []);
});

check("F-31: Laravel's per-address limit counts the visitor's own address, and a client-sent X-Forwarded-For changes nothing", () => {
  // The password-forgot limiter counts per address and per account (api/config/ratelimits.php);
  // every request names another address of its own, so only the per-address counter fills.
  const spec = laravelLimit('password-forgot', 'ip');
  const m = /^(\d+)\/(\d+)(,|$)/.exec(spec);
  assert.ok(m, `the per-address rule is not max/seconds: ${spec}`);
  const max = Number(m[1]);
  const windowMs = Number(m[2]) * 1000;
  const stamp = crypto.randomBytes(4).toString('hex');
  let n = 0;
  const forgot = () => {
    n += 1;
    return apiRequest('POST', '/api/forgot-password', { json: { email: `f31-${stamp}-${n}@example.invalid` } });
  };
  const forged = (address) => {
    const r = forgot();
    return { ...r, headers: { ...r.headers, 'X-Forwarded-For': address } };
  };

  // Visitor A is the third probe, which sent nothing before: its counter starts empty.
  const t0 = Date.now();
  const a = stack.probe([...Array.from({ length: max }, forgot), forgot(), forged('203.0.113.7')], { index: 3 });
  const b = stack.probe([forgot(), forged(a.address[0])], { index: 1 });
  const aAgain = stack.request(forgot(), 3);
  const elapsed = Date.now() - t0;
  const burst = a.results.slice(0, max);
  const [over, overForged] = a.results.slice(max);
  const [bPlain, bAsA] = b.results;
  const counts = burst.reduce((acc, r) => ({ ...acc, [r.status ?? r.error]: (acc[r.status ?? r.error] ?? 0) + 1 }), {});
  console.log(`limit ${spec}: visitor A ${a.address.join(',')} sent ${max} (${JSON.stringify(counts)}), then ${over.status}, forged ${overForged.status}; `
    + `visitor B ${b.address.join(',')}: ${bPlain.status}, claiming A's address ${bAsA.status}; A again ${aAgain.status}; ${elapsed} ms`);
  assert.notEqual(a.address[0], b.address[0], 'the two visitors share an address');
  assert.equal(counts[429] ?? 0, 0, 'limited before the limit');
  assert.deepEqual(Object.keys(counts), ['200'], `answers inside the limit: ${JSON.stringify(counts)}`);
  assert.ok(elapsed < windowMs, `the checks took ${elapsed} ms, longer than the limit's window: the result proves nothing`);
  assert.equal(over.status, 429, 'one more than the limit from the same address');
  assert.match(over.json?.message ?? '', /Zu viele Versuche/, "the 429 is not Laravel's");
  assert.equal(overForged.status, 429, 'a forged X-Forwarded-For moved visitor A into another bucket');
  assert.notEqual(bPlain.status, 429, "visitor B is counted in A's bucket: Laravel does not count the visitor's own address");
  assert.notEqual(bAsA.status, 429, "visitor B claiming A's address in X-Forwarded-For was counted as A");
  assert.equal(aAgain.status, 429, "A's window had closed before B's checks: the result proves nothing");
});

check('account deletion: Laravel deletes the account, and its token opens nothing afterwards', () => {
  const user = register('stackdelete');
  const del = stack.request(apiRequest('DELETE', '/api/me', { token: user.token, json: { password: user.password } }));
  assert.equal(del.status, 200, `DELETE /api/me: ${redact(del)}`);
  const res = stack.probe([
    apiRequest('GET', '/api/user', { token: user.token }),
    apiRequest('GET', '/api/bookings', { token: user.token }),
    apiRequest('GET', '/internal/health'),
    apiRequest('DELETE', `/internal/accounts/${user.id ?? 1}`, { json: {} }),
  ]).results;
  console.log(`after the deletion: /api/user ${res[0].status}, /api/bookings ${res[1].status}; the former internal routes from the edge: ${res[2].status}, ${res[3].status}`);
  assert.equal(res[0].status, 401);
  assert.equal(res[1].status, 401);
  assert.equal(query(`SELECT COUNT(*) FROM users WHERE email = '${user.email}'`)[0], '0', 'the account row is still there');
  assert.equal(query(`SELECT COUNT(*) FROM personal_access_tokens WHERE tokenable_id = ${Number(user.id)}`)[0], '0', 'tokens of the account are still there');
  for (const r of res.slice(2)) {
    assert.ok(r.status === 404 || r.status === 405, `an internal path answered ${r.status} through the edge`);
    assert.equal(header(r, 'x-goenn-backend'), undefined, 'an internal path reached another backend through the edge');
  }
});

// --------------------------------------------------------------------------- backups

check('F-17: the backup writes a database dump and an archive of the uploads and private media, with checksums', () => {
  const pubName = storedName('png');
  const privName = storedName('png');
  const where = roots();
  const planted = [`${where.uploads}/partners/${pubName}`, `${where.private}/evidence/${privName}`];
  for (const file of planted) plant('api', file, png([0x44, 0x55, 0x66]));
  // As Laravel writes an evidence image (api/config/filesystems.php): owner and group only. The
  // backup, root without capabilities, reads it through the www-data group.
  assert.equal(stack.exec('api', ['chmod', '0640', planted[1]]).status, 0);
  try {
    const run = stack.exec('backup', ['bash', '/opt/deploy/backup.sh', '--once']);
    assert.equal(run.status, 0, `backup.sh --once: ${tail(run.stdout + run.stderr)}`);
    const stamp = /run (\S+) written/.exec(run.stdout)?.[1];
    assert.ok(stamp, `no "written" line: ${tail(run.stdout)}`);
    const files = [`db-${stamp}.sql.gz`, `uploads-${stamp}.tar.gz`, `SHA256SUMS-${stamp}`];
    const listed = stack.exec('backup', ['ls', '-1', '/backups']).stdout.split(/\s+/);
    assert.deepEqual(files.filter((f) => !listed.includes(f)), [], 'missing from /backups');
    assert.equal(stack.sh('backup', `cd /backups && sha256sum --check --quiet SHA256SUMS-${stamp}`).status, 0, 'the checksums do not verify');

    const dumped = stack.sh('backup', `gzip -dc /backups/db-${stamp}.sql.gz | sed -n 's/^-- Table structure for table \`\\(.*\\)\`$/\\1/p'`).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    const tables = query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'").sort();
    console.log(`dump ${stamp}: ${dumped.length} tables; the database has ${tables.length}`);
    assert.ok(tables.length > 10, `only ${tables.length} tables in the database`);
    assert.deepEqual(dumped, tables, 'the dump does not hold exactly the tables of the database');

    const archived = stack.exec('backup', ['tar', '-tzf', `/backups/uploads-${stamp}.tar.gz`]).stdout.split(/\r?\n/).filter(Boolean);
    console.log(`archive ${stamp}: ${archived.length} entries`);
    for (const entry of [`uploads/partners/${pubName}`, `private-media/evidence/${privName}`]) assert.ok(archived.includes(entry), `${entry} is not in the archive`);
  } finally {
    remove('api', planted);
  }
});

check('F-17: pruning deletes only expired sets, and only after a successful run', async () => {
  const days = Number(values.BACKUP_RETENTION_DAYS);
  assert.ok(days >= 1, 'BACKUP_RETENTION_DAYS');
  const now = Math.floor(Date.now() / 1000);
  const set = (stamp) => [`db-${stamp}.sql.gz`, `uploads-${stamp}.tar.gz`, `SHA256SUMS-${stamp}`];
  const old = set('19990101T000000Z');
  const recent = set('19990102T000000Z');
  const touch = stack.sh('backup', [
    `cd /backups && touch ${[...old, ...recent].join(' ')}`,
    `touch -d @${now - (days + 3) * 86400} ${old.join(' ')}`,
    `touch -d @${now - 2 * 86400} ${recent.join(' ')}`,
  ].join(' && '));
  assert.equal(touch.status, 0, touch.stderr);
  const list = () => stack.exec('backup', ['ls', '-1', '/backups']).stdout.split(/\s+/).filter(Boolean);
  const pause = () => new Promise((r) => setTimeout(r, 1100));
  try {
    await pause();
    const failed = stack.compose(['exec', '-T', '-e', 'DB_PASSWORD=wrong-ci-only-not-a-secret', 'backup', 'bash', '/opt/deploy/backup.sh', '--once']);
    const afterFailure = list();
    const checkAfterFailure = stack.exec('backup', ['bash', '/opt/deploy/backup.sh', '--check']).status;
    await pause();
    const ok = stack.exec('backup', ['bash', '/opt/deploy/backup.sh', '--once']);
    const afterSuccess = list();
    const checkAfterSuccess = stack.exec('backup', ['bash', '/opt/deploy/backup.sh', '--check']).status;
    const stamp = /run (\S+) written/.exec(ok.stdout)?.[1];
    console.log(`prune (retention ${days} days): failed run exit ${failed.status}, --check ${checkAfterFailure}; good run exit ${ok.status}, --check ${checkAfterSuccess}; ${/pruned \d+ file\(s\)[^\n]*/.exec(ok.stdout)?.[0]}`);
    assert.notEqual(failed.status, 0, 'a run with a wrong password succeeded');
    assert.deepEqual([...old, ...recent].filter((f) => !afterFailure.includes(f)), [], 'a failed run deleted files');
    assert.equal(checkAfterFailure, 1, '--check after a failed run');
    assert.equal(ok.status, 0, tail(ok.stdout + ok.stderr));
    assert.deepEqual(old.filter((f) => afterSuccess.includes(f)), [], 'expired files were kept');
    assert.deepEqual(recent.filter((f) => !afterSuccess.includes(f)), [], 'files inside the retention were deleted');
    assert.deepEqual(set(stamp).filter((f) => !afterSuccess.includes(f)), [], 'the new set is missing');
    assert.match(ok.stdout, new RegExp(`pruned ${old.length} file\\(s\\)`));
    assert.equal(checkAfterSuccess, 0, '--check after a good run');
  } finally {
    stack.sh('backup', `cd /backups && rm -f ${[...old, ...recent].join(' ')}`);
  }
});

// --------------------------------------------------------------------------- logs

check('F-45: every container rotates its log with the configured limits', () => {
  const all = stack.containers();
  console.log(`log rotation: ${all.length} containers checked (max-size ${values.LOG_MAX_SIZE}, max-file ${values.LOG_MAX_FILES})`);
  assert.ok(all.length >= 8, `only ${all.length} containers`);
  const wrong = all.filter((c) => {
    const log = c.HostConfig.LogConfig ?? {};
    return log.Type !== 'local' || log.Config?.['max-size'] !== values.LOG_MAX_SIZE || log.Config?.['max-file'] !== values.LOG_MAX_FILES;
  }).map((c) => `${c.Name.replace(/^\//, '')}: ${JSON.stringify(c.HostConfig.LogConfig)}`);
  assert.deepEqual(wrong, []);
});

check('F-45: the MySQL binary log keeps exactly the configured retention, not the MySQL default', () => {
  const [row] = query('SELECT @@log_bin, @@binlog_expire_logs_seconds');
  const [logBin, seconds] = row.split(/\s+/).map(Number);
  const days = values.MYSQL_BINLOG_RETENTION_DAYS;
  console.log(`binary log: log_bin ${logBin}, binlog_expire_logs_seconds ${seconds} (MYSQL_BINLOG_RETENTION_DAYS=${days})`);
  // Per value: with `off` MySQL keeps its unused default; with days the equality shows the
  // setting took effect (deploy/ci.env's value differs from MySQL's default: static.test.mjs).
  if (days === 'off') {
    assert.equal(logBin, 0, 'the binary log is on');
  } else {
    assert.equal(logBin, 1);
    assert.equal(seconds, Number(days) * 86400, 'the retention is not the configured one');
  }
});
