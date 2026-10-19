# Deploy runbook: the GÖ4Fun backend on one Linux server

This is the one supported way to run the backend in production: Caddy in front, Laravel (`api/`)
behind it with its scheduler, and MySQL, all as containers started by
`deploy/docker-compose.yml`. The app reaches it under one fixed `https://` address. Laravel answers
every route itself and builds the database schema with its migrations; the Node backend
(`server/`) is no longer part of the production stack.

The runbook is written for the operator: whoever runs the server. Every decision it does not make
is a visible blank, `______`, with who decides it; the last section lists them all. Commands run
on the server, in the `deploy/` folder of the clone, as root (for example after `sudo -i`):
`<BACKUP_DIR>` and the backup files belong to root with modes 700 and 600, and the steps that
create, list, check or read them need root. A member of the `docker` group (root-equivalent
anyway) can run only the `docker compose` commands. `<DOMAIN>`, `<BACKUP_DIR>` and similar are
placeholders for the values in `deploy/.env`.

Contents: [What runs](#what-runs) · [Prerequisites](#prerequisites) · [Settings](#settings) ·
[First start](#first-start) · [The app build](#the-app-build) · [Updating](#updating) ·
[Backups](#backups) · [Logs](#logs) · [Troubleshooting](#troubleshooting) ·
[What CI checks](#what-ci-checks) · [Decisions this runbook does not make](#decisions-this-runbook-does-not-make)

## What runs

```
Internet ─► caddy :80/:443   HTTPS, security headers, the upload allow-list
              ├─► media :8080  public uploads (read-only files; holds no secrets)
              └─► api :8080    Laravel: the whole API, the uploads, the schema (migrations)
            scheduler        Laravel's schedule: club renewals, credits, the retention prune
            db    MySQL 8.4 ◄── api, the scheduler, and the backup, admin-gate and seed services
```

| Service | Image | What it does | Networks | Volumes | Lifetime |
|---|---|---|---|---|---|
| `caddy` | `caddy:2-alpine` (pinned) | the only service with host ports; gets and renews the certificate for `<DOMAIN>`; sends the security headers; passes the allowed upload paths to `media` and everything else to `api` | edge, media | `caddy-data`, `caddy-config`, `deploy/Caddyfile` | long-running; starts only after `admin-gate` succeeded and `api` is healthy |
| `media` | `caddy:2-alpine` (pinned) | serves the public uploads as plain files, for caddy only (`deploy/Caddyfile.media`); runs as `nobody`, read-only, without settings or keys | media | `uploads` (read-only), `deploy/Caddyfile.media` | long-running |
| `api` | built from `api/Dockerfile` | Laravel on port 8080 as the user `www-data` (uid 33); runs the migrations before Apache starts; answers every route; stores the uploads, checked and re-encoded, in two volumes outside its docroot; sends mail through Microsoft Graph or over SMTP (`MAIL_MAILER`) | edge, app | `uploads`, `private-media` | long-running |
| `scheduler` | built from `api/Dockerfile` | `php artisan schedule:work` (`api/routes/console.php`): club renewals every hour, credit expiry every five minutes, the credit reminder mails every day, the retention prune every hour; no Apache | app, outbound | `private-media` | long-running; starts once `api` is healthy |
| `db` | `mysql:8.4` (pinned) | the database `goenntertainment`; on the very first start (empty volume) it creates the daily rotation of its binary log (`deploy/mysql/02-binlog-rotate.sql`); the tables come from api's migrations | app, data | `db-data` | long-running |
| `backup` | `mysql:8.4` (pinned) | a database dump and an uploads archive every night at 02:30 UTC and once at start, then pruning (`deploy/scripts/backup.sh`) | data | `uploads` and `private-media` (read-only; the evidence images, mode 640, through the `www-data` group), `<BACKUP_DIR>` (host folder) | long-running |
| `storage-init` | `busybox:1.37` (pinned) | creates the upload folders and gives them to uid 33 (`www-data`) | none | `uploads`, `private-media` | one-shot on every `up` |
| `admin-gate` | `mysql:8.4` (pinned) | refuses to let `caddy` start while no admin account exists (`deploy/scripts/admin-gate.sh`) | data | none | one-shot on every `up` |
| `seed` | built from `api/Dockerfile` | creates the first admin account (`php artisan admin:create`); never started by `docker compose up` (profile `tools`) | data | none | one-off, `docker compose run --rm seed` |

Keep exactly one `scheduler` container (no `--scale scheduler=…`, no replicas): every scheduler
runs every job that is due, and the locks only keep two runs of one job from overlapping.

Networks (the compose file's footer has the details):

| Network | Who is on it | Way out |
|---|---|---|
| edge | caddy (fixed address `<APP_NET_PREFIX>.10`), api | yes: certificates for caddy, mail for api (Microsoft Graph or SMTP) |
| media | caddy, media | none (internal) |
| app | api, scheduler, db | none (internal) |
| data | db, backup, admin-gate, seed | none (internal) |
| outbound | scheduler | yes: mail for the credit reminders (Microsoft Graph or SMTP) |

caddy reaches neither the scheduler nor db, and db has no way out. Laravel trusts the client
address only from caddy's fixed address (F-31).

Why the uploads have a file server of their own: Caddy follows symbolic links, and it has no
setting to refuse them. A link planted in the `uploads` volume under an allowed name would make
the server that reads the volume hand out whatever the link points to. caddy holds the
certificate and account keys (`caddy-data`), so it mounts no volume that another service writes;
`media` has nothing to hand out but the uploads themselves. Apache in the api container never
serves an upload: the volumes are mounted outside its docroot and outside `/var/www`, and its
settings refuse requests there (`api/docker/apache.conf`).

Volumes (named `deploy_<name>` on the server, after the compose file's folder; `docker volume ls`):

| Volume | Holds | Notes |
|---|---|---|
| `db-data` | the database, including MySQL's binary log | the one part nothing else can rebuild |
| `uploads` | public images: avatars, partner logos and covers, offer images | api writes, media serves read-only (behind caddy) |
| `private-media` | ban and timeout evidence | api writes it and hands it to admins only, through a checked route; the scheduler's prune removes old images; the backup reads it; never mounted into a file server |
| `caddy-data` | certificates and caddy's ACME account | lost: caddy requests new certificates, which the certificate authority rate-limits |
| `caddy-config` | caddy's own saved configuration | |

Only caddy publishes ports: `0.0.0.0:80` and `0.0.0.0:443`, IPv4 only. MySQL and Laravel have no
host port. No network has IPv6: published on IPv6 as well, Docker would relay every IPv6 client
with the network's gateway as its address, and all IPv6 clients would share one address in the
rate limits. So the domain gets an A record and **no AAAA record** until IPv6 is set up end to end
(`______`, the operator). Checks on the server, once caddy runs (written for a Linux host with
Docker's default port publishing; not yet run on a real host):

```bash
ss -ltnp '( sport = :443 )'          # a listener on 0.0.0.0:443, none on [::]:443
dig +short AAAA <DOMAIN>             # prints nothing
curl -4 -sSI https://<DOMAIN>/api/health
docker compose logs caddy --tail 5   # "remote_ip": real client addresses, not <APP_NET_PREFIX>.1 (the edge gateway)
```

The mobile app is not a container: it is built with EAS and carries the server address
([The app build](#the-app-build)).

| File | What it is |
|---|---|
| `deploy/docker-compose.yml` | the production stack, the only compose file for a server |
| `deploy/Caddyfile` | HTTPS, security headers, body limits, the upload rule, the access log |
| `deploy/Caddyfile.media` | the media service: the same upload rule, plain files from the `uploads` volume |
| `deploy/.env.example` | the template for `deploy/.env`, with who decides each setting |
| `deploy/scripts/preflight.sh` | checks `deploy/.env` and `<BACKUP_DIR>` before a start |
| `deploy/scripts/backup.sh`, `deploy/scripts/admin-gate.sh`, `deploy/scripts/db-entrypoint.sh` | the scripts of the backup, admin-gate and db services |
| `deploy/mysql/02-binlog-rotate.sql` | the event that rotates MySQL's binary log every day, created on the db service's first start |
| `api/Dockerfile` | the image built on the server (api, scheduler and seed) |
| `deploy/docker-compose.ci.yml`, `deploy/ci.env` | CI and local tests only, never on a server |

## Prerequisites

- **A Linux host** that runs Docker Engine and has `bash`, `git`, `openssl`, GNU `stat` and
  `realpath` (for the preflight), `curl`, and `ss` and `dig` for the checks. Which provider hosts
  it and how big it is: `______` (the operator). One data point, not a sizing: the idle test stack
  of the earlier, Node-based setup used 0.55 to 0.7 GB of memory in two runs (MySQL about 0.45 to
  0.5 GB of it), and its images about 2.5 GB of disk.
- **Docker Compose v2.24.4 or newer** (`docker compose version`). The production files use
  `additional_contexts` and a bind mount with `create_host_path: false`; the CI override uses
  `!reset`, which needs 2.24.4 (`deploy/docker-compose.ci.yml`). The files were
  tested with Docker Compose v5.5.1; no older version was tried.
- **The whole clone**: the image is built from `api/` and `shared/` (what the app and Laravel
  share: blocked terms, common passwords, reserved account names, the legal versions and the club
  rules in `shared/club.json`). Without `shared/` the build stops on purpose.
- **DNS**: an A record for `<DOMAIN>` pointing to the server's IPv4 address, in place before caddy
  starts for the first time (the certificate authority checks the name). No AAAA record.
- **Firewall**: inbound 22 (SSH), 80 and 443, nothing else. Outbound: caddy to the certificate
  authority, api and the scheduler to the mail service (with `graph`: `graph.microsoft.com` and
  the server's metadata endpoint, [Mail through Microsoft Graph](#mail-through-microsoft-graph);
  with `smtp`: the provider), and the image builds to the container registries and package
  mirrors.
- A **password manager** for the generated secrets and `APP_KEY` (below).

## Settings

All settings live in `deploy/.env`, which never goes into git. Create it so that only its owner
can read it, fill it in, then check it:

```bash
cd deploy
install -m 600 .env.example .env
nano .env                 # or any editor
scripts/preflight.sh
```

Every setting below is required: `docker compose` refuses to start until it is set, and names the
missing one. `deploy/.env.example` carries the same list with longer comments.

| Setting | What it is | Who decides | Format |
|---|---|---|---|
| `DOMAIN` | the backend's public name; the app calls `https://<DOMAIN>` and caddy gets its certificate for it | `______` (the operator, with the domain owner) | a host name without scheme or path; A record, no AAAA |
| `DB_PASSWORD` | password of the database user `goenn` (api, scheduler, backup, admin-gate, seed) | technical: generated | `openssl rand -base64 24` |
| `DB_ROOT_PASSWORD` | MySQL's root password (used for a restore) | technical: generated | `openssl rand -base64 24` |
| `APP_KEY` | Laravel's encryption key; it encrypts the two-factor secrets | technical: generated once, never changed | `echo "base64:$(openssl rand -base64 32)"` |
| `APP_NET_PREFIX` | the first three parts of a private /24 that nothing else on the host uses; the compose puts the edge network, with caddy's fixed address, into it | technical: the operator | three numbers, e.g. `172.30.42`; check with `ip -4 addr` and `docker network inspect` |
| `PAYMENTS_MODE` | whether buying credits, club plans and paid bookings works: `off` refuses them, `test` books them without real money (no payment provider is connected yet); on a public server `test` gives everyone credits and club plans for nothing | `______` (the operator, with whoever answers for the business) | `off` or `test` |
| `EVIDENCE_RETENTION_DAYS` | days to keep evidence images of bans and timeouts (the image goes, the record stays) | `______` (the operator, with whoever answers for data protection) | whole days, at least 1 |
| `TOKEN_RETENTION_DAYS` | days to keep sign-in tokens and two-factor, reset and e-mail codes after they stopped being valid | `______` (the operator, with whoever answers for data protection) | whole days, at least 1 |
| `MAIL_MAILER` | how mail goes out (two-factor, password-reset and e-mail-change codes, the credit reminders): `graph` is Microsoft Graph as the server's managed identity ([Mail through Microsoft Graph](#mail-through-microsoft-graph)), `smtp` an SMTP provider; never `log`, with which api and the scheduler do not start | `______` (the operator) | `graph` or `smtp` |
| `MAIL_GRAPH_CLIENT_ID` | with `graph`: the client ID of the server's user-assigned managed identity; not a secret | technical: an output of the hosting platform's stack | a GUID; empty with `smtp` |
| `MAIL_HOST` | with `smtp`: the SMTP host of the mail provider | `______` (the operator: the mail provider) | a host name, port 587 unless `MAIL_PORT` says otherwise, `MAIL_SCHEME=smtps` for TLS from the start; empty with `graph` |
| `MAIL_USERNAME` | with `smtp`: the SMTP login | `______` (the operator) | must be in the file; empty with `graph`, or for a relay without login |
| `MAIL_PASSWORD` | with `smtp`: the SMTP password | `______` (the operator) | must be in the file; empty with `graph`, or for a relay without login |
| `MAIL_FROM_ADDRESS` | the sender address of every mail; with `graph`, the mailbox the identity may send as | `______` (the operator: the sender mailbox) | an e-mail address |
| `BACKUP_DIR` | the host folder the backup service writes to | `______` (the operator: where, who looks after it) | an absolute path outside the clone, owned by root, mode 700 |
| `BACKUP_RETENTION_DAYS` | days a backup set is kept | `______` (the operator, with whoever answers for data protection) | whole days, at least 1 |
| `LOG_MAX_SIZE` | the size of one container log file | `______` (the operator, with whoever answers for data protection) | a whole number with the unit `k`, `m` or `g` |
| `LOG_MAX_FILES` | how many log files each container keeps | `______` (the operator, with whoever answers for data protection) | a whole number, at least 2 (Docker's `local` log driver compresses the rotated files and refuses a single file) |
| `MYSQL_BINLOG_RETENTION_DAYS` | days MySQL keeps its binary log, which records every change, also the rows of deleted accounts; the log is rotated daily, so a change stays at most two days longer ([Logs](#logs)) | `______` (the operator, with whoever answers for data protection) | whole days from 1 to 9999, or `off` (no binary log); 0 is refused |

Generating the secrets: each command prints the value once, in your own terminal, so you can put it
into `deploy/.env` and into the password manager. Never paste a value into a chat, a ticket or a
commit.

- Keep `APP_KEY` in the password manager, outside the server. Laravel encrypts the two-factor
  secrets with it: with another key nobody who uses two-factor sign-in gets into their account,
  and a restored backup is of no use for those accounts without the original key. Generate it
  once and never change it.
- Never run `git clean` in the clone on the server: `deploy/.env` is ignored by git, and
  `git clean -x` deletes it. Never run `docker compose down -v`: `-v` deletes the volumes, that is
  the database and every upload.
- The `ADMIN_EMAIL` and `ADMIN_PASSWORD` of the admin account are not settings: they are typed in
  once, for the one command that creates the account ([First start](#first-start)).

Optional settings, with their defaults in the compose or the code (`deploy/.env.example` lists
them): `SANCTUM_EXPIRATION` (access-token lifetime in minutes, default 30 days), `MAIL_PORT`,
`MAIL_SCHEME`, `LOG_LEVEL`, and the rate limits `AUTH_LIMIT_*` of the sign-in, sign-up, password
and two-factor routes. The other write limits are fixed in the code (`api/config/ratelimits.php`).

`scripts/preflight.sh` (also `scripts/preflight.sh <env-file>`) prints one line per check and a
total, never a value, and exits 1 when a check fails. It checks that `deploy/.env` exists with mode
600 or 400; that none of its settings is also set in the shell (docker compose would take the
shell's value); that `<BACKUP_DIR>` is an existing absolute path outside the clone, owned by root
with mode 700; the form of `BACKUP_RETENTION_DAYS`, `MYSQL_BINLOG_RETENTION_DAYS`, `LOG_MAX_SIZE`,
`LOG_MAX_FILES`, `EVIDENCE_RETENTION_DAYS`, `TOKEN_RETENTION_DAYS` and `PAYMENTS_MODE`; that
`MAIL_MAILER` is `graph` or `smtp` and the chosen way has what it needs (a GUID in
`MAIL_GRAPH_CLIENT_ID`, or `MAIL_HOST`), with an address in `MAIL_FROM_ADDRESS`; and that docker
compose renders the production compose with the file. api and the scheduler check the mail
settings again when they start: a setting the chosen way needs that is empty stops them with
`ERROR: required settings missing or invalid` (`api/docker/entrypoint.sh`).

### Mail through Microsoft Graph

With `MAIL_MAILER=graph` the app sends through Microsoft Graph as the server's user-assigned
managed identity (`api/app/Mail/GraphTransport.php`). There is no app registration and no
secret: the token comes from the server's metadata endpoint (`169.254.169.254`, plain HTTP,
reachable from the server only), is kept encrypted in the database's cache table until five
minutes before it expires, and nothing needs rotating. Every mail goes out as the one mailbox in
`MAIL_FROM_ADDRESS`, as JSON with `saveToSentItems: false`, so the mailbox keeps no copy of a
code.

What the hosting platform provides:

- the user-assigned managed identity, attached to the server: its client ID goes into
  `MAIL_GRAPH_CLIENT_ID`, its principal ID is needed once, below;
- outbound HTTPS to `graph.microsoft.com` for api and the scheduler, and their way to the
  metadata endpoint.

What Microsoft 365 must provide (an Exchange administrator does it; no tenant values belong in
this repository):

- a mailbox for `MAIL_FROM_ADDRESS`; a shared mailbox needs no licence up to 50 GB;
- the domain of that address as an accepted domain, with its verification, SPF, DKIM and DMARC
  records (in Cloudflare as DNS only);
- **no** Microsoft Graph permission consented to the identity in Microsoft Entra ID: a consented
  `Mail.Send` would let it send as every mailbox of the tenant, and Exchange's scope cannot
  narrow a grant made there;
- in Exchange Online PowerShell, the role "Application Mail.Send" for the identity, scoped to the
  one mailbox, and a check of the scope:

```powershell
New-ServicePrincipal -AppId <client ID> -ObjectId <principal ID> -DisplayName <a name>
New-ManagementScope -Name <scope name> -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<MAIL_FROM_ADDRESS>'"
New-ManagementRoleAssignment -Role "Application Mail.Send" -App <client ID> -CustomResourceScope <scope name>
Test-ServicePrincipalAuthorization -Identity <client ID> -Resource <MAIL_FROM_ADDRESS>
Test-ServicePrincipalAuthorization -Identity <client ID> -Resource <another mailbox>
```

  The first check must show the role with `InScope` `True`, the second with `False`. A change of
  the assignment takes 30 minutes to 2 hours to apply;
- an outbound spam policy for the mailbox that caps its external recipients per hour: the app's
  mail counts against the tenant-wide limit.

That Exchange accepts a managed identity this way follows from its documentation for service
principals but has not been tried yet. If it refuses, the way out is an app registration with a
certificate credential (never a client secret), as a later change to the app.

## First start

The admin account is created before the domain is reachable: everything except caddy starts
first, a one-off container creates the admin, and only then does caddy start. The `admin-gate`
service enforces the order: while no admin exists, `docker compose up -d` stops with
`service "admin-gate" didn't complete successfully: exit 1` and caddy stays down.

1. Get the code and fill in the settings ([Settings](#settings)):

   ```bash
   git clone <repository URL> goenntertainment
   cd goenntertainment/deploy
   install -d -m 700 -o root -g root <BACKUP_DIR>
   install -m 600 .env.example .env
   nano .env
   ```

2. Check the settings; every line must say `ok`:

   ```bash
   scripts/preflight.sh
   ```

3. Build the images, with fresh copies of the pinned base images (`--profile tools` builds the
   seed image too):

   ```bash
   docker compose --profile tools build --pull
   ```

4. Start everything except caddy, and wait until db and api report `healthy` (api runs the
   migrations first; the first start takes a few minutes):

   ```bash
   docker compose up -d db storage-init api scheduler backup
   until [ "$(docker compose ps --format '{{.Health}}' db api | grep -c '^healthy$')" = 2 ]; do sleep 5; done
   docker compose ps
   ```

   The database schema comes from Laravel's migrations (`api/database/migrations`), which api runs
   on every start (`php artisan migrate --force`, `api/docker/entrypoint.sh`); they also create the
   category list the app shows. Never load a schema file by hand.

5. Create the admin account. Who the admin is (the address), how many admin accounts there are
   and who approves an admin grant: `______` (whoever is accountable for the app, to be named
   before go-live). The address and the password are typed in, exist only in the shell variables
   and the one `--rm` container, and are removed right after. The command applies the app's
   password rules (at least 8 characters with letters and digits, not a common password, neither
   the username `admin` nor the address in it): use a long, unique password from the password
   manager.

   ```bash
   read -r -p 'Admin e-mail: ' ADMIN_EMAIL
   read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
   ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose run --rm seed
   unset ADMIN_EMAIL ADMIN_PASSWORD
   ```

   Expected: `admin:create: account created (is_admin = 1).` It refuses (exit 1) and changes
   nothing when an account with that address or the username `admin` exists; it never promotes an
   account or resets a password. A further admin is an account that exists in the app, promoted
   with `docker compose exec api php artisan admin:grant <address>` (`--revoke` takes it back).

6. Check that an admin exists, without printing anything secret:

   ```bash
   docker compose run --rm admin-gate
   ```

   Expected: `admin-gate: 1 admin account(s); caddy may start.`

7. Start the rest. The gate passes, caddy starts and requests the certificate:

   ```bash
   docker compose up -d
   docker compose ps
   ```

8. Check from outside:

   ```bash
   curl -sSI https://<DOMAIN>/api/health
   ```

   Expected: status 200 (`HTTP/2 200`) with `strict-transport-security`,
   `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy` and
   `permissions-policy`; `curl -sS` on the same address prints `{"ok":true}`. A certificate error
   means the A record does not point to the server yet, or ports 80/443 are closed:
   `docker compose logs caddy --tail 50`. Then run the IPv4 checks of [What runs](#what-runs).

9. Confirm the first backup: `docker compose logs backup` shows `run ... written`, and
   `ls -l <BACKUP_DIR>` lists one `db-`, `uploads-` and `SHA256SUMS-` file.

Partners, offers and voucher batches are created by an admin in the app's admin area. There is no
demo data for a server: `php artisan db:seed --class=DemoMarketplaceSeeder` refuses to run in
production.

Restoring onto a fresh server instead: steps 1 to 4 with the old `APP_KEY` (the other secrets may
be new: the dump holds the app's data, not MySQL's accounts), then [Restore](#restore), without
steps 5 and 6.

## The app build

The app finds the server through `EXPO_PUBLIC_API_URL`, baked into the build. In
[`eas.json`](../eas.json), replace the placeholder in **both** profiles (`preview` and
`production`) with the server's address:

```json
"env": { "EXPO_PUBLIC_API_URL": "https://<DOMAIN>" }
```

Without it the build is useless: the app shows only a timeout when signing in. Who owns the EAS
project and builds the app: `______` (whoever is accountable for the app, to be named before
go-live).

## Updating

```bash
cd <clone>/deploy
docker compose exec backup bash /opt/deploy/backup.sh --once     # a fresh backup set first
git pull --ff-only
scripts/preflight.sh
docker compose --profile tools build --pull
docker compose up -d
```

Docker rebuilds only what changed and replaces the containers; the database and the uploads stay
in their volumes, and api applies new migrations when it starts. Going back to the old images
does not undo a migration, which is why the update starts with a backup set: the way back is a
[restore](#restore) of that set. When an update adds a required
setting, `scripts/preflight.sh` and `docker compose` name it: add it to `deploy/.env`
([Settings](#settings)) and run the steps again. Who approves an update before it goes live:
`______` (whoever is accountable for the app, to be named before go-live).

**Base images.** Every image is pinned by digest (`<name>:<tag>@sha256:<digest>`) in
`api/Dockerfile`, `server/Dockerfile`, `deploy/docker-compose.yml` (mysql, caddy, busybox),
`dev/docker-compose.yml` (Mailpit) and `.github/actionlint/Dockerfile`, so every build starts from
the same bytes. The stack test's probe in `deploy/docker-compose.ci.yml` is built from
`server/Dockerfile` and pins no image of its own, so the Node pin has one copy. Dependabot
(`.github/dependabot.yml`) proposes new digests every week as pull requests that run the full CI;
after merging one, deploy it with the steps above. Who reviews and merges them: `______`
(whoever is accountable for the app, to be named before go-live).

**Urgent refresh** (a security fix in a base image before Dependabot's pull request), in a
development clone:

```bash
docker buildx imagetools inspect mysql:8.4      # the "Digest:" line is the new pin
git grep -n 'mysql:8.4@sha256:'                 # every copy of the pin
```

Change every copy of the pin in one pull request (the deploy tests and
`scripts/ci/check-mirrors.mjs` fail while two copies differ), let CI pass, merge, and deploy with
the steps above.

**Monthly rebuild without cache**, so that packages installed while the images are built (the
system libraries of the api image's PHP extensions come from the Debian mirrors at build time) pick
up their security fixes between base-image updates:

```bash
docker compose --profile tools build --pull --no-cache
docker compose up -d
```

Who does it, and when: `______` (the operator).

**Support dates.** The production stack runs no Node; CI's stack-test probe and the development
tools do. Node 22 gets security fixes until 2027-04-30 (`server/Dockerfile`); move to the next
long-term-support line before then, together with CI's `NODE_VERSION`
(`scripts/ci/check-mirrors.mjs` fails while the two differ). Who tracks the support dates of PHP
8.4 and MySQL 8.4: `______` (the operator).

**CI images Dependabot cannot update.** The `mysql:8.4` service image of the test jobs in
`.github/workflows/ci.yml` (three copies): Dependabot does not read service images in workflow
files. It carries the same pin as `deploy/docker-compose.yml`, and `scripts/ci/check-mirrors.mjs`
fails until all copies agree, so a Dependabot update of the compose pin needs the workflow lines
changed by hand in the same pull request.

**From an earlier setup** (once, on a server that ran an earlier `deploy/docker-compose.yml`). The
project is named after its folder, `deploy`, as before, so the database, the certificates and
caddy's configuration stay in their volumes (`deploy_db-data`, `deploy_caddy-data`,
`deploy_caddy-config`). Before `git pull`, stop the old stack with the old files; this also
removes its network `deploy_default`, whose address range could overlap `APP_NET_PREFIX`, and the
containers of services this version no longer has (the Node backend). Never add `-v`:

```bash
docker compose down
```

Then add the new settings ([Settings](#settings)) and run the update steps above. A database
volume from before has no binary-log rotation yet: create it once ([Logs](#logs)). api's
migrations take over a database that an earlier setup created from `server/schema.sql`: they
create only what is missing (tried once on a database built from the schema of the earlier,
Node-based setup: 41 tables before, 70 after, and a second run had nothing to do). Back it up first
all the same ([Backups](#backups)). Uploads that the old setup kept in folders of the clone move
into volumes as described next.

**Moving from the old upload folders** (once, only if this server ran an earlier setup that kept
uploads in `deploy/storage/` and `deploy/storage-private/`): with the stack stopped
(`docker compose stop`), copy them into the volumes, check the files, then delete the old folders:

```bash
docker compose run --rm --no-deps \
  -v "$PWD/storage:/old/storage:ro" -v "$PWD/storage-private:/old/storage-private:ro" \
  storage-init sh -c 'cp -a /old/storage/. /storage/ && cp -a /old/storage-private/. /storage-private/ && chown -R 33:33 /storage /storage-private'
docker compose up -d
```

## Backups

The `backup` service (`deploy/scripts/backup.sh`) writes one set every night at 02:30 UTC and once
whenever the service starts:

| File | Content |
|---|---|
| `db-<stamp>.sql.gz` | a `mysqldump` of the database `goenntertainment`, in one consistent transaction |
| `uploads-<stamp>.tar.gz` | the volumes `uploads` and `private-media` (folders `uploads/` and `private-media/`) |
| `SHA256SUMS-<stamp>` | the checksums of both |

- **Where**: `<BACKUP_DIR>` on the host (`BACKUP_DIR`), outside the clone, owned by root, mode
  700. The files are mode 600: they hold personal data and need the same care as the database.
- **Checks**: a set is assembled in a `.partial-<stamp>` folder, checked (`gzip -t`, the dump's
  completion line, `tar -t`, the checksums) and only then moved into place. Laravel keeps writing
  while the uploads are archived: when files were added or removed meanwhile, the log says so and
  the set is kept (the archive holds the files as they were found); any other archive error fails
  the run.
- **Retention**: after each successful run, sets older than `BACKUP_RETENTION_DAYS` are deleted. A
  failed run deletes nothing.
- **Time**: 02:30 UTC is a technical constant (`RUN_AT_UTC` in `deploy/scripts/backup.sh`); another
  time: `______` (the operator).
- **Not in the backup**: `deploy/.env` and the secrets (keep `APP_KEY` and the secrets in the
  password manager), the certificates (caddy requests new ones), the container logs, and MySQL's
  binary log, so a restore goes back to the last set, not to a point in time between two sets.
- **Offsite copy, encryption at rest, who looks after the backups and tests a restore**: `______`
  (the operator). Without an offsite copy, losing the server loses the backups too.

Checking:

```bash
docker compose ps backup                    # healthy: the last run succeeded within 26 hours, none failed since
docker compose logs backup --tail 20
ls -l <BACKUP_DIR>
docker compose exec backup bash /opt/deploy/backup.sh --once     # one run now
docker compose exec backup bash /opt/deploy/backup.sh --check    # the healthcheck by hand
```

### Restore

A restore replaces the database and both upload volumes with one set. `<SET_DIR>` is the folder
that holds the set: `<BACKUP_DIR>` on the same server. On a new server, put the set into a folder
of its own, not into the new `<BACKUP_DIR>`: the backup service deletes sets there by age.

1. Pick the set and check it:

   ```bash
   ls -l <SET_DIR>
   stamp=<stamp>                 # e.g. 20260101T023000Z, from the file names
   (cd <SET_DIR> && sha256sum -c "SHA256SUMS-$stamp")
   ```

2. Stop the services that write (on a new server: after step 4 of [First start](#first-start)):

   ```bash
   docker compose stop caddy api scheduler backup
   ```

3. Load the database dump. The root password is read inside the db container from its own
   environment: it appears on no command line. `pipefail` makes a failing `gunzip` fail the whole
   command; without it mysql would read an empty input and report success.

   ```bash
   set -o pipefail
   gunzip -c "<SET_DIR>/db-$stamp.sql.gz" \
     | docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot goenntertainment' \
     && echo 'database loaded'
   ```

   Expected: `database loaded` and no error above it. Otherwise stop here: the uploads (step 4)
   must not be restored without the database.

4. Replace the uploads (this deletes the files in both volumes first):

   ```bash
   docker compose run --rm --no-deps -v "<SET_DIR>:/backups:ro" storage-init sh -c "set -e
     find /storage /storage-private -mindepth 1 -delete
     tar -xzf /backups/uploads-$stamp.tar.gz -C /storage --strip-components=1 uploads
     tar -xzf /backups/uploads-$stamp.tar.gz -C /storage-private --strip-components=1 private-media
     chown -R 33:33 /storage /storage-private"
   ```

   The archive keeps symbolic links as links. Laravel writes only regular files into both
   volumes, so a link did not come from the app: list them, expect nothing, and treat any link as
   a sign that someone wrote into the volume outside the app (remove it, and find out how it got
   there before going live again):

   ```bash
   docker compose run --rm --no-deps storage-init find /storage /storage-private -type l
   ```

5. Start everything and check:

   ```bash
   docker compose up -d
   docker compose ps
   curl -sS https://<DOMAIN>/api/health
   ```

   The gate passes with the restored admin account; api runs the migrations at start; the backup
   service writes a first set of the restored state.

## Logs

Every container logs to Docker's `local` log driver, rotated by size: at most `LOG_MAX_FILES`
files of `LOG_MAX_SIZE` each, per container. Docker rotates by size, not by time, so how many days
the logs cover depends on the traffic. Whether a hard time limit is required: `______` (the
operator, with whoever answers for data protection); one way is the `journald` driver in the
compose's `x-logging` block with a `MaxRetentionSec` in the host's journald configuration (not
set up here).

```bash
docker compose logs -f api scheduler
docker compose logs caddy --since 1h
```

The caddy access log (JSON, one line per request, in `docker compose logs caddy`) holds per
request: the client address and port, protocol, method, host, the full URI including the query
string, every request header with the values of `Authorization` and `Cookie` replaced by
`REDACTED` (the app sends its token in `Authorization`), the TLS version, cipher and server name,
the status, the response size and duration, and the response headers. Laravel logs from
`LOG_LEVEL` up (default `warning`), in api and in the scheduler; the project's rule is that no
password, token or code is ever logged (`AGENTS.md`). With Microsoft Graph, a mail that is not
sent logs `[mail-graph] mail not sent` at error level, with the request (`token` or `send`), the
HTTP status, the error code and a hint: never the token, a recipient or the mail itself.

MySQL's binary log is not a container log: it lives in the `db-data` volume. MySQL deletes a
binary-log file only when the log rotates, once the file's last write is more than
`MYSQL_BINLOG_RETENTION_DAYS` days old. The db service turns on MySQL's event scheduler, and an
event (`deploy/mysql/02-binlog-rotate.sql`, created as root on the first start of an empty volume)
rotates the log once a day. So a change, including the rows of a deleted account, stays in the
binary log at least `MYSQL_BINLOG_RETENTION_DAYS` days and at most two days longer; the backups
keep their own copy for `BACKUP_RETENTION_DAYS` days. To see the values in effect and the event:

```bash
docker compose exec db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SELECT @@log_bin, @@binlog_expire_logs_seconds, @@event_scheduler; SELECT EVENT_NAME, STATUS, INTERVAL_VALUE, INTERVAL_FIELD, LAST_EXECUTED FROM information_schema.EVENTS"'
```

Expected: `1`, the retention in seconds and `ON` (with `off`: `0`, MySQL's unused default and
`ON`), then `binlog_rotate ENABLED 1 DAY` and the time of the last rotation (`NULL` during the
first day). A `db-data` volume whose first start ran before this event existed does not have it:
create it once (nothing changes when it exists):

```bash
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot < /docker-entrypoint-initdb.d/02-binlog-rotate.sql'
```

Whether the access log keeps full client addresses and query strings or masks them, and who may
read the production logs (everyone who can run `docker` on the server can): `______` (the
operator, with whoever answers for data protection).

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `required variable <NAME> is missing a value: <NAME> is missing in deploy/.env ...` | a required setting is empty or missing: [Settings](#settings) |
| `scripts/preflight.sh` prints `FAIL` | the line says what to fix; the env file needs mode 600, `<BACKUP_DIR>` root and mode 700 outside the clone |
| `service "admin-gate" didn't complete successfully: exit 1` on `docker compose up -d`, caddy stays `Created` | no admin account yet: steps 5 and 6 of [First start](#first-start); `docker compose run --rm admin-gate` says why |
| `failed to create network ...: Pool overlaps with other one on this address space` | `APP_NET_PREFIX` is used by another network on the host: pick a free /24 |
| api stays `unhealthy` | `docker compose logs api`: `ERROR: required settings missing or invalid` names them; a failed migration shows its error before Apache starts; otherwise usually a wrong `DB_PASSWORD` |
| club renewals, credit expiry or the reminder mails do not happen | `docker compose logs scheduler`; `Retention settings missing or invalid` names a setting of the prune |
| a code mail is not sent; `docker compose logs api` shows `[mail-graph] mail not sent` | the line names the request, the status, the error code and a hint. `token` 400: the identity is not attached to the server, or `MAIL_GRAPH_CLIENT_ID` is not its client ID. `token` 404 or 410: the metadata endpoint is updating, just after a boot; it passes within a minute or two. No answer: api or the scheduler does not reach the metadata endpoint or Graph. `send` 403 `ErrorAccessDenied`: the role assignment is missing, does not cover `MAIL_FROM_ADDRESS`, or is not applied yet (up to 2 hours). `send` 404: `MAIL_FROM_ADDRESS` is not a mailbox of the tenant ([Mail through Microsoft Graph](#mail-through-microsoft-graph)) |
| `[mail-graph] mail settings missing or invalid` | `MAIL_GRAPH_CLIENT_ID` is not a GUID or `MAIL_FROM_ADDRESS` is not an address: [Settings](#settings) |
| db exits right away | `docker compose logs db`: `MYSQL_BINLOG_RETENTION_DAYS must be ...` means the value is not 1 to 9999 or `off` |
| no container starts: `failed to initialize logging driver: compression cannot be enabled when max file count is 1` | `LOG_MAX_FILES=1`: set it to 2 or more (`scripts/preflight.sh` refuses 1), then `docker compose up -d` |
| backup `unhealthy` | `docker compose logs backup`: `BACKUP_DIR` missing or not writable, an invalid `BACKUP_RETENTION_DAYS`, the database did not answer within about 5 minutes (`did not answer`; each run waits for it, also after a reboot), or a failed run (`nothing was deleted`) |
| caddy logs certificate or challenge errors | the A record does not point to the server yet, or 80/443 are closed |
| a request gets `413` from caddy | the body is over the edge's limit: 9 MB for uploads (multipart), 128 KiB for everything else |
| images under `/storage/` answer `502` | the media service is not running: `docker compose ps media`, `docker compose logs media` |
| uploads fail with "Serverfehler" | the upload volumes do not belong to uid 33 (`www-data`): `docker compose logs storage-init` |
| `Bitte ein Bild wählen (jpg, png oder webp, höchstens 5 MB).` | the file is no JPEG, PNG or WebP picture, or larger than 5 MB (`api/app/Support/Uploads.php`) |
| a purchase says `Bezahlen ist noch nicht freigeschaltet` | `PAYMENTS_MODE` is `off`: no payment provider is connected yet |
| the app shows only a timeout when signing in | `EXPO_PUBLIC_API_URL` in `eas.json` ([The app build](#the-app-build)) |

## What CI checks

On every pull request:

- `.github/workflows/ci.yml`: the client tests, typecheck and lint; the server tests and the API
  tests against MySQL 8.4 loaded from `server/schema.sql`; the schema drift check (the migrations
  build the tables of `server/schema.sql`); the tooling tests; `scripts/ci/check-repo.mjs` (among
  others: every setting the production compose requires is named in this runbook);
  `scripts/ci/check-mirrors.mjs` (values written in several places, such as the image pins); the
  workflow policy and actionlint; the dependency audit.
- `.github/workflows/docker.yml`: the deploy tests (`npm run test:deploy`, the files in
  `deploy/test/`): the compose renders with `deploy/ci.env` and refuses to start without each
  required setting, the Caddyfile, the scripts, the image pins, the two Dockerfiles, and this
  runbook (its sections, the first-start order, the commands and the values it shares with the
  code); and the stack test, which builds the images, starts the whole stack with `deploy/ci.env`
  and `deploy/docker-compose.ci.yml` on internal networks and checks it through caddy, a
  marketplace pass included (sign-up, a partner with its logo, an offer, credits in test mode).
  Locally: `npm run test:deploy` (Docker needed) and the root README's
  [Tests and checks](../README.md#tests-and-checks).

Not checked by CI: the real host, DNS, a certificate from a public authority, the firewall, the
published ports and the IPv6 path, a host reboot, and Dependabot's handling of the compose files.
The first start, the backup and the restore of this runbook were walked through on a local test
stack of the earlier, Node-based setup (`deploy/ci.env` and the CI override, internal networks, no
published ports); the stack test runs the same steps on this one; the host parts were not.

## Decisions this runbook does not make

Each needs an answer from the person named before the server goes live. The settings named in a
row are required: the stack does not start without them.

| Decision | Who decides | Answer |
|---|---|---|
| the backend domain (`DOMAIN`), and HSTS `includeSubDomains`/`preload` for the whole business domain | the operator, with the domain owner | `______` |
| the hosting provider and the server size | the operator | `______` |
| how mail goes out (`MAIL_MAILER`: Microsoft Graph or SMTP), the sender mailbox (`MAIL_FROM_ADDRESS`), and with SMTP the provider (`MAIL_HOST`, `MAIL_USERNAME`, `MAIL_PASSWORD`) | the operator | `______` |
| whether the server takes payments in test mode, without real money (`PAYMENTS_MODE`) | the operator, with whoever answers for the business | `______` |
| retention of evidence images and expired sign-in data (`EVIDENCE_RETENTION_DAYS`, `TOKEN_RETENTION_DAYS`) | the operator, with whoever answers for data protection | `______` |
| where the backups live, who looks after them, the offsite copy, encryption at rest, and how long sets are kept (`BACKUP_DIR`, `BACKUP_RETENTION_DAYS`) | the operator, with whoever answers for data protection | `______` |
| how much container log is kept, whether a time limit is required (`LOG_MAX_SIZE`, `LOG_MAX_FILES`) | the operator, with whoever answers for data protection | `______` |
| how long MySQL keeps its binary log, or `off` (`MYSQL_BINLOG_RETENTION_DAYS`) | the operator, with whoever answers for data protection | `______` |
| whether the access log masks client addresses or query strings; who may read production logs | the operator, with whoever answers for data protection | `______` |
| the backup time (02:30 UTC is a technical constant) | the operator | `______` |
| who the admin is (the address typed in at the first start), how many admin accounts there are, and who approves an admin grant | whoever is accountable for the app, to be named before go-live | `______` |
| the access-token lifetime (default 30 days, `SANCTUM_EXPIRATION`) | the operator | `______` |
| IPv6 (an AAAA record) once it is set up end to end | the operator | `______` |
| who approves updates and the go-live; who reviews and merges Dependabot's pull requests | whoever is accountable for the app, to be named before go-live | `______` |
| who does the monthly rebuild and tracks the PHP and MySQL support dates | the operator | `______` |
| who owns the EAS project and builds the app | whoever is accountable for the app, to be named before go-live | `______` |
