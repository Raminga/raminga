# CGO_ENABLED=0 multi-stage build for the G1 Docker acceptance.
FROM --platform=$BUILDPLATFORM golang:1.27.4 AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /out/raminga ./cmd/raminga

FROM debian:bookworm-slim
# Lab/e2e images keep every daemon's data directory at /data. Exporting it
# makes plain `docker exec ... raminga status` resolve the same data dir as the
# daemon, without requiring --data-dir on every command.
ENV RAMINGA_DATA_DIR=/data
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates iproute2 iputils-ping iptables conntrack curl procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/raminga /usr/local/bin/raminga
COPY tests/e2e/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY tests/e2e/configs/api-only.toml /opt/raminga/api-only.toml
COPY tests/e2e/nat-router.sh /app/tests/e2e/nat-router.sh
COPY tests/e2e/g2/nat-peer-entrypoint.sh /app/tests/e2e/g2/nat-peer-entrypoint.sh
RUN chmod 0755 /usr/local/bin/raminga /usr/local/bin/entrypoint.sh /app/tests/e2e/nat-router.sh /app/tests/e2e/g2/nat-peer-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
