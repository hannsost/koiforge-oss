# syntax=docker/dockerfile:1.7

FROM node:26.8.1-bookworm-slim AS build

ARG PNPM_VERSION=10.18.3

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && test "$(pnpm --version)" = "${PNPM_VERSION}" \
  && rm --recursive --force /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY examples/modules ./examples/modules

RUN pnpm install --frozen-lockfile
RUN VITE_API_BASE_URL= pnpm --workspace-concurrency=2 \
    --filter "@koiforge/control-plane-api..." \
    --filter "@koiforge/console-web..." \
    build \
  && pnpm --filter "@koiforge/control-plane-api" --prod deploy --legacy /out/api

FROM node:26.8.1-bookworm-slim AS runtime

ARG BUILD_DATE=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="KoiForge" \
      org.opencontainers.image.description="Single-instance KoiForge control plane and web console" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates nginx \
  && rm --recursive --force /var/lib/apt/lists/* \
  && groupadd --gid 10001 koiforge \
  && useradd --uid 10001 --gid koiforge --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin koiforge \
  && mkdir --parents /app/ui /var/lib/koiforge/state \
  && chown --recursive koiforge:koiforge /var/lib/koiforge

COPY --from=build --chown=koiforge:koiforge /out/api /app/api
COPY --from=build --chown=koiforge:koiforge /workspace/apps/console-web/dist /app/ui
COPY --from=build --chown=koiforge:koiforge /workspace/examples/modules /examples/modules

RUN printf '%s\n' \
    'worker_processes auto;' \
    'error_log /dev/stderr notice;' \
    'pid /tmp/nginx.pid;' \
    'events { worker_connections 1024; }' \
    'http {' \
    '  include /etc/nginx/mime.types;' \
    '  default_type application/octet-stream;' \
    '  access_log /dev/stdout;' \
    '  sendfile on;' \
    '  server_tokens off;' \
    '  client_body_temp_path /tmp/client_temp;' \
    '  proxy_temp_path /tmp/proxy_temp;' \
    '  fastcgi_temp_path /tmp/fastcgi_temp;' \
    '  uwsgi_temp_path /tmp/uwsgi_temp;' \
    '  scgi_temp_path /tmp/scgi_temp;' \
    '  server {' \
    '    listen 8080;' \
    '    root /app/ui;' \
    '    index index.html;' \
    '    client_max_body_size 50m;' \
    '    add_header X-Content-Type-Options nosniff always;' \
    '    add_header Referrer-Policy same-origin always;' \
    '    location = /healthz {' \
    '      access_log off;' \
    '      proxy_pass http://127.0.0.1:3000/health;' \
    '    }' \
    '    location /api/ {' \
    '      proxy_pass http://127.0.0.1:3000;' \
    '      proxy_http_version 1.1;' \
    '      proxy_set_header Host $http_host;' \
    '      proxy_set_header X-Forwarded-Proto $scheme;' \
    '      proxy_set_header X-Forwarded-For $remote_addr;' \
    '      proxy_read_timeout 600s;' \
    '      proxy_send_timeout 600s;' \
    '    }' \
    '    location / {' \
    '      try_files $uri $uri/ /index.html;' \
    '    }' \
    '  }' \
    '}' \
    > /etc/nginx/nginx.conf

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3000 \
    KOIFORGE_STATE_ROOT=/var/lib/koiforge/state \
    KOIFORGE_IMPORT_DATA_ROOT=/var/lib/koiforge/state \
    KOIFORGE_GENERATION_DISABLED=1

WORKDIR /app/api
USER 10001:10001
EXPOSE 8080 3000

CMD ["node", "dist/index.js"]
