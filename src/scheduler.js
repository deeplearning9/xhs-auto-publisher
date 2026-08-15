import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { NeedsAttentionError, ValidationError } from "./errors.js";
import { isDue, loadPost, updatePost } from "./post.js";
import { publishPost } from "./browser.js";

export async function listPostFiles(postsDir) {
  await mkdir(postsDir, { recursive: true });
  const entries = await readdir(postsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(postsDir, entry.name))
    .sort();
}

export async function runDuePosts(config, options = {}) {
  const files = await listPostFiles(config.postsDir);
  const results = [];
  for (const file of files) {
    let post;
    try {
      post = await loadPost(file, { checkImages: false });
      if (!isDue(post)) continue;
      post = await loadPost(file);
      if (!options.dryRun) await updatePost(file, { status: "publishing", lastError: null });
      const result = await publishPost(config, post, options);
      if (!options.dryRun) {
        await updatePost(file, {
          status: "published",
          publishedAt: new Date().toISOString(),
          lastResult: result
        });
      }
      results.push({ file, ok: true, result });
    } catch (error) {
      const status = error instanceof NeedsAttentionError ? "needs_attention" : "failed";
      if (post?._file && !options.dryRun) {
        await updatePost(file, {
          status,
          lastError: error.message,
          artifact: error.artifact ?? null
        }).catch(() => {});
      }
      results.push({ file, ok: false, status, error: error.message });
      if (error instanceof ValidationError) continue;
    }
  }
  return results;
}

export async function daemon(config, { once = false, ...publishOptions } = {}) {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  do {
    const results = await runDuePosts(config, publishOptions);
    for (const item of results) {
      if (item.ok) console.log(`[成功] ${item.file}`);
      else console.error(`[${item.status}] ${item.file}: ${item.error}`);
    }
    if (once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  } while (!stopping);
}
