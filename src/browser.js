import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { NeedsAttentionError } from "./errors.js";

export function proxyFromEnvironment(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!new Set(["http:", "https:", "socks5:"]).has(url.protocol)) return undefined;
    const proxy = { server: `${url.protocol}//${url.host}` };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    const bypass = env.NO_PROXY || env.no_proxy;
    if (bypass) proxy.bypass = bypass.split(",").map((item) => item.trim()).filter(Boolean).join(",");
    return proxy;
  } catch {
    return undefined;
  }
}

async function firstVisible(locators, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;

        // Xiaohongshu keeps duplicate tab/editor nodes off-screen during page
        // transitions. Playwright considers those nodes visible, but cannot
        // scroll them into view. Only return controls that intersect the
        // browser viewport.
        const inViewport = await candidate.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0
            && box.height > 0
            && box.right > 0
            && box.bottom > 0
            && box.left < window.innerWidth
            && box.top < window.innerHeight;
        }).catch(() => false);
        if (inViewport) return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new NeedsAttentionError("页面结构与预期不一致，未找到需要填写的控件");
}

async function firstExisting(locators, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const locator of locators) {
      if (await locator.count().catch(() => 0)) return locator.first();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new NeedsAttentionError("页面结构与预期不一致，未找到文件上传控件");
}

async function hasLoginScreen(page) {
  if (/\/login(?:\?|$)/.test(page.url())) return true;
  for (const text of ["APP扫一扫登录", "短信登录", "扫码登录"]) {
    if (await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function hasBrowserError(page) {
  if (/^(about:blank|chrome-error:)/.test(page.url())) return true;
  const body = await page.locator("body").innerText().catch(() => "");
  return /ERR_[A-Z_]+|无法访问此网站|This site can.?t be reached/i.test(body);
}

async function isAuthenticatedPage(page) {
  try {
    const url = new URL(page.url());
    if (url.hostname === "creator.xiaohongshu.com" && !url.pathname.startsWith("/login") && /^\/(new|publish)\//.test(url.pathname)) {
      return true;
    }
  } catch {
    return false;
  }
  for (const text of ["发布笔记", "笔记管理", "数据看板"]) {
    if (await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function waitForInitialSessionState(page, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let loginDetectedAt;
  while (Date.now() < deadline) {
    if (await isAuthenticatedPage(page)) return "authenticated";
    if (await hasLoginScreen(page)) {
      loginDetectedAt ??= Date.now();
      // A saved session can briefly render the login shell before Xiaohongshu
      // redirects to the creator home page. Give that redirect priority over QR.
      if (Date.now() - loginDetectedAt >= 2_000) return "login";
    } else {
      loginDetectedAt = undefined;
    }
    if (await hasBrowserError(page)) return "error";
    await page.waitForTimeout(300);
  }
  return "unknown";
}

async function gotoAllowingSessionRedirect(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = String(error?.message ?? "");
    // Xiaohongshu can replace the login document while restoring a saved
    // session. Playwright reports that successful hand-off as an aborted
    // navigation or detached frame, while the page continues to /new/home.
    if (!/ERR_ABORTED|frame was detached|navigation.*interrupted/i.test(message) || page.isClosed()) throw error;
    await page.waitForTimeout(1_000);
  }
}

async function gotoWithRetries(page, url, { attempts = 3, timeout = 30_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      if (!(await hasBrowserError(page))) return;
      lastError = new Error(`页面返回浏览器网络错误（第 ${attempt} 次）`);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? "");
      if (/ERR_ABORTED|frame was detached|navigation.*interrupted/i.test(message) && !page.isClosed()) {
        await page.waitForTimeout(1_000);
        if (!(await hasBrowserError(page))) return;
      }
    }
    if (attempt < attempts) {
      await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(attempt * 1_000);
    }
  }
  throw new NeedsAttentionError(`小红书发布页连续 ${attempts} 次连接失败，请检查代理后重试`, { cause: lastError });
}

export async function checkLoginStatus(config, { headless = true } = {}) {
  const context = await openBrowser(config, { headless });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    // Verify the session against the actual creator editor. The site root can
    // briefly render its login shell even when the publishing session is valid.
    await gotoAllowingSessionRedirect(page, config.creatorUrl ?? config.loginUrl ?? "https://creator.xiaohongshu.com/");
    const state = await waitForInitialSessionState(page);
    if (state === "authenticated") return { loggedIn: true, state };
    if (state === "login") return { loggedIn: false, state };
    if (state === "error") {
      throw new NeedsAttentionError("检查登录状态时无法连接小红书，请检查代理或网络");
    }
    throw new NeedsAttentionError("小红书页面已打开，但暂时无法判断登录状态");
  } finally {
    await context.close();
  }
}

async function switchToQrLogin(page) {
  if (await isAuthenticatedPage(page)) return "authenticated";
  if (await page.getByText("APP扫一扫登录", { exact: false }).first().isVisible().catch(() => false)) return "qr";
  const images = page.locator(".sso-login-wrapper img");
  const count = await images.count();
  for (let index = 0; index < count; index += 1) {
    const image = images.nth(index);
    const box = await image.boundingBox().catch(() => null);
    if (!box || box.width > 100 || box.height > 100) continue;
    await image.click().catch(() => {});
    await page.waitForTimeout(800);
    if (await isAuthenticatedPage(page)) return "authenticated";
    if (await page.getByText("APP扫一扫登录", { exact: false }).first().isVisible().catch(() => false)) return "qr";
  }
  if (await isAuthenticatedPage(page)) return "authenticated";
  throw new NeedsAttentionError("已打开登录页，但未找到二维码登录入口；可在窗口右上角手动切换二维码");
}

async function qrCodeLocator(page) {
  const images = page.locator(".sso-login-wrapper img");
  const count = await images.count();
  for (let index = 0; index < count; index += 1) {
    const image = images.nth(index);
    const box = await image.boundingBox().catch(() => null);
    if (!box || box.width < 120 || box.height < 120) continue;
    if (Math.abs(box.width - box.height) > 35) continue;
    return image;
  }
  const wrapper = page.locator(".sso-login-wrapper").first();
  if (await wrapper.isVisible().catch(() => false)) return wrapper;
  throw new NeedsAttentionError("登录页已打开，但暂时无法读取二维码");
}

export async function openBrowser(config, { headless = false } = {}) {
  await mkdir(config.profileDir, { recursive: true });
  await mkdir(config.artifactsDir, { recursive: true });
  const proxy = proxyFromEnvironment();
  const context = await chromium.launchPersistentContext(config.profileDir, {
    // Use the regular Chrome-for-Testing binary for both headed and the modern
    // headless mode. This avoids a second, legacy headless-shell download.
    channel: "chromium",
    headless,
    args: ["--disable-quic"],
    viewport: { width: 1440, height: 960 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    ...(proxy ? { proxy } : {})
  });
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(config.navigationTimeoutSeconds * 1000);
  return context;
}

export async function login(config, { headless = false } = {}) {
  const context = await openBrowser(config, { headless });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await gotoAllowingSessionRedirect(page, config.loginUrl ?? "https://creator.xiaohongshu.com/");
    const initialState = await waitForInitialSessionState(page);

    if (initialState === "authenticated") {
      return { alreadyLoggedIn: true };
    }

    if (initialState === "error") {
      throw new NeedsAttentionError("小红书登录页连接失败，请检查代理后重试");
    }

    if (initialState !== "login") {
      throw new NeedsAttentionError("登录页已打开，但无法确认登录状态；窗口将关闭，请重试");
    }

    const loginMode = await switchToQrLogin(page);
    if (loginMode === "authenticated") return { alreadyLoggedIn: true };

    const deadline = Date.now() + config.loginTimeoutMinutes * 60_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if (await isAuthenticatedPage(page)) {
        await page.waitForTimeout(1500);
        return { alreadyLoggedIn: false };
      }
      if (await hasBrowserError(page)) {
        throw new NeedsAttentionError("扫码窗口与小红书的连接已中断，请检查代理后重试");
      }
    }
    throw new NeedsAttentionError(`登录等待超过 ${config.loginTimeoutMinutes} 分钟，请重新运行 login`);
  } finally {
    await context.close();
  }
}

export async function createQrLoginSession(config, { headless = true } = {}) {
  const context = await openBrowser(config, { headless });
  const page = context.pages()[0] ?? await context.newPage();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await context.close().catch(() => {});
  };

  try {
    await gotoAllowingSessionRedirect(page, config.loginUrl ?? "https://creator.xiaohongshu.com/");
    const initialState = await waitForInitialSessionState(page);
    if (initialState === "authenticated") {
      await close();
      return { alreadyLoggedIn: true, close };
    }
    if (initialState === "error") throw new NeedsAttentionError("小红书登录页连接失败，请检查代理后重试");
    if (initialState !== "login") throw new NeedsAttentionError("无法确认小红书登录页状态，请稍后重试");

    const mode = await switchToQrLogin(page);
    if (mode === "authenticated") {
      await close();
      return { alreadyLoggedIn: true, close };
    }
    await qrCodeLocator(page);

    return {
      alreadyLoggedIn: false,
      async getState() {
        if (closed) return "closed";
        if (await isAuthenticatedPage(page)) return "authenticated";
        if (await hasBrowserError(page)) return "error";
        return "waiting";
      },
      async screenshotQr() {
        if (closed) throw new NeedsAttentionError("扫码会话已经结束，请重新打开");
        if (await isAuthenticatedPage(page)) throw new NeedsAttentionError("已经登录，无需继续扫码");
        return (await qrCodeLocator(page)).screenshot({ type: "png" });
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function noteBody(post) {
  const tags = post.tags.map((tag) => `#${tag}`).join(" ");
  return tags ? `${post.content}\n\n${tags}` : post.content;
}

export async function fillEditor(page, post) {
  const imageTab = await firstVisible([
    page.getByText("上传图文", { exact: true }),
    page.getByRole("tab", { name: /上传图文|图文笔记/ }),
    page.locator("div,button,span").filter({ hasText: /^上传图文$/ })
  ], 20_000);
  // The current creator page renders two nested elements with the same tab
  // label. The outer tab intercepts pointer events directed at the inner
  // label, so dispatch the click on the owning tab element itself.
  await imageTab.evaluate((element) => {
    const target = element.closest(".creator-tab, [role='tab'], button") ?? element;
    target.click();
  });
  await page.waitForTimeout(800);

  // File inputs are commonly hidden behind a styled upload button, so existence
  // rather than visibility is the correct signal here.
  const fileInput = await firstExisting([
    page.locator('input[type="file"][multiple][accept*=".jpg"]'),
    page.locator('input[type="file"][multiple][accept*=".png"]'),
    page.locator('input[type="file"][accept*="image"]'),
    page.locator('input[type="file"][multiple]:not([accept*=".mp4"])')
  ], 20_000);
  await fileInput.setInputFiles(post._imageFiles);

  const title = await firstVisible([
    page.locator('input[placeholder*="标题"]'),
    page.locator('textarea[placeholder*="标题"]'),
    page.getByRole("textbox", { name: /标题/ })
  ], 30_000);
  await title.fill(post.title);

  const body = await firstVisible([
    page.locator('[contenteditable="true"][data-placeholder*="正文"]'),
    page.locator('.ql-editor[contenteditable="true"]'),
    page.locator('div[contenteditable="true"]'),
    page.locator('textarea[placeholder*="正文"]'),
    page.locator('textarea[placeholder*="描述"]')
  ]);
  await body.fill(noteBody(post));
  // Filling hashtags can leave the suggestion menu open above the fixed
  // action bar. Dismiss it before validating or clicking Publish.
  await page.keyboard.press("Escape").catch(() => {});
}

async function publishAction(page) {
  // Xiaohongshu's current action bar is a custom element with a closed shadow
  // root. Its internal "发布" button is visible but cannot be reached by text
  // or role locators. The host exposes its state through attributes, and the
  // submit button has a stable position within the 680x90 action bar.
  const customHost = await firstExisting([
    page.locator('xhs-publish-btn[is-publish="true"]')
  ], 5_000).catch(() => null);

  if (customHost) {
    const disabled = await customHost.getAttribute("submit-disabled");
    const loading = await customHost.getAttribute("submit-loading");
    if (disabled === "true" || loading === "true") {
      throw new NeedsAttentionError("发布按钮不可用，请检查图片、标题或正文是否满足页面要求");
    }
    const box = await customHost.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error("小红书发布操作区未显示在页面中");
    }
    const position = { x: box.width * 0.605, y: box.height * 0.5 };
    await customHost.click({ position, trial: true });
    return () => customHost.click({ position });
  }

  const button = await firstVisible([
    page.getByRole("button", { name: "发布", exact: true }),
    page.locator("button").filter({ hasText: /^发布$/ }),
    page.getByText("发布", { exact: true })
  ], 8_000);
  if (await button.isDisabled().catch(() => false)) {
    throw new NeedsAttentionError("发布按钮不可用，请检查图片、标题或正文是否满足页面要求");
  }
  await button.click({ trial: true });
  return () => button.click();
}

async function artifactPath(config, post, suffix) {
  await mkdir(config.artifactsDir, { recursive: true });
  const safeId = post.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(config.artifactsDir, `${safeId}-${Date.now()}-${suffix}.png`);
}

export async function publishPost(config, post, { dryRun = false, headless = false } = {}) {
  const context = await openBrowser(config, { headless });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await gotoWithRetries(page, config.creatorUrl, {
      attempts: 3,
      timeout: Math.min(config.navigationTimeoutSeconds * 1000, 30_000)
    });
    if (await hasLoginScreen(page)) {
      throw new NeedsAttentionError("登录已失效，请先运行 npm run login");
    }

    await fillEditor(page, post);
    const clickPublish = await publishAction(page);
    const beforePath = await artifactPath(config, post, dryRun ? "dry-run" : "before-publish");
    await page.screenshot({ path: beforePath, fullPage: true });
    if (dryRun) return { dryRun: true, screenshot: beforePath };
    await clickPublish();

    const result = await Promise.any([
      page.waitForURL((url) => !url.pathname.includes("/publish/publish"), { timeout: 30_000 }).then(() => "navigated"),
      page.getByText(/发布成功|提交成功|审核中/, { exact: false }).waitFor({ state: "visible", timeout: 30_000 }).then(() => "message")
    ]).catch(() => null);
    if (!result) {
      const uncertainPath = await artifactPath(config, post, "uncertain");
      await page.screenshot({ path: uncertainPath, fullPage: true });
      throw new NeedsAttentionError(`点击发布后未能确认结果。为避免重复发布，任务不会自动重试；截图: ${uncertainPath}`);
    }
    return { dryRun: false, result };
  } catch (error) {
    if (!(error instanceof NeedsAttentionError)) {
      const errorPath = await artifactPath(config, post, "error").catch(() => null);
      if (errorPath) await page.screenshot({ path: errorPath, fullPage: true }).catch(() => {});
      error.artifact = errorPath;
    }
    throw error;
  } finally {
    await context.close();
  }
}
