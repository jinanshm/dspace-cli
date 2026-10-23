# dspace-xmlui

A small **REST API and CLI for DSpace 4–6 XMLUI repositories**. It exposes
search results, item metadata, file lists and PDF links as JSON by reading the
repository's server-rendered Discovery pages.

This is useful when a pre-7 deployment has no usable JSON API: legacy REST can be
firewalled, OAI-PMH may be incomplete, and OpenSearch may be absent. XMLUI's
Discovery interface is still fully parameterised, so it can be queried and
parsed reliably.

- Zero runtime dependencies (Node built-ins only)
- Runs on **Bun 1.1+** (recommended) or **Node 18+**
- Read-only: no authentication, writes or admin operations

API reference: [`docs/api.md`](docs/api.md) · OpenAPI: [`openapi.yaml`](openapi.yaml)

## Requirements

- [Bun](https://bun.sh) 1.1+ (recommended), or Node 18+
- Network access to the target repository

## Configuration

All configuration is environment-based. Only `DSPACE_BASE_URL` is required.

| Variable | Default | Description |
| --- | --- | --- |
| `DSPACE_BASE_URL` | — (required) | Repository origin, e.g. `https://repository.example.org` |
| `DSPACE_CONTEXT` | `/xmlui` | XMLUI context path; `""` when mounted at the host root |
| `DSPACE_TLS_VERIFY` | `1` | Set `0` only for expired or self-signed certificates |
| `DSPACE_TIMEOUT_MS` | `45000` | Per-request timeout |
| `DSPACE_CONCURRENCY` | `4` | Parallel upstream requests |
| `DSPACE_CACHE_TTL_MS` | `300000` | HTML cache lifetime (5 minutes) |
| `DSPACE_USER_AGENT` | `dspace-xmlui-explorer/1.0` | Outgoing `User-Agent` |
| `DSPACE_PORT` | `8787` | REST server port |
| `DSPACE_HOST` | `127.0.0.1` | REST server bind address |
| `DSPACE_LOG` | `1` | Set `0` to silence request logs |

Example (bash):

```bash
export DSPACE_BASE_URL=https://repository.example.org
export DSPACE_CONTEXT=/xmlui
```

PowerShell:

```powershell
$env:DSPACE_BASE_URL = "https://repository.example.org"
$env:DSPACE_CONTEXT = "/xmlui"
```

## Quick start

Start the API:

```bash
DSPACE_BASE_URL=https://repository.example.org bun src/server.js
# DSpace XMLUI REST API on http://127.0.0.1:8787/api/health
```

Query it:

```bash
curl "http://127.0.0.1:8787/api/search?q=medicine&size=5"
curl "http://127.0.0.1:8787/api/search?q=*:*&hasFile=1&includeFiles=1&size=3"
curl "http://127.0.0.1:8787/api/items/123456789/42"
curl -L "http://127.0.0.1:8787/api/items/123456789/42/pdf" -o paper.pdf
```

PowerShell:

```powershell
$env:DSPACE_BASE_URL = "https://repository.example.org"
bun src/server.js
```

### Detached server (Windows)

```powershell
bun run start:bg     # hidden process; writes data/server.pid and data/server.log
bun run stop         # stops the recorded pid (or whatever owns the port)
```

## CLI

The CLI uses the same client and does not need the server:

```bash
DSPACE_BASE_URL=https://repository.example.org bun src/cli.js stats
DSPACE_BASE_URL=https://repository.example.org bun src/cli.js search "medicine" --size 5
DSPACE_BASE_URL=https://repository.example.org bun src/cli.js item 123456789/42 --json
DSPACE_BASE_URL=https://repository.example.org bun src/cli.js pdf 123456789/42
DSPACE_BASE_URL=https://repository.example.org bun src/cli.js harvest --out data/items.ndjson --max 100 --include-files
```

Per-command overrides avoid exporting the environment:

```bash
bun src/cli.js stats --base-url https://repository.example.org
```

Install it globally as `dspace-cli`:

```bash
bun link
dspace-cli stats --base-url https://repository.example.org
```

Bun puts the shim in `~/.bun/bin`, which is normally already on `PATH`. If the
command is not found, add that directory to `PATH` and restart the terminal. If
you change the shebang, run `bun unlink && bun link` again.

## Search

`/xmlui/discover` accepts the following parameters, which map to the API:

| Parameter | Meaning |
| --- | --- |
| `query` | Solr query; defaults to `*:*`. Supports `AND`, `OR`, quotes, `title:`, `author:` |
| `rpp` | Results per page (capped at 100) |
| `page` | 1-based page number |
| `sort_by` / `order` | `score`, `dc.title_sort`, `dc.date.issued_dt`, `dc.contributor.author_sort` |
| `filtertype_N`, `filter_relational_operator_N`, `filter_N` | Field filters (`title`, `author`, `subject`, `dateIssued`, `has_content_in_original_bundle`) |

Scoped search is a path, not a parameter:

```
/xmlui/handle/<handle>/discover?query=*:*
```

Discovery result pages contain **no file links**. PDFs are resolved from the
item page, which exposes `citation_pdf_url` and a `.file-wrapper` list pointing
at `/xmlui/bitstream/...`.

## PDF links

By default `/api/search` returns `pdfUrl: null` because enriching every result
costs one extra upstream request per item. Enable it explicitly:

```bash
# enrich the whole page
curl "http://127.0.0.1:8787/api/search?q=medicine&size=5&includeFiles=1"

# only items with files, capped at 20
curl "http://127.0.0.1:8787/api/search?q=*:*&size=20&hasFile=1&includeFiles=1&enrichLimit=20"
```

- `includeFiles=1` adds `pdfUrl` and `files[]` to each result.
- `enrichLimit=N` caps how many results are enriched; `0` disables it.
- `hasFile=1` excludes records that have no bitstreams.

If you already have a handle:

```bash
curl "http://127.0.0.1:8787/api/items/123456789/42/files"   # pdfUrl + files
curl "http://127.0.0.1:8787/api/items/123456789/42"         # full record
curl -L "http://127.0.0.1:8787/api/items/123456789/42/pdf" -o paper.pdf
```

## API at a glance

| Endpoint | Purpose |
| --- | --- |
| `GET /api/search?q=&page=&size=&sort=&collection=&field=&value=&hasFile=&includeFiles=` | Search |
| `GET /api/items/:handle` | Full record (DC metadata, files, collections) |
| `GET /api/items/:handle/files` | Bitstreams + `pdfUrl` |
| `GET /api/items/:handle/pdf[?proxy=1]` | Redirect or stream the PDF |
| `GET /api/communities`, `/api/communities/:handle` | Structure |
| `GET /api/collections` | All collections |
| `GET /api/stats`, `/api/health` | Totals / liveness |
| `GET /api/raw?path=/discover?…` | Debug passthrough |
| `GET /openapi.yaml` | OpenAPI 3.0 specification |

Full schemas and examples: [`docs/api.md`](docs/api.md).

## Compatibility

Targets the **pre-7 XMLUI** interface (`/xmlui/discover`, `.file-wrapper`,
`?show=full`).

- **DSpace 5–6 XMLUI**: expected to work; Discovery parameters and markup are
  stable across these releases.
- **DSpace 4 XMLUI**: search likely works; item file lists may differ.
- **DSpace 7/8**: not supported. The client detects the Angular shell and
  returns a clear error; use `/server/api` instead.
- **JSPUI**: not supported (different URLs and markup).
- **Custom themes**: work as long as structural classes such as
  `ds-artifact-item`, `file-wrapper` and `ds-referenceSet-list` are preserved.
- **Restricted/embargoed bitstreams**: the URL resolves, but downloads may
  redirect to a login page.
- **WAF/bot protection**: some repositories reject non-browser clients with
  HTTP 403; the API reports that explicitly.

## Tests

```bash
bun test
```

Tests are offline: they run the parsers against small synthetic XMLUI fixtures,
so they do not contact any repository.

## Layout

```
src/dspace.js       HTTP client (TLS, retries, cache, limiter) + HTML parsers
src/server.js       zero-dependency REST server
src/cli.js          stats/search/item/community/pdf/harvest commands
test/               offline parser tests + fixtures
docs/api.md         endpoint reference
openapi.yaml        OpenAPI 3.0 specification
scripts/            detached start/stop helpers (Windows)
```

## Notes and limitations

- This is **scraping**, not an official API. Markup changes upstream can break
  the parsers; the fixture tests catch parser regressions.
- Responses are cached for 5 minutes, concurrency is limited to 4, and the
  harvester waits between requests. Keep usage polite.
- Some metadata contains internal `host:port` links. The parser rewrites
  absolute links to the configured base, but the raw `uri` metadata value is
  preserved verbatim.
- TLS verification is enabled by default. If a repository uses an expired
  certificate, set `DSPACE_TLS_VERIFY=0`; the client then enables legacy
  renegotiation where the runtime supports it.
- If the server fails with `EADDRINUSE`, another process owns the port (default
  `8787`). Stop it or set `DSPACE_PORT`.

## License

MIT — see [LICENSE](LICENSE).
