// Checks of the deploy runbook (deploy/README.md) against the files it describes: its sections,
// the first-start order that keeps the public edge down until an admin account exists, commands
// that never put a secret on a command line, the restore steps, the update steps, and the values it
// shares with the code. Most checks read files only; the service check renders the compose and the
// entrypoint check runs a script in the pinned busybox image (Docker, no network).
//
//   node --test deploy/test/runbook.test.mjs        (npm run test:deploy runs every deploy test)
//
// Every check prints how many things it examined and refuses to pass on zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMPOSE_FILE, DEPLOY_DIR, ENV_EXAMPLE, REPO_ROOT, RUNBOOK, dockerRun, parseEnvFile, readText,
  renderConfig, requiredSettings, serviceImage,
} from './lib.mjs';

/** The sections an operator needs, in this order (`## ` headings), and the restore subsection. */
const SECTIONS = [
  'What runs',
  'Prerequisites',
  'Cloudflare and the load balancer',
  'Settings',
  'First start',
  'The app build',
  'Updating',
  'Backups',
  'Logs',
  'Troubleshooting',
  'What CI checks',
  'Decisions this runbook does not make',
];
const RESTORE = 'Restore';

/** The blank that marks a decision nobody may guess. */
const BLANK = '______';

const runbook = () => readText(RUNBOOK).replace(/\r\n/g, '\n');
const repoText = (file) => readText(path.join(REPO_ROOT, file)).replace(/\r\n/g, '\n');

/** `## ` sections of a Markdown text: Map title -> body (until the next `## `). */
function sections(text, level = 2) {
  const marker = `${'#'.repeat(level)} `;
  const out = new Map();
  let title = null;
  let body = [];
  for (const line of text.split('\n')) {
    if (line.startsWith(marker)) {
      if (title !== null) out.set(title, body.join('\n'));
      title = line.slice(marker.length).trim();
      body = [];
    } else if (title !== null) {
      if (level === 2 || !line.startsWith('## ')) body.push(line);
      else { out.set(title, body.join('\n')); title = null; body = []; }
    }
  }
  if (title !== null) out.set(title, body.join('\n'));
  return out;
}

function section(name) {
  const body = sections(runbook()).get(name);
  assert.ok(body !== undefined, `deploy/README.md has no "## ${name}" section`);
  return body;
}

/**
 * The shell commands of a Markdown text, in order: the lines of its bash code blocks, with
 * continuation lines joined, comment lines dropped and trailing ` # ...` comments removed.
 * A line that opens a double-quoted string runs on until the string closes (a multi-line
 * `sh -c "..."`).
 */
function commands(text) {
  const out = [];
  const fence = /```bash\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) {
    let current = '';
    for (const raw of m[1].split('\n')) {
      const line = raw.trim();
      if (current === '' && (line === '' || line.startsWith('#'))) continue;
      const withoutComment = line.replace(/\s+#\s.*$/, '');
      current = current === '' ? withoutComment : `${current} ${withoutComment}`;
      const open = (current.replace(/'[^']*'/g, '').match(/"/g) ?? []).length % 2 === 1;
      if (current.endsWith('\\')) { current = current.slice(0, -1).trimEnd(); continue; }
      if (open) continue;
      out.push(current);
      current = '';
    }
    if (current !== '') out.push(current);
  }
  return out;
}

/** Splits a command line into words, keeping quoted parts together (quotes removed). */
function words(line) {
  const out = [];
  for (const m of line.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The `docker compose ...` invocations inside a command line (pipes, `$(...)`, `;`, `&&` split it). */
function composeCalls(line) {
  const calls = [];
  for (const m of line.matchAll(/docker compose ((?:'[^']*'|"(?:[^"\\]|\\.)*"|[^|;&)'"])*)/g)) {
    calls.push(words(m[1]));
  }
  return calls;
}

/** Global options before the subcommand that take a value. */
const GLOBAL_WITH_VALUE = new Set(['--profile', '-p', '--project-name', '-f', '--file', '--env-file', '--project-directory']);
/** Subcommand options that take a value. */
const WITH_VALUE = new Set(['-v', '--volume', '-e', '--env', '--tail', '--since', '--until', '--format', '-u', '--user', '-w', '--workdir', '--entrypoint', '--name', '-t', '--timeout']);
/** Subcommands whose every free word is a service, and those whose first free word is. */
const ALL_SERVICES = new Set(['up', 'ps', 'logs', 'stop', 'start', 'restart', 'build', 'pull', 'down', 'create', 'rm', 'kill']);
const FIRST_SERVICE = new Set(['run', 'exec']);

/** { sub, services } of one `docker compose` word list. */
function parseCompose(argv) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-')) i += GLOBAL_WITH_VALUE.has(argv[i]) ? 2 : 1;
  const sub = argv[i];
  const free = [];
  for (i += 1; i < argv.length; i += 1) {
    const w = argv[i];
    if (w.startsWith('-')) { if (WITH_VALUE.has(w)) i += 1; continue; }
    free.push(w);
    if (FIRST_SERVICE.has(sub)) break;
  }
  const services = ALL_SERVICES.has(sub) || FIRST_SERVICE.has(sub) ? free : [];
  return { sub, services };
}

/** The data rows of the first Markdown table in a text: arrays of trimmed cells. */
function tableRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) { if (rows.length > 0) break; continue; }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1);
}

/** The settings deploy/.env.example marks as a decision ("DECISION (who)" in their comment block). */
function decisionSettings() {
  const lines = readText(ENV_EXAMPLE).replace(/\r\n/g, '\n').split('\n');
  const decided = new Set();
  for (const entry of parseEnvFile(lines.join('\n'))) {
    let i = entry.line - 1;
    while (i > 0 && lines[i - 1].trim() !== '') i -= 1;
    if (/DECISION \([^)]+\)/.test(lines.slice(i, entry.line).join('\n'))) decided.add(entry.name);
  }
  return decided;
}

const composeText = () => readText(path.join(DEPLOY_DIR, COMPOSE_FILE));

/* ------------------------------------------------------------------------------ the tests */

test('runbook: deploy/README.md is a runbook with every section an operator needs, in order', () => {
  const titles = [...sections(runbook()).keys()];
  const missing = SECTIONS.filter((s) => !titles.includes(s));
  console.log(`runbook sections: ${SECTIONS.length} expected, ${titles.length} found`);
  assert.deepEqual(missing, [], `missing sections: ${missing.join(', ')}`);
  const order = SECTIONS.map((s) => titles.indexOf(s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `sections out of order: ${titles.join(' / ')}`);
  for (const s of SECTIONS) assert.ok(section(s).trim().length > 0, `section "${s}" is empty`);
  assert.ok(sections(section('Backups'), 3).has(RESTORE), 'the Backups section has no "### Restore"');
});

test('runbook: every pointer to a runbook section names one that exists', () => {
  const titles = new Set([...sections(runbook()).keys(), ...sections(runbook(), 3).keys()].map((t) => t.toLowerCase()));
  const folder = (name) => {
    const dir = path.join(REPO_ROOT, 'deploy', name);
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `deploy/${name}/${f}`) : [];
  };
  const files = [
    'deploy/docker-compose.yml', 'deploy/.env.example', 'deploy/Caddyfile', 'api/docker/entrypoint.sh',
    ...folder('scripts'), ...folder('mysql'),
  ].filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  const pointers = [];
  for (const file of files) {
    for (const m of repoText(file).matchAll(/deploy\/README\.md,\s*([A-Za-z][A-Za-z ]*?)\s*[).;]/g)) pointers.push({ file, name: m[1] });
  }
  console.log(`section pointers: ${pointers.length} in ${files.length} files`);
  assert.ok(pointers.length > 0, 'no pointer found: refusing to report clean');
  assert.deepEqual(pointers.filter((p) => !titles.has(p.name.toLowerCase())).map((p) => `${p.file}: "${p.name}"`), []);
});

test('runbook: the settings table names every required setting with what it is, who decides and its format', () => {
  const required = requiredSettings(composeText());
  assert.ok(required.length > 0, 'the compose requires no setting: refusing to report clean');
  const rows = tableRows(section('Settings'));
  const byName = new Map();
  for (const cells of rows) {
    const m = /^`([A-Z][A-Z0-9_]*)`$/.exec(cells[0] ?? '');
    if (m) byName.set(m[1], cells);
  }
  const decisions = decisionSettings();
  const problems = [];
  for (const name of required) {
    const cells = byName.get(name);
    if (!cells) { problems.push(`${name}: no row in the settings table`); continue; }
    const [, what = '', who = '', format = ''] = cells;
    if (!what || !who || !format) problems.push(`${name}: a cell is empty`);
    if (decisions.has(name) && !who.includes(BLANK)) problems.push(`${name}: a decision (deploy/.env.example) without the blank ${BLANK} in "who decides"`);
    if (!decisions.has(name) && !/^technical/.test(who)) problems.push(`${name}: neither a decision in deploy/.env.example nor marked technical`);
  }
  for (const name of byName.keys()) if (!required.includes(name)) problems.push(`${name}: in the table but not required by the compose`);
  const decisionTable = section('Decisions this runbook does not make');
  for (const name of required.filter((n) => decisions.has(n))) {
    if (!decisionTable.includes(`\`${name}\``)) problems.push(`${name}: a decision missing from "Decisions this runbook does not make"`);
  }
  console.log(`settings table: ${required.length} required settings, ${byName.size} rows, ${decisions.size} decisions in deploy/.env.example`);
  assert.deepEqual(problems, []);
});

test('runbook: every decision row is a visible blank with who decides', () => {
  const rows = tableRows(section('Decisions this runbook does not make'));
  assert.ok(rows.length > 0, 'no decision rows: refusing to report clean');
  const bad = rows.filter(([what, who, answer]) => !what || !who || answer !== `\`${BLANK}\``);
  console.log(`decision rows: ${rows.length}`);
  assert.deepEqual(bad.map((r) => r.join(' | ')), []);
});

/**
 * Who approves updates and the go-live, who merges, who owns the app's accounts and who holds admin
 * rights is not settled yet: the runbook leaves it to a role that is named before go-live, never
 * to a person or a role it guesses.
 */
const GOVERNANCE_ROLE = 'whoever is accountable for the app, to be named before go-live';
const GOVERNANCE = /approv|\bmerges?\b|\bowns\b|\badmins?\b/i;

test('runbook: who approves, merges, owns the app accounts or holds admin rights is left to a role named before go-live', () => {
  const rows = tableRows(section('Decisions this runbook does not make')).filter(([what]) => GOVERNANCE.test(what));
  // Blanks in the text: "<sentence>: `______` (<who>)", with wrapped (and indented) lines joined.
  const text = runbook().replace(/[ \t]*\n(?!\n)[ \t]*/g, ' ');
  const inline = [...text.matchAll(/([^.\n]*):\s+`______`\s+\(([^)]+)\)/g)].filter((m) => GOVERNANCE.test(m[1]));
  console.log(`governance blanks: ${rows.length} decision rows, ${inline.length} in the text`);
  assert.ok(rows.length > 0 && inline.length > 0, 'no governance blank found: refusing to report clean');
  const wrong = [
    ...rows.filter(([, who]) => who !== GOVERNANCE_ROLE).map(([what, who]) => `row "${what}": ${who}`),
    ...inline.filter((m) => m[2] !== GOVERNANCE_ROLE).map((m) => `"${m[1].trim()}": ${m[2]}`),
  ];
  assert.deepEqual(wrong, []);
  assert.ok(rows.some(([what]) => /how many admin/i.test(what) && /admin grant/i.test(what)), 'no blank for the number of admins and who approves an admin grant');
});

test('F-05: the first start keeps the public edge down until the admin account exists', () => {
  // Anywhere in the runbook: the admin's address and password never go into a file or the
  // environment of a long-running container.
  const all = commands(runbook());
  assert.deepEqual(all.filter((c) => /\bexport\s+ADMIN_|ADMIN_(EMAIL|PASSWORD)=[^"]|>>?\s*\.env|exec\s+node\s+npm\s+run\s+seed/.test(c)), [], 'ADMIN_* exported, written to a file, or the seed run inside the long-running node container');
  assert.ok(all.filter((c) => /read\b.*ADMIN_PASSWORD/.test(c)).every((c) => /\s-[a-z]*s/.test(c)), 'the admin password is read without -s (it would echo)');
  const cmds = commands(section('First start'));
  console.log(`first start: ${cmds.length} commands`);
  assert.ok(cmds.length > 0, 'no commands in "First start": refusing to report clean');
  const find = (re, what) => {
    const i = cmds.findIndex((c) => re.test(c));
    assert.ok(i >= 0, `"First start" has no command that ${what}`);
    return i;
  };
  const preflight = find(/(^|\s)scripts\/preflight\.sh(\s|$)/, 'runs scripts/preflight.sh');
  const build = find(/^docker compose (--profile tools )?build --pull\b/, 'builds with --pull');
  const ups = cmds.map((c, i) => ({ i, call: composeCalls(c).map(parseCompose).find((p) => p.sub === 'up') })).filter((u) => u.call);
  const partial = ups.find((u) => u.call.services.length > 0);
  assert.ok(partial, '"First start" has no `docker compose up -d <services>` without caddy');
  assert.ok(!partial.call.services.includes('caddy'), `the first up starts caddy: ${cmds[partial.i]}`);
  for (const s of ['db', 'api', 'scheduler']) assert.ok(partial.call.services.includes(s), `the first up does not start ${s}`);
  const seed = find(/^ADMIN_EMAIL="\$ADMIN_EMAIL" ADMIN_PASSWORD="\$ADMIN_PASSWORD" docker compose run --rm seed$/, 'creates the admin with the one-off seed service, ADMIN_* set for that command only');
  const gate = find(/^docker compose run --rm admin-gate$/, 'checks that an admin exists');
  const full = ups.find((u) => u.call.services.length === 0);
  assert.ok(full, '"First start" has no plain `docker compose up -d`');
  const health = find(/^curl -sSI https:\/\/<DOMAIN>\/api\/health$/, 'checks https://<DOMAIN>/api/health');
  const unset = find(/^unset ADMIN_EMAIL ADMIN_PASSWORD$/, 'unsets ADMIN_EMAIL and ADMIN_PASSWORD');
  const order = { preflight, build, 'first up': partial.i, seed, unset, 'admin check': gate, 'full up': full.i, health };
  const sorted = Object.entries(order).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  assert.deepEqual(sorted, Object.keys(order), 'the first-start steps are out of order');
  // Before the seed, nothing may start caddy: every earlier up names its services, without caddy.
  for (const u of ups.filter((x) => x.i < seed)) assert.ok(u.call.services.length > 0 && !u.call.services.includes('caddy'), `starts caddy before the admin exists: ${cmds[u.i]}`);
});

test('F-18: no runbook command puts a password on a command line or prints a secret', () => {
  const cmds = commands(runbook());
  console.log(`secret check: ${cmds.length} commands`);
  assert.ok(cmds.length > 0, 'no commands: refusing to report clean');
  const rules = [
    [/(^|\s)-p["'$]|--password\b/, 'a password option on the command line'],
    [/\bmysql(dump)?\b[^|]*\s-p\S/, 'mysql or mysqldump with -p<password>'],
    [/\b(echo|printf)\b[^|]*\$\{?[A-Z_]*(PASSWORD|SECRET|KEY)\b/, 'prints a secret variable'],
    [/\bcat\s+(\S*\/)?\.env\b|\bprintenv\b|\bdocker compose\b[^|]*\bconfig\b(?![^|]*--(quiet|services))/, 'prints the settings'],
    [/\bdocker\s+(compose\s+)?inspect\b/, 'docker inspect shows a container environment'],
  ];
  const problems = [];
  for (const c of cmds) for (const [re, why] of rules) if (re.test(c)) problems.push(`${why}: ${c}`);
  // MYSQL_PWD only inside a single-quoted `sh -c '...'`, so the root password is read inside the
  // db container and never reaches a command line on the host.
  for (const c of cmds.filter((x) => x.includes('MYSQL_PWD'))) {
    if (!/sh -c '[^']*MYSQL_PWD="\$MYSQL_ROOT_PASSWORD"[^']*'/.test(c)) problems.push(`MYSQL_PWD outside the db container's shell: ${c}`);
  }
  assert.deepEqual(problems, []);
});

test('F-17: backups go outside the clone, and the restore is spelled out step by step', () => {
  const all = commands(runbook());
  assert.deepEqual(all.filter((c) => /\bmysqldump\b|\s>>?\s*\S*(backup|\.sql)/.test(c)), [], 'a command writes a dump itself (the backup service does that, outside the clone)');
  const backups = section('Backups');
  const restore = sections(backups, 3).get(RESTORE) ?? '';
  assert.ok(backups.includes('`BACKUP_DIR`'), 'the Backups section does not name BACKUP_DIR');
  const cmds = commands(restore);
  console.log(`restore: ${cmds.length} commands`);
  const steps = [
    [/sha256sum -c/, 'checks the set'],
    // Every service that writes the database or the volumes: api, the scheduler (its jobs and the
    // retention prune) and the backup.
    [/^docker compose stop\b(?=.*\bapi\b)(?=.*\bscheduler\b)(?=.*\bbackup\b)/, 'stops api, the scheduler and backup'],
    // Without pipefail a gunzip that fails hands mysql an empty input, and the load reports success.
    [/^set -o pipefail$/, 'makes a failing gunzip fail the load (pipefail)'],
    [/^gunzip -c "<SET_DIR>\/db-\$stamp\.sql\.gz" \| docker compose exec -T db /, 'loads the dump into db'],
    [/^docker compose run --rm --no-deps -v "<SET_DIR>:\/backups:ro" storage-init sh -c .*tar -xzf .*uploads.*private-media.*chown -R 33:33/, 'unpacks both upload volumes and gives them back to uid 33 (www-data)'],
    [/^docker compose up -d$/, 'starts everything again'],
  ];
  let last = -1;
  for (const [re, what] of steps) {
    const i = cmds.findIndex((c, j) => j > last && re.test(c));
    assert.ok(i > last, `the restore has no step that ${what} (after the previous step)`);
    last = i;
  }
});

test('F-17: the steps on the root-owned backup files run as root; a docker-group user is offered only the docker compose commands', () => {
  // <BACKUP_DIR> is root's with mode 700 and the sets are mode 600 (deploy/scripts/preflight.sh,
  // backup.sh): install, ls, sha256sum and gunzip on them need root.
  const host = commands(runbook()).filter((c) => /<(BACKUP_DIR|SET_DIR)>/.test(c) && !/^docker\b/.test(c));
  console.log(`host commands on <BACKUP_DIR> or <SET_DIR>: ${host.length}`);
  assert.ok(host.length > 0, 'no host command on the backups found: refusing to report clean');
  const intro = runbook().split('\n## ')[0].replace(/\n/g, ' ');
  assert.match(intro, /Commands run [^.]*\bas root\b/, 'the runbook does not say that its commands run as root');
  const offers = intro.split(/(?<=\.)\s+/).filter((s) => /`docker`/.test(s) && /\b(user|group|member)\b/.test(s));
  assert.deepEqual(offers.filter((s) => !/\bonly the `docker compose` commands\b/.test(s)), [], 'a user of the docker group is offered steps that need root');
});

test('F-25: updating rebuilds from fresh base images and says how to refresh a pin', () => {
  assert.ok(!/up -d --build|git pull &&/.test(runbook()), 'the old update command (no --pull) is still there');
  const updating = section('Updating');
  const cmds = commands(updating);
  console.log(`updating: ${cmds.length} commands`);
  const steps = [/^git pull --ff-only$/, /(^|\s)scripts\/preflight\.sh$/, /^docker compose (--profile tools )?build --pull$/, /^docker compose up -d$/];
  let last = -1;
  for (const re of steps) {
    const i = cmds.findIndex((c, j) => j > last && re.test(c));
    assert.ok(i > last, `"Updating" has no ${re} after the previous step`);
    last = i;
  }
  assert.ok(cmds.some((c) => /build --pull --no-cache/.test(c)), 'no rebuild without cache');
  assert.ok(cmds.some((c) => /^docker buildx imagetools inspect \S+:\S+/.test(c)), 'no command that resolves a new digest');
});

test('runbook: every service a command names exists in the production compose', () => {
  const services = new Set(Object.keys(renderConfig({ profiles: ['tools'] }).services));
  const refs = [];
  for (const c of commands(runbook())) {
    for (const call of composeCalls(c).map(parseCompose)) for (const s of call.services) refs.push({ s, c });
  }
  console.log(`service references: ${refs.length} (compose services: ${services.size})`);
  assert.ok(refs.length > 0, 'no service named in a command: refusing to report clean');
  assert.deepEqual(refs.filter((r) => !services.has(r.s)).map((r) => `${r.s}: ${r.c}`), []);
});

test('runbook: every repository path it names exists', () => {
  const text = runbook();
  const top = new Set(fs.readdirSync(REPO_ROOT));
  const found = new Set();
  for (const m of text.matchAll(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]*)`/g)) {
    if (top.has(m[1].split('/')[0]) || m[1].startsWith('scripts/')) found.add(m[1].replace(/\/$/, ''));
  }
  for (const m of text.matchAll(/\]\((\.\.\/[^)#\s]+)(#[^)]*)?\)/g)) found.add(path.posix.join('deploy', m[1]));
  for (const c of commands(text)) for (const m of c.matchAll(/(?:^|\s)(scripts\/[\w./-]+\.sh)/g)) found.add(m[1]);
  // Not in a clone: the operator's settings file, and the old upload folders, named only to move
  // them away.
  const notInClone = new Set(['deploy/.env', 'deploy/storage', 'deploy/storage-private']);
  const missing = [...found].filter((p) => !notInClone.has(p)).filter((p) => {
    const atRoot = path.join(REPO_ROOT, p);
    const inDeploy = path.join(REPO_ROOT, 'deploy', p);
    return !fs.existsSync(atRoot) && !fs.existsSync(inDeploy);
  });
  console.log(`paths named: ${found.size}`);
  assert.ok(found.size > 0, 'no path found: refusing to report clean');
  assert.deepEqual(missing, []);
});

test('runbook: values it shares with the code agree', () => {
  const text = runbook();
  const APP_KEY_COMMAND = /(echo "base64:\$\(openssl rand -base64 \d+\)")/;
  // [what, the file that holds the value, its pattern there, its pattern in the runbook]
  const mirrors = [
    ['backup time (RUN_AT_UTC)', path.join(REPO_ROOT, 'deploy', 'scripts', 'backup.sh'), /RUN_AT_UTC='(\d\d:\d\d)'/, /(\d\d:\d\d) UTC/g],
    ['Node 22 end of security support', path.join(REPO_ROOT, 'server', 'Dockerfile'), /until (\d{4}-\d\d-\d\d)/, /Node 22 gets security fixes until (\d{4}-\d\d-\d\d)/g],
    ['APP_KEY command', ENV_EXAMPLE, new RegExp(String.raw`^#\s+${APP_KEY_COMMAND.source}$`, 'm'), new RegExp(`\`${APP_KEY_COMMAND.source}\``, 'g')],
    ['APP_KEY command', path.join(REPO_ROOT, 'api', 'docker', 'entrypoint.sh'), new RegExp(String.raw`echo '\s*${APP_KEY_COMMAND.source}'`), new RegExp(`\`${APP_KEY_COMMAND.source}\``, 'g')],
    ['Compose version for !reset', path.join(DEPLOY_DIR, 'docker-compose.ci.yml'), /!reset needs Compose >= (\d+\.\d+\.\d+)/, /Docker Compose v(\d+\.\d+\.\d+) or newer/g],
    ['multipart body limit', path.join(DEPLOY_DIR, 'Caddyfile'), /@multipart \{\s*max_size (\d+)MB/, /(\d+) MB for uploads/g],
    ['other body limit', path.join(DEPLOY_DIR, 'Caddyfile'), /@not_multipart \{\s*max_size (\d+)KiB/, /(\d+) KiB for everything else/g],
    ['upload cache lifetime', path.join(DEPLOY_DIR, 'Caddyfile'), />Cache-Control "public, max-age=(\d+)"/, /`Cache-Control: public, max-age=(\d+)`/g],
  ];
  const problems = [];
  for (const [what, file, inCode, inRunbook] of mirrors) {
    const where = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const code = fs.existsSync(file) ? inCode.exec(readText(file).replace(/\r\n/g, '\n'))?.[1] : undefined;
    const said = [...text.matchAll(inRunbook)].map((m) => m[1]);
    if (code === undefined) problems.push(`${what}: no value in ${where}`);
    if (said.length === 0) problems.push(`${what}: not in deploy/README.md`);
    for (const v of said) if (code !== undefined && v !== code) problems.push(`${what}: deploy/README.md says ${v}, ${where} says ${code}`);
  }
  console.log(`shared values: ${mirrors.length}`);
  assert.deepEqual(problems, []);
});

test("runbook: the edge's TLS files and the uploads' cache lifetime are the ones the Caddyfile and the preflight use", () => {
  const caddyfile = readText(path.join(DEPLOY_DIR, 'Caddyfile')).replace(/\r\n/g, '\n');
  const files = [...new Set([...caddyfile.matchAll(/\/etc\/caddy\/origin\/([\w.-]+)/g)].map((m) => m[1]))].sort();
  console.log(`TLS files in deploy/Caddyfile: ${files.join(', ') || 'none'}`);
  assert.ok(files.length > 0, 'no TLS file in deploy/Caddyfile: refusing to report clean');
  const text = runbook();
  const preflight = readText(path.join(DEPLOY_DIR, 'scripts', 'preflight.sh'));
  const origin = sections(text, 3).get('Origin certificate and Authenticated Origin Pulls') ?? '';
  assert.ok(origin, 'deploy/README.md has no "### Origin certificate and Authenticated Origin Pulls"');
  const problems = [];
  for (const f of files) {
    if (!origin.includes(`\`<ORIGIN_TLS_DIR>/${f}\``)) problems.push(`${f}: not in the runbook's table of the TLS files`);
    if (!preflight.includes(`/${f}`)) problems.push(`${f}: not checked by deploy/scripts/preflight.sh`);
  }
  // The compose mounts the folder where the Caddyfile reads it.
  if (!/target: \/etc\/caddy\/origin\r?$/m.test(composeText())) problems.push('the compose does not mount ORIGIN_TLS_DIR at /etc/caddy/origin');
  // The runbook says how long Cloudflare may keep an upload, in minutes.
  const seconds = Number(/>Cache-Control "public, max-age=(\d+)"/.exec(caddyfile)?.[1]);
  const words = { 1: 'one', 2: 'two', 5: 'five', 10: 'ten', 15: 'fifteen', 30: 'thirty', 60: 'sixty' };
  const minutes = words[seconds / 60];
  if (!minutes) problems.push(`the upload cache lifetime (${seconds} s) is not a number of minutes the runbook can say`);
  else if (!new RegExp(`within ${minutes} minutes`).test(text.replace(/\s+/g, ' '))) problems.push(`the runbook does not say "within ${minutes} minutes"`);
  assert.deepEqual(problems, []);
});

test('runbook: no stale or guessed facts', () => {
  const text = runbook();
  const rules = [
    [/exec node npm run seed/, 'seeds inside the long-running node container'],
    [/up -d --build/, 'starts everything, caddy included, in one go'],
    [/\bapi:80\b|8080:80/, 'api on port 80'],
    [/-p"\$MYSQL_ROOT_PASSWORD"/, 'the root password on a command line'],
    [/€|\bEUR\b|\/Monat|per month|Hetzner|Brevo/i, 'a vendor or a price'],
    [/goenntertainment\.de/, 'a guessed domain'],
    [/github\.com\/[A-Za-z0-9-]+\//, "a clone URL with someone's account"],
    [/\bSchritt \d/, 'the old step numbers'],
  ];
  const problems = rules.filter(([re]) => re.test(text)).map(([re, why]) => `${why}: ${re}`);
  // The old upload folders appear only where the runbook moves them into the volumes.
  const updating = sections(text).get('Updating') ?? '';
  const move = updating.indexOf('**Moving from the old upload folders**');
  const outside = text.replace(move >= 0 ? updating.slice(move) : '', '');
  if (/deploy\/storage/.test(outside)) problems.push('deploy/storage outside "Moving from the old upload folders"');
  console.log(`stale-fact rules: ${rules.length + 1}`);
  assert.deepEqual(problems, []);
});

test('runbook: the volume names it gives are the ones docker compose uses', () => {
  // A top-level `name:` names the project; without one, docker compose takes the folder's name.
  const project = /^name:\s*['"]?([^\s'"]+)/m.exec(composeText())?.[1] ?? path.basename(DEPLOY_DIR);
  const said = [...runbook().matchAll(/named `([a-z0-9_-]+)_<name>`/g)].map((m) => m[1]);
  console.log(`volume prefix: the compose gives ${project}, the runbook names ${said.join(', ') || 'none'}`);
  assert.ok(said.length > 0, 'the runbook does not say how the volumes are named');
  assert.deepEqual([...new Set(said)], [project]);
});

test('F-45: the runbook creates the binary-log rotation on a database volume older than it, from the file the db service mounts', () => {
  const db = renderConfig({ profiles: ['tools'] }).services.db;
  const rotate = (db.volumes ?? []).find((v) => v.type === 'bind' && /binlog-rotate\.sql$/.test(v.target));
  assert.ok(rotate, 'the db service mounts no binary-log rotation');
  const logs = commands(section('Logs'));
  const create = logs.filter((c) => c.includes(`< ${rotate.target}`));
  console.log(`Logs: ${logs.length} commands, ${create.length} load ${rotate.target}`);
  assert.equal(create.length, 1, 'the Logs section has no command that creates the rotation in an existing database');
  assert.match(create[0], /^docker compose exec -T db sh -c 'MYSQL_PWD="\$MYSQL_ROOT_PASSWORD" mysql -uroot < \S+'$/);
  assert.ok(logs.some((c) => /@@event_scheduler/.test(c) && /information_schema\.EVENTS/.test(c)), 'no command shows the scheduler and the event');
});

test('api entrypoint: an empty APP_KEY prints the runbook\'s openssl command, not a compose command that cannot run', () => {
  const code = repoText('api/docker/entrypoint.sh').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/key:generate/.test(code), 'api/docker/entrypoint.sh still points at key:generate');
  const r = dockerRun(serviceImage('storage-init'), {
    mounts: [{ src: path.join(REPO_ROOT, 'api', 'docker', 'entrypoint.sh'), dst: '/opt/goenn-entrypoint.sh' }],
    entrypoint: 'sh',
    args: ['-c', 'mkdir -p /var/www/api && APP_KEY= sh /opt/goenn-entrypoint.sh echo started'],
  });
  console.log('entrypoint: 1 run with an empty APP_KEY');
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!r.stdout.includes('started'), 'the command ran although APP_KEY is empty');
  assert.ok(r.stderr.includes('echo "base64:$(openssl rand -base64 32)"'), `no openssl command in:\n${r.stderr}`);
  assert.ok(!/docker compose/.test(r.stderr), `the hint names a docker compose command:\n${r.stderr}`);
});
