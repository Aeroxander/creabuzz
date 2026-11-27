# syntax=docker/dockerfile:1.7
#
# Public Buzz relay image — published as ghcr.io/block/buzz:<tag>.
#
# Builds the `buzz-relay` and `buzz-admin` binaries (Rust 1.95) and the Creaton
# app's static bundle (app/, pnpm + vite), then assembles them into a small debian-slim runtime with
# `git` available (the relay shells out to git for repo hydrate / receive-pack
# / upload-pack — see crates/buzz-relay/src/api/git).
#
# Multi-arch is handled by running this same Dockerfile on native amd64 and
# native arm64 runners (see .github/workflows/docker.yml). The Dockerfile
# itself is platform-agnostic; do not add --platform pins.

ARG RUST_VERSION=1.95
ARG NODE_VERSION=24
ARG DEBIAN_VERSION=bookworm

# Optional extra CA bundle for builds behind a TLS-intercepting corporate proxy
# (e.g. a Cloudflare/Zscaler gateway that re-signs TLS). Empty by default, so
# public CI builds are unaffected. Point it at a PEM file in the build context:
#   docker build --build-arg EXTRA_CA_CERTS=path/to/proxy-ca.pem ...
# Consumed by the network-touching stages below (cargo + pnpm).
ARG EXTRA_CA_CERTS=

# Optional npm registry for builds where the public registry is unreachable or
# policy-blocked (e.g. a corporate mirror / Artifactory). Empty default = public
# npmjs, so public CI builds are unaffected. Consumed by the node-base stage.
ARG NPM_REGISTRY=

# ─── Stage 1: cargo-chef base ───────────────────────────────────────────────
FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS chef
# Trust an optional corporate-proxy CA before any network fetch (no-op if unset).
ARG EXTRA_CA_CERTS
COPY --chmod=0644 ${EXTRA_CA_CERTS:-Dockerfile} /tmp/extra-ca/src
RUN if [ -n "${EXTRA_CA_CERTS}" ]; then \
        cp /tmp/extra-ca/src /usr/local/share/ca-certificates/extra-proxy-ca.crt \
        && update-ca-certificates \
        && echo "CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt" >> /etc/environment; \
    fi
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
RUN cargo install cargo-chef --locked --version 0.1.71
WORKDIR /build

# ─── Stage 2: plan dependency graph ─────────────────────────────────────────
# Only the manifests are needed to compute the recipe; this layer rebuilds
# only when Cargo.{toml,lock} or crate manifests change, not on every source
# edit.
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# ─── Stage 3: cook dependencies, then build the binary ──────────────────────
FROM chef AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        libssl-dev \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*
# Keep enough DWARF for native profilers to resolve optimized code to source
# locations. The normal runtime strips it below; runtime-debug retains it.
ENV CARGO_PROFILE_RELEASE_DEBUG=line-tables-only
COPY --from=planner /build/recipe.json recipe.json
# Cook the full workspace recipe — relay deps include workspace siblings, so
# scoping to -p buzz-relay misses transitive deps and re-builds them later.
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
# Compile immutable artifact identity into the relay. Defaults preserve local
# and third-party builds that do not run in provenance-aware CI.
ARG BUZZ_SOURCE_SHA=unknown
ARG BUZZ_BUILD_ID=local
ARG BUZZ_BUILD_URL=unknown
ENV BUZZ_SOURCE_SHA=${BUZZ_SOURCE_SHA} \
    BUZZ_BUILD_ID=${BUZZ_BUILD_ID} \
    BUZZ_BUILD_URL=${BUZZ_BUILD_URL}
RUN cargo build --release --locked -p buzz-relay --bin buzz-relay \
                                   -p buzz-admin --bin buzz-admin

# Derive the normal release binaries from the same optimized ELF files as the
# debug image so the two variants cannot drift at code-generation time.
FROM builder AS stripped-binaries
RUN strip target/release/buzz-relay \
    && strip target/release/buzz-admin

# ─── Stage 4a: node, pnpm and the optional proxy CA / npm mirror ────────────
# The set-up the app bundle below starts from. Nothing is built here.
FROM node:${NODE_VERSION}-${DEBIAN_VERSION}-slim AS node-base
WORKDIR /build
# Trust an optional corporate-proxy CA so corepack + pnpm can fetch over an
# intercepting TLS gateway (no-op if EXTRA_CA_CERTS is unset).
ARG EXTRA_CA_CERTS
COPY --chmod=0644 ${EXTRA_CA_CERTS:-Dockerfile} /tmp/extra-ca/src
RUN if [ -n "${EXTRA_CA_CERTS}" ]; then \
        apt-get update && apt-get install -y --no-install-recommends ca-certificates \
        && cp /tmp/extra-ca/src /usr/local/share/ca-certificates/extra-proxy-ca.crt \
        && update-ca-certificates \
        && rm -rf /var/lib/apt/lists/*; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Point npm + corepack at an optional mirror (no-op when NPM_REGISTRY is unset).
# corepack reads COREPACK_NPM_REGISTRY to fetch the pinned pnpm; pnpm/npm read
# the .npmrc registry for dependency installs.
ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
# When using a mirror, disable corepack's npmjs signature check: the mirror
# republishes tarballs without the public registry's provenance signatures, so
# strict verification fails ("No compatible signature found"). Only relaxed on
# the mirror path — public builds (NPM_REGISTRY unset) keep strict verification.
RUN if [ -n "${NPM_REGISTRY}" ]; then \
        echo "registry=${NPM_REGISTRY}" > /build/.npmrc \
        && echo "COREPACK_INTEGRITY_KEYS=0" >> /etc/environment; \
    fi
ENV COREPACK_INTEGRITY_KEYS=${NPM_REGISTRY:+0}
RUN corepack enable

# ─── Stage 4b: the Creaton app (pnpm + vite) ────────────────────────────────
# The phone-first app (app/, package @creaton/app): what the image serves. Its network settings are read when it is built and are public in the page. Unset is off: with none of them the
# app shows no money screens. They are the app's own names (app/src/lib/pot-network.ts, features/money/passkey-sender.ts):
#   VITE_CREATON_CHAIN_ID, VITE_CREATON_LAUNCHER, VITE_CREATON_DOLLAR   the test network and its contracts: the three values
#                                                                      of contracts/pot/deployments/pot-<chain>.json
#   VITE_CREATON_RPC_URL                                               a node the page reads from (public in the page)
#   VITE_CREATON_PASSKEY_ACCOUNT=1, VITE_CREATON_BUNDLER_URL,          fee-paid sending from a passkey account; the bundler
#   VITE_CREATON_SPONSOR_URL (optional)                                and the sponsor sit behind addresses that hold their
#                                                                      own keys (a key in the address is refused)
#   VITE_CREATON_EARLIER_CONTRACT, _TEXT_HASH, _TEXT_URL               the earlier backers' claim page: all three or the page
#                                                                      does not exist (the app checks them and fails closed)
# docs/next-version/DEPLOY-TEST-NETWORK.md says where each comes from.
FROM node-base AS app-builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
# The app's shared logic (@creaton/core) is a workspace package: `@creaton/app...` takes the app and its workspace
# dependencies.
COPY packages/creaton-core/package.json packages/creaton-core/
COPY app/package.json app/
RUN pnpm install --frozen-lockfile --filter "@creaton/app..."
COPY packages/creaton-core/ packages/creaton-core/
COPY app/ app/
ARG VITE_CREATON_CHAIN_ID=
ARG VITE_CREATON_LAUNCHER=
ARG VITE_CREATON_DOLLAR=
ARG VITE_CREATON_RPC_URL=
ARG VITE_CREATON_PASSKEY_ACCOUNT=
ARG VITE_CREATON_BUNDLER_URL=
ARG VITE_CREATON_SPONSOR_URL=
ARG VITE_CREATON_EARLIER_CONTRACT=
ARG VITE_CREATON_EARLIER_TEXT_HASH=
ARG VITE_CREATON_EARLIER_TEXT_URL=
# An empty argument reaches the build as no setting at all. Settings that do not fit together stop the build here, with the
# reason, rather than build an app that quietly shows no money (a launcher without its chain, a passkey switch without its
# bundler). The build ends by checking its own output: the page, its manifest, the service worker, and the Launcher inside
# the code when one was named.
RUN set -eu; \
    for name in VITE_CREATON_CHAIN_ID VITE_CREATON_LAUNCHER VITE_CREATON_DOLLAR VITE_CREATON_RPC_URL \
                VITE_CREATON_PASSKEY_ACCOUNT VITE_CREATON_BUNDLER_URL VITE_CREATON_SPONSOR_URL \
                VITE_CREATON_EARLIER_CONTRACT VITE_CREATON_EARLIER_TEXT_HASH VITE_CREATON_EARLIER_TEXT_URL; do \
        eval "value=\${$name:-}"; \
        if [ -z "$value" ]; then unset "$name"; fi; \
        case "$value" in *CHANGE_ME*) echo "$name still holds CHANGE_ME: put the real value in, then build again." >&2; exit 1 ;; esac; \
    done; \
    address='^0x[0-9a-fA-F]{40}$'; \
    if [ -n "${VITE_CREATON_CHAIN_ID:-}${VITE_CREATON_LAUNCHER:-}${VITE_CREATON_DOLLAR:-}" ]; then \
        [ -n "${VITE_CREATON_CHAIN_ID:-}" ] && [ -n "${VITE_CREATON_LAUNCHER:-}" ] \
            || { echo "The app needs VITE_CREATON_CHAIN_ID and VITE_CREATON_LAUNCHER together (VITE_CREATON_DOLLAR with them): one without the other builds an app with no money screens." >&2; exit 1; }; \
        printf '%s' "$VITE_CREATON_CHAIN_ID" | grep -Eq '^[1-9][0-9]*$' \
            || { echo "VITE_CREATON_CHAIN_ID must be a whole number (got: $VITE_CREATON_CHAIN_ID)." >&2; exit 1; }; \
        printf '%s' "$VITE_CREATON_LAUNCHER" | grep -Eq "$address" \
            || { echo "VITE_CREATON_LAUNCHER must be a 0x address of 40 hex digits." >&2; exit 1; }; \
        if [ -n "${VITE_CREATON_DOLLAR:-}" ]; then \
            printf '%s' "$VITE_CREATON_DOLLAR" | grep -Eq "$address" \
                || { echo "VITE_CREATON_DOLLAR must be a 0x address of 40 hex digits." >&2; exit 1; }; \
        fi; \
    fi; \
    for name in VITE_CREATON_RPC_URL VITE_CREATON_BUNDLER_URL VITE_CREATON_SPONSOR_URL; do \
        eval "value=\${$name:-}"; \
        if [ -n "$value" ]; then \
            printf '%s' "$value" | grep -Eq '^https?://[^[:space:]@]+$' \
                || { echo "$name must be an http(s) address with no name, password or space in it." >&2; exit 1; }; \
            ! printf '%s' "$value" | grep -Eiq '[?&][^=&]*(key|token|secret|auth|password)' \
                || { echo "$name carries a key in its address, and every setting is public in the page: put the key in a proxy and name the proxy." >&2; exit 1; }; \
        fi; \
    done; \
    if [ "${VITE_CREATON_PASSKEY_ACCOUNT:-}" = "1" ]; then \
        [ -n "${VITE_CREATON_CHAIN_ID:-}" ] && [ -n "${VITE_CREATON_RPC_URL:-}" ] && [ -n "${VITE_CREATON_BUNDLER_URL:-}" ] \
            || { echo "VITE_CREATON_PASSKEY_ACCOUNT=1 needs VITE_CREATON_CHAIN_ID, VITE_CREATON_RPC_URL and VITE_CREATON_BUNDLER_URL: without all three the phone account cannot send." >&2; exit 1; }; \
    elif [ -n "${VITE_CREATON_PASSKEY_ACCOUNT:-}" ]; then \
        echo "VITE_CREATON_PASSKEY_ACCOUNT is 1 or left out (got: $VITE_CREATON_PASSKEY_ACCOUNT)." >&2; exit 1; \
    fi; \
    pnpm -C app build; \
    for file in index.html sw.js assets/manifest.webmanifest; do \
        [ -f "app/dist/$file" ] || { echo "The app build has no $file." >&2; exit 1; }; \
    done; \
    grep -q '/assets/manifest.webmanifest' app/dist/index.html \
        || { echo "The app's page does not name its manifest." >&2; exit 1; }; \
    if [ -n "${VITE_CREATON_LAUNCHER:-}" ]; then \
        grep -rqi "$VITE_CREATON_LAUNCHER" app/dist/assets \
            || { echo "The app build does not name the Launcher $VITE_CREATON_LAUNCHER." >&2; exit 1; }; \
    fi

# ─── Stage 5: shared runtime ────────────────────────────────────────────────
FROM debian:${DEBIAN_VERSION}-slim AS runtime-base

# OCI annotations: required for GHCR to auto-link the image to this repo and
# inherit its visibility. org.opencontainers.image.source is the load-bearing
# one — without it GHCR keeps the image private even when the repo is public.
LABEL org.opencontainers.image.title="Creaton" \
      org.opencontainers.image.description="Creaton server: the relay with the Creaton web app inside it" \
      org.opencontainers.image.source="https://github.com/Aeroxander/creabuzz" \
      org.opencontainers.image.url="https://github.com/Aeroxander/creabuzz" \
      org.opencontainers.image.documentation="https://github.com/Aeroxander/creabuzz#readme" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 buzz \
    && useradd  --system --uid 1000 --gid 1000 --home-dir /var/lib/buzz \
                --create-home --shell /usr/sbin/nologin buzz

# The web bundle is copied by the final targets below.
#
# The invite landing page is always served from the bundled web UI. Repository
# browser routes require the separate BUZZ_SERVE_GIT_WEB_GUI=true opt-in.
ENV BUZZ_WEB_DIR=/srv/buzz/web

# 3000: app (WS + REST)  ·  8080: /_liveness, /_readiness  ·  9102: /metrics
EXPOSE 3000 8080 9102

# deploy/compose mounts a volume here; pre-created so it inherits buzz:buzz.
RUN mkdir -p /data/git && chown buzz:buzz /data/git

USER buzz:buzz
WORKDIR /var/lib/buzz

ENTRYPOINT ["/usr/local/bin/buzz-relay"]

# Optimized binaries with line-table debug information for native profiling.
# Published under debug-* tags; runtime behavior otherwise matches the normal
# image exactly.
FROM runtime-base AS runtime-debug
COPY --from=app-builder /build/app/dist                 /srv/buzz/web
COPY --from=builder /build/target/release/buzz-relay /usr/local/bin/buzz-relay
COPY --from=builder /build/target/release/buzz-admin /usr/local/bin/buzz-admin

# The Creaton image (deploy/compose/compose.creaton.yml builds it): the stripped binaries with the Creaton app (app/) as
# the web bundle.
FROM runtime-base AS runtime-creaton
COPY --from=app-builder /build/app/dist                 /srv/buzz/web
COPY --from=stripped-binaries /build/target/release/buzz-relay /usr/local/bin/buzz-relay
COPY --from=stripped-binaries /build/target/release/buzz-admin /usr/local/bin/buzz-admin

# The final/default target, so a plain `docker build .` and the release tags build the Creaton image. This stays the last
# stage on purpose.
FROM runtime-creaton AS runtime
