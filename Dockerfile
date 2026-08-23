FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS build

COPY prisma ./prisma
RUN npx prisma generate

COPY tailwind.config.cjs ./
COPY crisis_premium ./crisis_premium
COPY webinar-data ./webinar-data
RUN npm run css:build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner

WORKDIR /app
ARG BUILD_COMMIT_SHA=unknown
ENV NODE_ENV=production
ENV APP_BUILD_COMMIT_SHA="${BUILD_COMMIT_SHA}"
LABEL com.aspb.image.scope="autowebinar" \
  com.aspb.schema.compatibility="email-links-v2" \
  org.opencontainers.image.revision="${BUILD_COMMIT_SHA}"

COPY package*.json ./
COPY prisma ./prisma
RUN apk add --no-cache ffmpeg \
  && npm ci --omit=dev --ignore-scripts \
  && npx prisma generate \
  && npm cache clean --force \
  && mkdir -p /var/lib/aspb/media \
  && chown node:node /var/lib/aspb/media \
  && chmod 700 /var/lib/aspb/media

COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/crisis_premium ./crisis_premium
COPY --chown=node:node --from=build /app/webinar-data ./webinar-data
COPY --chown=node:node scripts/worker-healthcheck.mjs ./scripts/worker-healthcheck.mjs
COPY --chown=node:node scripts/run-worker-with-watchdog.mjs ./scripts/run-worker-with-watchdog.mjs
COPY --chown=node:node scripts/check-webinar-video.mjs ./scripts/check-webinar-video.mjs

USER node
RUN test -r /app/crisis_premium/assets/vasiliy-artin.jpg

EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD if [ "${WORKER_ROLE:-all}" = "webinar" ]; then node scripts/worker-healthcheck.mjs; else wget -qO- "http://127.0.0.1:${PORT:-5174}/health/ready" || exit 1; fi

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]
