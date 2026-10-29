// 离线自测：用真实免费列表 JSON 验 freeWindow/claimUrlFor 的判定，不碰浏览器。
// 运行：node userscript/test_logic.mjs [free.json]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = fs.readFileSync(path.join(here, 'epic-fab-claimer.user.js'), 'utf8');
const dataPath = process.argv[2] || path.join(here, 'free_sample.json');
const payload = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// 最小 DOM stub：只要能让脚本解析完、不执行 boot
const noop = () => {};
const fakeEl = { style: {}, appendChild: noop, addEventListener: noop, attachShadow: () => ({ querySelector: () => fakeEl, querySelectorAll: () => [], innerHTML: '', addEventListener: noop, appendChild: noop }), getBoundingClientRect: () => ({ width: 0, height: 0 }), querySelector: () => null, querySelectorAll: () => [] };
const sandbox = {
  window: {
    __efcBooted: true,               // 跳过 boot，只留纯函数
    GM_getValue: (k, d) => d,
    GM_setValue: noop,
    addEventListener: noop,
  },
  document: { body: fakeEl, createElement: () => fakeEl, cookie: '', querySelector: () => null, querySelectorAll: () => [], readyState: 'complete' },
  location: { hostname: 'store.epicgames.com', search: '', pathname: '/' },
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  console,
  setTimeout, clearTimeout, URLSearchParams, Event,
};
sandbox.window.document = sandbox.document;
sandbox.window.location = sandbox.location;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'epic-fab-claimer.user.js' });

const I = sandbox.window.__efcInternals;
if (!I) { console.error('FAIL: 没拿到 __efcInternals'); process.exit(1); }

const els = payload?.data?.Catalog?.searchStore?.elements || [];
if (!els.length) { console.error('FAIL: JSON 里没有 elements'); process.exit(1); }

let freeCount = 0;
const rows = [];
for (const el of els) {
  const w = I.freeWindow(el);
  if (!w) continue;
  freeCount++;
  const ns = el.namespace;
  const offer = el.id;
  const slug = el.catalogNs?.mappings?.[0]?.pageSlug || el.urlSlug || String(el.productSlug || '').split('/')[0];
  const url = I.claimUrlFor({ id: offer, title: el.title, namespace: ns, offerId: offer, slug });
  rows.push(`  · ${el.title} | ns=${ns} | offer=${offer} | until=${new Date(w.end).toISOString().slice(0, 10)}`);
  rows.push(`    ${url}`);
  // 断言：结账 URL 必须带 1-ns-offer 三元组，否则后面点不到
  if (!url.includes(`offers=1-${ns}-${offer}`)) {
    console.error(`FAIL: URL 三元组不对 → ${url}`);
    process.exit(1);
  }
}

console.log(`免费列表元素 ${els.length} 个，判定为「当前可领」${freeCount} 个：`);
rows.forEach((r) => console.log(r));

// priceIsZero 的单测（用真实页面上出现的几种写法）
const priceCases = [
  ['合计 ¥0.00', true],
  ['Total: $0.00', true],
  ['费用 免费 / Free', true],
  ['价格 ¥88.00', false],
  ['无语义文本', null],
];
for (const [text, want] of priceCases) {
  sandbox.document.body = { innerText: text, querySelectorAll: () => [] };
  sandbox.document.querySelectorAll = () => [];
  // pageText() 读 document.body.innerText
  const got = I.priceIsZero();
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} priceIsZero("${text}") = ${got}（期望 ${want}）`);
  if (!ok) process.exit(1);
}
console.log('ALL PASS');

// tierRank 单测：真实 Fab 返回的档位（slug 语言无关优先，name 本地化兜底）
const tierCases = [
  ['专业', 0], ['Professional', 0], ['PRO', 0],
  ['个人', 1], ['Personal', 1],
  ['CC-BY', 2], ['', 2], [null, 2],
  [{ slug: 'professional', name: '专业' }, 0],
  [{ slug: 'personal', name: '个人' }, 1],
  [{ slug: 'cc0', name: 'CC0' }, 2],
  // slug 与 name 冲突时以 slug 为准
  [{ slug: 'professional', name: '个人' }, 0],
];
for (const [name, want] of tierCases) {
  const got = I.tierRank(name);
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} tierRank(${JSON.stringify(name)}) = ${got}（期望 ${want}）`);
  if (!ok) process.exit(1);
}
// 排序后必须专业版排第一 —— 这是「拿不到专业版」那个 bug 的直接断言
const sorted = [{ name: '个人' }, { name: '专业' }, { name: 'CC-BY' }]
  .sort((a, b) => I.tierRank(a.name) - I.tierRank(b.name));
console.log(`排序结果：${sorted.map((l) => l.name).join(' > ')}`);
if (sorted[0].name !== '专业') { console.error('FAIL: 专业版没排到第一'); process.exit(1); }
console.log('TIER PASS');

// 回归测试：'Download the Epic Games Launcher' 这类结账页常驻推广文案
// 曾被当成「领取成功」，导致限时免费条目被永久记成 claimed。必须判否。
const okCases = [
  ['Thanks for your order!', true],
  ['下单成功', true],
  ['感谢您的订单', true],
  ["It's all yours", true],
  ['Download the Epic Games Launcher', false],
  ['Is Epic Games Launcher installed?', false],
  ['Please place your order below', false],
  ['', false],
];
for (const [t, want] of okCases) {
  const got = I.successText(t);
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} successText(${JSON.stringify(t)}) = ${got}（期望 ${want}）`);
  if (!ok) process.exit(1);
}
const ctaCases = [['In Library', true], ['已在库', true], ['Place Order', false], ['添加到库', false]];
for (const [t, want] of ctaCases) {
  const got = I.ownedCtaText(t);
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} ownedCtaText(${JSON.stringify(t)}) = ${got}（期望 ${want}）`);
  if (!ok) process.exit(1);
}
console.log('CLAIM-DETECT PASS');

// ── freeUntilOf：永久免费 / 限时免费 / 过期 / 未开始 / 要钱 ──
{
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const cases = [
    ['永久免费', { priceTier: { price: 0 } }, true],
    ['限时免费·进行中', { priceTier: { price: 49.99, discountedPrice: 0, effectiveDiscountPercentage: 100,
      discountStartDate: iso(now - 86400000), discountEndDate: iso(now + 86400000) } }, true],
    ['限时免费·已过期', { priceTier: { price: 49.99, discountedPrice: 0, effectiveDiscountPercentage: 100,
      discountStartDate: iso(now - 5 * 86400000), discountEndDate: iso(now - 86400000) } }, false],
    ['限时免费·没开始', { priceTier: { price: 49.99, discountedPrice: 0, effectiveDiscountPercentage: 100,
      discountStartDate: iso(now + 86400000), discountEndDate: iso(now + 5 * 86400000) } }, false],
    ['要钱', { priceTier: { price: 19.99, discountedPrice: 9.99, effectiveDiscountPercentage: 50 } }, false],
    ['空档位', {}, false],
  ];
  let bad = 0;
  for (const [name, lic, want] of cases) {
    const got = I.freeUntilOf(lic).free;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} freeUntilOf(${name}) = ${got}（期望 ${want}）`);
  }
  const until = I.freeUntilOf({ priceTier: { price: 9, discountedPrice: 0,
    discountStartDate: iso(now - 1000), discountEndDate: iso(now + 3600000) } }).until;
  const okT = typeof until === 'number' && until > now;
  if (!okT) bad++;
  console.log(`${okT ? 'PASS' : 'FAIL'} freeUntilOf 返回截止时间戳 ${until}`);
  if (bad) { console.error(`FREE-UNTIL FAIL: ${bad} 个用例不符`); process.exit(1); }
  console.log('FREE-UNTIL PASS');
}

// ── dayKey：本地日期 YYYY-MM-DD，同日同值、换日必变 ──
{
  const k = I.dayKey();
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(k) && k === I.dayKey();
  console.log(`${ok ? 'PASS' : 'FAIL'} dayKey() = ${k}`);
  if (!ok) process.exit(1);
}

// ── 设置面板的字段表与默认值必须对齐（漏一个就是「设置里改不到」）──
{
  const def = I.DEF_SETTINGS || {};
  const schema = I.SETTINGS_SCHEMA || [];
  const keys = schema.flatMap((s) => s.fields.map((f) => f.k));
  const missing = Object.keys(def).filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !(k in def));
  let bad = 0;
  if (missing.length) { bad++; console.log(`FAIL 默认项没进设置面板: ${missing.join(',')}`); }
  if (extra.length) { bad++; console.log(`FAIL 面板上有默认值里没有的键: ${extra.join(',')}`); }
  if (new Set(keys).size !== keys.length) { bad++; console.log('FAIL 面板里有重复键'); }
  for (const sec of schema) {
    for (const f of sec.fields) {
      if (!['bool', 'num'].includes(f.type)) { bad++; console.log(`FAIL 未知类型 ${f.k}: ${f.type}`); }
      if (f.type === 'num' && !(Number.isFinite(f.min) && Number.isFinite(f.max) && f.min < f.max)) {
        bad++; console.log(`FAIL ${f.k} 的 min/max 不合法`);
      }
      if (!f.label) { bad++; console.log(`FAIL ${f.k} 没有标签`); }
    }
  }
  if (!bad) console.log(`PASS 设置面板覆盖全部 ${Object.keys(def).length} 个默认项（${schema.length} 组）`);
  if (bad) process.exit(1);
}

// ── 头部 @version 必须和代码里的 VERSION 一致（Tampermonkey 靠头部判断要不要更新，
//    只改常量不改头部 = 用户永远收不到新版）──
{
  const m = src.match(/\/\/\s*@version\s+(\S+)/);
  const got = m ? m[1] : '(缺失)';
  const ok = got === I.VERSION;
  console.log(`${ok ? 'PASS' : 'FAIL'} 头部 @version = ${got}，VERSION = ${I.VERSION}`);
  if (!ok) process.exit(1);
}

// ── normalizeSettings：脏值要能兜住（导入/手改/旧版本）──
{
  const N = I.normalizeSettings;
  const cases = [
    ['数字字符串被转成数字', { maxFabPerRun: '7' }, (r) => r.maxFabPerRun === 7],
    ['超过上限被夹住', { maxFabPerRun: 99999 }, (r) => r.maxFabPerRun === 3000],
    ['低于下限被夹住', { toastMaxPerDay: -5 }, (r) => r.toastMaxPerDay === 0],
    ['小数被取整', { epicRetryMinutes: 45.7 }, (r) => r.epicRetryMinutes === 46],
    ['布尔按真值取', { autoEpic: 'yes', logOwned: 0 }, (r) => r.autoEpic === true && r.logOwned === false],
    ['非法数字保持默认', { retryDays: 'abc' }, (r) => r.retryDays === 7],
    ['未知键被丢掉', { notARealKey: 1 }, (r) => !('notARealKey' in r)],
    ['空值不覆盖默认', { maxEpicPerRun: null }, (r) => r.maxEpicPerRun === 3],
  ];
  let bad = 0;
  for (const [name, raw, ok] of cases) {
    const r = N(raw);
    const pass = ok(r);
    if (!pass) bad++;
    console.log(`${pass ? 'PASS' : 'FAIL'} normalizeSettings：${name} → ${JSON.stringify(r).slice(0, 90)}`);
  }
  if (bad) { console.error(`NORMALIZE FAIL: ${bad} 项`); process.exit(1); }
  console.log('NORMALIZE PASS');
}
