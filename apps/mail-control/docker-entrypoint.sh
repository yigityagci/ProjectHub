#!/bin/sh
# ProjectHub self-hosted Postfix — container entrypoint.
#
# Does one-time-per-boot setup (re-asserting the baked-in security
# invariants from main.cf.base onto whatever main.cf the persistent
# `postfix-config` volume currently has, and fixing up directory
# ownership/permissions), then hands off to supervisord, which is what
# actually runs Postfix, OpenDKIM, and the mail-control listener for the
# lifetime of the container. This script never runs again until the
# container restarts — it is NOT part of the mail-control listener's own
# request-handling path.
set -eu

# --- 1. Re-assert the baked-in security invariants onto main.cf -----------
# /etc/postfix is a named volume (see docker-compose.yml's `postfix-config`
# volume) — on a brand-new volume Docker pre-populates it from the image's
# apt-installed postfix defaults, NOT from main.cf.base directly. Applying
# every line of main.cf.base via `postconf -e` on every boot (not just the
# first) guarantees these invariants are always in force even if the
# persisted main.cf was hand-edited, is stale, or predates this image
# version — same idempotent, additive mechanism the mail-control listener
# itself uses for typed fields (see src/postfix.ts#buildPostconfArgs).
if [ -f /etc/postfix/main.cf.base ]; then
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    /usr/sbin/postconf -e "$line"
  done < /etc/postfix/main.cf.base
fi

# --- 2. Directory ownership / permissions ---------------------------------
mkdir -p /var/spool/postfix
chown -R postfix:postfix /var/spool/postfix

mkdir -p /etc/opendkim/keys
chown -R opendkim:opendkim /etc/opendkim/keys
chmod 750 /etc/opendkim/keys

mkdir -p /var/run/opendkim
chown opendkim:opendkim /var/run/opendkim

mkdir -p /var/run
touch /etc/opendkim/KeyTable /etc/opendkim/SigningTable /etc/opendkim/TrustedHosts
chown opendkim:opendkim /etc/opendkim/KeyTable /etc/opendkim/SigningTable /etc/opendkim/TrustedHosts

mkdir -p /home/mailctl
chown mailctl:mailctl /home/mailctl

# --- 3. Hand off to supervisord (PID 1 from here on) ----------------------
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
