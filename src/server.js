import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import express from "express";
import multer from "multer";
import { checkLoginStatus, createQrLoginSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { ExternalServiceError, ValidationError } from "./errors.js";
import { generatePost } from "./llm.js";
import { fetchOpenverseImage, searchOpenverse } from "./images.js";
import { runDuePosts } from "./scheduler.js";
import { loadPost, updatePost, validatePost } from "./post.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(projectRoot, "public");
const config = await loadConfig(projectRoot, process.env.XHS_CONFIG);
const port = Number(process.env.PORT || config.webPort || 3210);
const buildId = "closed-shadow-publish-v1";

await Promise.all([
  mkdir(config.assetsDir, { recursive: true }),
  mkdir(config.postsDir, { recursive: true })
]);

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: config.assetsDir,
    filename: (_req, file, callback) => {
      const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extensions[file.mimetype] ?? ""}`);
    }
  }),
  limits: { files: 18, fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = allowedImageTypes.has(file.mimetype);
    callback(allowed ? null : new ValidationError(`不支持的图片格式: ${file.mimetype}`), allowed);
  }
});

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "拒绝来自其他站点的写入请求" });
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(config.assetsDir, { index: false, fallthrough: false }));
app.use(express.static(publicDir));

let loginState = { status: "checking", message: "正在检查已保存的小红书登录状态" };
let loginCheckRunning = false;
let activeLoginSession = null;
let loginDeadline = 0;
let loginPollRunning = false;
let schedulerRunning = false;
let queueMutationRunning = false;

async function refreshLoginState() {
  if (loginCheckRunning || activeLoginSession) return;
  loginCheckRunning = true;
  loginState = { status: "checking", message: "正在检查已保存的小红书登录状态" };
  try {
    const result = await checkLoginStatus(config, { headless: true });
    loginState = result.loggedIn
      ? { status: "logged_in", message: "已从专用浏览器会话识别到登录状态" }
      : { status: "logged_out", message: "专用浏览器会话尚未登录，请扫码一次" };
  } catch (error) {
    loginState = { status: "error", message: error.message };
  } finally {
    loginCheckRunning = false;
  }
}

async function closeLoginSession() {
  const session = activeLoginSession;
  activeLoginSession = null;
  loginDeadline = 0;
  if (session) await session.close();
}

async function pollLoginSession() {
  if (!activeLoginSession || loginPollRunning) return;
  loginPollRunning = true;
  try {
    if (loginDeadline && Date.now() >= loginDeadline) {
      await closeLoginSession();
      loginState = { status: "error", message: `扫码等待超过 ${config.loginTimeoutMinutes} 分钟，请重新打开二维码` };
      return;
    }
    const state = await activeLoginSession.getState();
    if (state === "authenticated") {
      await closeLoginSession();
      loginState = { status: "logged_in", message: "扫码登录成功" };
    } else if (state === "error" || state === "closed") {
      await closeLoginSession();
      loginState = { status: "error", message: "二维码页面连接已中断，请检查网络后重试" };
    }
  } catch (error) {
    await closeLoginSession();
    loginState = { status: "error", message: error.message };
  } finally {
    loginPollRunning = false;
  }
}

async function runScheduler() {
  if (schedulerRunning || queueMutationRunning || new Set(["checking", "waiting"]).has(loginState.status)) return;
  schedulerRunning = true;
  try {
    await runDuePosts(config, { headless: false });
  } catch (error) {
    console.error(`[scheduler] ${error.message}`);
  } finally {
    schedulerRunning = false;
  }
}

app.get("/api/status", (_req, res) => {
  res.json({
    xhs: { ...loginState, qrReady: Boolean(activeLoginSession) },
    llm: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna"
    },
    scheduler: { running: schedulerRunning, pollSeconds: config.pollSeconds },
    buildId
  });
});

app.post("/api/xhs/login", async (_req, res) => {
  if (activeLoginSession) return res.status(202).json({ ...loginState, qrReady: true });
  if (loginCheckRunning) return res.status(409).json({ error: "正在检查历史登录状态，请稍后再试" });
  loginState = { status: "checking", message: "正在准备小红书二维码" };
  try {
    const session = await createQrLoginSession(config, { headless: true });
    if (session.alreadyLoggedIn) {
      loginState = { status: "logged_in", message: "已识别到保存的登录状态，无需扫码" };
      return res.json({ ...loginState, qrReady: false });
    }
    activeLoginSession = session;
    loginDeadline = Date.now() + config.loginTimeoutMinutes * 60_000;
    loginState = { status: "waiting", message: "请使用小红书 App 扫描网页中的二维码" };
    res.status(202).json({ ...loginState, qrReady: true });
  } catch (error) {
    loginState = { status: "error", message: error.message };
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/xhs/login/qr.png", async (_req, res, next) => {
  try {
    if (!activeLoginSession) return res.status(404).json({ error: "当前没有等待扫码的会话" });
    const png = await activeLoginSession.screenshotQr();
    res.setHeader("Cache-Control", "no-store");
    res.type("image/png").send(png);
  } catch (error) {
    next(error);
  }
});

app.post("/api/xhs/login/cancel", async (_req, res) => {
  await closeLoginSession();
  loginState = { status: "logged_out", message: "已取消扫码登录" };
  res.json(loginState);
});

app.post("/api/generate", async (req, res, next) => {
  try {
    res.json(await generatePost(req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/images/search", async (req, res, next) => {
  try {
    const images = await searchOpenverse(req.body?.queries, { page: req.body?.page, limit: 6 });
    res.json({ images, licensePolicy: "仅搜索 CC0 与公共领域图片；发布前仍建议核对来源页面" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/images/:id/file", async (req, res, next) => {
  try {
    const image = await fetchOpenverseImage(req.params.id);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.type(image.contentType).send(image.buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/posts", async (_req, res, next) => {
  try {
    const files = (await readdir(config.postsDir)).filter((name) => name.endsWith(".json")).sort().reverse();
    const posts = [];
    for (const name of files.slice(0, 50)) {
      try {
        posts.push({ ...JSON.parse(await readFile(path.join(config.postsDir, name), "utf8")), file: name });
      } catch {
        posts.push({ id: name, status: "failed", lastError: "任务文件无法读取", file: name });
      }
    }
    res.json(posts);
  } catch (error) {
    next(error);
  }
});

function postFileFromId(id) {
  const safeId = String(id ?? "");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(safeId)) throw new ValidationError("任务编号无效");
  return path.join(config.postsDir, `${safeId}.json`);
}

app.post("/api/posts/:id/cancel", async (req, res, next) => {
  if (schedulerRunning || queueMutationRunning) return res.status(409).json({ error: "发布器正在处理任务，请稍后再取消" });
  queueMutationRunning = true;
  try {
    const file = postFileFromId(req.params.id);
    const post = await loadPost(file, { checkImages: false });
    if (post.status === "cancelled") return res.json({ id: post.id, status: post.status });
    if (post.status !== "pending") {
      const message = post.status === "publishing"
        ? "任务正在发布，无法安全取消"
        : post.status === "published" ? "任务已经发布，无法通过本地队列撤回" : "该任务当前不在等待发布状态";
      return res.status(409).json({ error: message });
    }
    const updated = await updatePost(file, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      lastError: null
    });
    res.json({ id: updated.id, status: updated.status });
  } catch (error) {
    next(error);
  } finally {
    queueMutationRunning = false;
  }
});

app.post("/api/posts/:id/retry", async (req, res, next) => {
  if (schedulerRunning || queueMutationRunning) return res.status(409).json({ error: "发布器正在处理任务，请稍后再重试" });
  queueMutationRunning = true;
  let shouldRun = false;
  try {
    const file = postFileFromId(req.params.id);
    const post = await loadPost(file, { checkImages: false });
    const safelyRetryable = post.status === "failed"
      || (post.status === "needs_attention" && post.lastError?.startsWith("页面结构与预期不一致"));
    if (!safelyRetryable) {
      const message = post.status === "needs_attention"
        ? "该任务的发布结果不确定，为避免重复发布，不能自动重试"
        : "只有明确失败且尚未发布的任务可以重试";
      return res.status(409).json({ error: message });
    }
    const now = new Date().toISOString();
    const updated = await updatePost(file, {
      status: "pending",
      publishAt: now,
      retriedAt: now,
      lastError: null,
      artifact: null
    });
    shouldRun = true;
    res.json({ id: updated.id, status: updated.status });
  } catch (error) {
    next(error);
  } finally {
    queueMutationRunning = false;
    if (shouldRun) void runScheduler();
  }
});

app.delete("/api/posts/:id", async (req, res, next) => {
  if (schedulerRunning || queueMutationRunning) return res.status(409).json({ error: "发布器正在处理任务，请稍后再删除" });
  queueMutationRunning = true;
  try {
    const file = postFileFromId(req.params.id);
    const post = await loadPost(file, { checkImages: false });
    const deletable = new Set(["draft", "cancelled", "failed", "needs_attention"]);
    if (!deletable.has(post.status)) {
      const message = post.status === "pending"
        ? "请先取消发布，再删除任务"
        : post.status === "publishing" ? "任务正在发布，无法安全删除" : "已发布任务只保留为历史记录，不能在这里删除";
      return res.status(409).json({ error: message });
    }

    await unlink(file);
    const assetsRoot = `${path.resolve(config.assetsDir)}${path.sep}`;
    const imageFiles = post.images
      .map((image) => path.resolve(config.postsDir, image))
      .filter((image) => image.startsWith(assetsRoot));
    await Promise.all(imageFiles.map((image) => unlink(image).catch((error) => {
      if (error.code !== "ENOENT") console.error(`[cleanup] ${image}: ${error.message}`);
    })));
    res.json({ id: post.id, deleted: true });
  } catch (error) {
    next(error);
  } finally {
    queueMutationRunning = false;
  }
});

app.post("/api/posts", upload.array("images", 18), async (req, res, next) => {
  const savedFiles = req.files ?? [];
  try {
    if (!savedFiles.length) throw new ValidationError("请至少上传一张图片");
    const action = req.body.action || "draft";
    if (!new Set(["draft", "schedule", "publish"]).has(action)) throw new ValidationError("发布方式无效");
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    const file = path.join(config.postsDir, `${id}.json`);
    const images = savedFiles.map((item) => path.relative(config.postsDir, item.path).replaceAll("\\", "/"));
    const tags = String(req.body.tags ?? "").split(/[,，\n]/).map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean);
    let imageSources = [];
    if (req.body.imageSources) {
      try {
        imageSources = JSON.parse(req.body.imageSources);
      } catch {
        throw new ValidationError("图片来源信息格式无效");
      }
      if (!Array.isArray(imageSources)) throw new ValidationError("图片来源信息必须是数组");
      imageSources = imageSources.slice(0, 18).map((source) => ({
        id: String(source?.id ?? "").slice(0, 80),
        title: String(source?.title ?? "").slice(0, 160),
        creator: String(source?.creator ?? "").slice(0, 120),
        license: String(source?.license ?? "").slice(0, 20),
        sourceUrl: String(source?.sourceUrl ?? "").slice(0, 1000)
      }));
    }
    let publishAt;
    if (action === "publish") publishAt = new Date().toISOString();
    if (action === "schedule") {
      if (!req.body.publishAt || Number.isNaN(Date.parse(req.body.publishAt))) throw new ValidationError("请选择有效的发布时间");
      publishAt = new Date(req.body.publishAt).toISOString();
    }
    const post = validatePost({
      id,
      status: action === "draft" ? "draft" : "pending",
      publishAt,
      title: req.body.title,
      content: req.body.content,
      images,
      imageSources,
      tags
    }, "网页表单");
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(post, null, 2)}\n`, "utf8");
    await rename(temporary, file);
    if (action !== "draft") void runScheduler();
    res.status(201).json({ id, status: post.status, file: path.basename(file) });
  } catch (error) {
    await Promise.all(savedFiles.map((item) => unlink(item.path).catch(() => {})));
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error instanceof ValidationError || error instanceof multer.MulterError
    ? 400
    : error instanceof ExternalServiceError ? 502 : 500;
  if (error instanceof ExternalServiceError) {
    const cause = error.cause;
    const details = [cause?.status, cause?.code, cause?.message].filter(Boolean).join(" | ").slice(0, 800);
    console.error(`[external] ${error.message}${details ? `; upstream: ${details}` : ""}`);
  } else {
    console.error(status === 500 ? error : error.message);
  }
  res.status(status).json({ error: status === 500 ? "服务器处理失败，请查看终端日志" : error.message });
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`小红书内容控制台: http://127.0.0.1:${port}`);
  console.log(`登录组件: ${buildId}`);
  console.log(process.env.OPENAI_API_KEY ? "OpenAI API 已配置。" : "提示: OPENAI_API_KEY 尚未配置，LLM 生成功能暂不可用。 ");
  void refreshLoginState();
});

const timer = setInterval(() => void runScheduler(), config.pollSeconds * 1000);
const loginPollTimer = setInterval(() => void pollLoginSession(), 1_000);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(timer);
    clearInterval(loginPollTimer);
    void closeLoginSession().finally(() => server.close(() => process.exit(0)));
  });
}
