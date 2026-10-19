#!/bin/sh
# CI AND LOCAL TESTS ONLY - NOT FOR A SERVER. Makes a throw-away PKI for the deploy tests
# (deploy/test/), in place of what Cloudflare and Cierra's private CA provide on a server
# (deploy/README.md, Origin certificate and Authenticated Origin Pulls). The tests run it in the
# pinned MySQL image, which has openssl, without a network:
#
#   sh throwaway-pki.sh <folder> <domain>
#
# <folder>/edge/           what the edge loads from ORIGIN_TLS_DIR:
#   origin-cert.pem          an origin certificate for <domain> and *.<domain>, as Cloudflare's
#                            Origin CA issues one by default
#   origin-key.pem           its private key (mode 600)
#   origin-pull-ca.pem       the CA that signed client-cert.pem
# <folder>/cloudflare/     what the stack test's probe presents and trusts in Cloudflare's place:
#   client-cert.pem,         a client certificate of that CA (extended key usage clientAuth),
#   client-key.pem           which the edge accepts
#   origin-ca.pem            the CA that signed origin-cert.pem, to verify the edge with
#   other-cert.pem,          a client certificate of another CA, which the edge refuses
#   other-key.pem
#
# Everything is valid for one day. The CA keys stay in a temporary folder of the container and
# are gone with it; nothing is printed but the file names. On a host folder, create
# <folder>/edge and <folder>/cloudflare first: files written as root into folders of your own
# can be removed without root.
set -eu

out=${1:?usage: throwaway-pki.sh <folder> <domain>}
domain=${2:?usage: throwaway-pki.sh <folder> <domain>}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out/edge" "$out/cloudflare"

key() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null
}

# ca <name> <key> <certificate>
ca() {
  key "$2"
  openssl req -x509 -new -key "$2" -sha256 -days 1 -subj "/CN=throwaway $1" \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -out "$3"
}

# leaf <CA key> <CA certificate> <common name> <extensions> <key> <certificate>
leaf() {
  key "$5"
  openssl req -new -key "$5" -subj "/CN=$3" -out "$work/leaf.csr"
  printf '%s\n' "$4" > "$work/leaf.ext"
  openssl x509 -req -in "$work/leaf.csr" -CA "$2" -CAkey "$1" -CAserial "$work/serial" -CAcreateserial \
    -days 1 -sha256 -extfile "$work/leaf.ext" -out "$6" 2>/dev/null
}

ca 'origin CA' "$work/origin-ca.key" "$out/cloudflare/origin-ca.pem"
leaf "$work/origin-ca.key" "$out/cloudflare/origin-ca.pem" "$domain" \
  "subjectAltName=DNS:$domain,DNS:*.$domain
extendedKeyUsage=serverAuth
basicConstraints=CA:FALSE" \
  "$out/edge/origin-key.pem" "$out/edge/origin-cert.pem"

ca 'origin-pull CA' "$work/pull-ca.key" "$out/edge/origin-pull-ca.pem"
leaf "$work/pull-ca.key" "$out/edge/origin-pull-ca.pem" 'throwaway origin-pull client' \
  "extendedKeyUsage=clientAuth
basicConstraints=CA:FALSE" \
  "$out/cloudflare/client-key.pem" "$out/cloudflare/client-cert.pem"

ca 'other CA' "$work/other-ca.key" "$work/other-ca.pem"
leaf "$work/other-ca.key" "$work/other-ca.pem" 'throwaway client of another CA' \
  "extendedKeyUsage=clientAuth
basicConstraints=CA:FALSE" \
  "$out/cloudflare/other-key.pem" "$out/cloudflare/other-cert.pem"

# The edge reads its key as root (owner); the test reads the client side as itself.
chmod 600 "$out/edge/origin-key.pem"
chmod 644 "$out/edge/origin-cert.pem" "$out/edge/origin-pull-ca.pem" "$out/cloudflare/"*.pem
ls "$out/edge" "$out/cloudflare"
