"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  buyerPriceForDesiredReceive,
  calculateFees,
  currencyMetadata,
  extractMarketItemNameId,
  formatMinor,
  highestBuyOrderFromListingHtml,
  highestBuyOrderFromHistogram,
  itemMatches,
  parseDisplayPrice,
  parseEmbeddedJson,
  sleep
} = require("./steam-utils");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PROFILE_DIR = process.env.STEAM_QUICK_SELL_PROFILE
  ? path.resolve(process.env.STEAM_QUICK_SELL_PROFILE)
  : path.join(ROOT, ".data", "steam-browser");
const HOST = "127.0.0.1";
const PORT = Number(process.env.STEAM_QUICK_SELL_PORT || 31777);
const APP_TOKEN = process.env.STEAM_QUICK_SELL_APP_TOKEN
  || crypto.randomBytes(32).toString("hex");
const MAX_MATCHED_UNITS = 500;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const SELL_CONCURRENCY = Math.min(
  8,
  Math.max(1, Number(process.env.STEAM_SELL_CONCURRENCY || 2))
);
const SELL_REQUEST_INTERVAL_MS = Math.max(
  200,
  Number(process.env.STEAM_SELL_INTERVAL_MS || 400)
);
const SCAN_CONCURRENCY = Math.min(
  6,
  Math.max(1, Number(process.env.STEAM_SCAN_CONCURRENCY || 4))
);
const MARKET_PRICE_CONCURRENCY = 3;
const NATIVE_MODE = process.env.STEAM_QUICK_SELL_NATIVE === "1";
const STEAM_CLIENT_MODE = process.env.STEAM_QUICK_SELL_STEAM_CLIENT === "1";
const STEAM_CDP_PORT = Number(process.env.STEAM_CDP_PORT || 8080);

let browserContext;
let browserExecutable;
let remoteBrowser;
let appPage;
let loginPage;
let server;
let walletCache;
let walletFetchPromise;
const previews = new Map();
const jobs = new Map();
const marketItemNameIdCache = new Map();

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatRange(values, currency) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return minimum === maximum
    ? formatMinor(minimum, currency)
    : `${formatMinor(minimum, currency)} – ${formatMinor(maximum, currency)}`;
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("请求内容过大");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("请求内容不是有效 JSON");
  }
}

function assertLocalMutation(request) {
  const expectedOrigin = `http://${HOST}:${PORT}`;
  if (request.headers.origin !== expectedOrigin) {
    throw new Error("已拒绝非本地页面发起的操作");
  }
  if (request.headers["x-app-token"] !== APP_TOKEN) {
    throw new Error("本地会话令牌无效，请刷新页面");
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
}

function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(resolved)) {
    jsonResponse(response, 404, { error: "页面不存在" });
    return;
  }
  const body = fs.readFileSync(resolved);
  response.writeHead(200, {
    "Content-Type": contentType(resolved),
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": [
      "default-src 'self'",
      "img-src 'self' https://community.fastly.steamstatic.com https://steamcommunity-a.akamaihd.net data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(body);
}

async function steamCookies() {
  if (STEAM_CLIENT_MODE) await connectToSteamClient();
  if (!browserContext) return [];
  return browserContext.cookies(["https://steamcommunity.com", "https://store.steampowered.com"]);
}

async function getSession() {
  const cookies = await steamCookies();
  const secureCookie = cookies.find((cookie) => cookie.name === "steamLoginSecure");
  const sessionCookie = cookies.find(
    (cookie) => cookie.name === "sessionid" && cookie.domain.includes("steamcommunity")
  );
  if (!secureCookie || !sessionCookie) return null;
  let decoded = secureCookie.value;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Chromium usually returns the already-decoded value.
  }
  const steamId = decoded.split("||")[0];
  if (!/^\d{17}$/.test(steamId)) return null;
  return { steamId, sessionId: sessionCookie.value };
}

async function getText(url, options = {}) {
  if (STEAM_CLIENT_MODE) {
    const result = await steamClientFetch(url, { method: "GET" });
    if (!result.ok) {
      throw new Error(`Steam 返回 HTTP ${result.status}，请稍后重试`);
    }
    return result.text;
  }
  const response = await browserContext.request.get(url, {
    timeout: 30_000,
    failOnStatusCode: false,
    ...options
  });
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`Steam 返回 HTTP ${response.status()}，请稍后重试`);
  }
  return text;
}

async function getWalletInfo(force = false) {
  if (!force && walletCache && Date.now() - walletCache.time < 30 * 60 * 1000) {
    return walletCache.value;
  }
  if (!force && walletFetchPromise) return walletFetchPromise;
  walletFetchPromise = (async () => {
    const html = await getText("https://steamcommunity.com/market/?l=schinese");
    const wallet = parseEmbeddedJson(html, "g_rgWalletInfo");
    if (!wallet || !wallet.wallet_currency) {
      throw new Error("无法读取 Steam 钱包币种；请确认账号能够使用社区市场");
    }
    walletCache = { time: Date.now(), value: wallet };
    return wallet;
  })();
  try {
    return await walletFetchPromise;
  } finally {
    walletFetchPromise = null;
  }
}

async function statusPayload() {
  let session;
  try {
    session = await getSession();
  } catch (error) {
    return {
      loggedIn: false,
      steamClientUnavailable: true,
      warning: errorMessage(error)
    };
  }
  if (!session) return { loggedIn: false };
  let wallet = null;
  let warning = null;
  try {
    wallet = await getWalletInfo();
  } catch (error) {
    warning = errorMessage(error);
  }
  const currency = wallet ? currencyMetadata(wallet) : null;
  return {
    loggedIn: true,
    steamId: session.steamId,
    currency,
    warning
  };
}

async function openLogin() {
  if (NATIVE_MODE) {
    await replaceBrowserContext(false);
    loginPage = browserContext.pages()[0] || await browserContext.newPage();
  }
  if (loginPage && !loginPage.isClosed()) {
    if (!/^about:blank/.test(loginPage.url())) {
      await loginPage.bringToFront();
      return;
    }
  } else {
    loginPage = await browserContext.newPage();
  }
  await loginPage.goto(
    "https://steamcommunity.com/login/home/?goto=market%2F",
    { waitUntil: "domcontentloaded", timeout: 60_000 }
  );
  await loginPage.bringToFront();
}

async function finishLoginIfPossible() {
  const session = await getSession();
  if (!session) {
    if (NATIVE_MODE && !browserContext) await replaceBrowserContext(true);
    return false;
  }
  walletCache = null;
  if (NATIVE_MODE) {
    await replaceBrowserContext(true);
  } else {
    if (loginPage && !loginPage.isClosed()) await loginPage.close().catch(() => {});
    if (appPage && !appPage.isClosed()) await appPage.bringToFront().catch(() => {});
  }
  return true;
}

async function discoverContexts(steamId) {
  const html = await getText(
    `https://steamcommunity.com/profiles/${steamId}/inventory/?l=schinese`
  );
  const appData = parseEmbeddedJson(html, "g_rgAppContextData");
  if (!appData) {
    throw new Error("无法读取库存目录；请确认库存页面可访问后重试");
  }
  const contexts = [];
  for (const [appIdKey, app] of Object.entries(appData)) {
    const appId = String(app.appid || appIdKey);
    const contextData = app.rgContexts || app.contexts || {};
    for (const [contextIdKey, context] of Object.entries(contextData)) {
      const assetCount = Number(context.asset_count ?? 0);
      if (assetCount <= 0) continue;
      contexts.push({
        appId,
        appName: app.name || `App ${appId}`,
        contextId: String(context.id || contextIdKey),
        contextName: context.name || "库存",
        assetCount
      });
    }
  }
  return contexts;
}

async function fetchInventoryPage(steamId, context, startAssetId) {
  const query = new URLSearchParams({ l: "schinese", count: "2000" });
  if (startAssetId) query.set("start_assetid", startAssetId);
  const url = `https://steamcommunity.com/inventory/${steamId}/${context.appId}/${context.contextId}?${query}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (STEAM_CLIENT_MODE) {
      const result = await steamClientFetch(url, { method: "GET" });
      if (result.status === 429) {
        lastError = new Error("Steam 请求过于频繁");
        await sleep(2500 * (attempt + 1));
        continue;
      }
      if (!result.ok) {
        throw new Error(`${context.appName} 库存读取失败（HTTP ${result.status}）`);
      }
      const data = JSON.parse(result.text);
      if (!data || (data.success !== true && Number(data.success) !== 1)) {
        throw new Error(`${context.appName} 库存返回了无效数据`);
      }
      return data;
    }
    const response = await browserContext.request.get(url, {
      timeout: 30_000,
      failOnStatusCode: false,
      headers: { Referer: `https://steamcommunity.com/profiles/${steamId}/inventory/` }
    });
    if (response.status() === 429) {
      lastError = new Error("Steam 请求过于频繁");
      await sleep(2500 * (attempt + 1));
      continue;
    }
    if (!response.ok()) {
      throw new Error(`${context.appName} 库存读取失败（HTTP ${response.status()}）`);
    }
    const data = await response.json().catch(() => null);
    if (!data || (data.success !== true && Number(data.success) !== 1)) {
      throw new Error(`${context.appName} 库存返回了无效数据`);
    }
    return data;
  }
  throw lastError || new Error("库存读取失败");
}

function isTradingCard(description, asset, context) {
  const appId = String(asset.appid || context.appId);
  const contextId = String(asset.contextid || context.contextId);
  return appId === "753"
    && contextId === "6"
    && (description.tags || []).some(
      (tag) => tag.category === "item_class" && tag.internal_name === "item_class_2"
    );
}

async function scanMatches(steamId, query, mode, options = {}) {
  const contexts = await discoverContexts(steamId);
  if (!contexts.length) throw new Error("当前账号没有可读取的 Steam 库存");
  const targetContexts = options.tradingCardsOnly
    ? contexts.filter((context) => context.appId === "753" && context.contextId === "6")
    : contexts;
  if (!targetContexts.length) {
    return { matches: [], scannedAssets: 0, contexts: 0, errors: [] };
  }

  const matches = [];
  const errors = [];
  let scannedAssets = 0;
  let nextContext = 0;

  async function scanWorker() {
    while (true) {
      const contextIndex = nextContext;
      nextContext += 1;
      if (contextIndex >= targetContexts.length) return;
      const context = targetContexts[contextIndex];
      let startAssetId = null;
      try {
        do {
          const data = await fetchInventoryPage(steamId, context, startAssetId);
          const descriptions = new Map();
          for (const description of data.descriptions || []) {
            descriptions.set(`${description.classid}_${description.instanceid || "0"}`, description);
          }
          for (const asset of data.assets || []) {
            scannedAssets += 1;
            const description = descriptions.get(`${asset.classid}_${asset.instanceid || "0"}`);
            if (!description || Number(description.marketable) !== 1) continue;
            const tradingCard = isTradingCard(description, asset, context);
            if (options.tradingCardsOnly) {
              if (!tradingCard) continue;
            } else if (!itemMatches(description, query, mode)) {
              continue;
            }
            matches.push({
              appId: String(asset.appid || context.appId),
              appName: context.appName,
              contextId: String(asset.contextid || context.contextId),
              assetId: String(asset.assetid),
              amount: Math.max(1, Number(asset.amount || 1)),
              name: description.name || description.market_name || description.market_hash_name,
              marketHashName: description.market_hash_name || description.market_name || description.name,
              isTradingCard: tradingCard,
              publisherFee: Number.isFinite(Number(description.market_fee))
                ? Number(description.market_fee)
                : null,
              iconUrl: description.icon_url
                ? `https://community.fastly.steamstatic.com/economy/image/${description.icon_url}/96fx96f`
                : null
            });
          }
          startAssetId = data.more_items ? String(data.last_assetid || "") : null;
        } while (startAssetId);
      } catch (error) {
        errors.push(`${context.appName}: ${errorMessage(error)}`);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SCAN_CONCURRENCY, targetContexts.length) },
      () => scanWorker()
    )
  );
  return { matches, scannedAssets, contexts: targetContexts.length, errors };
}

function groupMatches(matches) {
  const grouped = new Map();
  for (const item of matches) {
    const key = `${item.appId}|${item.marketHashName}`;
    const current = grouped.get(key) || {
      appId: item.appId,
      appName: item.appName,
      name: item.name,
      marketHashName: item.marketHashName,
      count: 0,
      iconUrl: item.iconUrl,
      isTradingCard: item.isTradingCard,
      lowestPriceFormatted: item.lowestPriceFormatted || null,
      highestBuyOrderFormatted: item.highestBuyOrderFormatted || null,
      highestBuyOrderQuantity: item.highestBuyOrderQuantity || 0,
      marketPriceFormatted: item.marketPriceFormatted || null
    };
    current.count += item.amount;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count);
}

async function fetchLowestMarketBuyerPrice(marketHashName, currencyId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await getSteamClientPage();
    const result = await page.evaluate(async ({ itemName, walletCurrency }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      try {
        const searchUrl = new URL("https://steamcommunity.com/market/search/render/");
        searchUrl.search = new URLSearchParams({
          query: itemName,
          start: "0",
          count: "100",
          search_descriptions: "0",
          sort_column: "price",
          sort_dir: "asc",
          appid: "753",
          norender: "1",
          currency: String(walletCurrency)
        });
        const searchResponse = await fetch(searchUrl, {
          credentials: "include",
          cache: "no-store",
          headers: { "X-Requested-With": "XMLHttpRequest" },
          signal: controller.signal
        });
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          const exactResult = (searchData.results || []).find(
            (entry) => entry.hash_name === itemName && Number(entry.sell_price) > 0
          );
          if (searchData.success && exactResult) {
            return {
              status: searchResponse.status,
              buyerPrice: Number(exactResult.sell_price),
              formatted: exactResult.sell_price_text || null
            };
          }
        }

        // The search endpoint is less aggressively rate limited. Retain
        // priceoverview as a fallback for an unusual name that is not present
        // in the first exact search results.
        const overviewUrl = new URL("https://steamcommunity.com/market/priceoverview/");
        overviewUrl.search = new URLSearchParams({
          currency: String(walletCurrency),
          appid: "753",
          market_hash_name: itemName
        });
        const overviewResponse = await fetch(overviewUrl, {
          credentials: "include",
          cache: "no-store",
          headers: { "X-Requested-With": "XMLHttpRequest" },
          signal: controller.signal
        });
        if (overviewResponse.status === 429) return { status: 429 };
        const overviewData = await overviewResponse.json();
        if (
          !overviewResponse.ok
          || !overviewData.success
          || !overviewData.lowest_price
        ) {
          return {
            status: overviewResponse.status,
            error: "当前没有市场在售价格"
          };
        }
        if (typeof GetPriceValueAsInt !== "function") {
          return { status: 500, error: "Steam 价格解析器不可用" };
        }
        return {
          status: overviewResponse.status,
          buyerPrice: Number(GetPriceValueAsInt(overviewData.lowest_price)),
          formatted: overviewData.lowest_price
        };
      } catch (error) {
        return {
          status: error?.name === "AbortError" ? 408 : 500,
          error: error?.name === "AbortError" ? "最低价请求超时" : String(error)
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }, { itemName: marketHashName, walletCurrency: currencyId });
    if (result.buyerPrice > 0) return result;
    lastError = new Error(result.error || `Steam 返回 HTTP ${result.status}`);
    if (result.status !== 408 && result.status !== 429 && result.status < 500) break;
    await sleep(1200 * (attempt + 1));
  }
  throw lastError || new Error("无法读取市场最低价");
}

async function populateLowestCardPrices(items, wallet) {
  const currency = currencyMetadata(wallet);
  const uniqueItems = new Map();
  for (const item of items) {
    if (!item.isTradingCard) continue;
    if (!uniqueItems.has(item.marketHashName)) {
      uniqueItems.set(item.marketHashName, []);
    }
    uniqueItems.get(item.marketHashName).push(item);
  }
  const entries = [...uniqueItems.entries()];
  const errors = [];
  let nextIndex = 0;

  async function priceWorker(workerIndex) {
    if (workerIndex > 0) await sleep(workerIndex * 180);
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const [marketHashName, matchingItems] = entries[index];
      try {
        const result = await fetchLowestMarketBuyerPrice(
          marketHashName,
          currency.id
        );
        for (const item of matchingItems) {
          const quote = calculateFees(
            result.buyerPrice,
            wallet,
            item.publisherFee
          );
          item.lowestBuyerPrice = quote.buyerPays;
          item.lowestSellerPrice = quote.sellerReceives;
          item.lowestPriceFormatted = formatMinor(quote.buyerPays, currency);
          item.marketPriceFormatted = item.lowestPriceFormatted;
        }
      } catch (error) {
        errors.push(`${matchingItems[0]?.name || marketHashName}: ${errorMessage(error)}`);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MARKET_PRICE_CONCURRENCY, entries.length) },
      (_unused, index) => priceWorker(index)
    )
  );
  return errors;
}

async function fetchHighestMarketBuyOrder(marketHashName, wallet) {
  let lastError;
  let cachedItemNameId = marketItemNameIdCache.get(marketHashName) || null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (!cachedItemNameId) {
        const listingUrl = new URL(
          `https://steamcommunity.com/market/listings/753/${encodeURIComponent(marketHashName)}`
        );
        listingUrl.searchParams.set("l", "english");
        const listingHtml = await getText(listingUrl.href);
        const renderedOrder = highestBuyOrderFromListingHtml(
          listingHtml,
          currencyMetadata(wallet)
        );
        if (renderedOrder) return renderedOrder;
        cachedItemNameId = extractMarketItemNameId(listingHtml);
        if (!cachedItemNameId) {
          throw new Error("无法识别市场求购数据编号");
        }
        marketItemNameIdCache.set(marketHashName, cachedItemNameId);
      }

      const histogramUrl = new URL(
        "https://steamcommunity.com/market/itemordershistogram"
      );
      histogramUrl.search = new URLSearchParams({
        country: wallet.wallet_country || "CN",
        language: "schinese",
        currency: String(wallet.wallet_currency),
        item_nameid: cachedItemNameId,
        two_factor: "0"
      });
      const histogram = JSON.parse(await getText(histogramUrl.href));
      const order = highestBuyOrderFromHistogram(histogram);
      if (!order) throw new Error("当前没有有效的市场求购单");
      return { itemNameId: cachedItemNameId, ...order };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (!/429|请求超时|HTTP 5\d\d|closed|destroyed|Target/i.test(lastError.message)) {
      break;
    }
    await sleep(1800 * (attempt + 1));
  }
  throw lastError || new Error("无法读取市场最高求购价");
}

async function populateHighestCardBuyOrders(items, wallet) {
  const currency = currencyMetadata(wallet);
  const uniqueItems = new Map();
  for (const item of items) {
    if (!item.isTradingCard) continue;
    if (!uniqueItems.has(item.marketHashName)) {
      uniqueItems.set(item.marketHashName, []);
    }
    uniqueItems.get(item.marketHashName).push(item);
  }
  const entries = [...uniqueItems.entries()];
  const errors = [];
  let nextIndex = 0;

  async function priceWorker(workerIndex) {
    if (workerIndex > 0) await sleep(workerIndex * 250);
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const [marketHashName, matchingItems] = entries[index];
      try {
        const result = await fetchHighestMarketBuyOrder(marketHashName, wallet);
        for (const item of matchingItems) {
          const quote = calculateFees(
            result.buyerPrice,
            wallet,
            item.publisherFee
          );
          item.highestBuyOrderBuyerPrice = quote.buyerPays;
          item.highestBuyOrderSellerPrice = quote.sellerReceives;
          item.highestBuyOrderQuantity = result.quantity;
          item.highestBuyOrderFormatted = formatMinor(quote.buyerPays, currency);
          item.marketPriceFormatted = item.highestBuyOrderFormatted;
        }
      } catch (error) {
        errors.push(`${matchingItems[0]?.name || marketHashName}: ${errorMessage(error)}`);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MARKET_PRICE_CONCURRENCY, entries.length) },
      (_unused, index) => priceWorker(index)
    )
  );
  return errors;
}

function capMatchesToHighestBuyDemand(items) {
  const remainingByName = new Map();
  const kept = [];
  for (const item of items) {
    if (!remainingByName.has(item.marketHashName)) {
      remainingByName.set(
        item.marketHashName,
        Math.max(0, Math.trunc(Number(item.highestBuyOrderQuantity || 0)))
      );
    }
    const remaining = remainingByName.get(item.marketHashName);
    const amount = Math.min(item.amount, remaining);
    if (amount > 0 && item.highestBuyOrderSellerPrice > 0) {
      kept.push({ ...item, amount });
      remainingByName.set(item.marketHashName, remaining - amount);
    }
  }
  return kept;
}

async function createPreview(body) {
  const session = await getSession();
  if (!session) throw new Error("Steam 登录已失效，请重新登录");
  const tradingCardsOnly = body.tradingCardsOnly === true;
  const cardPriceMode = tradingCardsOnly && body.cardPriceMode === "highest_buy"
    ? "highest_buy"
    : tradingCardsOnly
      ? "lowest"
      : null;
  const query = tradingCardsOnly ? "全部集换式卡牌" : String(body.name || "").trim();
  if (!tradingCardsOnly && (!query || query.length > 160)) {
    throw new Error("请输入有效的物品名称");
  }
  const mode = body.mode === "contains" ? "contains" : "exact";
  const scan = await scanMatches(
    session.steamId,
    query,
    mode,
    { tradingCardsOnly }
  );
  let priceErrors = [];
  let wallet = walletCache?.value || null;
  if (tradingCardsOnly && scan.matches.length) {
    wallet = wallet || await getWalletInfo();
    priceErrors = cardPriceMode === "highest_buy"
      ? await populateHighestCardBuyOrders(scan.matches, wallet)
      : await populateLowestCardPrices(scan.matches, wallet);
  }
  const totalFound = scan.matches.reduce((sum, item) => sum + item.amount, 0);
  const usableMatches = cardPriceMode === "highest_buy"
    ? capMatchesToHighestBuyDemand(scan.matches)
    : tradingCardsOnly
      ? scan.matches.filter((item) => item.lowestSellerPrice > 0)
    : scan.matches;
  const usableBeforeLimit = usableMatches.reduce(
    (sum, item) => sum + item.amount,
    0
  );
  const kept = [];
  let unitsKept = 0;
  for (const item of usableMatches) {
    if (unitsKept >= MAX_MATCHED_UNITS) break;
    const amount = Math.min(item.amount, MAX_MATCHED_UNITS - unitsKept);
    kept.push({ ...item, amount });
    unitsKept += amount;
  }
  const id = crypto.randomUUID();
  const confirmToken = crypto.randomBytes(18).toString("base64url");
  previews.set(id, {
    id,
    confirmToken,
    createdAt: Date.now(),
    steamId: session.steamId,
    query,
    mode,
    tradingCardsOnly,
    cardPriceMode,
    marketPriceTime: tradingCardsOnly ? Date.now() : null,
    wallet: wallet || walletCache?.value || null,
    items: kept
  });
  const currency = wallet ? currencyMetadata(wallet) : null;
  const marketBuyerPrices = kept
    .map((item) => (
      cardPriceMode === "highest_buy"
        ? item.highestBuyOrderBuyerPrice
        : item.lowestBuyerPrice
    ))
    .filter((value) => value > 0);
  const marketSellerPrices = kept
    .map((item) => (
      cardPriceMode === "highest_buy"
        ? item.highestBuyOrderSellerPrice
        : item.lowestSellerPrice
    ))
    .filter((value) => value > 0);
  const marketBuyerPriceFormatted = marketBuyerPrices.length
    ? formatRange(marketBuyerPrices, currency)
    : null;
  const marketSellerPriceFormatted = marketSellerPrices.length
    ? formatRange(marketSellerPrices, currency)
    : null;
  return {
    previewId: id,
    confirmToken,
    query,
    mode,
    tradingCardsOnly,
    cardPriceMode,
    totalFound,
    usableCount: unitsKept,
    truncated: usableBeforeLimit > unitsKept,
    demandLimited: cardPriceMode === "highest_buy" && totalFound > usableBeforeLimit,
    groups: groupMatches(kept),
    marketBuyerPriceFormatted,
    marketSellerPriceFormatted,
    lowestBuyerPriceFormatted: cardPriceMode === "lowest"
      ? marketBuyerPriceFormatted
      : null,
    lowestSellerPriceFormatted: cardPriceMode === "lowest"
      ? marketSellerPriceFormatted
      : null,
    highestBuyOrderFormatted: cardPriceMode === "highest_buy"
      ? marketBuyerPriceFormatted
      : null,
    highestBuyOrderSellerFormatted: cardPriceMode === "highest_buy"
      ? marketSellerPriceFormatted
      : null,
    scannedAssets: scan.scannedAssets,
    scannedContexts: scan.contexts,
    errors: scan.errors,
    priceErrors
  };
}

function lotsFromPreview(preview, quantity) {
  const available = preview.items.reduce((sum, item) => sum + item.amount, 0);
  const wanted = quantity === "all"
    ? available
    : Math.min(available, Math.max(1, Math.trunc(Number(quantity))));
  const lots = [];
  let selected = 0;
  for (const item of preview.items) {
    const amount = Math.min(item.amount, wanted - selected);
    if (amount > 0) {
      lots.push({ ...item, amount });
      selected += amount;
    }
    if (selected >= wanted) break;
  }
  return lots;
}

function isTransientListingFailure(status, message) {
  if (status === 408 || status === 429 || status >= 500) return true;
  return /try again|problem listing|temporar|too many|rate limit|server busy|稍后|频繁|重试|服务器繁忙/i
    .test(String(message || ""));
}

async function postListing(session, item, sellerPrice, beforeAttempt) {
  let lastResult;
  let transientRetries = 0;
  let sawTransientFailure = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await beforeAttempt();
    if (STEAM_CLIENT_MODE) {
      const result = await steamClientFetch(
        "https://steamcommunity.com/market/sellitem/",
        {
          method: "POST",
          timeoutMs: 20_000,
          form: {
            sessionid: session.sessionId,
            appid: item.appId,
            contextid: item.contextId,
            assetid: item.assetId,
            amount: String(item.amount),
            price: String(sellerPrice)
          }
        }
      );
      if (result.status === 429) {
        transientRetries += 1;
        sawTransientFailure = true;
        lastResult = { ok: false, message: "Steam 限流" };
        await sleep(4000 * (attempt + 1));
        continue;
      }
      if (result.status === 408) {
        transientRetries += 1;
        sawTransientFailure = true;
        lastResult = { ok: false, message: "Steam 响应超时" };
        await sleep(2500 * (attempt + 1));
        continue;
      }
      let data;
      try {
        data = JSON.parse(result.text);
      } catch {
        data = { success: false, message: result.text.slice(0, 200) };
      }
      if (result.ok && (data.success === true || Number(data.success) === 1)) {
        return {
          ok: true,
          needsConfirmation: Boolean(
            data.requires_confirmation
            || data.needs_mobile_confirmation
            || data.needs_email_confirmation
          ),
          listingId: data.listingid || null,
          transientRetries
        };
      }
      const message = String(data.message || data.error || `HTTP ${result.status}`);
      lastResult = {
        ok: false,
        message
      };
      if (isTransientListingFailure(result.status, message)) {
        transientRetries += 1;
        sawTransientFailure = true;
        if (attempt < 3) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
      }
      break;
    }
    const response = await browserContext.request.post(
      "https://steamcommunity.com/market/sellitem/",
      {
        timeout: 30_000,
        failOnStatusCode: false,
        headers: {
          Origin: "https://steamcommunity.com",
          Referer: `https://steamcommunity.com/profiles/${session.steamId}/inventory/`
        },
        form: {
          sessionid: session.sessionId,
          appid: item.appId,
          contextid: item.contextId,
          assetid: item.assetId,
          amount: String(item.amount),
          // Steam's official sell dialog submits the per-item "You receive" amount.
          price: String(sellerPrice)
        }
      }
    );
    if (response.status() === 429) {
      transientRetries += 1;
      sawTransientFailure = true;
      lastResult = { ok: false, message: "Steam 限流" };
      await sleep(4000 * (attempt + 1));
      continue;
    }
    const data = await response.json().catch(async () => ({
      success: false,
      message: (await response.text().catch(() => "")).slice(0, 200)
    }));
    if (response.ok() && (data.success === true || Number(data.success) === 1)) {
      return {
        ok: true,
        needsConfirmation: Boolean(
          data.requires_confirmation
          || data.needs_mobile_confirmation
          || data.needs_email_confirmation
        ),
        listingId: data.listingid || null,
        transientRetries
      };
    }
    const message = data.message || data.error || `HTTP ${response.status()}`;
    lastResult = { ok: false, message: String(message) };
    if (isTransientListingFailure(response.status(), message)) {
      transientRetries += 1;
      sawTransientFailure = true;
      if (attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
    }
    break;
  }
  return {
    ...(lastResult || { ok: false, message: "未知错误" }),
    transientRetries,
    transientFailure: sawTransientFailure
  };
}

async function runSellJob(job, preview, lots) {
  job.state = "running";
  const workerCount = Math.min(SELL_CONCURRENCY, lots.length);
  job.initialConcurrency = workerCount;
  job.concurrency = workerCount;
  job.transientRetries = 0;
  job.stabilityMode = false;
  let nextIndex = 0;
  let nextRequestAt = Date.now();

  async function waitForRequestSlot() {
    const slot = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = slot + SELL_REQUEST_INTERVAL_MS;
    const waitMs = slot - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }

  async function worker(workerIndex) {
    // Avoid sending every first request in the exact same millisecond.
    if (workerIndex > 0) await sleep(workerIndex * SELL_REQUEST_INTERVAL_MS);
    while (!job.fatalError) {
      if (job.stabilityMode && workerIndex > 0) return;
      const itemIndex = nextIndex;
      nextIndex += 1;
      if (itemIndex >= lots.length) return;
      const item = lots[itemIndex];
      try {
        const session = await getSession();
        if (!session || session.steamId !== preview.steamId) {
          throw new Error("Steam 登录已失效或账号已切换，任务已停止");
        }
        const result = await postListing(
          session,
          item,
          item.sellerPrice,
          waitForRequestSlot
        );
        job.transientRetries += Number(result.transientRetries || 0);
        if (job.transientRetries >= 2 && !job.stabilityMode) {
          job.stabilityMode = true;
          job.concurrency = 1;
        }
        if (result.ok) {
          job.succeeded += item.amount;
          if (result.needsConfirmation) job.needsConfirmation += item.amount;
        } else {
          job.failed += item.amount;
        }
        job.results.push({
          name: item.name,
          amount: item.amount,
          assetId: item.assetId,
          ok: result.ok,
          message: result.ok
            ? (
              result.needsConfirmation
                ? "等待手机或邮箱确认"
                : `已上架${result.transientRetries ? `（重试 ${result.transientRetries} 次）` : ""}`
            )
            : result.message
        });
        if (job.results.length > 100) job.results.shift();
      } catch (error) {
        job.failed += item.amount;
        job.results.push({
          name: item.name,
          amount: item.amount,
          assetId: item.assetId,
          ok: false,
          message: errorMessage(error)
        });
        if (/登录已失效|账号已切换/.test(errorMessage(error))) {
          job.fatalError = errorMessage(error);
        }
      }
      job.completed += item.amount;
      job.updatedAt = Date.now();
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_unused, index) => worker(index))
  );
  if (job.completed < job.total && job.fatalError) {
    job.failed += job.total - job.completed;
    job.completed = job.total;
  }
  job.state = "finished";
  job.updatedAt = Date.now();
}

async function createSellJob(body) {
  const activeJob = [...jobs.values()].find(
    (job) => job.state === "queued" || job.state === "running"
  );
  if (activeJob) throw new Error("已有上架任务正在运行，请等待它完成");
  const preview = previews.get(String(body.previewId || ""));
  if (!preview || Date.now() - preview.createdAt > PREVIEW_TTL_MS) {
    throw new Error("预览已过期，请重新扫描后再出售");
  }
  if (body.confirmToken !== preview.confirmToken) {
    throw new Error("出售确认无效，请重新扫描");
  }
  const session = await getSession();
  if (!session || session.steamId !== preview.steamId) {
    throw new Error("Steam 登录已失效或账号已切换");
  }
  // A preview is created only after the wallet has been detected. Reuse that
  // immutable snapshot so clicking Sell never waits on another market-page GET.
  const wallet = preview.wallet || walletCache?.value || await getWalletInfo();
  const currency = currencyMetadata(wallet);
  const marketLowestMode = body.priceMode === "market_lowest";
  const marketHighestBuyMode = body.priceMode === "market_highest_buy";
  const automaticMarketMode = marketLowestMode || marketHighestBuyMode;
  if (automaticMarketMode) {
    if (!preview.items.length || preview.items.some((item) => !item.isTradingCard)) {
      throw new Error("市场自动定价仅支持 Steam 集换式卡牌");
    }
    const expectedCardPriceMode = marketHighestBuyMode ? "highest_buy" : "lowest";
    if (preview.cardPriceMode !== expectedCardPriceMode) {
      throw new Error("价格模式与扫描结果不一致，请重新扫描集换式卡牌");
    }
    const maximumPriceAge = marketHighestBuyMode ? 30_000 : 60_000;
    if (
      !preview.marketPriceTime
      || Date.now() - preview.marketPriceTime > maximumPriceAge
    ) {
      throw new Error(
        marketHighestBuyMode
          ? "最高求购价已超过 30 秒，请重新扫描集换式卡牌"
          : "市场最低价已超过 60 秒，请重新扫描集换式卡牌"
      );
    }
  }
  const inputMinor = automaticMarketMode
    ? null
    : parseDisplayPrice(body.price, currency);
  const lots = lotsFromPreview(preview, body.quantity || "all");
  if (!lots.length) throw new Error("没有可出售的匹配物品");
  for (const lot of lots) {
    const fees = marketHighestBuyMode
      ? {
        buyerPays: lot.highestBuyOrderBuyerPrice,
        sellerReceives: lot.highestBuyOrderSellerPrice
      }
      : marketLowestMode
      ? {
        buyerPays: lot.lowestBuyerPrice,
        sellerReceives: lot.lowestSellerPrice
      }
      : body.priceMode === "receive"
        ? buyerPriceForDesiredReceive(inputMinor, wallet, lot.publisherFee)
        : calculateFees(inputMinor, wallet, lot.publisherFee);
    if (fees.sellerReceives <= 0) throw new Error("扣除手续费后实收金额必须大于 0");
    lot.sellerPrice = fees.sellerReceives;
    lot.buyerPrice = fees.buyerPays;
  }
  const total = lots.reduce((sum, item) => sum + item.amount, 0);
  const buyerPrices = lots.map((item) => item.buyerPrice);
  const sellerPrices = lots.map((item) => item.sellerPrice);
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    needsConfirmation: 0,
    pricingMode: marketHighestBuyMode
      ? "market_highest_buy"
      : marketLowestMode
        ? "market_lowest"
        : body.priceMode,
    immediateMatchMode: marketHighestBuyMode,
    buyerPaysFormatted: formatRange(buyerPrices, currency),
    sellerReceivesFormatted: formatRange(sellerPrices, currency),
    results: []
  };
  jobs.set(jobId, job);
  previews.delete(preview.id);
  setImmediate(() => runSellJob(job, preview, lots).catch((error) => {
    job.state = "finished";
    job.fatalError = errorMessage(error);
    job.updatedAt = Date.now();
  }));
  return job;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    jsonResponse(response, 200, { appToken: APP_TOKEN });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    jsonResponse(response, 200, await statusPayload());
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const id = url.pathname.slice("/api/jobs/".length);
    const job = jobs.get(id);
    if (!job) throw new Error("任务不存在或程序已重启");
    jsonResponse(response, 200, job);
    return;
  }

  assertLocalMutation(request);
  if (request.method === "POST" && url.pathname === "/api/login") {
    if (STEAM_CLIENT_MODE) throw new Error("当前模式直接使用 Steam 客户端登录状态");
    await openLogin();
    jsonResponse(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login/finish") {
    if (STEAM_CLIENT_MODE) throw new Error("当前模式不提供独立登录功能");
    jsonResponse(response, 200, { loggedIn: await finishLoginIfPossible() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    if (STEAM_CLIENT_MODE) throw new Error("不能从本工具退出 Steam 客户端账号");
    await browserContext.clearCookies();
    walletCache = null;
    previews.clear();
    jsonResponse(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/shutdown") {
    jsonResponse(response, 200, { ok: true });
    setImmediate(async () => {
      if (!STEAM_CLIENT_MODE) await browserContext?.close().catch(() => {});
      server?.close();
      process.exit(0);
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/preview") {
    jsonResponse(response, 200, await createPreview(await readJsonBody(request)));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/quote") {
    const body = await readJsonBody(request);
    const wallet = await getWalletInfo();
    const currency = currencyMetadata(wallet);
    const input = parseDisplayPrice(body.price, currency);
    const preview = previews.get(String(body.previewId || ""));
    const publisherFees = preview?.items?.length
      ? [...new Set(preview.items.map((item) => item.publisherFee))]
      : [null];
    const quotes = publisherFees.map((publisherFee) => (
      body.priceMode === "receive"
        ? buyerPriceForDesiredReceive(input, wallet, publisherFee)
        : calculateFees(input, wallet, publisherFee)
    ));
    jsonResponse(response, 200, {
      buyerPays: formatRange(quotes.map((quote) => quote.buyerPays), currency),
      sellerReceives: formatRange(quotes.map((quote) => quote.sellerReceives), currency),
      fees: formatRange(
        quotes.map((quote) => quote.buyerPays - quote.sellerReceives),
        currency
      )
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sell") {
    const startedAt = Date.now();
    const job = await createSellJob(await readJsonBody(request));
    job.creationMs = Date.now() - startedAt;
    if (job.creationMs > 1000) {
      console.warn(`创建上架任务耗时 ${job.creationMs}ms`);
    }
    jsonResponse(response, 202, job);
    return;
  }
  jsonResponse(response, 404, { error: "接口不存在" });
}

async function requestHandler(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else if (request.method === "GET") {
      serveStatic(response, url.pathname);
    } else {
      jsonResponse(response, 405, { error: "不支持的请求方法" });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}]`, error);
    jsonResponse(response, 400, { error: errorMessage(error) });
  }
}

function findBrowserExecutable() {
  const candidates = [
    process.env.EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function connectToSteamClient() {
  if (remoteBrowser?.isConnected() && browserContext) return browserContext;
  try {
    remoteBrowser = await chromium.connectOverCDP(
      `http://127.0.0.1:${STEAM_CDP_PORT}`,
      { timeout: 5000 }
    );
  } catch {
    throw new Error("无法连接 Steam 客户端；请确认 Steam 正在运行并保持登录");
  }
  browserContext = remoteBrowser.contexts()[0];
  if (!browserContext) {
    remoteBrowser = null;
    throw new Error("Steam 客户端没有可用的网页会话");
  }
  remoteBrowser.on("disconnected", () => {
    remoteBrowser = null;
    browserContext = null;
  });
  return browserContext;
}

async function getSteamClientPage() {
  await connectToSteamClient();
  const page = browserContext.pages().find(
    (candidate) => !candidate.isClosed()
      && /^https:\/\/steamcommunity\.com(?:\/|$)/i.test(candidate.url())
  );
  if (!page) {
    throw new Error("请先在 Steam 客户端中打开“社区市场”或“库存”页面");
  }
  return page;
}

async function steamClientFetch(url, options = {}) {
  const page = await getSteamClientPage();
  try {
    return await page.evaluate(async ({ requestUrl, method, form, timeoutMs }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const requestOptions = {
        method,
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      };
      if (form) {
        requestOptions.headers = {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        };
        requestOptions.body = new URLSearchParams(form).toString();
      }
      try {
        const response = await fetch(requestUrl, requestOptions);
        return {
          ok: response.ok,
          status: response.status,
          text: await response.text()
        };
      } catch (error) {
        if (error?.name === "AbortError") {
          return { ok: false, status: 408, text: "Steam 请求超时" };
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }, {
      requestUrl: url,
      method: options.method || "GET",
      form: options.form || null,
      timeoutMs: Number(options.timeoutMs || 15_000)
    });
  } catch (error) {
    if (/closed|destroyed|Target/i.test(errorMessage(error))) {
      throw new Error("Steam 社区页面已关闭，请重新打开市场或库存页面");
    }
    throw error;
  }
}

async function createBrowserContext(headless) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: browserExecutable,
    headless,
    viewport: null,
    locale: "zh-CN",
    acceptDownloads: false,
    args: [
      "--start-maximized",
      "--disable-features=msEdgeFirstRunExperience,OverscrollHistoryNavigation",
      "--no-default-browser-check"
    ]
  });
  context.on("close", () => {
    if (browserContext === context) {
      browserContext = null;
      loginPage = null;
    }
    if (!NATIVE_MODE && !process.env.STEAM_QUICK_SELL_AUTOCLOSE_MS) {
      server?.close();
      process.exit(0);
    }
  });
  return context;
}

async function replaceBrowserContext(headless) {
  const previous = browserContext;
  browserContext = null;
  loginPage = null;
  appPage = null;
  if (previous) await previous.close().catch(() => {});
  browserContext = await createBrowserContext(headless);
  return browserContext;
}

async function start() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      if (!response.headersSent) jsonResponse(response, 500, { error: errorMessage(error) });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  if (STEAM_CLIENT_MODE) {
    await connectToSteamClient().catch((error) => {
      console.warn(errorMessage(error));
    });
    console.log(`Steam 客户端直连后台已启动：http://${HOST}:${PORT}`);
    return;
  }
  browserExecutable = findBrowserExecutable();
  if (!browserExecutable) {
    throw new Error("未找到 Microsoft Edge 或 Google Chrome");
  }
  browserContext = await createBrowserContext(
    NATIVE_MODE || process.env.STEAM_QUICK_SELL_HEADLESS === "1"
  );
  if (NATIVE_MODE) {
    console.log(`Steam 一键出售后台已启动：http://${HOST}:${PORT}`);
    return;
  }
  appPage = browserContext.pages()[0] || await browserContext.newPage();
  await appPage.goto(`http://${HOST}:${PORT}`, { waitUntil: "domcontentloaded" });
  console.log(`Steam 一键出售已启动：http://${HOST}:${PORT}`);
  if (process.env.STEAM_QUICK_SELL_SCREENSHOT) {
    await appPage.screenshot({
      path: path.resolve(process.env.STEAM_QUICK_SELL_SCREENSHOT),
      fullPage: true
    });
  }
  const autoCloseMs = Number(process.env.STEAM_QUICK_SELL_AUTOCLOSE_MS || 0);
  if (autoCloseMs > 0) {
    setTimeout(async () => {
      await browserContext?.close().catch(() => {});
      server?.close(() => process.exit(0));
    }, autoCloseMs);
  }
}

process.on("SIGINT", async () => {
  if (!STEAM_CLIENT_MODE) await browserContext?.close().catch(() => {});
  server?.close();
  process.exit(0);
});

start().catch((error) => {
  console.error("启动失败：", errorMessage(error));
  process.exitCode = 1;
});
