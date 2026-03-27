# CUIT API

A REST API to search for CUITs across multiple data sources, with graph-based relationship tracking using Neo4j.

## Requirements

- Node.js 20+
- pnpm
- Neo4j Aura account (free tier available at aura.neo4j.io)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `NEO4J_URI` | Your Neo4j Aura connection URI (starts with `neo4j+s://`) |
| `NEO4J_USER` | Neo4j username (default: `neo4j`) |
| `NEO4J_PASSWORD` | Neo4j password set during instance creation |

### 3. Set up Neo4j

In your Neo4j Aura query editor, create the index:

```cypher
CREATE INDEX cuit_id IF NOT EXISTS
FOR (c:CUIT) ON (c.id)
```

### 4. Load initial data

```bash
pnpm load:cuits
```

### 5. Run the server

```bash
pnpm dev
```

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

```
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
```

## Nosis Scraper

Scrapes relationship trees from Nosis Manager and stores them in Neo4j.

### Setup

Add Nosis credentials to `.env`:
```env
NOSIS_USER=your_nosis_user
NOSIS_PASSWORD=your_nosis_password
```

### Usage
```bash
pnpm nosis:test <taxId>
```

Example:
```bash
pnpm nosis:test 20461235787
```

### How it works

1. Logs in to Nosis Manager using Playwright (headless browser)
2. Searches for the given Tax ID
3. Fetches the relationship tree (up to 2 levels deep, max 49 nodes)
4. Maps the tree to Neo4j graph format
5. Inserts nodes and relationships into Neo4j

### Limitations

- Session expires after some time — scraper re-logs in automatically on retry
- Maximum 2 levels of relationships per query (Nosis limitation)
- Maximum 49 nodes per query (Nosis limitation)
- 1 second delay between requests to avoid rate limiting
- Relationship type codes are mapped manually in `nosisRelationshipTypes.ts` — unknown codes fall back to `Unknown (code)`

## Graph API

Endpoints to query the Neo4j graph database.

### GET /graph/cuit/:taxId

Searches for a Tax ID in the graph.

- If `inMyBase` is `true` → returns node info directly
- If `inMyBase` is `false` → returns paths to connected nodes with `inMyBase: true`
- If not found → 404

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxDepth` | number | 3 | Maximum path depth (1–10) |

**Example**
```bash
GET /graph/cuit/30710687389?maxDepth=3
```
```json
{
  "cuit": "30710687389",
  "found": true,
  "results": [
    {
      "source": "neo4j",
      "file": "neo4j",
      "data": {
        "businessName": "WIRSOLUT SA",
        "inMyBase": false,
        "pathToBase": [
          { "taxId": "30710687389", "businessName": "WIRSOLUT SA", "relationshipType": "Employer" },
          { "taxId": "20461235787", "businessName": "Sielecki Santiago Agustin", "relationshipType": "" }
        ]
      }
    }
  ]
}
```

---

### GET /graph/path

Finds the shortest path between two Tax IDs in the graph.

**Query parameters**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `from` | string | ✅ | — | Starting Tax ID |
| `to` | string | ✅ | — | Target Tax ID |
| `maxDepth` | number | ❌ | 3 | Maximum path depth (1–10) |

**Example**
```bash
GET /graph/path?from=20222935785&to=27044838317&maxDepth=3
```
```json
{
  "found": true,
  "path": [
    { "taxId": "20222935785", "businessName": "Sielecki Luciano Andres", "relationshipType": "Employer" },
    { "taxId": "30590745797", "businessName": "Cooperativa Credivico", "relationshipType": "Employee" },
    { "taxId": "27044838317", "businessName": "Lubel Mirta Luisa", "relationshipType": "" }
  ]
}
```

**Error responses**

| Code | Reason |
|---|---|
| 400 | `from` and `to` are the same, or `maxDepth` is invalid |
| 404 | No path found between the two Tax IDs |
| 500 | Graph database unavailable |