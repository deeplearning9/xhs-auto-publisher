#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login, publishPost } from "./browser.js";
import { loadConfig } from "./config.js";
import { daemon } from "./scheduler.js";
import { NeedsAttentionError } from "./errors.js";
import { loadPost, updatePost } from "./post.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`
小红书本地发布器

用法:
  node src/cli.js login [--config path]
  node src/cli.js validate <post.json> [--config path]
  node src/cli.js publish <post.json> [--dry-run] [--headless] [--config path]
  node src/cli.js daemon [--once] [--dry-run] [--headless] [--config path]
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") flags.config = argv[++i];
    else if (arg.startsWith("--")) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, file] = positional;
  if (!command || flags.help) {
    usage();
    return;
  }
  const config = await loadConfig(projectRoot, flags.config);

  if (command === "login") {
    console.log("浏览器已打开，请在小红书创作平台完成扫码登录……");
    const result = await login(config);
    console.log(result.alreadyLoggedIn ? "当前会话已登录。" : "登录成功，会话已保存在本机。 ");
    return;
  }

  if (command === "validate") {
    if (!file) throw new Error("validate 需要任务文件路径");
    const post = await loadPost(file);
    console.log(`校验通过: ${post.id}，${post.images.length} 张图片`);
    return;
  }

  if (command === "publish") {
    if (!file) throw new Error("publish 需要任务文件路径");
    const post = await loadPost(file);
    if (post.status === "published" && !flags.force) {
      throw new Error("该任务已标记为 published；如确需重发，请显式添加 --force");
    }
    const dryRun = Boolean(flags["dry-run"]);
    if (!dryRun) await updatePost(post._file, { status: "publishing", lastError: null });
    try {
      const result = await publishPost(config, post, {
        dryRun,
        headless: Boolean(flags.headless)
      });
      if (!dryRun) {
        await updatePost(post._file, { status: "published", publishedAt: new Date().toISOString(), lastResult: result });
      }
      console.log(dryRun ? `演练完成，未点击发布。截图: ${result.screenshot}` : "发布成功。");
    } catch (error) {
      if (!dryRun) {
        await updatePost(post._file, {
          status: error instanceof NeedsAttentionError ? "needs_attention" : "failed",
          lastError: error.message,
          artifact: error.artifact ?? null
        }).catch(() => {});
      }
      throw error;
    }
    return;
  }

  if (command === "daemon") {
    console.log(`开始监听 ${config.postsDir}，轮询间隔 ${config.pollSeconds} 秒。按 Ctrl+C 停止。`);
    await daemon(config, {
      once: Boolean(flags.once),
      dryRun: Boolean(flags["dry-run"]),
      headless: Boolean(flags.headless)
    });
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`${error.name ?? "Error"}: ${error.message}`);
  process.exitCode = 1;
});
