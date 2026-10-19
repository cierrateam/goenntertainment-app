# GÖ4Fun

The app for going out in Göttingen together: offers from local partners booked at group prices,
one stamp card across all partners, and credits that pay everywhere. An [Expo](https://expo.dev)
app (`src/`) on a Laravel API (`api/`); production runs with Docker (`deploy/`).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the backend (required — the app loads offers, bookings and the account from it)

   The app talks to Laravel in [`api/`](api/) on port `8000`, which answers every route. The
   former Node backend in [`server/`](server/) is no longer needed by the app (its code and
   tests stay in the repository). Laravel does not start automatically; run it in its own
   terminal (on Windows, `scripts/dev-up.ps1` starts it together with Metro):

   ```bash
   php api/artisan serve --host=0.0.0.0 --port=8000
   ```

   First-time setup:
   - `api/.env` from `api/.env.example`, then `php api/artisan key:generate`; set
     `DB_CONNECTION=mysql` and the database settings of the MySQL database `goenntertainment`.
   - Database: `php api/artisan migrate` builds the tables and the category list (on a
     database created from `server/schema.sql` earlier, it adds only what is missing).
   - An admin account: sign up in the app, then `php api/artisan admin:grant <address>`.

3. Start the app (in a second terminal)

   ```bash
   npx expo start
   ```

If the app shows "Keine Verbindung zum Server", Laravel from step 2 is not running, or the
phone cannot reach it: the app takes the address from `EXPO_PUBLIC_API_URL` in `.env.local`
(template: [`.env.example`](.env.example), see [`src/constants/config.ts`](src/constants/config.ts)).

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

The screens live in [`src/app`](src/app) and use [file-based routing](https://docs.expo.dev/router/introduction).

### Mail in development

Laravel (`api/`) sends 2FA codes, password reset codes, the codes that confirm a new e-mail
address or a first password, and other mail. A server sends it through Microsoft Graph or over
SMTP ([`deploy/README.md`](deploy/README.md#settings), `MAIL_MAILER`). In
development a local mail catcher, [Mailpit](https://github.com/axllent/mailpit),
receives every mail, so no code is ever written to a log:

```bash
docker compose -f dev/docker-compose.yml up -d
```

The inbox is at http://127.0.0.1:8025 (SMTP on 127.0.0.1:1025, both reachable only
from this PC). `api/.env.example` already points there. An older `api/.env` that
still uses the log mailer must take the `MAIL_*` lines from `api/.env.example`, and
an old `api/storage/logs/laravel.log` should be deleted: it can contain codes. Mails
with a code refuse the log mailer ([`api/app/Support/CodeMail.php`](api/app/Support/CodeMail.php)):
when `MAIL_MAILER` names it, or names a failover chain that contains it, they are not sent at
all.

Without Docker, the Mailpit binary does the same: download it from the
[Mailpit releases](https://github.com/axllent/mailpit/releases) and run
`mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025`.

## Tests and checks

This is the one list of test suites and checks. CI runs all of them on every pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml); the two deploy rows in
[`.github/workflows/docker.yml`](.github/workflows/docker.yml)); run them locally before you commit.
Every test file belongs to exactly one of these globs; a new suite or glob is added here and in
CI together.

| Suite or check | Test files | Command (from the repository root) | Needs |
|---|---|---|---|
| Client unit tests | `src/domain/*.test.ts` | `npm test` | Node >= 22.18 (runs the `.ts` files directly) |
| Typecheck | all `*.ts`/`*.tsx` in `tsconfig.json` | `npx tsc --noEmit` | `expo-env.d.ts` (see below) |
| Lint | `src/`, `app/`, `components/` (expo lint's default inputs; tooling under `scripts/` is not linted) | `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run lint` | |
| Expo SDK versions | | `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npx expo install --check` | |
| Server tests | `server/test/*.test.js` | `npm --prefix server test` (loads the test-only `server/test/test.env` and runs the files one at a time: they share one database, and in parallel one file's cleanup could deadlock with another file's writes and load could break time bounds; one file: `node --env-file=test/test.env --test test/<file>.test.js` in `server/`) | MySQL 8.4 with `server/schema.sql` loaded; `DB_*` in `server/.env` |
| `composer.lock` matches `composer.json` | | `cd api && composer validate --no-check-publish --strict` | PHP 8.4, Composer 2 |
| API tests | `api/tests/Unit/**/*Test.php`, `api/tests/Feature/**/*Test.php` | `cd api && php artisan test` (see [API tests and MySQL](#api-tests-and-mysql)) | PHP 8.4 with `pdo_mysql`, `composer install`, `api/.env` with a key; MySQL 8.4 with `server/schema.sql` loaded and `DB_CONNECTION=mysql` plus `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` in the environment |
| CI tooling tests | `scripts/ci/*.test.mjs` | `npm run test:tooling` | |
| Repository guardrails | | `node scripts/ci/check-repo.mjs` | |
| Schema drift tool tests | `scripts/schema-drift/*.test.mjs` | `node --test "scripts/schema-drift/*.test.mjs"` | Node >= 22.18, `npm --prefix server ci` |
| Schema drift check | | `node scripts/schema-drift/check.mjs` | Node >= 22.18, `npm --prefix server ci`, MySQL 8.4 and an account that may create databases (`SCHEMA_DRIFT_DB_HOST`, `_PORT`, `_USER`, `_PASSWORD`), PHP with `pdo_mysql`, `composer install` in `api/` |
| Workflow policy | | `node scripts/ci/check-workflows.mjs .github/workflows --ci-env deploy/ci.env` | |
| Values written in several places (CI and Dockerfile versions, the internal secret rules, the request body limits) | | `node scripts/ci/check-mirrors.mjs` | |
| Workflow lint | | actionlint, see [`.github/actionlint/Dockerfile`](.github/actionlint/Dockerfile) | Docker |
| Dependency audit | | `node scripts/ci/audit.mjs npm .`, `… npm server`, `… composer api` | network (registry); blocking (advisories fixed or listed in `.github/audit-allowlist.json`) |
| Deploy static checks | `deploy/test/*.test.mjs` except `stack.test.mjs` | `npm run test:deploy` (the compose files as Compose renders them with [`deploy/ci.env`](deploy/ci.env), the Caddyfile as Caddy adapts it, the scripts and the Dockerfiles; starts no stack) | Docker: the CLI and the pinned `mysql` and `caddy` images |
| Deploy stack test | `deploy/test/stack.test.mjs` | `COMPOSE_PROJECT_NAME=<a name of its own> npm run test:deploy:stack` (PowerShell: set `$env:COMPOSE_PROJECT_NAME` first). It builds the images, starts the whole stack with `deploy/docker-compose.ci.yml` and `deploy/ci.env` on internal networks, checks it through Caddy from a probe container, and removes it with its volumes and built images | Docker with Compose >= 2.24.4; registry access for the image builds; the subnet of `APP_NET_PREFIX` (`deploy/ci.env`) free on this host |

One-time setup per clone:

```bash
npm ci
npm --prefix server ci
(cd api && composer install && cp .env.example .env && php artisan key:generate)
# Generates the git-ignored expo-env.d.ts (and the typed-route declarations) for tsc:
EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npx expo customize tsconfig.json
```

The Expo CLI always runs with `EXPO_NO_TELEMETRY=1` and `EXPO_OFFLINE=1`, so it sends nothing
to Expo. In PowerShell set them first: `$env:EXPO_NO_TELEMETRY=1; $env:EXPO_OFFLINE=1`.

### API tests and MySQL

The app's tables exist only in `server/schema.sql`, so the API feature tests that use the
database (they extend `api/tests/AppFeatureTestCase.php`) run against MySQL 8.4 loaded from that
file, each test inside a transaction that is rolled back. Give the connection as environment
variables, as below; they win over `api/.env` and `api/phpunit.xml`. Without them those tests
fail with a message that says what is missing (they are never skipped). The unit tests need no
database (`php artisan test --testsuite=Unit`). A throw-away MySQL in Docker (the password is a
local-only value, not a secret):

```bash
docker run -d --rm --name goenn-api-tests -p 127.0.0.1:3307:3306 --tmpfs /var/lib/mysql \
  -e MYSQL_DATABASE=goenntertainment -e MYSQL_USER=goenn \
  -e MYSQL_PASSWORD=local-only-not-a-secret -e MYSQL_ROOT_PASSWORD=local-only-not-a-secret-root \
  mysql:8.4
# When `docker logs goenn-api-tests` says "ready for connections" (port 3306), load the schema:
docker exec -i -e MYSQL_PWD=local-only-not-a-secret goenn-api-tests mysql -u goenn goenntertainment < server/schema.sql
(cd api && DB_CONNECTION=mysql DB_HOST=127.0.0.1 DB_PORT=3307 DB_DATABASE=goenntertainment \
  DB_USERNAME=goenn DB_PASSWORD=local-only-not-a-secret php artisan test)
docker stop goenn-api-tests   # removes the container and its data
```

Point the tests at a database of their own, not at a development database.
`api/tests/Probes/` is not a suite: tests of `AppFeatureTestCase` run the probe there in a
child PHPUnit process. One class runs outside the rolled-back transaction:
`api/tests/Feature/ConcurrentCapsTest.php` starts ten `php -S` processes on free local ports
(`api/tests/Support/ParallelServers.php`) and sends them bursts of requests, to show that the
per-account caps hold for requests that arrive at the same time. Those processes must see its
accounts, so it writes committed rows and deletes them again afterwards; its cache rows carry a
prefix of their own.

## Further reading

- [Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/) – the version this app is
  built on ([`AGENTS.md`](AGENTS.md)).
- [`api/README.md`](api/README.md) – the Laravel API; [`deploy/README.md`](deploy/README.md) – the
  production setup.
