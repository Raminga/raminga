# `install.sh --service` 验证

## 自动化：Linux 容器 + stub systemctl

```sh
make install-test
```

需要 Docker。它会：

1. 交叉构建当前 Docker 架构的 Linux `raminga`；
2. 在一次性 `alpine:3.22` 容器里以 root 运行 `tests/install/systemd-inner.sh`；
3. 用真实 `raminga` daemon、真实本地 Connect API 和真实 `identity/key`；
4. 用 `tests/install/fakebin/systemctl` 和 `journalctl` 代替 systemd；替身按 unit 的 `User=` 降权运行 `ExecStart`，以便验证非 root 服务用户的 HTTPS API。

覆盖：全新安装、已有 unit 升级/自定义内容保留、已有/无 unit 的独立 daemon 迁移、非 root 服务用户 + 真实 HTTPS（`--api-tcp`）daemon 迁移（归档仅 root 可读时走安全暂存）、身份保留、unit 用户/数据目录冲突、符号链接 unit、标准目录 drop-in、`/etc` 外同名 unit（active 或 inactive）、其他 systemd unit 托管、API `data_dir`/属主不一致、API discovery 不可用、服务不 active、启动失败、daemon 启动即退出、已有 unit 升级失败、健康等待期间 SIGTERM 清理、停止失败/过渡 ActiveState/disable 失败时保留 unit、带空格的数据目录，以及非 `--service` 安装回归。

**这不是真实 systemd。** 它不能证明 systemd 的 unit 解析、依赖排序、`Restart=on-failure` 节流、enable 符号链接和 journal 语义。CI 的 `systemd-real` job 单独运行下方真实 systemd 验收。

在 Linux CI 中可把它作为独立步骤：

```sh
make check
make install-test
```

本仓库的 `.github/workflows/ci.yml` 已配置在 `ubuntu-latest` 上运行 `make install-test`；远端 CI 结果以实际 workflow 运行为准。

## 真实 systemd：一次性 Linux VM/runner

以下步骤只应在**可丢弃**的 Linux VM/CI runner 上执行；会写入 `/usr/local/bin/raminga` 和 `/etc/systemd/system/raminga.service`，并占用 4001 或你指定的端口。不要在开发者日常机器或有其他 `raminga.service` 的机器上运行。开始前确认：

```sh
test "$(id -u)" -eq 0
test -d /run/systemd/system
test ! -e /etc/systemd/system/raminga.service
! systemctl is-active --quiet raminga
```

基本验收（服务用户用 root，数据目录用临时目录，避免改动真实用户）：

```sh
set -eu
cd /path/to/raminga
make build

DATA=$(mktemp -d /var/tmp/raminga-systemd.XXXXXX)
./bin/raminga init --data-dir "$DATA" \
  --listen /ip4/127.0.0.1/tcp/4001 \
  --listen /ip4/127.0.0.1/udp/4001/quic-v1

# 先模拟已有的独立 daemon，并记录身份。
./bin/raminga daemon --data-dir "$DATA" >/tmp/raminga-independent.log 2>&1 &
for i in $(seq 1 100); do
  ./bin/raminga status --data-dir "$DATA" >/dev/null 2>&1 && break
  sleep 0.1
done
PEER_BEFORE=$(./bin/raminga status --data-dir "$DATA" | sed -n 's/^peer_id: //p')
./bin/raminga status --data-dir "$DATA" | grep '^supervised: false'

# 安装并迁移到 systemd；成功提示只能在 active + API 健康之后出现。
./scripts/install.sh --service --user root --data-dir "$DATA"
systemctl is-active --quiet raminga
./bin/raminga status --data-dir "$DATA" | grep '^supervised: true'
PEER_AFTER=$(./bin/raminga status --data-dir "$DATA" | sed -n 's/^peer_id: //p')
test -n "$PEER_BEFORE"
test "$PEER_BEFORE" = "$PEER_AFTER"

# 已有 unit 升级：应走 restart，Peer ID 不变。
./scripts/install.sh --service --user root --data-dir "$DATA"
systemctl is-active --quiet raminga
test "$PEER_BEFORE" = "$(./bin/raminga status --data-dir "$DATA" | sed -n 's/^peer_id: //p')"

# 失败路径：破坏配置后升级，必须非零退出、服务停止、不能打印成功。
systemctl stop raminga
printf 'not valid toml\n' >"$DATA/config.toml"
if ./scripts/install.sh --service --user root --data-dir "$DATA" >/tmp/raminga-install-fail.out 2>/tmp/raminga-install-fail.err; then
  echo "FAIL: install reported success for invalid config" >&2
  exit 1
fi
! grep -q '已安装并启动 systemd 服务' /tmp/raminga-install-fail.out
! systemctl is-active --quiet raminga

# 清理。
systemctl disable --now raminga || true
rm -f /etc/systemd/system/raminga.service
systemctl daemon-reload
rm -rf "$DATA" /usr/local/bin/raminga
```

预期结果：

| 检查 | 预期 |
| --- | --- |
| 独立 daemon 迁移 | 旧 API 先消失，systemd 服务 active，`supervised: true`，Peer ID 与 `identity/key` 不变 |
| 已有 unit 升级 | 只 `restart`，不重写 unit；Peer ID 不变 |
| 非法配置升级 | 非零退出，不打印成功，服务 inactive；已有 unit 文件保留 |
| 冲突 unit/API 属主/`data_dir` | 安装前非零退出，原服务/进程仍可用（可用容器测试覆盖，也可在 VM 中手工构造） |

### CI 验收记录

2026-11-15（Asia/Shanghai），提交 `83f91f7` 在 GitHub 托管 Ubuntu 24.04.5 LTS x64 虚拟机上通过。PID 1 为 systemd 255（`255.4-1ubuntu8.18`）。[CI 日志](https://github.com/Raminga/raminga/actions/runs/43680945152/job/132711215864)

```sh
CGO_ENABLED=0 go build -trimpath -o "$RUNNER_TEMP/raminga" ./cmd/raminga
sudo bash tests/install/systemd-real.sh "$RUNNER_TEMP/raminga"
```

- **PASS**：以非 root 用户运行的旧回环 HTTPS daemon 退出，systemd 服务 active、enabled，本地 API 报告由 systemd 托管。Peer ID 和身份密钥保持一致。
- **PASS**：再次安装重启了同一个 unit，unit 内容和身份保持一致。
- **PASS**：无效 TOML 导致已有服务启动失败，安装器返回非零，服务停止，原 unit 和密钥保留。
- **PASS**：无效 TOML 导致新服务启动失败，安装器返回非零，并清理新 unit 和 enable 链接。两条失败路径都检查了实际 systemd 日志和服务不再重启。
