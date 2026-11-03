#!/usr/bin/env bash
# Sourced by the backup tests: throwaway gpg SIGNING keys (never real keys; every homedir is a temp dir).
# mk_signkey <homedir> <label> [faked-system-time]  -> prints the PRIMARY fingerprint; creates an ed25519 sign-only key without passphrase (expires: never, or 1d from the faked time).
# pub_export <homedir> <fpr> <outfile>             -> exported PUBLIC key (what BACKUP_VERIFY_KEYRING points to)
mk_signkey() {
  local h="$1" label="$2" fake="${3:-}"; mkdir -p "$h"; chmod 700 "$h"
  if [[ -n "$fake" ]]; then
    gpg --homedir "$h" --batch --quiet --pinentry-mode loopback --passphrase '' --faked-system-time "$fake" --quick-generate-key "velto-test-$label" ed25519 sign 1d >/dev/null 2>&1
  else
    gpg --homedir "$h" --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key "velto-test-$label" ed25519 sign never >/dev/null 2>&1
  fi
  gpg --homedir "$h" --batch --with-colons --list-keys 2>/dev/null | awk -F: '/^fpr/{print $10; exit}'
}
pub_export() { gpg --homedir "$1" --batch --export "$2" > "$3" 2>/dev/null; }
kill_agents() { local h; for h in "$@"; do gpgconf --homedir "$h" --kill all >/dev/null 2>&1; done; }
# rev_pub <homedir> <fpr> <outfile>: REVOKES the key in that (throwaway) homedir and exports the public key WITH the revocation certificate.
rev_pub() {
  local tmp; tmp="$(mktemp)"
  printf 'y\n0\n\ny\n' | gpg --homedir "$1" --yes --no-tty --command-fd 0 --pinentry-mode loopback --passphrase '' --output "$tmp" --gen-revoke "$2" >/dev/null 2>&1
  gpg --homedir "$1" --batch --import "$tmp" >/dev/null 2>&1; gpg --homedir "$1" --batch --export "$2" > "$3" 2>/dev/null; rm -f "$tmp"
}

# flipbyte <file> <offset>: replace that byte by a DIFFERENT value (never a no-op, unlike writing a fixed byte into random data)
flipbyte() { local b; b="$(dd if="$1" bs=1 skip="$2" count=1 2>/dev/null | od -An -tu1 | tr -d ' ')"; printf "$(printf '\\%03o' $(( (b + 1) % 256 )))" | dd of="$1" bs=1 seek="$2" conv=notrunc 2>/dev/null; }
