# CUIT API

A graph-based search engine for Argentine tax identifiers (CUITs), built around a Neo4j knowledge graph enriched with relationship data scraped from external providers. The system lets users:

- Search any CUIT and visualise its relationship paths to nodes in their own database.
- Find the shortest relationship path between two CUITs.
- Manage their own CUIT base by adding, editing, and removing entities and relationships.
- Ingest data from heterogeneous external sources (Excel files, CSVs, third-party APIs) and merge them into a single, deduplicated graph.

The codebase is a TypeScript service running on Fastify, backed by a Neo4j Aura graph database, and accompanied by a React frontend (in a separate repository).

## Table of contents

- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Design patterns](#design-patterns)
- [Adding a new data source](#adding-a-new-data-source)
- [Running the project](#running-the-project)
- [Available scripts](#available-scripts)
- [Database](#database)
- [Authentication](#authentication)
- [Testing](#testing)

## Architecture

The project follows a strict **Hexagonal Architecture** (also known as Ports and Adapters), with four concentric layers. Dependencies always point inward — outer layers know about inner layers, never the reverse.

```
                       ┌────────────────────────────────┐
                       │   Driving adapters             │
                       │   (CLI scripts, HTTP routes)   │
                       └──────────────┬─────────────────┘
                                      │ calls
                                      ▼
                       ┌────────────────────────────────┐
                       │   Application services         │
                       │   (CuitSearchService,          │
                       │    LoaderService)              │
                       └──────────────┬─────────────────┘
                                      │ depends on (ports)
                                      ▼
                       ┌────────────────────────────────┐
                       │   Domain                       │
                       │   (entities, value objects)    │
                       └────────────────────────────────┘
                                      ▲
                                      │ implements
                       ┌──────────────┴─────────────────┐
                       │   Driven adapters              │
                       │   (Neo4jRepository,            │
                       │    NosisEnricher,              │
                       │    PoseidonLoader,             │
                       │    SeniorHomeXlsxWriter, ...)  │
                       └────────────────────────────────┘
```

### Why hexagonal?

The original codebase mixed Excel parsing, Nosis HTTP calls, and Neo4j writes in single files. Adding a second data source (Senior Home) would have required either duplicating that code or branching with `if` statements throughout. Refactoring to hexagonal solved this by making the **application core source-agnostic** — it only knows about the `ISourceLoader`, `IEnricher`, `IGraphRepository`, and `ILoadOutputWriter` ports. Adding a new source now means writing exactly one new class that implements `ISourceLoader`, plus a thin CLI script to wire it up. No existing code changes.

### Layer responsibilities

#### Domain (`src/domain/`)

Pure data structures with no framework dependencies. This is the heart of the application — every other layer can depend on it, but it depends on nothing. Examples: `CuitNode`, `LoadableNode`, `PathSegment`, `RowLoadOutcome`.

#### Ports (`src/ports/`)

Abstract interfaces that define the contracts between layers. The application layer depends only on these abstractions, never on concrete classes. There are two kinds:

- **Inbound ports** — Define what the application can do (e.g. `ISource.search`).
- **Outbound ports** — Define what the application needs from outside (e.g. `IGraphRepository.findNode`, `IEnricher.resolveDocument`).

#### Application (`src/application/`)

Stateless services that orchestrate business operations by composing port calls. They contain the use-case logic but no infrastructure details.

- `CuitSearchService` — Searches a CUIT across multiple registered `ISource` adapters in parallel and aggregates the results.
- `LoaderService` — Orchestrates the full ingestion pipeline: ask a loader for rows, resolve each row's documents via the enricher, persist resolved nodes to the repository, fetch their relationship graphs, and emit per-row outcomes to the optional writer.

#### Infrastructure (`src/infrastructure/`)

Concrete implementations of the outbound ports. Each adapter is a self-contained module that knows about exactly one external system.

- `neo4j/` — Driver, repository, and Cypher query catalogue.
- `nosis/NosisEnricher` — Implements `IEnricher` against Nosis Manager.
- `loaders/PoseidonLoader`, `loaders/SeniorHomeLoader` — Implement `ISourceLoader` for their respective input formats.
- `output/SeniorHomeXlsxWriter` — Implements `ILoadOutputWriter` to produce a colour-coded Excel report.
- `csv/CsvSource` — Implements `ISource` for legacy CSV-based search.

#### Driving adapters (`src/routes/`, `src/scripts/`)

The outermost layer — the entry points that hand control to the application. HTTP routes for the running API, CLI scripts for batch operations. They are intentionally thin: they instantiate concrete adapters, wire them into a service, and delegate.


## Project structure

```
src/
├── domain/
│   └── entities.ts              ← Pure data structures
│
├── ports/
│   └── interfaces.ts            ← ISource, IGraphRepository, ISourceLoader,
│                                  IEnricher, ILoadOutputWriter
├── application/
│   ├── CuitSearchService.ts     ← Multi-source search orchestration
│   └── LoaderService.ts         ← Ingestion pipeline orchestration
│
├── infrastructure/
│   ├── csv/
│   │   └── CsvSource.ts         ← Legacy CSV search adapter
│   ├── neo4j/
│   │   ├── Neo4jDriver.ts       ← Driver singleton
│   │   ├── Neo4jRepository.ts   ← Implements IGraphRepository
│   │   ├── Neo4jSource.ts       ← Implements ISource using Neo4jRepository
│   │   └── queries.ts           ← Centralised Cypher catalogue
│   ├── nosis/
│   │   └── NosisEnricher.ts     ← Implements IEnricher using NosisScraper
│   ├── loaders/
│   │   ├── PoseidonLoader.ts    ← Implements ISourceLoader (Poseidon xlsx)
│   │   └── SeniorHomeLoader.ts  ← Implements ISourceLoader (Senior Home csv/xlsx)
│   └── output/
│       └── SeniorHomeXlsxWriter.ts ← Implements ILoadOutputWriter
│
├── scrapers/
│   ├── nosis.ts                 ← Low-level Nosis HTTP client
│   ├── nosisAuth.ts             ← Playwright-based login
│   └── nosisRelationshipTypes.ts ← Code → name mapping
│
├── auth/
│   ├── AuthService.ts           ← bcrypt + JWT
│   ├── UserRepository.ts        ← Reads/writes /data/users.json
│   └── activityLogger.ts        ← Pino-based audit log
│
├── middleware/
│   └── authMiddleware.ts        ← JWT verification
│
├── routes/
│   ├── auth.ts                  ← Login / logout
│   ├── cuit.ts                  ← Multi-source CUIT search
│   └── graph.ts                 ← Graph operations (paths, nodes, relationships)
│
├── scripts/
│   ├── loadFromPoseidon.ts      ← Loads Poseidon xlsx into Neo4j via LoaderService
│   ├── loadFromSeniorHome.ts    ← Loads Senior Home csv/xlsx via LoaderService
│   ├── scrapeToXlsx.ts          ← Read-only: enriches an xlsx with Nosis trees
│   ├── testNosis.ts             ← Manual Nosis debugging
│   └── createUser.ts            ← Creates a new auth user
│
└── index.ts                     ← Fastify entry point
```

## Design patterns

### Repository

The `IGraphRepository` port defines an abstract interface for all graph operations the application needs. `Neo4jRepository` is the concrete implementation. The application talks only to the interface, so swapping Neo4j for ArangoDB or Neptune in the future means writing one new repository class — nothing else changes.

This is a textbook Repository Pattern: it isolates data-access logic in a single class, abstracts the persistence technology behind an interface, and gives the rest of the code a clean, domain-oriented API.

### Adapter

Every class in `infrastructure/` is an adapter — it bridges the application's port abstractions to a specific external system (Neo4j, Nosis, an Excel file, the filesystem). Adapters are interchangeable as long as they honour their port's contract.

### Service Layer

`CuitSearchService` and `LoaderService` are application services that encapsulate use-case logic. They have no state, depend only on ports (injected at construction), and are easy to test with mock adapters.

### Dependency Injection (constructor-based)

All services and adapters receive their dependencies as constructor arguments. This makes them:
- **Trivially testable** — pass mock implementations instead of real ones.
- **Composable** — swap a `Neo4jRepository` for an in-memory one in a test.
- **Explicit** — every dependency is visible in the constructor signature.

There's no IoC container; explicit wiring is done in the entry points (`index.ts`, scripts). This keeps the trade-off simple: a tiny bit more boilerplate in exchange for full transparency.

### Singleton (managed scope)

`Neo4jDriver` exposes a single shared driver instance, because Neo4j explicitly recommends one driver per process. The singleton is opened lazily and closed once at shutdown.

### Strategy

`ISourceLoader` implementations are strategies — each one parses a different input format, but the `LoaderService` treats them all uniformly through the interface. Same for `ISource` (different search backends), `IEnricher` (different upstream providers), and `ILoadOutputWriter` (different output formats).

### Template Method (lightweight)

`LoaderService.run()` defines the skeleton of the ingestion algorithm:
1. Ask the loader for rows.
2. For each row, resolve every node, persist it, scrape its relationships, persist them.
3. Create inter-node relationships declared by the loader.
4. Emit outcomes to the writer.

The variability lives in the injected adapters; the algorithm itself is fixed.

### Factory

`NosisEnricher.create()` and `NosisScraper.create()` are async static factories — they perform the Playwright login during construction, something a regular constructor can't do.

## Adding a new data source

This is the moment of truth for any architecture. To add a new source — say, a SQL database called Triton — you need to do **exactly two things**:

1. **Write the loader.**
   Create `src/infrastructure/loaders/TritonLoader.ts` implementing `ISourceLoader`. Its only job is to read its specific format and yield a list of `LoadableRow` objects. It knows nothing about Nosis, Neo4j, or the output writer.

2. **Write the CLI script.**
   Create `src/scripts/loadFromTriton.ts`. It's a ~30-line file that instantiates the loader, the enricher, the repository, and the service, then calls `service.run()`.

That's it. No changes to the service, the enricher, the repository, the routes, or any existing loader. The architecture rewards you for adding new things without modifying old things — the Open-Closed Principle in practice.

If the new source also needs a custom output report, you can additionally implement `ILoadOutputWriter` and inject it.

## Running the project

### Prerequisites

- Node.js 22+
- pnpm 10+
- A Neo4j database (Aura recommended)
- Nosis Manager credentials (for ingestion scripts only)
- A `.env` file in the project root — see `.env.example`

### Environment variables

```
NEO4J_URI=neo4j+s://xxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=...
JWT_SECRET=...
JWT_EXPIRES_IN=8h
DATA_ROUTE=./data/users.json
LOG_ROUTE=./logs
LOG_DOC=activity.log
FRONT_ROUTE=http://localhost:5173
PORT=3000
NOSIS_USER=...
NOSIS_PASSWORD=...
```

### Install

```bash
pnpm setup
```

### Run the API

```bash
pnpm dev
```

The server listens on `http://localhost:3000`. Swagger UI is mounted at `/docs`.

## Available scripts

All scripts live under `src/scripts/` and are exposed via `package.json`.

### `pnpm dev`
Starts the Fastify API in watch mode via `tsx`.

### `pnpm test`
Runs the Vitest test suite.

### `pnpm load:poseidon [filePath] [startRow] [count] [sourceName]`
Loads a Poseidon-formatted xlsx file into Neo4j. Each row's CUIT is upserted as `inMyBase`, then Nosis is scraped for its relationship tree and the tree is merged into the graph.

```bash
pnpm load:poseidon ./sources/Filled-dbPoseidon.xlsx 1 100 poseidon
```

Defaults: `./sources/Filled-dbPoseidon.xlsx`, `startRow=1`, `count=10`, `sourceName=poseidon`.

### `pnpm load:seniorhome <inputPath> <outputPath> [startRow] [count]`
Loads a Senior Home csv or xlsx file. Each row produces up to two nodes (resident + responsible) plus a `Responsible` relationship between them. Generates a colour-coded report at `outputPath`:

- **Yellow** — Both resident and responsible loaded successfully.
- **Cyan** — Only the resident was loaded (responsible missing or not found).
- **Red** — Nothing was loaded.

```bash
pnpm load:seniorhome ./sources/seniorHome.csv ./output/seniorHome-log.xlsx 1 50
```

### `pnpm scrape:xlsx <inputPath> [outputPath] [startRow] [count]`
Read-only Nosis scrape that does NOT touch Neo4j. Reads an xlsx with a `CUIT` column and writes a new xlsx where each input row is followed by its relationship tree, expanded into level-indexed columns (Nivel 1, Nivel 2, ...). Useful for one-off enrichments or auditing.

```bash
pnpm scrape:xlsx ./sources/alyc.xlsx ./output/alyc-enriched.xlsx
```

### `pnpm nosis:test <taxId>`
Manual Nosis debugging — resolves a document, fetches its tree, and dumps the raw JSON to stdout.

### `pnpm create:user <username> <password>`
Creates a new authentication user (writes to `users.json`).

```bash
pnpm create:user admin 1234
```

### `pnpm generate:docs`
Generates HTML API documentation via TypeDoc in `./docs`.

## Database

The graph schema is intentionally minimal:

### Node label: `CUIT`

Properties:
- `id` — The 11-digit CUIT (no separators). Primary key.
- `businessName` — Full name or company name.
- `inMyBase` — Boolean. `true` for nodes that came from one of our source files (Poseidon, Senior Home, ...). `false` or `null` for enrichment nodes brought in by Nosis.
- `sources` — Array of source names that contributed this node (e.g. `["poseidon", "seniorHome"]`).
- `phone`, `email`, `birthday`, `entryDate`, `exitDate`, `loadedAt` — Optional contact and lifecycle fields.

### Relationship type: `RELATED_TO`

Properties:
- `type` — Human-readable relationship name (`"Employer"`, `"Manager"`, `"Responsible"`, ...).
- `source` — `"manual"` for relationships created via the API, otherwise unset for those brought in by enrichment.
- `createdAt` — Timestamp (manual relationships only).

### Query catalogue

All Cypher queries live in a single file: `src/infrastructure/neo4j/queries.ts`. Centralising them keeps the schema visible at a glance and makes auditing or optimising any single query trivial.

Notable design decisions:

- `MERGE_BASE_NODE` is **idempotent**: re-running it appends the source to the `sources` array only if not already present, and uses `COALESCE($attr, c.attr)` for every optional field so that `null` parameters preserve existing values instead of clobbering them.
- `DELETE_RELATIONSHIP` also performs **orphan cleanup**: if removing an edge leaves a node with no remaining relationships AND it's not `inMyBase`, the node itself is detached and deleted. This keeps the graph clean of zombie nodes left over from Nosis enrichment.

## Authentication

### User storage

Users are stored in a JSON file (path from `DATA_ROUTE`), with passwords hashed via bcrypt. The file is read on every login attempt — there's no in-memory cache, which is fine for the small user counts this system targets.

### JWT

Login returns a short-lived JWT (default 8h) signed with `JWT_SECRET`. The token is sent in the `Authorization: Bearer <token>` header for every protected request.

### Protected routes

All `/graph/*` routes require a valid JWT, enforced by `authMiddleware`. Auth events (login, logout, search, edit, ...) are written to a Pino log at `LOG_ROUTE/LOG_DOC`.

### Rate limiting

Fastify's rate-limit plugin restricts the public surface to 60 requests/minute/IP to protect against credential stuffing.


## Testing

The project uses Vitest. Run all tests with:

```bash
pnpm test
```

Tests follow the same hexagonal philosophy as the production code: services are tested in isolation by passing mock implementations of their ports. This keeps tests fast, deterministic, and free of network or filesystem dependencies.

Test files live next to the unit they cover under `src/tests/`. Coverage focuses on the application layer (the bits with actual logic) — the infrastructure adapters are integration points and are exercised end-to-end via the scripts.

## Deploy

The API is deployed to **Railway** with a `/data` volume mount for `users.json` and the activity log. The frontend is a separate React app deployed to **Render** as a static site.

Backend configuration on Railway:
- **Start command**: `npx tsx src/index.ts`
- **Volume mount**: `/data` for persistent files
- **Environment variables**: every entry from `.env.example` plus `NODE_ENV=production`
