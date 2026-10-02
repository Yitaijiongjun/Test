// ==UserScript==
// @name         Pixiv 智能跨页排行助手 (全能进阶版)
// @namespace    https://github.com/
// @version      2.0.0
// @description  精确区间抓取、筛选上下文隔离、IndexedDB 缓存、跨页排序、任务控制、自适应请求延迟与数据库大屏。
// @author       Antigravity
// @match        https://www.pixiv.net/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 0. 常量与通用工具
    // ==========================================
    const DB_NAME = 'PixivSmartRankDB';
    const DB_VERSION = 2;
    const ART_STORE = 'artworks';
    const MEMBERSHIP_STORE = 'searchMemberships';
    const CACHE_TTL = 7 * 86400 * 1000;
    const DELAY_STORAGE_KEY = 'PixivSmartRank_Delay';
    const PANEL_POS_STORAGE_KEY = 'PixivSmartRank_PanelPos';
    const MIN_FETCH_DELAY = 250;
    const MAX_FETCH_DELAY = 6000;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function safeDecode(value) {
        try { return decodeURIComponent(value); } catch (_) { return value; }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(2)} MB`;
    }

    function formatDate(ms) {
        if (!ms) return '-';
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function createElement(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== '') node.textContent = text;
        return node;
    }

    function isSearchPage() {
        return location.pathname.includes('/tags/') || location.pathname.includes('/search/');
    }

    function getCurrentSearchTag() {
        const match = location.pathname.match(/\/tags\/([^/]+)/);
        if (match) return safeDecode(match[1]);
        const params = new URLSearchParams(location.search);
        return params.get('word') || '未解析';
    }

    function getCurrentPageNumber() {
        const value = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
        return Number.isFinite(value) && value > 0 ? value : 1;
    }

    function normalizedSearchPath() {
        return location.pathname
            .replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '')
            .replace(/\/$/, '');
    }

    function buildSearchContext() {
        const keyword = getCurrentSearchTag();
        const params = new URLSearchParams(location.search);
        params.delete('p');

        if (!params.has('word')) params.set('word', keyword);
        if (!params.has('order')) params.set('order', 'date_d');
        if (!params.has('mode')) params.set('mode', 'all');
        if (!params.has('s_mode')) params.set('s_mode', 's_tag');

        const sortedEntries = [...params.entries()].sort((a, b) => {
            const keyCompare = a[0].localeCompare(b[0]);
            return keyCompare !== 0 ? keyCompare : a[1].localeCompare(b[1]);
        });
        const canonical = new URLSearchParams();
        for (const [key, value] of sortedEntries) canonical.append(key, value);

        const path = normalizedSearchPath();
        const key = `${path}?${canonical.toString()}`;
        const extra = sortedEntries
            .filter(([k, v]) => !(
                (k === 'word' && v === keyword) ||
                (k === 'order' && v === 'date_d') ||
                (k === 'mode' && v === 'all') ||
                (k === 's_mode' && v === 's_tag')
            ))
            .map(([k, v]) => `${k}=${v}`)
            .join(' · ');

        return {
            key,
            keyword,
            query: canonical.toString(),
            label: extra ? `${keyword} · ${extra}` : keyword,
            path
        };
    }

    // ==========================================
    // 1. 样式
    // ==========================================
    function injectCSS() {
        if (document.getElementById('pixiv-rank-style')) return;
        const style = document.createElement('style');
        style.id = 'pixiv-rank-style';
        style.textContent = `
            #pixiv-rank-panel {
                --pr-primary: #0096fa;
                --pr-primary-hover: #008ae6;
                --pr-text: #111827;
                --pr-text-secondary: #6b7280;
                --pr-text-muted: #9ca3af;
                --pr-border: #e5e7eb;
                --pr-border-strong: #d1d5db;
                --pr-surface: #ffffff;
                --pr-surface-soft: #f8fafc;
                --pr-surface-hover: #f3f4f6;
                --pr-danger: #ef4444;
                --pr-success: #10b981;
                --pr-warning: #f59e0b;
                --pr-radius: 8px;
            }
            #pixiv-rank-panel, #pixiv-rank-panel * { box-sizing: border-box; }
            #pixiv-rank-panel button { transition: background-color .18s ease, border-color .18s ease, opacity .18s ease; }
            #pixiv-rank-panel button:disabled { opacity: .5; cursor: not-allowed !important; }
            #pixiv-rank-panel .secondary-btn:hover:not(:disabled) { background: #e5e7eb !important; border-color: #d1d5db !important; }
            #pixiv-rank-panel .primary-btn:hover:not(:disabled) { background: var(--pr-primary-hover) !important; }
            #pixiv-rank-log-box::-webkit-scrollbar, .pixiv-custom-scrollbar::-webkit-scrollbar { width: 6px; }
            #pixiv-rank-log-box::-webkit-scrollbar-thumb, .pixiv-custom-scrollbar::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
            .pixiv-rank-card a:hover .pixiv-rank-img { transform: scale(1.04); }
            .pixiv-rank-card { min-width: 0; }
            .pixiv-rank-img { transition: transform .2s ease; }
            .pixiv-mini-btn { padding: 5px 8px; border: 1px solid #e5e7eb; background: #fff; border-radius: 4px; cursor: pointer; font-size: 11px; color: #4b5563; }
            .pixiv-mini-btn:hover:not(:disabled) { background: #f3f4f6; }
            .pixiv-mini-btn.danger { color: #ef4444; border-color: #fecaca; }
            .pixiv-status-pill { display:inline-flex; align-items:center; gap:4px; padding:2px 6px; border-radius:999px; background:#f3f4f6; color:#6b7280; font-size:10px; }
            .pixiv-bar-track { width: 100%; background: #f3f4f6; border-radius: 4px; height: 8px; overflow: hidden; }
            .pixiv-bar-fill { background: #0096fa; height: 100%; border-radius: 4px; transition: width .25s ease; }
            .pixiv-dashboard-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 1000000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(3px); }
            .pixiv-dashboard-modal { background: #fff; width: 760px; max-width: 92vw; max-height: 86vh; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.2); display: flex; flex-direction: column; animation: pixivFadeIn .2s ease-out; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
            .pixiv-dashboard-header { padding: 16px 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
            .pixiv-dashboard-body { padding: 20px; overflow-y: auto; flex: 1; }
            .pixiv-dashboard-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
            .pixiv-dashboard-table th { padding: 10px 8px; border-bottom: 2px solid #e5e7eb; color: #4b5563; font-weight: 600; }
            .pixiv-dashboard-table td { padding: 10px 8px; border-bottom: 1px solid #f3f4f6; color: #111827; vertical-align: middle; }
            .pixiv-dashboard-table tr:hover td { background: #f9fafb; }
            .pixiv-danger-btn { color: #ef4444; cursor: pointer; padding: 4px 8px; border: 0; background: transparent; border-radius: 4px; }
            .pixiv-danger-btn:hover { background: #fee2e2; }
            @keyframes pixivFadeIn { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
        `;
        document.head.appendChild(style);
    }

    // ==========================================
    // 2. IndexedDB：作品与检索上下文分离
    // ==========================================
    class ArtworkDB {
        constructor() {
            this.db = null;
        }

        async init() {
            if (this.db) return this.db;
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = (event) => {
                    const database = event.target.result;
                    const tx = event.target.transaction;

                    let artworkStore;
                    if (!database.objectStoreNames.contains(ART_STORE)) {
                        artworkStore = database.createObjectStore(ART_STORE, { keyPath: 'id' });
                        artworkStore.createIndex('bookmarkCount', 'bookmarkCount', { unique: false });
                        artworkStore.createIndex('likeCount', 'likeCount', { unique: false });
                        artworkStore.createIndex('viewCount', 'viewCount', { unique: false });
                    } else {
                        artworkStore = tx.objectStore(ART_STORE);
                    }

                    if (!database.objectStoreNames.contains(MEMBERSHIP_STORE)) {
                        const memberships = database.createObjectStore(MEMBERSHIP_STORE, { keyPath: 'key' });
                        memberships.createIndex('contextKey', 'contextKey', { unique: false });
                        memberships.createIndex('artworkId', 'artworkId', { unique: false });
                        memberships.createIndex('tag', 'tag', { unique: false });

                        // v1 数据无法还原当时的完整筛选条件，因此只迁移到“旧版上下文”，避免错误混入新精确上下文。
                        if (event.oldVersion < 2 && artworkStore) {
                            const cursorReq = artworkStore.openCursor();
                            cursorReq.onsuccess = (e) => {
                                const cursor = e.target.result;
                                if (!cursor) return;
                                const art = cursor.value;
                                const tag = art.tag || '未分类';
                                memberships.put({
                                    key: `legacy:${tag}::${art.id}`,
                                    contextKey: `legacy:${tag}`,
                                    contextLabel: `${tag} · 旧版数据`,
                                    artworkId: String(art.id),
                                    tag,
                                    lastSeen: art.updateTime || Date.now(),
                                    legacy: true
                                });
                                cursor.continue();
                            };
                        }
                    }
                };

                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    this.db.onversionchange = () => {
                        this.db.close();
                        this.db = null;
                    };
                    resolve(this.db);
                };
                request.onerror = (event) => reject(event.target.error);
            });
        }

        async putArtwork(art) {
            await this.init();
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction([ART_STORE], 'readwrite');
                tx.objectStore(ART_STORE).put(art);
                tx.oncomplete = () => resolve();
                tx.onerror = (event) => reject(event.target.error);
            });
        }

        async putMembership(artworkId, context) {
            await this.init();
            const membership = {
                key: `${context.key}::${artworkId}`,
                contextKey: context.key,
                contextLabel: context.label,
                artworkId: String(artworkId),
                tag: context.keyword,
                lastSeen: Date.now(),
                legacy: false
            };
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction([MEMBERSHIP_STORE], 'readwrite');
                tx.objectStore(MEMBERSHIP_STORE).put(membership);
                tx.oncomplete = () => resolve();
                tx.onerror = (event) => reject(event.target.error);
            });
        }

        async getArtwork(id) {
            await this.init();
            return new Promise(resolve => {
                const req = this.db.transaction([ART_STORE], 'readonly').objectStore(ART_STORE).get(String(id));
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        }

        async getRawAll() {
            await this.init();
            return new Promise(resolve => {
                const req = this.db.transaction([ART_STORE], 'readonly').objectStore(ART_STORE).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        }

        async getRawMemberships() {
            await this.init();
            return new Promise(resolve => {
                const req = this.db.transaction([MEMBERSHIP_STORE], 'readonly').objectStore(MEMBERSHIP_STORE).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        }

        async getMembershipsForContext(contextKey) {
            await this.init();
            return new Promise(resolve => {
                const tx = this.db.transaction([MEMBERSHIP_STORE], 'readonly');
                const index = tx.objectStore(MEMBERSHIP_STORE).index('contextKey');
                const req = index.getAll(IDBKeyRange.only(contextKey));
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        }

        async getAllForContext(contextKey) {
            const memberships = await this.getMembershipsForContext(contextKey);
            if (!memberships.length) return [];
            const wanted = new Set(memberships.map(item => String(item.artworkId)));
            const all = await this.getRawAll();
            return all.filter(art => wanted.has(String(art.id)));
        }

        async hasLegacyForTag(tag) {
            const memberships = await this.getMembershipsForContext(`legacy:${tag}`);
            return memberships.length > 0;
        }

        async countAll() {
            await this.init();
            return new Promise(resolve => {
                const req = this.db.transaction([ART_STORE], 'readonly').objectStore(ART_STORE).count();
                req.onsuccess = () => resolve(req.result || 0);
                req.onerror = () => resolve(0);
            });
        }

        async deleteContext(contextKey) {
            await this.init();
            await new Promise(resolve => {
                const tx = this.db.transaction([MEMBERSHIP_STORE], 'readwrite');
                const index = tx.objectStore(MEMBERSHIP_STORE).index('contextKey');
                const req = index.openCursor(IDBKeyRange.only(contextKey));
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) return;
                    cursor.delete();
                    cursor.continue();
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
            await this.cleanupOrphans();
        }

        async cleanupOrphans() {
            const memberships = await this.getRawMemberships();
            const referenced = new Set(memberships.map(item => String(item.artworkId)));
            await this.init();
            return new Promise(resolve => {
                const tx = this.db.transaction([ART_STORE], 'readwrite');
                const store = tx.objectStore(ART_STORE);
                const req = store.openCursor();
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) return;
                    if (!referenced.has(String(cursor.value.id))) cursor.delete();
                    cursor.continue();
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        }

        async clearAll() {
            await this.init();
            return new Promise(resolve => {
                const tx = this.db.transaction([ART_STORE, MEMBERSHIP_STORE], 'readwrite');
                tx.objectStore(ART_STORE).clear();
                tx.objectStore(MEMBERSHIP_STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        }
    }

    const db = new ArtworkDB();

    // ==========================================
    // 3. 日志与状态 UI
    // ==========================================
    function logMessage(text, type = 'info') {
        const box = document.getElementById('pixiv-rank-log-box');
        if (!box) return;
        const line = document.createElement('div');
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        line.style.marginBottom = '3px';
        line.style.lineHeight = '1.4';
        line.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : type === 'warn' ? '#f59e0b' : '#6b7280';
        line.textContent = `[${time}] ${text}`;
        box.appendChild(line);
        while (box.childElementCount > 80) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
    }

    async function updateDBStats() {
        const count = await db.countAll();
        const el = document.getElementById('pixiv-db-count');
        if (el) el.textContent = count.toLocaleString();
    }

    function updateDelayDisplay(ms, reason = '基础') {
        const el = document.getElementById('pixiv-fetch-delay');
        const state = document.getElementById('pixiv-fetch-delay-state');
        if (el) el.textContent = `${Math.round(ms)} ms`;
        if (state) state.textContent = reason;
    }

    // ==========================================
    // 4. 自适应串行 Fetch 调度器
    // ==========================================
    class AdaptiveFetcher {
        constructor() {
            const saved = parseInt(localStorage.getItem(DELAY_STORAGE_KEY) || '350', 10);
            this.baseDelay = clamp(Number.isFinite(saved) ? saved : 350, MIN_FETCH_DELAY, MAX_FETCH_DELAY);
            this.backoff = 1000;
            this.successStreak = 0;
            this.tail = Promise.resolve();
            this.activeControllers = new Set();
        }

        saveDelay() {
            localStorage.setItem(DELAY_STORAGE_KEY, String(this.baseDelay));
        }

        setBaseDelay(value) {
            this.baseDelay = clamp(Math.round(value), MIN_FETCH_DELAY, MAX_FETCH_DELAY);
            this.saveDelay();
            updateDelayDisplay(this.baseDelay, '基础');
        }

        async wait(ms, reason) {
            updateDelayDisplay(ms, reason);
            await sleep(ms);
            updateDelayDisplay(this.baseDelay, '基础');
        }

        abortAll() {
            for (const controller of this.activeControllers) controller.abort();
            this.activeControllers.clear();
        }

        requestJSON(url, options = {}) {
            const run = () => this._requestJSONImpl(url, options);
            const result = this.tail.then(run, run);
            this.tail = result.catch(() => undefined);
            return result;
        }

        async _requestJSONImpl(url, options) {
            const {
                label = '请求',
                maxRetries = 4,
                cancelCheck = () => false
            } = options;

            let attempt = 0;
            while (attempt <= maxRetries) {
                if (cancelCheck()) return { ok: false, cancelled: true, status: 0, errorType: 'cancelled' };

                const controller = new AbortController();
                this.activeControllers.add(controller);
                try {
                    const response = await fetch(url, {
                        headers: { 'Accept': 'application/json' },
                        signal: controller.signal
                    });
                    this.activeControllers.delete(controller);

                    if (response.ok) {
                        const json = await response.json();
                        this.backoff = 1000;
                        this.successStreak += 1;
                        if (this.successStreak >= 25 && this.baseDelay > MIN_FETCH_DELAY) {
                            this.setBaseDelay(this.baseDelay - 10);
                            this.successStreak = 0;
                        }
                        await this.wait(this.baseDelay, '节流');
                        return { ok: true, status: response.status, json };
                    }

                    this.successStreak = 0;
                    attempt += 1;

                    if (response.status === 429) {
                        if (attempt > maxRetries) return { ok: false, status: 429, errorType: 'rate-limit' };
                        const delay = this.backoff;
                        logMessage(`${label}: HTTP 429 限流，第 ${attempt}/${maxRetries} 次退避 ${delay}ms`, 'error');
                        this.setBaseDelay(Math.min(MAX_FETCH_DELAY, Math.ceil(this.baseDelay * 1.5)));
                        await this.wait(delay, '429 退避');
                        this.backoff = Math.min(60000, this.backoff * 2);
                        continue;
                    }

                    if (response.status === 403) {
                        if (attempt > Math.min(maxRetries, 3)) return { ok: false, status: 403, errorType: 'forbidden' };
                        const delay = Math.max(2000, this.backoff);
                        logMessage(`${label}: HTTP 403（权限/风控），第 ${attempt}/${Math.min(maxRetries, 3)} 次重试`, 'error');
                        this.setBaseDelay(Math.min(MAX_FETCH_DELAY, Math.ceil(this.baseDelay * 1.35)));
                        await this.wait(delay, '403 退避');
                        this.backoff = Math.min(30000, this.backoff * 2);
                        continue;
                    }

                    if (response.status >= 500 && response.status <= 599 && attempt <= maxRetries) {
                        const delay = Math.min(10000, 1200 * attempt);
                        logMessage(`${label}: HTTP ${response.status}，${delay}ms 后重试`, 'warn');
                        await this.wait(delay, '服务器重试');
                        continue;
                    }

                    return { ok: false, status: response.status, errorType: 'http' };
                } catch (error) {
                    this.activeControllers.delete(controller);
                    if (error && error.name === 'AbortError') {
                        return { ok: false, cancelled: true, status: 0, errorType: 'cancelled' };
                    }
                    attempt += 1;
                    if (attempt > maxRetries) return { ok: false, status: 0, errorType: 'network', error };
                    const delay = Math.min(10000, 1500 * attempt);
                    logMessage(`${label}: 网络异常，第 ${attempt}/${maxRetries} 次重试`, 'error');
                    await this.wait(delay, '网络重试');
                }
            }

            return { ok: false, status: 0, errorType: 'unknown' };
        }
    }

    const fetcher = new AdaptiveFetcher();

    // ==========================================
    // 5. 详情队列与任务控制
    // ==========================================
    class FetchQueue {
        constructor() {
            this.queue = [];
            this.running = false;
            this.paused = false;
            this.stopRequested = false;
            this.totalInCurrentJob = 0;
            this.processedInCurrentJob = 0;
            this.failedInCurrentJob = 0;
            this.seenKeys = new Set();
        }

        prepareForNewWork() {
            if (!this.running && this.queue.length === 0) {
                const shouldReset = this.stopRequested || this.totalInCurrentJob === 0 || this.processedInCurrentJob >= this.totalInCurrentJob;
                this.stopRequested = false;
                if (shouldReset) {
                    this.totalInCurrentJob = 0;
                    this.processedInCurrentJob = 0;
                    this.failedInCurrentJob = 0;
                    this.seenKeys.clear();
                }
            }
            this.updateProgressUI();
        }

        async waitIfPaused() {
            while (this.paused && !this.stopRequested) await sleep(180);
        }

        togglePause() {
            this.paused = !this.paused;
            const btn = document.getElementById('btn-queue-pause');
            if (btn) btn.textContent = this.paused ? '继续' : '暂停';
            logMessage(this.paused ? '任务已暂停。' : '任务已继续。', this.paused ? 'warn' : 'info');
            this.updateProgressUI();
        }

        stop() {
            this.stopRequested = true;
            this.paused = false;
            this.queue.length = 0;
            fetcher.abortAll();
            const btn = document.getElementById('btn-queue-pause');
            if (btn) btn.textContent = '暂停';
            logMessage('已停止当前任务并清空等待队列。', 'warn');
            this.updateProgressUI('已停止');
        }

        enqueue(ids, context) {
            if (!ids.length) return;
            this.stopRequested = false;
            let added = 0;
            for (const id of ids) {
                const key = `${context.key}::${id}`;
                if (this.seenKeys.has(key)) continue;
                this.seenKeys.add(key);
                this.queue.push({ id: String(id), context });
                added += 1;
            }
            if (added > 0) {
                this.totalInCurrentJob += added;
                logMessage(`入队 ${added} 个详情任务，待处理 ${this.queue.length}`, 'info');
                this.updateProgressUI();
            }
            if (!this.running && this.queue.length > 0) this.process();
        }

        updateProgressUI(statusText = '') {
            const container = document.getElementById('pixiv-progress-container');
            if (!container) return;
            const hasWork = scanActive || this.totalInCurrentJob > 0 || this.running || this.queue.length > 0;
            container.style.display = hasWork ? 'block' : 'none';
            if (!hasWork) return;

            const text = document.getElementById('pixiv-progress-text');
            const pctText = document.getElementById('pixiv-progress-pct');
            const fill = document.getElementById('pixiv-progress-fill');
            const state = document.getElementById('pixiv-queue-state');
            const denominator = Math.max(1, this.totalInCurrentJob);
            const pct = Math.floor((this.processedInCurrentJob / denominator) * 100);

            if (text) text.textContent = `详情解析: ${this.processedInCurrentJob} / ${this.totalInCurrentJob} · 失败 ${this.failedInCurrentJob}`;
            if (pctText) pctText.textContent = `${pct}%`;
            if (fill) fill.style.width = `${pct}%`;
            if (state) state.textContent = statusText || (this.paused ? '已暂停' : this.running ? '处理中' : '等待');
        }

        async process() {
            if (this.running) return;
            this.running = true;
            this.updateProgressUI();
            logMessage(`详情队列启动，当前基础 Fetch 延迟 ${fetcher.baseDelay}ms`, 'info');

            while (this.queue.length > 0 && !this.stopRequested) {
                await this.waitIfPaused();
                if (this.stopRequested) break;

                const item = this.queue.shift();
                let counted = false;
                try {
                    await db.putMembership(item.id, item.context);
                    const existing = await db.getArtwork(item.id);
                    const fresh = existing && (Date.now() - (existing.updateTime || 0) < CACHE_TTL);

                    if (!fresh) {
                        logMessage(`API 获取详情: ${item.id}`);
                        const result = await fetcher.requestJSON(`/ajax/illust/${item.id}`, {
                            label: `作品 ${item.id}`,
                            maxRetries: 5,
                            cancelCheck: () => this.stopRequested
                        });

                        if (result.cancelled) {
                            if (!this.stopRequested) this.queue.unshift(item);
                            break;
                        }

                        if (!result.ok) {
                            this.failedInCurrentJob += 1;
                            counted = true;
                            const detail = result.status ? `HTTP ${result.status}` : result.errorType;
                            logMessage(`详情获取失败 ${item.id}: ${detail}，已跳过`, 'error');
                        } else {
                            const json = result.json;
                            if (json && !json.error && json.body) {
                                const body = json.body;
                                await db.putArtwork({
                                    id: String(item.id),
                                    title: body.illustTitle || body.title || 'Untitled',
                                    userName: body.userName || '',
                                    userId: String(body.userId || ''),
                                    bookmarkCount: Number(body.bookmarkCount || 0),
                                    likeCount: Number(body.likeCount || 0),
                                    viewCount: Number(body.viewCount || 0),
                                    isR18: body.xRestrict === 1 || body.xRestrict === 2,
                                    isAi: body.aiType === 2,
                                    thumbUrl: body.urls ? (body.urls.small || body.urls.regular || body.urls.thumb || '') : '',
                                    updateTime: Date.now()
                                });
                                logMessage(`成功入库: ${item.id}（收藏 ${Number(body.bookmarkCount || 0).toLocaleString()}）`, 'success');
                            } else {
                                this.failedInCurrentJob += 1;
                                logMessage(`详情响应结构异常: ${item.id}`, 'error');
                            }
                            counted = true;
                        }
                    } else {
                        counted = true;
                    }
                } catch (error) {
                    this.failedInCurrentJob += 1;
                    counted = true;
                    logMessage(`本地处理异常: ${item.id} · ${error?.message || 'unknown'}`, 'error');
                }

                if (counted) {
                    this.processedInCurrentJob += 1;
                    this.updateProgressUI();
                }
            }

            this.running = false;
            const stopped = this.stopRequested;
            this.updateProgressUI(stopped ? '已停止' : '已完成');
            updateDBStats();
            if (!stopped) logMessage('当前详情队列处理完毕。', 'success');

            setTimeout(() => {
                if (!this.running && this.queue.length === 0) {
                    this.totalInCurrentJob = 0;
                    this.processedInCurrentJob = 0;
                    this.failedInCurrentJob = 0;
                    this.seenKeys.clear();
                    this.stopRequested = false;
                    this.updateProgressUI();
                }
            }, 4000);
        }
    }

    const queue = new FetchQueue();
    let scanAbortRequested = false;
    let scanActive = false;
    let scanTotal = 0;
    let scanProcessed = 0;
    let scanDiscovered = 0;

    function updateScanUI() {
        const row = document.getElementById('pixiv-scan-progress');
        if (!row) return;
        const container = document.getElementById('pixiv-progress-container');
        if (scanActive && container) container.style.display = 'block';
        if (scanTotal <= 0) {
            row.textContent = '搜索页扫描: -';
            return;
        }
        row.textContent = `搜索页扫描: ${scanProcessed} / ${scanTotal} · 已发现 ${scanDiscovered}`;
    }

    // ==========================================
    // 6. 搜索页抓取
    // ==========================================
    async function fetchSearchPage(context, page) {
        const params = new URLSearchParams(context.query);
        params.set('p', String(page));
        const url = `/ajax/search/artworks/${encodeURIComponent(context.keyword)}?${params.toString()}`;

        const result = await fetcher.requestJSON(url, {
            label: `搜索页 ${page}`,
            maxRetries: 4,
            cancelCheck: () => scanAbortRequested || queue.stopRequested
        });

        if (!result.ok) return result;
        const data = result.json;
        const list = data?.body?.illustManga?.data || [];
        const ids = [...new Set(list.map(item => String(item.id)).filter(id => /^\d+$/.test(id)))];
        return { ok: true, status: result.status, ids };
    }

    // ==========================================
    // 7. Pixiv 原生作品容器定位
    // ==========================================
    let nativeArtworkContainer = null;

    function findArtworkContainer() {
        if (nativeArtworkContainer && nativeArtworkContainer.isConnected && !nativeArtworkContainer.closest('#pixiv-rank-wrapper')) {
            const links = nativeArtworkContainer.querySelectorAll('a[href*="/artworks/"]');
            if (links.length > 0) return nativeArtworkContainer;
        }

        const links = Array.from(document.querySelectorAll('a[href*="/artworks/"]')).filter(link =>
            !link.closest('#pixiv-rank-wrapper') &&
            !link.closest('#pixiv-rank-panel') &&
            !link.closest('#pixiv-db-overlay')
        );
        if (links.length === 0) return null;

        const parentCounts = new Map();
        for (const link of links) {
            let parent = link.parentElement;
            let depth = 0;
            while (parent && depth < 7) {
                if (parent.id !== 'pixiv-rank-wrapper' && parent.tagName !== 'BODY' && parent.tagName !== 'HTML') {
                    parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1);
                }
                parent = parent.parentElement;
                depth += 1;
            }
        }

        let bestContainer = null;
        let maxCount = 0;
        for (const [element, count] of parentCounts.entries()) {
            if (count > maxCount && count >= Math.max(2, links.length / 3)) {
                maxCount = count;
                bestContainer = element;
            }
        }

        nativeArtworkContainer = bestContainer;
        return bestContainer;
    }

    function restoreNativeResults() {
        const wrapper = document.getElementById('pixiv-rank-wrapper');
        if (wrapper) wrapper.style.display = 'none';
        const container = findArtworkContainer();
        if (container) container.style.display = '';
        logMessage('已恢复 Pixiv 原生结果。', 'info');
    }

    // ==========================================
    // 8. 数据库 Dashboard
    // ==========================================
    async function renderDBDashboard() {
        document.getElementById('pixiv-db-overlay')?.remove();

        const [allData, memberships] = await Promise.all([db.getRawAll(), db.getRawMemberships()]);
        const artMap = new Map(allData.map(art => [String(art.id), art]));
        const stats = new Map();
        let totalBytes = 0;

        for (const art of allData) totalBytes += JSON.stringify(art).length * 2;
        for (const membership of memberships) totalBytes += JSON.stringify(membership).length * 2;

        for (const membership of memberships) {
            const key = membership.contextKey;
            if (!stats.has(key)) {
                stats.set(key, {
                    key,
                    label: membership.contextLabel || membership.tag || key,
                    count: 0,
                    latestUpdate: 0,
                    sizeBytes: 0,
                    legacy: Boolean(membership.legacy)
                });
            }
            const stat = stats.get(key);
            stat.count += 1;
            stat.latestUpdate = Math.max(stat.latestUpdate, membership.lastSeen || 0);
            stat.sizeBytes += JSON.stringify(membership).length * 2;
            const art = artMap.get(String(membership.artworkId));
            if (art) stat.sizeBytes += JSON.stringify(art).length * 2;
        }

        const sorted = [...stats.values()].sort((a, b) => b.count - a.count);
        const maxCount = sorted.length ? sorted[0].count : 1;

        const overlay = createElement('div', 'pixiv-dashboard-overlay');
        overlay.id = 'pixiv-db-overlay';
        const modal = createElement('div', 'pixiv-dashboard-modal');

        const header = createElement('div', 'pixiv-dashboard-header');
        const title = createElement('div', '', '本地数据库总览');
        title.style.cssText = 'font-size:16px;font-weight:700;color:#111827;';
        const close = createElement('button', '', '×');
        close.type = 'button';
        close.style.cssText = 'border:0;background:transparent;color:#9ca3af;font-size:22px;cursor:pointer;line-height:1;';
        close.onclick = () => overlay.remove();
        header.append(title, close);

        const body = createElement('div', 'pixiv-dashboard-body pixiv-custom-scrollbar');
        const summary = createElement('div');
        summary.style.cssText = 'display:flex;gap:20px;margin-bottom:20px;background:#f9fafb;padding:16px;border-radius:8px;border:1px solid #f3f4f6;align-items:center;';

        const makeMetric = (label, value) => {
            const wrap = createElement('div');
            const l = createElement('div', '', label);
            l.style.cssText = 'font-size:12px;color:#6b7280;';
            const v = createElement('div', '', value);
            v.style.cssText = 'font-size:20px;font-weight:700;color:#111827;';
            wrap.append(l, v);
            return wrap;
        };

        summary.append(
            makeMetric('唯一作品', allData.length.toLocaleString()),
            makeMetric('检索上下文', sorted.length.toLocaleString()),
            makeMetric('上下文关联', memberships.length.toLocaleString()),
            makeMetric('预估存储', formatBytes(totalBytes))
        );

        const clearAll = createElement('button', '', '清空全部数据');
        clearAll.type = 'button';
        clearAll.style.cssText = 'margin-left:auto;padding:6px 12px;background:#fff;color:#ef4444;border:1px solid #ef4444;border-radius:4px;font-size:12px;cursor:pointer;font-weight:600;';
        clearAll.onclick = async () => {
            if (!confirm('确定要清空本地收集的全部 Pixiv 排行数据吗？')) return;
            await db.clearAll();
            await updateDBStats();
            renderDBDashboard();
        };
        summary.appendChild(clearAll);
        body.appendChild(summary);

        const table = createElement('table', 'pixiv-dashboard-table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const text of ['检索上下文', '关联量', '预估体积', '最后出现', '操作']) {
            headRow.appendChild(createElement('th', '', text));
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        if (!sorted.length) {
            const row = document.createElement('tr');
            const cell = createElement('td', '', '数据库暂无记录');
            cell.colSpan = 5;
            cell.style.cssText = 'text-align:center;padding:20px;color:#9ca3af;';
            row.appendChild(cell);
            tbody.appendChild(row);
        } else {
            for (const stat of sorted) {
                const row = document.createElement('tr');

                const nameCell = document.createElement('td');
                const name = createElement('div', '', stat.label);
                name.style.cssText = 'font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                name.title = stat.label;
                nameCell.appendChild(name);
                if (stat.legacy) {
                    const legacy = createElement('span', 'pixiv-status-pill', 'v1 旧数据');
                    legacy.style.marginTop = '4px';
                    nameCell.appendChild(legacy);
                }

                const countCell = document.createElement('td');
                const countWrap = createElement('div');
                countWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
                const countText = createElement('span', '', stat.count.toLocaleString());
                countText.style.minWidth = '42px';
                const track = createElement('div', 'pixiv-bar-track');
                track.style.cssText = 'flex:1;max-width:130px;';
                const fill = createElement('div', 'pixiv-bar-fill');
                fill.style.width = `${(stat.count / maxCount) * 100}%`;
                track.appendChild(fill);
                countWrap.append(countText, track);
                countCell.appendChild(countWrap);

                const sizeCell = createElement('td', '', formatBytes(stat.sizeBytes));
                sizeCell.style.color = '#6b7280';
                const dateCell = createElement('td', '', formatDate(stat.latestUpdate));
                dateCell.style.cssText = 'color:#6b7280;font-size:12px;';

                const actionCell = document.createElement('td');
                const remove = createElement('button', 'pixiv-danger-btn', '清除');
                remove.type = 'button';
                remove.onclick = async () => {
                    if (!confirm(`确定清除检索上下文「${stat.label}」的全部关联数据吗？共享作品会在无其他引用时自动回收。`)) return;
                    await db.deleteContext(stat.key);
                    await updateDBStats();
                    renderDBDashboard();
                };
                actionCell.appendChild(remove);

                row.append(nameCell, countCell, sizeCell, dateCell, actionCell);
                tbody.appendChild(row);
            }
        }
        table.appendChild(tbody);
        body.appendChild(table);

        modal.append(header, body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) overlay.remove();
        });
    }

    // ==========================================
    // 9. 跨页排序渲染（完全使用 DOM API，避免注入用户数据）
    // ==========================================
    function createArtworkCard(art) {
        const card = createElement('div', 'pixiv-rank-card');
        const link = document.createElement('a');
        link.href = `/artworks/${encodeURIComponent(String(art.id))}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'display:flex;flex-direction:column;text-decoration:none;color:inherit;width:100%;';

        const imageBox = createElement('div');
        imageBox.style.cssText = 'position:relative;width:100%;aspect-ratio:1/1;border-radius:6px;overflow:hidden;background:rgba(128,128,128,.1);';
        const img = document.createElement('img');
        img.src = art.thumbUrl || '';
        img.alt = art.title || '';
        img.loading = 'lazy';
        img.className = 'pixiv-rank-img';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        imageBox.appendChild(img);

        const bookmark = createElement('div', '', `收藏: ${Number(art.bookmarkCount || 0).toLocaleString()}`);
        bookmark.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,.62);color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;backdrop-filter:blur(2px);';
        imageBox.appendChild(bookmark);

        if (art.isR18) {
            const badge = createElement('div', '', 'R-18');
            badge.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(224,36,94,.95);color:#fff;padding:2px 4px;border-radius:3px;font-size:10px;font-weight:700;';
            imageBox.appendChild(badge);
        }
        if (art.isAi) {
            const badge = createElement('div', '', 'AI');
            badge.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,.62);color:#fff;padding:2px 4px;border-radius:3px;font-size:10px;';
            imageBox.appendChild(badge);
        }

        const meta = createElement('div');
        meta.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:4px;';
        const title = createElement('div', '', art.title || 'Untitled');
        title.title = art.title || 'Untitled';
        title.style.cssText = 'font-size:14px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

        const sub = createElement('div');
        sub.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
        const user = createElement('span', '', art.userName || '');
        user.style.cssText = 'font-size:12px;color:rgba(128,128,128,.9);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const views = Number(art.viewCount || 0);
        const viewLabel = views >= 1000 ? `${(views / 1000).toFixed(1)}k 阅` : `${views} 阅`;
        const view = createElement('span', '', viewLabel);
        view.style.cssText = 'font-size:11px;color:rgba(128,128,128,.65);white-space:nowrap;';
        sub.append(user, view);
        meta.append(title, sub);
        link.append(imageBox, meta);
        card.appendChild(link);
        return card;
    }

    async function renderRankedArtworks(sortType = 'bookmark', minFav = 0) {
        const container = findArtworkContainer();
        if (!container || !container.parentElement) {
            alert('未能定位 Pixiv 原生作品列表，请确认当前搜索结果已加载完成。');
            return;
        }

        const context = buildSearchContext();
        let list = await db.getAllForContext(context.key);
        if (!list.length) {
            if (await db.hasLegacyForTag(context.keyword)) {
                alert('检测到 v1 旧缓存，但旧数据没有完整筛选上下文。请按当前筛选重新抓取一次后再排序。');
            } else {
                alert('当前检索条件暂无精确缓存，请先抓取对应页数。');
            }
            return;
        }

        if (minFav > 0) list = list.filter(art => Number(art.bookmarkCount || 0) >= minFav);
        list.sort((a, b) => {
            if (sortType === 'bookmark') return Number(b.bookmarkCount || 0) - Number(a.bookmarkCount || 0);
            if (sortType === 'like') return Number(b.likeCount || 0) - Number(a.likeCount || 0);
            if (sortType === 'view') return Number(b.viewCount || 0) - Number(a.viewCount || 0);
            if (sortType === 'rate') {
                const rateA = Number(a.viewCount || 0) > 0 ? Number(a.bookmarkCount || 0) / Number(a.viewCount || 0) : 0;
                const rateB = Number(b.viewCount || 0) > 0 ? Number(b.bookmarkCount || 0) / Number(b.viewCount || 0) : 0;
                return rateB - rateA;
            }
            return 0;
        });

        let wrapper = document.getElementById('pixiv-rank-wrapper');
        if (!wrapper) {
            wrapper = createElement('div');
            wrapper.id = 'pixiv-rank-wrapper';
            wrapper.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(184px,1fr));gap:24px 20px;width:100%;padding-top:16px;';
        }
        if (wrapper.parentElement !== container.parentElement || wrapper.nextSibling !== container) {
            container.parentElement.insertBefore(wrapper, container);
        }

        container.style.display = 'none';
        wrapper.style.display = 'grid';
        wrapper.replaceChildren();

        const fragment = document.createDocumentFragment();
        for (const art of list) fragment.appendChild(createArtworkCard(art));
        wrapper.appendChild(fragment);
        logMessage(`跨页排序完成：${list.length} 个作品 · ${context.label}`, 'success');
    }

    // ==========================================
    // 10. 控制面板与拖拽
    // ==========================================
    function enablePanelDrag(panel, handle) {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        const restore = () => {
            try {
                const raw = localStorage.getItem(PANEL_POS_STORAGE_KEY);
                if (!raw) return;
                const pos = JSON.parse(raw);
                if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
                const rect = panel.getBoundingClientRect();
                const left = clamp(pos.left, 8, Math.max(8, window.innerWidth - rect.width - 8));
                const top = clamp(pos.top, 8, Math.max(8, window.innerHeight - 48));
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
                panel.style.right = 'auto';
            } catch (_) {}
        };

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('[data-no-drag]')) return;
            const rect = panel.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            const left = clamp(event.clientX - offsetX, 8, Math.max(8, window.innerWidth - rect.width - 8));
            const top = clamp(event.clientY - offsetY, 8, Math.max(8, window.innerHeight - 48));
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        });

        const finish = event => {
            if (!dragging) return;
            dragging = false;
            try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
            const rect = panel.getBoundingClientRect();
            localStorage.setItem(PANEL_POS_STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        window.addEventListener('resize', restore);
        requestAnimationFrame(restore);
    }

    function createControlPanel() {
        injectCSS();
        if (document.getElementById('pixiv-rank-panel')) return;

        const panel = createElement('div');
        panel.id = 'pixiv-rank-panel';
        panel.style.cssText = `
            position:fixed;top:75px;right:24px;z-index:99999;width:328px;
            background:#fff;color:#374151;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);
            border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
            font-size:13px;padding:16px;user-select:none;
        `;

        panel.innerHTML = `
            <div id="pixiv-rank-drag-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;cursor:move;touch-action:none;">
                <span style="font-weight:600;font-size:14px;color:#111827;">Pixiv 跨页排序引擎</span>
                <span id="pixiv-rank-toggle-btn" data-no-drag style="cursor:pointer;color:#9ca3af;font-size:12px;">▼ 收起</span>
            </div>
            <div id="pixiv-rank-panel-body">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;color:#4b5563;gap:8px;">
                    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">标签: <strong id="pixiv-current-tag" style="color:#111827;"></strong></span>
                    <span style="white-space:nowrap;">总库: <strong id="pixiv-db-count" style="color:#0096fa;">0</strong> <a id="btn-open-db" style="color:#0096fa;cursor:pointer;margin-left:3px;">DB</a></span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:11px;color:#6b7280;">
                    <span>当前 Fetch 延迟: <strong id="pixiv-fetch-delay" style="color:#111827;">-</strong></span>
                    <span id="pixiv-fetch-delay-state" class="pixiv-status-pill">基础</span>
                </div>
                <div id="pixiv-rank-log-box" style="height:108px;overflow-y:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;margin-bottom:12px;"></div>

                <div id="pixiv-progress-container" style="display:none;margin-bottom:14px;padding:9px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;">
                    <div id="pixiv-scan-progress" style="font-size:11px;color:#6b7280;margin-bottom:5px;">搜索页扫描: -</div>
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-bottom:4px;">
                        <span id="pixiv-progress-text">详情解析: 0 / 0</span>
                        <span id="pixiv-progress-pct" style="font-weight:600;color:#0096fa;">0%</span>
                    </div>
                    <div class="pixiv-bar-track"><div id="pixiv-progress-fill" class="pixiv-bar-fill" style="width:0%;"></div></div>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:8px;">
                        <span id="pixiv-queue-state" class="pixiv-status-pill">等待</span>
                        <button id="btn-queue-pause" class="pixiv-mini-btn" type="button">暂停</button>
                        <button id="btn-queue-stop" class="pixiv-mini-btn danger" type="button">停止</button>
                    </div>
                </div>

                <div style="margin-bottom:16px;">
                    <label style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;color:#4b5563;">
                        <span>批量抓取范围</span>
                        <span style="color:#9ca3af;font-size:11px;" title="继承当前 Pixiv URL 的官方筛选参数，并按完整筛选上下文隔离缓存">精确继承筛选</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                        <span style="font-size:12px;">从第</span>
                        <input type="number" id="pixiv-page-start" min="1" step="5" style="width:52px;padding:5px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:12px;text-align:center;">
                        <span style="font-size:12px;">页起，连续</span>
                        <input type="number" id="pixiv-page-count" min="1" value="5" style="width:52px;padding:5px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:12px;text-align:center;">
                        <span style="font-size:12px;">页</span>
                    </div>
                    <button id="btn-fetch-range" class="secondary-btn" style="width:100%;padding:7px 0;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500;">开始后台抓取</button>
                </div>

                <div style="margin-bottom:12px;">
                    <label style="display:block;margin-bottom:6px;font-size:12px;color:#4b5563;">全局展现维度</label>
                    <select id="pixiv-rank-sort-select" style="width:100%;padding:7px 8px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:12px;">
                        <option value="bookmark">按收藏数最高</option>
                        <option value="rate">按收藏比率最高</option>
                        <option value="like">按点赞数最高</option>
                        <option value="view">按浏览量最高</option>
                    </select>
                </div>

                <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                    <span style="font-size:12px;color:#4b5563;">滤除低收藏:</span>
                    <input type="number" id="pixiv-min-fav" value="0" min="0" step="50" style="width:76px;padding:5px 8px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:12px;">
                </div>

                <button id="btn-apply-sort" class="primary-btn" style="width:100%;padding:9px 0;background:#0096fa;color:#fff;font-weight:600;border:0;border-radius:4px;cursor:pointer;font-size:13px;">跨页展现并排序全部记录</button>
                <button id="btn-restore-native" class="secondary-btn" style="width:100%;padding:7px 0;margin-top:7px;background:#fff;color:#6b7280;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer;font-size:12px;">恢复 Pixiv 原生结果</button>
            </div>
        `;

        document.body.appendChild(panel);

        const tagEl = document.getElementById('pixiv-current-tag');
        const inputStart = document.getElementById('pixiv-page-start');
        const inputCount = document.getElementById('pixiv-page-count');
        const btnFetchRange = document.getElementById('btn-fetch-range');
        const btnApply = document.getElementById('btn-apply-sort');
        const sortSelect = document.getElementById('pixiv-rank-sort-select');
        const minFavInput = document.getElementById('pixiv-min-fav');
        const toggleBtn = document.getElementById('pixiv-rank-toggle-btn');
        const panelBody = document.getElementById('pixiv-rank-panel-body');
        const dragHeader = document.getElementById('pixiv-rank-drag-header');

        tagEl.textContent = getCurrentSearchTag();
        tagEl.title = buildSearchContext().label;
        inputStart.value = String(getCurrentPageNumber());
        inputStart.step = inputCount.value;

        inputCount.addEventListener('change', () => {
            const step = parseInt(inputCount.value, 10);
            if (Number.isFinite(step) && step > 0) inputStart.step = String(step);
        });

        document.getElementById('btn-open-db').onclick = renderDBDashboard;
        document.getElementById('btn-queue-pause').onclick = () => queue.togglePause();
        document.getElementById('btn-queue-stop').onclick = () => {
            scanAbortRequested = true;
            queue.stop();
        };
        document.getElementById('btn-restore-native').onclick = restoreNativeResults;

        toggleBtn.onclick = () => {
            const hidden = panelBody.style.display === 'none';
            panelBody.style.display = hidden ? 'block' : 'none';
            toggleBtn.textContent = hidden ? '▼ 收起' : '▶ 展开';
        };

        btnFetchRange.onclick = async () => {
            const startPage = parseInt(inputStart.value, 10);
            const count = parseInt(inputCount.value, 10);
            if (!Number.isFinite(startPage) || !Number.isFinite(count) || startPage < 1 || count < 1) {
                logMessage('无效的抓取范围配置。', 'error');
                return;
            }

            const context = buildSearchContext();
            const endPage = startPage + count - 1;
            scanAbortRequested = false;
            scanActive = true;
            queue.prepareForNewWork();
            scanTotal = count;
            scanProcessed = 0;
            scanDiscovered = 0;
            updateScanUI();
            btnFetchRange.disabled = true;
            logMessage(`扫描第 ${startPage}–${endPage} 页 · ${context.label}`, 'info');

            const discoveredSet = new Set();
            try {
                for (let page = startPage; page <= endPage; page += 1) {
                    await queue.waitIfPaused();
                    if (scanAbortRequested || queue.stopRequested) break;

                    logMessage(`抓取搜索页: ${page}`);
                    const result = await fetchSearchPage(context, page);
                    if (result.cancelled || scanAbortRequested || queue.stopRequested) break;

                    if (!result.ok) {
                        const detail = result.status ? `HTTP ${result.status}` : result.errorType;
                        logMessage(`第 ${page} 页抓取失败：${detail}。本批扫描停止，未将其误判为空页。`, 'error');
                        break;
                    }

                    scanProcessed += 1;
                    for (const id of result.ids) discoveredSet.add(id);
                    scanDiscovered = discoveredSet.size;
                    updateScanUI();

                    if (result.ids.length === 0) {
                        logMessage(`第 ${page} 页正常返回但无作品，停止向后扫描。`, 'warn');
                        break;
                    }
                    queue.enqueue(result.ids, context);
                }
            } finally {
                scanActive = false;
                btnFetchRange.disabled = false;
                if (!scanAbortRequested && !queue.stopRequested) {
                    inputStart.value = String(startPage + count);
                    logMessage(`搜索页扫描结束，共发现 ${scanDiscovered} 个唯一作品。`, 'success');
                }
                if (!queue.running && queue.queue.length === 0 && queue.totalInCurrentJob === 0) {
                    setTimeout(() => {
                        scanTotal = 0;
                        scanProcessed = 0;
                        scanDiscovered = 0;
                        updateScanUI();
                        queue.updateProgressUI();
                    }, 1500);
                }
            }
        };

        btnApply.onclick = () => {
            const minFav = Math.max(0, parseInt(minFavInput.value || '0', 10) || 0);
            renderRankedArtworks(sortSelect.value, minFav);
        };

        enablePanelDrag(panel, dragHeader);
        updateDBStats();
        updateDelayDisplay(fetcher.baseDelay, '基础');
        updateScanUI();
        queue.updateProgressUI();
    }

    // ==========================================
    // 11. SPA 路由感知
    // ==========================================
    function init() {
        createControlPanel();
    }

    function handleRouteChange() {
        nativeArtworkContainer = null;
        const panel = document.getElementById('pixiv-rank-panel');
        if (isSearchPage()) {
            init();
            if (panel) panel.style.display = 'block';

            const tagEl = document.getElementById('pixiv-current-tag');
            if (tagEl) {
                tagEl.textContent = getCurrentSearchTag();
                tagEl.title = buildSearchContext().label;
            }
            const startEl = document.getElementById('pixiv-page-start');
            const countEl = document.getElementById('pixiv-page-count');
            if (startEl && countEl) {
                startEl.value = String(getCurrentPageNumber());
                startEl.step = countEl.value;
            }
        } else if (panel) {
            panel.style.display = 'none';
        }

        const wrapper = document.getElementById('pixiv-rank-wrapper');
        if (wrapper) wrapper.style.display = 'none';
        setTimeout(() => {
            const container = findArtworkContainer();
            if (container) container.style.display = '';
        }, 0);
    }

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        handleRouteChange();
    }, 600);

    if (isSearchPage()) init();
})();
