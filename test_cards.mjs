// 离线自测：商店页卡片标注（v1.8.0）的价格解析 / 档位判定 / 徽章文案 / 库缓存页数。
// 用例里的文案与档位结构全部照抄真实响应：
//   · 卡片价签    -100% + Free* + <del>¥466.58</del> / From ¥326.59 / ¥326.59
//   · 详情档位    licenses[].priceTier{price, discountedPrice, currencyCode, discountStartDate, discountEndDate}
// 运行：node userscript/test_cards.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = fs.readFileSync(path.join(here, 'epic-fab-claimer.user.js'), 'utf8');

const noop = () => {};
const fakeEl = {
  style: {}, appendChild: noop, addEventListener: noop, remove: noop,
  attachShadow: () => ({ querySelector: () => fakeEl, querySelectorAll: () => [], innerHTML: '', addEventListener: noop, appendChild: noop }),
  getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, bottom: 0 }),
  querySelector: () => null, querySelectorAll: () => [], setAttribute: noop, textContent: '',
};
const sandbox = {
  window: {
    __efcBooted: true,
    GM_getValue: (k, d) => d,
    GM_setValue: noop,
    addEventListener: noop,
    innerHeight: 900,
  },
  document: {
    body: fakeEl, createElement: () => ({ ...fakeEl }), cookie: '',
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, readyState: 'complete',
  },
  location: { hostname: 'www.fab.com', search: '', pathname: '/search', href: 'https://www.fab.com/search' },
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  console, setTimeout, clearTimeout, clearInterval, setInterval: () => 0,
  URLSearchParams, Event,
};
sandbox.window.document = sandbox.document;
sandbox.window.location = sandbox.location;
sandbox.window.setInterval = sandbox.setInterval;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'epic-fab-claimer.user.js' });

const I = sandbox.window.__efcInternals;
if (!I) { console.error('FAIL: 没拿到 __efcInternals'); process.exit(1); }

let bad = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} = ${JSON.stringify(got)}${ok ? '' : `（期望 ${JSON.stringify(want)}）`}`);
};
const checkTrue = (name, cond, detail) => {
  if (!cond) bad++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 1. 卡片价签解析（真实文案）──
check('parseCardPrice(-100% Free* ¥466.58)', I.parseCardPrice('-100% Free* ¥466.58', '¥466.58'),
  { state: 'free', amount: '¥466.58', original: '¥466.58', pct: 100 });
check('parseCardPrice(From ¥326.59)', I.parseCardPrice('From ¥326.59', ''),
  { state: 'from', amount: '¥326.59', original: '', pct: 0 });
check('parseCardPrice(¥326.59)', I.parseCardPrice('¥326.59', ''),
  { state: 'paid', amount: '¥326.59', original: '', pct: 0 });
check('parseCardPrice(免费)', I.parseCardPrice('免费', ''),
  { state: 'free', amount: '', original: '', pct: 0 });
check('parseCardPrice(空文本)', I.parseCardPrice('', ''),
  { state: 'unknown', amount: '', original: '', pct: 0 });
check('parseCardPrice(From $19.99)', I.parseCardPrice('From $19.99'),
  { state: 'from', amount: '$19.99', original: '', pct: 0 });

// ── 2. 金额格式 ──
check('formatMoney(326.59, CNY)', I.formatMoney(326.59, 'CNY'), '¥326.59');
check('formatMoney(49.99, USD)', I.formatMoney(49.99, 'USD'), '$49.99');
check('formatMoney(12, CNY)', I.formatMoney(12, 'CNY'), '¥12');
check('formatMoney(9.5, "")', I.formatMoney(9.5, ''), '9.50');

// ── 3. 详情档位：个人免费 + 专业收钱（真实形状：currencyCode/price/discountedPrice）──
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const personalFreeProPaid = {
  licenses: [
    { name: 'Personal', slug: 'personal', priceTier: { currencyCode: 'CNY', price: 0, discountedPrice: null } },
    { name: 'Professional', slug: 'professional', priceTier: { currencyCode: 'CNY', price: 326.59, discountedPrice: null } },
  ],
};
{
  const s = I.tierSummary(personalFreeProPaid, now);
  checkTrue('tierSummary 专业排第一', s.tiers[0].rank === 0 && s.tiers[0].name === 'Professional',
    s.tiers.map((t) => t.name).join(' > '));
  checkTrue('tierSummary 个人免费/专业收费', s.tiers[1].freeNow === true && s.tiers[0].freeNow === false);
  const b = I.badgeFor({ owned: false, tiers: s.tiers, freeUntil: s.freeUntil }, now);
  check('badgeFor(个人免费·专业收费)', b, { text: '个人免费 · 专业 ¥326.59', tone: 'warn' });
}

// ── 4. 限时免费：3 天后到期 ──
const limitFree = {
  licenses: [{
    name: 'Professional', slug: 'professional',
    priceTier: {
      currencyCode: 'CNY', price: 466.58, discountedPrice: 0, effectiveDiscountPercentage: 100,
      discountStartDate: iso(now - 86400000), discountEndDate: iso(now + 3 * 86400000),
    },
  }],
};
{
  const s = I.tierSummary(limitFree, now);
  checkTrue('tierSummary 限时免费命中窗口', s.tiers[0].freeNow === true && s.freeUntil > now);
  const b = I.badgeFor({ owned: false, tiers: s.tiers, freeUntil: s.freeUntil }, now);
  check('badgeFor(限时免费剩 3 天)', b, { text: '限时免费 · 剩 3 天', tone: 'warn' });
}
// 窗口已过期 → 不能算免费
{
  const expired = { licenses: [{ name: 'Professional', slug: 'professional', priceTier: {
    currencyCode: 'CNY', price: 466.58, discountedPrice: 0,
    discountStartDate: iso(now - 5 * 86400000), discountEndDate: iso(now - 86400000) } }] };
  const s = I.tierSummary(expired, now);
  checkTrue('tierSummary 过期折扣不算免费', s.tiers[0].freeNow === false && s.freeUntil === 0);
  check('badgeFor(过期 → 不加徽章)', I.badgeFor({ owned: false, tiers: s.tiers, freeUntil: s.freeUntil }, now), null);
}

// ── 5. 徽章优先级 ──
{
  const s = I.tierSummary(limitFree, now);
  check('badgeFor(已在库优先)', I.badgeFor({ owned: true, tiers: s.tiers, freeUntil: s.freeUntil }, now),
    { text: '✓ 已在库', tone: 'ok' });
  const allFree = I.tierSummary({ licenses: [
    { name: 'Personal', slug: 'personal', priceTier: { price: 0, currencyCode: 'CNY' } },
  ] }, now);
  check('badgeFor(全免费)', I.badgeFor({ owned: false, tiers: allFree.tiers, freeUntil: 0 }, now),
    { text: '免费', tone: 'ok' });
  check('badgeFor(纯付费 → null)',
    I.badgeFor({ owned: false, tiers: I.tierSummary(personalFreeProPaid, now).tiers.filter((t) => !t.freeNow), freeUntil: 0,
      price: I.parseCardPrice('¥326.59') }, now), null);
}

// ── 5b. 真实陷阱：卡片写 Free*，其实只有 UEFN 参考版免费，个人/专业都要钱 ──
{
  const uefn = { licenses: [
    { name: 'UEFN - Reference only', slug: 'uefn', priceTier: { currencyCode: 'CNY', price: 0 } },
    { name: 'Personal', slug: 'personal', priceTier: { currencyCode: 'CNY', price: 19.93 } },
    { name: 'Professional', slug: 'professional', priceTier: { currencyCode: 'CNY', price: 199.92 } },
  ] };
  const s = I.tierSummary(uefn, now);
  check('badgeFor(卡片写 Free 但档位要钱)',
    I.badgeFor({ owned: false, tiers: s.tiers, freeUntil: s.freeUntil, price: I.parseCardPrice('-100% Free* ¥466.58') }, now),
    { text: '个人 ¥19.93 · 专业 ¥199.92', tone: 'warn' });
}

// ── 6. 库标题匹配：真实库里带 & 与截断的标题 ──
{
  const lib = { set: new Set([
    I.normT('Coffee Table Round'),
    I.normT('Chair & Desk Set Vol 2'),
    I.normT('Modular Post Apocalyptic Desert Environment (Desert City,Desert Village)'),
  ]) };
  checkTrue('libHas 精确命中', I.libHas(lib, 'Coffee Table Round'));
  checkTrue('libHas HTML 实体归一（&amp;）', I.libHas(lib, 'Chair &amp; Desk Set Vol 2'));
  checkTrue('libHas 长标题按前缀命中', I.libHas(lib, 'Modular Post Apocalyptic Desert Environment (Desert City,Deser'));
  checkTrue('libHas 没领过的判否', I.libHas(lib, 'Forest Terrain') === false);
}

// ── 7. 读库页数上限必须跟设置走（曾经硬砍到 40 页）──
{
  const st = { libPages: 64, libCacheHours: 24 };
  let pages = 0;
  sandbox.fetch = async () => {
    pages++;
    return {
      ok: true,
      json: async () => ({
        results: [{ listing: { title: 'T' + pages } }],
        cursors: { next: pages < 64 ? 'c' + pages : '' },
      }),
    };
  };
  const lib = await I.libraryTitleSet(st);
  checkTrue('libraryTitleSet 翻满 64 页', pages === 64 && lib.pages === 64, `实际 ${pages} 页 / ${lib.count} 条`);
  // 设置里给的上限仍然要夹住（防手改成 9999）：这次让游标永远有下一页
  pages = 0;
  sandbox.fetch = async () => {
    pages++;
    return {
      ok: true,
      json: async () => ({ results: [{ listing: { title: 'T' + pages } }], cursors: { next: 'more' } }),
    };
  };
  const lib2 = await I.libraryTitleSet({ libPages: 9999, libCacheHours: 24 });
  checkTrue('libraryTitleSet 上限夹到 200', pages === 200 && lib2.pages === 200, `实际 ${pages} 页`);
}

// ── 8. 库缓存读回来必须再归一化一遍（否则大小写 / &amp; 全被当成「没领过」）──
{
  const orig = sandbox.window.GM_getValue;
  sandbox.window.GM_getValue = (k, d) => (k === 'efc:fab:libcache'
    ? { at: Date.now(), titles: ['Sofa V35 Part7', 'Chair &amp; Desk'] }
    : d);
  const lib = await I.libSnapshot({ libPages: 64, libCacheHours: 24 }, {});
  checkTrue('libSnapshot 读缓存时归一化标题',
    lib.set.has('sofa v35 part7') && lib.set.has('chair & desk') && lib.cached === true,
    Array.from(lib.set).join(' | '));
  sandbox.window.GM_getValue = orig;
}

if (bad) { console.error(`\nCARDS FAIL: ${bad} 项不符`); process.exit(1); }
console.log('\nALL PASS');