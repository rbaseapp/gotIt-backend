# GotIt Backend

Independent product backend for GotIt.

## Architecture

```text
Client
  ├── authentication -> rbase Core
  └── product API     -> GotIt Backend

GotIt Backend
  ├── Core auth client
  └── product_gotit.*
```

The service is internally a Modular Monolith. It is not a module inside `core-platform`.

## B0 decisions

- Local default port: `3001`.
- Core auth timeout: `3000ms` by default.
- Core auth validation has no automatic retry in B0.
- `/ready` checks PostgreSQL only. Core auth failures fail closed per authenticated request with `503` rather than making Render readiness cascade on a Core outage.
- Product migrations are not moved in B0. The 8 GotIt migrations already applied in Production remain immutable in their current location until migration ownership/metadata is changed deliberately.

## Setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm run build
npm test
```

Set `DATABASE_URL` to the PostgreSQL database that already contains `product_gotit.*`.

## Run locally

```bash
npm run dev
```

Then:

```text
GET http://localhost:3001/health
GET http://localhost:3001/ready
GET http://localhost:3001/api/v1
```

## Docker

Run `npm install` once first so `package-lock.json` exists, then:

```bash
docker compose up -d --build
```

The container must be able to reach the PostgreSQL host referenced by `DATABASE_URL`.

## Next milestone

B1 adds:

```text
GET /api/v1/profile
PATCH /api/v1/profile
```

using trusted `applicationId + applicationUserId` obtained through Core authentication.
