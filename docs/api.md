# REST API reference

Base URL when running locally: `http://127.0.0.1:8787`

All endpoints are `GET`, return JSON (except the PDF redirect), and send
`Access-Control-Allow-Origin: *`.

The service is a cached facade over a DSpace XMLUI repository. Where useful, the
upstream URL used for a response is included in the `upstream` field.

Configure the target with `DSPACE_BASE_URL` (required) and `DSPACE_CONTEXT`
(default `/xmlui`).

---

## `GET /api/health`

Liveness and endpoint discovery.

```json
{
  "status": "ok",
  "uptimeSeconds": 42,
  "requests": 7,
  "configured": true,
  "upstream": "https://repository.example.org",
  "platform": "DSpace 6.0 (XMLUI/Cocoon)",
  "runtime": "bun 1.4.2",
  "endpoints": ["GET /api/stats", "GET /api/search?…", "…"]
}
```

`configured` is `false` when `DSPACE_BASE_URL` is unset; the process still
starts, but upstream calls fail until it is configured.

---

## `GET /api/stats`

Repository totals (two upstream searches).

```json
{
  "items": 12000,
  "itemsWithFiles": 8000,
  "platform": "DSpace 6.0 (XMLUI / Mirage theme)",
  "baseUrl": "https://repository.example.org",
  "contextPath": "/xmlui",
  "fetchedAt": "2026-01-01T12:00:00.000Z"
}
```

---

## `GET /api/search`

The main endpoint. Maps 1:1 onto Discovery.

### Query parameters

| Param | Alias | Default | Description |
| --- | --- | --- | --- |
| `q` | `query` | `*:*` | Solr query. Supports `AND`, `OR`, quotes, `title:`, `author:`. |
| `page` | — | `1` | 1-based page |
| `size` | `rpp` | `20` | 1–100 (upstream may accept more; capped) |
| `sort` | — | `relevance` | `relevance`, `title`, `date`, `dateAsc`, `author` |
| `order` | — | per sort | `asc` / `desc` |
| `collection` | `scope` | — | Community/collection handle, e.g. `123456789/42` |
| `field` | `filtertype` | — | `title`, `author`, `subject`, `dateIssued`, `has_content_in_original_bundle` |
| `operator` | `filter_relational_operator` | `contains` | `contains`, `equals`, `authority`, `notcontains`, `notequals`, `notauthority` |
| `value` | `filter` | — | Filter value |
| `hasFile` | — | `false` | Only items with a bitstream |
| `includeFiles` | — | `false` | Fetch item pages and attach `pdfUrl` + `files` to each result (one extra upstream request per result) |
| `enrichLimit` | — | whole page | Cap how many results get enriched (`0` = metadata only) |

### Response

```json
{
  "query": "medicine",
  "total": 42,
  "page": 1,
  "size": 2,
  "pages": 21,
  "showing": { "from": 1, "to": 2 },
  "tookMs": 4,
  "sort": { "by": "relevance", "order": "DESC" },
  "results": [
    {
      "id": "123456789/42",
      "handle": "123456789/42",
      "title": "Sample Item One",
      "authors": ["Doe, Jane", "Roe, Richard"],
      "publisher": "Example Press",
      "issued": "2024-05-01",
      "abstract": "…highlighted snippet or null…",
      "url": "https://repository.example.org/xmlui/handle/123456789/42",
      "pdfUrl": "https://repository.example.org/xmlui/bitstream/handle/123456789/42/paper.pdf?sequence=1&isAllowed=y"
    }
  ],
  "upstream": "https://repository.example.org/xmlui/discover?query=medicine&rpp=2&…"
}
```

`pdfUrl` and `files` are only present with `includeFiles=1`. Without it,
`pdfUrl` is `null` — Discovery results contain no file links; each PDF has to be
resolved from the item page. When enrichment is on, `enrichedCount` reports how
many results actually had a usable file, and `enrichLimit` echoes the cap.

### Examples

```
/api/search?q=medicine&size=5
/api/search?q=*:*&collection=123456789/42&size=3
/api/search?q=*:*&field=dateIssued&operator=equals&value=2024
/api/search?q=title:microbiology&sort=date&order=desc
/api/search?q=*:*&hasFile=1&includeFiles=1&size=5
```

---

## `GET /api/items/:handle`

Full record. Handle may be `123456789/42` or URL-encoded `123456789%2F42`.
Query params: `full=true` (default) includes the `dcMetadata` table.

```json
{
  "handle": "123456789/42",
  "title": "Sample Item One",
  "authors": ["Doe, Jane"],
  "publisher": "Example Press",
  "issued": "2024-05-01",
  "type": "Article",
  "language": "en",
  "subject": ["Sample data"],
  "abstract": "A short abstract.",
  "uri": "http://localhost:8080/xmlui/handle/123456789/42",
  "metadata": {
    "DC.title": [{ "value": "Sample Item One", "lang": "en_US", "scheme": null }],
    "DCTERMS.issued": [{ "value": "2024-05-01", "lang": null, "scheme": "DCTERMS.W3CDTF" }]
  },
  "collections": [
    { "handle": "123456789/7", "name": "Sample Collection", "url": "…", "itemCount": 12 }
  ],
  "files": [
    {
      "name": "paper.pdf",
      "filename": "paper.pdf",
      "size": "120.5Kb",
      "format": "PDF",
      "sequence": 1,
      "url": "https://repository.example.org/xmlui/bitstream/handle/123456789/42/paper.pdf?sequence=1&isAllowed=y",
      "isPdf": true
    }
  ],
  "pdfUrl": "https://repository.example.org/xmlui/bitstream/handle/123456789/42/paper.pdf?sequence=1&isAllowed=y",
  "url": "https://repository.example.org/xmlui/handle/123456789/42",
  "dcMetadata": [
    { "field": "dc.contributor.author", "value": "Doe, Jane", "lang": "en_US" },
    { "field": "dc.subject", "value": "Sample data", "lang": null }
  ]
}
```

Some records store internal `localhost:8080` links in their metadata. The `uri`
field is returned verbatim; use `url` for a working link.

---

## `GET /api/items/:handle/files`

Just the bitstreams.

```json
{
  "handle": "123456789/42",
  "title": "Sample Item One",
  "count": 1,
  "files": [
    {
      "name": "paper.pdf",
      "size": "120.5Kb",
      "format": "PDF",
      "url": "…",
      "isPdf": true
    }
  ],
  "pdfUrl": "…",
  "itemUrl": "…"
}
```

---

## `GET /api/items/:handle/pdf`

- Default: **302** to the direct upstream PDF.
- `?proxy=1`: streams the bytes through this server (useful when a client cannot
  accept the repository certificate).

Upstream returns `application/pdf` and supports `Range`.

---

## `GET /api/communities`

Top-level communities scraped from `/xmlui/`.

```json
{
  "count": 3,
  "communities": [
    { "handle": "123456789/7", "name": "Sample Community", "itemCount": 120, "url": "…" }
  ]
}
```

## `GET /api/communities/:handle`

One community with its sub-communities and collections.

```json
{
  "handle": "123456789/7",
  "name": "Sample Community",
  "url": "…",
  "subcommunities": [],
  "collections": [
    { "handle": "123456789/8", "name": "Sample Collection", "itemCount": 12 }
  ]
}
```

## `GET /api/collections`

All collections across all communities, sorted by item count (one upstream
request per community; cached).

---

## `GET /api/raw?path=/discover?query=test`

Debug passthrough: returns status, content type, byte count and the first 200 KB
of the upstream body. Useful when upstream markup changes.

---

## Errors

```json
{
  "error": {
    "status": 502,
    "message": "Timeout after 45000ms: …",
    "details": { "upstream": "…" }
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Bad request (e.g. `/api/raw` without `path`) |
| 404 | Item/route not found |
| 405 | Non-GET method |
| 422 | Target is DSpace 7+ (Angular), not XMLUI |
| 502 | Upstream failure (timeout, 5xx, TLS) |

---

## Operational behaviour

- **Target**: any DSpace 4–6 XMLUI instance. Set `DSPACE_BASE_URL`,
  `DSPACE_CONTEXT` (`/xmlui` by default, `""` when mounted at root) and leave
  `DSPACE_TLS_VERIFY` on unless the certificate is broken.
- **Cache**: successful HTML GETs are cached for 5 minutes (configurable via
  `DSPACE_CACHE_TTL_MS`), max ~400 entries.
- **Concurrency**: 4 upstream requests at a time (`DSPACE_CONCURRENCY`), with
  one retry on 5xx or timeout.
- **Timeouts**: 45 s (`DSPACE_TIMEOUT_MS`).
- **TLS**: verification is on by default. With `DSPACE_TLS_VERIFY=0`, legacy
  renegotiation is also enabled where the runtime supports it. Bun/BoringSSL
  rejects Node's `SSL_OP_LEGACY_SERVER_CONNECT` and custom cipher strings, so the
  option set is chosen per runtime.
- **URL rewriting**: absolute links pointing at `localhost`, `127.0.0.1` or a
  `:8080` host are rewritten to the configured base URL.
- The service is read-only and unauthenticated; it never posts or modifies data.
