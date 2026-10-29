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

// ── 6. 标题比对：只认完全相等（前缀匹配会误判「已在库」，把免费条目吞掉）──
{
  checkTrue('sameTitle 全等', I.sameTitle('Coffee Table Round', 'Coffee Table Round'));
  checkTrue('sameTitle HTML 实体归一', I.sameTitle('Chair &amp; Desk Set Vol 2', 'Chair & Desk Set Vol 2'));
  checkTrue('sameTitle 前缀不同不算同一条',
    I.sameTitle('Modular Post Apocalyptic Desert Environment (Desert City,Desert Village)',
      'Modular Post Apocalyptic Desert Environment (Desert City,Deser') === false);
  checkTrue('sameTitle 不相干判否', I.sameTitle('Forest Terrain', 'Forest Terrain 2 Extra') === false);
  checkTrue('sameTitle 短标题不做前缀', I.sameTitle('Sofa V35', 'Sofa V35 Part7') === false);
}

// ── 7. isOwned：单条问库（uid 优先、标题兜底、缓存 0 请求、查不了返回 null）──
{
  let calls = 0;
  const serve = (rows) => { sandbox.fetch = async () => { calls++; return { ok: true, json: async () => ({ results: rows }) }; }; };

  serve([{ listing: { uid: 'AAAA-1111', title: 'Coffee Table Round' } }]);
  checkTrue('isOwned 按 uid 命中', (await I.isOwned('aaaa-1111', 'Coffee Table Round', { ownedCacheHours: 24 })) === true);
  checkTrue('isOwned 同标题不同 uid 判否',
    (await I.isOwned('bbbb-2222', 'Coffee Table Round', { ownedCacheHours: 24 })) === false);

  serve([{ listing: { title: 'Chair &amp; Desk Set Vol 2' } }]);
  checkTrue('isOwned 没 uid 时按标题比',
    (await I.isOwned('cccc-3333', 'Chair & Desk Set Vol 2', { ownedCacheHours: 24 })) === true);

  const before = calls;
  await I.isOwned('aaaa-1111', 'Coffee Table Round', { ownedCacheHours: 24 });
  checkTrue('isOwned 命中缓存不发请求', calls === before, `多发了 ${calls - before} 次`);

  sandbox.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  checkTrue('isOwned 401 返回 null（不猜）',
    (await I.isOwned('dddd-4444', 'Something Else Entirely', { ownedCacheHours: 24 })) === null);
}

if (bad) { console.error(`\nCARDS FAIL: ${bad} 项不符`); process.exit(1); }
console.log('\nALL PASS');