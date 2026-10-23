// ==UserScript==
// @name         Epic/Fab 免费领取助手
// @namespace    ruindream.efc
// @version      1.2.0
// @description  打开浏览器时自动扫描 Epic 本周免费游戏与 Fab 免费资产并自动领取；遇真人验证会高亮等你点。
// @author       桃夭
// @homepageURL  https://github.com/LHuiMeng/epic-fab-claimer-userscript
// @supportURL   https://github.com/LHuiMeng/epic-fab-claimer-userscript/issues
// @updateURL    https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js
// @downloadURL  https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js
// @match        https://store.epicgames.com/*
// @match        https://www.epicgames.com/*
// @match        https://www.fab.com/*
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      store-site-backend-static-ipv4.ak.epicgames.com
// @connect      store.epicgames.com
// @connect      fab.com
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // ────────────────────────────── 常量 ──────────────────────────────
  const K = {
    epicHist: 'efc:epic:history',
    fabHist: 'efc:fab:history',
    log: 'efc:log',
    settings: 'efc:settings',
    lastEpicScan: 'efc:last:epic',
    lastFabScan: 'efc:last:fab',
    lastAutoOpen: 'efc:last:autoopen',
    openTabs: 'efc:openTabs',
  };
  const DEF_SETTINGS = {
    autoEpic: true,      // 每日首次自动扫 Epic
    autoFab: true,       // 打开 Fab 时自动领
    maxEpicPerRun: 3,    // 每轮最多开 3 个领取页
    maxFabPerRun: 10,    // 每轮最多领 10 个资产
    retryDays: 7,        // Fab 失败条目的冷却天数
    epicRetryMinutes: 120, // Epic 未领到的条目多久重试一次（限时免费等不起 7 天）
    dryRun: false,       // 只扫描不点领取
    epicScanHours: 24,   // Epic 自动扫的间隔
    fabScanHours: 6,     // Fab 自动领的间隔
  };
  const FREE_API = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions'
    + '?locale=zh-CN&country=CN&allowCountries=CN';
  const STORE = 'https://store.epicgames.com';
  const CAPTCHA_WAIT_MS = 5 * 60 * 1000;

  // ────────────────────────────── GM 兼容层 ──────────────────────────────
  // Tampermonkey 老 API 同步、Violentmonkey/GM4 是 Promise，统一 await 一次。
  const has = (n) => typeof window[n] === 'function';

  async function gmGet(key, def) {
    try {
      let v;
      if (has('GM_getValue')) v = window.GM_getValue(key, def);
      else if (window.GM && window.GM.getValue) v = window.GM.getValue(key, def);
      else v = def;
      v = await Promise.resolve(v);
      return v === undefined || v === null ? def : v;
    } catch (e) { return def; }
  }
  async function gmSet(key, val) {
    try {
      if (has('GM_setValue')) window.GM_setValue(key, val);
      else if (window.GM && window.GM.setValue) await window.GM.setValue(key, val);
    } catch (e) { /* 存储失败不该让流程崩 */ }
  }
  function gmOpenTab(url, opts) {
    const o = Object.assign({ active: false, insert: true, setParent: true }, opts || {});
    if (has('GM_openInTab')) return window.GM_openInTab(url, o);
    if (window.GM && window.GM.openInTab) return window.GM.openInTab(url, o);
    return window.open(url, '_blank');
  }
  function gmNotify(text, title) {
    try {
      if (has('GM_notification')) window.GM_notification({ text, title: title || '免费领取助手', timeout: 8000 });
      else if (window.GM && window.GM.notification) window.GM.notification({ text, title: title || '免费领取助手' });
    } catch (e) { /* ignore */ }
  }
  function gmXhr(url, headers) {
    return new Promise((resolve, reject) => {
      const fn = has('GM_xmlhttpRequest') ? window.GM_xmlhttpRequest
        : (window.GM && window.GM.xmlHttpRequest ? window.GM.xmlHttpRequest : null);
      if (!fn) { reject(new Error('没有 GM_xmlhttpRequest 权限')); return; }
      fn({
        method: 'GET', url, headers: headers || {},
        timeout: 30000,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  // ────────────────────────────── 日志 / 设置 ──────────────────────────────
  async function log(msg, level) {
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`;
    console.log('[EFC]', msg);
    try {
      const arr = await gmGet(K.log, []);
      arr.push({ t: Date.now(), msg, level: level || 'info' });
      while (arr.length > 200) arr.shift();
      await gmSet(K.log, arr);
    } catch (e) { /* ignore */ }
    if (ui) ui.refresh();
  }
  async function settings() {
    return Object.assign({}, DEF_SETTINGS, await gmGet(K.settings, {}));
  }
  async function hist(key) {
    const h = await gmGet(key, {});
    return h && typeof h === 'object' ? h : {};
  }
  async function setHist(key, id, val) {
    const h = await hist(key);
    h[id] = val;
    await gmSet(key, h);
  }
  function recentlyTried(entry, days) {
    if (!entry || !entry.at) return false;
    return Date.now() - entry.at < days * 86400000;
  }
  function cookieVal(name) {
    // 注意：别 decodeURIComponent —— fab_csrftoken 是 32 位纯十六进制，
    // 解码只会把 %xx 之类搞坏，导致后端报 CSRF token incorrect length。
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? m[1].replace(/^"|"$/g, '').trim() : '';
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ────────────────────────────── 悬浮面板 ──────────────────────────────
  let ui = null;
  function mountPanel(title) {
    if (ui || !document.body) return ui;
    const host = document.createElement('div');
    host.id = 'efc-panel-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { font: 12px/1.5 "Microsoft YaHei", system-ui, sans-serif; width: 268px; color: #e8e8ea;
               background: rgba(22,22,26,.94); border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
               box-shadow: 0 10px 30px rgba(0,0,0,.45); overflow: hidden; backdrop-filter: blur(6px); }
        .hd { display:flex; align-items:center; gap:6px; padding: 7px 10px; cursor: pointer;
              background: linear-gradient(90deg, rgba(255,90,140,.28), rgba(120,90,255,.22)); }
        .hd b { font-weight: 600; font-size: 12px; flex: 1; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #6ee7a8; box-shadow: 0 0 6px #6ee7a8; }
        .dot.busy { background: #ffd166; box-shadow: 0 0 6px #ffd166; }
        .dot.warn { background: #ff6b6b; box-shadow: 0 0 6px #ff6b6b; }
        .bd { padding: 8px 10px 10px; }
        .row { display:flex; gap:6px; margin-bottom: 6px; }
        button { flex:1; font: inherit; font-size: 11px; color:#e8e8ea; background: rgba(255,255,255,.08);
                 border: 1px solid rgba(255,255,255,.16); border-radius: 6px; padding: 4px 0; cursor: pointer; }
        button:hover { background: rgba(255,255,255,.16); }
        #log { max-height: 168px; overflow: auto; white-space: pre-wrap; word-break: break-all;
               font-size: 11px; color: #b9b9c2; margin-top: 6px; border-top: 1px solid rgba(255,255,255,.1); padding-top: 6px; }
        #log .warnline { color: #ffb4b4; }
        #log .okline { color: #8ef0b6; }
        .hint { font-size: 10.5px; color:#8d8d99; margin-top: 4px; }
        .collapsed .bd { display: none; }
      </style>
      <div class="box">
        <div class="hd"><span class="dot"></span><b></b><span class="mini">–</span></div>
        <div class="bd">
          <div class="row"><button data-act="scan">立即扫描本轮</button><button data-act="clear">清日志</button></div>
          <div id="log"></div>
          <div class="hint"></div>
        </div>
      </div>`;
    const box = root.querySelector('.box');
    const dot = root.querySelector('.dot');
    const logEl = root.querySelector('#log');
    const hintEl = root.querySelector('.hint');
    root.querySelector('b').textContent = title;
    root.querySelector('.hd').addEventListener('click', () => box.classList.toggle('collapsed'));

    ui = {
      api: root,
      async refresh() {
        const arr = await gmGet(K.log, []);
        logEl.innerHTML = arr.slice(-24).map((l) => {
          const cls = l.level === 'warn' ? 'warnline' : (l.level === 'ok' ? 'okline' : '');
          return `<div class="${cls}">${String(l.msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`;
        }).join('');
        logEl.scrollTop = logEl.scrollHeight;
        const st = await settings();
        hintEl.textContent = `${location.hostname} · Epic ${st.autoEpic ? '开' : '关'} / Fab ${st.autoFab ? '开' : '关'}${st.dryRun ? ' · 仅扫描' : ''}`;
      },
      busy(on, warn) {
        dot.className = 'dot' + (warn ? ' warn' : (on ? ' busy' : ''));
      },
    };
    root.querySelector('[data-act="scan"]').addEventListener('click', () => {
      window.__efcForceScan = true;
      if (location.hostname.endsWith('fab.com')) fabRun(true);
      else if (location.hostname.endsWith('epicgames.com')) epicScan(true);
    });
    root.querySelector('[data-act="clear"]').addEventListener('click', async () => {
      await gmSet(K.log, []);
      ui.refresh();
    });
    ui.refresh();
    return ui;
  }

  // ══════════════════════════════ Fab 部分 ══════════════════════════════
  // 档位优先级：专业 > 个人 > 其它（CC-BY / CC0 之类）。
  // 优先用 slug 判（professional / personal，语言无关）；name 是本地化的
  // （中文「专业/个人」、英文「Professional/Personal」），只按英文名匹配会永远选到个人版。
  function tierRank(l) {
    let slug = '', name = '';
    if (l && typeof l === 'object') {
      slug = String(l.slug || '').trim().toLowerCase();
      name = String(l.name || '').trim().toLowerCase();
    } else {
      name = String(l || '').trim().toLowerCase();
    }
    if (slug === 'professional' || slug === 'pro') return 0;
    if (slug === 'personal') return 1;
    if (slug) return 2;
    if (name === 'professional' || name === '专业' || name === 'pro') return 0;
    if (name === 'personal' || name === '个人') return 1;
    return 2;
  }
  function isProTier(l) { return tierRank(l) === 0; }

  async function fabRun(force) {
    const st = await settings();
    if (!force && !st.autoFab) return;
    const last = await gmGet(K.lastFabScan, 0);
    if (!force && Date.now() - last < st.fabScanHours * 3600000) return;
    await gmSet(K.lastFabScan, Date.now());

    mountPanel('Fab 免费资产');
    ui.busy(true);
    await log(`Fab：开始扫描（同源接口）`);

    const csrf = cookieVal('fab_csrftoken');
    if (!csrf) {
      await log('Fab：没有 fab_csrftoken cookie，可能未登录 — 本次跳过', 'warn');
      ui.busy(false, true);
      return;
    }

    // 先确认登录态。/i/users/me 未登录时 401；搜索接口是公开的，
    // 不先查就会把 8 个条目一个个撞成 401（实测就是这种刷屏）。
    let me = null;
    try {
      const r = await fetch('/i/users/me', { credentials: 'include', headers: { Accept: 'application/json' } });
      if (r.ok) me = await r.json();
      else if (r.status === 401 || r.status === 403) {
        await log('Fab：未登录（/i/users/me → ' + r.status + '），先登录 Fab 再扫', 'warn');
        bigBanner('Fab 还没登录 —— 登录一次后点「立即扫描本轮」', 'rgba(200,120,20,.95)');
        ui.busy(false, true);
        return;
      }
    } catch (e) {
      await log(`Fab：登录态检查失败 ${e.message}`, 'warn');
    }
    if (me) await log(`Fab：已登录 ${me.displayName || me.username || ''}`);

    let items = [];
    try {
      const r = await fetch('/i/listings/search?is_free=1&count=60&sort_by=-createdAt', {
        credentials: 'include', headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      items = j.results || j.listings || [];
    } catch (e) {
      await log(`Fab：列表失败 ${e.message}`, 'warn');
      ui.busy(false, true);
      return;
    }
    await log(`Fab：免费列表 ${items.length} 个`);

    const h = await hist(K.fabHist);
    let done = 0;
    for (const it of items) {
      if (done >= st.maxFabPerRun) break;
      const id = it.uid || it.id;
      const title = it.title || '(无标题)';
      const prev = h[id];
      let upgrading = false;
      if (prev && prev.state === 'claimed') {
        // 已经领过：只有在「当初拿的不是专业版」时才回头补专业版，别重复下单
        if (isProTier(prev.license)) continue;
        if (!force && prev.proCheckedAt && Date.now() - prev.proCheckedAt < st.retryDays * 864e5) continue;
        upgrading = true;
      }
      // 手动扫描：失败/待登录的都重试；自动跑：needs-login 也不受冷却限制
      if (prev && prev.state !== 'claimed' && !force && prev.state !== 'needs-login' && recentlyTried(prev, st.retryDays)) continue;

      let offer = null;
      let tier = '';
      try {
        const d = await fetch(`/i/listings/${encodeURIComponent(id)}`, {
          credentials: 'include', headers: { Accept: 'application/json' },
        });
        if (d.ok) {
          const det = await d.json();
          const free = (det.licenses || []).filter((l) => {
            const p = l.priceTier && l.priceTier.price;
            return p === 0 || p === '0';
          });
          // 专业版优先；专业版要钱时才退而领个人版
          free.sort((a, b) => tierRank(a) - tierRank(b));
          if (free.length) { offer = free[0].offerId; tier = free[0].name || ''; }
        }
      } catch (e) { /* 落到下面统一记失败 */ }

      if (!offer) {
        await setHist(K.fabHist, id, { title, state: 'no-free-tier', at: Date.now() });
        await log(`Fab：${title.slice(0, 28)} 没有免费档位，跳过`, 'warn');
        continue;
      }
      if (upgrading && !isProTier(tier)) {
        // 专业版仍然要钱 → 保持个人版；记下检查时间，省得每轮都去问一遍
        await setHist(K.fabHist, id, {
          title, state: 'claimed', at: prev.at || Date.now(),
          offer: prev.offer, license: prev.license, proCheckedAt: Date.now(),
        });
        continue;
      }
      if (st.dryRun) {
        await log(`Fab：[仅扫描] ${upgrading ? '可补专业版' : '可领'} ${title.slice(0, 28)}〔${tier}〕`, 'ok');
        done++;
        continue;
      }

      let ok = false, why = '', status = 0, authFail = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          const fd = new FormData();
          fd.append('offer_id', offer);
          const r = await fetch(`/i/listings/${encodeURIComponent(id)}/add-to-library`, {
            method: 'POST', credentials: 'include', body: fd,
            headers: {
              Accept: 'application/json, text/plain, */*',
              'X-CsrfToken': csrf,
              'X-Requested-With': 'XMLHttpRequest',
            },
          });
          if (r.ok) { ok = true; break; }
          status = r.status;
          let body = '';
          try { body = (await r.text()).slice(0, 160); } catch (e) { /* ignore */ }
          why = `HTTP ${status}${body ? ' ' + body : ''}`;
          if (status === 401) { authFail = true; break; }
          if (status === 429) { await log('Fab：被限流，20s 后重试', 'warn'); await sleep(20000); }
          else if (status === 403) { await log('Fab：CSRF 被拒（cookie 与头不一致），可能是页面 cookie 刚刷新', 'warn'); await sleep(1500); }
          else break;
        } catch (e) { why = e.message; break; }
      }
      if (ok) {
        await setHist(K.fabHist, id, { title, state: 'claimed', at: Date.now(), offer, license: tier });
        await log(`Fab：${upgrading ? '补领专业版' : '领到'} ${title.slice(0, 30)}〔${tier}〕`, 'ok');
        done++;
      } else if (authFail) {
        // 401 = 这个会话没登录/已过期，不是这一条的问题，别再拿后面的条目继续撞
        await setHist(K.fabHist, id, { title, state: 'needs-login', at: Date.now() });
        await log(`Fab：401 未授权 —— 登录态失效，本轮停手（${title.slice(0, 20)}）`, 'warn');
        bigBanner('Fab 登录态失效：登录一次后我会自动接着领', 'rgba(200,120,20,.95)');
        gmNotify('Fab 需要重新登录', 'Fab 领取');
        break;
      } else {
        await setHist(K.fabHist, id, { title, state: 'failed', at: Date.now(), why });
        await log(`Fab：${title.slice(0, 26)} 失败 ${why}`, 'warn');
      }
      await sleep(1200);
    }
    await log(`Fab：本轮结束，处理 ${done} 个`);
    if (done) gmNotify(`本轮领取 ${done} 个 Fab 免费资产`, 'Fab 领取完成');
    ui.busy(false);
  }

  // ══════════════════════════════ Epic 部分 ══════════════════════════════
  // 免费列表：只认「折扣百分比为 0 且当前时间落在 startDate/endDate 之间」，别只看价格。
  function freeWindow(el) {
    const now = Date.now();
    const promos = el.promotions || {};
    // 结构是两层：promotions.promotionalOffers[] = 促销组，组内 promotionalOffers[] 才是
    // 带 startDate/endDate/discountSetting 的具体档位。日期在内层，别在外层找。
    for (const groups of [promos.promotionalOffers, promos.upcomingPromotionalOffers]) {
      for (const group of groups || []) {
        for (const o of group.promotionalOffers || []) {
          const s = Date.parse(o.startDate || '');
          const e = Date.parse(o.endDate || '');
          if (!(now >= s && now <= e)) continue;
          const ds = o.discountSetting || {};
          if (Number(ds.discountPercentage) === 0) return { start: s, end: e };
        }
      }
    }
    return null;
  }

  function offerIdOf(el) {
    const offers = el.items || [];
    const pick = offers.find((i) => i.id) || offers[0];
    if (pick && pick.id) return pick.id;
    return (el.catalogNs && el.catalogNs.mappings && el.catalogNs.mappings[0] &&
      el.catalogNs.mappings[0].pageSlug) || '';
  }

  async function fetchFreeGames() {
    const r = await gmXhr(FREE_API, { Accept: 'application/json' });
    if (r.status !== 200) throw new Error(`免费列表 HTTP ${r.status}`);
    const j = JSON.parse(r.responseText);
    const els = (j.data && j.data.Catalog && j.data.Catalog.searchStore &&
      j.data.Catalog.searchStore.elements) || [];
    const out = [];
    for (const el of els) {
      const win = freeWindow(el);
      if (!win) continue;
      const ns = el.namespace;
      const offer = el.id || offerIdOf(el);
      const slug = (el.catalogNs && el.catalogNs.mappings && el.catalogNs.mappings[0] &&
        el.catalogNs.mappings[0].pageSlug) || el.urlSlug || String(el.productSlug || '').split('/')[0];
      out.push({
        id: offer || slug,
        title: el.title || slug || '(无标题)',
        namespace: ns,
        offerId: offer,
        slug,
        url: `${STORE}/zh-CN/p/${slug}`,
        until: win.end,
        freeEnd: win.end,
      });
    }
    return out;
  }

  function claimUrlFor(g) {
    // 直接开结账页：不用过商品页的年龄闸和侧栏按钮，页内就能点「下单」。
    if (g.namespace && g.offerId) {
      return `${STORE}/zh-CN/purchase?highlightColor=0078f2&offers=1-${g.namespace}-${g.offerId}`
        + `&orderId&purchaseToken&showNavigation=true&efc=claim&efcTitle=${encodeURIComponent(g.title)}`;
    }
    return `${g.url}?efc=claim&efcTitle=${encodeURIComponent(g.title)}`;
  }

  async function epicScan(force) {
    const st = await settings();
    if (!force && !st.autoEpic) return;
    const last = await gmGet(K.lastEpicScan, 0);
    if (!force && Date.now() - last < st.epicScanHours * 3600000) return;
    await gmSet(K.lastEpicScan, Date.now());

    mountPanel('Epic 免费游戏');
    ui.busy(true);
    await log('Epic：拉本周免费列表');
    let games = [];
    try {
      games = await fetchFreeGames();
    } catch (e) {
      await log(`Epic：列表失败 ${e.message}`, 'warn');
      ui.busy(false, true);
      return;
    }
    await log(`Epic：本周免费 ${games.length} 个`);
    if (!games.length) { ui.busy(false); return; }

    const h = await hist(K.epicHist);
    const cool = (st.epicRetryMinutes || 120) * 60000;
    const todo = games.filter((g) => {
      const prev = h[g.id];
      if (!prev) return true;
      // 旧版把「没验证过」也记成 claimed，害得限时免费的再也没碰过 ——
      // 没有 verified 标记的 claimed 一律当作「待复核」，重试一次。
      if (force) return !(prev.state === 'claimed' && prev.verified);
      if (prev.state === 'claimed') return !prev.verified;
      // 其它状态（failed / needs-human / needs-login / skipped-paid）：
      // 免费窗口只有一周，按分钟级冷却重试，别用 retryDays 一睡七天
      return Date.now() - (prev.at || 0) > cool;
    });
    for (const g of games) {
      if (todo.includes(g)) continue;
      const p = h[g.id] || {};
      await log(`Epic：${g.title.slice(0, 24)} 跳过（${p.state}${p.verified ? '·已验证' : ''}，${Math.max(1, Math.round((cool - (Date.now() - (p.at || 0))) / 60000))} 分钟后重试）`);
    }
    if (!todo.length) {
      await log('Epic：本周的都处理过了，没有要开的');
      ui.busy(false);
      return;
    }
    // 限时免费的窗口快关了还没领到 → 明说，别让人以为没事
    const soon = todo.filter((g) => g.freeEnd && g.freeEnd - Date.now() < 48 * 3600000);
    if (soon.length) {
      const names = soon.map((g) => g.title).slice(0, 3).join('、');
      await log(`Epic：还有 ${soon.length} 个 48 小时内到期没领到：${names}`, 'warn');
      bigBanner(`⏳ ${names} 限时免费快结束了，正在重试领取`, 'rgba(200,120,20,.95)');
      gmNotify(`${soon.length} 个限时免费 48h 内到期`, 'Epic 领取提醒');
    }
    if (st.dryRun) {
      for (const g of todo) await log(`Epic：[仅扫描] 可领 ${g.title}`, 'ok');
      ui.busy(false);
      return;
    }

    const batch = todo.slice(0, st.maxEpicPerRun);
    for (const g of todo.slice(st.maxEpicPerRun)) {
      await log(`Epic：${g.title} 超出本轮上限(${st.maxEpicPerRun})，下轮再领`, 'warn');
    }
    let opened = await gmGet(K.openTabs, 0);
    await gmSet(K.openTabs, opened + batch.length);
    for (const g of batch) {
      await log(`Epic：打开领取页 ${g.title.slice(0, 26)}`);
      gmOpenTab(claimUrlFor(g), { active: false });
      await sleep(2500);
    }
    await log(`Epic：已开 ${batch.length} 个标签，进度看那些标签页的面板`);
    if (batch.length) gmNotify(`已打开 ${batch.length} 个 Epic 领取页，正在自动点`, 'Epic 领取');
    ui.busy(false);
  }

  // ── 结账页里的自动点：这是整个脚本最容易随 Epic 改版失效的地方 ──
  const SEL = {
    // 10/2026 改版后侧栏购买按钮只剩 hashed class，data-testid 作为兜底
    purchase: 'button[data-testid="purchase-cta-button"], button[class*="_sidebarBuyButton_"]',
    checkoutFrame: '#webPurchaseContainer iframe, iframe[src*="/checkout"], iframe[src*="purchase"]',
    placeOrder: ['Place Order', 'Place order', '下单', 'Add to library', '添加到库', 'Get', '获取', 'Continue', '继续'],
    ageMonth: '[role="combobox"][aria-label="Month"]',
    eulaCheck: 'input#agree',
  };

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /** 在页面 + 所有同源 iframe 里找按钮（新版结账是同源 /checkout，能直接进 DOM）。 */
  function findButton(texts, root) {
    return findInRoot(texts, root || document, 0);
  }
  function findInRoot(texts, root, depth) {
    const buttons = root.querySelectorAll('button, a[role="button"], [role="button"]');
    for (const b of buttons) {
      const t = (b.innerText || b.textContent || '').trim();
      if (!t || t.length > 40) continue;
      if (!texts.some((x) => t.toLowerCase() === x.toLowerCase() || t.startsWith(x))) continue;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      if (!visible(b)) continue;
      return b;
    }
    if (depth > 2) return null;
    for (const f of root.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (d && d.body) {
          const hit = findInRoot(texts, d, depth + 1);
          if (hit) return hit;
        }
      } catch (e) { /* 跨域 iframe 进不去，忽略 */ }
    }
    return null;
  }

  function pageText(root) {
    const parts = [(root || document).body ? (root || document).body.innerText : ''];
    for (const f of (root || document).querySelectorAll('iframe')) {
      try {
        if (f.contentDocument && f.contentDocument.body) parts.push(f.contentDocument.body.innerText);
      } catch (e) { /* ignore */ }
    }
    return parts.join('\n');
  }

  function priceIsZero() {
    const t = pageText();
    // 硬闸：出现正数金额且没有 0 价标记，就不点
    if (/(¥|￥|\$|€)\s*0(\.00)?\b/.test(t)) return true;
    if (/\b(Free|free|免费|0\.00)\b/.test(t)) return true;
    const num = t.match(/(¥|￥|\$|€)\s*([1-9]\d*(\.\d{2})?)/);
    if (num) return false;
    return null; // 没找到价格信息 → 未知
  }

  function captchaPresent() {
    const has = (root) => !!root.querySelector(
      'iframe[src*="hcaptcha"], #h_captcha_challenge_checkout_free_prod, .h_captcha_challenge, iframe[src*="turnstile"]');
    if (has(document)) return true;
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument && has(f.contentDocument)) return true; } catch (e) { /* ignore */ }
    }
    return false;
  }

  async function waitFor(fn, timeoutMs, stepMs) {
    const t0 = Date.now();
    const step = stepMs || 500;
    while (Date.now() - t0 < timeoutMs) {
      try { const v = fn(); if (v) return v; } catch (e) { /* ignore */ }
      await sleep(step);
    }
    return null;
  }

  function bigBanner(text, color) {
    let el = document.getElementById('efc-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'efc-banner';
      el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;'
        + 'font:14px/1.6 "Microsoft YaHei",sans-serif;padding:10px 18px;border-radius:10px;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.5);color:#fff;max-width:80vw;text-align:center;';
      document.body.appendChild(el);
    }
    el.style.background = color || 'rgba(200,40,60,.95)';
    el.textContent = text;
    el.style.display = 'block';
    return el;
  }
  function hideBanner() {
    const el = document.getElementById('efc-banner');
    if (el) el.style.display = 'none';
  }

  // 领取成功的**硬证据**只有两种：订单完成文案，或侧栏 CTA 变成「已在库」。
  // 曾经把 'Download the Epic Games Launcher'（结账页常驻推广文案）也当成功，
  // 结果限时免费的条目被记成 claimed、再也没重试过 —— 别再加这种泛文案。
  function successText(t) {
    return /Thanks for your order|It's all yours|下单成功|感谢您的订单|感谢你的订单/i.test(String(t || ''));
  }
  function ownedCtaText(t) {
    return /in library|已在库|已加入库/i.test(String(t || ''));
  }

  async function epicClaimInThisTab(g) {
    const title = g.title || '未知游戏';
    mountPanel(`领取：${title.slice(0, 14)}`);
    ui.busy(true);
    await log(`Epic：处理 ${title}`);

    // 0) 会话过期：Epic 会把人踢到登录页
    if (location.pathname.includes('/id/login')) {
      await setHist(K.epicHist, g.id, { title, state: 'needs-login', at: Date.now() });
      await log('Epic：被踢到登录页，需要重新登录 Epic 账号', 'warn');
      bigBanner('需要重新登录 Epic，登录后刷新本页');
      ui.busy(false, true);
      return;
    }

    // 1) 找并点领取按钮：结账页里是 Place Order / Add to library；
    //    带年龄闸时页面上先只有 Continue，那就先过年龄闸再来。
    const CLAIM_LABELS = ['Place Order', 'Place order', '下单', 'Add to library', '添加到库', 'Get', '获取'];
    const AGE_LABELS = ['Continue', '继续'];
    let clicked = 0;
    let label = '';
    let owned = false;
    const deadline = Date.now() + 60000;

    while (Date.now() < deadline && clicked === 0) {
      if (findButton(['In Library', '已在库', 'Already in library'])) { owned = true; break; }
      const b = findButton(CLAIM_LABELS);
      if (b) {
        label = (b.innerText || '').trim();
        // 2) 硬闸：必须是 0 元。明确读到要付钱就停手，读不到价格只告警。
        const zero = priceIsZero();
        if (zero === false) {
          await setHist(K.epicHist, g.id, { title, state: 'skipped-paid', at: Date.now() });
          await log(`Epic：${title} 页面显示要付钱，放弃（安全闸）`, 'warn');
          bigBanner('这一页显示要付钱，脚本不动手', 'rgba(200,120,20,.95)');
          ui.busy(false, true);
          return;
        }
        if (zero === null) await log('Epic：没读到价格，但按钮文案是领取类，继续', 'warn');

        // 3) 点下去
        try {
          b.scrollIntoView({ block: 'center' });
          await sleep(300);
          b.click();
          clicked++;
          await log(`Epic：点了「${label}」`);
        } catch (e) {
          await setHist(K.epicHist, g.id, { title, state: 'failed', at: Date.now(), why: 'click ' + e.message });
          await log(`Epic：点击失败 ${e.message}`, 'warn');
          ui.busy(false, true);
          return;
        }
        await sleep(2500);
        break;
      }
      const cont = findButton(AGE_LABELS);
      if (cont) {
        try { cont.click(); await log('Epic：先过一次年龄闸（Continue）'); } catch (e) { /* ignore */ }
        await sleep(2500);
        continue;
      }
      await sleep(800);
    }

    if (owned) {
      await setHist(K.epicHist, g.id, { title, state: 'claimed', at: Date.now(), note: '早已在库', verified: true });
      await log(`Epic：${title} 已在库`);
      ui.busy(false);
      return;
    }
    if (clicked === 0) {
      const t = pageText();
      if (/sign in|登录|Account id is missing/i.test(t)) {
        await setHist(K.epicHist, g.id, { title, state: 'needs-login', at: Date.now() });
        await log('Epic：页面要求登录（Account id is missing / 登录），请在浏览器里登一次', 'warn');
        bigBanner('需要登录 Epic 才能领取，登录后刷新');
        ui.busy(false, true);
        return;
      }
      await setHist(K.epicHist, g.id, { title, state: 'failed', at: Date.now(), why: '没等到领取按钮' });
      await log('Epic：60 秒没等到领取按钮（选择器可能又变了，把这一页截图给桃夭）', 'warn');
      bigBanner('没找到领取按钮 — 把这一页截图发给桃夭', 'rgba(200,120,20,.95)');
      ui.busy(false, true);
      return;
    }

    // 4) EU 账号会出现 I Accept；EULA 复选框也顺手勾上
    const acc = findButton(['I Accept', 'I Agree', '接受', '同意']);
    if (acc) { acc.click(); await log('Epic：点了条款同意'); await sleep(1500); }
    const eula = document.querySelector(SEL.eulaCheck);
    if (eula && !eula.checked) {
      eula.checked = true;
      eula.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 5) 等结果：成功文案 / 侧栏变 In Library / 出验证码
    let captchaNotified = false;
    const result = await waitFor(() => {
      const t = pageText();
      if (successText(t)) return 'ok';
      const cta = document.querySelector(SEL.purchase);
      if (cta && ownedCtaText(cta.innerText || '')) return 'ok';
      if (captchaPresent()) return 'captcha';
      return null;
    }, CAPTCHA_WAIT_MS, 1500);

    if (result === 'captcha' && !captchaNotified) {
      captchaNotified = true;
      await log('Epic：出现真人验证，等你点一下', 'warn');
      bigBanner('⚠️ 请在这个标签页完成真人验证 —— 我就停这儿等它');
      gmNotify('Epic 弹出真人验证，请点开那个标签页完成', '需要你点一下');
    }

    if (result === 'ok') {
      await setHist(K.epicHist, g.id, { title, state: 'claimed', at: Date.now(), verified: true });
      await log(`Epic：${title} 领取成功 ✅`, 'ok');
      bigBanner(`✅ ${title} 已入库`, 'rgba(30,140,80,.95)');
      gmNotify(`${title} 已领取`, 'Epic 领取成功');
      await sleep(4000);
      hideBanner();
      await closeSelfIfOpened();
    } else if (result === 'captcha') {
      // 卡在验证码：不判失败，等你处理完再刷新本页重试
      await setHist(K.epicHist, g.id, { title, state: 'needs-human', at: Date.now() });
      await log('Epic：卡在真人验证，已记 needs-human；你过完验证码后可点「立即扫描本轮」重试', 'warn');
      ui.busy(false, true);
    } else {
      await setHist(K.epicHist, g.id, { title, state: 'failed', at: Date.now(), why: '等结果超时' });
      await log('Epic：5 分钟没等到成功提示，记失败；截图发给桃夭看卡在哪', 'warn');
      bigBanner('没等到成功提示 — 把这一页截图发给桃夭', 'rgba(200,120,20,.95)');
      ui.busy(false, true);
    }
  }

  async function closeSelfIfOpened() {
    const n = await gmGet(K.openTabs, 0);
    if (n > 0) {
      await gmSet(K.openTabs, n - 1);
      setTimeout(() => { try { window.close(); } catch (e) { /* 手动开的标签关不掉，正常 */ } }, 1200);
    }
  }

  // ══════════════════════════════ 入口 ══════════════════════════════
  function parseArgs() {
    const q = new URLSearchParams(location.search);
    return { claim: q.get('efc') === 'claim', title: q.get('efcTitle') || '' };
  }

  async function boot() {
    const host = location.hostname;
    const args = parseArgs();

    // 领取标签页（我们自己开的）
    if (args.claim && host.endsWith('epicgames.com')) {
      const games = await fetchFreeGames().catch(() => []);
      const hit = games.find((g) => (location.search.includes(g.offerId || '###'))) || {
        id: location.search, title: args.title || '未知游戏',
      };
      await epicClaimInThisTab(hit);
      return;
    }

    if (host.endsWith('fab.com')) {
      if (location.pathname.startsWith('/login') || location.pathname.startsWith('/signin')) return;
      mountPanel('Fab 免费资产');
      await fabRun(false);
      return;
    }
    if (host.endsWith('epicgames.com')) {
      // 登录页 / 账号页不打扰，免得你正在登号时脚本在后台开领取标签
      if (location.pathname.startsWith('/id/') || location.pathname.startsWith('/account')) return;
      mountPanel('Epic 免费游戏');
      await epicScan(false);
      // 我们自己开出来做扫描的后台标签，扫完就关掉，别留在标签栏里
      if (new URLSearchParams(location.search).get('efc') === 'scan') await closeSelfIfOpened();
      return;
    }

    // 其他站点：每天第一次打开浏览器时，静默开一个后台标签去扫 Epic
    const st = await settings();
    if (!st.autoEpic) return;
    const lastOpen = await gmGet(K.lastAutoOpen, 0);
    if (Date.now() - lastOpen < st.epicScanHours * 3600000) return;
    const lastScan = await gmGet(K.lastEpicScan, 0);
    if (Date.now() - lastScan < st.epicScanHours * 3600000) return;  // 刚扫过，别开空标签
    await gmSet(K.lastAutoOpen, Date.now());
    const n = await gmGet(K.openTabs, 0);
    await gmSet(K.openTabs, n + 1);
    gmOpenTab(`${STORE}/zh-CN/free-games?efc=scan`, { active: false });
  }

  // 给离线自测留出口（node 里 stub 一个 window 就能验纯逻辑，不影响正常使用）
  window.__efcInternals = { freeWindow, priceIsZero, claimUrlFor, SEL, tierRank, isProTier, successText, ownedCtaText };

  // 单页只跑一次；Epic 站内路由切换不重复触发
  if (window.__efcBooted) return;
  window.__efcBooted = true;
  boot().catch((e) => console.error('[EFC] boot 失败', e));
})();
