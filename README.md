# CUIT API

A REST API to search for CUITs across multiple data sources, with graph-based relationship tracking using Neo4j.

## Requirements

- Node.js 20+
- pnpm
- Neo4j Aura account (free tier available at aura.neo4j.io)

## Setup

### 1. Install dependencies

\`\`\`bash
pnpm install
\`\`\`

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

\`\`\`bash
cp .env.example .env
\`\`\`

| Variable | Description |
|---|---|
| `NEO4J_URI` | Your Neo4j Aura connection URI (starts with `neo4j+s://`) |
| `NEO4J_USER` | Neo4j username (default: `neo4j`) |
| `NEO4J_PASSWORD` | Neo4j password set during instance creation |

### 3. Set up Neo4j

In your Neo4j Aura query editor, create the index:

\`\`\`cypher
CREATE INDEX cuit_id IF NOT EXISTS
FOR (c:CUIT) ON (c.id)
\`\`\`

### 4. Load initial data

\`\`\`bash
pnpm load:cuits
\`\`\`

### 5. Run the server

\`\`\`bash
pnpm dev
\`\`\`

## API

Documentation available at `http://localhost:3000/docs` when the server is running.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/cuit/:cuit` | Search for a CUIT across all sources |

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Start development server |
| `pnpm test` | Run tests |
| `pnpm load:cuits` | Load CUITs from CSV into Neo4j |
| `pnpm generate:docs` | Generate TypeDoc documentation |

## Data Sources

| Source | Type | Description |
|---|---|---|
| `csv-poseidon` | CSV | Local CSV file with client data |

## Project Structure

\`\`\`
src/
├── config.ts          # Environment variables
├── index.ts           # Fastify server
├── schemas.ts         # Shared OpenAPI schemas
├── helpers/
│   └── cuitHandler.ts # Route business logic
├── routes/
│   └── cuit.ts        # API endpoints
├── scripts/
│   └── loadCuits.ts   # Data loading scripts
├── sources/
│   ├── ISource.ts     # Source interface
│   └── CsvSource.ts   # CSV adapter
└── tests/
    └── cuit.test.ts   # Tests
\`\`\`