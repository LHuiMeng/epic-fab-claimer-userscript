// 拿真实 /i/listings/{id} 响应喂脚本的 freeUntilOf / tierRank，看它到底判成什么。
// 运行：node userscript/test_real_promo.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = fs.readFileSync(path.join(here, 'epic-fab-claimer.user.js'), 'utf8');
const dump = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'promo_dump.json'), 'utf8'));

const noop = () => {};
const fakeEl = { style: {}, appendChild: noop, addEventListener: noop, textContent: '',
  classList: { toggle: noop }, querySelector: () => fakeEl, querySelectorAll: () => [],
  attachShadow: () => fakeEl, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
const sandbox = {
  window: { __efcBooted: true, GM_getValue: (k, d) => d, GM_setValue: noop, addEventListener: noop },
  document: { body: fakeEl, createElement: () => fakeEl, cookie: '', querySelector: () => null,
    querySelectorAll: () => [], readyState: 'complete' },
  location: { hostname: 'www.fab.com', search: '', pathname: '/' },
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  console, setTimeout, clearTimeout, URLSearchParams, Event, Date,
};
sandbox.window.document = sandbox.document;
sandbox.window.location = sandbox.location;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'epic-fab-claimer.user.js' });
const I = sandbox.window.__efcInternals;

let bad = 0;
for (const row of dump) {
  const title = (row.detail.title || '').slice(0, 40);
  const lics = row.detail.licenses || [];
  const judged = lics.map((l) => {
    const fu = I.freeUntilOf(l);
    return { name: l.name, slug: l.slug, free: fu.free, until: fu.until };
  });
  const free = judged.filter((j) => j.free);
  free.sort((a, b) => I.tierRank(a) - I.tierRank(b));
  const ok = free.length > 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${title}`);
  for (const j of judged) {
    console.log(`    ${j.name}(${j.slug}) free=${j.free} until=${j.until ? new Date(j.until).toISOString() : null}`);
  }
  console.log(`    → 脚本会选：${free.length ? free[0].name + (free[0].until ? '·限时' : '') : '（无，判为没有免费档位）'}`);
}
if (bad) { console.error(`\nREAL-PROMO FAIL: ${bad} 个条目被判成没有免费档位`); process.exit(1); }
console.log('\nREAL-PROMO PASS');
