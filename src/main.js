"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  activeListingAssetKeys,
  buyerPriceForDesiredReceive,
  capMatchesToHighestBuyDemand,
  calculateFees,
  classifySellFailure,
  currencyMetadata,
  extractMarketItemNameId,
  formatMinor,
  highestBuyOrderFromListingHtml,
  highestBuyOrderFromHistogram,
  itemMatches,
  isMarketKey,
  isWeaponCase,
  marketAssetKey,
  marketListingKey,
  marketListingUrl,
  normalizeInventoryCategory,
  normalizeMarketPriceMode,
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
const SELL_RETRY_DELAYS_MS = [2000, 5000];
const SCAN_CONCURRENCY = Math.min(
  6,
  Math.max(1, Number(process.env.STEAM_SCAN_CONCURRENCY || 4))
);
const MARKET_PRICE_CONCURRENCY = 3;
const configuredHighestBuyTimeoutMs = Number(
  process.env.STEAM_HIGHEST_BUY_SCAN_TIMEOUT_MS || 30_000
);
const HIGHEST_BUY_BATCH_TIMEOUT_MS = Number.isFinite(configuredHighestBuyTimeoutMs)
  ? Math.max(15_000, configuredHighestBuyTimeoutMs)
  : 30_000;
const ACTIVE_LISTING_PAGE_SIZE = 100;
const MAX_ACTIVE_LISTING_PAGES = 50;
const ACTIVE_LISTING_TOTAL_TIMEOUT_MS = 10_000;
const SELL_VERIFY_INVENTORY_TIMEOUT_MS = 10_000;
const SELL_VERIFY_CONTEXT_CONCURRENCY = 2;
const SELL_VERIFY_SETTLE_MS = 750;
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
    const result = await steamClientFetch(url, {
      method: "GET",
      timeoutMs: Number(options.timeoutMs || 15_000)
    });
    if (!result.ok) {
      throw new Error(`Steam 返回 HTTP ${result.status}，请稍后重试`);
    }
    return result.text;
  }
  const { timeoutMs, ...requestOptions } = options;
  const response = await browserContext.request.get(url, {
    timeout: Number(timeoutMs || 30_000),
    failOnStatusCode: false,
    ...requestOptions
  });
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`Steam 返回 HTTP ${response.status()}，请稍后重试`);
  }
  return text;
}

async function fetchActiveMarketListingAssetKeys() {
  const keys = new Set();
  const deadline = Date.now() + ACTIVE_LISTING_TOTAL_TIMEOUT_MS;
  let start = 0;
  for (let pageIndex = 0; pageIndex < MAX_ACTIVE_LISTING_PAGES; pageIndex += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("当前市场挂单校验超时，请稍后重试");
    }
    const listingsUrl = new URL("https://steamcommunity.com/market/mylistings");
    listingsUrl.search = new URLSearchParams({
      start: String(start),
      count: String(ACTIVE_LISTING_PAGE_SIZE)
    });
    let payload;
    try {
      payload = JSON.parse(await getText(listingsUrl.href, {
        timeoutMs: Math.max(1, Math.min(7000, remainingMs))
      }));
    } catch (error) {
      throw new Error(`无法读取当前市场挂单：${errorMessage(error)}`);
    }
    if (payload?.success !== true && Number(payload?.success) !== 1) {
      throw new Error("无法读取当前市场挂单，请稍后重试");
    }
    for (const key of activeListingAssetKeys(payload)) keys.add(key);
    const totalCount = Math.max(0, Math.trunc(Number(payload.total_count || 0)));
    const pageSize = Math.max(
      1,
      Math.trunc(Number(payload.pagesize || ACTIVE_LISTING_PAGE_SIZE))
    );
    const currentStart = Math.max(0, Math.trunc(Number(payload.start ?? start)));
    if (currentStart + pageSize >= totalCount) return keys;
    const nextStart = currentStart + pageSize;
    if (nextStart <= start) {
      throw new Error("Steam 市场挂单分页数据无效");
    }
    start = nextStart;
  }
  throw new Error("当前市场挂单数量过多，无法完成安全扫描");
}

function inventoryContextKey(appId, contextId) {
  return `${String(appId)}|${String(contextId)}`;
}

async function fetchCurrentInventoryAssetKeys(steamId, items) {
  const groupsByContext = new Map();
  for (const item of items) {
    const contextKey = inventoryContextKey(item.appId, item.contextId);
    if (!groupsByContext.has(contextKey)) {
      groupsByContext.set(contextKey, {
        contextKey,
        appId: String(item.appId),
        contextId: String(item.contextId),
        targetAssetIds: new Set()
      });
    }
    groupsByContext.get(contextKey).targetAssetIds.add(String(item.assetId));
  }

  const groups = [...groupsByContext.values()];
  const keys = new Set();
  const verifiedContexts = new Set();
  const errors = [];
  const deadline = Date.now() + SELL_VERIFY_INVENTORY_TIMEOUT_MS;
  let nextIndex = 0;

  async function verifyContext() {
    while (true) {
      const groupIndex = nextIndex;
      nextIndex += 1;
      if (groupIndex >= groups.length) return;
      const group = groups[groupIndex];
      let startAssetId = "";
      try {
        for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw new Error("库存核验超时");
          }
          const inventoryUrl = new URL(
            `https://steamcommunity.com/inventory/${steamId}/`
            + `${group.appId}/${group.contextId}`
          );
          inventoryUrl.search = new URLSearchParams({
            l: "schinese",
            count: "2000",
            ...(startAssetId ? { start_assetid: startAssetId } : {})
          });
          const payload = JSON.parse(await getText(inventoryUrl.href, {
            timeoutMs: Math.max(1, Math.min(7000, remainingMs))
          }));
          if (payload?.success !== true && Number(payload?.success) !== 1) {
            throw new Error("Steam 返回了无效库存数据");
          }
          for (const asset of payload.assets || []) {
            const assetId = String(asset.assetid || asset.id || "");
            if (group.targetAssetIds.has(assetId)) {
              keys.add(
                marketAssetKey(group.appId, group.contextId, assetId)
              );
            }
          }
          if (
            [...group.targetAssetIds].every((assetId) => (
              keys.has(marketAssetKey(group.appId, group.contextId, assetId))
            ))
            || !(
              payload.more_items === true
              || Number(payload.more_items) === 1
            )
          ) {
            verifiedContexts.add(group.contextKey);
            break;
          }
          const nextAssetId = String(payload.last_assetid || "");
          if (!nextAssetId || nextAssetId === startAssetId) {
            throw new Error("Steam 库存分页数据无效");
          }
          startAssetId = nextAssetId;
          if (pageIndex === 49) {
            throw new Error("库存物品过多，无法完成安全核验");
          }
        }
      } catch (error) {
        errors.push(`${group.contextKey}: ${errorMessage(error)}`);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SELL_VERIFY_CONTEXT_CONCURRENCY, groups.length) },
      () => verifyContext()
    )
  );
  return { keys, verifiedContexts, errors };
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
  const category = normalizeInventoryCategory(options.category) || "specific";
  const targetContexts = category === "trading_card"
    ? contexts.filter((context) => context.appId === "753" && context.contextId === "6")
    : category === "weapon_case"
      ? contexts.filter((context) => context.appId === "730" && context.contextId === "2")
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
            const weaponCase = isWeaponCase(
              description,
              asset.appid || context.appId,
              asset.contextid || context.contextId
            );
            const marketKey = isMarketKey(description);
            const categoryMatches = category === "all"
              || (category === "trading_card" && tradingCard)
              || (category === "weapon_case" && weaponCase)
              || (category === "key" && marketKey)
              || (category === "specific" && itemMatches(description, query, mode));
            if (!categoryMatches) continue;
            if (
              category !== "all"
              && category !== "specific"
              && query
              && !itemMatches(description, query, mode)
            ) {
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
              isWeaponCase: weaponCase,
              isMarketKey: marketKey,
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
    const key = marketListingKey(item.appId, item.marketHashName);
    const current = grouped.get(key) || {
      appId: item.appId,
      appName: item.appName,
      name: item.name,
      marketHashName: item.marketHashName,
      count: 0,
      iconUrl: item.iconUrl,
      isTradingCard: item.isTradingCard,
      isWeaponCase: item.isWeaponCase,
      isMarketKey: item.isMarketKey,
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

async function fetchLowestMarketBuyerPrice(
  appId,
  marketHashName,
  currencyId,
  deadline = Number.POSITIVE_INFINITY
) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("市场最低价读取超时");
    const requestTimeoutMs = Math.max(1, Math.min(15_000, remainingMs));
    const page = await getSteamClientPage();
    const result = await page.evaluate(async ({
      itemAppId,
      itemName,
      walletCurrency,
      timeoutMs
    }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const searchUrl = new URL("https://steamcommunity.com/market/search/render/");
        searchUrl.search = new URLSearchParams({
          query: itemName,
          start: "0",
          count: "100",
          search_descriptions: "0",
          sort_column: "price",
          sort_dir: "asc",
          appid: String(itemAppId),
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
          appid: String(itemAppId),
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
    }, {
      itemAppId: String(appId),
      itemName: marketHashName,
      walletCurrency: currencyId,
      timeoutMs: requestTimeoutMs
    });
    if (result.buyerPrice > 0) return result;
    lastError = new Error(result.error || `Steam 返回 HTTP ${result.status}`);
    if (result.status !== 408 && result.status !== 429 && result.status < 500) break;
    const retryWaitMs = Math.min(
      1200 * (attempt + 1),
      Math.max(0, deadline - Date.now())
    );
    if (retryWaitMs <= 0) break;
    await sleep(retryWaitMs);
  }
  throw lastError || new Error("无法读取市场最低价");
}

async function populateLowestMarketPrices(items, wallet) {
  const currency = currencyMetadata(wallet);
  const uniqueItems = new Map();
  for (const item of items) {
    const key = marketListingKey(item.appId, item.marketHashName);
    if (!uniqueItems.has(key)) {
      uniqueItems.set(key, {
        appId: item.appId,
        marketHashName: item.marketHashName,
        items: []
      });
    }
    uniqueItems.get(key).items.push(item);
  }
  const entries = [...uniqueItems.values()];
  const errors = [];
  let nextIndex = 0;

  async function priceWorker(workerIndex) {
    if (workerIndex > 0) await sleep(workerIndex * 180);
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const { appId, marketHashName, items: matchingItems } = entries[index];
      try {
        const result = await fetchLowestMarketBuyerPrice(
          appId,
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

async function fetchHighestMarketBuyOrder(
  appId,
  marketHashName,
  wallet,
  deadline = Number.POSITIVE_INFINITY
) {
  let lastError;
  const cacheKey = marketListingKey(appId, marketHashName);
  let cachedItemNameId = marketItemNameIdCache.get(cacheKey) || null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("最高求购价读取超时");
    }
    const requestTimeoutMs = Math.max(1000, Math.min(15_000, remainingMs));
    try {
      if (!cachedItemNameId) {
        const listingUrl = new URL(marketListingUrl(appId, marketHashName));
        listingUrl.searchParams.set("l", "english");
        const listingHtml = await getText(listingUrl.href, {
          timeoutMs: requestTimeoutMs
        });
        const renderedOrder = highestBuyOrderFromListingHtml(
          listingHtml,
          currencyMetadata(wallet)
        );
        if (renderedOrder) return renderedOrder;
        cachedItemNameId = extractMarketItemNameId(listingHtml);
        if (!cachedItemNameId) {
          throw new Error("无法识别市场求购数据编号");
        }
        marketItemNameIdCache.set(cacheKey, cachedItemNameId);
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
      const histogram = JSON.parse(await getText(histogramUrl.href, {
        timeoutMs: Math.max(1000, Math.min(15_000, deadline - Date.now()))
      }));
      const order = highestBuyOrderFromHistogram(histogram);
      if (!order) throw new Error("当前没有有效的市场求购单");
      return { itemNameId: cachedItemNameId, ...order };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (!/429|请求超时|HTTP 5\d\d|closed|destroyed|Target/i.test(lastError.message)) {
      break;
    }
    const retryWaitMs = Math.min(
      1800 * (attempt + 1),
      Math.max(0, deadline - Date.now())
    );
    if (retryWaitMs <= 0) break;
    await sleep(retryWaitMs);
  }
  throw lastError || new Error("无法读取市场最高求购价");
}

async function populateHighestMarketBuyOrders(items, wallet) {
  const currency = currencyMetadata(wallet);
  const uniqueItems = new Map();
  for (const item of items) {
    const key = marketListingKey(item.appId, item.marketHashName);
    if (!uniqueItems.has(key)) {
      uniqueItems.set(key, {
        appId: item.appId,
        marketHashName: item.marketHashName,
        items: []
      });
    }
    uniqueItems.get(key).items.push(item);
  }
  const entries = [...uniqueItems.values()];
  const errors = [];
  const deadline = Date.now() + HIGHEST_BUY_BATCH_TIMEOUT_MS;
  let nextIndex = 0;
  let processedEntries = 0;
  let timedOut = false;

  async function priceWorker(workerIndex) {
    if (workerIndex > 0) await sleep(workerIndex * 250);
    while (true) {
      if (Date.now() >= deadline) {
        timedOut = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const { appId, marketHashName, items: matchingItems } = entries[index];
      try {
        const result = await fetchHighestMarketBuyOrder(
          appId,
          marketHashName,
          wallet,
          deadline
        );
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
      } finally {
        processedEntries += 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MARKET_PRICE_CONCURRENCY, entries.length) },
      (_unused, index) => priceWorker(index)
    )
  );
  if (timedOut && processedEntries < entries.length) {
    errors.push(
      `最高求购价读取超过 ${Math.round(HIGHEST_BUY_BATCH_TIMEOUT_MS / 1000)} 秒，`
      + `已跳过剩余 ${entries.length - processedEntries} 种商品`
    );
  }
  return errors;
}

async function createPreview(body) {
  const session = await getSession();
  if (!session) throw new Error("Steam 登录已失效，请重新登录");
  const legacyTradingCardsOnly = body.tradingCardsOnly === true;
  const legacyWeaponCasesOnly = body.weaponCasesOnly === true;
  if (legacyTradingCardsOnly && legacyWeaponCasesOnly) {
    throw new Error("库存分类条件无效");
  }
  const category = legacyTradingCardsOnly
    ? "trading_card"
    : legacyWeaponCasesOnly
      ? "weapon_case"
      : normalizeInventoryCategory(body.category) || "specific";
  const categoryNames = {
    all: "全部可售商品",
    weapon_case: "武器箱",
    key: "钥匙",
    trading_card: "集换式卡牌",
    specific: "特定商品"
  };
  const query = category === "all" ? "" : String(body.name || "").trim();
  if (query.length > 160 || (category === "specific" && !query)) {
    throw new Error("请输入有效的物品名称");
  }
  const legacyPriceMode = legacyTradingCardsOnly
    ? body.cardPriceMode || "lowest"
    : legacyWeaponCasesOnly
      ? body.casePriceMode || "lowest"
      : body.itemPriceMode;
  const marketPriceMode = normalizeMarketPriceMode(
    body.marketPriceMode || legacyPriceMode
  );
  const mode = body.mode === "contains" ? "contains" : "exact";
  const scan = await scanMatches(
    session.steamId,
    query,
    mode,
    { category }
  );
  const totalFound = scan.matches.reduce((sum, item) => sum + item.amount, 0);
  const candidates = [];
  let candidateUnits = 0;
  for (const item of scan.matches) {
    if (candidateUnits >= MAX_MATCHED_UNITS) break;
    const amount = Math.min(item.amount, MAX_MATCHED_UNITS - candidateUnits);
    candidates.push({ ...item, amount });
    candidateUnits += amount;
  }
  let priceErrors = [];
  let wallet = walletCache?.value || null;
  if (marketPriceMode && candidates.length) {
    wallet = wallet || await getWalletInfo();
    priceErrors = marketPriceMode === "highest_buy"
      ? await populateHighestMarketBuyOrders(candidates, wallet)
      : await populateLowestMarketPrices(candidates, wallet);
  }
  const usableMatches = marketPriceMode === "highest_buy"
    ? capMatchesToHighestBuyDemand(candidates)
    : marketPriceMode === "lowest"
      ? candidates.filter((item) => item.lowestSellerPrice > 0)
      : candidates;
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
    category,
    categoryName: categoryNames[category],
    marketPriceMode,
    marketPriceTime: marketPriceMode ? Date.now() : null,
    wallet: wallet || walletCache?.value || null,
    items: kept
  });
  const currency = wallet ? currencyMetadata(wallet) : null;
  const marketBuyerPrices = kept
    .map((item) => (
      marketPriceMode === "highest_buy"
        ? item.highestBuyOrderBuyerPrice
        : item.lowestBuyerPrice
    ))
    .filter((value) => value > 0);
  const marketSellerPrices = kept
    .map((item) => (
      marketPriceMode === "highest_buy"
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
    category,
    categoryName: categoryNames[category],
    tradingCardsOnly: category === "trading_card",
    weaponCasesOnly: category === "weapon_case",
    keysOnly: category === "key",
    marketPriceMode,
    totalFound,
    usableCount: unitsKept,
    truncated: totalFound > candidateUnits || usableBeforeLimit > unitsKept,
    demandLimited: marketPriceMode === "highest_buy" && candidateUnits > usableBeforeLimit,
    groups: groupMatches(kept),
    marketBuyerPriceFormatted,
    marketSellerPriceFormatted,
    lowestBuyerPriceFormatted: marketPriceMode === "lowest"
      ? marketBuyerPriceFormatted
      : null,
    lowestSellerPriceFormatted: marketPriceMode === "lowest"
      ? marketSellerPriceFormatted
      : null,
    highestBuyOrderFormatted: marketPriceMode === "highest_buy"
      ? marketBuyerPriceFormatted
      : null,
    highestBuyOrderSellerFormatted: marketPriceMode === "highest_buy"
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

function listingFailure(status, message, transportError = false) {
  return {
    ok: false,
    status: Number(status || 0),
    message: String(message || "未知错误"),
    ...classifySellFailure(status, message, { transportError })
  };
}

async function postListingAttempt(session, item, sellerPrice, beforeAttempt) {
  await beforeAttempt();
  try {
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
          listingId: data.listingid || null
        };
      }
      const message = String(data.message || data.error || `HTTP ${result.status}`);
      return listingFailure(result.status, message);
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
        status: response.status()
      };
    }
    const message = data.message || data.error || `HTTP ${response.status()}`;
    return listingFailure(response.status(), message);
  } catch (error) {
    return listingFailure(0, errorMessage(error), true);
  }
}

async function runSellJob(job, preview, lots) {
  job.state = "preparing";
  job.phase = "validating_session";
  job.statusText = "正在校验 Steam 登录状态…";
  job.updatedAt = Date.now();
  const session = await getSession();
  if (!session || session.steamId !== preview.steamId) {
    throw new Error("Steam 登录已失效或账号已切换，任务未开始");
  }

  job.phase = "validating_listings";
  job.statusText = "正在检查当前市场挂单…";
  job.updatedAt = Date.now();
  const activeListingKeys = await fetchActiveMarketListingAssetKeys();
  const alreadyListedCount = lots.reduce(
    (sum, lot) => (
      activeListingKeys.has(marketAssetKey(lot.appId, lot.contextId, lot.assetId))
        ? sum + lot.amount
        : sum
    ),
    0
  );
  if (alreadyListedCount > 0) {
    throw new Error(
      `所选物品中有 ${alreadyListedCount} 件已在 Steam 市场挂单，`
      + "请重新扫描库存后再出售"
    );
  }

  const maximumPriceAge = job.immediateMatchMode
    ? 30_000
    : job.pricingMode === "market_lowest"
      ? 60_000
      : null;
  if (
    maximumPriceAge
    && (
      !preview.marketPriceTime
      || Date.now() - preview.marketPriceTime > maximumPriceAge
    )
  ) {
    throw new Error(
      job.immediateMatchMode
        ? "挂单校验完成时最高求购价已超过 30 秒，请重新扫描物品价格"
        : "挂单校验完成时市场最低价已超过 60 秒，请重新扫描物品价格"
    );
  }

  job.state = "running";
  job.phase = "listing";
  job.listingStarted = true;
  const workerCount = Math.min(SELL_CONCURRENCY, lots.length);
  job.initialConcurrency = workerCount;
  job.concurrency = workerCount;
  job.transientRetries = 0;
  job.transientFailures = 0;
  job.retryQueued = 0;
  job.retryRound = 0;
  job.verifiedSucceeded = 0;
  job.marketPricesRefreshed = 0;
  job.stabilityMode = false;
  job.statusText = `正在 ${workerCount} 路并行上架…`;
  job.updatedAt = Date.now();
  const records = lots.map((item) => ({
    item,
    attempts: 0,
    finalized: false,
    lastResult: null
  }));
  const maximumAttempts = 1 + SELL_RETRY_DELAYS_MS.length;
  const wallet = preview.wallet || walletCache?.value;
  const currency = currencyMetadata(wallet);
  let nextRequestAt = Date.now();

  async function waitForRequestSlot() {
    const slot = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = slot + SELL_REQUEST_INTERVAL_MS;
    const waitMs = slot - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }

  function appendResult(record, ok, message) {
    job.results.push({
      name: record.item.name,
      amount: record.item.amount,
      assetId: record.item.assetId,
      ok,
      message
    });
    if (job.results.length > 100) job.results.shift();
  }

  function finishSuccess(record, result, verified = false) {
    if (record.finalized) return;
    record.finalized = true;
    job.succeeded += record.item.amount;
    job.completed += record.item.amount;
    if (result.needsConfirmation) {
      job.needsConfirmation += record.item.amount;
    }
    if (verified) job.verifiedSucceeded += record.item.amount;
    const retryText = record.attempts > 1
      ? `（重试 ${record.attempts - 1} 次）`
      : "";
    appendResult(
      record,
      true,
      result.message || (
        result.needsConfirmation
          ? "等待手机或邮箱确认"
          : `已上架${retryText}`
      )
    );
    job.updatedAt = Date.now();
  }

  function finishFailure(record, message) {
    if (record.finalized) return;
    record.finalized = true;
    job.failed += record.item.amount;
    job.completed += record.item.amount;
    appendResult(record, false, message);
    job.updatedAt = Date.now();
  }

  async function attemptRecord(record) {
    const currentSession = await getSession();
    if (!currentSession || currentSession.steamId !== preview.steamId) {
      const message = "Steam 登录已失效或账号已切换，任务已停止";
      job.fatalError = message;
      finishFailure(record, message);
      return false;
    }
    if (record.attempts > 0) job.transientRetries += 1;
    record.attempts += 1;
    const result = await postListingAttempt(
      currentSession,
      record.item,
      record.item.sellerPrice,
      waitForRequestSlot
    );
    record.lastResult = result;
    if (result.ok) {
      finishSuccess(record, result);
      return false;
    }
    if (result.fatal) {
      job.fatalError = result.message;
      finishFailure(record, result.message);
      return false;
    }
    if (result.retryable) {
      job.transientFailures += 1;
      if (
        (result.status === 429 || job.transientFailures >= 2)
        && !job.stabilityMode
      ) {
        job.stabilityMode = true;
        job.concurrency = 1;
        job.statusText = "检测到 Steam 限流或临时故障，正在稳定处理剩余物品…";
      }
      if (result.requiresVerification || record.attempts < maximumAttempts) {
        return true;
      }
    }
    finishFailure(record, result.message);
    return false;
  }

  async function runAttemptBatch(batch, concurrency, adaptive = false) {
    const retryQueue = [];
    let nextIndex = 0;

    async function worker(workerIndex) {
      if (workerIndex > 0) {
        await sleep(workerIndex * SELL_REQUEST_INTERVAL_MS);
      }
      while (!job.fatalError) {
        if (adaptive && job.stabilityMode && workerIndex > 0) return;
        const recordIndex = nextIndex;
        nextIndex += 1;
        if (recordIndex >= batch.length) return;
        const record = batch[recordIndex];
        if (record.finalized) continue;
        if (await attemptRecord(record)) retryQueue.push(record);
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, batch.length) },
        (_unused, index) => worker(index)
      )
    );
    return retryQueue;
  }

  async function verifyUncertainResults(retryQueue) {
    const uncertain = retryQueue.filter(
      (record) => record.lastResult?.requiresVerification
    );
    if (!uncertain.length) return retryQueue;

    job.phase = "verifying_failures";
    job.statusText = `正在核验 ${uncertain.length} 件结果不确定的物品…`;
    job.updatedAt = Date.now();
    await sleep(SELL_VERIFY_SETTLE_MS);
    const [listingResult, inventoryResult] = await Promise.allSettled([
      fetchActiveMarketListingAssetKeys(),
      fetchCurrentInventoryAssetKeys(
        preview.steamId,
        uncertain.map((record) => record.item)
      )
    ]);
    const activeKeys = listingResult.status === "fulfilled"
      ? listingResult.value
      : null;
    const inventory = inventoryResult.status === "fulfilled"
      ? inventoryResult.value
      : { keys: new Set(), verifiedContexts: new Set(), errors: [] };
    const readyToRetry = retryQueue.filter(
      (record) => !record.lastResult?.requiresVerification
    );

    for (const record of uncertain) {
      const item = record.item;
      const assetKey = marketAssetKey(item.appId, item.contextId, item.assetId);
      const contextKey = inventoryContextKey(item.appId, item.contextId);
      if (activeKeys?.has(assetKey)) {
        finishSuccess(
          record,
          { message: "已在市场挂单（核验确认，未重复提交）" },
          true
        );
      } else if (inventory.verifiedContexts.has(contextKey)) {
        if (inventory.keys.has(assetKey)) {
          readyToRetry.push(record);
        } else {
          finishSuccess(
            record,
            { message: "物品已离开库存（核验确认，未重复提交）" },
            true
          );
        }
      } else {
        finishFailure(
          record,
          `上次请求结果无法确认，为避免重复上架未自动重试：`
          + `${record.lastResult?.message || "未知错误"}`
        );
      }
    }
    return readyToRetry;
  }

  async function refreshRetryPrices(retryQueue) {
    if (
      !retryQueue.length
      || (
        job.pricingMode !== "market_highest_buy"
        && job.pricingMode !== "market_lowest"
      )
    ) {
      return retryQueue;
    }

    job.phase = "refreshing_retry_prices";
    job.statusText = `正在刷新 ${retryQueue.length} 件待重试物品的市场价格…`;
    job.updatedAt = Date.now();
    const grouped = new Map();
    for (const record of retryQueue) {
      const key = marketListingKey(
        record.item.appId,
        record.item.marketHashName
      );
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(record);
    }
    const entries = [...grouped.values()];
    const ready = [];
    const deadline = Date.now() + 15_000;
    let nextIndex = 0;

    async function priceWorker() {
      while (true) {
        const entryIndex = nextIndex;
        nextIndex += 1;
        if (entryIndex >= entries.length) return;
        const matchingRecords = entries[entryIndex];
        const sample = matchingRecords[0].item;
        try {
          if (job.pricingMode === "market_highest_buy") {
            const price = await fetchHighestMarketBuyOrder(
              sample.appId,
              sample.marketHashName,
              wallet,
              deadline
            );
            let remainingDemand = price.quantity;
            for (const record of matchingRecords) {
              if (record.item.amount > remainingDemand) {
                finishFailure(
                  record,
                  "当前最高求购数量不足，未继续重试"
                );
                continue;
              }
              const quote = calculateFees(
                price.buyerPrice,
                wallet,
                record.item.publisherFee
              );
              if (quote.sellerReceives <= 0) {
                finishFailure(record, "刷新后的最高求购价不足以支付市场手续费");
                continue;
              }
              record.item.buyerPrice = quote.buyerPays;
              record.item.sellerPrice = quote.sellerReceives;
              remainingDemand -= record.item.amount;
              ready.push(record);
              job.marketPricesRefreshed += record.item.amount;
            }
          } else {
            const price = await fetchLowestMarketBuyerPrice(
              sample.appId,
              sample.marketHashName,
              currency.id,
              deadline
            );
            for (const record of matchingRecords) {
              const quote = calculateFees(
                price.buyerPrice,
                wallet,
                record.item.publisherFee
              );
              if (quote.sellerReceives <= 0) {
                finishFailure(record, "刷新后的市场最低价不足以支付市场手续费");
                continue;
              }
              record.item.buyerPrice = quote.buyerPays;
              record.item.sellerPrice = quote.sellerReceives;
              ready.push(record);
              job.marketPricesRefreshed += record.item.amount;
            }
          }
        } catch (error) {
          for (const record of matchingRecords) {
            finishFailure(
              record,
              `重试前刷新市场价格失败：${errorMessage(error)}`
            );
          }
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(MARKET_PRICE_CONCURRENCY, entries.length) },
        () => priceWorker()
      )
    );
    job.buyerPaysFormatted = formatRange(
      lots.map((item) => item.buyerPrice),
      currency
    );
    job.sellerReceivesFormatted = formatRange(
      lots.map((item) => item.sellerPrice),
      currency
    );
    return ready;
  }

  let retryQueue = await runAttemptBatch(records, workerCount, true);
  for (
    let retryIndex = 0;
    retryIndex < SELL_RETRY_DELAYS_MS.length && retryQueue.length;
    retryIndex += 1
  ) {
    if (job.fatalError) break;
    retryQueue = await verifyUncertainResults(retryQueue);
    if (!retryQueue.length) break;
    job.retryQueued = retryQueue.reduce(
      (sum, record) => sum + record.item.amount,
      0
    );
    job.retryRound = retryIndex + 1;
    job.phase = "retry_wait";
    const retryDelay = SELL_RETRY_DELAYS_MS[retryIndex];
    job.statusText = (
      `${job.retryQueued} 件物品等待第 ${job.retryRound} 轮稳定重试…`
    );
    job.updatedAt = Date.now();
    await sleep(retryDelay);
    if (job.fatalError) break;
    retryQueue = await refreshRetryPrices(retryQueue);
    if (!retryQueue.length) break;
    job.phase = "retrying";
    job.concurrency = 1;
    job.stabilityMode = true;
    job.statusText = (
      `正在单线程执行第 ${job.retryRound} 轮重试…`
    );
    job.updatedAt = Date.now();
    retryQueue = await runAttemptBatch(retryQueue, 1);
  }

  if (retryQueue.length && !job.fatalError) {
    retryQueue = await verifyUncertainResults(retryQueue);
  }

  if (job.fatalError) {
    for (const record of records) {
      finishFailure(record, job.fatalError);
    }
  } else {
    for (const record of records) {
      if (!record.finalized) {
        finishFailure(
          record,
          record.lastResult?.message || "达到最大重试次数"
        );
      }
    }
  }
  job.retryQueued = 0;
  job.concurrency = 0;
  if (job.completed < job.total) {
    const missing = job.total - job.completed;
    job.failed += missing;
    job.completed = job.total;
  }
  job.state = "finished";
  job.phase = "finished";
  job.statusText = job.failed > 0 ? "任务完成，部分物品上架失败" : "任务完成";
  job.updatedAt = Date.now();
}

async function createSellJob(body) {
  const activeJob = [...jobs.values()].find(
    (job) => (
      job.state === "queued"
      || job.state === "preparing"
      || job.state === "running"
    )
  );
  if (activeJob) throw new Error("已有上架任务正在运行，请等待它完成");
  const preview = previews.get(String(body.previewId || ""));
  if (!preview || Date.now() - preview.createdAt > PREVIEW_TTL_MS) {
    throw new Error("预览已过期，请重新扫描后再出售");
  }
  if (body.confirmToken !== preview.confirmToken) {
    throw new Error("出售确认无效，请重新扫描");
  }
  const marketLowestMode = body.priceMode === "market_lowest";
  const marketHighestBuyMode = body.priceMode === "market_highest_buy";
  const automaticMarketMode = marketLowestMode || marketHighestBuyMode;
  if (automaticMarketMode) {
    if (!preview.items.length) {
      throw new Error("没有取得可用的市场价格，请重新扫描物品");
    }
    const expectedMarketPriceMode = marketHighestBuyMode ? "highest_buy" : "lowest";
    if (preview.marketPriceMode !== expectedMarketPriceMode) {
      throw new Error("价格模式与扫描结果不一致，请重新扫描物品价格");
    }
    const maximumPriceAge = marketHighestBuyMode ? 30_000 : 60_000;
    if (
      !preview.marketPriceTime
      || Date.now() - preview.marketPriceTime > maximumPriceAge
    ) {
      throw new Error(
        marketHighestBuyMode
          ? "最高求购价已超过 30 秒，请重新扫描物品价格"
          : "市场最低价已超过 60 秒，请重新扫描物品价格"
      );
    }
  }
  const wallet = preview.wallet || walletCache?.value;
  if (!wallet) {
    throw new Error("钱包信息已失效，请重新扫描后再出售");
  }
  const currency = currencyMetadata(wallet);
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
    phase: "queued",
    listingStarted: false,
    statusText: "任务已创建，等待后台校验…",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    needsConfirmation: 0,
    transientRetries: 0,
    transientFailures: 0,
    retryQueued: 0,
    retryRound: 0,
    verifiedSucceeded: 0,
    marketPricesRefreshed: 0,
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
    const failedDuringPreflight = !job.listingStarted;
    if (!failedDuringPreflight) {
      const remaining = Math.max(0, job.total - job.completed);
      job.failed += remaining;
      job.completed = job.total;
    }
    job.state = "finished";
    job.phase = "finished";
    job.preflightFailed = failedDuringPreflight;
    job.fatalError = errorMessage(error);
    job.statusText = failedDuringPreflight ? "任务未开始" : "任务异常结束";
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
