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
    body: mkEl(), createElement: () => mkEl(), cookie: 'fab_csrftoken=00000000000000000000000000000000',   // 假的：真 token 不进仓库
    querySelector: () => null, querySelectorAll: () => [], readyState: 'complete',
  },
  location: { hostname: 'www.fab.com', search: '?efc=scan', pathname: '/limited-time-free' },
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, URLSearchParams, FormData, Event, Date,
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
  if (u.startsWith('/i/library/search')) {
    // 真实接口：GET /i/library/search?q=… → {results:[{listing:{title}}]}
    const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
    const owned = ['Coffee Table Round'].filter((t) => t.toLowerCase().includes(q.toLowerCase()));
    return resp(200, { results: owned.map((t) => ({ listing: { title: t } })) });
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
check('/i/library/search 里已有的条目没再下单', !(hist[FREE_ID] && hist[FREE_ID].verified !== true),
  JSON.stringify(hist[FREE_ID] || {}).slice(0, 100));
check('没对已拥有的条目发 add-to-library 请求', !calls.some((c) => c.includes(FREE_ID)));

const daily = store.get('efc:daily') || {};
const fab = daily.fab || {};
check('每日汇总写了 fab 段', !!fab.done, JSON.stringify(fab).slice(0, 160));
check('汇总里报了「领到 1 个」', (fab.claimed || []).includes('Ready Map Vol 2 - Bridge Environment'),
  JSON.stringify(fab.claimed));
check('汇总里报了「已在库里」', fab.ownedCount === 1, `ownedCount=${fab.ownedCount}`);

const lines = I.summaryLines(daily).map((l) => l.text).join(' | ');
check('悬浮窗文案分得清「领到」和「领过了」',
  lines.includes('领到 1 个') && lines.includes('早就在库里'), lines);

// ── 领过日志开关：默认关（不刷屏），打开后才写 ──
{
  const logs = store.get('efc:log') || [];
  const hasOwnedLine = logs.some((l) => String(l.msg || '').includes('已在库里'));
  check('默认不写「领过了」日志', hasOwnedLine === false, `日志条数 ${logs.length}`);

  store.set('efc:fab:history', {});
  store.set('efc:settings', { logOwned: true });
  store.set('efc:log', []);
  await I.fabRun(true);
  const logs2 = store.get('efc:log') || [];
  check('开关打开后写「领过了」日志',
    logs2.some((l) => String(l.msg || '').includes('已在库里')),
    logs2.map((l) => l.msg).join(' / ').slice(0, 160));
}

// ── 场景 2：翻页 + 整库比对（已拥有的条目一个请求都不发）──
{
  const calls2 = [];
  let finalized2 = 0;
  const OWNED = ['Owned Alpha One', 'Owned Beta Two', 'Owned Gamma Three'];
  const r2 = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const page = (titles, next) => ({ results: titles.map((t) => ({ uid: 'u-' + t, title: t })),
    cursors: { next: next || null } });

  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls2.push(`${(opts.method || 'GET').toUpperCase()} ${u}`);
    if (u === '/i/users/me') return r2(200, { displayName: 'RuinDream' });
    if (u.includes('min_discount_percentage=100')) return r2(200, page([], null));
    if (u.includes('is_free=1')) {
      if (u.includes('cursor=c1')) return r2(200, page(['Owned Beta Two', 'New Free Item A'], 'c2'));
      if (u.includes('cursor=c2')) return r2(200, page(['New Free Item B'], null));
      return r2(200, page(['Owned Alpha One', 'Owned Gamma Three'], 'c1'));
    }
    if (u.startsWith('/i/library/search')) {
      // 新形状：逐条问 q=标题 → 命中就回一条带 uid 的（真实接口带 listing 对象）
      const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]).toLowerCase();
      const hit = OWNED.filter((t) => t.toLowerCase() === q);
      return r2(200, { results: hit.map((t) => ({ listing: { uid: 'u-' + t, title: t } })) });
    }
    if (u.includes('/add-to-library')) return r2(200, '{}');
    if (u === '/i/cart' ) return r2(200, { items: [], totalPrice: { discountPrice: 0 } });
    if (u.startsWith('/i/listings/') && !u.includes('add-to-library')) {
      return r2(200, { title: 'x', licenses: [{ name: 'Personal', slug: 'personal',
        offerId: 'off-' + u, listingLicenseId: 'll-' + u,
        priceTier: { price: 0 } }] });
    }
    return r2(404, { detail: 'not stubbed: ' + u });
  };

  store.set('efc:fab:history', {});
  store.set('efc:settings', {});
  store.set('efc:log', []);
  await I.fabRun(true);

  const hist2 = store.get('efc:fab:history') || {};
  const claimedTitles = Object.values(hist2).filter((v) => v.state === 'claimed').map((v) => v.title);
  check('翻页后新条目都领到了', ['New Free Item A', 'New Free Item B'].every((t) => claimedTitles.includes(t)),
    claimedTitles.join(','));
  const daily2 = (store.get('efc:daily') || {}).fab || {};
  check('已在库的三个没被算成「新领」',
    !(daily2.claimed || []).some((t) => OWNED.includes(t)) && (daily2.claimed || []).length === 2,
    JSON.stringify(daily2.claimed));
  check('已在库的三个记进「已在库」',
    (daily2.owned || []).length === 3, JSON.stringify(daily2.owned));
  check('已拥有的条目没发 add-to-library',
    !calls2.some((c) => c.includes('add-to-library') && OWNED.some((t) => calls2.length && c.includes('u-' + t))) &&
    calls2.filter((c) => c.includes('add-to-library')).length === 2,
    `add-to-library 次数 ${calls2.filter((c) => c.includes('add-to-library')).length}`);
  check('已拥有的条目没发详情请求',
    !OWNED.some((t) => calls2.some((c) => c.startsWith('GET /i/listings/u-' + t))));
  const libCalls = calls2.filter((c) => c.startsWith('GET /i/library/search'));
  check('没有整库翻页（只有 q= 单条查询）',
    libCalls.every((c) => c.includes('q=')),
    libCalls.join(' | '));
  check('每个候选只问一次库（5 个候选 = 5 次）',
    libCalls.length === 5, `${libCalls.length} 次：` + libCalls.join(' | '));
  check('列表按页翻（is_free 3 页 + 100% 折扣 1 页 = 4 次）',
    calls2.filter((c) => c.startsWith('GET /i/listings/search')).length === 4,
    String(calls2.filter((c) => c.startsWith('GET /i/listings/search')).length));
}

// ── 场景 3：并发领取（同时最多几个在飞）+ 每轮上限 ──
{
  const calls3 = [];
  let live = 0;
  let maxLive = 0;
  const r3 = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const titles = Array.from({ length: 12 }, (_, i) => `Free Item ${i + 1}`);

  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls3.push(`${method} ${u}`);
    if (u === '/i/users/me') return r3(200, { displayName: 'RuinDream' });
    if (u.startsWith('/i/library/search')) return r3(200, { results: [], cursors: { next: null } });
    if (u.includes('min_discount_percentage=100')) return r3(200, { results: [], cursors: { next: null } });
    if (u.includes('is_free=1')) {
      return r3(200, { results: titles.map((t) => ({ uid: 'id-' + t, title: t })), cursors: { next: null } });
    }
    if (u.includes('/add-to-library')) {
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 40));   // 模拟网络往返，让并发真的重叠
      live--;
      return r3(200, '{}');
    }
    if (u.startsWith('/i/listings/')) {
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 25));
      live--;
      return r3(200, { title: 'x', licenses: [{ name: 'Personal', slug: 'personal',
        offerId: 'off-' + u, listingLicenseId: 'll-' + u, priceTier: { price: 0 } }] });
    }
    return r3(404, { detail: 'not stubbed ' + u });
  };

  store.set('efc:fab:history', {});
  store.set('efc:settings', { fabConcurrency: 4, maxFabPerRun: 5 });
  store.set('efc:log', []);
  const logs3 = [];
  const realConsole3 = sandbox.console;
  sandbox.console = { log: (...a) => logs3.push(a.join(' ')), warn: () => {}, error: () => {} };
  await I.fabRun(true);
  sandbox.console = realConsole3;
  const logText3 = logs3.join('\n');
  // 主人明确要求「领了谁就发出来」：每一条领到的都必须带完整标题，不能只在第 1/2/10 个报
  check('领到的 5 个逐条报了完整标题',
    ['Free Item 1', 'Free Item 2', 'Free Item 3', 'Free Item 4', 'Free Item 5']
      .every((t) => logText3.includes(t)),
    logText3.split('\n').filter((l) => l.includes('已领')).join(' | '));

  const daily3 = (store.get('efc:daily') || {}).fab || {};
  const claimed3 = daily3.claimed || [];
  check('并发生效（同时在飞 > 1）', maxLive >= 2, `最大并发 ${maxLive}`);
  check('每轮上限被遵守（5 个）', claimed3.length === 5, `实领 ${claimed3.length}: ${claimed3.join(',')}`);
  check('没有多发 add-to-library（只针对被领的 5 个）',
    calls3.filter((c) => c.includes('add-to-library')).length === 5,
    String(calls3.filter((c) => c.includes('add-to-library')).length));
}

// ── 场景 C：已有个人版、专业版仍要钱 → 必须报出来（1.7.2 修的就是这条静默分支）──
{
  const PRO_ID = 'pr0pr0pr-0000-0000-0000-00000000beef';
  const captured = [];
  const baseFetch = sandbox.fetch;
  const rC = (status, body, kind = 'json') => ({
    ok: status >= 200 && status < 300, status,
    json: async () => (kind === 'json' ? body : JSON.parse(body)),
    text: async () => (kind === 'json' ? JSON.stringify(body) : body),
  });
  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === '/i/users/me') return rC(200, { displayName: 'RuinDream' });
    if (u.startsWith('/i/library/search')) {
      // 真的拥有：库搜索能查到它（带 uid，走 uid 精确判定）
      const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
      const hit = /Paid Pro Asset/i.test(q) ? [{ listing: { uid: PRO_ID, title: 'Paid Pro Asset' } }] : [];
      return rC(200, { results: hit, cursors: { next: null } });
    }
    if (u.includes('min_discount_percentage=100')) return rC(200, { results: [], cursors: { next: null } });
    if (u.includes('is_free=1')) {
      return rC(200, { results: [{ uid: PRO_ID, title: 'Paid Pro Asset' }], cursors: { next: null } });
    }
    if (u === `/i/listings/${PRO_ID}`) {
      return rC(200, { title: 'Paid Pro Asset', licenses: [
        { name: '个人', slug: 'personal', offerId: 'OFFER-P', listingLicenseId: 'LL-P',
          priceTier: { price: 0, discountedPrice: 0, effectiveDiscountPercentage: 0 } },
        { name: '专业', slug: 'professional', offerId: 'OFFER-PRO', listingLicenseId: 'LL-PRO',
          priceTier: { price: 29.99, discountedPrice: 29.99 } },
      ] });
    }
    return rC(404, { detail: 'not stubbed ' + u });
  };
  const realConsole = sandbox.console;
  sandbox.console = { log: (...a) => captured.push(a.join(' ')), warn: () => {}, error: () => {} };
  store.set('efc:settings', {});
  store.set('efc:fab:history', { [PRO_ID]: { title: 'Paid Pro Asset', state: 'claimed', license: '个人', offer: 'OFFER-OLD', at: Date.now() } });
  store.delete('efc:daily');
  await I.fabRun(true);
  sandbox.console = realConsole;
  sandbox.fetch = baseFetch;

  const dailyC = (store.get('efc:daily') || {}).fab || {};
  const text = captured.join('\n');
  check('专业版仍要钱被计入汇总', dailyC.proStillPaid === 1, JSON.stringify(dailyC).slice(0, 140));
  check('专业版仍要钱写了明细日志', /专业版仍要钱（本轮第 1 个）/.test(text), text.slice(-260));
  check('结束行点明该类跳过数量', /专业版仍要钱 1 个/.test(text), text.slice(-260));
  check('已有个人版没被重复下单', !text.includes('add-to-library'), text.slice(-200));
}

// ── 场景 D：历史记着「已领个人版」，但库里根本没有 → 必须补领（主人这次丢单的那类）──
{
  const LOST_ID = '10570570-0000-4000-8000-000000000001';
  const rD = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  let claimedD = 0;
  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === '/i/users/me') return rD(200, { displayName: 'RuinDream' });
    if (u.startsWith('/i/library/search')) return rD(200, { results: [] });   // 库里没有
    if (u.includes('min_discount_percentage=100')) return rD(200, { results: [] });
    if (u.includes('is_free=1')) return rD(200, { results: [{ uid: LOST_ID, title: 'Female character head' }] });
    if (u === `/i/listings/${LOST_ID}`) {
      return rD(200, {
        title: 'Female character head',
        licenses: [
          { name: '个人', slug: 'personal', offerId: 'OFFER-P', listingLicenseId: 'LL-P', priceTier: { price: 0 } },
          { name: '专业', slug: 'professional', offerId: 'OFFER-PRO', listingLicenseId: 'LL-PRO', priceTier: { price: 19.93 } },
        ],
      });
    }
    if (u.endsWith('/add-to-library')) { claimedD++; return rD(204, {}); }
    return rD(404, { detail: 'not stubbed ' + u });
  };
  store.set('efc:settings', {});
  store.delete('efc:daily');
  store.set('efc:log', []);
  // 老版本按标题前缀误记的形状：state=claimed + license=个人，但从来没有 ownedCheckedAt
  store.set('efc:fab:history', {
    [LOST_ID]: { title: 'Female character head', state: 'claimed', license: '个人', at: Date.now() - 86400000 },
  });
  await I.fabRun(true);
  const dailyD = (store.get('efc:daily') || {}).fab || {};
  check('库里没有就必须补领（不被历史吞掉）', (dailyD.claimed || []).includes('Female character head'),
    JSON.stringify(dailyD).slice(0, 160));
  check('补领真的发了 add-to-library', claimedD === 1, `次数 ${claimedD}`);
  check('没有误记成「专业版仍要钱」', dailyD.proStillPaid !== 1, `proStillPaid=${dailyD.proStillPaid}`);
}

// ── 场景 E：库确认在库、但不是我们领的（没有 offer）→ 不拉详情、不刷「专业版仍要钱」──
{
  const IDS = ['e0000001-0000-4000-8000-000000000001', 'e0000002-0000-4000-8000-000000000002', 'e0000003-0000-4000-8000-000000000003'];
  const rE = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  let detailE = 0;
  const titles = { [IDS[0]]: 'Owned One', [IDS[1]]: 'Owned Two', [IDS[2]]: 'Owned Three' };
  sandbox.fetch = async (url) => {
    const u = String(url);
    if (u === '/i/users/me') return rE(200, { displayName: 'RuinDream' });
    if (u.startsWith('/i/library/search')) {
      const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]).toLowerCase();
      const hit = Object.entries(titles).filter(([, t]) => t.toLowerCase() === q);
      return rE(200, { results: hit.map(([uid, title]) => ({ listing: { uid, title } })) });
    }
    if (u.includes('min_discount_percentage=100')) return rE(200, { results: [] });
    if (u.includes('is_free=1')) return rE(200, { results: IDS.map((uid) => ({ uid, title: titles[uid] })) });
    if (u.startsWith('/i/listings/')) { detailE++; return rE(200, { title: 'x', licenses: [] }); }
    return rE(404, { detail: 'not stubbed ' + u });
  };
  store.set('efc:settings', {});
  store.delete('efc:daily');
  store.set('efc:log', []);
  store.set('efc:fab:history', Object.fromEntries(IDS.map((uid) => [uid, {
    title: titles[uid], state: 'claimed', license: '个人', at: Date.now() - 86400000,
  }])));
  await I.fabRun(true);
  const dailyE = (store.get('efc:daily') || {}).fab || {};
  check('已在库的老记录不再逐条拉详情', detailE === 0, `详情请求 ${detailE} 次`);
  check('汇总不再刷「专业版仍要钱」', (dailyE.proStillPaid || 0) === 0, `proStillPaid=${dailyE.proStillPaid}`);
  check('这三条都记进「已在库」', (dailyE.owned || []).length === 3, JSON.stringify(dailyE.owned));
}

// ── 场景 F：「无免费档」只用 1 天冷却（限时免费会突然出现），别跟着 retryDays 睡一周 ──
{
  const NF_ID = 'f0000001-0000-4000-8000-000000000001';
  const FAIL_ID = 'f0000002-0000-4000-8000-000000000002';
  const rF = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  let claimedF = [];
  sandbox.fetch = async (url) => {
    const u = String(url);
    if (u === '/i/users/me') return rF(200, { displayName: 'RuinDream' });
    if (u.startsWith('/i/library/search')) return rF(200, { results: [] });
    if (u.includes('min_discount_percentage=100')) return rF(200, { results: [] });
    if (u.includes('is_free=1')) {
      return rF(200, { results: [
        { uid: NF_ID, title: 'Late Freebie' },
        { uid: FAIL_ID, title: 'Still Failing' },
      ] });
    }
    if (u === `/i/listings/${NF_ID}`) {
      return rF(200, { title: 'Late Freebie', licenses: [
        { name: '个人', slug: 'personal', offerId: 'OFFER-NF', listingLicenseId: 'LL-NF', priceTier: { price: 0 } },
      ] });
    }
    if (u.endsWith('/add-to-library')) { claimedF.push(u); return rF(204, {}); }
    return rF(404, { detail: 'not stubbed ' + u });
  };
  store.set('efc:settings', {});
  store.delete('efc:daily');
  store.set('efc:log', []);
  store.set('efc:last:fab', 0);   // 清掉「Fab 扫描冷却」，否则整轮直接 return
  store.set('efc:fab:history', {
    [NF_ID]: { title: 'Late Freebie', state: 'no-free-tier', at: Date.now() - 26 * 3600 * 1000 },
    [FAIL_ID]: { title: 'Still Failing', state: 'failed', at: Date.now() - 26 * 3600 * 1000 },
  });
  await I.fabRun(false);   // 非 force：走冷却判定
  const dailyF = (store.get('efc:daily') || {}).fab || {};
  check('「无免费档」过 1 天就重试并补领', (dailyF.claimed || []).includes('Late Freebie'), JSON.stringify(dailyF.claimed));
  check('「失败」仍按 retryDays 冷却，不重试', !(dailyF.claimed || []).includes('Still Failing'));
  check('只对需要重试的那条发了 add-to-library', claimedF.length === 1, `次数 ${claimedF.length}`);
}

if (bad) { console.error(`\nFLOW FAIL: ${bad} 项不符`); process.exit(1); }
console.log('\nFAB-FLOW PASS');
