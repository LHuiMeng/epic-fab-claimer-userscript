// 全流程离线演练：不碰浏览器，用真实接口的响应形状喂 fabRun，
// 验「限时免费能领」+「add-to-library 报 Not free 时自动改走购物车」+「/library 判已拥有」。
// 运行：node userscript/test_fab_flow.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = fs.readFileSync(path.join(here, 'epic-fab-claimer.user.js'), 'utf8');

// ── 最小 DOM stub（够 mountPanel/ui 跑通）──
const mkEl = () => {
  const el = {
    style: {}, dataset: {}, textContent: '', innerHTML: '', className: '',
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector: () => mkEl(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    attachShadow: () => mkEl(),
  };
  return el;
};
const store = new Map();
const sandbox = {
  window: {
    __efcBooted: true,
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, v),
    GM_openInTab: () => ({}),
    GM_notification: () => {},
    addEventListener() {},
  },
  document: {
    body: mkEl(), createElement: () => mkEl(), cookie: 'fab_csrftoken=0123456789abcdef0123456789abcdef',
    querySelector: () => null, querySelectorAll: () => [], readyState: 'complete',
  },
  location: { hostname: 'www.fab.com', search: '?efc=scan', pathname: '/limited-time-free' },
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  console, setTimeout, clearTimeout, URLSearchParams, FormData, Event, Date,
};
sandbox.window.document = sandbox.document;
sandbox.window.location = sandbox.location;
sandbox.globalThis = sandbox;

// ── fetch 路由：形状照抄真接口 ──
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const LIMIT_ID = '95ff3c25-59f9-441d-aa43-93c3abd63680';
const FREE_ID = 'ffffffff-0000-0000-0000-000000000001';
const calls = [];
const resp = (status, body, kind = 'json') => ({
  ok: status >= 200 && status < 300, status,
  json: async () => (kind === 'json' ? body : JSON.parse(body)),
  text: async () => (kind === 'json' ? JSON.stringify(body) : body),
});
let finalized = 0;
let cartHasItem = false;

sandbox.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  calls.push(`${method} ${url}`);
  const u = String(url);
  if (u === '/i/users/me') return resp(200, { displayName: 'RuinDream' });
  if (u.startsWith('/i/listings/search') && u.includes('min_discount_percentage=100')) {
    return resp(200, { results: [{ uid: LIMIT_ID, title: 'Ready Map Vol 2 - Bridge Environment', hasEffectiveDiscounts: true }] });
  }
  if (u.startsWith('/i/listings/search') && u.includes('is_free=1')) {
    return resp(200, { results: [{ uid: FREE_ID, title: 'Coffee Table Round' }] });
  }
  if (u === '/library') {
    return resp(200, '<html><body><div>Coffee Table Round</div></body></html>', 'text');
  }
  if (u === `/i/listings/${LIMIT_ID}`) {
    return resp(200, {
      title: 'Ready Map Vol 2 - Bridge Environment',
      licenses: [{
        name: '专业', slug: 'professional', offerId: 'OFFER-LIMIT', listingLicenseId: 'LL-LIMIT',
        priceTier: {
          price: 49.99, discountedPrice: 0, effectiveDiscountPercentage: 100,
          discountStartDate: iso(now - 86400000), discountEndDate: iso(now + 86400000),
        },
      }],
    });
  }
  if (u.endsWith('/add-to-library')) return resp(400, 'Not free.');
  if (u === '/i/cart/items' && method === 'POST') { cartHasItem = true; return resp(201, { uid: 'CART-1' }); }
  if (u === '/i/cart' && method === 'GET') {
    return resp(200, {
      items: cartHasItem ? [{ uid: 'CART-1', listingUid: LIMIT_ID }] : [],
      totalPrice: { discountPrice: 0 },
    });
  }
  if (u === '/i/cart/validate') return resp(204, '');
  if (u === '/i/payment/finalize') { finalized++; cartHasItem = false; return resp(204, ''); }
  if (u.startsWith('/i/cart/items/') && method === 'DELETE') { cartHasItem = false; return resp(204, ''); }
  return resp(404, { detail: 'not stubbed: ' + u });
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'epic-fab-claimer.user.js' });
const I = sandbox.window.__efcInternals;

let bad = 0;
const check = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 先把历史清空、Fab 冷却跳过（force=true）
store.set('efc:fab:history', {});
await I.fabRun(true);

const hist = store.get('efc:fab:history') || {};
const limitRec = hist[LIMIT_ID] || {};
check('限时免费被领到（走购物车）', limitRec.state === 'claimed', JSON.stringify(limitRec).slice(0, 120));
check('记下了专业版档位', /专业/.test(limitRec.license || ''), limitRec.license);
check('记下了截止时间', typeof limitRec.until === 'number', String(limitRec.until));
check('真的走到了 finalize', finalized === 1, `finalize 次数 ${finalized}`);
check('add-to-library 的 400 被识别后转购物车',
  calls.some((c) => c.includes('add-to-library')) && calls.some((c) => c === 'POST /i/cart/validate'));
check('购物车清干净了', cartHasItem === false);
check('/library 里已有的条目没再下单', !(hist[FREE_ID] && hist[FREE_ID].verified !== true),
  JSON.stringify(hist[FREE_ID] || {}).slice(0, 100));
check('没对已拥有的条目发 add-to-library', !calls.some((c) => c.includes(FREE_ID)));

const daily = store.get('efc:daily') || {};
const fab = daily.fab || {};
check('每日汇总写了 fab 段', !!fab.done, JSON.stringify(fab).slice(0, 160));
check('汇总里报了「领到 1 个」', (fab.claimed || []).includes('Ready Map Vol 2 - Bridge Environment'),
  JSON.stringify(fab.claimed));
check('汇总里报了「已在库里」', fab.ownedCount === 1, `ownedCount=${fab.ownedCount}`);

const lines = I.summaryLines(daily).map((l) => l.text).join(' | ');
check('悬浮窗文案分得清「领到」和「领过了」',
  lines.includes('领到 1 个') && lines.includes('早就在库里'), lines);

if (bad) { console.error(`\nFLOW FAIL: ${bad} 项不符`); process.exit(1); }
console.log('\nFAB-FLOW PASS');
