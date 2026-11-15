#!/bin/sh
# Install a Raminga archive binary. Run this from the unpacked archive (next to
# the binary) or from the repository after `make build`.
set -eu

PROG=raminga
PREFIX=
SERVICE=0
MODIFY_PATH=1
SERVICE_USER=
DATA_DIR=
SERVICE_NAME=raminga
SYSTEMD_UNIT_DIR=/etc/systemd/system
WAIT_SECONDS=${RAMINGA_INSTALL_WAIT_SECONDS:-30}

# State filled by service_preflight and install_systemd_service.
UNIT=
UNIT_EXISTS=0
UNIT_ACTIVE=0
UNIT_CREATED=0
UNIT_TMP=
SERVICE_TOUCHED=0
INDEPENDENT=0
BEFORE_PEER=
BEFORE_KEY_CKSUM=
RUN_UID=
RUN_GID=
PREFLIGHT_CLI=
CLI_STAGE=
HEALTH_DETAIL=

usage() {
	cat <<'USAGE'
用法: sh install.sh [--prefix DIR] [--no-modify-path] [--service [--user NAME] [--data-dir DIR]]

默认安装到 ~/.local/bin（root 为 /usr/local/bin）。--prefix 覆盖目录。
目录不在 PATH 时，把它写入 shell 配置（zsh: ~/.zshrc，bash: ~/.bashrc，macOS 的 bash: ~/.bash_profile）。
--no-modify-path 不写配置，只打印要加入的一行。root 和 --service 不写配置。
--service 仅用于 Linux + systemd 的 root 安装。已有 raminga.service 必须指向同一用户和
数据目录，否则脚本会停止并给出指引；目标数据目录已有独立 daemon 时，脚本会先通过本地
API 停止它，再交给 systemd，并在报告成功前等待 systemctl active 与受托管 API 健康。
RAMINGA_INSTALL_WAIT_SECONDS 可覆盖健康检查等待秒数（默认 30，范围 1-300）。
USAGE
}

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 1
}

while [ "$#" -gt 0 ]; do
	case "$1" in
	--prefix)
		[ "$#" -ge 2 ] || die "--prefix 需要一个目录"
		PREFIX=$2
		shift 2
		;;
	--prefix=*)
		PREFIX=${1#*=}
		shift
		;;
	--service)
		SERVICE=1
		shift
		;;
	--no-modify-path)
		MODIFY_PATH=0
		shift
		;;
	--user)
		[ "$#" -ge 2 ] || die "--user 需要一个用户名"
		SERVICE_USER=$2
		shift 2
		;;
	--user=*)
		SERVICE_USER=${1#*=}
		shift
		;;
	--data-dir)
		[ "$#" -ge 2 ] || die "--data-dir 需要一个目录"
		DATA_DIR=$2
		shift 2
		;;
	--data-dir=*)
		DATA_DIR=${1#*=}
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		die "未知参数: $1"
		;;
	esac
done

if [ -n "$SERVICE_USER" ] && [ "$SERVICE" -ne 1 ]; then
	die "--user 只能和 --service 一起使用"
fi
if [ "$SERVICE" -eq 1 ] && [ -n "$PREFIX" ]; then
	die "--service 固定安装到 /usr/local/bin，不能和 --prefix 一起使用"
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$SCRIPT_DIR/raminga" ]; then
	SRC=$SCRIPT_DIR/raminga
elif [ -x "$SCRIPT_DIR/raminga.exe" ]; then
	SRC=$SCRIPT_DIR/raminga.exe
elif [ -x "$SCRIPT_DIR/../bin/raminga" ]; then
	SRC=$SCRIPT_DIR/../bin/raminga
elif [ -x "$PWD/raminga" ]; then
	SRC=$PWD/raminga
else
	die "找不到 raminga 二进制；请在归档解压目录或仓库根目录运行"
fi

if [ -n "${HOME:-}" ]; then
	DEFAULT_PREFIX=$HOME/.local/bin
else
	DEFAULT_PREFIX=
fi
if [ "$SERVICE" -eq 1 ]; then
	DEST_DIR=/usr/local/bin
else
	if [ "$(id -u)" -eq 0 ]; then
		DEST_DIR=${PREFIX:-/usr/local/bin}
	else
		[ -n "$DEFAULT_PREFIX" ] || die "HOME 未设置；请用 --prefix 指定安装目录"
		DEST_DIR=${PREFIX:-$DEFAULT_PREFIX}
	fi
fi
DEST=$DEST_DIR/$PROG

lookup_home() {
	if command -v getent >/dev/null 2>&1; then
		getent passwd "$1" | cut -d: -f6
	else
		awk -F: -v u="$1" '$1 == u { print $6; exit }' /etc/passwd
	fi
}

if [ "$SERVICE" -eq 1 ]; then
	# Fail platform/root checks before resolving a service user, so a non-root
	# invocation gets the real reason instead of a misleading account error.
	[ "$(uname -s)" = Linux ] || die "--service 只在 Linux 上支持"
	[ "$(id -u)" -eq 0 ] || die "--service 需要 root（例如 sudo ./install.sh --service）"
	if [ -n "$SERVICE_USER" ]; then
		RUN_USER=$SERVICE_USER
	elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
		RUN_USER=$SUDO_USER
	else
		die "以 root 直接运行时请用 --user NAME 指定服务用户"
	fi
	id -u "$RUN_USER" >/dev/null 2>&1 || die "用户 $RUN_USER 不存在"
	RUN_HOME=$(lookup_home "$RUN_USER")
	[ -n "$RUN_HOME" ] || die "找不到用户 $RUN_USER 的主目录"
	if [ -z "$DATA_DIR" ]; then
		DATA_DIR=$RUN_HOME/.raminga
	else
		case "$DATA_DIR" in
		/*) ;;
		*) DATA_DIR=$PWD/$DATA_DIR ;;
		esac
	fi
	STATUS_DIR=$DATA_DIR
else
	if [ -n "$DATA_DIR" ]; then
		STATUS_DIR=$DATA_DIR
	elif [ -n "$DEFAULT_PREFIX" ]; then
		STATUS_DIR=$HOME/.raminga
	else
		STATUS_DIR=
	fi
fi

# canonical_path resolves an existing directory to its physical path and
# normalizes the parent of a path that does not exist yet. It is used only for
# comparisons; the unit keeps the path the caller selected.
canonical_path() {
	if [ -d "$1" ]; then
		(CDPATH= cd -- "$1" 2>/dev/null && pwd -P)
	else
		_parent=$(dirname -- "$1")
		_base=$(basename -- "$1")
		if [ -d "$_parent" ]; then
			printf '%s/%s\n' "$(CDPATH= cd -- "$_parent" 2>/dev/null && pwd -P)" "$_base"
		else
			printf '%s\n' "$1"
		fi
	fi
}

same_path() {
	[ "$(canonical_path "$1")" = "$(canonical_path "$2")" ]
}

cleanup_cli_stage() {
	[ -z "$CLI_STAGE" ] || rm -f "$CLI_STAGE"
	CLI_STAGE=
}

# run_cli runs the CLI as RUN_USER with only a minimal environment. The local
# API endpoint check requires the caller's UID to own api.endpoint.json, so root
# cannot inspect a non-root data directory. Running as RUN_USER also keeps root
# from executing code influenced by that account's data directory. The clean
# environment prevents the installer's RAMINGA_API_TCP/proxy settings from
# choosing a different transport than the daemon actually uses.
run_cli() {
	if [ "$RUN_UID" -eq 0 ]; then
		env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
			HOME="$RUN_HOME" USER="$RUN_USER" LOGNAME="$RUN_USER" "$@"
		return
	fi

	_rc_setpriv=$(command -v setpriv 2>/dev/null || true)
	if [ -n "$_rc_setpriv" ] &&
		"$_rc_setpriv" --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups true >/dev/null 2>&1; then
		env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
			HOME="$RUN_HOME" USER="$RUN_USER" LOGNAME="$RUN_USER" \
			"$_rc_setpriv" --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups -- "$@"
		return
	fi

	_rc_su=$(command -v su 2>/dev/null || true)
	[ -n "$_rc_su" ] || die "找不到 setpriv 或 su，无法以服务用户 $RUN_USER 执行本地 API 检查"
	env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
		HOME="$RUN_HOME" USER="$RUN_USER" LOGNAME="$RUN_USER" \
		"$_rc_su" -s /bin/sh "$RUN_USER" -c 'exec "$@"' -- sh "$@"
}

status_field() {
	printf '%s\n' "$2" | sed -n "s/^$1: //p" | sed -n '1p'
}

unit_value() {
	sed -n "s/^$1=//p" "$UNIT" | sed -n '1p'
}

# unit_exec_data_dir understands both unit formats written by this script:
#   ExecStart="/usr/local/bin/raminga" daemon --data-dir "/path with space"
#   ExecStart=/usr/local/bin/raminga daemon --data-dir /path
unit_exec_data_dir() {
	_exec=$1
	_data=$(printf '%s\n' "$_exec" | sed -n 's/.*--data-dir "\([^"]*\)".*/\1/p' | sed -n '1p')
	if [ -n "$_data" ]; then
		printf '%s\n' "$_data"
		return 0
	fi
	_data=$(printf '%s\n' "$_exec" | sed -n 's/.*--data-dir="\([^"]*\)".*/\1/p' | sed -n '1p')
	if [ -n "$_data" ]; then
		printf '%s\n' "$_data"
		return 0
	fi
	_data=$(printf '%s\n' "$_exec" | sed -n 's/.*--data-dir=\([^ ]*\).*/\1/p' | sed -n '1p')
	if [ -n "$_data" ]; then
		printf '%s\n' "$_data"
		return 0
	fi
	printf '%s\n' "$_exec" | sed -n 's/.*--data-dir \([^ ]*\).*/\1/p' | sed -n '1p'
}

# check_api_owner refuses to take over a data directory whose local API files
# belong to another account. The socket/endpoint is created by the daemon
# process, so its owner identifies the account running that daemon.
check_api_owner() {
	[ -n "$RUN_UID" ] || return 0
	for _api_file in "$DATA_DIR/api.sock" "$DATA_DIR/api.token" "$DATA_DIR/api.endpoint.json"; do
		[ -e "$_api_file" ] || [ -L "$_api_file" ] || continue
		_api_owner=$(stat -c '%u' "$_api_file" 2>/dev/null || true)
		[ -n "$_api_owner" ] || continue
		if [ "$_api_owner" != "$RUN_UID" ]; then
			die "本地 API 文件 $_api_file 属于 UID $_api_owner，不是服务用户 $RUN_USER（UID $RUN_UID）；为避免停止其他账号的节点，未做任何修改。请改用正确的 --user/--data-dir，或让该账号停止节点后重试。"
		fi
	done
}

service_preflight() {
	[ "$(uname -s)" = Linux ] || die "--service 只在 Linux 上支持"
	[ "$(id -u)" -eq 0 ] || die "--service 需要 root（例如 sudo ./install.sh --service）"
	command -v systemctl >/dev/null 2>&1 || die "没有 systemctl；--service 需要 systemd"
	[ -d /run/systemd/system ] || die "systemd 没有作为 PID 1 运行；--service 不可用"
	[ -d "$SYSTEMD_UNIT_DIR" ] || die "找不到 $SYSTEMD_UNIT_DIR；--service 需要 systemd"

	case "$WAIT_SECONDS" in
	'' | *[!0-9]*) die "RAMINGA_INSTALL_WAIT_SECONDS 必须是 1-300 的整数" ;;
	esac
	[ "$WAIT_SECONDS" -ge 1 ] && [ "$WAIT_SECONDS" -le 300 ] ||
		die "RAMINGA_INSTALL_WAIT_SECONDS 必须是 1-300 的整数"

	id -u "$RUN_USER" >/dev/null 2>&1 || die "用户 $RUN_USER 不存在"
	RUN_UID=$(id -u "$RUN_USER")
	RUN_GID=$(id -g "$RUN_USER")
	[ -d "$RUN_HOME" ] || die "用户 $RUN_USER 的主目录 $RUN_HOME 不存在"

	case "$DATA_DIR" in
	/) die "数据目录不能是 /" ;;
	*'"'* | *\\* | *'$'* | *'%'*) die "数据目录不能包含双引号、反斜杠、$ 或 %（systemd unit 会解释这些字符）：$DATA_DIR" ;;
	esac
	case "$(canonical_path "$DATA_DIR")" in
	/ | //) die "数据目录不能解析为 /：$DATA_DIR" ;;
	esac

	# Refuse to mint a new identity in an unrelated non-empty directory. This
	# mirrors the CLI's old-data-dir guard, while allowing Raminga runtime files
	# and the launcher cache in a fresh directory.
	if [ -d "$DATA_DIR" ] && [ ! -e "$DATA_DIR/identity" ] && [ ! -e "$DATA_DIR/config.toml" ]; then
		_unknown=$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 \
			! \( -name bin -type d \) \
			! \( -name raminga.lock ! -type d \) ! \( -name daemon.log ! -type d \) \
			! \( -name daemon.log.1 ! -type d \) ! \( -name api.sock ! -type d \) \
			! \( -name api.token ! -type d \) ! \( -name api.endpoint.json ! -type d \) \
			-print -quit 2>/dev/null || true)
		[ -z "$_unknown" ] || die "目标数据目录 $DATA_DIR 非空，但没有 identity/ 或 config.toml；疑似非 Raminga 数据目录。未安装、未启动服务，也未创建身份。请确认后手动运行 raminga init --data-dir $DATA_DIR，或改用正确的 --data-dir。"
	fi

	UNIT=$SYSTEMD_UNIT_DIR/$SERVICE_NAME.service
	if [ -L "$UNIT" ]; then
		die "已有 $UNIT 是符号链接；拒绝覆盖。请用 systemctl cat $SERVICE_NAME 核对，移除或改为普通 unit 后重试。"
	fi
	if [ -e "$UNIT" ] && [ ! -f "$UNIT" ]; then
		die "已有 $UNIT 不是普通文件；拒绝覆盖。请检查该路径后重试。"
	fi

	# A same-named unit in any lower-priority systemd directory is still a real
	# unit. Creating the /etc unit above it would shadow (overwrite) that unit,
	# even when systemd currently reports it inactive, so refuse either way.
	for _outside_unit in \
		"/run/systemd/system/$SERVICE_NAME.service" \
		"/usr/local/lib/systemd/system/$SERVICE_NAME.service" \
		"/usr/lib/systemd/system/$SERVICE_NAME.service" \
		"/lib/systemd/system/$SERVICE_NAME.service"; do
		[ -e "$_outside_unit" ] || [ -L "$_outside_unit" ] || continue
		die "检测到 /etc 之外的同名 unit：$_outside_unit（即使当前 inactive 也不覆盖）。未做任何修改。请用 systemctl cat $SERVICE_NAME 核对来源；移除该 unit 或改为普通 /etc unit 后重试。"
	done

	# systemd reads drop-ins from all of these locations. A drop-in can change
	# User= or ExecStart=, so validating only the /etc unit file would be unsafe.
	_dropins_found=
	for _dropin in \
		"$SYSTEMD_UNIT_DIR/$SERVICE_NAME.service.d" \
		"/run/systemd/system/$SERVICE_NAME.service.d" \
		"/usr/local/lib/systemd/system/$SERVICE_NAME.service.d" \
		"/usr/lib/systemd/system/$SERVICE_NAME.service.d"; do
		[ -d "$_dropin" ] || continue
		if [ -n "$(find "$_dropin" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]; then
			_dropins_found=$_dropin
			break
		fi
	done
	[ -z "$_dropins_found" ] || die "检测到 $_dropins_found 下的 drop-in；脚本不会在未合并的情况下复用/创建 unit。未做任何修改。请先 systemctl cat $SERVICE_NAME 核对并合并/移除 drop-in 后重试。"

	if [ -f "$UNIT" ]; then
		UNIT_EXISTS=1
		_user_lines=$(grep -c '^User=' "$UNIT" 2>/dev/null || true)
		[ "${_user_lines:-0}" -le 1 ] || die "已有 $UNIT 包含多个 User= 行；无法确定服务账号，拒绝继续。请检查 systemctl cat $SERVICE_NAME 并只保留一个 User=。"
		_exec_lines=$(grep -c '^ExecStart=' "$UNIT" 2>/dev/null || true)
		[ "${_exec_lines:-0}" -eq 1 ] || die "已有 $UNIT 必须恰好有一个 ExecStart= 行；拒绝继续。请检查 systemctl cat $SERVICE_NAME。"
		_unit_user=$(unit_value User)
		[ -n "$_unit_user" ] || _unit_user=root
		[ "$_unit_user" = "$RUN_USER" ] ||
			die "已有 $UNIT 的 User=$_unit_user，与本次服务用户 $RUN_USER 不一致；未做任何修改。请先用 systemctl cat $SERVICE_NAME 核对；如确要更换账号，请备份并手动调整 unit 后重试。"

		_unit_exec=$(unit_value ExecStart)
		[ -n "$_unit_exec" ] || die "已有 $UNIT 没有 ExecStart；拒绝覆盖。请检查 systemctl cat $SERVICE_NAME。"
		case "$_unit_exec" in
		"$DEST "* | "\"$DEST\" "*) ;;
		*) die "已有 $UNIT 的 ExecStart 不是 $DEST；拒绝覆盖。请检查 systemctl cat $SERVICE_NAME，备份后移除旧 unit 再重试。" ;;
		esac

		_unit_data=$(unit_exec_data_dir "$_unit_exec")
		[ -n "$_unit_data" ] || die "无法从已有 $UNIT 的 ExecStart 解析 --data-dir；拒绝覆盖。请检查 systemctl cat $SERVICE_NAME。"
		same_path "$_unit_data" "$DATA_DIR" ||
			die "已有 $UNIT 的数据目录是 $_unit_data，与本次 $DATA_DIR 不一致；未停止服务、未做任何修改。请先用 systemctl cat $SERVICE_NAME 核对；如确要迁移，请备份数据目录并手动调整 unit 后重试。"

		_enabled=$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)
		case "$_enabled" in
		masked | masked-runtime) die "$SERVICE_NAME.service 已被 mask；未做任何修改。请先 systemctl unmask $SERVICE_NAME 后重试。" ;;
		esac
	fi

	_active=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)
	case "$(printf '%s\n' "$_active" | sed -n '1p')" in
	active | activating | reloading) UNIT_ACTIVE=1 ;;
	esac
	if [ "$UNIT_EXISTS" -eq 0 ] && [ "$UNIT_ACTIVE" -eq 1 ]; then
		die "systemd 报告 $SERVICE_NAME.service 处于 active，但 $UNIT 不存在；它可能由 /run 或 /usr/lib 下的同名 unit 启动。为避免误停或覆盖其他 unit，未做任何修改。请用 systemctl cat $SERVICE_NAME 确认来源后再处理。"
	fi

	# A root-only archive path is common when the installer was unpacked as
	# root. The service user must run status/stop, so stage a root-owned,
	# non-writable copy instead of falling back to running the CLI as root.
	PREFLIGHT_CLI=$SRC
	if [ "$RUN_UID" -ne 0 ] && ! run_cli "$SRC" version >/dev/null 2>&1; then
		mkdir -p "$DEST_DIR" || die "无法创建安装目录 $DEST_DIR（用于暂存服务用户可执行的 CLI）"
		CLI_STAGE=$(mktemp "$DEST_DIR/.raminga-cli.XXXXXX") ||
			die "无法在 $DEST_DIR 创建服务用户可执行的暂存 CLI"
		trap 'cleanup_cli_stage' EXIT
		trap 'cleanup_cli_stage; exit 130' HUP INT TERM
		cp "$SRC" "$CLI_STAGE" || {
			cleanup_cli_stage
			die "无法复制 $SRC 到暂存 CLI"
		}
		chmod 0755 "$CLI_STAGE" || {
			cleanup_cli_stage
			die "无法设置暂存 CLI 的可执行权限"
		}
		PREFLIGHT_CLI=$CLI_STAGE
		run_cli "$PREFLIGHT_CLI" version >/dev/null 2>&1 ||
			die "服务用户 $RUN_USER 无法访问或执行归档 $SRC，安全暂存副本也不能执行；未安装、未停止任何进程。请把归档放到该用户可读的路径后重试。"
	fi

	check_api_owner

	_status_out=$(run_cli "$PREFLIGHT_CLI" status --data-dir "$DATA_DIR" 2>&1) && _status_ok=1 || _status_ok=0
	if [ "$_status_ok" -eq 1 ]; then
		_api_data=$(status_field data_dir "$_status_out")
		_api_sup=$(status_field supervised "$_status_out")
		_api_peer=$(status_field peer_id "$_status_out")
		[ -n "$_api_data" ] || die "本地 API 返回的 data_dir 为空；未停止任何进程。请手动运行 $DEST status --data-dir $DATA_DIR 检查。"
		same_path "$_api_data" "$DATA_DIR" ||
			die "本地 API 报告的 data_dir 是 $_api_data，与目标 $DATA_DIR 不一致；为避免停止其他节点，未做任何修改。请检查 api.sock/api.token/api.endpoint.json 是否来自另一个数据目录。"

		case "$_api_sup" in
		true)
			if [ "$UNIT_EXISTS" -eq 0 ] || [ "$UNIT_ACTIVE" -ne 1 ]; then
				die "目标数据目录的节点报告 supervised=true，但不是由当前 $SERVICE_NAME.service 管理（unit 不存在或未 active）；为避免误停其他 systemd 服务，未做任何修改。请用 systemctl list-units --all 'raminga*' 和 systemctl cat 确认启动它的 unit。"
			fi
			;;
		false)
			if [ "$UNIT_ACTIVE" -eq 1 ]; then
				die "$SERVICE_NAME.service 处于 active，但目标节点报告 supervised=false；可能有另一个进程占用该数据目录。拒绝停止/重启，未做任何修改。请先手动检查 $DEST status --data-dir $DATA_DIR 和 ps。"
			fi
			INDEPENDENT=1
			;;
		*)
			die "无法判断目标节点的 systemd 托管状态（supervised=${_api_sup:-空}）；未停止任何进程。请先手动运行 $DEST status --data-dir $DATA_DIR。"
			;;
		esac
		BEFORE_PEER=$_api_peer
	else
		if [ "$UNIT_ACTIVE" -eq 1 ]; then
			: # The unit is ours; restart is the remediation for an unhealthy API.
		elif [ ! -e "$DATA_DIR/api.sock" ] && [ ! -L "$DATA_DIR/api.sock" ] &&
			[ ! -e "$DATA_DIR/api.endpoint.json" ] && [ ! -L "$DATA_DIR/api.endpoint.json" ]; then
			: # No local API artifact: there is no daemon to identify or stop.
		elif printf '%s\n' "$_status_out" | grep -Fq '节点未运行' ||
			printf '%s\n' "$_status_out" | grep -Fq 'connection refused'; then
			: # Stale Unix socket with no listener; safe to let the service replace it.
		else
			_detail=$(printf '%s\n' "$_status_out" | tail -n 3)
			die "无法确认目标数据目录 $DATA_DIR 是否有独立 daemon 在运行：$_detail
未停止任何进程，也未安装/启动 systemd 服务。请先手动确认：
  $DEST status --data-dir $DATA_DIR
如果确认没有 daemon，请先修复上面的本地 API/token/endpoint 错误再重试。"
		fi
	fi

	if [ -f "$DATA_DIR/identity/key" ]; then
		BEFORE_KEY_CKSUM=$(cksum <"$DATA_DIR/identity/key" 2>/dev/null || true)
	fi
}

remove_new_unit() {
	[ "$UNIT_CREATED" -eq 1 ] || return 0
	rm -f "$UNIT"
	systemctl daemon-reload >/dev/null 2>&1 || true
}

abort_before_start() {
	[ -z "$UNIT_TMP" ] || rm -f "$UNIT_TMP"
	UNIT_TMP=
	remove_new_unit
	die "$1"
}

stop_started_service() {
	systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
	_i=0
	while systemctl is-active --quiet "$SERVICE_NAME" && [ "$_i" -lt 10 ]; do
		sleep 1
		_i=$((_i + 1))
	done
	if systemctl is-active --quiet "$SERVICE_NAME"; then
		if [ "$UNIT_CREATED" -eq 1 ]; then
			systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
		fi
		printf 'install.sh: 警告：无法停止 %s.service；unit 未删除。请立即运行 sudo systemctl stop %s 并检查 journalctl -u %s。\n' \
			"$SERVICE_NAME" "$SERVICE_NAME" "$SERVICE_NAME" >&2
		return 1
	fi
	if [ "$UNIT_CREATED" -eq 1 ]; then
		systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
		rm -f "$UNIT"
		systemctl daemon-reload >/dev/null 2>&1 || true
	fi
	return 0
}

fail_service() {
	stop_started_service || true
	die "$1"
}

service_interrupted() {
	trap - HUP INT TERM
	printf '\ninstall.sh: 收到中断信号，正在清理本次启动的服务…\n' >&2
	[ -z "$UNIT_TMP" ] || rm -f "$UNIT_TMP"
	UNIT_TMP=
	if [ "$SERVICE_TOUCHED" -eq 1 ]; then
		stop_started_service || true
	else
		remove_new_unit
	fi
	exit 130
}

wait_for_service_health() {
	_deadline=$(($(date +%s) + WAIT_SECONDS))
	HEALTH_DETAIL='本地 API 尚未就绪'
	while :; do
		if systemctl is-active --quiet "$SERVICE_NAME"; then
			_unit_state=active
		else
			_unit_state=inactive
		fi

		if _api_out=$(run_cli "$DEST" status --data-dir "$DATA_DIR" 2>&1); then
			_api_data=$(status_field data_dir "$_api_out")
			_api_sup=$(status_field supervised "$_api_out")
			_api_peer=$(status_field peer_id "$_api_out")

			if [ -z "$_api_data" ] || ! same_path "$_api_data" "$DATA_DIR"; then
				HEALTH_DETAIL="本地 API 报告的 data_dir 不是目标目录：${_api_data:-空}"
				return 1
			fi
			if [ -n "$BEFORE_PEER" ] && [ "$_api_peer" != "$BEFORE_PEER" ]; then
				HEALTH_DETAIL="Peer ID 发生变化（$BEFORE_PEER -> ${_api_peer:-空}），身份未保留"
				return 1
			fi
			if [ "$_api_sup" != true ]; then
				# systemd sets INVOCATION_ID at exec time, so a daemon that
				# reports supervised=false is not the unit we just started.
				# Stop here instead of waiting for a healthy-looking independent
				# daemon that we must not touch.
				HEALTH_DETAIL="本地 API 的 supervised=${_api_sup:-空}，不是 systemd 托管；可能有独立 daemon 占用数据目录"
				return 1
			fi
			if [ "$_unit_state" = active ]; then
				if [ -n "$BEFORE_KEY_CKSUM" ]; then
					_now_key=$(cksum <"$DATA_DIR/identity/key" 2>/dev/null || true)
					if [ "$_now_key" != "$BEFORE_KEY_CKSUM" ]; then
						HEALTH_DETAIL='identity/key 校验和发生变化，身份未保留'
						return 1
					fi
				fi
				# Re-check after the API call: a daemon that stopped during the
				# status request must not produce a success message.
				if systemctl is-active --quiet "$SERVICE_NAME"; then
					return 0
				fi
				HEALTH_DETAIL='本地 API 已就绪，但服务在健康检查期间退出'
			else
				HEALTH_DETAIL='本地 API 已就绪，但 systemctl 尚未 active'
			fi
		else
			HEALTH_DETAIL=$(printf '%s\n' "$_api_out" | tail -n 2)
			[ -n "$HEALTH_DETAIL" ] || HEALTH_DETAIL='本地 API 不可达'
		fi

		if [ "$(date +%s)" -ge "$_deadline" ]; then
			return 1
		fi
		sleep 1
	done
}

install_systemd_service() {
	trap 'service_interrupted' HUP INT TERM
	# A valid existing unit is reused as-is. It already names the installed
	# binary, the service user and the data directory; preserving it keeps local
	# hardening/Environment/Restart changes that the script cannot merge safely.
	if [ "$UNIT_EXISTS" -eq 0 ]; then
		UNIT_CREATED=1
		UNIT_TMP=$(mktemp "$SYSTEMD_UNIT_DIR/.raminga.service.XXXXXX") || abort_before_start "无法在 $SYSTEMD_UNIT_DIR 创建临时 unit"
		if ! cat >"$UNIT_TMP" <<UNIT_EOF
# Managed by Raminga install.sh.
[Unit]
Description=Raminga node
Wants=network-online.target
After=network-online.target

[Service]
User=$RUN_USER
ExecStart="$DEST" daemon --data-dir "$DATA_DIR"
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT_EOF
		then
			abort_before_start "写入临时 unit 失败"
		fi
		chmod 0644 "$UNIT_TMP" || abort_before_start "无法设置 unit 权限"
		mv -f "$UNIT_TMP" "$UNIT" || abort_before_start "无法原子替换 $UNIT"
		UNIT_TMP=
	fi

	if ! systemctl daemon-reload; then
		abort_before_start "systemctl daemon-reload 失败；未停止独立 daemon，也未启动服务"
	fi

	if [ "$INDEPENDENT" -eq 1 ]; then
		printf '检测到目标数据目录的独立（非 systemd）daemon；先通过本地 API 停止，再交给 systemd。\n'
		if _stop_out=$(run_cli "$DEST" stop --data-dir "$DATA_DIR" 2>&1); then
			if run_cli "$DEST" status --data-dir "$DATA_DIR" >/dev/null 2>&1; then
				abort_before_start "独立 daemon 在 stop 后仍可访问；未启动 systemd 服务，也未强制 kill。请手动确认 $DEST status --data-dir $DATA_DIR，并按提示停止后再重试。"
			fi
		else
			_detail=$(printf '%s\n' "$_stop_out" | tail -n 3)
			abort_before_start "无法通过本地 API 停止独立 daemon：$_detail
未启动 systemd 服务，也未强制 kill 任何进程。请手动运行：
  $DEST stop --data-dir $DATA_DIR
确认节点未运行后重试。"
		fi
	fi

	SERVICE_TOUCHED=1
	if [ "$UNIT_EXISTS" -eq 1 ]; then
		if ! systemctl restart "$SERVICE_NAME"; then
			fail_service "systemctl restart $SERVICE_NAME 失败。已停止本次启动的服务；已有 unit 保持不变；未报告安装成功。请查看 journalctl -u $SERVICE_NAME -n 50 --no-pager。"
		fi
	else
		if ! systemctl enable --now "$SERVICE_NAME"; then
			fail_service "systemctl enable --now $SERVICE_NAME 失败。已停止本次启动的服务并移除新 unit；未报告安装成功。请查看 journalctl -u $SERVICE_NAME -n 50 --no-pager。"
		fi
	fi

	if ! wait_for_service_health; then
		fail_service "systemd 服务 $SERVICE_NAME 未在 ${WAIT_SECONDS}s 内达到 active + 本地 API 健康：$HEALTH_DETAIL
已停止本次启动的服务；未报告安装成功。请查看：
  journalctl -u $SERVICE_NAME -n 50 --no-pager
  systemctl status $SERVICE_NAME --no-pager"
	fi

	trap - HUP INT TERM
	_version=$(run_cli "$DEST" version 2>/dev/null | sed -n '1p' || true)
	[ -n "$_version" ] || _version=$DEST
	printf '已安装并启动 systemd 服务 %s（用户 %s，数据目录 %s，版本 %s）\n' \
		"$SERVICE_NAME" "$RUN_USER" "$DATA_DIR" "$_version"
}

if [ "$SERVICE" -eq 1 ]; then
	service_preflight
fi

mkdir -p "$DEST_DIR" || die "无法创建安装目录 $DEST_DIR"
# PATH entries and rc lines must be absolute even for a relative --prefix.
DEST_DIR=$(CDPATH= cd -- "$DEST_DIR" && pwd) || die "无法进入安装目录"
DEST=$DEST_DIR/$PROG

# shell_rc_file prints the rc file for the user's login shell, or nothing when
# the shell isn't one this script knows how to configure.
shell_rc_file() {
	[ -n "${HOME:-}" ] || return 0
	case "$(basename -- "${SHELL:-}")" in
	zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
	bash)
		# Terminal windows on macOS start bash as a login shell, which never
		# reads ~/.bashrc.
		if [ "$(uname -s)" = Darwin ]; then
			printf '%s\n' "$HOME/.bash_profile"
		else
			printf '%s\n' "$HOME/.bashrc"
		fi
		;;
	esac
}

# add_path_line appends the PATH line once. It fails without changing anything
# if the file can't be written, so the caller can fall back to the manual hint.
add_path_line() {
	if [ -f "$1" ] && grep -Fqx -- "$2" "$1"; then
		printf '%s 已包含 PATH 配置，未重复写入。\n' "$1"
		return 0
	fi
	{
		if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then
			printf '\n'
		fi
		printf '# Added by Raminga install.sh\n%s\n' "$2"
	} 2>/dev/null >>"$1" || return 1
	printf '已把 %s 加入 PATH：写入 %s\n' "$DEST_DIR" "$1"
}

# same_file compares inodes so a symlink to the installed binary isn't flagged.
same_file() {
	[ "$(ls -Lid -- "$1" 2>/dev/null | awk '{print $1}')" = "$(ls -Lid -- "$2" 2>/dev/null | awk '{print $1}')" ]
}

TMP=$(mktemp "$DEST_DIR/.raminga-install.XXXXXX") || die "无法在 $DEST_DIR 创建临时文件"
trap 'rm -f "$TMP"; cleanup_cli_stage' EXIT HUP INT TERM
cp "$SRC" "$TMP" || die "复制二进制到 $TMP 失败"
chmod 0755 "$TMP" || die "设置 $TMP 可执行权限失败"
mv -f "$TMP" "$DEST" || die "替换 $DEST 失败"
trap - EXIT HUP INT TERM
cleanup_cli_stage

if [ "$(uname -s)" = Darwin ]; then
	xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
fi

if [ "$SERVICE" -eq 1 ]; then
	install_systemd_service
else
	OLD_RUNNING=0
	if [ -n "$STATUS_DIR" ] && "$DEST" status --data-dir "$STATUS_DIR" >/dev/null 2>&1; then
		OLD_RUNNING=1
	fi

	INSTALLED_VERSION=$("$DEST" version 2>/dev/null | sed -n '1p' || true)
	[ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION="$DEST"
	printf '已安装 %s 到 %s\n' "$INSTALLED_VERSION" "$DEST"

	DEST_ON_PATH=0
	PATH_ADDED=0
	case ":${PATH:-}:" in
	*":$DEST_DIR:"*) DEST_ON_PATH=1 ;;
	*)
		if [ "$DEST_DIR" = "${DEFAULT_PREFIX:-}" ]; then
			PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
		else
			PATH_LINE=$(printf 'export PATH="%s:$PATH"' "$DEST_DIR")
		fi
		RC_FILE=
		if [ "$MODIFY_PATH" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
			RC_FILE=$(shell_rc_file)
		fi
		case "$DEST_DIR" in
		*[\"\$\`\\]*) RC_FILE= ;; # Unsafe to place inside the double-quoted line.
		esac
		if [ -n "$RC_FILE" ] && add_path_line "$RC_FILE" "$PATH_LINE"; then
			PATH_ADDED=1
			printf '当前终端要生效，请运行：source %s\n' "$RC_FILE"
		else
			printf '%s 不在 PATH。把下面一行加入 shell 配置：\n%s\n' "$DEST_DIR" "$PATH_LINE"
		fi
		;;
	esac

	# Fixing PATH doesn't help when another raminga is found first, so say so.
	FOUND=$(command -v "$PROG" 2>/dev/null || true)
	if [ -n "$FOUND" ] && ! same_file "$FOUND" "$DEST"; then
		FOUND_VERSION=$("$FOUND" version 2>/dev/null | sed -n '1p' || true)
		[ -n "$FOUND_VERSION" ] || FOUND_VERSION='版本未知'
		printf '警告：当前运行 raminga 会先找到 %s（%s），不是刚安装的 %s。\n' "$FOUND" "$FOUND_VERSION" "$DEST"
		if [ "$DEST_ON_PATH" -eq 1 ]; then
			printf '它在 PATH 里排在前面。请删除或替换它，或调整 PATH 顺序；也可以直接运行 %s。\n' "$DEST"
		elif [ "$PATH_ADDED" -eq 1 ]; then
			printf '运行上面的 source 后，新版会排在前面；用 command -v raminga 确认。\n'
		else
			printf '请把 %s 加到 PATH 前面，或删除旧版；也可以直接运行 %s。\n' "$DEST_DIR" "$DEST"
		fi
	fi

	if [ "$OLD_RUNNING" -eq 1 ]; then
		printf '运行 raminga restart 切换到新版本\n'
	fi
fi
