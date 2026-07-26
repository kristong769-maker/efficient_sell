"use strict";

const elements = Object.fromEntries(
  [
    "statusDot", "statusText", "logoutButton", "loginPanel", "workspace", "loginButton",
    "category", "itemName", "matchMode", "categoryHint", "scanButton", "lowestButton",
    "highestButton", "previewPanel", "liveInventory", "matchCount", "contextCount",
    "assetCount", "warningBox", "itemGroups", "quantity", "allButton", "price",
    "priceMode", "currencyCode", "quote", "confirmCheck", "sellButton", "progressPanel",
    "progressText", "progressNumbers", "progressBar", "resultSummary", "resultList", "toast"
  ].map((id) => [id, document.getElementById(id)])
);

const categoryHints = {
  all: "扫描库存中的全部可售商品；此分类无需搜索。",
  weapon_case: "仅识别 CS2 武器箱；可留空扫描全部，或输入关键词缩小范围。",
  key: "识别库存中的可售钥匙；可留空扫描全部，或输入关键词缩小范围。",
  trading_card: "识别全部可售集换式卡牌；可按卡牌名关键词搜索。",
  specific: "请输入商品名称；建议使用精确匹配，避免误售相似商品。"
};

let appToken = "";
let currentPreview = null;
let currency = null;
let quoteTimer = null;
let loginPoll = null;
let lastScanPayload = null;
let automaticPriceMode = null;

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

function updateCategoryControls(resetMode = false) {
  const searchable = elements.category.value !== "all";
  elements.itemName.disabled = !searchable;
  elements.matchMode.disabled = !searchable;
  if (resetMode) {
    elements.matchMode.value = elements.category.value === "specific"
      ? "exact"
      : "contains";
  }
  elements.categoryHint.textContent = categoryHints[elements.category.value] || "";
}

function setScanBusy(busy, activeMode = null) {
  const buttons = [
    [elements.scanButton, "扫描后自定义价格"],
    [elements.lowestButton, "以市场底价上架"],
    [elements.highestButton, "以最高求购价出售"]
  ];
  elements.category.disabled = busy;
  elements.itemName.disabled = busy;
  elements.matchMode.disabled = busy;
  for (const [button, normalText] of buttons) {
    button.disabled = busy;
    button.textContent = normalText;
  }
  if (busy) {
    const activeButton = activeMode === "lowest"
      ? elements.lowestButton
      : activeMode === "highest_buy"
        ? elements.highestButton
        : elements.scanButton;
    activeButton.textContent = activeMode === "lowest"
      ? "正在读取市场底价…"
      : activeMode === "highest_buy"
        ? "正在读取最高求购价…"
        : "正在扫描…";
  } else {
    updateCategoryControls();
  }
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

function setPriceModeOptions(marketPriceMode) {
  elements.priceMode.replaceChildren();
  const options = marketPriceMode === "highest_buy"
    ? [["market_highest_buy", "最高求购价（优先立即成交）"]]
    : marketPriceMode === "lowest"
      ? [["market_lowest", "市场最低在售价"]]
      : [["buyer", "买家支付总价"], ["receive", "卖家实收金额"]];
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    elements.priceMode.append(option);
  }
  elements.priceMode.disabled = Boolean(marketPriceMode);
  elements.price.disabled = Boolean(marketPriceMode);
  if (marketPriceMode) elements.price.value = "";
}

function renderGroups(groups, marketPriceMode) {
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
    const facts = document.createElement("div");
    facts.className = "item-facts";
    if (marketPriceMode) {
      const price = document.createElement("span");
      price.className = "item-market-price";
      price.textContent = group.marketPriceFormatted || "暂无价格";
      facts.append(price);
    }
    const count = document.createElement("span");
    count.className = "item-count";
    count.textContent = `× ${group.count}`;
    facts.append(count);
    row.append(image, info, facts);
    elements.itemGroups.append(row);
  }
}

function renderPreview(preview, refreshed = false) {
  currentPreview = preview;
  automaticPriceMode = preview.marketPriceMode || null;
  elements.matchCount.textContent = preview.usableCount;
  elements.contextCount.textContent = preview.scannedContexts;
  elements.assetCount.textContent = preview.scannedAssets;
  elements.quantity.max = Math.max(1, preview.usableCount);
  elements.quantity.value = preview.usableCount || 1;
  renderGroups(preview.groups, automaticPriceMode);
  setPriceModeOptions(automaticPriceMode);

  const warnings = [];
  if (preview.truncated) warnings.push(`匹配数量较多，本次最多处理 ${preview.usableCount} 件。`);
  if (preview.demandLimited) warnings.push("部分库存超过当前最高价求购数量，已按可立即成交数量保留。");
  if (preview.errors.length) warnings.push(`部分库存读取失败：${preview.errors.join("；")}`);
  if (preview.priceErrors.length) warnings.push(`部分商品没有取得有效市场价格：${preview.priceErrors.join("；")}`);
  if (!preview.totalFound) warnings.push(`没有找到可出售的${preview.categoryName || "商品"}。`);
  elements.warningBox.textContent = warnings.join(" ");
  show(elements.warningBox, warnings.length > 0);

  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  elements.liveInventory.textContent = refreshed
    ? `已更新 ${now} · 实时可上架 ${preview.usableCount} 件`
    : `库存快照 ${now} · 可上架 ${preview.usableCount} 件`;
  elements.confirmCheck.checked = false;
  elements.sellButton.textContent = "一键出售";
  updateQuote();
  validateSellButton();
  show(elements.previewPanel);
}

async function scan(marketPriceMode = null) {
  const category = elements.category.value;
  const name = elements.itemName.value.trim();
  if (category === "specific" && !name) {
    toast("请先输入要出售的商品名称");
    elements.itemName.focus();
    return;
  }
  const payload = {
    category,
    name: category === "all" ? "" : name,
    mode: elements.matchMode.value
  };
  if (marketPriceMode) payload.marketPriceMode = marketPriceMode;
  lastScanPayload = payload;
  setScanBusy(true, marketPriceMode);
  show(elements.previewPanel, false);
  currentPreview = null;
  try {
    const preview = await api("/api/preview", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderPreview(preview);
    elements.previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(error.message, 7000);
  } finally {
    setScanBusy(false);
  }
}

async function updateQuote() {
  if (automaticPriceMode) {
    const action = automaticPriceMode === "highest_buy"
      ? "按当前最高求购价优先立即成交"
      : "按当前市场最低在售价创建挂单";
    elements.quote.textContent = currentPreview?.marketBuyerPriceFormatted
      ? `${action} · 买家价格 ${currentPreview.marketBuyerPriceFormatted} · 预计实收 ${currentPreview.marketSellerPriceFormatted}`
      : "没有取得可用的市场价格";
    return;
  }
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
  const priceReady = automaticPriceMode
    ? Boolean(currentPreview?.marketBuyerPriceFormatted)
    : Boolean(elements.price.value.trim());
  elements.sellButton.disabled = !(
    currentPreview
    && currentPreview.usableCount > 0
    && elements.confirmCheck.checked
    && priceReady
    && Number(elements.quantity.value) > 0
  );
}

async function sell() {
  if (!currentPreview) return;
  const quantity = Number(elements.quantity.value);
  if (
    !Number.isInteger(quantity)
    || quantity < 1
    || quantity > currentPreview.usableCount
  ) {
    toast(`出售数量必须在 1 到 ${currentPreview.usableCount} 之间`);
    return;
  }
  const priceDescription = automaticPriceMode === "highest_buy"
    ? "最高求购价"
    : automaticPriceMode === "lowest"
      ? "市场最低在售价"
      : "自定义价格";
  const customWarning = !automaticPriceMode && currentPreview.groups.length > 1
    ? "\n\n匹配到的不同商品都会使用当前输入的同一价格。"
    : "";
  if (!window.confirm(
    `确认以${priceDescription}出售 ${quantity} 件商品吗？${customWarning}`
  )) return;
  elements.category.disabled = true;
  elements.itemName.disabled = true;
  elements.matchMode.disabled = true;
  elements.scanButton.disabled = true;
  elements.lowestButton.disabled = true;
  elements.highestButton.disabled = true;
  setBusy(elements.sellButton, true, "正在创建任务…");
  try {
    const job = await api("/api/sell", {
      method: "POST",
      body: JSON.stringify({
        previewId: currentPreview.previewId,
        confirmToken: currentPreview.confirmToken,
        quantity,
        price: elements.price.value,
        priceMode: automaticPriceMode === "highest_buy"
          ? "market_highest_buy"
          : automaticPriceMode === "lowest"
            ? "market_lowest"
            : elements.priceMode.value
      })
    });
    currentPreview = null;
    show(elements.progressPanel);
    elements.progressPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    await monitorJob(job.id);
  } catch (error) {
    toast(error.message, 7000);
    setScanBusy(false);
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

async function refreshInventoryAfterJob(job) {
  if (!lastScanPayload) return;
  elements.progressText.textContent = "任务完成，正在更新库存…";
  try {
    const preview = await api("/api/preview", {
      method: "POST",
      body: JSON.stringify(lastScanPayload)
    });
    show(elements.progressPanel, false);
    renderPreview(preview, true);
    setScanBusy(false);
    elements.previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    toast(
      `${job.failed ? "任务完成，部分物品上架失败" : "上架任务完成"}；当前实时可上架 ${preview.usableCount} 件`,
      7000
    );
  } catch (error) {
    elements.progressText.textContent = "任务完成，库存更新失败";
    elements.sellButton.textContent = "一键出售";
    elements.sellButton.disabled = true;
    setScanBusy(false);
    toast(`任务已完成，但库存自动更新失败：${error.message}`, 8000);
  }
}

async function monitorJob(jobId) {
  while (true) {
    const job = await api(`/api/jobs/${jobId}`);
    renderJob(job);
    if (job.state === "finished") {
      await refreshInventoryAfterJob(job);
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

elements.category.addEventListener("change", () => updateCategoryControls(true));
elements.scanButton.addEventListener("click", () => scan());
elements.lowestButton.addEventListener("click", () => scan("lowest"));
elements.highestButton.addEventListener("click", () => scan("highest_buy"));
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
  updateCategoryControls();
  try {
    appToken = (await api("/api/bootstrap")).appToken;
    await refreshStatus();
  } catch (error) {
    toast(`初始化失败：${error.message}`, 10000);
  }
})();
