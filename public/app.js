const $ = (selector) => document.querySelector(selector);
const stateLabels = { draft: "草稿", pending: "等待中", publishing: "发布中", published: "已发布", failed: "失败", needs_attention: "需处理", cancelled: "已取消" };
let toastTimer;
let lastImageQueries = [];
let imageSearchPage = 1;
let autoImageSources = new Map();
let qrRefreshTimer;
let loginWasWaiting = false;

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 4500);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  const span = button.querySelector("span");
  if (span) span.textContent = busy ? "正在生成…" : label;
  else button.textContent = busy ? "处理中…" : label;
}

function setGenerateStatus(message, type = "working") {
  const element = $("#generateStatus");
  element.hidden = !message;
  element.textContent = message;
  element.className = `operation-status ${type}`;
}

function imageExtension(type) {
  return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
}

function renderImageSources() {
  const panel = $("#autoImagePanel");
  const sources = [...autoImageSources.values()];
  panel.hidden = sources.length === 0;
  $("#autoImageSources").replaceChildren(...sources.map((source, index) => {
    const row = document.createElement("div");
    row.className = "auto-image-source";
    const link = document.createElement("a");
    link.href = source.sourceUrl || "https://openverse.org/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `${index + 1}. ${source.title || "开放版权图片"}`;
    const license = document.createElement("span");
    license.textContent = `${source.creator || "未知作者"} · ${String(source.license || "").toUpperCase()}`;
    row.append(link, license);
    return row;
  }));
}

function renderSelectedImages() {
  const files = [...$("#images").files].slice(0, 18);
  const names = new Set(files.map((file) => file.name));
  autoImageSources = new Map([...autoImageSources].filter(([name]) => names.has(name)));
  const preview = $("#imagePreview");
  preview.replaceChildren(...files.map((file, index) => {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.alt = `第 ${index + 1} 张图片预览`;
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    const caption = document.createElement("figcaption");
    const source = autoImageSources.get(file.name);
    caption.textContent = `${index === 0 ? "封面" : index + 1}${source ? ` · ${String(source.license).toUpperCase()}` : ""}`;
    figure.append(image, caption);
    return figure;
  }));
  renderImageSources();
}

async function findAndAttachImages(queries, page = 1) {
  const search = await api("/api/images/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries, page })
  });
  if (!search.images?.length) throw new Error("开放图库没有找到合适的竖版图片，可换一批或手动添加");

  const downloaded = await Promise.allSettled(search.images.slice(0, 3).map(async (source) => {
    const response = await fetch(source.previewUrl);
    if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
    const blob = await response.blob();
    const name = `openverse-${source.id}.${imageExtension(blob.type)}`;
    return { file: new File([blob], name, { type: blob.type }), source };
  }));
  const usable = downloaded.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!usable.length) throw new Error("找到图片但下载失败，请点击“换一批”重试");

  const transfer = new DataTransfer();
  autoImageSources = new Map();
  for (const item of usable) {
    transfer.items.add(item.file);
    autoImageSources.set(item.file.name, item.source);
  }
  $("#images").files = transfer.files;
  renderSelectedImages();
  return usable.length;
}

function refreshQrImage() {
  const image = $("#loginQrImage");
  $("#loginQrStatus").textContent = "正在加载小红书二维码……";
  image.onload = () => { $("#loginQrStatus").textContent = "请使用小红书 App 扫码并在手机上确认"; };
  image.onerror = () => { $("#loginQrStatus").textContent = "二维码读取失败，正在等待自动重试……"; };
  image.src = `/api/xhs/login/qr.png?t=${Date.now()}`;
}

function openLoginModal() {
  const modal = $("#loginModal");
  if (!modal.hidden) return;
  modal.hidden = false;
  refreshQrImage();
  clearInterval(qrRefreshTimer);
  qrRefreshTimer = setInterval(refreshQrImage, 20_000);
}

function hideLoginModal() {
  $("#loginModal").hidden = true;
  $("#loginQrImage").removeAttribute("src");
  clearInterval(qrRefreshTimer);
  qrRefreshTimer = undefined;
}

async function cancelQrLogin() {
  try {
    await api("/api/xhs/login/cancel", { method: "POST" });
  } catch (error) {
    toast(error.message, true);
  } finally {
    hideLoginModal();
    await refreshStatus();
  }
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    const llm = $("#llmStatus");
    llm.textContent = status.llm.configured ? `LLM · ${status.llm.model}` : "LLM · 未配置密钥";
    llm.className = `status-pill ${status.llm.configured ? "ok" : "warn"}`;
    const xhs = $("#xhsStatus");
    const loggedIn = status.xhs.status === "logged_in";
    const checking = status.xhs.status === "checking";
    xhs.textContent = loggedIn ? "小红书 · 已登录" : status.xhs.status === "waiting" ? "小红书 · 等待扫码" : checking ? "小红书 · 检查中" : "专用会话 · 未登录";
    xhs.title = status.xhs.message;
    xhs.className = `status-pill ${loggedIn ? "ok" : "warn"}`;
    $("#loginButton").disabled = checking || loggedIn;
    $("#loginButton").textContent = loggedIn ? "已登录" : status.xhs.status === "waiting" ? "等待扫码…" : checking ? "正在检查…" : "扫码登录";
    if (status.xhs.status === "waiting" && status.xhs.qrReady) {
      loginWasWaiting = true;
      openLoginModal();
    } else if (loggedIn && loginWasWaiting) {
      loginWasWaiting = false;
      hideLoginModal();
      toast("小红书扫码登录成功");
    } else if (status.xhs.status === "error" && !$("#loginModal").hidden) {
      $("#loginQrStatus").textContent = status.xhs.message;
    }
  } catch (error) { toast(error.message, true); }
}

async function refreshQueue() {
  try {
    const posts = await api("/api/posts");
    const queue = $("#queue");
    if (!posts.length) {
      queue.innerHTML = '<p class="empty">还没有发布任务。</p>';
      return;
    }
    queue.replaceChildren(...posts.map((post) => {
      const card = document.createElement("article");
      card.className = "task";
      const top = document.createElement("div");
      top.className = "task-top";
      const title = document.createElement("h3");
      title.textContent = post.title || post.id;
      const badge = document.createElement("span");
      badge.className = `task-status ${post.status}`;
      badge.textContent = stateLabels[post.status] || post.status;
      top.append(title, badge);
      const meta = document.createElement("p");
      meta.textContent = post.lastError || (post.publishAt ? `计划：${new Date(post.publishAt).toLocaleString("zh-CN")}` : `任务：${post.id}`);
      card.append(top, meta);
      const actions = document.createElement("div");
      actions.className = "task-actions";
      if (post.status === "pending") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "task-action cancel";
        cancel.textContent = "取消发布";
        cancel.addEventListener("click", async () => {
          if (!window.confirm(`确定取消“${post.title}”的发布计划吗？草稿和图片会保留。`)) return;
          cancel.disabled = true;
          try {
            await api(`/api/posts/${encodeURIComponent(post.id)}/cancel`, { method: "POST" });
            toast("发布计划已取消，任务内容仍然保留");
            await refreshQueue();
          } catch (error) {
            toast(error.message, true);
            cancel.disabled = false;
          }
        });
        actions.append(cancel);
      }
      const safelyRetryable = post.status === "failed"
        || (post.status === "needs_attention" && post.lastError?.startsWith("页面结构与预期不一致"));
      if (safelyRetryable) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "task-action retry";
        retry.textContent = "重新发布";
        retry.addEventListener("click", async () => {
          if (!window.confirm(`确定重新发布“${post.title}”吗？确认后将立即尝试发布到小红书。`)) return;
          retry.disabled = true;
          try {
            await api(`/api/posts/${encodeURIComponent(post.id)}/retry`, { method: "POST" });
            toast("任务已重新加入发布队列");
            await refreshQueue();
          } catch (error) {
            toast(error.message, true);
            retry.disabled = false;
          }
        });
        actions.append(retry);
      }
      if (["draft", "cancelled", "failed", "needs_attention"].includes(post.status)) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "task-action delete";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`确定永久删除“${post.title}”吗？该任务上传的图片也会被清理。`)) return;
          remove.disabled = true;
          try {
            await api(`/api/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" });
            toast("任务已删除");
            await refreshQueue();
          } catch (error) {
            toast(error.message, true);
            remove.disabled = false;
          }
        });
        actions.append(remove);
      }
      if (actions.childElementCount) card.append(actions);
      return card;
    }));
  } catch (error) { toast(error.message, true); }
}

$("#loginButton").addEventListener("click", async () => {
  const button = $("#loginButton");
  button.disabled = true;
  button.textContent = "正在准备二维码…";
  try {
    const result = await api("/api/xhs/login", { method: "POST" });
    if (result.qrReady) {
      loginWasWaiting = true;
      openLoginModal();
    } else {
      toast(result.message || "当前小红书会话已经登录");
    }
    await refreshStatus();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = "扫码登录";
  }
});

$("#closeLoginModal").addEventListener("click", cancelQrLogin);
$("#cancelLoginButton").addEventListener("click", cancelQrLogin);

$("#generateButton").addEventListener("click", async () => {
  const button = $("#generateButton");
  const topic = $("#topic");
  if (!topic.value.trim()) {
    const message = "请先填写“选题 / 产品 / 经历”，再生成笔记草稿。";
    setGenerateStatus(message, "error");
    toast(message, true);
    topic.focus();
    return;
  }
  setBusy(button, true, "生成笔记草稿");
  setGenerateStatus("正在连接 LLM 并生成草稿，请稍候……");
  try {
    const result = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: topic.value, audience: $("#audience").value, tone: $("#tone").value,
        keyPoints: $("#keyPoints").value, useEmoji: $("#useEmoji").checked
      })
    });
    $("#title").value = result.title;
    $("#content").value = result.content;
    $("#tags").value = result.tags.join(", ");
    updateCounts();
    lastImageQueries = result.imageQueries || [];
    imageSearchPage = 1;
    button.querySelector("span").textContent = "正在网上找图…";
    try {
      const count = await findAndAttachImages(lastImageQueries, imageSearchPage);
      setGenerateStatus(`草稿生成完成，并自动加入 ${count} 张开放版权图片。请核对后再发布。`, "success");
      toast(`草稿和 ${count} 张图片已准备好`);
    } catch (imageError) {
      setGenerateStatus(`草稿已生成；${imageError.message}`, "working");
      toast(imageError.message, true);
    }
  } catch (error) {
    setGenerateStatus(error.message, "error");
    toast(error.message, true);
  }
  finally { setBusy(button, false, "生成笔记草稿"); }
});

function updateCounts() {
  $("#titleCount").textContent = `${[...$("#title").value].length} / 20`;
  $("#contentCount").textContent = `${$("#content").value.length} / 1000`;
}
$("#title").addEventListener("input", updateCounts);
$("#content").addEventListener("input", updateCounts);

$("#images").addEventListener("change", (event) => {
  if (event.isTrusted) autoImageSources = new Map();
  renderSelectedImages();
});

$("#refreshImagesButton").addEventListener("click", async () => {
  const button = $("#refreshImagesButton");
  if (!lastImageQueries.length) return;
  button.disabled = true;
  button.textContent = "正在找图…";
  try {
    imageSearchPage = imageSearchPage >= 5 ? 1 : imageSearchPage + 1;
    const count = await findAndAttachImages(lastImageQueries, imageSearchPage);
    toast(`已更换 ${count} 张开放版权图片`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "换一批";
  }
});

function updatePublishMode() {
  const action = document.querySelector('input[name="action"]:checked').value;
  $("#scheduleField").hidden = action !== "schedule";
  $("#publishAt").required = action === "schedule";
  $("#saveButton").textContent = action === "publish" ? "确认并发布" : action === "draft" ? "保存草稿" : "加入发布队列";
}
document.querySelectorAll('input[name="action"]').forEach((input) => input.addEventListener("change", updatePublishMode));

$("#postForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#saveButton");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    const action = document.querySelector('input[name="action"]:checked').value;
    const form = new FormData();
    form.set("title", $("#title").value);
    form.set("content", $("#content").value);
    form.set("tags", $("#tags").value);
    form.set("imageSources", JSON.stringify([...autoImageSources.values()]));
    form.set("action", action);
    if (action === "schedule") form.set("publishAt", new Date($("#publishAt").value).toISOString());
    for (const file of $("#images").files) form.append("images", file);
    const result = await api("/api/posts", { method: "POST", body: form });
    toast(action === "draft" ? "草稿已保存" : action === "publish" ? "任务已创建，正在启动发布" : "已加入定时发布队列");
    await refreshQueue();
    console.info("created task", result.id);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = originalLabel; updatePublishMode(); }
});

$("#refreshButton").addEventListener("click", refreshQueue);
const defaultTime = new Date(Date.now() + 60 * 60 * 1000);
defaultTime.setMinutes(Math.ceil(defaultTime.getMinutes() / 5) * 5, 0, 0);
$("#publishAt").value = new Date(defaultTime.getTime() - defaultTime.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
updatePublishMode();
updateCounts();
void refreshStatus();
void refreshQueue();
setInterval(() => { void refreshStatus(); void refreshQueue(); }, 5000);
