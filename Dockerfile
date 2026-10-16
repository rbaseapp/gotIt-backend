FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json .prettierrc.json ./
COPY src ./src
COPY scripts/build-admin-prompt-reference.mjs ./scripts/build-admin-prompt-reference.mjs

RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts ./scripts

USER node

CMD ["node", "--enable-source-maps", "dist/src/server.js"]
