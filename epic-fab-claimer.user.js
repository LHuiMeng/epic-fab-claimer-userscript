// ==UserScript==
// @name         Epic/Fab 免费领取助手
// @namespace    ruindream.efc
// @version      1.6.1
// @description  打开浏览器就自动扫 Epic 每周免费 + Fab 免费/限时免费并领取；限时免费走 0 元购物车结算；结果用角落悬浮窗汇报，点 ✕ 当天不再提醒。
// @author       桃夭
// @homepageURL  https://github.com/LHuiMeng/epic-fab-claimer-userscript
// @supportURL   https://github.com/LHuiMeng/epic-fab-claimer-userscript/issues
// @updateURL    https://ghproxy.net/https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js
// @downloadURL  https://ghproxy.net/https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js
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
// @grant        GM_registerMenuCommand
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
    daily: 'efc:daily',        // 当天汇总（跨标签共享）
    toastOff: 'efc:toastOff',  // 用户点 X 的日期，当天不再弹
    toastShown: 'efc:toastShown', // 当天已弹次数，别每开一个标签就弹一次
  };
  const VERSION = '1.6.1';
  const DEF_SETTINGS = {
    autoEpic: true,      // 每日首次自动扫 Epic
    autoFab: true,       // 打开 Fab 时自动领
    maxEpicPerRun: 3,    // 每轮最多开 3 个领取页
    maxFabPerRun: 25,    // 每轮最多领多少个 Fab 资产
    fabConcurrency: 3,   // 并发领取数（1 = 串行；6~8 更快，但容易被限流）
    retryDays: 7,        // Fab 失败条目的冷却天数
    epicRetryMinutes: 120, // Epic 未领到的条目多久重试一次（限时免费等不起 7 天）
    logOwned: false,     // 已在库（领过了）的条目要不要写日志；默认不写，免得刷屏
    fabListPages: 20,    // Fab 免费列表翻几页（每页 24 条；Fab 上免费资产有 900+ 条）
    libPages: 20,        // 拉库时翻几页（每页 24 条），用于判断"已在库"
    toastEnabled: true,  // 右下角浮窗总开关
    toastMaxPerDay: 3,   // 每天最多主动弹几次（0 = 只写面板/日志）
    notifyFail: true,    // 领取失败时发系统通知
    dryRun: false,       // 只扫描不点领取
    epicScanHours: 24,   // Epic 自动扫的间隔
    fabScanHours: 6,     // Fab 自动领的间隔
  };
  const FREE_API = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions'
    + '?locale=zh-CN&country=CN&allowCountries=CN';
  // 主更新通道：ghproxy 直通 raw（国内可直连、没有 CDN 分支缓存）
  const CDN_URL = 'https://ghproxy.net/https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js';
  // 备用镜像：jsDelivr（分支文件有最长 12h 缓存，只当兜底）
  const CDN_URL_FALLBACK = 'https://fastly.jsdelivr.net/gh/LHuiMeng/epic-fab-claimer-userscript@main/epic-fab-claimer.user.js';
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
  // 失败类通知受设置里「失败时发系统通知」控制；成功类仍直接 gmNotify
  function notifyFail(text, title) {
    if (stCache && stCache.notifyFail === false) return;
    gmNotify(text, title);
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
  let stCache = null;
  async function settings() {
    stCache = normalizeSettings(await gmGet(K.settings, {}));
    return stCache;
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
          <div class="row"><button data-act="openSettings">⚙ 设置</button></div>
          <div class="row"><button data-act="logowned">领过日志：关</button></div>
          <div id="log"></div>
          <div class="hint"></div>
        </div>
      </div>`;
    const box = root.querySelector('.box');
    const dot = root.querySelector('.dot');
    const logEl = root.querySelector('#log');
    const hintEl = root.querySelector('.hint');
    root.querySelector('b').textContent = `${title} · v${VERSION}`;
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
        const btnOwned = root.querySelector('[data-act="logowned"]');
        if (btnOwned) btnOwned.textContent = `领过日志：${st.logOwned ? '开' : '关'}`;
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
    root.querySelector('[data-act="openSettings"]').addEventListener('click', () => { openSettings(); });
    root.querySelector('[data-act="logowned"]').addEventListener('click', async () => {
      const st = await settings();
      await gmSet(K.settings, Object.assign({}, st, { logOwned: !st.logOwned }));
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

  // 免费有两种，实测两手都要认：
  // 1. 永久免费 priceTier.price === 0
  // 2. 限时免费 priceTier.price 是原价，但 discountedPrice === 0 /
  //    effectiveDiscountPercentage === 100，且当前落在 discountStartDate~discountEndDate 之间
  function freeUntilOf(l) {
    const pt = (l && l.priceTier) || {};
    const now = Date.now();
    if (typeof pt.price === 'number' && pt.price === 0) return { free: true, until: null };
    const zeroNow = (typeof pt.discountedPrice === 'number' && pt.discountedPrice === 0)
      || pt.effectiveDiscountPercentage === 100;
    if (!zeroNow) return { free: false, until: null };
    const s = pt.discountStartDate ? Date.parse(pt.discountStartDate) : 0;
    const e = pt.discountEndDate ? Date.parse(pt.discountEndDate) : 0;
    if (s && now < s) return { free: false, until: null };
    if (e && now > e) return { free: false, until: null };
    return { free: true, until: e || null };
  }

  // ══════════════════════════ 每日汇总 + 悬浮窗 ══════════════════════════
  const FAB_HOME = 'https://www.fab.com';

  function dayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function dailyGet() {
    const d = await gmGet(K.daily, null);
    if (!d || d.day !== dayKey()) return { day: dayKey(), startedAt: 0, epic: null, fab: null };
    return d;
  }

  async function dailyPatch(site, patch) {
    const d = await dailyGet();
    d.day = dayKey();
    d[site] = Object.assign({}, d[site] || {}, patch, { at: Date.now() });
    await gmSet(K.daily, d);
    return d;
  }

  function toastHide() {
    const el = document.getElementById('efc-toast');
    if (el) el.remove();
  }

  // 不抢焦点的角落浮窗：只在自身区域吃点击，不遮页面、不弹模态
  function showToast(title, lines, opts) {
    const o = opts || {};
    if (stCache && stCache.toastEnabled === false) return;   // 设置里关掉就彻底静默
    let el = document.getElementById('efc-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'efc-toast';
      el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;max-width:340px;'
        + 'font:13px/1.65 "Microsoft YaHei",system-ui,sans-serif;color:#f0f1f4;background:rgba(22,24,30,.95);'
        + 'border:1px solid rgba(255,255,255,.13);border-radius:10px;padding:9px 12px;'
        + 'box-shadow:0 8px 28px rgba(0,0,0,.45);text-align:left;';
      document.body.appendChild(el);
    }
    el.textContent = '';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-weight:600;margin-bottom:3px;';
    const t = document.createElement('span');
    t.textContent = title;
    t.style.flex = '1';
    const x = document.createElement('span');
    x.textContent = '✕';
    x.title = '今天不再提醒';
    x.style.cssText = 'cursor:pointer;opacity:.5;font-weight:400;padding:0 2px;';
    x.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await gmSet(K.toastOff, dayKey());
      toastHide();
    });
    head.appendChild(t);
    head.appendChild(x);
    el.appendChild(head);
    for (const ln of lines || []) {
      const row = document.createElement('div');
      row.textContent = ln.text;
      const color = ln.tone === 'bad' ? '#ff9a9a'
        : ln.tone === 'warn' ? '#ffd48a'
          : ln.tone === 'ok' ? '#8fe3a5' : '#e8e9ec';
      row.style.cssText = `opacity:${ln.dim ? '.72' : '1'};color:${color};`;
      el.appendChild(row);
    }
    if (!o.keep) {
      setTimeout(() => { if (document.getElementById('efc-toast') === el) toastHide(); }, 25000);
    }
  }

  function summaryLines(d) {
    const out = [];
    const e = d.epic;
    const f = d.fab;
    if (e) {
      if (!e.listed) out.push({ text: 'Epic：本周没有免费游戏', dim: true });
      else if (e.opened) out.push({ text: `Epic：本周 ${e.listed} 个，已开 ${e.opened} 个领取页自动点`, tone: 'ok' });
      else out.push({ text: `Epic：本周 ${e.listed} 个，都领过了`, dim: true });
      for (const t of (e.failed || []).slice(0, 2)) out.push({ text: `✗ ${t}`, tone: 'bad' });
    }
    if (f) {
      if (f.skipped) out.push({ text: 'Fab：今天已检查过（在冷却期内）', dim: true });
      else {
        if ((f.claimed || []).length) {
          out.push({ text: `Fab：领到 ${f.claimed.length} 个`, tone: 'ok' });
          for (const t of f.claimed.slice(0, 3)) out.push({ text: `· ${t}`, dim: true });
        }
        if (f.ownedCount) out.push({ text: `Fab：${f.ownedCount} 个早就在库里（领过了）`, dim: true });
        if (f.noTierCount) out.push({ text: `Fab：${f.noTierCount} 个现在不免费（折扣已过）`, dim: true });
        if (!(f.claimed || []).length && !f.ownedCount) {
          out.push({ text: f.listed ? 'Fab：没有新的免费条目' : 'Fab：暂时没有免费条目', dim: true });
        }
      }
      for (const t of (f.failed || []).slice(0, 2)) out.push({ text: `✗ ${t.title || t}`, tone: 'bad' });
    }
    if (!out.length) out.push({ text: '没有可领取的', dim: true });
    return out;
  }

  function sitesDone(d, st) {
    if (st.autoEpic && !(d.epic && d.epic.done)) return false;
    if (st.autoFab && !(d.fab && d.fab.done)) return false;
    return !!(d.epic || d.fab);
  }

  // 在任意网站上跑：今天第一次 → 开两个后台标签去扫；已有结果 → 直接汇报
  async function dailyCheck(skipSite) {
    const st = await settings();
    if (!st.autoEpic && !st.autoFab) return;
    if ((await gmGet(K.toastOff, '')) === dayKey()) return;   // 今天被 X 掉了
    const d = await dailyGet();
    if (d.day === dayKey() && sitesDone(d, st)) {
      // 同一天最多主动弹 3 次，别每开一个标签页都糊一脸
      const shown = await gmGet(K.toastShown, {});
      const n = shown.day === dayKey() ? shown.n : 0;
      const cap = Number.isFinite(st.toastMaxPerDay) ? st.toastMaxPerDay : 3;
      if (n < cap) {
        await gmSet(K.toastShown, { day: dayKey(), n: n + 1 });
        showToast('免费内容检查完毕', summaryLines(d));
      }
      return;
    }
    if (d.startedAt && Date.now() - d.startedAt < 10 * 60000) {   // 正在跑，等结果
      pollDaily(st);
      return;
    }
    const mine = Date.now();
    await gmSet(K.daily, {
      day: dayKey(), startedAt: mine,
      epic: d.epic || null, fab: d.fab || null,
    });
    // 多个标签同时恢复时可能一起进这儿，抢到的那个才继续，别开两套标签
    const again = await dailyGet();
    if (again.startedAt !== mine) return;
    let opened = 0;
    const needEpic = st.autoEpic && !(d.epic && d.epic.done) && skipSite !== 'epic';
    const needFab = st.autoFab && !(d.fab && d.fab.done) && skipSite !== 'fab';
    if (needEpic) { gmOpenTab(`${STORE}/zh-CN/free-games?efc=scan`, { active: false }); opened++; }
    if (needFab) { gmOpenTab(`${FAB_HOME}/limited-time-free?efc=scan`, { active: false }); opened++; }
    if (!opened) return;
    const n = await gmGet(K.openTabs, 0);
    await gmSet(K.openTabs, n + opened);
    showToast('正在检查免费内容…', [{ text: 'Epic 每周免费 + Fab 免费/限时免费', dim: true }], { keep: true });
    pollDaily(st);
  }

  async function pollDaily(st) {
    for (let i = 0; i < 45; i++) {
      await sleep(4000);
      if ((await gmGet(K.toastOff, '')) === dayKey()) return;
      const d = await dailyGet();
      if (sitesDone(d, st)) {
        const anyBad = (d.epic && (d.epic.failed || []).length) || (d.fab && (d.fab.failed || []).length);
        showToast(anyBad ? '有项目领取失败' : '免费内容检查完毕', summaryLines(d));
        if (anyBad) notifyFail('有免费内容没领到，点开面板看原因', 'Epic/Fab 领取');
        return;
      }
      showToast('正在检查免费内容…', [{ text: `${d.epic ? 'Epic 已扫' : 'Epic 扫描中'} · ${d.fab ? 'Fab 已扫' : 'Fab 扫描中'}`, dim: true }], { keep: true });
    }
    showToast('检查超时', [{ text: '没等到结果，点面板「立即扫描本轮」重试', tone: 'warn' }]);
  }

  async function fabRun(force) {
    const st = await settings();
    if (!force && !st.autoFab) return;
    const last = await gmGet(K.lastFabScan, 0);
    if (!force && Date.now() - last < st.fabScanHours * 3600000) {
      await dailyPatch('fab', { done: true, skipped: true, listed: 0 });
      return;
    }
    await gmSet(K.lastFabScan, Date.now());

    mountPanel('Fab 免费资产');
    ui.busy(true);
    await log(`Fab：开始扫描（同源接口）`);

    const csrf = cookieVal('fab_csrftoken');
    if (!csrf) {
      await log('Fab：没有 fab_csrftoken cookie，可能未登录 — 本次跳过', 'warn');
      await dailyPatch('fab', { done: true, listed: 0, claimed: [],
        failed: [{ title: 'Fab 未登录', reason: '没有 fab_csrftoken' }] });
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
        await dailyPatch('fab', { done: true, listed: 0, claimed: [],
          failed: [{ title: 'Fab 未登录', reason: `/i/users/me ${r.status}` }] });
        ui.busy(false, true);
        return;
      }
    } catch (e) {
      await log(`Fab：登录态检查失败 ${e.message}`, 'warn');
    }
    if (me) await log(`Fab：已登录 ${me.displayName || me.username || ''}`);

    // ── 列表：两条口子 + 翻页（Fab 每页固定 24 条，count 传大也没用）──
    let items = [];
    let listPages = 0;
    let listTruncated = false;
    try {
      const sources = [
        // 限时免费只在 100% 折扣这条里出现，必须单独捞
        'min_discount_percentage=100',
        'is_free=1',
      ];
      const seen = new Set();
      const pageCap = Math.max(1, Math.min(40, st.fabListPages || 10));
      for (const qs of sources) {
        let cursor = '';
        for (let page = 0; page < pageCap; page++) {
          const url = `/i/listings/search?${qs}&count=24&sort_by=-createdAt`
            + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
          const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!r.ok) {
            await log(`Fab：列表 ${qs} 第 ${page + 1} 页 → HTTP ${r.status}`, 'warn');
            break;
          }
          const j = await r.json();
          const rows = j.results || j.listings || [];
          for (const it of rows) {
            const id = it.uid || it.id;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            items.push(it);
          }
          listPages++;
          cursor = (j.cursors && j.cursors.next) || '';
          if (!cursor || !rows.length) break;
          if (page === pageCap - 1 && cursor) listTruncated = true;
        }
      }
      items.sort((a, b) => {
        // 会过期的先处理：限时免费的排前面
        const la = a.hasEffectiveDiscounts || a.isDiscounted ? 0 : 1;
        const lb = b.hasEffectiveDiscounts || b.isDiscounted ? 0 : 1;
        return la - lb;
      });
    } catch (e) {
      await log(`Fab：列表失败 ${e.message}`, 'warn');
      await dailyPatch('fab', { done: true, listed: 0, claimed: [],
        failed: [{ title: 'Fab 列表拉取失败', reason: e.message }] });
      ui.busy(false, true);
      return;
    }
    await log(`Fab：免费候选 ${items.length} 个（翻了 ${listPages} 页${listTruncated ? '，到页数上限了' : ''}）`);

    // ── 库：一次翻完，本地比对 ──
    // 关键：已经在库里的条目**一个请求都不发**（不发详情、不发 add-to-library、也不逐条查库）。
    // 逐条查 /i/library/search 是每条一次请求，几百个条目就是几百次 —— 这里改成先拉全库。
    const lib = await libraryTitleSet(st);
    await log(`Fab：库里有 ${lib.count} 条（翻了 ${lib.pages} 页${lib.truncated ? '，到页数上限了' : ''}）`);

    const h = await hist(K.fabHist);
    let done = 0;
    let ownedCount = 0;
    let noTierCount = 0;
    const dailyClaimed = [];
    const dailyOwned = [];
    const dailyFailed = [];
    let authFailStop = false;

    // ── 1) 本地先筛：不发任何请求就能确定跳过的都在这儿处理 ──
    const todo = [];
    for (const it of items) {
      const id = it.uid || it.id;
      const title = it.title || '(无标题)';
      const prev = h[id];
      if (libHas(lib, title)) {
        await setHist(K.fabHist, id, { title, state: 'claimed', verified: true, at: (prev && prev.at) || Date.now() });
        dailyOwned.push(title);
        ownedCount++;
        if (st.logOwned) await log(`Fab：${title.slice(0, 26)} 已在库里（领过了），跳过`);
        continue;
      }
      let upgrading = false;
      if (prev && prev.state === 'claimed') {
        // 已经领过：只有在「当初拿的不是专业版」时才回头补专业版，别重复下单
        if (isProTier(prev.license)) continue;
        if (!force && prev.proCheckedAt && Date.now() - prev.proCheckedAt < st.retryDays * 864e5) continue;
        upgrading = true;
      }
      // 手动扫描：失败/待登录的都重试；自动跑：needs-login 也不受冷却限制
      if (prev && prev.state !== 'claimed' && !force && prev.state !== 'needs-login' && recentlyTried(prev, st.retryDays)) continue;
      todo.push({ id, title, prev, upgrading });
    }
    const conc = Math.max(1, Math.min(8, Number(st.fabConcurrency) || 3));
    await log(`Fab：需要处理 ${todo.length} 个，并发 ${conc}（其余已在库或冷却中）`);

    // ── 2) 并发领取 ──
    async function claimOne(entry) {
      const { id, title, prev, upgrading } = entry;
      let offer = null;
      let tier = '';
      let lic = null;
      let until = null;
      try {
        const d = await fetch(`/i/listings/${encodeURIComponent(id)}`, {
          credentials: 'include', headers: { Accept: 'application/json' },
        });
        if (d.ok) {
          const det = await d.json();
          const free = [];
          for (const l of det.licenses || []) {
            const fu = freeUntilOf(l);
            if (!fu.free) continue;
            free.push(l);
            l.__until = fu.until;
          }
          // 专业版优先；专业版要钱时才退而领个人版
          free.sort((a, b) => tierRank(a) - tierRank(b));
          if (free.length) {
            lic = free[0];
            offer = lic.offerId;
            tier = lic.name || '';
            until = lic.__until || null;
          }
        }
      } catch (e) { /* 落到下面统一记失败 */ }

      if (!offer) {
        await setHist(K.fabHist, id, { title, state: 'no-free-tier', at: Date.now() });
        await log(`Fab：${title.slice(0, 28)} 当前没有免费档位（原价/折扣已过），跳过`, 'warn');
        noTierCount++;
        return;
      }
      const tierLabel = until ? `${tier}·限时到 ${new Date(until).toLocaleDateString('zh-CN')}` : tier;
      if (upgrading && !isProTier(lic || tier)) {
        // 专业版仍然要钱 → 保持个人版；记下检查时间，省得每轮都去问一遍
        await setHist(K.fabHist, id, {
          title, state: 'claimed', at: prev.at || Date.now(),
          offer: prev.offer, license: prev.license, proCheckedAt: Date.now(),
        });
        return;
      }
      if (st.dryRun) {
        await log(`Fab：[仅扫描] ${upgrading ? '可补专业版' : '可领'} ${title.slice(0, 28)}〔${tierLabel}〕`, 'ok');
        done++;
        return;
      }

      let ok = false, why = '', status = 0, authFail = false, needCart = false;
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
          // 限时免费回 400 "Not free."、打包(bundle)回 400 "Listing is a bundle."，
          // 两者 add-to-library 都不认，改走购物车结算；购物车自己校验 0 元，多试一次没有风险。
          if ((status === 400 || status === 409 || status === 422)
            && (until || /not free|bundle|免费|free/i.test(body))) { needCart = true; break; }
          if (status === 429) { await log('Fab：被限流，20s 后重试', 'warn'); await sleep(20000); }
          else if (status === 403) { await log('Fab：CSRF 被拒（cookie 与头不一致），可能是页面 cookie 刚刷新', 'warn'); await sleep(1500); }
          else break;
        } catch (e) { why = e.message; break; }
      }
      if (!ok && needCart && lic) {
        // 购物车链路：加购 → 校验 totalPrice.discountPrice 必须是 0 → validate → finalize
        const res = await fabClaimViaCart(id, lic, csrf, title);
        ok = res.ok;
        why = res.why || why;
      }
      if (ok) {
        const rec = { title, state: 'claimed', at: Date.now(), offer, license: tier };
        if (until) rec.until = until;
        await setHist(K.fabHist, id, rec);
        await log(`Fab：${upgrading ? '补领专业版' : '领到'} ${title.slice(0, 30)}〔${tierLabel}〕`, 'ok');
        dailyClaimed.push(title);
        lib.set.add(normT(title));
        done++;
      } else if (authFail) {
        // 401 = 这个会话没登录/已过期，不是这一条的问题，别再拿后面的条目继续撞
        await setHist(K.fabHist, id, { title, state: 'needs-login', at: Date.now() });
        await log(`Fab：401 未授权 —— 登录态失效，本轮停手（${title.slice(0, 20)}）`, 'warn');
        bigBanner('Fab 登录态失效：登录一次后我会自动接着领', 'rgba(200,120,20,.95)');
        notifyFail('Fab 需要重新登录', 'Fab 领取');
        dailyFailed.push({ title, reason: '未登录' });
        authFailStop = true;
      } else {
        await setHist(K.fabHist, id, { title, state: 'failed', at: Date.now(), why });
        await log(`Fab：${title.slice(0, 26)} 失败 ${why}`, 'warn');
        dailyFailed.push({ title, reason: why });
      }
    }

    let nextIdx = 0;
    let inFlight = 0;
    async function worker() {
      while (!authFailStop && done + inFlight < st.maxFabPerRun) {
        const i = nextIdx++;
        if (i >= todo.length) return;
        inFlight++;
        try {
          await claimOne(todo[i]);
        } finally {
          inFlight--;
        }
        await sleep(200 + Math.random() * 200);   // 并发之间的抖动，别踩同一个节拍
      }
    }
    await Promise.all(Array.from({ length: conc }, () => worker()));

    await log(`Fab：本轮结束 —— 新领 ${done} 个 / 已在库 ${ownedCount} 个 / 无免费档 ${noTierCount} 个 / 失败 ${dailyFailed.length} 个`);
    if (done) gmNotify(`本轮领取 ${done} 个 Fab 免费资产`, 'Fab 领取完成');
    await dailyPatch('fab', {
      done: true, listed: items.length, claimed: dailyClaimed,
      owned: dailyOwned, ownedCount, noTierCount, failed: dailyFailed,
    });
    ui.busy(false);
  }

  // ── 标题归一化：HTML 里 & 是 &amp;、' 是 &#x27;，不归一化就会漏匹配 ──
  function normT(x) {
    return String(x || '')
      .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ── 一次性把整库标题拉成 Set ──
  // Fab 每页固定 24 条，用 cursors.next 翻；这样"这条在不在库里"是纯本地判断，
  // 已拥有的条目一个请求都不发（这是主人明确要的行为）。
  async function libraryTitleSet(st) {
    const set = new Set();
    const cap = Math.max(1, Math.min(40, st.libPages || 20));
    let cursor = '';
    let pages = 0;
    let truncated = false;
    for (let i = 0; i < cap; i++) {
      const url = `/i/library/search?count=24` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      let r;
      try {
        r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      } catch (e) { break; }
      if (!r.ok) break;
      let j;
      try { j = await r.json(); } catch (e) { break; }
      const rows = j.results || [];
      for (const row of rows) {
        const t = normT((row.listing && row.listing.title) || row.title || '');
        if (t) set.add(t);
      }
      pages++;
      cursor = (j.cursors && j.cursors.next) || '';
      if (!cursor || !rows.length) break;
      if (i === cap - 1 && cursor) truncated = true;
    }
    return { set, count: set.size, pages, truncated };
  }

  // 库里的标题常被截断，所以先全等比，再按 24 字前缀比
  function libHas(lib, title) {
    const want = normT(title);
    if (!want) return false;
    if (lib.set.has(want)) return true;
    const head = want.slice(0, 24);
    if (head.length < 12) return false;
    for (const t of lib.set) {
      if (t.startsWith(head)) return true;
      if (t.length >= 12 && head.startsWith(t.slice(0, 24))) return true;
    }
    return false;
  }

  // 限时免费专用：走购物车结算。**任何一个环节不是 0 元就撤单**，绝不动钱。
  async function fabClaimViaCart(listingId, lic, csrf, title) {
    const H = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'X-CsrfToken': csrf,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const drop = async () => {
      try {
        const cart = await (await fetch('/i/cart', { credentials: 'include', headers: { Accept: 'application/json' } })).json();
        for (const it of (cart.items || [])) {
          if (it.listingUid === listingId) {
            await fetch(`/i/cart/items/${encodeURIComponent(it.uid)}`, { method: 'DELETE', credentials: 'include', headers: H });
          }
        }
      } catch (e) { /* ignore */ }
    };
    try {
      const add = await fetch('/i/cart/items', {
        method: 'POST', credentials: 'include', headers: H,
        body: JSON.stringify({ listingLicense: lic.listingLicenseId }),
      });
      if (!add.ok) return { ok: false, why: `加购 HTTP ${add.status}` };
      const cart = await (await fetch('/i/cart', { credentials: 'include', headers: { Accept: 'application/json' } })).json();
      const total = cart && cart.totalPrice ? cart.totalPrice.discountPrice : null;
      if (!(total === 0)) {
        await drop();
        return { ok: false, why: `购物车合计 ${total}，不是 0 元 —— 已撤单` };
      }
      const v = await fetch('/i/cart/validate', {
        method: 'POST', credentials: 'include', headers: H,
        body: JSON.stringify({ offer_ids: [lic.offerId] }),
      });
      if (!v.ok) { await drop(); return { ok: false, why: `validate HTTP ${v.status}` }; }
      const f = await fetch('/i/payment/finalize', {
        method: 'POST', credentials: 'include', headers: H,
        body: JSON.stringify({ offer_ids: [lic.offerId] }),
      });
      await drop();
      if (!f.ok) return { ok: false, why: `finalize HTTP ${f.status}` };
      await log(`Fab：${title.slice(0, 24)} 走购物车结算成功（0 元）`, 'ok');
      return { ok: true };
    } catch (e) {
      await drop();
      return { ok: false, why: '购物车流程 ' + e.message };
    }
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
    if (!force && Date.now() - last < st.epicScanHours * 3600000) {
      await dailyPatch('epic', { done: true, skipped: true, listed: 0, opened: 0, failed: [] });
      return;
    }
    await gmSet(K.lastEpicScan, Date.now());

    mountPanel('Epic 免费游戏');
    ui.busy(true);
    await log('Epic：拉本周免费列表');
    let games = [];
    try {
      games = await fetchFreeGames();
    } catch (e) {
      await log(`Epic：列表失败 ${e.message}`, 'warn');
      await dailyPatch('epic', { done: true, listed: 0, opened: 0, failed: [`列表拉取失败：${e.message}`] });
      ui.busy(false, true);
      return;
    }
    await log(`Epic：本周免费 ${games.length} 个`);
    if (!games.length) {
      await dailyPatch('epic', { done: true, listed: 0, opened: 0, failed: [] });
      ui.busy(false);
      return;
    }

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
      if (st.logOwned) {
        await log(`Epic：${g.title.slice(0, 24)} 跳过（${p.state}${p.verified ? '·已验证' : ''}，${Math.max(1, Math.round((cool - (Date.now() - (p.at || 0))) / 60000))} 分钟后重试）`);
      }
    }
    if (!todo.length) {
      await log('Epic：本周的都处理过了，没有要开的');
      await dailyPatch('epic', { done: true, listed: games.length, opened: 0, failed: [] });
      ui.busy(false);
      return;
    }
    // 限时免费的窗口快关了还没领到 → 明说，别让人以为没事
    const soon = todo.filter((g) => g.freeEnd && g.freeEnd - Date.now() < 48 * 3600000);
    if (soon.length) {
      const names = soon.map((g) => g.title).slice(0, 3).join('、');
      await log(`Epic：还有 ${soon.length} 个 48 小时内到期没领到：${names}`, 'warn');
      bigBanner(`⏳ ${names} 限时免费快结束了，正在重试领取`, 'rgba(200,120,20,.95)');
      notifyFail(`${soon.length} 个限时免费 48h 内到期`, 'Epic 领取提醒');
    }
    if (st.dryRun) {
      for (const g of todo) await log(`Epic：[仅扫描] 可领 ${g.title}`, 'ok');
      await dailyPatch('epic', { done: true, listed: games.length, opened: 0, failed: [] });
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
    await dailyPatch('epic', {
      done: true, listed: games.length, opened: batch.length,
      failed: soon.map((g) => `${g.title}（48h 内到期）`).slice(0, 3),
    });
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

  async function epicNote(field, entry) {
    const d = await dailyGet();
    const e = Object.assign({}, d.epic || {});
    e[field] = (e[field] || []).slice();
    e[field].push(entry);
    if (e.listed === undefined) e.listed = e[field].length;
    await dailyPatch('epic', e);
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
      await epicNote('failed', { title, reason: '被踢到登录页' });
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
      await epicNote('claimed', title);
      ui.busy(false);
      return;
    }
    if (clicked === 0) {
      const t = pageText();
      if (/sign in|登录|Account id is missing/i.test(t)) {
        await setHist(K.epicHist, g.id, { title, state: 'needs-login', at: Date.now() });
        await log('Epic：页面要求登录（Account id is missing / 登录），请在浏览器里登一次', 'warn');
      await epicNote('failed', { title, reason: '需要登录 Epic' });
        bigBanner('需要登录 Epic 才能领取，登录后刷新');
        ui.busy(false, true);
        return;
      }
      await setHist(K.epicHist, g.id, { title, state: 'failed', at: Date.now(), why: '没等到领取按钮' });
      await log('Epic：60 秒没等到领取按钮（选择器可能又变了，把这一页截图给桃夭）', 'warn');
      await epicNote('failed', { title, reason: '没等到领取按钮' });
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
      await epicNote('claimed', title);
      bigBanner(`✅ ${title} 已入库`, 'rgba(30,140,80,.95)');
      gmNotify(`${title} 已领取`, 'Epic 领取成功');
      await sleep(4000);
      hideBanner();
      await closeSelfIfOpened();
    } else if (result === 'captcha') {
      // 卡在验证码：不判失败，等你处理完再刷新本页重试
      await setHist(K.epicHist, g.id, { title, state: 'needs-human', at: Date.now() });
      await log('Epic：卡在真人验证，已记 needs-human；你过完验证码后可点「立即扫描本轮」重试', 'warn');
      await epicNote('failed', { title, reason: '等你过真人验证' });
      ui.busy(false, true);
    } else {
      await setHist(K.epicHist, g.id, { title, state: 'failed', at: Date.now(), why: '等结果超时' });
      await log('Epic：5 分钟没等到成功提示，记失败；截图发给桃夭看卡在哪', 'warn');
      await epicNote('failed', { title, reason: '等结果超时' });
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

  // ══════════════════════════ 设置 UI（v1.4.0）══════════════════════════
  // 一个独立的 shadow host，任何站点都能开（菜单命令 / 面板按钮都进这里）。
  // 字段表驱动渲染：加设置只改 SETTINGS_SCHEMA + DEF_SETTINGS，不用碰 DOM 代码。
  const SETTINGS_SCHEMA = [
    {
      section: '总开关',
      fields: [
        { k: 'autoEpic', type: 'bool', label: '自动领 Epic 每周免费', hint: '每天首次打开浏览器时扫一次' },
        { k: 'autoFab', type: 'bool', label: '自动领 Fab 免费资产', hint: '含限时免费（走 0 元购物车结算）' },
        { k: 'dryRun', type: 'bool', label: '仅扫描，不下单', hint: '只告诉你会领什么，一个都不点' },
      ],
    },
    {
      section: '每轮上限',
      fields: [
        { k: 'maxEpicPerRun', type: 'num', label: 'Epic 每轮最多领', min: 1, max: 10, unit: '个' },
        { k: 'maxFabPerRun', type: 'num', label: 'Fab 每轮最多领', min: 1, max: 200, unit: '个' },
        { k: 'fabConcurrency', type: 'num', label: '并发领取数', min: 1, max: 8, unit: '个', hint: '1 = 一个一个领；4~6 大约快 3 倍，太高会被限流' },
        { k: 'fabListPages', type: 'num', label: 'Fab 列表翻几页', min: 1, max: 40, unit: '页', hint: '每页 24 条；Fab 上免费资产有几百个，只翻 1 页就只能看到 24 个' },
        { k: 'libPages', type: 'num', label: '读库翻几页', min: 1, max: 40, unit: '页', hint: '库里的条目越多这里要越大，否则老条目会被误判成"没领过"' },
      ],
    },
    {
      section: '冷却与重试',
      fields: [
        { k: 'epicScanHours', type: 'num', label: 'Epic 自动扫间隔', min: 1, max: 168, unit: '小时' },
        { k: 'fabScanHours', type: 'num', label: 'Fab 自动扫间隔', min: 1, max: 168, unit: '小时' },
        { k: 'epicRetryMinutes', type: 'num', label: 'Epic 失败重试冷却', min: 10, max: 1440, unit: '分钟', hint: '免费窗口只有一周，别设太大' },
        { k: 'retryDays', type: 'num', label: 'Fab 失败重试冷却', min: 1, max: 30, unit: '天' },
      ],
    },
    {
      section: '汇报方式',
      fields: [
        { k: 'toastEnabled', type: 'bool', label: '显示右下角浮窗', hint: '关掉就完全静默，只看面板日志' },
        { k: 'toastMaxPerDay', type: 'num', label: '每天最多主动弹', min: 0, max: 20, unit: '次', hint: '0 = 只在面板里看' },
        { k: 'notifyFail', type: 'bool', label: '失败时发系统通知' },
        { k: 'logOwned', type: 'bool', label: '「领过了」也逐条写日志', hint: '默认只汇总计数' },
      ],
    },
  ];

  // 存进去的东西可能是旧版本、手改的、或从别处导入的字符串 —— 一律过一遍这里
  function normalizeSettings(raw) {
    const out = Object.assign({}, DEF_SETTINGS);
    const fields = {};
    for (const sec of SETTINGS_SCHEMA) for (const f of sec.fields) fields[f.k] = f;
    for (const k of Object.keys(DEF_SETTINGS)) {
      const v = raw && raw[k];
      if (v === undefined || v === null) continue;
      const f = fields[k];
      if (!f) continue;
      if (f.type === 'bool') out[k] = !!v;
      else {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        out[k] = Math.min(f.max, Math.max(f.min, Math.round(n)));
      }
    }
    return out;
  }

  let setUi = null;   // { host, root, body, io, msg, stat }

  function esc(s) {
    return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  const SET_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .mask { position: fixed; inset: 0; background: rgba(8,9,12,.55); display: flex;
            align-items: center; justify-content: center; padding: 24px; }
    .card { width: 480px; max-width: 94vw; max-height: 86vh; display: flex; flex-direction: column;
            font: 12.5px/1.6 "Microsoft YaHei", system-ui, sans-serif; color: #e8e9ec;
            background: #16181e; border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
            box-shadow: 0 18px 50px rgba(0,0,0,.6); overflow: hidden; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
          background: linear-gradient(90deg, rgba(255,90,140,.26), rgba(120,90,255,.2)); }
    .hd b { flex: 1; font-size: 13px; font-weight: 600; }
    .hd .ver { font-size: 10.5px; opacity: .65; }
    .hd .x { cursor: pointer; opacity: .65; padding: 0 2px; font-size: 14px; }
    .hd .x:hover { opacity: 1; }
    .bd { padding: 4px 14px 10px; overflow: auto; }
    .sec { padding: 10px 0 8px; border-bottom: 1px solid rgba(255,255,255,.07); }
    .sec:last-child { border-bottom: 0; }
    .sec-t { font-size: 11px; letter-spacing: .04em; opacity: .55; margin-bottom: 6px; }
    .row { display: flex; align-items: center; gap: 10px; padding: 4px 0; cursor: pointer; }
    .row .lab { flex: 1; min-width: 0; }
    .row .lab em { display: block; font-style: normal; font-size: 10.5px; opacity: .5; }
    input[type=checkbox] { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
    .sw { flex: 0 0 auto; width: 36px; height: 20px; border-radius: 999px; position: relative;
      background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.18);
      cursor: pointer; transition: background .16s, border-color .16s; }
    .sw::after { content: ''; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px;
      border-radius: 50%; background: #9aa0ad; transition: transform .16s, background .16s; }
    input[type=checkbox]:checked + .sw { background: #2f9e63; border-color: #6ee7a8; }
    input[type=checkbox]:checked + .sw::after { transform: translateX(16px); background: #fff; }
    input[type=checkbox]:focus-visible + .sw { outline: 2px solid #9aa4ff; outline-offset: 2px; }
    .num { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .num input { width: 72px; font: inherit; font-size: 12px; color: #e8e9ec; text-align: right;
      background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16);
      border-radius: 6px; padding: 3px 6px; }
    .num em { font-style: normal; font-size: 10.5px; opacity: .55; min-width: 26px; }
    .acts { display: flex; flex-wrap: wrap; gap: 6px; }
    button { font: inherit; font-size: 11.5px; color: #e8e9ec; background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.16); border-radius: 7px; padding: 5px 10px; cursor: pointer; }
    button:hover { background: rgba(255,255,255,.17); }
    button.danger { color: #ff9a9a; border-color: rgba(255,120,120,.35); }
    button.danger:hover { background: rgba(255,120,120,.18); }
    textarea { width: 100%; height: 88px; margin-top: 6px; resize: vertical; font: 11px/1.5 ui-monospace, Consolas, monospace;
      color: #d7d8dc; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.14);
      border-radius: 7px; padding: 6px 8px; }
    .stat { font-size: 11px; opacity: .75; white-space: pre-wrap; word-break: break-all; }
    .ft { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-top: 1px solid rgba(255,255,255,.09); }
    .ft .msg { flex: 1; font-size: 11px; opacity: .6; }
    .ft .msg.ok { color: #8fe3a5; opacity: 1; }
    .ft .msg.bad { color: #ff9a9a; opacity: 1; }
  `;

  function fieldHtml(f, st) {
    const v = st[f.k];
    if (f.type === 'bool') {
      return `<label class="row"><span class="lab">${esc(f.label)}${f.hint ? `<em>${esc(f.hint)}</em>` : ''}</span>`
        + `<input type="checkbox" data-k="${esc(f.k)}"${v ? ' checked' : ''}><i class="sw"></i></label>`;
    }
    return `<label class="row"><span class="lab">${esc(f.label)}${f.hint ? `<em>${esc(f.hint)}</em>` : ''}</span>`
      + `<span class="num"><input type="number" data-k="${esc(f.k)}" value="${esc(v)}"`
      + ` min="${f.min}" max="${f.max}" step="1"><em>${esc(f.unit || '')}</em></span></label>`;
  }

  function bodyHtml(st) {
    const secs = SETTINGS_SCHEMA.map((sec) => `<div class="sec"><div class="sec-t">${esc(sec.section)}</div>`
      + sec.fields.map((f) => fieldHtml(f, st)).join('') + '</div>').join('');
    return secs + `
      <div class="sec"><div class="sec-t">立刻执行</div><div class="acts">
        <button data-act="scanEpic">扫 Epic</button>
        <button data-act="scanFab">扫 Fab</button>
        <button data-act="scanBoth">两边都扫</button>
      </div></div>
      <div class="sec"><div class="sec-t">数据</div>
        <div class="acts">
          <button data-act="export">导出设置</button>
          <button data-act="apply">应用下面这段 JSON</button>
          <button data-act="reset">恢复默认</button>
        </div>
        <textarea id="io" spellcheck="false" placeholder="点「导出设置」把当前配置写到这里；也可以粘一段 JSON 进来再点「应用」。"></textarea>
        <div class="acts" style="margin-top:6px">
          <button data-act="clearDaily">清空今日汇总</button>
          <button data-act="clearLog">清空日志</button>
          <button data-act="clearHist" class="danger">清空领取历史</button>
        </div>
      </div>
      <div class="sec"><div class="sec-t">状态</div><div class="stat" id="stat">读取中…</div></div>`;
  }

  async function statText() {
    const [le, lf, he, hf, logs, daily] = await Promise.all([
      gmGet(K.lastEpicScan, 0), gmGet(K.lastFabScan, 0),
      hist(K.epicHist), hist(K.fabHist), gmGet(K.log, []), gmGet(K.daily, null),
    ]);
    const fmt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '还没跑过');
    const lines = [
      `Epic 上次扫描：${fmt(le)}（历史 ${Object.keys(he).length} 条）`,
      `Fab 上次扫描：${fmt(lf)}（历史 ${Object.keys(hf).length} 条）`,
      `日志：${(logs || []).length} 条`,
    ];
    if (daily && daily.day) {
      const e = daily.epic ? `Epic ${daily.epic.done ? '已完成' : '进行中'}` : 'Epic 未跑';
      const f = daily.fab ? `Fab ${daily.fab.done ? '已完成' : '进行中'}` : 'Fab 未跑';
      lines.push(`今日（${daily.day}）：${e} · ${f}`);
    }
    return lines.join('\n');
  }

  async function openSettings() {
    toastHide();          // 设置界面打开时先把角落浮窗收起来，别叠在一起
    if (setUi) {
      setUi.host.style.display = 'block';
      await renderSettings();
      return;
    }
    const host = document.createElement('div');
    host.id = 'efc-settings-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:block;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${SET_CSS}</style>
      <div class="mask"><div class="card">
        <div class="hd"><b>Epic/Fab 领取助手 · 设置</b><span class="ver"></span><span class="x" title="关闭（Esc）">✕</span></div>
        <div class="bd"></div>
        <div class="ft"><span class="msg">改动自动保存</span><button data-act="close">关闭</button></div>
      </div></div>`;
    setUi = {
      host,
      root,
      body: root.querySelector('.bd'),
      msg: root.querySelector('.ft .msg'),
      card: root.querySelector('.card'),
    };
    root.querySelector('.ver').textContent = 'v' + VERSION;
    const close = () => { host.style.display = 'none'; };
    root.querySelector('.hd .x').addEventListener('click', close);
    root.querySelector('[data-act="close"]').addEventListener('click', close);
    root.querySelector('.mask').addEventListener('click', (e) => {
      if (e.target === root.querySelector('.mask')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && host.style.display !== 'none') close();
    });

    // 改了就存：不设"保存"按钮，省得忘了点
    setUi.body.addEventListener('change', async (e) => {
      const t = e.target;
      const k = t && t.getAttribute && t.getAttribute('data-k');
      if (!k) return;
      const f = SETTINGS_SCHEMA.flatMap((s) => s.fields).find((x) => x.k === k);
      if (!f) return;
      const st = await settings();
      const val = f.type === 'bool' ? !!t.checked
        : Math.min(f.max, Math.max(f.min, Math.round(Number(t.value) || f.min)));
      if (f.type === 'num' && String(val) !== t.value) t.value = val;
      await gmSet(K.settings, Object.assign({}, st, { [k]: val }));
      await flash(`已保存：${f.label} = ${f.type === 'bool' ? (val ? '开' : '关') : val + (f.unit || '')}`, 'ok');
      if (ui) ui.refresh();
      if (k === 'toastEnabled' || k === 'logOwned') await api.refreshStats();
    });

    setUi.body.addEventListener('click', async (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      await onAction(act);
    });

    await renderSettings();
  }

  async function renderSettings() {
    if (!setUi) return;
    const st = await settings();
    const scrollTop = setUi.body.scrollTop;
    setUi.body.innerHTML = bodyHtml(st);
    setUi.body.scrollTop = scrollTop;
    await api.refreshStats();
  }

  // 页面代码里到处用 flash(...)，这里给个短名字别名（api 还没建好时也不能炸）
  const flash = (text, level) => (api ? api.flash(text, level) : Promise.resolve());

  const api = {
    async refreshStats() {
      if (!setUi) return;
      const el = setUi.root.querySelector('#stat');
      if (el) el.textContent = await statText();
    },
    async flash(text, level) {
      if (!setUi) return;
      const m = setUi.msg;
      m.textContent = text;
      m.className = 'msg ' + (level || '');
      clearTimeout(api._t);
      api._t = setTimeout(() => {
        if (setUi && setUi.msg === m) { m.textContent = '改动自动保存'; m.className = 'msg'; }
      }, 2600);
    },
  };

  async function onAction(act) {
    if (act === 'close') { setUi.host.style.display = 'none'; return; }

    if (act === 'scanEpic' || act === 'scanBoth') {
      await flash('已开始扫 Epic —— 进度看面板日志');
      if (location.hostname.endsWith('epicgames.com')) epicScan(true);
      else gmOpenTab(`${STORE}/zh-CN/free-games?efc=scan`, { active: true });
    }
    if (act === 'scanFab' || act === 'scanBoth') {
      await flash('已开始扫 Fab —— 进度看面板日志');
      if (location.hostname.endsWith('fab.com')) fabRun(true);
      else gmOpenTab(`${FAB_HOME}/limited-time-free?efc=scan`, { active: true });
    }

    if (act === 'export') {
      const st = await settings();
      setUi.root.querySelector('#io').value = JSON.stringify(st, null, 2);
      await flash('已导出到下面的文本框，可以直接复制', 'ok');
    }

    if (act === 'apply') {
      const raw = (setUi.root.querySelector('#io').value || '').trim();
      if (!raw) { await flash('先把 JSON 粘进文本框', 'bad'); return; }
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (err) {
        await flash(`JSON 解析失败：${err.message}`, 'bad');
        return;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        await flash('要一个 JSON 对象，例如 {"maxFabPerRun": 5}', 'bad');
        return;
      }
      await gmSet(K.settings, normalizeSettings(obj));
      await renderSettings();
      await flash('已应用并生效', 'ok');
      if (ui) ui.refresh();
      return;
    }

    if (act === 'reset') {
      if (!window.confirm('恢复全部默认设置？（不影响领取历史）')) return;
      await gmSet(K.settings, {});
      await renderSettings();
      await flash('已恢复默认', 'ok');
      if (ui) ui.refresh();
      return;
    }

    if (act === 'clearLog') {
      await gmSet(K.log, []);
      await renderSettings();
      await flash('日志已清空', 'ok');
      if (ui) ui.refresh();
      return;
    }
    if (act === 'clearHist') {
      if (!window.confirm('清空领取历史？\n清了之后脚本会把你能看到的免费条目重新扫一遍（已在库的会靠 Fab 库搜索识别出来，不会重复占库）。')) return;
      await gmSet(K.epicHist, {});
      await gmSet(K.fabHist, {});
      await renderSettings();
      await flash('领取历史已清空', 'ok');
      return;
    }
    if (act === 'clearDaily') {
      await gmSet(K.daily, null);
      await gmSet(K.toastOff, '');
      await gmSet(K.toastShown, {});
      await renderSettings();
      await flash('今日汇总已清空（下次打开页面会重新检查）', 'ok');
    }
  }
  function mountSettingsMenu() {
    try {
      if (typeof window.GM_registerMenuCommand === 'function') {
        window.GM_registerMenuCommand('⚙ 脚本设置', () => { openSettings(); });
        window.GM_registerMenuCommand('🔁 检查更新 / 重装', () => {
          gmOpenTab(`${CDN_URL}?t=${Date.now()}`, { active: true });
        });
        window.GM_registerMenuCommand('🔁 备用镜像更新（主通道打不开时）', () => {
          gmOpenTab(`${CDN_URL_FALLBACK}?t=${Date.now()}`, { active: true });
        });
      }
    } catch (e) { /* 有的管理器不让注册，面板按钮兜底 */ }
  }


  // ══════════════════════════════ 入口 ══════════════════════════════
  function parseArgs() {
    const q = new URLSearchParams(location.search);
    return { claim: q.get('efc') === 'claim', title: q.get('efcTitle') || '' };
  }

  async function boot() {
    const host = location.hostname;
    await log(`Epic/Fab 助手 v${VERSION} 已加载（${host}）`);
    await log('设置：Tampermonkey 菜单 → ⚙ 脚本设置（Epic/Fab 页上的面板里也有「⚙ 设置」按钮）');
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
      if (new URLSearchParams(location.search).get('efc') === 'scan') {
        await closeSelfIfOpened();   // 这是我们自己开的扫描标签，扫完就退场（汇总由发起页去弹）
        return;
      }
      await dailyCheck('fab');       // 用户自己开的 Fab 页：把 Epic 那半边也补上
      return;
    }
    if (host.endsWith('epicgames.com')) {
      // 登录页 / 账号页不打扰，免得你正在登号时脚本在后台开领取标签
      if (location.pathname.startsWith('/id/') || location.pathname.startsWith('/account')) return;
      mountPanel('Epic 免费游戏');
      await epicScan(false);
      // 我们自己开出来做扫描的后台标签，扫完就关掉，别留在标签栏里
      if (new URLSearchParams(location.search).get('efc') === 'scan') {
        await closeSelfIfOpened();
        return;
      }
      await dailyCheck('epic');      // 用户自己开的 Epic 页：把 Fab 那半边也补上
      return;
    }

    // 其他任何站点：每天第一次打开浏览器就开始干活（不再只认 Epic/Fab 站点）
    await dailyCheck();
  }

  // 给离线自测留出口（node 里 stub 一个 window 就能验纯逻辑，不影响正常使用）
  window.__efcInternals = { DEF_SETTINGS, SETTINGS_SCHEMA, normalizeSettings, openSettings, VERSION, freeWindow, priceIsZero, claimUrlFor, SEL, tierRank, isProTier, freeUntilOf, successText, ownedCtaText, dayKey, fabRun, dailyCheck, dailyGet, dailyPatch, summaryLines };

  mountSettingsMenu();

  // 单页只跑一次；Epic 站内路由切换不重复触发
  if (window.__efcBooted) return;
  window.__efcBooted = true;
  boot().catch((e) => console.error('[EFC] boot 失败', e));
})();
