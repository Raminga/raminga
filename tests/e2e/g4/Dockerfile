# G4 security/stability image: the normal daemon plus a TEST-ONLY attacker.
# The attacker is never part of the shipped binary or release archives.
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
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /out/raminga-attacker ./tests/e2e/g4/attacker

FROM debian:bookworm-slim
ENV RAMINGA_DATA_DIR=/data
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates iproute2 iputils-ping iptables conntrack curl procps sqlite3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/raminga /usr/local/bin/raminga
COPY --from=build /out/raminga-attacker /usr/local/bin/raminga-attacker
COPY tests/e2e/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/raminga /usr/local/bin/raminga-attacker /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
