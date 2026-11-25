FROM node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS source
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY streaming ./streaming
COPY reviews/db/migrations ./reviews/db/migrations

FROM source AS development
ENV NODE_ENV=development HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "--watch", "--import", "tsx", "src/main.ts"]

FROM source AS build
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/streaming ./streaming
COPY --from=build --chown=node:node /app/reviews/db/migrations ./reviews/db/migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
