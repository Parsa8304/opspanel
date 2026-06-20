# Production image for OpsPanel (Next.js + Prisma)
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production
# Full node_modules + build output (app is not configured for `output: standalone`)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
RUN mkdir -p ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/ansible ./ansible
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]
