process.env.DSPACE_BASE_URL = "https://repository.example.org";
process.env.DSPACE_TLS_VERIFY = "1";

const { describe, test, expect } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const ds = require("../src/dspace");

const BASE = "https://repository.example.org";
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("search parser", () => {
  const parsed = ds.parseSearchPage(fixture("search.html"));

  test("reads pagination metadata", () => {
    expect(parsed.total).toBe(7);
    expect(parsed.from).toBe(1);
    expect(parsed.to).toBe(2);
    expect(parsed.page).toBe(1);
    expect(parsed.rpp).toBe(10);
    expect(parsed.tookMs).toBe(40);
  });

  test("extracts result fields", () => {
    expect(parsed.results).toHaveLength(2);
    const [first, second] = parsed.results;
    expect(first.handle).toBe("123456789/42");
    expect(first.title).toBe("Sample & Item One");
    expect(first.authors).toEqual(["Doe, Jane", "Roe, Richard"]);
    expect(first.publisher).toBe("Example Press");
    expect(first.issued).toBe("2024-05-01");
    expect(first.abstract).toBe("An abstract about sample data.");
    expect(first.url).toBe(`${BASE}/xmlui/handle/123456789/42`);
    expect(first.thumbnail).toBe(`${BASE}/xmlui/bitstream/handle/123456789/42/thumb.png`);
  });

  test("leaves missing fields null", () => {
    const second = parsed.results[1];
    expect(second.publisher).toBeNull();
    expect(second.abstract).toBeNull();
    expect(second.thumbnail).toBeNull();
  });

  test("parses pagination without English wording", () => {
    const html = '<p class="pagination-info">Mostrando ítems 1-2 de 7</p>';
    const localized = ds.parseSearchPage(html);
    expect(localized.from).toBe(1);
    expect(localized.to).toBe(2);
    expect(localized.total).toBe(7);
  });

  test("detects an empty result set", () => {
    const html = '<p class="pagination-info">No results</p>';
    expect(ds.parseSearchPage(html).total).toBe(0);
  });
});

describe("item parser", () => {
  const html = fixture("item.html");
  const item = ds.parseItemPage(html, { url: `${BASE}/xmlui/handle/123456789/42` });

  test("reads Dublin Core metadata", () => {
    expect(item.handle).toBe("123456789/42");
    expect(item.title).toBe("Sample Item One");
    expect(item.authors).toEqual(["Doe, Jane"]);
    expect(item.publisher).toBe("Example Press");
    expect(item.issued).toBe("2024-05-01");
    expect(item.type).toBe("Article");
    expect(item.language).toBe("en");
    expect(item.subject).toEqual(["Sample data"]);
    expect(item.abstract).toBe("A short abstract.");
  });

  test("keeps internal identifiers verbatim", () => {
    expect(item.uri).toBe("http://localhost:8080/xmlui/handle/123456789/42");
  });

  test("resolves the PDF link and rewrites internal hosts", () => {
    expect(item.pdfUrl).toBe(
      `${BASE}/xmlui/bitstream/handle/123456789/42/paper.pdf?sequence=1&isAllowed=y`
    );
  });

  test("lists bitstreams", () => {
    expect(item.files).toHaveLength(2);
    const [pdf, csv] = item.files;
    expect(pdf).toMatchObject({
      name: "paper.pdf",
      filename: "paper.pdf",
      size: "120.5Kb",
      format: "PDF",
      sequence: 1,
      isPdf: true,
    });
    expect(pdf.url).toBe(
      `${BASE}/xmlui/bitstream/handle/123456789/42/paper.pdf?sequence=1&isAllowed=y`
    );
    expect(csv.format).toBe("CSV");
    expect(csv.isPdf).toBe(false);
  });

  test("reads the owning collection", () => {
    expect(item.collections).toEqual([
      {
        handle: "123456789/7",
        name: "Sample Collection",
        url: `${BASE}/xmlui/handle/123456789/7`,
        itemCount: 12,
      },
    ]);
  });
});

describe("full metadata table", () => {
  test("aligns field, value and optional language", () => {
    const rows = ds.parseFullMetadata(fixture("item.html"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ field: "dc.title", value: "Sample Item One", lang: "en_US" });
    expect(rows[1]).toEqual({ field: "dc.subject", value: "Sample data", lang: null });
  });
});

describe("artifact lists", () => {
  const html = fixture("community.html");

  test("parses communities with counts", () => {
    expect(ds.parseArtifactList(html, "community")).toEqual([
      {
        handle: "123456789/7",
        name: "Sample Community",
        itemCount: 120,
        url: `${BASE}/xmlui/handle/123456789/7`,
      },
    ]);
  });

  test("parses collections with counts", () => {
    expect(ds.parseArtifactList(html, "collection")).toEqual([
      {
        handle: "123456789/8",
        name: "Sample Collection",
        itemCount: 12,
        url: `${BASE}/xmlui/handle/123456789/8`,
      },
    ]);
  });
});

describe("search URL builder", () => {
  test("applies defaults", () => {
    const { url, params } = ds.buildSearchUrl({});
    expect(params.get("query")).toBe("*:*");
    expect(params.get("rpp")).toBe("20");
    expect(params.get("page")).toBe("1");
    expect(params.get("sort_by")).toBe("score");
    expect(params.get("order")).toBe("DESC");
    expect(url).toStartWith(`${BASE}/xmlui/discover?`);
  });

  test("maps sort and paging options", () => {
    const { params } = ds.buildSearchUrl({ q: "medicine", size: 5, page: 2, sort: "date" });
    expect(params.get("query")).toBe("medicine");
    expect(params.get("rpp")).toBe("5");
    expect(params.get("page")).toBe("2");
    expect(params.get("sort_by")).toBe("dc.date.issued_dt");
    expect(params.get("order")).toBe("DESC");
  });

  test("caps the page size", () => {
    expect(ds.buildSearchUrl({ size: 500 }).params.get("rpp")).toBe("100");
    expect(ds.buildSearchUrl({ size: 0 }).params.get("rpp")).toBe("1");
  });

  test("adds a field filter", () => {
    const { params } = ds.buildSearchUrl({
      field: "dateIssued",
      operator: "equals",
      value: "2024",
    });
    expect(params.get("filtertype_0")).toBe("dateIssued");
    expect(params.get("filter_relational_operator_0")).toBe("equals");
    expect(params.get("filter_0")).toBe("2024");
  });

  test("adds the has-file filter", () => {
    const { params } = ds.buildSearchUrl({ hasFile: true });
    expect(params.get("filtertype_1")).toBe("has_content_in_original_bundle");
    expect(params.get("filter_1")).toBe("true");
  });

  test("uses a scoped path for collections", () => {
    const { url } = ds.buildSearchUrl({ collection: "handle/123456789/42" });
    expect(url).toStartWith(`${BASE}/xmlui/handle/123456789/42/discover?`);
  });
});

describe("utilities", () => {
  test("decodes named and numeric entities", () => {
    expect(ds.decodeEntities("A &amp; B &#65; &#x42; &nbsp;")).toBe("A & B A B  ");
  });

  test("strips tags and normalises whitespace", () => {
    expect(ds.stripTags("<b>Hello</b>   <i>world</i>")).toBe("Hello world");
  });

  test("absolutizes relative and internal links", () => {
    expect(ds.absolutize("/xmlui/handle/1")).toBe(`${BASE}/xmlui/handle/1`);
    expect(ds.absolutize("xmlui/handle/1")).toBe(`${BASE}/xmlui/handle/1`);
    expect(ds.absolutize("http://localhost:8080/xmlui/handle/1")).toBe(
      `${BASE}/xmlui/handle/1`
    );
    expect(ds.absolutize("http://old.example:8080/path")).toBe(`${BASE}/path`);
    expect(ds.absolutize("http://other.example/path")).toBe("https://other.example/path");
    expect(ds.absolutize("")).toBeNull();
  });

  test("extracts handles from handles and URLs", () => {
    expect(ds.extractHandle("123456789/42")).toBe("123456789/42");
    expect(ds.extractHandle("handle/123456789/42")).toBe("123456789/42");
    expect(ds.extractHandle(`${BASE}/xmlui/handle/123456789/42`)).toBe("123456789/42");
    expect(ds.extractHandle("not-a-handle")).toBeNull();
  });
});
