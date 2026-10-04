// ==UserScript==
// @name         拼多多订单批量查询管理器
// @namespace    https://github.com/Yitaijiongjun/Test
// @version      0.1.0
// @description  在拼多多网页端批量采集订单，按时间/状态/关键词筛选，统计金额并导出 CSV。数据仅保存在本机浏览器。
// @author       ChatGPT
// @match        https://mobile.yangkeduo.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP = 'pddom';
  const VERSION = 1;
  const API_MARK = '/proxy/api/api/aristotle/order_list_v4';
  const STORAGE_KEY = `${APP}:orders:v${VERSION}`;
  const PREF_KEY = `${APP}:prefs:v${VERSION}`;
  const MAX_STORED_ORDERS = 5000;
  const PAGE_SIZE = 50;

  const state = {
    orders: new Map(),
    panelOpen: false,
    loading: false,
    autoLoadStop: false,
    page: 1,
    lastCaptureAt: 0,
    lastApiAt: 0,
    statusText: '等待订单接口数据',
  };

  function log(...args) {
    console.debug('[PDD订单管理器]', ...args);
  }

  function isOrderApi(url) {
    try {
      const s = typeof url === 'string' ? url : String(url?.url || '');
      return s.includes(API_MARK);
    } catch {
      return false;
    }
  }

  function safeJsonParse(text, fallback = null) {
    try { return JSON.parse(text); } catch { return fallback; }
  }

  function loadCache() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = safeJsonParse(raw, []);
    if (!Array.isArray(arr)) return;
    for (const order of arr) {
      if (order?.orderSn) state.orders.set(order.orderSn, order);
    }
  }

  function saveCache() {
    const arr = [...state.orders.values()]
      .sort((a, b) => (b.orderTime || 0) - (a.orderTime || 0))
      .slice(0, MAX_STORED_ORDERS);
    state.orders = new Map(arr.map(o => [o.orderSn, o]));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch (err) {
      // localStorage 可能达到浏览器配额，按时间保留较新的 1500 条。
      const reduced = arr.slice(0, 1500);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reduced));
      state.orders = new Map(reduced.map(o => [o.orderSn, o]));
      log('缓存空间不足，已压缩历史订单', err);
    }
  }

  function loadPrefs() {
    return safeJsonParse(localStorage.getItem(PREF_KEY), {}) || {};
  }

  function savePrefs(prefs) {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  }

  function normalizeOrder(o) {
    if (!o || typeof o !== 'object' || !o.order_sn) return null;
    const goods = Array.isArray(o.order_goods) ? o.order_goods.map(g => ({
      goodsId: String(g.goods_id || ''),
      skuId: String(g.sku_id || ''),
      name: g.goods_name || '',
      spec: g.spec || '',
      price: Number(g.goods_price || 0),
      number: Number(g.goods_number || 0),
      thumb: g.thumb_url || '',
    })) : [];

    return {
      orderSn: String(o.order_sn),
      orderTime: Number(o.order_time || 0),
      shippingTime: Number(o.shipping_time || 0),
      receiveTime: Number(o.receive_time || 0),
      displayAmount: Number(o.display_amount || 0),
      orderAmount: Number(o.order_amount || 0),
      discountAmount: Number(o.discount_amount || 0),
      shippingAmount: Number(o.shipping_amount || 0),
      statusPrompt: o.order_status_prompt || inferStatus(o),
      status: Number(o.status ?? -1),
      orderStatus: Number(o.order_status ?? -1),
      payStatus: Number(o.pay_status ?? -1),
      shippingStatus: Number(o.shipping_status ?? -1),
      commentStatus: Number(o.comment_status ?? -1),
      afterSalesStatus: Number(o.after_sales?.after_sales_status ?? -1),
      mallName: o.mall?.mall_name || '',
      link: o.order_link_url || `order.html?order_sn=${encodeURIComponent(o.order_sn)}`,
      trackingNumber: o.tracking_number || '',
      goods,
      offset: o.offset || '',
      capturedAt: Date.now(),
    };
  }

  function inferStatus(o) {
    if (o.pay_status === 4) return '退款/售后';
    if (o.pay_status === 0 || o.pay_status === 1) return '待付款';
    if (o.shipping_status === 0) return '待发货';
    if (o.shipping_status === 1) return '待收货';
    if (o.comment_status === 0) return '待评价';
    return '其他';
  }

  function ingestPayload(payload, source = 'network') {
    if (!payload || !Array.isArray(payload.orders)) return 0;
    let added = 0;
    for (const raw of payload.orders) {
      const o = normalizeOrder(raw);
      if (!o) continue;
      const prev = state.orders.get(o.orderSn);
      state.orders.set(o.orderSn, prev ? { ...prev, ...o } : o);
      if (!prev) added++;
    }
    state.lastCaptureAt = Date.now();
    state.lastApiAt = Date.now();
    state.statusText = `已采集 ${state.orders.size} 条订单`;
    saveCache();
    refreshUI();
    log(`采集订单 ${payload.orders.length} 条，新增 ${added} 条，来源 ${source}`);
    return added;
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__pddomPatched) return;
    const nativeFetch = window.fetch;
    const wrapped = async function (...args) {
      const resp = await nativeFetch.apply(this, args);
      try {
        if (isOrderApi(args[0])) {
          resp.clone().json().then(data => ingestPayload(data, 'fetch')).catch(() => {});
        }
      } catch (err) {
        log('fetch 捕获失败', err);
      }
      return resp;
    };
    wrapped.__pddomPatched = true;
    window.fetch = wrapped;
  }

  function patchXHR() {
    const XHR = window.XMLHttpRequest;
    if (!XHR || XHR.prototype.__pddomPatched) return;
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__pddomUrl = url;
      return nativeOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      if (isOrderApi(this.__pddomUrl)) {
        this.addEventListener('loadend', () => {
          try {
            const data = this.responseType === 'json'
              ? this.response
              : safeJsonParse(this.responseText, null);
            ingestPayload(data, 'xhr');
          } catch (err) {
            log('XHR 捕获失败', err);
          }
        }, { once: true });
      }
      return nativeSend.apply(this, args);
    };

    XHR.prototype.__pddomPatched = true;
  }

  // 尽可能早地安装网络监听，不读取/保存 Cookie、Token、anti_content。
  loadCache();
  patchFetch();
  patchXHR();

  function money(cents) {
    const n = Number(cents || 0) / 100;
    return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtTime(sec) {
    if (!sec) return '-';
    const d = new Date(sec * 1000);
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).replaceAll('/', '-');
  }

  function toDateInput(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseStartDate(s) {
    if (!s) return 0;
    const t = new Date(`${s}T00:00:00`).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  }

  function parseEndDate(s) {
    if (!s) return Number.MAX_SAFE_INTEGER;
    const t = new Date(`${s}T23:59:59.999`).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : Number.MAX_SAFE_INTEGER;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[ch]);
  }

  function getFilteredOrders() {
    const root = document.getElementById(`${APP}-panel`);
    if (!root) return [...state.orders.values()].sort((a, b) => b.orderTime - a.orderTime);
    const start = parseStartDate(root.querySelector('[data-role="start"]')?.value || '');
    const end = parseEndDate(root.querySelector('[data-role="end"]')?.value || '');
    const status = root.querySelector('[data-role="status"]')?.value || '';
    const keyword = (root.querySelector('[data-role="keyword"]')?.value || '').trim().toLowerCase();

    return [...state.orders.values()]
      .filter(o => o.orderTime >= start && o.orderTime <= end)
      .filter(o => !status || o.statusPrompt === status)
      .filter(o => {
        if (!keyword) return true;
        const haystack = [
          o.orderSn, o.mallName, o.trackingNumber, o.statusPrompt,
          ...o.goods.flatMap(g => [g.name, g.spec, g.goodsId, g.skuId])
        ].join('\n').toLowerCase();
        return haystack.includes(keyword);
      })
      .sort((a, b) => b.orderTime - a.orderTime);
  }

  function buildStatusOptions(selected = '') {
    const values = [...new Set([...state.orders.values()].map(o => o.statusPrompt).filter(Boolean))].sort();
    return `<option value="">全部状态</option>${values.map(v =>
      `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}</option>`
    ).join('')}`;
  }

  function defaultPrefs() {
    const p = loadPrefs();
    if (p.start || p.end) return p;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    return { start: toDateInput(start.getTime() / 1000), end: toDateInput(now.getTime() / 1000), status: '', keyword: '' };
  }

  function installUI() {
    if (document.getElementById(`${APP}-launcher`)) return;
    const style = document.createElement('style');
    style.textContent = `
      #${APP}-launcher{position:fixed;right:18px;bottom:20px;z-index:2147483645;border:0;border-radius:999px;background:#e02e24;color:#fff;padding:11px 16px;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.22);cursor:pointer}
      #${APP}-panel{position:fixed;inset:24px;z-index:2147483646;background:#fff;color:#222;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);display:none;overflow:hidden;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
      #${APP}-panel *{box-sizing:border-box}
      #${APP}-panel.${APP}-open{display:flex;flex-direction:column}
      .${APP}-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #eee;background:#fafafa}
      .${APP}-title{font-size:17px;font-weight:700;margin-right:auto}.pddom-muted{color:#777}.pddom-danger{color:#c00}
      .${APP}-btn{border:1px solid #ddd;background:#fff;color:#222;border-radius:7px;padding:7px 11px;cursor:pointer}.pddom-btn:hover{background:#f5f5f5}.pddom-btn-primary{background:#e02e24;color:white;border-color:#e02e24}.pddom-btn-primary:hover{background:#c92720}
      .${APP}-filters{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:10px;padding:12px 16px;border-bottom:1px solid #eee;align-items:end}
      .${APP}-field label{display:block;color:#666;margin-bottom:4px}.pddom-field input,.pddom-field select{width:100%;height:34px;border:1px solid #d9d9d9;border-radius:6px;padding:0 8px;background:#fff;color:#222}
      .${APP}-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;padding:12px 16px;background:#fbfbfb;border-bottom:1px solid #eee}
      .${APP}-card{border:1px solid #eee;border-radius:8px;padding:9px 11px;background:#fff}.pddom-card b{display:block;font-size:18px;margin-top:2px}
      .${APP}-body{flex:1;overflow:auto;padding:0 16px 10px}.pddom-table{width:100%;border-collapse:collapse;table-layout:fixed}.pddom-table th{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #ddd;padding:9px 7px;text-align:left}.pddom-table td{border-bottom:1px solid #eee;padding:9px 7px;vertical-align:top;word-break:break-word}.pddom-table tr:hover td{background:#fafafa}
      .pddom-goods{display:flex;gap:8px;margin-bottom:6px}.pddom-goods img{width:42px;height:42px;object-fit:cover;border-radius:5px;background:#f3f3f3}.pddom-goods-text{min-width:0}.pddom-goods-name{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.pddom-small{font-size:12px;color:#777}.pddom-status{display:inline-block;padding:2px 7px;border-radius:999px;background:#fff2f0;color:#cf2c24;border:1px solid #ffd2cf;white-space:nowrap}.pddom-link{color:#1677ff;text-decoration:none}.pddom-link:hover{text-decoration:underline}
      .${APP}-foot{display:flex;align-items:center;gap:8px;padding:9px 16px;border-top:1px solid #eee;background:#fafafa}.pddom-foot .spacer{flex:1}
      @media(max-width:1100px){.${APP}-filters{grid-template-columns:repeat(3,1fr)}.${APP}-stats{grid-template-columns:repeat(3,1fr)}}
    `;
    document.head.appendChild(style);

    const launcher = document.createElement('button');
    launcher.id = `${APP}-launcher`;
    launcher.textContent = `订单管理 (${state.orders.size})`;
    launcher.addEventListener('click', () => setPanelOpen(true));
    document.body.appendChild(launcher);

    const p = defaultPrefs();
    const panel = document.createElement('section');
    panel.id = `${APP}-panel`;
    panel.innerHTML = `
      <div class="${APP}-head">
        <div class="${APP}-title">拼多多订单批量查询管理器</div>
        <span class="pddom-muted" data-role="statusText"></span>
        <button class="${APP}-btn" data-action="openOrders">打开订单页</button>
        <button class="${APP}-btn" data-action="close">关闭</button>
      </div>
      <div class="${APP}-filters">
        <div class="${APP}-field"><label>开始日期</label><input data-role="start" type="date" value="${escapeHtml(p.start || '')}"></div>
        <div class="${APP}-field"><label>结束日期</label><input data-role="end" type="date" value="${escapeHtml(p.end || '')}"></div>
        <div class="${APP}-field"><label>订单状态</label><select data-role="status">${buildStatusOptions(p.status || '')}</select></div>
        <div class="${APP}-field"><label>关键词</label><input data-role="keyword" placeholder="订单号 / 商品 / 店铺 / 快递单号" value="${escapeHtml(p.keyword || '')}"></div>
        <button class="${APP}-btn pddom-btn-primary" data-action="filter">查询 / 刷新统计</button>
        <button class="${APP}-btn" data-action="autoLoad">加载至开始日期</button>
      </div>
      <div class="${APP}-stats" data-role="stats"></div>
      <div class="${APP}-body">
        <table class="pddom-table">
          <thead><tr><th style="width:145px">下单时间</th><th style="width:95px">状态</th><th style="width:170px">订单号 / 店铺</th><th>商品</th><th style="width:125px">显示金额</th><th style="width:95px">操作</th></tr></thead>
          <tbody data-role="rows"></tbody>
        </table>
      </div>
      <div class="${APP}-foot">
        <button class="${APP}-btn" data-action="prev">上一页</button><span data-role="pager"></span><button class="${APP}-btn" data-action="next">下一页</button>
        <span class="spacer"></span>
        <button class="${APP}-btn" data-action="export">导出筛选结果 CSV</button>
        <button class="${APP}-btn" data-action="stop">停止批量加载</button>
        <button class="${APP}-btn" data-action="clear">清空本地缓存</button>
      </div>`;
    document.body.appendChild(panel);

    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('change', onFilterChanged);
    panel.querySelector('[data-role="keyword"]').addEventListener('input', debounce(onFilterChanged, 220));
    refreshUI();
  }

  function setPanelOpen(open) {
    state.panelOpen = !!open;
    const panel = document.getElementById(`${APP}-panel`);
    panel?.classList.toggle(`${APP}-open`, state.panelOpen);
    if (open) refreshUI();
  }

  function rememberFilters() {
    const panel = document.getElementById(`${APP}-panel`);
    if (!panel) return;
    savePrefs({
      start: panel.querySelector('[data-role="start"]').value,
      end: panel.querySelector('[data-role="end"]').value,
      status: panel.querySelector('[data-role="status"]').value,
      keyword: panel.querySelector('[data-role="keyword"]').value,
    });
  }

  function onFilterChanged() {
    state.page = 1;
    rememberFilters();
    refreshUI();
  }

  function onPanelClick(e) {
    const action = e.target?.dataset?.action;
    if (!action) return;
    if (action === 'close') return setPanelOpen(false);
    if (action === 'filter') return onFilterChanged();
    if (action === 'prev') { state.page = Math.max(1, state.page - 1); return refreshUI(); }
    if (action === 'next') { state.page++; return refreshUI(); }
    if (action === 'export') return exportCsv();
    if (action === 'autoLoad') return autoLoadToStartDate();
    if (action === 'stop') { state.autoLoadStop = true; state.statusText = '已请求停止批量加载'; return refreshUI(); }
    if (action === 'openOrders') return openOrdersPage();
    if (action === 'clear') return clearCache();
  }

  function refreshUI() {
    const launcher = document.getElementById(`${APP}-launcher`);
    if (launcher) launcher.textContent = `订单管理 (${state.orders.size})`;
    const panel = document.getElementById(`${APP}-panel`);
    if (!panel) return;

    const statusSelect = panel.querySelector('[data-role="status"]');
    if (statusSelect) {
      const selected = statusSelect.value;
      statusSelect.innerHTML = buildStatusOptions(selected);
    }

    const filtered = getFilteredOrders();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const pageRows = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const displaySum = filtered.reduce((s, o) => s + o.displayAmount, 0);
    const orderSum = filtered.reduce((s, o) => s + o.orderAmount, 0);
    const discountSum = filtered.reduce((s, o) => s + o.discountAmount, 0);
    const times = [...state.orders.values()].map(o => o.orderTime).filter(Boolean);
    const earliest = times.length ? Math.min(...times) : 0;
    const latest = times.length ? Math.max(...times) : 0;

    panel.querySelector('[data-role="statusText"]').textContent = state.loading ? `批量加载中 · ${state.orders.size} 条` : state.statusText;
    panel.querySelector('[data-role="stats"]').innerHTML = `
      <div class="${APP}-card"><span class="pddom-muted">筛选订单</span><b>${filtered.length}</b></div>
      <div class="${APP}-card"><span class="pddom-muted">显示金额合计</span><b>${money(displaySum)}</b></div>
      <div class="${APP}-card"><span class="pddom-muted">订单金额合计</span><b>${money(orderSum)}</b></div>
      <div class="${APP}-card"><span class="pddom-muted">优惠金额合计</span><b>${money(discountSum)}</b></div>
      <div class="${APP}-card"><span class="pddom-muted">已采集时间范围</span><b style="font-size:13px">${earliest ? `${toDateInput(earliest)} ~ ${toDateInput(latest)}` : '暂无数据'}</b></div>`;

    panel.querySelector('[data-role="rows"]').innerHTML = pageRows.map(renderRow).join('') || `
      <tr><td colspan="6" style="text-align:center;padding:32px;color:#777">暂无匹配订单。若刚安装脚本，请打开订单页并刷新一次，然后使用“加载至开始日期”。</td></tr>`;
    panel.querySelector('[data-role="pager"]').textContent = `第 ${state.page}/${totalPages} 页，共 ${filtered.length} 条`;
  }

  function renderRow(o) {
    const goods = o.goods.slice(0, 3).map(g => `
      <div class="pddom-goods">
        ${g.thumb ? `<img src="${escapeHtml(g.thumb)}" referrerpolicy="no-referrer">` : ''}
        <div class="pddom-goods-text"><div class="pddom-goods-name">${escapeHtml(g.name || '(商品名称为空)')}</div><div class="pddom-small">${escapeHtml(g.spec || '')}${g.number ? ` × ${g.number}` : ''}</div></div>
      </div>`).join('');
    const more = o.goods.length > 3 ? `<div class="pddom-small">另有 ${o.goods.length - 3} 个商品</div>` : '';
    const absLink = new URL(o.link || '/', location.origin).href;
    return `<tr>
      <td>${escapeHtml(fmtTime(o.orderTime))}</td>
      <td><span class="pddom-status">${escapeHtml(o.statusPrompt)}</span></td>
      <td><div>${escapeHtml(o.orderSn)}</div><div class="pddom-small">${escapeHtml(o.mallName || '-')}</div>${o.trackingNumber ? `<div class="pddom-small">快递：${escapeHtml(o.trackingNumber)}</div>` : ''}</td>
      <td>${goods}${more}</td>
      <td><b>${money(o.displayAmount)}</b><div class="pddom-small">订单额 ${money(o.orderAmount)}</div><div class="pddom-small">优惠 ${money(o.discountAmount)}</div></td>
      <td><a class="pddom-link" href="${escapeHtml(absLink)}" target="_blank" rel="noopener noreferrer">订单详情</a></td>
    </tr>`;
  }

  function openOrdersPage() {
    if (location.pathname.includes('orders.html')) {
      state.statusText = '当前已在订单页；若无新数据请刷新页面';
      refreshUI();
      return;
    }
    const url = new URL('/orders.html', location.origin);
    url.searchParams.set('type', '0');
    url.searchParams.set('comment_tab', '1');
    url.searchParams.set('combine_orders', '1');
    url.searchParams.set('main_orders', '1');
    location.href = url.href;
  }

  function findLoadMoreButton() {
    const all = [...document.querySelectorAll('button,a,div,span')];
    return all.find(el => {
      if (!el.offsetParent) return false;
      const text = (el.textContent || '').trim();
      return /^(加载更多|查看更多|继续加载|更多订单)$/.test(text);
    });
  }

  function getScrollTarget() {
    const candidates = [...document.querySelectorAll('div,section,main')].filter(el => {
      if (el.closest(`#${APP}-panel`)) return false;
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 200;
    });
    candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || null;
  }

  async function autoLoadToStartDate() {
    if (state.loading) return;
    const panel = document.getElementById(`${APP}-panel`);
    const startText = panel?.querySelector('[data-role="start"]')?.value || '';
    const target = parseStartDate(startText);
    if (!target) {
      state.statusText = '请先选择开始日期';
      refreshUI();
      return;
    }
    if (!location.pathname.includes('orders.html')) {
      state.statusText = '请先点击“打开订单页”，进入订单列表后再批量加载';
      refreshUI();
      return;
    }

    state.loading = true;
    state.autoLoadStop = false;
    state.statusText = '开始批量加载';
    refreshUI();

    let noGrowthRounds = 0;
    let lastCount = state.orders.size;
    const MAX_ROUNDS = 240;

    for (let i = 0; i < MAX_ROUNDS && !state.autoLoadStop; i++) {
      const times = [...state.orders.values()].map(o => o.orderTime).filter(Boolean);
      const earliest = times.length ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
      if (earliest <= target) {
        state.statusText = `已加载至 ${toDateInput(earliest)}，达到开始日期`;
        break;
      }

      const more = findLoadMoreButton();
      if (more) more.click();
      const scrollTarget = getScrollTarget();
      if (scrollTarget) {
        scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'smooth' });
      }

      state.statusText = `正在加载更早订单 · 当前 ${state.orders.size} 条${earliest < Number.MAX_SAFE_INTEGER ? ` · 最早 ${toDateInput(earliest)}` : ''}`;
      refreshUI();
      await sleep(1450);

      if (state.orders.size > lastCount) {
        noGrowthRounds = 0;
        lastCount = state.orders.size;
      } else {
        noGrowthRounds++;
      }

      if (noGrowthRounds >= 4) {
        // 再给懒加载一次较长等待，排除网络慢。
        await sleep(2200);
        if (state.orders.size <= lastCount) {
          state.statusText = '连续多次未加载到新订单，可能已到底或页面未触发接口';
          break;
        }
        lastCount = state.orders.size;
        noGrowthRounds = 0;
      }
    }

    state.loading = false;
    if (state.autoLoadStop) state.statusText = `批量加载已停止 · 已采集 ${state.orders.size} 条`;
    refreshUI();
  }

  function clearCache() {
    if (!confirm('确认清空本脚本保存在浏览器中的订单缓存？不会删除拼多多订单。')) return;
    localStorage.removeItem(STORAGE_KEY);
    state.orders.clear();
    state.page = 1;
    state.statusText = '本地订单缓存已清空';
    refreshUI();
  }

  function exportCsv() {
    const rows = getFilteredOrders();
    const header = ['下单时间','订单状态','订单号','店铺','商品','规格','商品数量','显示金额','订单金额','优惠金额','运费','快递单号'];
    const lines = [header, ...rows.map(o => {
      const names = o.goods.map(g => g.name).join(' | ');
      const specs = o.goods.map(g => g.spec).join(' | ');
      const qty = o.goods.reduce((s, g) => s + Number(g.number || 0), 0);
      return [fmtTime(o.orderTime), o.statusPrompt, o.orderSn, o.mallName, names, specs, qty,
        (o.displayAmount / 100).toFixed(2), (o.orderAmount / 100).toFixed(2),
        (o.discountAmount / 100).toFixed(2), (o.shippingAmount / 100).toFixed(2), o.trackingNumber];
    })].map(row => row.map(csvCell).join(',')).join('\r\n');

    const blob = new Blob(['\ufeff', lines], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const panel = document.getElementById(`${APP}-panel`);
    const s = panel?.querySelector('[data-role="start"]')?.value || 'all';
    const e = panel?.querySelector('[data-role="end"]')?.value || 'all';
    a.download = `pdd-orders_${s}_${e}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return `"${s.replaceAll('"', '""')}"`;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  function bootDom() {
    if (!document.head || !document.body) return setTimeout(bootDom, 50);
    installUI();
    if (state.orders.size) state.statusText = `已从本地缓存恢复 ${state.orders.size} 条订单`;
    refreshUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootDom, { once: true });
  } else {
    bootDom();
  }
})();