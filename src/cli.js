#!/usr/bin/env node
"use strict";
/**
 * CLI for DSpace 4-6 XMLUI repositories.
 *
 *   DSPACE_BASE_URL=https://repository.example.org dspace-cli stats
 *   dspace-cli search "medicine" --size 5
 *   dspace-cli search "medicine" --include-files --json
 *   dspace-cli item 123456789/42 --json
 *   dspace-cli harvest --out data/items.ndjson --max 200 --include-files
 */

const fs = require("node:fs");
const path = require("node:path");
const ds = require("./dspace");

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(obj, flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  } else {
    process.stdout.write(formatHuman(obj) + "\n");
  }
}

function formatHuman(obj) {
  if (obj.results) {
    const lines = [`"${obj.query}" — ${obj.total} results (page ${obj.page}/${obj.pages || "?"}, ${obj.size}/page)`, ""];
    obj.results.forEach((r, i) => {
      lines.push(`${(obj.page - 1) * obj.size + i + 1}. ${r.title}`);
      if (r.authors?.length) lines.push(`   by ${r.authors.join("; ")}`);
      if (r.issued || r.publisher) lines.push(`   ${[r.publisher, r.issued].filter(Boolean).join(" · ")}`);
      lines.push(`   ${r.url}`);
      if (r.pdfUrl) lines.push(`   PDF: ${r.pdfUrl}`);
      lines.push("");
    });
    return lines.join("\n");
  }
  return JSON.stringify(obj, null, 2);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === "help") {
    console.log(`dspace-cli <command>

  stats                              repository totals
  runtime                            which JS runtime is executing the CLI
  search <query> [options]           search (HTML Discovery scrape)
  item <handle> [--json]             full item record + files
  communities                        top-level communities
  community <handle>                 collections inside a community
  pdf <handle>                       print direct PDF URL
  harvest --out <file> [options]     bulk export to NDJSON

target (required):
  DSPACE_BASE_URL   repository root, e.g. https://repository.example.org
  DSPACE_CONTEXT    XMLUI context path (default /xmlui, "" for root)
  DSPACE_TLS_VERIFY 1 (default) or 0 for expired/self-signed certificates
  --base-url URL    per-command override for DSPACE_BASE_URL
  --context PATH    per-command override for DSPACE_CONTEXT

search options:
  --size N        results per page (max 100, default 10)
  --page N        1-based page
  --sort S        relevance|title|date|dateAsc|author
  --order asc|desc
  --collection H  scope to a community/collection handle (123456789/42)
  --field F       filter field: title|author|subject|dateIssued|has_content_in_original_bundle
  --operator O    contains|equals|authority|notcontains|notequals
  --value V       filter value
  --has-file      only items with a bitstream
  --include-files fetch item pages and attach pdfUrl/files
  --json          raw JSON

examples:
  dspace-cli search "medicine" --size 5
  dspace-cli search "*:*" --collection 123456789/42 --size 3
  dspace-cli search "*:*" --field dateIssued --operator equals --value 2024 --size 3
  dspace-cli item 123456789/42 --json
  dspace-cli harvest --out data/items.ndjson --max 100 --include-files
`);
    return;
  }

  if (flags["base-url"]) ds.config.baseUrl = String(flags["base-url"]).replace(/\/+$/, "");
  if (flags.context !== undefined) ds.config.contextPath = ds.normalizeContext(String(flags.context));

  const networkCmds = new Set(["stats", "search", "item", "communities", "community", "pdf", "harvest"]);
  if (networkCmds.has(cmd) && !ds.config.baseUrl) {
    console.error(
      "DSPACE_BASE_URL is not set.\n" +
        "  Example: DSPACE_BASE_URL=https://repository.example.org dspace-cli stats\n" +
        "  Or:      dspace-cli stats --base-url https://repository.example.org"
    );
    process.exit(1);
  }

  if (cmd === "stats") return out(await ds.getStats(), flags);

  if (cmd === "runtime") {
    return out(
      {
        runtime: ds.isBun ? "bun" : "node",
        buntime: process.versions.bun || null,
        node: process.versions.node,
        execPath: process.execPath,
      },
      { json: true }
    );
  }

  if (cmd === "search") {
    const q = positional[1] || "*:*";
    const res = await ds.search({
      q,
      size: Number(flags.size || flags.rpp || 10),
      page: Number(flags.page || 1),
      sort: flags.sort || "relevance",
      order: flags.order,
      collection: flags.collection,
      field: flags.field,
      operator: flags.operator,
      value: flags.value,
      hasFile: !!flags["has-file"],
    });
    if (flags["include-files"]) {
      await Promise.all(
        res.results.map(async (r) => {
          try {
            const item = await ds.getItem(r.handle);
            r.pdfUrl = item?.pdfUrl || null;
            r.files = item?.files || [];
          } catch (e) {
            r.filesError = e.message;
          }
        })
      );
    }
    const size = res.rpp || Number(flags.size || 10);
    const pages = Math.ceil(res.total / size);
    return out({ ...res, size, pages }, flags);
  }

  if (cmd === "item") {
    const item = await ds.getItem(positional[1], { full: flags.full !== "false" });
    if (!item) {
      console.error("Item not found");
      process.exit(1);
    }
    return out(item, flags);
  }

  if (cmd === "communities") {
    const communities = await ds.getCommunities();
    return out({ count: communities.length, communities }, flags);
  }

  if (cmd === "community") {
    return out(await ds.getCommunity(positional[1]), flags);
  }

  if (cmd === "pdf") {
    const found = await ds.resolvePdf(positional[1]);
    if (!found) {
      console.error("No PDF found");
      process.exit(1);
    }
    console.log(found.url);
    return;
  }

  if (cmd === "harvest") {
    const outFile = flags.out || `data/harvest-${Date.now()}.ndjson`;
    const max = Number(flags.max || 100);
    const rpp = Math.min(100, Number(flags.rpp || 100));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const stream = fs.createWriteStream(outFile, { flags: "a" });
    let written = 0;
    let page = 1;
    while (written < max) {
      const res = await ds.search({ q: flags.q || "*:*", size: rpp, page, hasFile: !!flags["has-file"], collection: flags.collection });
      if (!res.results.length) break;
      for (const r of res.results) {
        if (written >= max) break;
        let record = { ...r };
        if (flags["include-files"]) {
          try {
            const item = await ds.getItem(r.handle);
            record = { ...record, pdfUrl: item?.pdfUrl || null, files: item?.files || [], collections: item?.collections || [] };
          } catch (e) {
            record.error = e.message;
          }
        }
        record.harvestedAt = new Date().toISOString();
        stream.write(JSON.stringify(record) + "\n");
        written++;
        if (written % 25 === 0) console.log(`  ${written}/${max}...`);
      }
      if ((page - 1) * rpp + res.results.length >= res.total) break;
      page++;
    }
    await new Promise((r) => stream.end(r));
    console.log(`Wrote ${written} records to ${outFile}`);
    return;
  }

  console.error(`Unknown command: ${cmd}. Try: dspace-cli help`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
