#!/bin/sh
# Isolated systemd-install test harness. Run inside a disposable Linux
# container (tests/install/systemd.sh does this). The real Raminga binary and
# the real local API are used; only systemctl/journalctl are stand-ins.
set -eu

INSTALL_SH=${1:?install.sh path}
BIN=${2:?linux raminga binary}
FAKEBIN=${3:?fakebin directory}

TESTROOT=${TESTROOT:-/tmp/raminga-install-test}
DATA_ROOT=$TESTROOT/data
FAKE_STATE=${FAKE_SYSTEMD_STATE:-/run/fake-systemd}
UNIT=/etc/systemd/system/raminga.service
DEST=/usr/local/bin/raminga
TEST_USER=${RAMINGA_INSTALL_TEST_USER:-raminga-test}
TESTBIN=/usr/local/bin/raminga-testbin
export FAKE_SYSTEMD_STATE=$FAKE_STATE
export PATH=$FAKEBIN:$PATH
export RAMINGA_INSTALL_WAIT_SECONDS=${RAMINGA_INSTALL_WAIT_SECONDS:-5}
unset FAKE_SYSTEMD_FAIL_START FAKE_SYSTEMD_NEVER_ACTIVE FAKE_SYSTEMD_EXIT_AFTER_START FAKE_SYSTEMD_UNSUPERVISED 2>/dev/null || true

if ! id -u "$TEST_USER" >/dev/null 2>&1; then
	if command -v adduser >/dev/null 2>&1; then
		adduser -D -s /bin/sh "$TEST_USER" >/dev/null
	else
		useradd -m -s /bin/sh "$TEST_USER"
	fi
fi
TEST_UID=$(id -u "$TEST_USER")
TEST_GID=$(id -g "$TEST_USER")

mkdir -p /run/systemd/system /etc/systemd/system /usr/local/bin "$DATA_ROOT" "$FAKE_STATE"

# The installer archive is root-only, like a `sudo` run from a private path.
# The non-root test must go through install.sh's staging path, never fall back
# to running the CLI as root.
ROOT_ARCHIVE=$TESTROOT/root-archive
rm -rf "$ROOT_ARCHIVE"
mkdir -p "$ROOT_ARCHIVE"
chmod 0700 "$ROOT_ARCHIVE"
cp "$INSTALL_SH" "$ROOT_ARCHIVE/install.sh"
cp "$BIN" "$ROOT_ARCHIVE/raminga"
chmod 0755 "$ROOT_ARCHIVE/install.sh" "$ROOT_ARCHIVE/raminga"
INSTALL_SH=$ROOT_ARCHIVE/install.sh
BIN=$ROOT_ARCHIVE/raminga

cp "$BIN" "$TESTBIN"
chmod 0755 "$TESTBIN"
rm -f "$UNIT"
: >"$FAKE_STATE/calls.log"

PASS=0
FAIL=0

assert() {
	_desc=$1
	shift
	if "$@"; then
		PASS=$((PASS + 1))
		printf 'PASS %s\n' "$_desc"
	else
		FAIL=$((FAIL + 1))
		printf 'FAIL %s\n' "$_desc" >&2
		if [ -f "$TESTROOT/out" ]; then
			sed 's/^/  out: /' "$TESTROOT/out" >&2 || true
		fi
		if [ -f "$TESTROOT/err" ]; then
			sed 's/^/  err: /' "$TESTROOT/err" >&2 || true
		fi
	fi
}

rc_is() { [ "$RC" -eq "$1" ]; }
rc_nonzero() { [ "$RC" -ne 0 ]; }
out_has() { grep -Fq -- "$1" "$TESTROOT/out"; }
out_lacks() { ! grep -Fq -- "$1" "$TESTROOT/out"; }
err_has() { grep -Fq -- "$1" "$TESTROOT/err"; }
unit_exists() { [ -f "$UNIT" ]; }
unit_missing() { [ ! -e "$UNIT" ] && [ ! -L "$UNIT" ]; }
unit_is_symlink() { [ -L "$UNIT" ]; }
unit_has() { grep -Fq -- "$1" "$UNIT"; }
unit_hash() { cksum <"$UNIT"; }
unit_hash_is() { [ "$(unit_hash)" = "$1" ]; }
active() { systemctl is-active --quiet raminga; }
inactive() { ! systemctl is-active --quiet raminga; }
main_pid_is() { [ "$(systemctl show -p MainPID --value raminga)" = "$1" ]; }
no_systemd_pid() { [ ! -f "$FAKE_STATE/pid" ]; }
status_of() { "$BIN" status --data-dir "$1" 2>/dev/null; }
peer_of() { status_of "$1" | sed -n 's/^peer_id: //p' | sed -n '1p'; }
supervised_of() { status_of "$1" | sed -n 's/^supervised: //p' | sed -n '1p'; }
supervised_true() { [ "$(supervised_of "$1")" = true ]; }
peer_is() { [ "$(peer_of "$1")" = "$2" ]; }
key_hash() { cksum <"$1/identity/key"; }
key_is() { [ "$(key_hash "$1")" = "$2" ]; }
pid_alive() { kill -0 "$1" 2>/dev/null; }
pid_dead() { ! kill -0 "$1" 2>/dev/null; }
pid_changed() { [ "$1" != "$2" ]; }
calls_has() { grep -Fq -- "$1" "$FAKE_STATE/calls.log"; }
calls_lack() { ! grep -Fq -- "$1" "$FAKE_STATE/calls.log"; }
clear_calls() { : >"$FAKE_STATE/calls.log"; }

run_install() {
	set +e
	sh "$INSTALL_SH" --service --user root --data-dir "$1" >"$TESTROOT/out" 2>"$TESTROOT/err"
	RC=$?
	set -e
}

run_install_user() {
	set +e
	sh "$INSTALL_SH" --service --user "$2" --data-dir "$1" >"$TESTROOT/out" 2>"$TESTROOT/err"
	RC=$?
	set -e
}

run_user() {
	su -s /bin/sh "$TEST_USER" -c 'exec "$@"' -- sh "$@"
}

wait_api() {
	_i=0
	while [ "$_i" -lt 100 ]; do
		if "$BIN" status --data-dir "$1" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1
		_i=$((_i + 1))
	done
	return 1
}

wait_api_user() {
	_i=0
	while [ "$_i" -lt 100 ]; do
		if run_user "$TESTBIN" status --data-dir "$1" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1
		_i=$((_i + 1))
	done
	return 1
}

as_peer() {
	run_user "$1" status --data-dir "$2" 2>/dev/null | sed -n 's/^peer_id: //p' | sed -n '1p'
}

as_supervised() {
	run_user "$1" status --data-dir "$2" 2>/dev/null | sed -n 's/^supervised: //p' | sed -n '1p'
}

status_ok_as_user() {
	run_user "$1" status --data-dir "$2" >/dev/null 2>&1
}

src_hidden_from_user() {
	! run_user "$BIN" version >/dev/null 2>&1
}

root_status_fails() {
	! "$BIN" status --data-dir "$1" >/dev/null 2>&1
}

no_cli_stage() {
	[ -z "$(find /usr/local/bin -maxdepth 1 -name '.raminga-cli.*' -print -quit 2>/dev/null)" ]
}

new_node() {
	_dir=$DATA_ROOT/$1
	_port=$2
	rm -rf "$_dir"
	if ! "$BIN" init --data-dir "$_dir" \
		--listen "/ip4/127.0.0.1/tcp/$_port" \
		--listen "/ip4/127.0.0.1/udp/$_port/quic-v1" >"$TESTROOT/init.log" 2>&1; then
		cat "$TESTROOT/init.log" >&2 || true
		return 1
	fi
	printf '%s\n' "$_dir"
}

new_node_user() {
	_dir=$DATA_ROOT/$1
	_port=$2
	rm -rf "$_dir"
	mkdir -p "$_dir"
	chown "$TEST_UID:$TEST_GID" "$_dir"
	if ! run_user "$TESTBIN" init --data-dir "$_dir" \
		--listen "/ip4/127.0.0.1/tcp/$_port" \
		--listen "/ip4/127.0.0.1/udp/$_port/quic-v1" >"$TESTROOT/init-user.log" 2>&1; then
		cat "$TESTROOT/init-user.log" >&2 || true
		return 1
	fi
	chown -R "$TEST_UID:$TEST_GID" "$_dir"
	printf '%s\n' "$_dir"
}

start_independent() {
	_dir=$1
	_tag=$2
	_mode=${3:-independent}
	_log=$TESTROOT/independent-$_tag.log
	if [ "$_mode" = supervised ]; then
		(export INVOCATION_ID=fake-other; exec "$BIN" daemon --data-dir "$_dir") >>"$_log" 2>&1 &
	else
		(exec "$BIN" daemon --data-dir "$_dir") >>"$_log" 2>&1 &
	fi
	_pid=$!
	printf '%s\n' "$_pid" >"$TESTROOT/independent.pid"
	if ! wait_api "$_dir"; then
		printf 'independent daemon failed to start; log:\n' >&2
		tail -n 30 "$_log" >&2 || true
		return 1
	fi
	printf '%s\n' "$_pid"
}

start_independent_user() {
	_dir=$1
	_tag=$2
	_log=$TESTROOT/independent-$_tag.log
	run_user "$TESTBIN" daemon --data-dir "$_dir" --api-tcp >>"$_log" 2>&1 &
	_su_pid=$!
	printf '%s\n' "$_su_pid" >"$TESTROOT/independent.pid"
	if ! wait_api_user "$_dir"; then
		printf 'non-root independent daemon failed to start; log:\n' >&2
		tail -n 30 "$_log" >&2 || true
		return 1
	fi
	# su keeps a parent process around, so record the real daemon PID for
	# cleanup/assertions instead of the su wrapper.
	_pid=$(pgrep -u "$TEST_UID" -f "raminga-testbin daemon --data-dir $_dir" 2>/dev/null | sed -n '1p')
	[ -n "$_pid" ] || _pid=$_su_pid
	printf '%s\n' "$_pid" >"$TESTROOT/independent.pid"
	INDEPENDENT_PID=$_pid
}

stop_pid() {
	_pid=$1
	kill -TERM "$_pid" 2>/dev/null || true
	_i=0
	while kill -0 "$_pid" 2>/dev/null && [ "$_i" -lt 100 ]; do
		sleep 0.05
		_i=$((_i + 1))
	done
	if kill -0 "$_pid" 2>/dev/null; then
		kill -KILL "$_pid" 2>/dev/null || true
	fi
	wait "$_pid" 2>/dev/null || true
	if [ -f "$TESTROOT/independent.pid" ] && [ "$(cat "$TESTROOT/independent.pid")" = "$_pid" ]; then
		rm -f "$TESTROOT/independent.pid"
	fi
}

reset_unit() {
	systemctl stop raminga >/dev/null 2>&1 || true
	systemctl disable raminga >/dev/null 2>&1 || true
	rm -f "$UNIT"
	rm -rf "$UNIT.d"
	clear_calls
}

cleanup() {
	systemctl stop raminga >/dev/null 2>&1 || true
	systemctl disable raminga >/dev/null 2>&1 || true
	if [ -f "$TESTROOT/independent.pid" ]; then
		_left=$(cat "$TESTROOT/independent.pid")
		if [ -n "$_left" ]; then
			kill -TERM "$_left" 2>/dev/null || true
			kill -KILL "$_left" 2>/dev/null || true
		fi
	fi
	rm -f "$UNIT"
}
trap cleanup EXIT HUP INT TERM

# ---------------------------------------------------------------------------
# 1. Fresh service install: unit, health, and the created identity.
# ---------------------------------------------------------------------------
printf '\n== fresh service install ==\n'
reset_unit
d=$(new_node fresh 42101)
run_install "$d"
assert 'fresh: exit 0' rc_is 0
assert 'fresh: success only after health' out_has '已安装并启动 systemd 服务 raminga'
assert 'fresh: unit exists' unit_exists
assert 'fresh: unit User=root' unit_has 'User=root'
assert 'fresh: unit ExecStart points at test binary' unit_has "ExecStart=\"$DEST\" daemon --data-dir \"$d\""
assert 'fresh: systemd active' active
assert 'fresh: API supervised=true' supervised_true "$d"
peer=$(peer_of "$d")
key=$(key_hash "$d")
assert 'fresh: API has a peer id' [ -n "$peer" ]
assert 'fresh: used enable --now' calls_has 'enable --now raminga'

# ---------------------------------------------------------------------------
# 2. Upgrade an existing unit: restart (not enable), identity and key preserved.
# ---------------------------------------------------------------------------
printf '\n== existing unit upgrade ==\n'
clear_calls
unit_before=$(unit_hash)
pid_before=$(systemctl show -p MainPID --value raminga)
run_install "$d"
pid_after=$(systemctl show -p MainPID --value raminga)
assert 'upgrade: exit 0' rc_is 0
assert 'upgrade: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'upgrade: used restart' calls_has 'restart raminga'
assert 'upgrade: did not use enable --now' calls_lack 'enable --now raminga'
assert 'upgrade: systemd active' active
assert 'upgrade: supervised API' supervised_true "$d"
assert 'upgrade: peer id preserved' peer_is "$d" "$peer"
assert 'upgrade: identity key unchanged' key_is "$d" "$key"
assert 'upgrade: new process' pid_changed "$pid_before" "$pid_after"
assert 'upgrade: existing unit not rewritten' unit_hash_is "$unit_before"

# ---------------------------------------------------------------------------
# 2b. A valid existing unit with local customization is reused, not rewritten.
# ---------------------------------------------------------------------------
printf '\n== existing unit customization preserved ==\n'
sed -i 's/^Restart=on-failure$/Restart=always/' "$UNIT"
sed -i '/^\[Service\]$/a Environment=RAMINGA_INSTALL_TEST=1' "$UNIT"
systemctl daemon-reload
systemctl restart raminga
wait_api "$d"
custom_unit_hash=$(unit_hash)
custom_peer=$(peer_of "$d")
clear_calls
run_install "$d"
assert 'custom-upgrade: exit 0' rc_is 0
assert 'custom-upgrade: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'custom-upgrade: unit byte-for-byte preserved' unit_hash_is "$custom_unit_hash"
assert 'custom-upgrade: systemd active' active
assert 'custom-upgrade: supervised API' supervised_true "$d"
assert 'custom-upgrade: peer preserved' peer_is "$d" "$custom_peer"
assert 'custom-upgrade: used restart' calls_has 'restart raminga'

# ---------------------------------------------------------------------------
# 2c. A unit written by the older installer (unquoted ExecStart) is accepted.
# ---------------------------------------------------------------------------
printf '\n== legacy unquoted unit ==\n'
reset_unit
legacy_dir=$(new_node legacy 42118)
cat >"$UNIT" <<EOF
[Unit]
Description=Raminga node
Wants=network-online.target
After=network-online.target

[Service]
User=root
ExecStart=$DEST daemon --data-dir $legacy_dir
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
legacy_hash=$(unit_hash)
clear_calls
run_install "$legacy_dir"
assert 'legacy-unit: exit 0' rc_is 0
assert 'legacy-unit: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'legacy-unit: unit not rewritten' unit_hash_is "$legacy_hash"
assert 'legacy-unit: used restart' calls_has 'restart raminga'
assert 'legacy-unit: systemd active' active
assert 'legacy-unit: supervised API' supervised_true "$legacy_dir"

# ---------------------------------------------------------------------------
# 3. Existing inactive unit + independent daemon: stop via API, restart unit.
# ---------------------------------------------------------------------------
printf '\n== migrate independent daemon with an existing unit ==\n'
systemctl stop raminga >/dev/null 2>&1 || true
assert 'migrate-with-unit: unit inactive before test' inactive
ind_pid=$(start_independent "$legacy_dir" with-unit independent)
peer_migrate=$(peer_of "$legacy_dir")
key_migrate=$(key_hash "$legacy_dir")
unit_before=$(unit_hash)
clear_calls
run_install "$legacy_dir"
assert 'migrate-with-unit: exit 0' rc_is 0
assert 'migrate-with-unit: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'migrate-with-unit: old daemon stopped' pid_dead "$ind_pid"
assert 'migrate-with-unit: systemd active' active
assert 'migrate-with-unit: supervised API' supervised_true "$legacy_dir"
assert 'migrate-with-unit: peer id preserved' peer_is "$legacy_dir" "$peer_migrate"
assert 'migrate-with-unit: identity key unchanged' key_is "$legacy_dir" "$key_migrate"
assert 'migrate-with-unit: used restart' calls_has 'restart raminga'
assert 'migrate-with-unit: unit not rewritten' unit_hash_is "$unit_before"
rm -f "$TESTROOT/independent.pid"

# ---------------------------------------------------------------------------
# 4. No existing unit + independent daemon: enable --now after safe stop.
# ---------------------------------------------------------------------------
printf '\n== migrate independent daemon without a unit ==\n'
reset_unit
d2=$(new_node migrate 42102)
ind_pid=$(start_independent "$d2" no-unit independent)
peer_migrate=$(peer_of "$d2")
key_migrate=$(key_hash "$d2")
clear_calls
run_install "$d2"
assert 'migrate: exit 0' rc_is 0
assert 'migrate: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'migrate: old daemon stopped' pid_dead "$ind_pid"
assert 'migrate: systemd active' active
assert 'migrate: supervised API' supervised_true "$d2"
assert 'migrate: peer id preserved' peer_is "$d2" "$peer_migrate"
assert 'migrate: identity key unchanged' key_is "$d2" "$key_migrate"
assert 'migrate: used enable --now' calls_has 'enable --now raminga'
rm -f "$TESTROOT/independent.pid"

# ---------------------------------------------------------------------------
# 4b. Non-root service user + real HTTPS daemon: the installer must not run
#     status/stop as root, and must stage the root-only archive safely.
# ---------------------------------------------------------------------------
printf '\n== non-root HTTPS migration ==\n'
reset_unit
assert 'nonroot-https: archive SRC inaccessible to service user' src_hidden_from_user
d_nr=$(new_node_user nonroot-https 42122)
start_independent_user "$d_nr" nonroot-https
ind_pid=$INDEPENDENT_PID
assert 'nonroot-https: HTTPS endpoint exists' [ -f "$d_nr/api.endpoint.json" ]
assert 'nonroot-https: endpoint owner is service user' [ "$(stat -c '%u' "$d_nr/api.endpoint.json")" = "$TEST_UID" ]
assert 'nonroot-https: endpoint is owner-only' [ "$(stat -c '%a' "$d_nr/api.endpoint.json")" = 600 ]
assert 'nonroot-https: root status fails endpoint UID check' root_status_fails "$d_nr"
assert 'nonroot-https: service user status works' status_ok_as_user "$TESTBIN" "$d_nr"
nr_peer=$(as_peer "$TESTBIN" "$d_nr")
nr_key=$(key_hash "$d_nr")
assert 'nonroot-https: status exposes peer id' [ -n "$nr_peer" ]
cat >"$UNIT" <<EOF
[Unit]
Description=Raminga node (non-root HTTPS test)

[Service]
User=$TEST_USER
ExecStart="$DEST" daemon --data-dir "$d_nr" --api-tcp
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
nr_unit_hash=$(unit_hash)
clear_calls
run_install_user "$d_nr" "$TEST_USER"
assert 'nonroot-https: exit 0' rc_is 0
assert 'nonroot-https: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'nonroot-https: independent daemon stopped' pid_dead "$ind_pid"
assert 'nonroot-https: systemd active' active
assert 'nonroot-https: supervised API as service user' [ "$(as_supervised "$DEST" "$d_nr")" = true ]
assert 'nonroot-https: peer id preserved' [ "$(as_peer "$DEST" "$d_nr")" = "$nr_peer" ]
assert 'nonroot-https: identity key unchanged' key_is "$d_nr" "$nr_key"
assert 'nonroot-https: endpoint still owned by service user' [ "$(stat -c '%u' "$d_nr/api.endpoint.json")" = "$TEST_UID" ]
assert 'nonroot-https: used restart' calls_has 'restart raminga'
assert 'nonroot-https: existing unit not rewritten' unit_hash_is "$nr_unit_hash"
assert 'nonroot-https: staged CLI cleaned up' no_cli_stage
rm -f "$TESTROOT/independent.pid"

# ---------------------------------------------------------------------------
# 5. Existing unit points to another data dir: refuse and leave it running.
# ---------------------------------------------------------------------------
printf '\n== conflicting existing unit ==\n'
reset_unit
other=$(new_node other 42103)
target=$(new_node target 42104)
cat >"$UNIT" <<EOF
[Unit]
Description=Raminga node
Wants=network-online.target
After=network-online.target

[Service]
User=root
ExecStart="$DEST" daemon --data-dir "$other"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl start raminga
wait_api "$other"
other_peer=$(peer_of "$other")
unit_before=$(unit_hash)
clear_calls
run_install "$target"
assert 'unit-conflict: nonzero exit' rc_nonzero
assert 'unit-conflict: explains data-dir mismatch' err_has '不一致'
assert 'unit-conflict: did not rewrite unit' unit_hash_is "$unit_before"
assert 'unit-conflict: existing service still active' active
assert 'unit-conflict: existing peer unchanged' peer_is "$other" "$other_peer"
assert 'unit-conflict: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'unit-conflict: did not stop other service' calls_lack 'stop raminga'

# ---------------------------------------------------------------------------
# 5b. Existing unit names another service user: refuse, leave the unit alone.
# ---------------------------------------------------------------------------
printf '\n== conflicting existing unit user ==\n'
reset_unit
target=$(new_node unit-user 42117)
cat >"$UNIT" <<EOF
[Unit]
Description=Raminga node

[Service]
User=65534
ExecStart="$DEST" daemon --data-dir "$target"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
unit_before=$(unit_hash)
clear_calls
run_install "$target"
assert 'unit-user-conflict: nonzero exit' rc_nonzero
assert 'unit-user-conflict: explains User mismatch' err_has 'User=65534'
assert 'unit-user-conflict: did not rewrite unit' unit_hash_is "$unit_before"
assert 'unit-user-conflict: no service started' inactive
assert 'unit-user-conflict: no success message' out_lacks '已安装并启动 systemd 服务 raminga'

# ---------------------------------------------------------------------------
# 5c. Any standard systemd drop-in is refused before touching the unit.
# ---------------------------------------------------------------------------
printf '\n== drop-in override ==\n'
reset_unit
dropin_dir=/run/systemd/system/raminga.service.d
rm -rf "$dropin_dir"
mkdir -p "$dropin_dir"
printf '[Service]\nEnvironment=RAMINGA_DROPIN_TEST=1\n' >"$dropin_dir/override.conf"
target=$(new_node dropin-target 42120)
run_install "$target"
assert 'dropin: nonzero exit' rc_nonzero
assert 'dropin: explains drop-in' err_has 'drop-in'
assert 'dropin: no unit installed' unit_missing
assert 'dropin: no service started' inactive
assert 'dropin: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
rm -rf "$dropin_dir"

# ---------------------------------------------------------------------------
# 6. A symlinked unit is refused rather than followed.
# ---------------------------------------------------------------------------
printf '\n== symlinked unit ==\n'
reset_unit
target=$(new_node symlink-target 42105)
ln -s "$TESTROOT/not-a-unit" "$UNIT"
run_install "$target"
assert 'symlink-unit: nonzero exit' rc_nonzero
assert 'symlink-unit: explains symlink' err_has '符号链接'
assert 'symlink-unit: symlink preserved' unit_is_symlink
assert 'symlink-unit: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'symlink-unit: no service started' inactive

# ---------------------------------------------------------------------------
# 6b. systemd says raminga.service is active but /etc has no unit file: refuse.
# ---------------------------------------------------------------------------
printf '\n== active unit outside /etc ==\n'
reset_unit
outside_unit=/run/systemd/system/raminga.service
outside_dir=$(new_node outside 42121)
cat >"$outside_unit" <<EOF
[Unit]
Description=Raminga node (outside /etc)

[Service]
User=root
ExecStart="$DEST" daemon --data-dir "$outside_dir"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$outside_unit"
FAKE_SYSTEMD_UNIT="$outside_unit" systemctl daemon-reload
FAKE_SYSTEMD_UNIT="$outside_unit" systemctl start raminga
wait_api "$outside_dir"
assert 'outside-unit: setup daemon supervised' supervised_true "$outside_dir"
clear_calls
run_install "$outside_dir"
assert 'outside-unit: nonzero exit' rc_nonzero
assert 'outside-unit: explains outside unit' err_has '同名 unit'
assert 'outside-unit: no /etc unit installed' unit_missing
assert 'outside-unit: outside service still active' active
assert 'outside-unit: outside daemon still supervised' supervised_true "$outside_dir"
assert 'outside-unit: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
FAKE_SYSTEMD_UNIT="$outside_unit" systemctl stop raminga
rm -f "$outside_unit"
systemctl daemon-reload

# ---------------------------------------------------------------------------
# 6c. An inactive same-named unit outside /etc must not be shadowed either.
# ---------------------------------------------------------------------------
printf '\n== inactive unit outside /etc ==\n'
reset_unit
outside_unit=/run/systemd/system/raminga.service
outside_dir=$(new_node outside-inactive 42123)
cat >"$outside_unit" <<EOF
[Unit]
Description=Raminga node (inactive outside /etc)

[Service]
User=root
ExecStart="$DEST" daemon --data-dir "$outside_dir"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$outside_unit"
systemctl daemon-reload
assert 'outside-inactive: setup unit inactive' inactive
clear_calls
run_install "$outside_dir"
assert 'outside-inactive: nonzero exit' rc_nonzero
assert 'outside-inactive: explains outside unit' err_has '同名 unit'
assert 'outside-inactive: no /etc unit installed' unit_missing
assert 'outside-inactive: outside unit preserved' [ -f "$outside_unit" ]
assert 'outside-inactive: service stays inactive' inactive
assert 'outside-inactive: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
rm -f "$outside_unit"
systemctl daemon-reload

# ---------------------------------------------------------------------------
# 7. A supervised node owned by another systemd unit is never stopped.
# ---------------------------------------------------------------------------
printf '\n== foreign supervised daemon ==\n'
reset_unit
d3=$(new_node foreign 42106)
ind_pid=$(start_independent "$d3" foreign supervised)
foreign_peer=$(peer_of "$d3")
clear_calls
run_install "$d3"
assert 'foreign-supervised: nonzero exit' rc_nonzero
assert 'foreign-supervised: explains other unit' err_has 'supervised=true'
assert 'foreign-supervised: daemon still alive' pid_alive "$ind_pid"
assert 'foreign-supervised: still supervised' supervised_true "$d3"
assert 'foreign-supervised: peer unchanged' peer_is "$d3" "$foreign_peer"
assert 'foreign-supervised: no unit installed' unit_missing
assert 'foreign-supervised: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
stop_pid "$ind_pid"

# ---------------------------------------------------------------------------
# 8. API answers for a different data dir: refuse before stopping anything.
# ---------------------------------------------------------------------------
printf '\n== API data-dir mismatch ==\n'
reset_unit
api_a=$(new_node api-a 42107)
api_b=$(new_node api-b 42108)
ind_pid=$(start_independent "$api_a" api-a independent)
api_a_peer=$(peer_of "$api_a")
ln -s "$api_a/api.sock" "$api_b/api.sock"
cp "$api_a/api.token" "$api_b/api.token"
clear_calls
run_install "$api_b"
assert 'data-dir-mismatch: nonzero exit' rc_nonzero
assert 'data-dir-mismatch: explains data_dir' err_has 'data_dir'
assert 'data-dir-mismatch: original daemon still alive' pid_alive "$ind_pid"
assert 'data-dir-mismatch: original peer unchanged' peer_is "$api_a" "$api_a_peer"
assert 'data-dir-mismatch: no unit installed' unit_missing
assert 'data-dir-mismatch: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
stop_pid "$ind_pid"

# ---------------------------------------------------------------------------
# 9. API socket owned by another account: refuse before stopping anything.
# ---------------------------------------------------------------------------
printf '\n== API owned by another account ==\n'
reset_unit
owner_dir=$(new_node owner 42109)
ind_pid=$(start_independent "$owner_dir" owner independent)
owner_peer=$(peer_of "$owner_dir")
chown 65534:65534 "$owner_dir/api.sock"
clear_calls
run_install "$owner_dir"
assert 'owner: nonzero exit' rc_nonzero
assert 'owner: explains foreign UID' err_has 'UID 65534'
assert 'owner: daemon still alive' pid_alive "$ind_pid"
assert 'owner: peer unchanged' peer_is "$owner_dir" "$owner_peer"
assert 'owner: no unit installed' unit_missing
assert 'owner: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
stop_pid "$ind_pid"

# ---------------------------------------------------------------------------
# 9b. A non-empty foreign directory is not initialized as a new identity.
# ---------------------------------------------------------------------------
printf '\n== foreign data directory ==\n'
reset_unit
foreign_dir=$DATA_ROOT/foreign
rm -rf "$foreign_dir"
mkdir -p "$foreign_dir"
printf "someone else's file\n" >"$foreign_dir/notes.txt"
clear_calls
run_install "$foreign_dir"
assert 'foreign-dir: nonzero exit' rc_nonzero
assert 'foreign-dir: explains refusal' err_has '疑似非 Raminga 数据目录'
assert 'foreign-dir: no identity created' [ ! -e "$foreign_dir/identity" ]
assert 'foreign-dir: no unit installed' unit_missing
assert 'foreign-dir: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'foreign-dir: did not touch other file' grep -Fq "someone else's file" "$foreign_dir/notes.txt"

# ---------------------------------------------------------------------------
# 10. Unusable API discovery: stop and give guidance, do not guess.
# ---------------------------------------------------------------------------
printf '\n== unidentifiable local API state ==\n'
reset_unit
unknown_dir=$(new_node unknown 42110)
printf '{}\n' >"$unknown_dir/api.endpoint.json"
clear_calls
run_install "$unknown_dir"
assert 'unknown-api: nonzero exit' rc_nonzero
assert 'unknown-api: explains refusal' err_has '无法确认'
assert 'unknown-api: no unit installed' unit_missing
assert 'unknown-api: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'unknown-api: no service running' main_pid_is 0

# ---------------------------------------------------------------------------
# 11. Service never becomes active: fail, stop it, remove the new unit.
# ---------------------------------------------------------------------------
printf '\n== service never active ==\n'
reset_unit
never_dir=$(new_node never 42111)
export FAKE_SYSTEMD_NEVER_ACTIVE=1
export RAMINGA_INSTALL_WAIT_SECONDS=3
clear_calls
run_install "$never_dir"
unset FAKE_SYSTEMD_NEVER_ACTIVE
assert 'never-active: nonzero exit' rc_nonzero
assert 'never-active: clear timeout error' err_has '未在'
assert 'never-active: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'never-active: new unit removed' unit_missing
assert 'never-active: service not running' main_pid_is 0
assert 'never-active: no enabled unit' [ "$(systemctl is-enabled raminga 2>/dev/null || true)" != enabled ]

# ---------------------------------------------------------------------------
# 11b. SIGTERM during health wait: cleanup the started service and new unit.
# ---------------------------------------------------------------------------
printf '\n== interrupt during health wait ==\n'
reset_unit
intr_dir=$(new_node interrupt 42119)
export FAKE_SYSTEMD_NEVER_ACTIVE=1
export RAMINGA_INSTALL_WAIT_SECONDS=30
set +e
sh "$INSTALL_SH" --service --user root --data-dir "$intr_dir" >"$TESTROOT/out" 2>"$TESTROOT/err" &
intr_pid=$!
sleep 1
kill -TERM "$intr_pid" 2>/dev/null || true
wait "$intr_pid"
RC=$?
set -e
unset FAKE_SYSTEMD_NEVER_ACTIVE
assert 'interrupt: nonzero exit' rc_nonzero
assert 'interrupt: explains cleanup' err_has '收到中断信号'
assert 'interrupt: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'interrupt: new unit removed' unit_missing
assert 'interrupt: service process stopped' no_systemd_pid

# ---------------------------------------------------------------------------
# 12. systemctl start fails: no success, no unit left behind.
# ---------------------------------------------------------------------------
printf '\n== start failure ==\n'
reset_unit
startfail_dir=$(new_node startfail 42112)
export FAKE_SYSTEMD_FAIL_START=1
export RAMINGA_INSTALL_WAIT_SECONDS=3
run_install "$startfail_dir"
unset FAKE_SYSTEMD_FAIL_START
assert 'start-fail: nonzero exit' rc_nonzero
assert 'start-fail: explains enable --now failure' err_has 'enable --now'
assert 'start-fail: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'start-fail: new unit removed' unit_missing
assert 'start-fail: no process' main_pid_is 0

# ---------------------------------------------------------------------------
# 12b. The unit starts a daemon that reports supervised=false: fail fast and
#      stop it rather than adopting an independent daemon.
# ---------------------------------------------------------------------------
printf '\n== service API is not supervised ==\n'
reset_unit
unsup_dir=$(new_node unsupervised 42116)
export FAKE_SYSTEMD_UNSUPERVISED=1
export RAMINGA_INSTALL_WAIT_SECONDS=3
run_install "$unsup_dir"
unset FAKE_SYSTEMD_UNSUPERVISED
assert 'unsupervised: nonzero exit' rc_nonzero
assert 'unsupervised: explains supervised=false' err_has 'supervised=false'
assert 'unsupervised: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'unsupervised: new unit removed' unit_missing
assert 'unsupervised: no process' main_pid_is 0

# ---------------------------------------------------------------------------
# 13. Daemon dies after start (invalid config): cleanup a new unit.
# ---------------------------------------------------------------------------
printf '\n== daemon exits after start ==\n'
reset_unit
badcfg_dir=$(new_node badcfg 42113)
printf 'this is not valid toml\n' >"$badcfg_dir/config.toml"
export RAMINGA_INSTALL_WAIT_SECONDS=3
run_install "$badcfg_dir"
assert 'bad-config: nonzero exit' rc_nonzero
assert 'bad-config: reports not healthy' err_has '未在'
assert 'bad-config: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'bad-config: new unit removed' unit_missing
assert 'bad-config: no process' main_pid_is 0

# ---------------------------------------------------------------------------
# 14. Failed upgrade of an existing unit: stop it and restore the old unit.
# ---------------------------------------------------------------------------
printf '\n== failed existing-unit upgrade ==\n'
reset_unit
existing_dir=$(new_node existing 42114)
export RAMINGA_INSTALL_WAIT_SECONDS=5
run_install "$existing_dir"
assert 'existing-fail: setup install succeeded' rc_is 0
unit_before=$(unit_hash)
systemctl stop raminga >/dev/null 2>&1 || true
printf 'this is not valid toml\n' >"$existing_dir/config.toml"
export RAMINGA_INSTALL_WAIT_SECONDS=3
run_install "$existing_dir"
assert 'existing-fail: nonzero exit' rc_nonzero
assert 'existing-fail: no success message' out_lacks '已安装并启动 systemd 服务 raminga'
assert 'existing-fail: unit preserved' unit_exists
assert 'existing-fail: unit restored byte-for-byte' unit_hash_is "$unit_before"
assert 'existing-fail: service stopped' main_pid_is 0

# ---------------------------------------------------------------------------
# 15. Data dir with spaces: unit quoting and re-upgrade parser.
# ---------------------------------------------------------------------------
printf '\n== data dir with spaces ==\n'
reset_unit
space_dir=$(new_node 'space dir' 42115)
export RAMINGA_INSTALL_WAIT_SECONDS=5
run_install "$space_dir"
assert 'space: exit 0' rc_is 0
assert 'space: success message' out_has '已安装并启动 systemd 服务 raminga'
assert 'space: unit quotes path' unit_has "ExecStart=\"$DEST\" daemon --data-dir \"$space_dir\""
assert 'space: supervised API' supervised_true "$space_dir"
space_peer=$(peer_of "$space_dir")
clear_calls
run_install "$space_dir"
assert 'space-upgrade: exit 0' rc_is 0
assert 'space-upgrade: used restart' calls_has 'restart raminga'
assert 'space-upgrade: peer preserved' peer_is "$space_dir" "$space_peer"

# ---------------------------------------------------------------------------
# 16. Non-service install still works, and --service + --prefix is rejected.
# ---------------------------------------------------------------------------
printf '\n== non-service regression ==\n'
prefix=$TESTROOT/prefix
set +e
sh "$INSTALL_SH" --prefix "$prefix" --no-modify-path >"$TESTROOT/out" 2>"$TESTROOT/err"
RC=$?
set -e
assert 'non-service: exit 0' rc_is 0
assert 'non-service: binary installed' [ -x "$prefix/raminga" ]
assert 'non-service: installed message' out_has '已安装'

set +e
sh "$INSTALL_SH" --service --prefix "$prefix" >"$TESTROOT/out" 2>"$TESTROOT/err"
RC=$?
set -e
assert 'argument conflict: nonzero exit' rc_nonzero
assert 'argument conflict: explains --prefix' err_has '不能和 --prefix'

printf '\ninstall-test summary: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
