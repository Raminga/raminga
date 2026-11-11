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

usage() {
	cat <<'USAGE'
用法: sh install.sh [--prefix DIR] [--no-modify-path] [--service [--user NAME] [--data-dir DIR]]

默认安装到 ~/.local/bin（root 为 /usr/local/bin）。--prefix 覆盖目录。
目录不在 PATH 时，把它写入 shell 配置（zsh: ~/.zshrc，bash: ~/.bashrc，macOS 的 bash: ~/.bash_profile）。
--no-modify-path 不写配置，只打印要加入的一行。root 和 --service 不写配置。
--service 仅用于 Linux + systemd 的 root 安装，会写入并启用 raminga.service。
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
	[ "$(uname -s)" = Linux ] || die "--service 只在 Linux 上支持"
	[ "$(id -u)" -eq 0 ] || die "--service 需要 root（例如 sudo ./install.sh --service）"
	command -v systemctl >/dev/null 2>&1 || die "没有 systemctl；--service 需要 systemd"
	[ -d /run/systemd/system ] || die "systemd 没有作为 PID 1 运行；--service 不可用"
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
	if [ -n "$SERVICE_USER" ]; then
		RUN_USER=$SERVICE_USER
	elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
		RUN_USER=$SUDO_USER
	else
		die "以 root 直接运行时请用 --user NAME 指定服务用户"
	fi
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

mkdir -p "$DEST_DIR"
# PATH entries and rc lines must be absolute even for a relative --prefix.
DEST_DIR=$(CDPATH= cd -- "$DEST_DIR" && pwd)
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

TMP=$(mktemp "$DEST_DIR/.raminga-install.XXXXXX")
trap 'rm -f "$TMP"' EXIT HUP INT TERM
cp "$SRC" "$TMP"
chmod 0755 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT HUP INT TERM

if [ "$(uname -s)" = Darwin ]; then
	xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
fi

OLD_RUNNING=0
if [ "$SERVICE" -eq 0 ] && [ -n "$STATUS_DIR" ] && "$DEST" status --data-dir "$STATUS_DIR" >/dev/null 2>&1; then
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
	if [ "$MODIFY_PATH" -eq 1 ] && [ "$SERVICE" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
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

if [ "$SERVICE" -eq 1 ]; then
	UNIT=/etc/systemd/system/raminga.service
	EXISTED=0
	if [ -f "$UNIT" ]; then
		EXISTED=1
	fi
	cat >"$UNIT" <<UNIT_EOF
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
	chmod 0644 "$UNIT"
	systemctl daemon-reload
	if [ "$EXISTED" -eq 1 ]; then
		systemctl restart raminga
	else
		systemctl enable --now raminga
	fi
	printf '已安装并启动 systemd 服务 raminga（用户 %s，数据目录 %s）\n' "$RUN_USER" "$DATA_DIR"
elif [ "$OLD_RUNNING" -eq 1 ]; then
	printf '运行 raminga restart 切换到新版本\n'
fi
