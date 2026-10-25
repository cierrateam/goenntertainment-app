# Image of the Node backend (server/).
#
# Node 22 is a long-term-support line: it gets security fixes until 2027-04-30 (its end of
# life in the Node.js release schedule). Move to the next LTS line before that date; CI's
# NODE_VERSION (.github/workflows/ci.yml) moves with it, and scripts/ci/check-mirrors.mjs fails
# while the two differ.
#
# The base image is pinned by digest (the multi-arch index of node:22-alpine), so every build
# starts from the same bytes; Dependabot proposes new digests (.github/dependabot.yml). By hand:
# `docker buildx imagetools inspect node:22-alpine` prints the current one; every copy of a pin
# moves in the same change.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

WORKDIR /app

# Erst nur die Paketlisten kopieren, dann installieren. Docker legt jede Zeile
# als eigene Schicht ab: solange sich package-lock.json nicht aendert, ueberspringt
# der naechste Bau das `npm ci` komplett und ist in Sekunden fertig.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Gemeinsame Listen von App, Laravel und Node (shared/ im Repo): gesperrte
# Begriffe, haeufige Passwoerter. Sie liegen AUSSERHALB von server/ und damit
# ausserhalb dieses Baukontexts - deploy/docker-compose.yml reicht den Ordner als
# zweiten, benannten Kontext `shared` herein. Ziel /shared, weil der Code die
# Dateien zwei Ebenen ueber src/ sucht (/app/src -> /shared), genau wie im Repo.
#
# Ohne den Kontext bricht der Bau hier ab - gewollt: Ohne die Liste gesperrter
# Begriffe startet der Server ohnehin nicht. Von Hand bauen:
#   docker build --build-context shared=../shared .
COPY --from=shared . /shared/

# In the compose, the named volumes uploads and private-media lie over storage/ and
# storage-private/. Das Anlegen hier ist fuer den Fall, dass jemand das Abbild ohne
# Mount startet – sonst wirft express.static beim ersten Bild-Aufruf.
# storage-private/ holds evidence and story images (F-11, src/storage.js): never served as static
# files, never mounted into a web server.
RUN mkdir -p storage/avatars storage/banners storage/posts storage/user-banners \
             storage-private/evidence storage-private/stories

# Nicht als root laufen. Das Abbild bringt den Benutzer `node` schon mit; er
# braucht Schreibrecht auf storage/, weil dort die Uploads landen.
RUN chown -R node:node /app/storage /app/storage-private

# Production build: the server checks its required settings before it starts and refuses to
# run without them (src/config.js). The compose sets the same value.
ENV NODE_ENV=production
USER node

EXPOSE 8000

CMD ["node", "src/index.js"]
