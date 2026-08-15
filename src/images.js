import { ExternalServiceError, ValidationError } from "./errors.js";
import { ProxyAgent } from "undici";

const OPENVERSE_API = "https://api.openverse.org/v1/images/";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let cachedProxy;

function proxyDispatcher(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return undefined;
    cachedProxy ??= new ProxyAgent(raw);
    return cachedProxy;
  } catch {
    return undefined;
  }
}

function fetchOptions(options = {}) {
  const dispatcher = proxyDispatcher();
  return dispatcher ? { ...options, dispatcher } : options;
}

function cleanQuery(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return new Set(["http:", "https:"]).has(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function expandQueries(queries) {
  const stopWords = new Set(["small", "large", "modern", "simple", "minimal", "beautiful", "aesthetic", "with", "and", "for"]);
  const expanded = [];
  for (const query of queries) {
    expanded.push(query);
    for (const word of query.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
      if (!stopWords.has(word)) expanded.push(word);
    }
  }
  return [...new Set(expanded)].slice(0, 10);
}

function normalizeResult(item, query) {
  if (!item || !UUID_PATTERN.test(String(item.id ?? ""))) return null;
  return {
    id: item.id,
    query,
    title: String(item.title || "开放版权图片").trim().slice(0, 160),
    creator: String(item.creator || "未知作者").trim().slice(0, 120),
    license: String(item.license || "").toLowerCase(),
    licenseUrl: safeHttpUrl(item.license_url),
    sourceUrl: safeHttpUrl(item.foreign_landing_url || item.detail_url),
    width: Number(item.width) || null,
    height: Number(item.height) || null,
    previewUrl: `/api/images/${item.id}/file`
  };
}

export async function searchOpenverse(queries, { fetchImpl = fetch, limit = 6, page = 1 } = {}) {
  const cleaned = [...new Set((Array.isArray(queries) ? queries : []).map(cleanQuery).filter(Boolean))].slice(0, 4);
  if (!cleaned.length) throw new ValidationError("没有可用的图片搜索词");
  const buckets = [];

  const expanded = expandQueries(cleaned);
  searchLoop:
  for (const source of ["stocksnap", ""]) {
    for (const query of expanded) {
      const url = new URL(OPENVERSE_API);
      url.searchParams.set("q", query);
      url.searchParams.set("license", "cc0,pdm");
      if (source) url.searchParams.set("source", source);
      url.searchParams.set("aspect_ratio", "tall");
      url.searchParams.set("mature", "false");
      url.searchParams.set("page_size", String(Math.max(limit, 6)));
      url.searchParams.set("page", String(Math.max(1, Math.min(Number(page) || 1, 5))));

      let response;
      try {
        response = await fetchImpl(url, fetchOptions({
          headers: { "User-Agent": "xhs-auto-publisher/1.0" },
          signal: AbortSignal.timeout(15_000)
        }));
      } catch (error) {
        throw new ExternalServiceError("无法连接开放版权图片库，请稍后重试", { cause: error });
      }
      if (!response.ok) {
        throw new ExternalServiceError(`开放版权图片库请求失败（${response.status}）`, { cause: new Error(`Openverse HTTP ${response.status}`) });
      }
      const payload = await response.json();
      buckets.push((payload.results ?? []).map((item) => normalizeResult(item, query)).filter(Boolean));
      if (buckets.reduce((sum, bucket) => sum + bucket.length, 0) >= limit) break searchLoop;
    }
  }

  const results = [];
  const seen = new Set();
  while (results.length < limit && buckets.some((bucket) => bucket.length)) {
    for (const bucket of buckets) {
      const item = bucket.shift();
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export async function fetchOpenverseImage(id, { fetchImpl = fetch } = {}) {
  if (!UUID_PATTERN.test(String(id ?? ""))) throw new ValidationError("图片编号无效");
  const url = `${OPENVERSE_API}${id}/thumb/?full_size=true&compressed=true`;
  let response;
  try {
    response = await fetchImpl(url, fetchOptions({
      headers: { "User-Agent": "xhs-auto-publisher/1.0" },
      signal: AbortSignal.timeout(25_000)
    }));
  } catch (error) {
    throw new ExternalServiceError("开放版权图片下载失败，请换一批图片", { cause: error });
  }
  if (!response.ok) throw new ExternalServiceError(`开放版权图片下载失败（${response.status}）`);
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new ValidationError("图片库返回了不支持的文件格式");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 20 * 1024 * 1024) throw new ValidationError("图片超过 20MB，已拒绝下载");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new ValidationError("下载的图片为空或超过 20MB");
  return { buffer, contentType };
}
