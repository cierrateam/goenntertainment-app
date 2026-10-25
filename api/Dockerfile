# Laravel-API (api/) als Container-Abbild.
#
# Gebaut wird aus deploy/docker-compose.yml heraus (Baukontext api/, dazu
# shared/ als zweiter Kontext). Von Hand, im Repo-Stamm:
#
#   docker build -f api/Dockerfile --build-context shared=shared -t goenn-api api
#
# ## Warum php:8.4-apache
#
# - 8.4, weil lokal (Herd) dieselbe Version läuft: Was am PC geht, geht hier.
# - Apache with PHP built in (mod_php) is ONE process: no second web server next to php-fpm.
#   Apache serves no uploads: the edge (Caddy, deploy/Caddyfile, with its file server
#   deploy/Caddyfile.media) serves those as static files, and this image refuses an upload folder
#   under its docroot (docker/apache.conf).
# - Laravel bringt in public/.htaccess die Umleitungen für Apache mit – inklusive
#   der Zeile, die den `Authorization`-Kopf (das Anmelde-Token) an PHP weiterreicht.
#   Ohne sie wäre jede Anfrage der App „nicht angemeldet".
#
# ## Stages
#
# - php-ext-installer, composer-bin: the two helper images, as stages so that every image this
#   file uses stands on a FROM line (Dependabot reads FROM lines only).
# - base: PHP with its extensions, and Apache on port 8080.
# - build: base plus Composer; installs the packages and builds the autoloader. Never shipped.
# - runtime (the last stage, the image that runs): base plus the finished code from build,
#   running as www-data. No Composer, no zip extension, no root.
#
# Every image is pinned by digest (<name>:<tag>@sha256:<digest of the multi-arch index>), so each
# build starts from the same bytes; Dependabot proposes new digests (.github/dependabot.yml). By
# hand: `docker buildx imagetools inspect <name>:<tag>` prints the current one; every copy of a
# pin moves in the same change.

FROM mlocati/php-extension-installer:2@sha256:1afade3e29cfc97362cf5885e5ac333bf2faab1146cb28ebbb59b17e68f87e88 AS php-ext-installer
FROM composer:2@sha256:af98f42dfff7c68ba8d53c2164fd9fde1087b7d449514baa38c418b1f6bc4bac AS composer-bin

# ================================================================ base
FROM php:8.5-apache@sha256:974e3a920309308e1690ed607e6cc3061d6906f90cc8d30fe519daa48bccf101 AS base

# ---------------------------------------------------------------- PHP-Erweiterungen
# pdo_mysql  Datenbank
# intl       Unicode-Normalisierung im Wortfilter (App\Support\BlockedTerms) –
#            ohne sie rutschen gestylte Buchstaben (𝐟𝐞𝐭𝐭) durch
# bcmath     große Zahlen (TOTP)
# opcache    hält übersetzten PHP-Code im Speicher
# gd         every uploaded image is decoded and encoded again (App\Support\ImageCheck): only
#            real JPEG, PNG and WebP pictures are stored, without their metadata
# exif       a photo's orientation from its EXIF data, applied before the metadata goes
# mbstring und sodium sind im offiziellen Abbild schon eingebaut.
# zip is installed in the build stage only: the package manager unpacks packages with it, the
# running app never needs it.
#
# `install-php-extensions` statt `docker-php-ext-install` von Hand: Es installiert
# die passenden System-Bibliotheken selbst und räumt die Bau-Pakete wieder weg.
# Von Hand müsste man deren Namen hinschreiben – und die ändern sich mit jeder
# Debian-Version des Basis-Abbilds (libicu72 → libicu76 …).
COPY --from=php-ext-installer /usr/bin/install-php-extensions /usr/local/bin/
RUN install-php-extensions pdo_mysql intl bcmath opcache gd exif \
    && rm /usr/local/bin/install-php-extensions

COPY docker/php.ini /usr/local/etc/php/conf.d/zz-goenn.ini

# ---------------------------------------------------------------- Apache
# Wurzel auf public/ – sonst läge der ganze Code samt Konfiguration offen im Netz.
# ${APACHE_DOCUMENT_ROOT} bleibt absichtlich wörtlich stehen: Apache setzt
# Umgebungsvariablen selbst ein (so steht es auch in der Doku des Abbilds).
#
# Port 8080 instead of 80: Apache runs as www-data (see USER below), and only root may open a
# port below 1024. The greps stop the build if the base image's files no longer hold the lines
# the replacements expect, instead of shipping an Apache that still wants port 80.
#
# ServerName ${APP_URL} (the public https://<DOMAIN>, set by the compose) as the first line of
# that site: Apache builds the address of its own redirects (Laravel's trailing-slash rule in
# public/.htaccess) from it, so they point at https://<DOMAIN>/... and not at the internal
# http://<DOMAIN>:8080. It has to be inside the site: the site's own port would win over a
# global ServerName. ${APP_URL} stays literal here, like ${APACHE_DOCUMENT_ROOT}: Apache reads it
# from the environment when it starts.
ENV APACHE_DOCUMENT_ROOT=/var/www/api/public
RUN sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \
    && sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf \
    && sed -ri 's/^<VirtualHost \*:80>$/<VirtualHost *:8080>\n\tServerName ${APP_URL}/' /etc/apache2/sites-available/000-default.conf \
    && grep -qx 'Listen 8080' /etc/apache2/ports.conf \
    && ! grep -Eq '^Listen 80$' /etc/apache2/ports.conf \
    && grep -qx '<VirtualHost \*:8080>' /etc/apache2/sites-available/000-default.conf \
    && grep -A1 -x '<VirtualHost \*:8080>' /etc/apache2/sites-available/000-default.conf | grep -qx '[[:space:]]*ServerName ${APP_URL}' \
    && a2enmod rewrite headers
# The project's settings load after Debian's own (conf-enabled/*.conf, in name order): the name
# zz-goenn sorts after security.conf, whose ServerTokens OS and ServerSignature On would otherwise
# win over this file's ServerTokens Prod and ServerSignature Off, and Apache's error pages would
# name its version. The test stops the build if another file sorts after it.
COPY docker/apache.conf /etc/apache2/conf-available/zz-goenn.conf
RUN a2enconf zz-goenn \
    && test "$(ls /etc/apache2/conf-enabled | tail -n 1)" = zz-goenn.conf

# ---------------------------------------------------------------- Code
# Liegt unter /var/www/api, shared/ direkt daneben unter /var/www/shared:
# App\Support\BlockedTerms und PasswordPolicy suchen die Listen eine Ebene über
# api/ (dirname(__DIR__, 3)) – genau wie im Repo.
WORKDIR /var/www/api

# ================================================================ build (never shipped)
FROM base AS build

COPY --from=php-ext-installer /usr/bin/install-php-extensions /usr/local/bin/
RUN install-php-extensions zip
COPY --from=composer-bin /usr/bin/composer /usr/bin/composer

# Erst nur die Paketlisten: Solange sich composer.lock nicht ändert, überspringt
# der nächste Bau diesen langsamen Schritt (Docker-Schichten-Cache).
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction --no-progress --prefer-dist

COPY . .
COPY --from=shared . /var/www/shared/

# Jetzt mit dem Code: Autoloader bauen und Laravels Paket-Erkennung laufen lassen.
RUN composer dump-autoload --optimize --no-dev --no-interaction

# ================================================================ runtime (the image that runs)
FROM base AS runtime

# The finished code, owned by root: the web server reads it but cannot change it. Only the
# folders Laravel writes to (caches, compiled views, logs) belong to www-data.
#
# No upload folder under the docroot: uploads are not this image's business (see the header).
# The build stops if a public/storage came in with the code (api/.dockerignore keeps the local
# development link out), and docker/apache.conf refuses one mounted there later. Two tests:
# `-e` follows a link and so misses one whose target does not exist in the image; `-L` sees it.
COPY --from=build /var/www/api /var/www/api
COPY --from=build /var/www/shared /var/www/shared
RUN mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views \
               storage/logs bootstrap/cache \
    && chown -R www-data:www-data storage bootstrap/cache \
    && test ! -e public/storage && test ! -L public/storage

COPY docker/entrypoint.sh /usr/local/bin/goenn-entrypoint
RUN chmod 755 /usr/local/bin/goenn-entrypoint

# Not root (F-28): Apache and PHP run as www-data, the user the base image provides for this.
# Its run, lock and log folders are writable for any user, and its logs go to stdout/stderr.
USER www-data:www-data

EXPOSE 8080

# Prüft den Weg bis zur Datenbank (/api/health fragt MySQL ab), nicht nur, ob
# Apache antwortet. `php -r` statt curl: curl ist im Abbild nicht dabei.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD php -r 'exit(str_contains((string) @file_get_contents("http://127.0.0.1:8080/api/health"), "\"ok\":true") ? 0 : 1);'

ENTRYPOINT ["goenn-entrypoint"]
CMD ["apache2-foreground"]
