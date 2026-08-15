import path from "node:path";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { ValidationError } from "./errors.js";

const VALID_STATUSES = new Set(["draft", "pending", "publishing", "published", "failed", "needs_attention", "cancelled"]);

export async function loadPost(file, { checkImages = true } = {}) {
  const absoluteFile = path.resolve(process.cwd(), file);
  let raw;
  try {
    raw = JSON.parse(await readFile(absoluteFile, "utf8"));
  } catch (error) {
    throw new ValidationError(`无法读取任务文件 ${absoluteFile}: ${error.message}`, { cause: error });
  }

  const post = validatePost(raw, absoluteFile);
  post._file = absoluteFile;
  post._imageFiles = post.images.map((image) => path.resolve(path.dirname(absoluteFile), image));

  if (checkImages) {
    for (const image of post._imageFiles) {
      try {
        await access(image, constants.R_OK);
      } catch {
        throw new ValidationError(`图片不存在或不可读: ${image}`);
      }
    }
  }
  return post;
}

export function validatePost(raw, source = "任务") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${source} 必须是 JSON 对象`);
  }
  const requiredStrings = ["id", "title", "content"];
  for (const key of requiredStrings) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) {
      throw new ValidationError(`${source} 的 ${key} 必须是非空字符串`);
    }
  }
  if (raw.title.trim().length > 20) {
    throw new ValidationError(`${source} 的标题超过 20 个字符`);
  }
  if (!Array.isArray(raw.images) || raw.images.length < 1 || raw.images.length > 18) {
    throw new ValidationError(`${source} 的 images 必须包含 1–18 张图片`);
  }
  if (raw.images.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ValidationError(`${source} 的 images 只能包含非空路径`);
  }
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string"))) {
    throw new ValidationError(`${source} 的 tags 必须是字符串数组`);
  }
  const status = raw.status ?? "pending";
  if (!VALID_STATUSES.has(status)) {
    throw new ValidationError(`${source} 的 status 无效: ${status}`);
  }
  if (raw.publishAt !== undefined && Number.isNaN(Date.parse(raw.publishAt))) {
    throw new ValidationError(`${source} 的 publishAt 不是有效日期`);
  }
  return {
    ...raw,
    id: raw.id.trim(),
    title: raw.title.trim(),
    content: raw.content.trim(),
    images: [...raw.images],
    tags: (raw.tags ?? []).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean),
    status
  };
}

export function isDue(post, now = new Date()) {
  return post.status === "pending" && (!post.publishAt || Date.parse(post.publishAt) <= now.getTime());
}

export async function updatePost(file, changes) {
  const absoluteFile = path.resolve(file);
  const current = JSON.parse(await readFile(absoluteFile, "utf8"));
  const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
  const temporary = `${absoluteFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, absoluteFile);
  return next;
}
