#!/usr/bin/env bash
# Destructive integration test for a disposable Linux runner with systemd PID 1.
set -euo pipefail

[[ $(id -u) == 0 && $(cat /proc/1/comm) == systemd ]]
[[ ! -e /usr/local/bin/raminga && ! -L /usr/local/bin/raminga ]]
[[ $(systemctl show -p LoadState --value raminga.service) == not-found ]]
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
systemctl --version | sed -n '1p'

binary=$(realpath "$1")
root=$(mktemp -d /var/tmp/raminga-systemd-ci.XXXXXX)
archive=$root/archive
data="$root/node data"
bad="$root/new failure"
account=raminga-ci
unit=/etc/systemd/system/raminga.service
old_pid=
account_created=false
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  if ((rc)); then
    systemctl status raminga.service --no-pager -l
    journalctl -u raminga.service --no-pager -n 80
    for log in "$root"/*.log; do
      [[ ! -f "$log" ]] || { printf '\n%s\n' "$log"; tail -60 "$log"; }
    done
  fi
  systemctl disable --now raminga.service >/dev/null 2>&1
  systemctl reset-failed raminga.service >/dev/null 2>&1
  [[ -z "$old_pid" ]] || kill "$old_pid" 2>/dev/null
  rm -f "$unit" /usr/local/bin/raminga
  systemctl daemon-reload
  if "$account_created"; then userdel "$account"; fi
  rm -rf "$root"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
useradd --system --no-create-home --home-dir "$root/home" "$account"
account_created=true
chmod 0755 "$root"
install -d -m 0700 "$archive"
install -m 0755 "$binary" "$archive/raminga"
install -m 0755 scripts/install.sh "$archive/install.sh"
install -m 0755 "$binary" "$root/raminga"
install -d -m 0700 -o "$account" "$data" "$bad" "$root/home"
as_user() { runuser -u "$account" -- "$@"; }
status() { as_user "$root/raminga" status --data-dir "$data"; }
peer() { sed -n 's/^peer_id: //p'; }
install_service() {
  RAMINGA_INSTALL_WAIT_SECONDS=8 "$archive/install.sh" --service --user "$account" --data-dir "$1"
}
expect_install_failure() {
  local target=$1 log=$2 since
  since=$(date +%s)
  if install_service "$target" >"$log" 2>&1; then
    echo 'FAIL: invalid config reported success' >&2
    return 1
  fi
  if grep -Fq '已安装并启动 systemd 服务' "$log"; then
    echo 'FAIL: unsuccessful install printed success' >&2
    return 1
  fi
  journalctl --since "@$since" -u raminga.service --no-pager -o cat >"$log.journal.log"
  grep -Ei 'config.*(toml|parse)|toml.*(config|line)' "$log.journal.log"
  sleep 2
  [[ $(systemctl show -p MainPID --value raminga.service) == 0 ]] || return 1
  case "$(systemctl show -p ActiveState --value raminga.service)" in
    inactive|failed) ;;
    *) echo 'FAIL: service still running or scheduled to restart' >&2; return 1 ;;
  esac
}

as_user "$root/raminga" init --data-dir "$data" --listen /ip4/127.0.0.1/tcp/0 --dht-mode client
setpriv --reuid="$(id -u "$account")" --regid="$(id -g "$account")" --init-groups \
  "$root/raminga" daemon --api-tcp --data-dir "$data" >"$root/old.log" 2>&1 &
old_pid=$!
before=
for _ in {1..60}; do
  if before=$(status 2>/dev/null); then break; fi
  kill -0 "$old_pid"
  sleep 0.2
done
grep -qx 'supervised: false' <<<"$before"
peer_before=$(peer <<<"$before")
[[ -n "$peer_before" && -f "$data/api.endpoint.json" ]]
key_before=$(sha256sum "$data/identity/key")

install_service "$data" >"$root/migrate.log" 2>&1
grep -F '已安装并启动 systemd 服务' "$root/migrate.log"
systemctl is-active --quiet raminga.service
systemctl is-enabled --quiet raminga.service
after=$(status)
grep -qx 'supervised: true' <<<"$after"
[[ $(peer <<<"$after") == "$peer_before" && $(sha256sum "$data/identity/key") == "$key_before" ]]
if kill -0 "$old_pid" 2>/dev/null; then
  echo 'FAIL: original daemon is still running' >&2
  exit 1
fi
wait "$old_pid"
old_pid=
pid_before=$(systemctl show -p MainPID --value raminga.service)
[[ "$pid_before" == [1-9]* ]]
unit_before=$(sha256sum "$unit")
echo 'PASS: non-root HTTPS daemon migrated; old process exited; service active and enabled; Peer ID and key preserved'

install_service "$data" >"$root/upgrade.log" 2>&1
systemctl is-active --quiet raminga.service
pid_after=$(systemctl show -p MainPID --value raminga.service)
[[ "$pid_after" == [1-9]* && "$pid_after" != "$pid_before" ]]
[[ $(status | peer) == "$peer_before" && $(sha256sum "$unit") == "$unit_before" ]]
echo 'PASS: existing service restarted; unit and identity preserved'

systemctl stop raminga.service
printf '[network\n' >"$data/config.toml"
expect_install_failure "$data" "$root/existing-failure.log"
[[ -f "$unit" && $(sha256sum "$unit") == "$unit_before" ]]
[[ $(sha256sum "$data/identity/key") == "$key_before" ]]
echo 'PASS: existing unit preserved and stopped after startup failure'

systemctl disable raminga.service
rm "$unit"
systemctl daemon-reload
# Use a distinct journal timestamp so this case proves the new unit executed.
sleep 2
printf '[network\n' >"$bad/config.toml"
expect_install_failure "$bad" "$root/new-failure.log"
[[ ! -e "$unit" && ! -L /etc/systemd/system/multi-user.target.wants/raminga.service ]]
[[ $(systemctl show -p LoadState --value raminga.service) == not-found ]]
echo 'PASS: failed fresh installation removed the unit and enable link'
