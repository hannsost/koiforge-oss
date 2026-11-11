FROM node:26.8.1-bookworm-slim

ARG PNPM_VERSION=10.18.3

# Keep the image small while providing the tools needed for GitLab work.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    python3 \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && test "$(pnpm --version)" = "${PNPM_VERSION}" \
  && mkdir --parents /var/lib/koiforge-state \
  && chown node:node /var/lib/koiforge-state \
  && rm --recursive --force /var/lib/apt/lists/*

WORKDIR /workspaces/koiforge
USER node
