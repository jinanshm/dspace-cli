"use strict";
/**
 * Zero-dependency REST facade over DSpace 4-6 XMLUI repositories.
 * Run:  bun src/server.js   (DSPACE_PORT=8787 by default)
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const ds = require("./dspace");

const PORT = Number(process.env.DSPACE_PORT || 8787);
const HOST = process.env.DSPACE_HOST || "127.0.0.1";

const startedAt = Date.now();
let requestCount = 0;

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": status === 200 ? "public, max-age=60" : "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: { status, message, ...(details ? { details } : {}) } });
}

function bool(v) {
  return v === "1" || v === "true" || v === "yes" || v === "";
}

function parseQueries(url) {
  const out = {};
  for (const k of new Set(url.searchParams.keys())) {
    const vals = url.searchParams.getAll(k);
    out[k] = vals.length > 1 ? vals : vals[0];
  }
  return out;
}

async function attachFiles(results, limit = 8) {
  const subset = results.slice(0, limit);
  await Promise.all(
    subset.map(async (r) => {
      try {
        const item = await ds.getItem(r.handle);
        if (item) {
          r.pdfUrl = item.pdfUrl;
          r.files = item.files.map((f) => ({ name: f.name, format: f.format, size: f.size, url: f.url, isPdf: f.isPdf }));
        }
      } catch (e) {
        r.enrichError = e.message;
      }
    })
  );
  return results;
}

const routes = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handler: async (req, res) => {
      sendJson(res, 200, {
        status: "ok",
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        requests: requestCount,
        configured: Boolean(ds.config.baseUrl),
        upstream: ds.config.baseUrl || null,
        platform: ds.config.platform || "DSpace XMLUI (detected on /api/stats)",
        runtime: ds.isBun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
        endpoints: [
          "GET /api/stats",
          "GET /api/search?q=&page=&size=&sort=&order=&collection=&field=&operator=&value=&hasFile=&includeFiles=",
          "GET /api/items/:handle",
          "GET /api/items/:handle/files",
          "GET /api/items/:handle/pdf[?proxy=1]",
          "GET /api/communities",
          "GET /api/communities/:handle",
          "GET /api/collections",
          "GET /api/raw?path=/discover%3Fquery%3Dx",
          "GET /openapi.yaml",
        ],
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/(?:api\/)?openapi\.yaml$/,
    handler: async (req, res) => {
      const spec = fs.readFileSync(path.join(__dirname, "..", "openapi.yaml"), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/yaml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(spec);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/stats$/,
    handler: async (req, res) => sendJson(res, 200, await ds.getStats()),
  },
  {
    method: "GET",
    pattern: /^\/api\/search$/,
    handler: async (req, res, { url }) => {
      const q = parseQueries(url);
      const opts = {
        q: q.q ?? q.query ?? "*:*",
        page: q.page ?? 1,
        size: q.size ?? q.rpp ?? 20,
        sort: q.sort ?? "relevance",
        order: q.order,
        collection: q.collection ?? q.scope,
        field: q.field ?? q.filtertype,
        operator: q.operator ?? q.filter_relational_operator,
        value: q.value ?? q.filter,
        hasFile: q.hasFile ? bool(q.hasFile) : false,
      };
      if (opts.size > 100) opts.size = 100;

      const out = await ds.search(opts);
      const size = Number(out.rpp || opts.size);
      const pages = size ? Math.max(1, Math.ceil(out.total / size)) : null;

      const body = {
        query: out.query,
        total: out.total,
        page: out.page,
        size,
        pages,
        showing: { from: out.from, to: out.to },
        tookMs: out.tookMs,
        sort: { by: opts.sort, order: (opts.order || "").toUpperCase() || null },
        results: out.results.map((r) => ({
          id: r.handle,
          handle: r.handle,
          title: r.title,
          authors: r.authors,
          publisher: r.publisher,
          issued: r.issued,
          abstract: r.abstract,
          url: r.url,
          pdfUrl: r.pdfUrl ?? null,
          files: r.files ?? undefined,
        })),
        upstream: out.upstream,
      };

      if (q.includeFiles && bool(q.includeFiles)) {
        // Default to enriching the whole page; callers opted in explicitly.
        // enrichLimit can still cap it (0 = metadata only).
        const requested = Number(q.enrichLimit);
        const limit =
          Number.isFinite(requested) && requested >= 0
            ? Math.min(requested, body.results.length)
            : body.results.length;
        await attachFiles(body.results, limit);
        body.enrichedCount = body.results.filter((r) => r.pdfUrl).length;
        body.enrichLimit = limit;
      }
      sendJson(res, 200, body);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/items\/(.+?)\/files$/,
    handler: async (req, res, { params }) => {
      const item = await ds.getItem(decodeURIComponent(params[0]));
      if (!item) return sendError(res, 404, "Item not found");
      sendJson(res, 200, {
        handle: item.handle,
        title: item.title,
        count: item.files.length,
        files: item.files,
        pdfUrl: item.pdfUrl,
        itemUrl: item.url,
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/items\/(.+?)\/pdf$/,
    handler: async (req, res, { params, url }) => {
      const handle = decodeURIComponent(params[0]);
      const found = await ds.resolvePdf(handle);
      if (!found) return sendError(res, 404, "No PDF file found for this item");
      if (url.searchParams.has("proxy")) {
        const upstream = await ds.rawRequestPublic(found.url, { binary: true });
        if (upstream.status !== 200) return sendError(res, 502, `Upstream PDF HTTP ${upstream.status}`);
        res.writeHead(200, {
          "Content-Type": upstream.headers["content-type"] || "application/pdf",
          "Content-Length": upstream.buffer.length,
          "Content-Disposition": `inline; filename="${(found.filename || "document.pdf").replace(/"/g, "")}"`,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(upstream.buffer);
      }
      res.writeHead(302, { Location: found.url, "Access-Control-Allow-Origin": "*" });
      res.end();
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/items\/(.+)$/,
    handler: async (req, res, { params, url }) => {
      const item = await ds.getItem(decodeURIComponent(params[0]), {
        full: bool(url.searchParams.get("full") || "true"),
      });
      if (!item) return sendError(res, 404, "Item not found");
      sendJson(res, 200, item);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/communities$/,
    handler: async (req, res) => {
      const communities = await ds.getCommunities();
      sendJson(res, 200, { count: communities.length, communities });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/communities\/(.+)$/,
    handler: async (req, res, { params }) => {
      const c = await ds.getCommunity(decodeURIComponent(params[0]));
      sendJson(res, 200, c);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/collections$/,
    handler: async (req, res) => {
      const communities = await ds.getCommunities();
      const collections = [];
      await Promise.all(
        communities.map(async (c) => {
          try {
            const detail = await ds.getCommunity(c.handle);
            for (const col of detail.collections) collections.push({ ...col, community: c.name });
          } catch {
            /* skip broken community */
          }
        })
      );
      collections.sort((a, b) => (b.itemCount || 0) - (a.itemCount || 0));
      sendJson(res, 200, { count: collections.length, collections });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/raw$/,
    handler: async (req, res, { url }) => {
      const path = url.searchParams.get("path");
      if (!path || !path.startsWith("/")) return sendError(res, 400, "Provide ?path=/discover?...");
      const upstream = await ds.fetchRaw(path);
      sendJson(res, 200, {
        upstream: upstream.url,
        status: upstream.status,
        contentType: upstream.headers["content-type"],
        bytes: upstream.buffer.length,
        body: upstream.text.slice(0, 200000),
      });
    },
  },
];

const server = http.createServer(async (req, res) => {
  requestCount++;
  const started = Date.now();
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }
    if (req.method !== "GET") return sendError(res, 405, "Only GET is supported");

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/api") {
      res.writeHead(302, { Location: "/api/health" });
      return res.end();
    }

    for (const route of routes) {
      const m = url.pathname.match(route.pattern);
      if (!m) continue;
      return await route.handler(req, res, { params: m.slice(1), url });
    }
    sendError(res, 404, `No route for ${url.pathname}. See /api/health`);
  } catch (e) {
    sendError(res, 502, e.message, { upstream: e.url });
  } finally {
    const ms = Date.now() - started;
    if (process.env.DSPACE_LOG !== "0") {
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${ms}ms`);
    }
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Another server instance is still running.\n` +
        `  Windows:  Get-Process bun,node -ErrorAction SilentlyContinue | Stop-Process -Force\n` +
        `  or set DSPACE_PORT to a free port.`
    );
  } else {
    console.error(`Server error: ${e.message}`);
  }
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`DSpace XMLUI REST API on http://${HOST}:${PORT}/api/health`);
    if (!ds.config.baseUrl) {
      console.warn("DSPACE_BASE_URL is not set; requests will fail until it is configured.");
    } else {
      console.log(
        `Upstream: ${ds.config.baseUrl}${ds.config.contextPath} (TLS verify ${ds.config.verifyTls ? "on" : "off"})`
      );
    }
  });
}

module.exports = { server, attachFiles };
