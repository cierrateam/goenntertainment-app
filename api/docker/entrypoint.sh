#!/bin/sh
# Startet die Laravel-API im Container.
#
# Läuft bei JEDEM Start, bevor Apache hochkommt. Hier und nicht beim Bauen, weil
# die Umgebungsvariablen (Datenbank, APP_KEY, Mail) erst beim Start feststehen –
# ein beim Bauen erzeugter Konfigurations-Cache hätte die falschen Werte.
set -e

cd /var/www/api

# The key is generated on the host with openssl, the same command as in deploy/README.md
# (Settings) and deploy/.env.example: a `docker compose run ... key:generate` cannot help here,
# because docker compose starts no service at all while APP_KEY is empty.
if [ -z "$APP_KEY" ]; then
  echo "ERROR: APP_KEY is missing. Generate it once, on the host:" >&2
  echo '  echo "base64:$(openssl rand -base64 32)"' >&2
  echo "Put the result into deploy/.env as APP_KEY, keep a copy in a password manager and never change it (deploy/README.md, Settings)." >&2
  exit 1
fi

# Required settings. Names only, never values (some are secrets).
missing=""
# The reverse proxy's address (the compose sets it from APP_NET_PREFIX). Without it Laravel would
# see every client as the proxy; '*' would let every client choose its own address (F-31).
case "$TRUSTED_PROXIES" in
  ''|'*'|'**') missing="$missing TRUSTED_PROXIES(the reverse proxy's address, never *)" ;;
esac
# How mail goes out (deploy/README.md, Settings): Microsoft Graph or SMTP, and every setting the
# chosen way needs; nothing falls back to another way. Never the log mailer, or any other: it
# would write every code into the container log (api/app/Support/CodeMail.php).
case "$MAIL_MAILER" in
  graph)
    [ -n "$MAIL_GRAPH_CLIENT_ID" ] || missing="$missing MAIL_GRAPH_CLIENT_ID(the managed identity's client ID, for MAIL_MAILER=graph)"
    ;;
  smtp)
    [ -n "$MAIL_HOST" ] || missing="$missing MAIL_HOST(the SMTP host, for MAIL_MAILER=smtp)"
    ;;
  *) missing="$missing MAIL_MAILER(graph or smtp)" ;;
esac
[ -n "$MAIL_FROM_ADDRESS" ] || missing="$missing MAIL_FROM_ADDRESS(the sender mailbox)"
if [ -n "$missing" ]; then
  echo "ERROR: required settings missing or invalid:$missing (see deploy/.env.example)" >&2
  exit 1
fi

# Konfiguration einmal zusammenfassen: spart bei jeder Anfrage das Einlesen von
# ~15 Konfigurationsdateien. Geht, weil der Code kein env() außerhalb von config/
# aufruft (dann würde der Cache diese Werte verschlucken).
php artisan config:cache
php artisan event:cache

# Schema-Änderungen einspielen. Laravel verwaltet das Schema allein (api/database/
# migrations); die erste Migration legt die Tabellen aus der Node-Zeit nur an,
# wenn es sie noch nicht gibt, und ergänzt sonst nur fehlende Spalten.
# Nur im Container mit RUN_MIGRATIONS=true (api), nicht im scheduler.
if [ "$RUN_MIGRATIONS" = "true" ]; then
  php artisan migrate --force
fi

exec "$@"
