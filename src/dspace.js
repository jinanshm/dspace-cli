"use strict";
/**
 * Client for DSpace 4-6 XMLUI repositories.
 *
 * Many pre-7 deployments expose no usable JSON API: the legacy REST endpoint
 * may be firewalled, OAI-PMH may be partially broken and OpenSearch may be
 * absent. Their XMLUI Discovery search is nonetheless fully parameterised and
 * server-rendered, so this client parses it:
 *
 *   /discover?query=&rpp=&page=&sort_by=&order=&filtertype_0=...
 *
 * Parsers rely on structural DSpace markup (Discovery result items, item file
 * lists, Dublin Core <meta> tags), not on a specific theme.
 *
 * Configure with DSPACE_BASE_URL (required), DSPACE_CONTEXT (default /xmlui)
 * and DSPACE_TLS_VERIFY (default on).
 */

const https = require("node:https");
const http = require("node:http");
const zlib = require("node:zlib");
const { URL } = require("node:url");

function normalizeContext(v) {
  if (!v) return "/xmlui";
  let c = String(v).trim();
  if (c === "/" || c === "") return "";
  if (!c.startsWith("/")) c = "/" + c;
  return c.replace(/\/+$/, "");
}

const config = {
  baseUrl: (process.env.DSPACE_BASE_URL || "").replace(/\/+$/, ""),
  // Some installs serve XMLUI at "/" or "/dspace/xmlui" instead of "/xmlui".
  contextPath: normalizeContext(process.env.DSPACE_CONTEXT),
  // Verification is on by default; set DSPACE_TLS_VERIFY=0 for broken certs.
  verifyTls: !/^(0|false|no)$/i.test(process.env.DSPACE_TLS_VERIFY || "1"),
  timeoutMs: Number(process.env.DSPACE_TIMEOUT_MS || 45000),
  concurrency: Number(process.env.DSPACE_CONCURRENCY || 4),
  cacheTtlMs: Number(process.env.DSPACE_CACHE_TTL_MS || 5 * 60 * 1000),
  userAgent:
    process.env.DSPACE_USER_AGENT ||
    "dspace-xmlui-explorer/1.0 (documentation/research; bun)",
  platform: null,
  isAngular: false,
};

function requireBaseUrl() {
  if (!config.baseUrl) {
    throw new Error(
      "DSPACE_BASE_URL is not set. Example: DSPACE_BASE_URL=https://repository.example.org"
    );
  }
  return config.baseUrl;
}

/* ------------------------------------------------------------------ */
/* Small text helpers                                                   */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function safeFromCodePoint(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(s) {
  return decodeEntities(String(s || ""))
    .replace(/\uFEFF/g, "")
    .replace(/\u00ad/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href) {
  if (!href) return null;
  let h = decodeEntities(href.trim());
  // Upstream metadata is full of internal links (localhost:8080, host:8080).
  h = h
    .replace(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i, config.baseUrl)
    .replace(/^https?:\/\/[^/]+:8080(?=\/|$)/i, config.baseUrl);
  if (/^https?:\/\//i.test(h)) return h.replace(/^http:/i, "https:");
  if (h.startsWith("/")) return config.baseUrl + h;
  return config.baseUrl + "/" + h.replace(/^\.?\//, "");
}

function handleFromHref(href) {
  const m = String(href || "").match(/\/handle\/([^/?#]+(?:\/[^/?#]+)?)/);
  return m ? m[1] : null;
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* HTTP layer (expired TLS cert upstream -> verification disabled)      */
/* ------------------------------------------------------------------ */

const crypto = require("node:crypto");
// Bun uses BoringSSL and rejects Node's SSL_OP_LEGACY_SERVER_CONNECT flag
// outright ("INVALID_COMMAND"), while Node/OpenSSL 3 needs it because the
// upstream Tomcat requires unsafe legacy renegotiation. Pick options per runtime.
// TLS verification is off either way: the repository certificate has expired.
const isBun = typeof Bun !== "undefined" || Boolean(process.versions.bun);

const tlsOptions = {
  rejectUnauthorized: config.verifyTls,
  keepAlive: true,
  maxSockets: 8,
};
if (!config.verifyTls) tlsOptions.minVersion = "TLSv1";
if (!isBun && !config.verifyTls) {
  tlsOptions.ciphers = "DEFAULT@SECLEVEL=1";
  tlsOptions.secureOptions = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT;
}
const agent = new https.Agent(tlsOptions);

class Semaphore {
  constructor(n) {
    this.n = Math.max(1, n);
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.n) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const limiter = new Semaphore(config.concurrency);

const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  if (cache.size > 400) {
    // drop oldest ~25 entries
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= 25) break;
    }
  }
  cache.set(key, { value, expires: Date.now() + config.cacheTtlMs });
}

function decompress(buf, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip":
      return zlib.gunzipSync(buf);
    case "deflate":
      return zlib.inflateSync(buf);
    case "br":
      return zlib.brotliDecompressSync(buf);
    default:
      return buf;
  }
}

function rawRequest(url, { binary = false, redirects = 4, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return done(reject, e);
    }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      u,
      {
        method: "GET",
        agent: u.protocol === "https:" ? agent : undefined,
        headers: {
          "User-Agent": config.userAgent,
          Accept: binary ? "*/*" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          ...headers,
        },
        timeout: config.timeoutMs,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = absolutize(res.headers.location);
          return rawRequest(next, { binary, redirects: redirects - 1, headers }).then(
            (v) => done(resolve, v),
            (e) => done(reject, e)
          );
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body = Buffer.concat(chunks);
          try {
            body = decompress(body, res.headers["content-encoding"]);
          } catch {
            /* keep raw bytes if decompression fails */
          }
          done(resolve, {
            status: res.statusCode,
            headers: res.headers,
            url: url,
            buffer: body,
            text: binary ? null : body.toString("utf8"),
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout after ${config.timeoutMs}ms: ${url}`)));
    req.on("error", (e) => done(reject, e));
    req.end();
  });
}

async function request(url, opts = {}) {
  const cacheable = !opts.binary && opts.cache !== false;
  const key = url;
  if (cacheable) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  await limiter.acquire();
  try {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await rawRequest(url, opts);
        if (res.status >= 500 && attempt === 0) {
          await sleep(400);
          continue;
        }
        if (cacheable && res.status === 200) cacheSet(key, res);
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await sleep(500);
      }
    }
    throw lastErr;
  } finally {
    limiter.release();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function xmlui(path) {
  return requireBaseUrl() + config.contextPath + path;
}

/** Detect the DSpace version from the XMLUI home page (cached). */
async function getPlatform() {
  if (config.platform) return config.platform;
  try {
    const res = await request(xmlui("/"));
    if (/<ds-app[\s>]|ng-version=/i.test(res.text)) {
      config.isAngular = true;
      config.platform = "DSpace 7+ (Angular UI)";
      return config.platform;
    }
    const m =
      res.text.match(/<meta[^>]+name="Generator"[^>]+content="([^"]+)"/i) ||
      res.text.match(/<meta[^>]+content="([^"]+)"[^>]+name="Generator"/i);
    config.platform = m ? m[1] : "DSpace (XMLUI)";
  } catch {
    config.platform = "DSpace (XMLUI)";
  }
  return config.platform;
}

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
/* ------------------------------------------------------------------ */

function parseMetaTags(html) {
  const metas = [];
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const name = attr(attrs, "name");
    const content = attr(attrs, "content");
    if (!name || content === null) continue;
    metas.push({
      name,
      content: decodeEntities(content),
      scheme: attr(attrs, "scheme"),
      lang: attr(attrs, "xml:lang"),
    });
  }
  return metas;
}

function attr(attrs, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = attrs.match(re);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : null;
}

/** Parse the discovery results page. */
function parseSearchPage(html, { baseUrl = config.baseUrl } = {}) {
  const totalMatch =
    html.match(/pagination-info">Now showing items\s+([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)/i) ||
    html.match(/total of\s+([\d,]+)\s+results/i);
  let total = 0;
  let from = 0;
  let to = 0;
  if (totalMatch && totalMatch.length === 4) {
    from = Number(totalMatch[1].replace(/,/g, ""));
    to = Number(totalMatch[2].replace(/,/g, ""));
    total = Number(totalMatch[3].replace(/,/g, ""));
  } else if (totalMatch) {
    total = Number(totalMatch[1].replace(/,/g, ""));
  }
  if (!total) {
    // Fallback that does not depend on the English "Now showing items" wording.
    // Most locales keep the same number order: from - to de/of N.
    const pag = html.match(/class="pagination-info"[^>]*>([\s\S]*?)<\/p>/i);
    if (pag) {
      const nums = (stripTags(pag[1]).match(/\d[\d.,\s]*/g) || [])
        .map((n) => Number(n.replace(/[.,\s]/g, "")))
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (nums.length >= 3) {
        from = nums[0];
        to = nums[1];
        total = nums[nums.length - 1];
      } else if (nums.length === 1) {
        total = nums[0];
      }
    }
  }
  if (!total && /no results|sin resultados/i.test(html)) total = 0;

  const tookMatch = html.match(/class="searchTime">\(([\d.]+)\s*seconds\)/i);
  const tookMs = tookMatch ? Math.round(parseFloat(tookMatch[1]) * 1000) : null;

  const pageMatch = html.match(/<input[^>]*name="page"[^>]*value="(\d+)"/i);
  const currentPage = pageMatch ? Number(pageMatch[1]) : 1;

  const rppMatch = html.match(/<input[^>]*name="rpp"[^>]*value="(\d+)"/i);
  const rpp = rppMatch ? Number(rppMatch[1]) : null;

  const results = [];
  const parts = html.split(/<li class="ds-artifact-item clearfix/i).slice(1);
  for (const part of parts) {
    const chunk = part.slice(0, 6000);
    const titleM = chunk.match(/<div class="artifact-title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleM) continue;
    const href = decodeEntities(titleM[1]);
    const title = stripTags(titleM[2]);
    const handle = handleFromHref(href);

    const authors = [];
    const authorRe = /<span class="author">([\s\S]*?)<\/span>\s*<\/span>/gi;
    let am;
    while ((am = authorRe.exec(chunk))) {
      const txt = stripTags(am[1]);
      if (txt) authors.push(...txt.split(/\s*;\s*/).filter(Boolean));
    }
    if (!authors.length) {
      const a2 = chunk.match(/<span class="author">([\s\S]*?)<\/span>/i);
      if (a2) {
        const txt = stripTags(a2[1]);
        if (txt) authors.push(...txt.split(/\s*;\s*/).filter(Boolean));
      }
    }

    const pub = chunk.match(/<span class="publisher">([\s\S]*?)<\/span>/i);
    const date = chunk.match(/<span class="date">([\s\S]*?)<\/span>/i);
    const abs = chunk.match(/<div class="abstract">([\s\S]*?)<\/div>/i);
    const thumb = chunk.match(/<img[^>]*src="([^"]+)"/i);

    results.push({
      handle,
      title,
      authors,
      publisher: pub ? cleanText(pub[1]) : null,
      issued: date ? cleanText(date[1]) : null,
      abstract: abs ? cleanText(abs[1]).replace(/\s*\.\.\.$/, "") : null,
      url: absolutize(href),
      thumbnail: thumb ? absolutize(thumb[1]) : null,
    });
  }

  return { total, from, to, page: currentPage, rpp, tookMs, results };
}

/** Parse an item page (handle view). */
function parseItemPage(html, { url } = {}) {
  const meta = parseMetaTags(html);
  const metadata = {};
  let citationPdfUrl = null;
  for (const m of meta) {
    if (m.name === "citation_pdf_url") {
      citationPdfUrl = absolutize(m.content);
      continue;
    }
    if (/^(DC|DCTERMS)\./i.test(m.name)) {
      const key = m.name;
      if (!metadata[key]) metadata[key] = [];
      metadata[key].push({ value: m.content, lang: m.lang || null, scheme: m.scheme || null });
    }
  }

  const first = (k) => (metadata[k] && metadata[k].length ? metadata[k][0].value : null);

  const handle = handleFromHref(url || "") || handleFromHref(html.match(/rel="canonical"[^>]*href="([^"]+)"/i)?.[1] || "");

  // Files
  const FORMAT_BY_EXT = {
    pdf: "PDF", xml: "XML", doc: "DOC", docx: "DOCX", xls: "XLS", xlsx: "XLSX",
    ppt: "PPT", pptx: "PPTX", zip: "ZIP", txt: "TXT", csv: "CSV", rtf: "RTF",
    jpg: "JPEG", jpeg: "JPEG", png: "PNG", gif: "GIF", mp4: "MP4", mp3: "MP3",
  };
  const files = [];
  const fileParts = html.split(/<div class="file-wrapper/i).slice(1);
  for (const part of fileParts) {
    const chunk = part.slice(0, 6000);
    const link = chunk.match(/href="([^"]*\/bitstream\/[^"]+)"/i);
    if (!link) continue;
    const href = decodeEntities(link[1]);
    const baseName = decodeURIComponent((href.split("?")[0].split("/").pop() || "").replace(/\+/g, " "));

    // Slice from .file-metadata so the mime icon's title="PDF file" is not
    // mistaken for the name (themes/localisations differ).
    const metaStart = chunk.search(/class="file-metadata"/i);
    const meta = metaStart >= 0 ? chunk.slice(metaStart, metaStart + 3000) : chunk;

    const nameM = meta.match(/<span[^>]*\btitle="([^"]+)"/i);
    const name = nameM ? cleanText(nameM[1]) : baseName;

    // Size/format labels are translated upstream; fall back to patterns that
    // do not depend on the label text.
    const sizeM =
      meta.match(/Size:[^<]*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ||
      meta.match(/([\d.,]+\s*(?:bytes|Kb|KB|Mb|MB|Gb|GB|TB))/);
    const fmtM = meta.match(/Format:[^<]*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);

    const ext = (baseName.split(".").pop() || "").toLowerCase();
    const format = fmtM ? cleanText(fmtM[1]) : FORMAT_BY_EXT[ext] || null;
    const seqM = href.match(/[?&]sequence=(\d+)/i);

    files.push({
      name,
      filename: baseName,
      size: sizeM ? cleanText(sizeM[1]) : null,
      format,
      sequence: seqM ? Number(seqM[1]) : null,
      url: absolutize(href),
      isPdf: ext === "pdf" || (format ? /^pdf$/i.test(format) : false),
    });
  }

  // Collections this item belongs to. Prefer the structural list; the English
  // heading is only a fallback because it is localised.
  const collections = [];
  const refList = html.match(/<ul[^>]*class="[^"]*ds-referenceSet-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  const collScope = refList
    ? refList[1]
    : (html.match(/This item appears in the following Collection\(s\)([\s\S]*?)(?:<\/ul>|<h2)/i) || [])[1];
  if (collScope) {
    const re = /<a href="([^"]*\/handle\/[^"]+)">([\s\S]*?)<\/a>(?:\s*\[([\d,]+)\])?/gi;
    let m;
    while ((m = re.exec(collScope))) {
      collections.push({
        handle: handleFromHref(m[1]),
        name: stripTags(m[2]),
        url: absolutize(m[1]),
        itemCount: m[3] ? Number(m[3].replace(/,/g, "")) : null,
      });
    }
  }

  // Simple view fields that are not in meta tags
  const title =
    first("DC.title") ||
    (html.match(/<h1 class="pagetitle[^"]*">([\s\S]*?)<\/h1>/i) || [])[1]?.trim() ||
    cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s*-\s*DSpace.*$/, "");

  return {
    handle,
    title: title ? cleanText(title) : null,
    authors: (metadata["DC.creator"] || []).map((x) => x.value),
    publisher: first("DC.publisher"),
    issued: first("DCTERMS.issued") || first("DC.date.issued"),
    type: first("DC.type"),
    language: first("DC.language"),
    subject: (metadata["DC.subject"] || []).map((x) => x.value),
    abstract: first("DC.description.abstract"),
    uri: first("DC.identifier"),
    metadata,
    collections,
    files,
    pdfUrl: citationPdfUrl || (files.find((f) => f.isPdf) || {}).url || null,
    url: absolutize((url || "").replace(config.baseUrl, "")) || (handle ? xmlui(`/handle/${handle}`) : null),
  };
}

/** Parse the ?show=full metadata table. */
function parseFullMetadata(html) {
  const rows = [];
  const parts = html.split('<td class="label-cell">').slice(1);
  for (const part of parts) {
    const end = part.indexOf("</td>");
    if (end < 0) continue;
    const field = stripTags(part.slice(0, end));
    if (!field) continue;
    let rest = part.slice(end + 5);
    const v = rest.match(/^\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!v) continue;
    const value = stripTags(v[1]);
    rest = rest.slice(v[0].length);
    // Third cell is the language; it may be self-closing (<td />) and thus absent.
    const l = rest.match(/^\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const lang = l ? stripTags(l[1]) || null : null;
    rows.push({ field, value, lang });
  }
  return rows;
}

function parseArtifactList(html, cssClass) {
  const out = [];
  const re = new RegExp(`<li class="ds-artifact-item[^"]*${cssClass}[^"]*"`, "i");
  const parts = html.split(re).slice(1);
  for (const part of parts) {
    const chunk = part.slice(0, 4000);
    const m = chunk.match(/<div class="artifact-title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,60})/i);
    if (!m) continue;
    const countM = m[3].match(/\[\s*([\d,]+)\s*\]/);
    out.push({
      handle: handleFromHref(m[1]),
      name: stripTags(m[2]),
      itemCount: countM ? Number(countM[1].replace(/,/g, "")) : null,
      url: absolutize(m[1]),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const SORTS = {
  relevance: { sort_by: "score", order: "desc" },
  title: { sort_by: "dc.title_sort", order: "asc" },
  date: { sort_by: "dc.date.issued_dt", order: "desc" },
  dateAsc: { sort_by: "dc.date.issued_dt", order: "asc" },
  author: { sort_by: "dc.contributor.author_sort", order: "asc" },
};

function buildSearchUrl(opts = {}) {
  const {
    q = "*:*",
    page = 1,
    size = 20,
    sort = "relevance",
    order,
    collection,
    field,
    operator = "contains",
    value,
    hasFile,
    extraParams,
  } = opts;

  const params = new URLSearchParams();
  params.set("query", q === "" || q == null ? "*:*" : q);
  params.set("rpp", String(Math.min(100, Math.max(1, toInt(size, 20)))));
  params.set("page", String(Math.max(1, toInt(page, 1))));
  params.set("etal", "0");
  params.set("group_by", "none");

  const s = SORTS[sort] || SORTS.relevance;
  params.set("sort_by", s.sort_by);
  params.set("order", (order || s.order).toUpperCase());

  let path = "/discover";
  if (collection) {
    path = `/handle/${String(collection).replace(/^\/?(handle\/)?/, "")}/discover`;
  }

  if (field && value !== undefined && value !== null && value !== "") {
    params.set("filtertype_0", field);
    params.set("filter_relational_operator_0", operator || "contains");
    params.set("filter_0", value);
  }
  if (hasFile) {
    params.set("filtertype_1", "has_content_in_original_bundle");
    params.set("filter_relational_operator_1", "equals");
    params.set("filter_1", "true");
  }
  if (extraParams && typeof extraParams === "object") {
    for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
  }

  return { url: xmlui(path) + "?" + params.toString(), params };
}

function angularError(url) {
  const err = new Error(
    `Upstream at ${config.baseUrl} looks like DSpace 7+ (Angular UI): /xmlui is not a real XMLUI. ` +
      `Use its /server/api REST API instead, or point DSPACE_BASE_URL at a pre-7 XMLUI instance.`
  );
  err.status = 422;
  err.code = "NOT_XMLUI";
  err.url = url;
  return err;
}

function assertXmlui(html, url) {
  if (/<ds-app[\s>]|ng-version=/i.test(html) && !/ds-artifact-item|ds-option-set|ds-main/i.test(html)) {
    throw angularError(url);
  }
}

async function search(opts = {}) {
  const { url } = buildSearchUrl(opts);
  const res = await request(url);
  if (res.status === 403) {
    const err = new Error(
      `Upstream blocked the request (HTTP 403): ${url}. Some repositories reject non-browser clients or restrict /xmlui paths.`
    );
    err.status = 403;
    err.url = url;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error(
      `XMLUI search not found (HTTP 404): ${url}. Check DSPACE_BASE_URL/DSPACE_CONTEXT; DSpace 7+ has no /xmlui and needs /server/api.`
    );
    err.status = 404;
    err.url = url;
    throw err;
  }
  if (res.status !== 200) {
    const err = new Error(`Upstream search returned HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  assertXmlui(res.text, url);
  const parsed = parseSearchPage(res.text);
  return { ...parsed, query: opts.q || "*:*", upstream: url };
}

async function getItem(handleOrUrl, { full = true } = {}) {
  const handle = extractHandle(handleOrUrl);
  if (!handle) throw new Error(`Could not parse handle from "${handleOrUrl}"`);
  const url = xmlui(`/handle/${handle}`) + (full ? "?show=full" : "");
  const res = await request(url);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    const err = new Error(`Upstream item returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  assertXmlui(res.text, url);
  const item = parseItemPage(res.text, { url });
  item.handle = item.handle || handle;
  item.url = xmlui(`/handle/${item.handle}`);
  if (full) item.dcMetadata = parseFullMetadata(res.text);
  return item;
}

function extractHandle(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/(?:handle\/)?(\d+\/\d+)/);
  return m ? m[1] : null;
}

async function getCommunities() {
  const res = await request(xmlui("/"));
  if (res.status !== 200) throw new Error(`Home page HTTP ${res.status}`);
  return parseArtifactList(res.text, "community");
}

async function getCommunity(handle) {
  const h = extractHandle(handle);
  if (!h) throw new Error("Invalid community handle");
  const res = await request(xmlui(`/handle/${h}`));
  if (res.status !== 200) throw new Error(`Community page HTTP ${res.status}`);
  const title = (res.text.match(/<h1 class="pagetitle[^"]*">([\s\S]*?)<\/h1>/i) || [])[1];
  const collections = parseArtifactList(res.text, "collection");
  const subcommunities = parseArtifactList(res.text, "community");
  return {
    handle: h,
    name: title ? stripTags(title) : null,
    url: xmlui(`/handle/${h}`),
    subcommunities,
    collections,
  };
}

async function getStats() {
  const [all, withFiles] = await Promise.all([
    search({ q: "*:*", size: 1 }),
    search({ q: "*:*", size: 1, hasFile: true }),
  ]);
  return {
    items: all.total,
    itemsWithFiles: withFiles.total,
    platform: await getPlatform(),
    baseUrl: config.baseUrl,
    contextPath: config.contextPath,
    fetchedAt: new Date().toISOString(),
  };
}

/** Fetch an arbitrary XMLUI path (debug/raw passthrough). */
async function fetchRaw(path) {
  const url = /^https?:\/\//i.test(path) ? path : xmlui(path);
  const res = await request(url);
  return { ...res, url };
}

/** Escape hatch for binary/streaming use (e.g. proxying a PDF). */
async function rawRequestPublic(url, opts = {}) {
  return request(url, opts);
}

/** Resolve the first PDF for a handle and return a direct upstream URL. */
async function resolvePdf(handle) {
  const item = await getItem(handle);
  if (!item) return null;
  const pdf = item.pdfUrl || (item.files.find((f) => f.isPdf) || {}).url;
  return pdf ? { url: pdf, filename: (item.files.find((f) => f.isPdf) || {}).filename || null, item } : null;
}

module.exports = {
  config,
  isBun,
  normalizeContext,
  requireBaseUrl,
  search,
  getItem,
  getCommunities,
  getCommunity,
  getStats,
  getPlatform,
  resolvePdf,
  fetchRaw,
  rawRequestPublic,
  extractHandle,
  // exported for tests / reuse
  parseSearchPage,
  parseItemPage,
  parseFullMetadata,
  parseArtifactList,
  buildSearchUrl,
  decodeEntities,
  stripTags,
  xmlui,
  absolutize,
  SORTS,
};
