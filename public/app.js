"use strict";

const elements = Object.fromEntries(
  [
    "statusDot", "statusText", "logoutButton", "loginPanel", "workspace", "loginButton",
    "itemName", "scanButton", "previewPanel", "matchCount", "contextCount", "assetCount",
    "warningBox", "itemGroups", "quantity", "allButton", "price", "priceMode",
    "currencyCode", "quote", "confirmCheck", "sellButton", "progressPanel",
    "progressText", "progressNumbers", "progressBar", "resultSummary", "resultList", "toast"
  ].map((id) => [id, document.getElementById(id)])
);

let appToken = "";
let currentPreview = null;
let currency = null;
let quoteTimer = null;
let loginPoll = null;

function show(element, visible = true) {
  element.classList.toggle("hidden", !visible);
}

function toast(message, milliseconds = 4500) {
  elements.toast.textContent = message;
  show(elements.toast);
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => show(elements.toast, false), milliseconds);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.method && options.method !== "GET" ? { "X-App-Token": appToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function refreshStatus() {
  const status = await api("/api/status");
  elements.statusDot.className = `dot ${status.loggedIn ? "online" : "offline"}`;
  elements.statusText.textContent = status.loggedIn
    ? `已登录 · ${status.steamId}`
    : "未登录 Steam";
  show(elements.logoutButton, status.loggedIn);
  show(elements.loginPanel, !status.loggedIn);
  show(elements.workspace, status.loggedIn);
  currency = status.currency;
  elements.currencyCode.textContent = currency ? `(${currency.code})` : "";
  if (status.warning) toast(status.warning, 7000);
  return status.loggedIn;
}

function selectedMatchMode() {
  return document.querySelector('input[name="matchMode"]:checked').value;
}

function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.normalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.normalText || button.textContent;
    button.disabled = false;
  }
}

function renderGroups(groups) {
  elements.itemGroups.replaceChildren();
  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "item-row";
    const image = group.iconUrl
      ? Object.assign(document.createElement("img"), { src: group.iconUrl, alt: "" })
      : Object.assign(document.createElement("div"), { className: "item-placeholder" });
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = group.name;
    const app = document.createElement("small");
    app.textContent = `${group.appName} · App ${group.appId}`;
    info.append(name, app);
    const count = document.createElement("div");
    count.className = "item-count";
    count.textContent = `× ${group.count}`;
    row.append(image, info, count);
    elements.itemGroups.append(row);
  }
}

async function scan() {
  const name = elements.itemName.value.trim();
  if (!name) {
    toast("请先输入物品名称");
    elements.itemName.focus();
    return;
  }
  setBusy(elements.scanButton, true, "正在扫描…");
  show(elements.previewPanel, false);
  currentPreview = null;
  try {
    const preview = await api("/api/preview", {
      method: "POST",
      body: JSON.stringify({ name, mode: selectedMatchMode() })
    });
    currentPreview = preview;
    elements.matchCount.textContent = preview.totalFound;
    elements.contextCount.textContent = preview.scannedContexts;
    elements.assetCount.textContent = preview.scannedAssets;
    elements.quantity.max = preview.usableCount;
    elements.quantity.value = preview.usableCount || 1;
    renderGroups(preview.groups);
    const warnings = [];
    if (preview.truncated) warnings.push(`匹配数量较多，本次最多处理 ${preview.usableCount} 件。`);
    if (preview.errors.length) warnings.push(`部分库存读取失败：${preview.errors.join("；")}`);
    if (!preview.totalFound) warnings.push("没有找到名称匹配且可在市场出售的物品。");
    elements.warningBox.textContent = warnings.join(" ");
    show(elements.warningBox, warnings.length > 0);
    elements.confirmCheck.checked = false;
    elements.sellButton.disabled = true;
    show(elements.previewPanel);
    elements.previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(error.message, 7000);
  } finally {
    setBusy(elements.scanButton, false);
  }
}

async function updateQuote() {
  if (!elements.price.value.trim()) {
    elements.quote.textContent = "输入价格后显示手续费预估";
    return;
  }
  try {
    const result = await api("/api/quote", {
      method: "POST",
      body: JSON.stringify({
        price: elements.price.value,
        priceMode: elements.priceMode.value,
        previewId: currentPreview?.previewId
      })
    });
    elements.quote.textContent =
      `每件：买家支付 ${result.buyerPays} · 预计实收 ${result.sellerReceives} · 手续费 ${result.fees}`;
  } catch (error) {
    elements.quote.textContent = error.message;
  }
}

function scheduleQuote() {
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(updateQuote, 280);
}

function validateSellButton() {
  elements.sellButton.disabled = !(
    currentPreview
    && currentPreview.usableCount > 0
    && elements.confirmCheck.checked
    && elements.price.value.trim()
    && Number(elements.quantity.value) > 0
  );
}

async function sell() {
  if (!currentPreview) return;
  setBusy(elements.sellButton, true, "正在创建任务…");
  try {
    const job = await api("/api/sell", {
      method: "POST",
      body: JSON.stringify({
        previewId: currentPreview.previewId,
        confirmToken: currentPreview.confirmToken,
        quantity: Number(elements.quantity.value),
        price: elements.price.value,
        priceMode: elements.priceMode.value
      })
    });
    currentPreview = null;
    show(elements.progressPanel);
    elements.progressPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    await monitorJob(job.id);
  } catch (error) {
    toast(error.message, 7000);
    setBusy(elements.sellButton, false);
    validateSellButton();
  }
}

function renderJob(job) {
  const percent = job.total ? Math.round(job.completed / job.total * 100) : 0;
  elements.progressText.textContent = job.state === "finished" ? "任务完成" : "正在逐件上架…";
  elements.progressNumbers.textContent = `${job.completed} / ${job.total}`;
  elements.progressBar.style.width = `${percent}%`;
  elements.resultSummary.textContent =
    `成功 ${job.succeeded} 件 · 失败 ${job.failed} 件 · 每件买家支付 ${job.buyerPaysFormatted} · 预计实收 ${job.sellerReceivesFormatted}`;
  elements.resultList.replaceChildren();
  for (const result of job.results.slice().reverse()) {
    const line = document.createElement("div");
    line.className = "result-line";
    const name = document.createElement("span");
    name.textContent = result.amount > 1 ? `${result.name} × ${result.amount}` : result.name;
    const status = document.createElement("span");
    status.className = result.ok ? "ok" : "bad";
    status.textContent = result.message;
    line.append(name, status);
    elements.resultList.append(line);
  }
  if (job.state === "finished" && job.needsConfirmation > 0) {
    elements.resultSummary.textContent +=
      ` · 有 ${job.needsConfirmation} 件需要在 Steam 手机令牌或邮箱中确认`;
  }
  if (job.fatalError) elements.resultSummary.textContent += ` · ${job.fatalError}`;
}

async function monitorJob(jobId) {
  while (true) {
    const job = await api(`/api/jobs/${jobId}`);
    renderJob(job);
    if (job.state === "finished") {
      elements.sellButton.textContent = "一键出售";
      elements.sellButton.disabled = true;
      toast(job.failed ? "任务已完成，部分物品上架失败" : "全部物品已提交上架", 7000);
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 900));
  }
}

elements.loginButton.addEventListener("click", async () => {
  setBusy(elements.loginButton, true, "等待 Steam 登录…");
  try {
    await api("/api/login", { method: "POST", body: "{}" });
    window.clearInterval(loginPoll);
    loginPoll = window.setInterval(async () => {
      try {
        const result = await api("/api/login/finish", { method: "POST", body: "{}" });
        if (result.loggedIn) {
          window.clearInterval(loginPoll);
          setBusy(elements.loginButton, false);
          await refreshStatus();
        }
      } catch {
        // Keep polling while the official login page is open.
      }
    }, 1400);
  } catch (error) {
    setBusy(elements.loginButton, false);
    toast(error.message, 7000);
  }
});

elements.logoutButton.addEventListener("click", async () => {
  if (!window.confirm("退出只会清除此工具保存的 Steam 会话，不会退出 Steam 客户端。继续吗？")) return;
  await api("/api/logout", { method: "POST", body: "{}" });
  show(elements.previewPanel, false);
  show(elements.progressPanel, false);
  await refreshStatus();
});

elements.scanButton.addEventListener("click", scan);
elements.itemName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") scan();
});
elements.allButton.addEventListener("click", () => {
  if (currentPreview) elements.quantity.value = currentPreview.usableCount;
  validateSellButton();
});
elements.price.addEventListener("input", () => {
  scheduleQuote();
  validateSellButton();
});
elements.priceMode.addEventListener("change", scheduleQuote);
elements.quantity.addEventListener("input", validateSellButton);
elements.confirmCheck.addEventListener("change", validateSellButton);
elements.sellButton.addEventListener("click", sell);

(async function initialize() {
  try {
    appToken = (await api("/api/bootstrap")).appToken;
    await refreshStatus();
  } catch (error) {
    toast(`初始化失败：${error.message}`, 10000);
  }
})();
