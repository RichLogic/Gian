FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /source
COPY . .
RUN node scripts/verify-source.mjs && pnpm install --frozen-lockfile
ARG GIAN_REMOTE_BUILD_ID
ARG GIAN_REMOTE_VERSION
RUN test -n "$GIAN_REMOTE_BUILD_ID" && test -n "$GIAN_REMOTE_VERSION" && pnpm build
RUN node scripts/bundle-runtime.mjs /runtime

FROM node:24-bookworm-slim
ENV NODE_ENV=production GIAN_REMOTE_HOST=0.0.0.0 GIAN_REMOTE_PORT=8787 GIAN_REMOTE_DATA_DIR=/data GIAN_REMOTE_STATIC_DIR=/app/web
ARG GIAN_REMOTE_BUILD_ID
ARG GIAN_REMOTE_VERSION
ENV GIAN_REMOTE_BUILD_ID=$GIAN_REMOTE_BUILD_ID GIAN_REMOTE_VERSION=$GIAN_REMOTE_VERSION
LABEL org.opencontainers.image.source=https://github.com/RichLogic/Gian-Remote org.opencontainers.image.revision=$GIAN_REMOTE_BUILD_ID org.opencontainers.image.version=$GIAN_REMOTE_VERSION
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /source/packages/remote-web/dist/ ./web/
RUN mkdir /data && chown node:node /data
RUN chmod +x /app/dist/src/cli.js && ln -s /app/dist/src/cli.js /usr/local/bin/gian-remote-server
USER node
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=6 CMD node -e "fetch('http://127.0.0.1:8787/health').then(async r=>{const h=await r.json();if(!r.ok||!h.ok||h.build_id!==process.env.GIAN_REMOTE_BUILD_ID)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/cli.js"]
