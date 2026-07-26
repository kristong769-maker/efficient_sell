"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buyerPriceForDesiredReceive,
  capMatchesToHighestBuyDemand,
  calculateFees,
  currencyMetadata,
  extractMarketItemNameId,
  highestBuyOrderFromListingHtml,
  highestBuyOrderFromHistogram,
  itemMatches,
  isMarketKey,
  isWeaponCase,
  marketListingKey,
  marketListingUrl,
  normalizeInventoryCategory,
  normalizeMarketPriceMode,
  parseDisplayPrice,
  parseEmbeddedJson,
  parseFormattedMarketPrice
} = require("../src/steam-utils");

const wallet = {
  wallet_currency: 23,
  wallet_fee: 1,
  wallet_fee_percent: "0.05",
  wallet_fee_minimum: 1,
  wallet_fee_base: 0,
  wallet_publisher_fee_percent_default: "0.10"
};

test("名称精确匹配忽略大小写和全半角", () => {
  assert.equal(itemMatches({ name: "Ｆｅｖｅｒ Case" }, "fever case", "exact"), true);
  assert.equal(itemMatches({ name: "Fever Case" }, "fever", "exact"), false);
  assert.equal(itemMatches({ name: "Fever Case" }, "fever", "contains"), true);
});

test("只识别 CS2 武器箱并排除其他容器", () => {
  const weaponCaseTag = {
    category: "Type",
    internal_name: "CSGO_Type_WeaponCase"
  };
  assert.equal(
    isWeaponCase(
      { market_hash_name: "Fever Case", tags: [weaponCaseTag] },
      730,
      2
    ),
    true
  );
  assert.equal(
    isWeaponCase(
      { market_hash_name: "CS:GO Weapon Case 2", tags: [weaponCaseTag] },
      "730",
      "2"
    ),
    true
  );
  assert.equal(
    isWeaponCase(
      {
        market_hash_name: "Stockholm 2021 Dust II Souvenir Package",
        tags: [weaponCaseTag]
      },
      730,
      2
    ),
    false
  );
  assert.equal(
    isWeaponCase(
      {
        market_hash_name: "Fever Case",
        tags: [{ category: "Type", internal_name: "CSGO_Type_StickerCapsule" }]
      },
      730,
      2
    ),
    false
  );
  assert.equal(
    isWeaponCase(
      { market_hash_name: "Fever Case", tags: [weaponCaseTag] },
      753,
      6
    ),
    false
  );
});

test("识别带类型标签或标准名称的可售钥匙", () => {
  assert.equal(
    isMarketKey({
      market_hash_name: "CS20 Case Key",
      tags: [{ internal_name: "CSGO_Tool_WeaponCase_KeyTag" }]
    }),
    true
  );
  assert.equal(
    isMarketKey({ market_hash_name: "Mann Co. Supply Crate Key", tags: [] }),
    true
  );
  assert.equal(
    isMarketKey({ name: "武器箱钥匙", tags: [] }),
    true
  );
  assert.equal(
    isMarketKey({ market_hash_name: "Keychain | Lil' Monster", tags: [] }),
    false
  );
  assert.equal(
    isMarketKey({ market_hash_name: "Fever Case", tags: [] }),
    false
  );
});

test("普通物品市场定价模式和跨游戏市场键", () => {
  assert.equal(normalizeInventoryCategory("all"), "all");
  assert.equal(normalizeInventoryCategory("weapon_case"), "weapon_case");
  assert.equal(normalizeInventoryCategory("unknown"), null);
  assert.equal(normalizeMarketPriceMode("lowest"), "lowest");
  assert.equal(normalizeMarketPriceMode("highest_buy"), "highest_buy");
  assert.equal(normalizeMarketPriceMode("custom"), null);
  assert.equal(marketListingKey(730, "Fever Case"), "730|Fever Case");
  assert.equal(
    marketListingUrl(730, "Fever Case | 特殊"),
    "https://steamcommunity.com/market/listings/730/Fever%20Case%20%7C%20%E7%89%B9%E6%AE%8A"
  );
  assert.notEqual(
    marketListingKey(730, "同名物品"),
    marketListingKey(753, "同名物品")
  );
});

test("最高求购数量按游戏和物品分别限制", () => {
  const matches = [
    {
      appId: "730",
      marketHashName: "同名物品",
      amount: 3,
      highestBuyOrderQuantity: 1,
      highestBuyOrderSellerPrice: 100
    },
    {
      appId: "753",
      marketHashName: "同名物品",
      amount: 4,
      highestBuyOrderQuantity: 2,
      highestBuyOrderSellerPrice: 200
    }
  ];
  assert.deepEqual(
    capMatchesToHighestBuyDemand(matches).map((item) => ({
      appId: item.appId,
      amount: item.amount
    })),
    [
      { appId: "730", amount: 1 },
      { appId: "753", amount: 2 }
    ]
  );
});

test("提取 Steam 页面中的嵌入 JSON", () => {
  const source = 'before var g_rgWalletInfo = {"wallet_currency":23,"nested":{"x":"}"}}; after';
  assert.deepEqual(parseEmbeddedJson(source, "g_rgWalletInfo"), {
    wallet_currency: 23,
    nested: { x: "}" }
  });
});

test("提取市场物品编号并读取最高求购档位", () => {
  const html = "<script>Market_LoadOrderSpread( 176955247 );</script>";
  assert.equal(extractMarketItemNameId(html), "176955247");
  assert.deepEqual(
    highestBuyOrderFromHistogram({
      success: 1,
      highest_buy_order: "66700",
      highest_buy_order_formatted: "Rp 667",
      buy_order_graph: [[667, 12, "12 个求购单"], [650, 28, "28 个求购单"]]
    }),
    {
      buyerPrice: 66700,
      quantity: 12,
      formatted: "Rp 667"
    }
  );
  assert.equal(
    highestBuyOrderFromHistogram({
      success: 1,
      highest_buy_order: "0",
      buy_order_graph: []
    }),
    null
  );
});

test("从新版市场页面读取最高求购价和该档数量", () => {
  const idrCurrency = currencyMetadata({ wallet_currency: 10 });
  const html = [
    '<span class="summary"><span>3,481</span> requests to buy at ',
    '<span>Rp 1 587</span> or lower</span>',
    '<table><thead><tr><th>Price</th></tr></thead><tbody>',
    '<tr><td><span>Rp 1 587</span></td><td><span>3</span></td></tr>',
    '</tbody></table>'
  ].join("");
  assert.deepEqual(highestBuyOrderFromListingHtml(html, idrCurrency), {
    buyerPrice: 158700,
    quantity: 3,
    formatted: "Rp 1 587"
  });
  assert.equal(parseFormattedMarketPrice("$0.14", currencyMetadata(wallet)), 14);
  assert.equal(parseFormattedMarketPrice("€1.234,56", currencyMetadata(wallet)), 123456);
});

test("人民币显示价格转换为最小单位", () => {
  const currency = currencyMetadata(wallet);
  assert.equal(parseDisplayPrice("1.23", currency), 123);
  assert.throws(() => parseDisplayPrice("1.234", currency));
});

test("IDR 不显示小数但 Steam 内部仍使用百分之一单位", () => {
  const idrWallet = {
    wallet_currency: 10,
    wallet_fee: 1,
    wallet_fee_percent: "0.05",
    wallet_fee_minimum: "18000",
    wallet_fee_base: "0",
    wallet_publisher_fee_percent_default: "0.10"
  };
  const currency = currencyMetadata(idrWallet);
  assert.equal(currency.decimals, 0);
  assert.equal(currency.factor, 100);
  assert.equal(parseDisplayPrice("18001", currency), 1800100);
  assert.throws(() => parseDisplayPrice("18001.5", currency));

  const fees = calculateFees(1800100, idrWallet);
  assert.equal(fees.buyerPays, 1800100);
  assert.equal(fees.sellerReceives, 1565305);
  assert.equal(fees.steamFee + fees.publisherFee, 234795);
});

test("手续费计算和实收价反算一致", () => {
  const fees = calculateFees(115, wallet);
  assert.deepEqual(fees, {
    buyerPays: 115,
    sellerReceives: 100,
    steamFee: 5,
    publisherFee: 10
  });
  const inverse = buyerPriceForDesiredReceive(100, wallet);
  assert.equal(inverse.buyerPays, 115);
  assert.equal(inverse.sellerReceives, 100);

  const rounded = calculateFees(114, wallet);
  assert.equal(rounded.buyerPays, 112);
  assert.equal(rounded.sellerReceives, 99);
});
