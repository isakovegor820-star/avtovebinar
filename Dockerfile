FROM node:22-alpine AS deps

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

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
  && npx prisma generate \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/crisis_premium ./crisis_premium
COPY --from=build /app/webinar-data ./webinar-data

EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD if [ "${WORKER_ROLE:-all}" = "webinar" ]; then node -e "process.exit(0)"; else wget -qO- "http://127.0.0.1:${PORT:-5174}/health/ready" || exit 1; fi

USER node

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]
