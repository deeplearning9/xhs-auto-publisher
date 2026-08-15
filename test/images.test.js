import test from "node:test";
import assert from "node:assert/strict";
import { fetchOpenverseImage, searchOpenverse } from "../src/images.js";

test("searchOpenverse only requests public-domain style licenses and normalizes results", async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      results: [{
        id: "101e9a59-b8c5-41b4-bf87-f95659e7a584",
        title: "Desk",
        creator: "Photographer",
        license: "cc0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        foreign_landing_url: "https://example.com/photo",
        width: 768,
        height: 1024
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const results = await searchOpenverse(["desk"], { fetchImpl, limit: 1 });
  assert.equal(requestedUrl.searchParams.get("license"), "cc0,pdm");
  assert.equal(requestedUrl.searchParams.get("source"), "stocksnap");
  assert.equal(requestedUrl.searchParams.get("aspect_ratio"), "tall");
  assert.equal(results[0].creator, "Photographer");
  assert.equal(results[0].previewUrl, "/api/images/101e9a59-b8c5-41b4-bf87-f95659e7a584/file");
});

test("searchOpenverse falls back from a specific phrase to a broad noun", async () => {
  const queries = [];
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get("q");
    queries.push(query);
    const results = query === "desk" ? [{
      id: "101e9a59-b8c5-41b4-bf87-f95659e7a584",
      title: "Desk",
      creator: "Photographer",
      license: "pdm"
    }] : [];
    return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
  };
  const results = await searchOpenverse(["small desk organizer"], { fetchImpl, limit: 1 });
  assert.deepEqual(queries, ["small desk organizer", "desk"]);
  assert.equal(results.length, 1);
});

test("fetchOpenverseImage rejects non-images and returns supported image bytes", async () => {
  const id = "101e9a59-b8c5-41b4-bf87-f95659e7a584";
  const good = await fetchOpenverseImage(id, {
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } })
  });
  assert.equal(good.contentType, "image/jpeg");
  assert.equal(good.buffer.length, 3);
  await assert.rejects(
    () => fetchOpenverseImage(id, { fetchImpl: async () => new Response("html", { headers: { "Content-Type": "text/html" } }) }),
    /不支持/
  );
});
