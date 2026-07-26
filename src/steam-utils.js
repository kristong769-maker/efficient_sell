"use strict";

const CURRENCY_CODES = {
  1: "USD", 2: "GBP", 3: "EUR", 4: "CHF", 5: "RUB", 6: "PLN",
  7: "BRL", 8: "JPY", 9: "NOK", 10: "IDR", 11: "MYR", 12: "PHP",
  13: "SGD", 14: "THB", 15: "VND", 16: "KRW", 17: "TRY", 18: "UAH",
  19: "MXN", 20: "CAD", 21: "AUD", 22: "NZD", 23: "CNY", 24: "INR",
  25: "CLP", 26: "PEN", 27: "COP", 28: "ZAR", 29: "HKD", 30: "TWD",
  31: "SAR", 32: "AED", 33: "SEK", 34: "ARS", 35: "ILS", 36: "BYN",
  37: "KZT", 38: "KWD", 39: "QAR", 40: "CRC", 41: "UYU", 42: "BGN",
  43: "HRK", 44: "CZK", 45: "DKK", 46: "HUF", 47: "RON"
};

const ZERO_DECIMAL_CURRENCIES = new Set([
  "CLP", "COP", "IDR", "JPY", "KRW", "VND"
]);

function normalizeName(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
}

function itemMatches(description, query, mode = "exact") {
  const needle = normalizeName(query);
  if (!needle) return false;
  const values = [description?.name, description?.market_name, description?.market_hash_name]
    .filter(Boolean)
    .map(normalizeName);
  return mode === "contains"
    ? values.some((value) => value.includes(needle))
    : values.some((value) => value === needle);
}

function isWeaponCase(description, appId, contextId) {
  if (String(appId) !== "730" || String(contextId) !== "2") return false;
  const hasWeaponCaseType = (description?.tags || []).some(
    (tag) => tag.internal_name === "CSGO_Type_WeaponCase"
  );
  if (!hasWeaponCaseType) return false;
  const marketHashName = String(description?.market_hash_name || "").trim();
  return /\bCase(?:\s+\d+)?$/i.test(marketHashName);
}

function isMarketKey(description) {
  const tags = description?.tags || [];
  const hasKeyTag = tags.some((tag) => {
    const internalName = String(tag?.internal_name || "");
    const localizedName = String(tag?.localized_tag_name || "");
    return /(?:^|_)key(?:tag)?(?:_|$)/i.test(internalName)
      || /^(?:key|钥匙)$/i.test(localizedName.trim());
  });
  if (hasKeyTag) return true;

  const names = [
    description?.name,
    description?.market_name,
    description?.market_hash_name
  ].filter(Boolean);
  return names.some((name) => (
    /\bkey(?:\s*#?\d+)?$/i.test(String(name).trim())
    || /钥匙(?:（[^）]*）|\([^)]*\))?$/.test(String(name).trim())
  ));
}

function normalizeInventoryCategory(value) {
  const category = String(value || "");
  return new Set(["all", "weapon_case", "key", "trading_card", "specific"])
    .has(category)
    ? category
    : null;
}

function marketAssetKey(appId, contextId, assetId) {
  return `${String(appId)}|${String(contextId)}|${String(assetId)}`;
}

function activeListingAssetKeys(payload) {
  const keys = new Set();
  for (const [appId, contexts] of Object.entries(payload?.assets || {})) {
    for (const [contextId, assets] of Object.entries(contexts || {})) {
      for (const [assetIdKey, asset] of Object.entries(assets || {})) {
        const assetId = asset?.id || asset?.assetid || assetIdKey;
        if (assetId) keys.add(marketAssetKey(appId, contextId, assetId));
      }
    }
  }
  return keys;
}

function normalizeMarketPriceMode(value) {
  if (value === "lowest" || value === "highest_buy") return value;
  return null;
}

function marketListingKey(appId, marketHashName) {
  return `${String(appId)}|${String(marketHashName)}`;
}

function marketListingUrl(appId, marketHashName) {
  return (
    `https://steamcommunity.com/market/listings/${encodeURIComponent(appId)}/`
    + encodeURIComponent(marketHashName)
  );
}

function capMatchesToHighestBuyDemand(items) {
  const remainingByListing = new Map();
  const kept = [];
  for (const item of items) {
    const key = marketListingKey(item.appId, item.marketHashName);
    if (!remainingByListing.has(key)) {
      remainingByListing.set(
        key,
        Math.max(0, Math.trunc(Number(item.highestBuyOrderQuantity || 0)))
      );
    }
    const remaining = remainingByListing.get(key);
    const amount = Math.min(item.amount, remaining);
    if (amount > 0 && item.highestBuyOrderSellerPrice > 0) {
      kept.push({ ...item, amount });
      remainingByListing.set(key, remaining - amount);
    }
  }
  return kept;
}

function extractBalancedObject(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseEmbeddedJson(source, marker) {
  const text = extractBalancedObject(source, marker);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMarketItemNameId(source) {
  const patterns = [
    /Market_LoadOrderSpread\(\s*(\d+)\s*\)/,
    /item_nameid["']?\s*[:=]\s*["']?(\d+)/i,
    /ItemActivityTicker\.Start\(\s*(\d+)\s*\)/
  ];
  return patterns
    .map((pattern) => String(source || "").match(pattern)?.[1])
    .find(Boolean) || null;
}

function highestBuyOrderFromHistogram(histogram) {
  const buyerPrice = Number(histogram?.highest_buy_order || 0);
  const firstBuyLevel = Array.isArray(histogram?.buy_order_graph)
    ? histogram.buy_order_graph[0]
    : null;
  const quantity = Math.max(
    0,
    Math.trunc(Number(Array.isArray(firstBuyLevel) ? firstBuyLevel[1] : 0))
  );
  if (!histogram?.success || buyerPrice <= 0 || quantity <= 0) return null;
  return {
    buyerPrice,
    quantity,
    formatted: histogram.highest_buy_order_formatted || null
  };
}

function parseFormattedMarketPrice(value, currency) {
  const compact = String(value || "")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/\u00a0/g, " ")
    .trim();
  const numericText = compact.replace(/[^\d.,]/g, "");
  if (!numericText) return 0;
  if (currency.decimals === 0) {
    const whole = Number(numericText.replace(/[^\d]/g, ""));
    return Number.isFinite(whole) ? Math.round(whole * currency.factor) : 0;
  }
  const decimalMatch = numericText.match(/[.,](\d{2})$/);
  let normalized;
  if (decimalMatch) {
    const separatorIndex = numericText.length - decimalMatch[0].length;
    normalized = `${numericText.slice(0, separatorIndex).replace(/[^\d]/g, "")}.${decimalMatch[1]}`;
  } else {
    normalized = numericText.replace(/[^\d]/g, "");
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.round(numeric * currency.factor) : 0;
}

function highestBuyOrderFromListingHtml(source, currency) {
  const match = String(source || "").match(
    /<span[^>]*>\s*<span[^>]*>[^<]+<\/span>\s*requests to buy at\s*<span[^>]*>([^<]+)<\/span>\s*or lower\s*<\/span>\s*<table[^>]*>[\s\S]*?<tbody>\s*<tr>\s*<td>[\s\S]*?<\/td>\s*<td>\s*<span[^>]*>([^<]+)<\/span>/i
  );
  if (!match) return null;
  const buyerPrice = parseFormattedMarketPrice(match[1], currency);
  const quantity = Number(String(match[2]).replace(/[^\d]/g, ""));
  if (buyerPrice <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return null;
  }
  return {
    buyerPrice,
    quantity,
    formatted: match[1].trim()
  };
}

function currencyMetadata(walletInfo) {
  const id = Number(walletInfo?.wallet_currency || 1);
  const code = CURRENCY_CODES[id] || "USD";
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
  // Steam Market keeps IDR and the other zero-display-decimal currencies in
  // hundredths internally even though its UI hides the fractional digits.
  // For example, v_currencyformat(18000, "IDR") renders as Rp 180.
  return { id, code, decimals, factor: 100 };
}

function parseDisplayPrice(value, currency) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error("价格格式不正确");
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("价格必须大于 0");
  }
  const fractionalDigits = normalized.split(".")[1]?.length || 0;
  if (fractionalDigits > currency.decimals) {
    throw new Error(`当前币种最多支持 ${currency.decimals} 位小数`);
  }
  const minor = Math.round(numeric * currency.factor);
  if (Math.abs(minor / currency.factor - numeric) > 1e-8) {
    throw new Error(`当前币种最多支持 ${currency.decimals} 位小数`);
  }
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("价格超出支持范围");
  }
  return minor;
}

function quoteFromSellerReceive(sellerReceives, walletInfo, publisherFeePercent) {
  const amount = Math.max(0, Math.trunc(sellerReceives));
  if (!Number(walletInfo?.wallet_fee)) {
    return { buyerPays: amount, sellerReceives: amount, steamFee: 0, publisherFee: 0 };
  }
  const steamPercent = Number(walletInfo.wallet_fee_percent ?? 0.05);
  const minimum = Number(walletInfo.wallet_fee_minimum ?? 1);
  const base = Number(walletInfo.wallet_fee_base ?? 0);
  const publisherPercent = Number(
    publisherFeePercent ?? walletInfo.wallet_publisher_fee_percent_default ?? 0.10
  );
  const steamFee = Math.floor(Math.max(amount * steamPercent, minimum) + base);
  const publisherFee = publisherPercent > 0
    ? Math.floor(Math.max(amount * publisherPercent, 1))
    : 0;
  return {
    buyerPays: amount + steamFee + publisherFee,
    sellerReceives: amount,
    steamFee,
    publisherFee
  };
}

function calculateFees(desiredBuyerPays, walletInfo, publisherFeePercent) {
  const desired = Math.max(0, Math.trunc(desiredBuyerPays));
  if (!Number(walletInfo?.wallet_fee)) {
    return { buyerPays: desired, sellerReceives: desired, steamFee: 0, publisherFee: 0 };
  }
  const totalRate = 1
    + Number(walletInfo?.wallet_fee_percent ?? 0.05)
    + Number(publisherFeePercent ?? walletInfo?.wallet_publisher_fee_percent_default ?? 0.10);
  let sellerReceives = Math.max(0, Math.floor(desired / totalRate));
  let result = quoteFromSellerReceive(sellerReceives, walletInfo, publisherFeePercent);
  while (sellerReceives > 0 && result.buyerPays > desired) {
    sellerReceives -= 1;
    result = quoteFromSellerReceive(sellerReceives, walletInfo, publisherFeePercent);
  }
  for (let attempts = 0; attempts < 10000; attempts += 1) {
    const next = quoteFromSellerReceive(sellerReceives + 1, walletInfo, publisherFeePercent);
    if (next.buyerPays > desired) break;
    sellerReceives += 1;
    result = next;
  }
  return result;
}

function buyerPriceForDesiredReceive(desiredReceive, walletInfo, publisherFeePercent) {
  const desired = Math.trunc(desiredReceive);
  if (desired <= 0) throw new Error("实收金额必须大于 0");
  return quoteFromSellerReceive(desired, walletInfo, publisherFeePercent);
}

function formatMinor(minor, currency) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency.code,
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals
  }).format(minor / currency.factor);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  activeListingAssetKeys,
  buyerPriceForDesiredReceive,
  capMatchesToHighestBuyDemand,
  calculateFees,
  currencyMetadata,
  extractBalancedObject,
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
  normalizeName,
  normalizeInventoryCategory,
  normalizeMarketPriceMode,
  parseDisplayPrice,
  parseEmbeddedJson,
  parseFormattedMarketPrice,
  quoteFromSellerReceive,
  sleep
};
