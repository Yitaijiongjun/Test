// ==UserScript==
// @name         Pixiv 智能跨页排行助手 (全能进阶版)
// @namespace    https://github.com/
// @version      3.0.0
// @description  作品中心本地数据库：宽泛采集作品 ID，保存完整元数据与 Pixiv 中文标签翻译，本地自由筛选、组合标签与跨页排序。
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
    const DB_VERSION = 3;
    const ART_STORE = 'artworks';
    const CACHE_TTL = 7 * 86400 * 1000;

    const DELAY_STORAGE_KEY = 'PixivSmartRank_Delay';
    const FETCH_SETTINGS_STORAGE_KEY = 'PixivSmartRank_FetchSettings';
    const PANEL_POS_STORAGE_KEY = 'PixivSmartRank_PanelPos';
    const HARD_MIN_FETCH_DELAY = 30;
    const HARD_MAX_FETCH_DELAY = 10000;
    const DEFAULT_FETCH_SETTINGS = Object.freeze({
        baseDelay: 160,
        minDelay: 60,
        maxDelay: 2500,
        successThreshold: 4,
        speedupStep: 20,
        rateLimitMultiplier: 1.25,
        forbiddenMultiplier: 1.12,
        backoffStart: 700,
        backoffMax: 20000
    });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function safeDecode(value) {
        try { return decodeURIComponent(value); } catch (_) { return value; }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(2) + ' MB';
    }

    function formatDate(msOrDate) {
        if (!msOrDate) return '-';
        const d = new Date(msOrDate);
        if (Number.isNaN(d.getTime())) return '-';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function createElement(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== '') node.textContent = text;
        return node;
    }

    function normalizeText(value) {
        return String(value || '').trim().toLocaleLowerCase();
    }

    function isSearchPage() {
        return location.pathname.includes('/tags/') || location.pathname.includes('/search/');
    }

    // 仅用于给“采集关键词”输入框提供默认值，不参与数据库归属与本地筛选。
    function getCurrentDiscoveryKeyword() {
        const match = location.pathname.match(/\/tags\/([^/]+)/);
        if (match) return safeDecode(match[1]);
        return new URLSearchParams(location.search).get('word') || '';
    }

    function getCurrentPageNumber() {
        const value = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
        return Number.isFinite(value) && value > 0 ? value : 1;
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
    // 2. IndexedDB：V3 作品中心数据库
    // ==========================================
    class ArtworkDB {
        constructor() {
            this.db = null;
        }

        async init() {
            if (this.db) return this.db;
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = event => {
                    const database = event.target.result;

                    // V3 不兼容旧模型：直接重建，保持结构干净。
                    for (const storeName of Array.from(database.objectStoreNames)) {
                        database.deleteObjectStore(storeName);
                    }

                    const store = database.createObjectStore(ART_STORE, { keyPath: 'id' });
                    store.createIndex('bookmarkCount', 'bookmarkCount', { unique: false });
                    store.createIndex('likeCount', 'likeCount', { unique: false });
                    store.createIndex('viewCount', 'viewCount', { unique: false });
                    store.createIndex('userId', 'userId', { unique: false });
                    store.createIndex('isR18', 'isR18', { unique: false });
                    store.createIndex('isAi', 'isAi', { unique: false });
                    store.createIndex('tagNames', 'tagNames', { unique: false, multiEntry: true });
                    store.createIndex('createDate', 'createDate', { unique: false });
                };

                request.onsuccess = event => {
                    this.db = event.target.result;
                    this.db.onversionchange = () => {
                        this.db.close();
                        this.db = null;
                    };
                    resolve(this.db);
                };
                request.onerror = event => reject(event.target.error);
            });
        }

        async putArtwork(art) {
            await this.init();
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction([ART_STORE], 'readwrite');
                tx.objectStore(ART_STORE).put(art);
                tx.oncomplete = () => resolve();
                tx.onerror = event => reject(event.target.error);
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

        async getAllByTag(tagName) {
            await this.init();
            return new Promise(resolve => {
                const tx = this.db.transaction([ART_STORE], 'readonly');
                const req = tx.objectStore(ART_STORE).index('tagNames').getAll(String(tagName));
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        }

        async countAll() {
            await this.init();
            return new Promise(resolve => {
                const req = this.db.transaction([ART_STORE], 'readonly').objectStore(ART_STORE).count();
                req.onsuccess = () => resolve(req.result || 0);
                req.onerror = () => resolve(0);
            });
        }

        async clearAll() {
            await this.init();
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction([ART_STORE], 'readwrite');
                tx.objectStore(ART_STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = event => reject(event.target.error);
            });
        }

        async getTagCatalog() {
            const all = await this.getRawAll();
            const catalog = new Map();

            for (const art of all) {
                const seen = new Set();
                for (const tag of Array.isArray(art.tags) ? art.tags : []) {
                    const name = String(tag?.name || '').trim();
                    if (!name || seen.has(name)) continue;
                    seen.add(name);

                    const translatedName = String(tag?.translatedName || '').trim();
                    const current = catalog.get(name);
                    if (current) {
                        current.count += 1;
                        if (!current.translatedName && translatedName) current.translatedName = translatedName;
                    } else {
                        catalog.set(name, { name, translatedName, count: 1 });
                    }
                }
            }

            return [...catalog.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        }

        async queryArtworks({ tags = [], ai = 'all', r18 = 'all', minFav = 0 } = {}) {
            let list = tags.length ? await this.getAllByTag(tags[0]) : await this.getRawAll();

            if (tags.length > 1) {
                const rest = tags.slice(1);
                list = list.filter(art => {
                    const names = new Set(Array.isArray(art.tagNames) ? art.tagNames : []);
                    return rest.every(tag => names.has(tag));
                });
            }

            if (ai === 'exclude') list = list.filter(art => !art.isAi);
            else if (ai === 'only') list = list.filter(art => Boolean(art.isAi));

            if (r18 === 'exclude') list = list.filter(art => !art.isR18);
            else if (r18 === 'only') list = list.filter(art => Boolean(art.isR18));

            if (minFav > 0) {
                list = list.filter(art => Number(art.bookmarkCount || 0) >= minFav);
            }

            return list;
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
            this.settings = this.loadSettings();
            this.baseDelay = this.settings.baseDelay;
            this.backoff = this.settings.backoffStart;
            this.successStreak = 0;
            this.tail = Promise.resolve();
            this.activeControllers = new Set();
        }

        normalizeSettings(input = {}) {
            const numberOr = (value, fallback) => {
                const n = Number(value);
                return Number.isFinite(n) ? n : fallback;
            };

            const minDelay = clamp(Math.round(numberOr(input.minDelay, DEFAULT_FETCH_SETTINGS.minDelay)), HARD_MIN_FETCH_DELAY, HARD_MAX_FETCH_DELAY);
            const maxDelay = clamp(Math.round(numberOr(input.maxDelay, DEFAULT_FETCH_SETTINGS.maxDelay)), minDelay, HARD_MAX_FETCH_DELAY);
            const baseDelay = clamp(Math.round(numberOr(input.baseDelay, DEFAULT_FETCH_SETTINGS.baseDelay)), minDelay, maxDelay);

            return {
                baseDelay,
                minDelay,
                maxDelay,
                successThreshold: clamp(Math.round(numberOr(input.successThreshold, DEFAULT_FETCH_SETTINGS.successThreshold)), 1, 50),
                speedupStep: clamp(Math.round(numberOr(input.speedupStep, DEFAULT_FETCH_SETTINGS.speedupStep)), 1, 1000),
                rateLimitMultiplier: clamp(numberOr(input.rateLimitMultiplier, DEFAULT_FETCH_SETTINGS.rateLimitMultiplier), 1.05, 4),
                forbiddenMultiplier: clamp(numberOr(input.forbiddenMultiplier, DEFAULT_FETCH_SETTINGS.forbiddenMultiplier), 1.02, 3),
                backoffStart: clamp(Math.round(numberOr(input.backoffStart, DEFAULT_FETCH_SETTINGS.backoffStart)), 200, 10000),
                backoffMax: clamp(Math.round(numberOr(input.backoffMax, DEFAULT_FETCH_SETTINGS.backoffMax)), 2000, 60000)
            };
        }

        loadSettings() {
            let saved = {};
            try {
                saved = JSON.parse(localStorage.getItem(FETCH_SETTINGS_STORAGE_KEY) || '{}') || {};
            } catch (_) {
                saved = {};
            }

            // v2.0 只保存单一 delay；首次升级时继承它，但不再受旧的 250ms 下限约束。
            const legacy = parseInt(localStorage.getItem(DELAY_STORAGE_KEY) || '', 10);
            if (!Number.isFinite(Number(saved.baseDelay)) && Number.isFinite(legacy)) {
                // 首次从 v2.0 升级时直接采用更快的新默认值，不让旧的保守延迟继续拖慢新版。
                saved.baseDelay = Math.min(legacy, DEFAULT_FETCH_SETTINGS.baseDelay);
            }
            return this.normalizeSettings({ ...DEFAULT_FETCH_SETTINGS, ...saved });
        }

        saveSettings() {
            this.settings.baseDelay = this.baseDelay;
            localStorage.setItem(FETCH_SETTINGS_STORAGE_KEY, JSON.stringify(this.settings));
            localStorage.setItem(DELAY_STORAGE_KEY, String(this.baseDelay));
        }

        getSettings() {
            return { ...this.settings, baseDelay: this.baseDelay };
        }

        applySettings(next = {}, reason = '手动设置') {
            const normalized = this.normalizeSettings({ ...this.settings, ...next });
            this.settings = normalized;
            this.baseDelay = normalized.baseDelay;
            this.backoff = Math.min(this.backoff, normalized.backoffMax);
            this.successStreak = 0;
            this.saveSettings();
            updateDelayDisplay(this.baseDelay, reason);
            syncFetchSettingsUI();
        }

        setBaseDelay(value, reason = '自适应') {
            this.baseDelay = clamp(Math.round(value), this.settings.minDelay, this.settings.maxDelay);
            this.settings.baseDelay = this.baseDelay;
            this.saveSettings();
            updateDelayDisplay(this.baseDelay, reason);
            syncFetchSettingsUI();
        }

        noteSuccess() {
            this.backoff = this.settings.backoffStart;
            this.successStreak += 1;

            if (this.successStreak >= this.settings.successThreshold) {
                if (this.baseDelay > this.settings.minDelay) {
                    const before = this.baseDelay;
                    this.baseDelay = Math.max(this.settings.minDelay, this.baseDelay - this.settings.speedupStep);
                    this.settings.baseDelay = this.baseDelay;
                    this.saveSettings();
                    updateDelayDisplay(this.baseDelay, '自动加速 ' + before + '→' + this.baseDelay + 'ms');
                }
                this.successStreak = 0;
            }
        }

        noteFailure() {
            this.successStreak = 0;
        }

        statusLabel(defaultReason = '基础') {
            return defaultReason + ' · 成功 ' + this.successStreak + '/' + this.settings.successThreshold;
        }

        async wait(ms, reason) {
            updateDelayDisplay(ms, reason);
            await sleep(ms);
            updateDelayDisplay(this.baseDelay, this.statusLabel('基础'));
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
                        this.noteSuccess();
                        await this.wait(this.baseDelay, '节流 · 成功 ' + this.successStreak + '/' + this.settings.successThreshold);
                        return { ok: true, status: response.status, json };
                    }

                    this.noteFailure();
                    attempt += 1;

                    if (response.status === 429) {
                        if (attempt > maxRetries) return { ok: false, status: 429, errorType: 'rate-limit' };
                        const delay = this.backoff;
                        logMessage(label + ': HTTP 429 限流，第 ' + attempt + '/' + maxRetries + ' 次退避 ' + delay + 'ms', 'error');
                        this.setBaseDelay(Math.ceil(this.baseDelay * this.settings.rateLimitMultiplier), '429 降速');
                        await this.wait(delay, '429 退避');
                        this.backoff = Math.min(this.settings.backoffMax, Math.ceil(this.backoff * 1.8));
                        continue;
                    }

                    if (response.status === 403) {
                        const retryLimit = Math.min(maxRetries, 2);
                        if (attempt > retryLimit) return { ok: false, status: 403, errorType: 'forbidden' };
                        const delay = Math.max(1200, this.backoff);
                        logMessage(label + ': HTTP 403（权限/风控），第 ' + attempt + '/' + retryLimit + ' 次重试', 'error');
                        this.setBaseDelay(Math.ceil(this.baseDelay * this.settings.forbiddenMultiplier), '403 降速');
                        await this.wait(delay, '403 退避');
                        this.backoff = Math.min(this.settings.backoffMax, Math.ceil(this.backoff * 1.6));
                        continue;
                    }

                    if (response.status >= 500 && response.status <= 599 && attempt <= maxRetries) {
                        const delay = Math.min(6000, 700 * attempt);
                        logMessage(label + ': HTTP ' + response.status + '，' + delay + 'ms 后重试', 'warn');
                        await this.wait(delay, '服务器重试');
                        continue;
                    }

                    return { ok: false, status: response.status, errorType: 'http' };
                } catch (error) {
                    this.activeControllers.delete(controller);
                    if (error && error.name === 'AbortError') {
                        return { ok: false, cancelled: true, status: 0, errorType: 'cancelled' };
                    }
                    this.noteFailure();
                    attempt += 1;
                    if (attempt > maxRetries) return { ok: false, status: 0, errorType: 'network', error };
                    const delay = Math.min(6000, 800 * attempt);
                    logMessage(label + ': 网络异常，第 ' + attempt + '/' + maxRetries + ' 次重试', 'error');
                    await this.wait(delay, '网络重试');
                }
            }

            return { ok: false, status: 0, errorType: 'unknown' };
        }
    }

    const fetcher = new AdaptiveFetcher();

    function syncFetchSettingsUI() {
        const settings = fetcher.getSettings();
        const values = {
            'pixiv-delay-base': settings.baseDelay,
            'pixiv-delay-min': settings.minDelay,
            'pixiv-delay-max': settings.maxDelay,
            'pixiv-success-threshold': settings.successThreshold,
            'pixiv-speedup-step': settings.speedupStep,
            'pixiv-rate-multiplier': settings.rateLimitMultiplier
        };
        for (const [id, value] of Object.entries(values)) {
            const el = document.getElementById(id);
            if (el && document.activeElement !== el) el.value = String(value);
        }
        const summary = document.getElementById('pixiv-fetch-profile-summary');
        if (summary) summary.textContent = settings.baseDelay + 'ms / 下限 ' + settings.minDelay + 'ms';
    }

    function applyFetchSettingsFromUI() {
        const read = (id, fallback) => {
            const el = document.getElementById(id);
            const n = el ? Number(el.value) : NaN;
            return Number.isFinite(n) ? n : fallback;
        };
        const current = fetcher.getSettings();
        fetcher.applySettings({
            baseDelay: read('pixiv-delay-base', current.baseDelay),
            minDelay: read('pixiv-delay-min', current.minDelay),
            maxDelay: read('pixiv-delay-max', current.maxDelay),
            successThreshold: read('pixiv-success-threshold', current.successThreshold),
            speedupStep: read('pixiv-speedup-step', current.speedupStep),
            rateLimitMultiplier: read('pixiv-rate-multiplier', current.rateLimitMultiplier)
        });
        logMessage('Fetch 节流参数已更新：' + fetcher.baseDelay + 'ms，最低 ' + fetcher.settings.minDelay + 'ms，' + fetcher.settings.successThreshold + ' 次成功加速 ' + fetcher.settings.speedupStep + 'ms。', 'success');
    }

    function applyFetchPreset(name) {
        const presets = {
            aggressive: { baseDelay: 120, minDelay: 40, maxDelay: 1500, successThreshold: 3, speedupStep: 25, rateLimitMultiplier: 1.20 },
            balanced: { baseDelay: 160, minDelay: 60, maxDelay: 2500, successThreshold: 4, speedupStep: 20, rateLimitMultiplier: 1.25 },
            steady: { baseDelay: 250, minDelay: 120, maxDelay: 4000, successThreshold: 8, speedupStep: 15, rateLimitMultiplier: 1.35 }
        };
        if (!presets[name]) return;
        fetcher.applySettings(presets[name], name === 'aggressive' ? '激进预设' : name === 'balanced' ? '均衡预设' : '稳健预设');
        logMessage('已切换 Fetch 节流预设：' + (name === 'aggressive' ? '激进' : name === 'balanced' ? '均衡' : '稳健') + '。', 'info');
    }

    // ==========================================
    // 5. 详情队列与任务控制
    // ==========================================
    function pickTranslatedTagName(tag) {
        const translation = tag && typeof tag.translation === 'object' && tag.translation ? tag.translation : {};
        const candidates = [
            translation.zh,
            translation['zh-cn'],
            translation.zh_cn,
            translation['zh-Hans'],
            translation.en
        ];
        const first = candidates.find(value => typeof value === 'string' && value.trim())
            || Object.values(translation).find(value => typeof value === 'string' && value.trim())
            || '';
        return String(first || '').trim();
    }

    function parseArtworkBody(body, id) {
        const rawTags = Array.isArray(body?.tags?.tags) ? body.tags.tags : [];
        const seen = new Set();
        const tags = [];

        for (const raw of rawTags) {
            const name = String(raw?.tag || '').trim();
            if (!name || seen.has(name)) continue;
            seen.add(name);

            const translation = raw && typeof raw.translation === 'object' && raw.translation
                ? { ...raw.translation }
                : {};
            const translatedName = pickTranslatedTagName(raw);

            tags.push({
                name,
                translatedName: translatedName && translatedName !== name ? translatedName : '',
                translation
            });
        }

        const urls = body?.urls && typeof body.urls === 'object' ? body.urls : {};
        return {
            id: String(id),
            title: String(body?.illustTitle || body?.title || 'Untitled'),
            userId: String(body?.userId || ''),
            userName: String(body?.userName || ''),
            bookmarkCount: Number(body?.bookmarkCount || 0),
            likeCount: Number(body?.likeCount || 0),
            viewCount: Number(body?.viewCount || 0),

            xRestrict: Number(body?.xRestrict || 0),
            isR18: Number(body?.xRestrict || 0) > 0,
            aiType: Number(body?.aiType || 0),
            isAi: Number(body?.aiType || 0) === 2,

            width: Number(body?.width || 0),
            height: Number(body?.height || 0),
            pageCount: Number(body?.pageCount || 1),
            illustType: Number(body?.illustType || 0),
            createDate: body?.createDate || '',
            uploadDate: body?.uploadDate || '',
            description: String(body?.description || ''),

            thumbUrl: String(urls.small || urls.regular || urls.thumb || ''),
            regularUrl: String(urls.regular || urls.small || ''),
            originalUrl: String(urls.original || ''),

            tags,
            tagNames: tags.map(tag => tag.name),
            translatedTagNames: tags.map(tag => tag.translatedName).filter(Boolean),

            fetchedAt: Date.now(),
            updateTime: Date.now()
        };
    }

    class FetchQueue {
        constructor() {
            this.queue = [];
            this.running = false;
            this.paused = false;
            this.stopRequested = false;
            this.totalInCurrentJob = 0;
            this.processedInCurrentJob = 0;
            this.failedInCurrentJob = 0;
            this.seenIds = new Set();
        }

        prepareForNewWork() {
            if (!this.running && this.queue.length === 0) {
                const finished = this.totalInCurrentJob === 0 || this.processedInCurrentJob >= this.totalInCurrentJob;
                this.stopRequested = false;
                if (finished) {
                    this.totalInCurrentJob = 0;
                    this.processedInCurrentJob = 0;
                    this.failedInCurrentJob = 0;
                    this.seenIds.clear();
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

        enqueue(ids) {
            if (!ids.length) return;
            this.stopRequested = false;
            let added = 0;

            for (const rawId of ids) {
                const id = String(rawId);
                if (!/^\d+$/.test(id) || this.seenIds.has(id)) continue;
                this.seenIds.add(id);
                this.queue.push(id);
                added += 1;
            }

            if (added > 0) {
                this.totalInCurrentJob += added;
                logMessage(`入队 ${added} 个作品详情，待处理 ${this.queue.length}`, 'info');
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
            logMessage(`详情队列启动，基础 Fetch 延迟 ${fetcher.baseDelay}ms`, 'info');

            while (this.queue.length > 0 && !this.stopRequested) {
                await this.waitIfPaused();
                if (this.stopRequested) break;

                const id = this.queue.shift();
                let failed = false;

                try {
                    const existing = await db.getArtwork(id);
                    const fresh = existing && Date.now() - Number(existing.fetchedAt || existing.updateTime || 0) < CACHE_TTL;

                    if (!fresh) {
                        const result = await fetcher.requestJSON(`/ajax/illust/${id}?lang=zh`, {
                            label: `作品详情 ${id}`,
                            maxRetries: 4,
                            cancelCheck: () => this.stopRequested
                        });

                        if (result.cancelled) break;
                        if (!result.ok || result.json?.error || !result.json?.body) {
                            failed = true;
                            const detail = result.status ? `HTTP ${result.status}` : (result.errorType || 'API error');
                            logMessage(`详情失败: ${id} · ${detail}`, 'error');
                        } else {
                            const art = parseArtworkBody(result.json.body, id);
                            await db.putArtwork(art);
                            const translatedCount = art.tags.filter(tag => tag.translatedName).length;
                            logMessage(`入库: ${id} · 收藏 ${art.bookmarkCount} · Tag ${art.tags.length}（译 ${translatedCount}）`, 'success');
                        }
                    }
                } catch (error) {
                    failed = true;
                    logMessage(`本地处理异常: ${id} · ${error?.message || 'unknown'}`, 'error');
                }

                this.processedInCurrentJob += 1;
                if (failed) this.failedInCurrentJob += 1;
                this.updateProgressUI();
            }

            this.running = false;
            const stopped = this.stopRequested;
            this.updateProgressUI(stopped ? '已停止' : '已完成');
            await updateDBStats();
            refreshTagDatalist();
            if (!stopped) logMessage('当前详情队列处理完毕。', 'success');

            setTimeout(() => {
                if (!this.running && this.queue.length === 0) {
                    this.totalInCurrentJob = 0;
                    this.processedInCurrentJob = 0;
                    this.failedInCurrentJob = 0;
                    this.seenIds.clear();
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
    // 6. 搜索页抓取：只负责发现作品 ID
    // ==========================================
    async function fetchSearchPage(keyword, page) {
        const params = new URLSearchParams({
            word: keyword,
            order: 'date_d',
            mode: 'all',
            p: String(page),
            s_mode: 's_tag',
            lang: 'zh'
        });
        const url = `/ajax/search/artworks/${encodeURIComponent(keyword)}?${params.toString()}`;

        const result = await fetcher.requestJSON(url, {
            label: `搜索页 ${page}`,
            maxRetries: 4,
            cancelCheck: () => scanAbortRequested || queue.stopRequested
        });

        if (!result.ok) return result;

        const list = result.json?.body?.illustManga?.data || [];
        const ids = [...new Set(
            list.map(item => String(item?.id || '')).filter(id => /^\d+$/.test(id))
        )];

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
    // 8. 数据库 Dashboard：Tag 浏览器
    // ==========================================
    async function renderDBDashboard() {
        document.getElementById('pixiv-db-overlay')?.remove();

        const allData = await db.getRawAll();
        const catalog = await db.getTagCatalog();
        const totalBytes = allData.reduce((sum, art) => sum + JSON.stringify(art).length * 2, 0);
        const aiCount = allData.filter(art => art.isAi).length;
        const r18Count = allData.filter(art => art.isR18).length;

        const overlay = createElement('div', 'pixiv-dashboard-overlay');
        overlay.id = 'pixiv-db-overlay';
        const modal = createElement('div', 'pixiv-dashboard-modal');
        modal.style.width = '820px';

        const header = createElement('div', 'pixiv-dashboard-header');
        const titleWrap = createElement('div');
        const title = createElement('div', '', '本地作品数据库');
        title.style.cssText = 'font-size:16px;font-weight:700;color:#111827;';
        const subtitle = createElement('div', '', 'Tag 来自作品详情，中文优先显示 Pixiv 官方翻译');
        subtitle.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:2px;';
        titleWrap.append(title, subtitle);
        const close = createElement('button', '', '×');
        close.type = 'button';
        close.style.cssText = 'border:0;background:transparent;color:#9ca3af;font-size:22px;cursor:pointer;line-height:1;';
        close.onclick = () => overlay.remove();
        header.append(titleWrap, close);

        const body = createElement('div', 'pixiv-dashboard-body pixiv-custom-scrollbar');
        const summary = createElement('div');
        summary.style.cssText = 'display:flex;gap:18px;margin-bottom:16px;background:#f9fafb;padding:14px;border-radius:8px;border:1px solid #f3f4f6;align-items:center;';

        const makeMetric = (label, value) => {
            const wrap = createElement('div');
            const l = createElement('div', '', label);
            l.style.cssText = 'font-size:11px;color:#6b7280;';
            const v = createElement('div', '', value);
            v.style.cssText = 'font-size:19px;font-weight:700;color:#111827;';
            wrap.append(l, v);
            return wrap;
        };

        summary.append(
            makeMetric('唯一作品', allData.length.toLocaleString()),
            makeMetric('唯一 Tag', catalog.length.toLocaleString()),
            makeMetric('AI 作品', aiCount.toLocaleString()),
            makeMetric('R-18', r18Count.toLocaleString()),
            makeMetric('预估存储', formatBytes(totalBytes))
        );

        const clearAll = createElement('button', '', '清空数据库');
        clearAll.type = 'button';
        clearAll.style.cssText = 'margin-left:auto;padding:6px 10px;background:#fff;color:#ef4444;border:1px solid #ef4444;border-radius:4px;font-size:11px;cursor:pointer;font-weight:600;';
        clearAll.onclick = async () => {
            if (!confirm('确定要清空 V3 本地作品数据库吗？')) return;
            await db.clearAll();
            await updateDBStats();
            await refreshTagDatalist();
            renderLocalFilterChips();
            renderDBDashboard();
        };
        summary.appendChild(clearAll);
        body.appendChild(summary);

        const searchRow = createElement('div');
        searchRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:10px;';
        const search = document.createElement('input');
        search.type = 'search';
        search.placeholder = '搜索中文翻译或 Pixiv 原 Tag';
        search.style.cssText = 'flex:1;padding:7px 9px;border:1px solid #d1d5db;border-radius:5px;font-size:12px;outline:none;';
        const hint = createElement('span', '', '最多展示 500 项');
        hint.style.cssText = 'font-size:10px;color:#9ca3af;white-space:nowrap;';
        searchRow.append(search, hint);
        body.appendChild(searchRow);

        const table = createElement('table', 'pixiv-dashboard-table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const text of ['中文 / 显示名', 'Pixiv 原 Tag', '作品数', '操作']) headRow.appendChild(createElement('th', '', text));
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        table.appendChild(tbody);
        body.appendChild(table);

        const renderRows = query => {
            tbody.replaceChildren();
            const q = normalizeText(query);
            const filtered = catalog.filter(tag => !q || normalizeText(tag.name).includes(q) || normalizeText(tag.translatedName).includes(q)).slice(0, 500);
            if (!filtered.length) {
                const row = document.createElement('tr');
                const cell = createElement('td', '', catalog.length ? '没有匹配的 Tag' : '数据库暂无作品');
                cell.colSpan = 4;
                cell.style.cssText = 'text-align:center;padding:20px;color:#9ca3af;';
                row.appendChild(cell);
                tbody.appendChild(row);
                return;
            }

            const fragment = document.createDocumentFragment();
            for (const tag of filtered) {
                const row = document.createElement('tr');
                const translatedCell = document.createElement('td');
                const primary = createElement('div', '', tag.translatedName || tag.name);
                primary.style.cssText = 'font-weight:600;color:#111827;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                primary.title = tag.translatedName || tag.name;
                translatedCell.appendChild(primary);

                const originalCell = createElement('td', '', tag.translatedName && tag.translatedName !== tag.name ? tag.name : '—');
                originalCell.style.cssText = 'color:#6b7280;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                originalCell.title = tag.name;
                const countCell = createElement('td', '', tag.count.toLocaleString());

                const actionCell = document.createElement('td');
                const filterBtn = createElement('button', 'pixiv-mini-btn', '筛选');
                filterBtn.type = 'button';
                filterBtn.onclick = () => {
                    addLocalTagFilter(tag.name, tag.translatedName);
                    overlay.remove();
                    applyCurrentLocalView();
                };
                actionCell.appendChild(filterBtn);
                row.append(translatedCell, originalCell, countCell, actionCell);
                fragment.appendChild(row);
            }
            tbody.appendChild(fragment);
        };

        search.addEventListener('input', () => renderRows(search.value));
        renderRows('');
        modal.append(header, body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
    }

    // ==========================================
    // 9. 本地筛选与跨页排序
    // ==========================================
    const localFilterState = { tags: [], ai: 'all', r18: 'all' };
    let cachedTagCatalog = [];

    function displayTagName(tag) {
        return String(tag?.translatedName || tag?.name || '');
    }

    function addLocalTagFilter(name, translatedName = '') {
        name = String(name || '').trim();
        if (!name || localFilterState.tags.some(tag => tag.name === name)) return;
        localFilterState.tags.push({ name, translatedName: String(translatedName || '').trim() });
        renderLocalFilterChips();
    }

    function removeLocalTagFilter(name) {
        localFilterState.tags = localFilterState.tags.filter(tag => tag.name !== name);
        renderLocalFilterChips();
    }

    function renderLocalFilterChips() {
        const box = document.getElementById('pixiv-active-tag-filters');
        if (!box) return;
        box.replaceChildren();

        if (!localFilterState.tags.length) {
            const empty = createElement('span', '', '未选择 Tag：将查询整个本地数据库');
            empty.style.cssText = 'font-size:10px;color:#9ca3af;';
            box.appendChild(empty);
            return;
        }

        for (const tag of localFilterState.tags) {
            const chip = createElement('button');
            chip.type = 'button';
            chip.title = `${tag.translatedName || tag.name} · ${tag.name} · 点击移除`;
            chip.style.cssText = 'border:1px solid #bae6fd;background:#f0f9ff;color:#0369a1;border-radius:999px;padding:3px 7px;font-size:10px;cursor:pointer;max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            chip.textContent = `${tag.translatedName || tag.name} ×`;
            chip.onclick = () => removeLocalTagFilter(tag.name);
            box.appendChild(chip);
        }
    }

    async function refreshTagDatalist() {
        cachedTagCatalog = await db.getTagCatalog();
        const datalist = document.getElementById('pixiv-tag-datalist');
        if (!datalist) return;
        datalist.replaceChildren();
        const fragment = document.createDocumentFragment();
        for (const tag of cachedTagCatalog.slice(0, 1500)) {
            const option = document.createElement('option');
            option.value = tag.translatedName || tag.name;
            option.label = tag.translatedName && tag.translatedName !== tag.name ? `${tag.name} · ${tag.count}` : `${tag.count} 个作品`;
            fragment.appendChild(option);
        }
        datalist.appendChild(fragment);
    }

    async function addTagFromFilterInput() {
        const input = document.getElementById('pixiv-local-tag-input');
        if (!input) return;
        const value = input.value.trim();
        if (!value) return;
        if (!cachedTagCatalog.length) cachedTagCatalog = await db.getTagCatalog();

        const normalized = normalizeText(value);
        let matched = cachedTagCatalog.find(tag => normalizeText(tag.name) === normalized || normalizeText(tag.translatedName) === normalized);
        if (!matched) {
            const partial = cachedTagCatalog.filter(tag => normalizeText(tag.name).includes(normalized) || normalizeText(tag.translatedName).includes(normalized));
            if (partial.length === 1) matched = partial[0];
        }
        if (!matched) {
            logMessage(`本地数据库中找不到 Tag：${value}`, 'warn');
            return;
        }

        addLocalTagFilter(matched.name, matched.translatedName);
        input.value = '';
    }

    function createArtworkCard(art) {
        const card = createElement('div', 'pixiv-rank-card');
        const link = document.createElement('a');
        link.href = `/artworks/${encodeURIComponent(art.id)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'display:flex;flex-direction:column;text-decoration:none;color:inherit;width:100%;';

        const imageBox = createElement('div');
        imageBox.style.cssText = 'position:relative;width:100%;aspect-ratio:1/1;border-radius:6px;overflow:hidden;background:rgba(128,128,128,.1);';
        const image = document.createElement('img');
        image.className = 'pixiv-rank-img';
        image.src = art.thumbUrl || '';
        image.alt = art.title || '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        imageBox.appendChild(image);

        const fav = createElement('div', '', `收藏: ${Number(art.bookmarkCount || 0).toLocaleString()}`);
        fav.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,.62);color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;backdrop-filter:blur(2px);';
        imageBox.appendChild(fav);

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
        const view = createElement('span', '', views >= 1000 ? `${(views / 1000).toFixed(1)}k 阅` : `${views} 阅`);
        view.style.cssText = 'font-size:11px;color:rgba(128,128,128,.65);white-space:nowrap;';
        sub.append(user, view);

        const tags = createElement('div');
        tags.style.cssText = 'display:flex;gap:4px;overflow:hidden;height:18px;';
        for (const tag of (Array.isArray(art.tags) ? art.tags : []).slice(0, 3)) {
            const pill = createElement('span', '', displayTagName(tag));
            pill.title = tag.translatedName && tag.translatedName !== tag.name ? `${tag.translatedName} / ${tag.name}` : tag.name;
            pill.style.cssText = 'max-width:95px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#f3f4f6;color:#6b7280;border-radius:3px;padding:1px 4px;font-size:9px;';
            tags.appendChild(pill);
        }

        meta.append(title, sub, tags);
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

        localFilterState.ai = document.getElementById('pixiv-filter-ai')?.value || 'all';
        localFilterState.r18 = document.getElementById('pixiv-filter-r18')?.value || 'all';

        let list = await db.queryArtworks({
            tags: localFilterState.tags.map(tag => tag.name),
            ai: localFilterState.ai,
            r18: localFilterState.r18,
            minFav
        });

        if (!list.length) {
            alert('本地数据库中没有符合当前条件的作品。');
            return;
        }

        list.sort((a, b) => {
            if (sortType === 'bookmark') return Number(b.bookmarkCount || 0) - Number(a.bookmarkCount || 0);
            if (sortType === 'like') return Number(b.likeCount || 0) - Number(a.likeCount || 0);
            if (sortType === 'view') return Number(b.viewCount || 0) - Number(a.viewCount || 0);
            if (sortType === 'date') return new Date(b.createDate || 0).getTime() - new Date(a.createDate || 0).getTime();
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
        if (wrapper.parentElement !== container.parentElement || wrapper.nextSibling !== container) container.parentElement.insertBefore(wrapper, container);

        container.style.display = 'none';
        wrapper.style.display = 'grid';
        wrapper.replaceChildren();
        const fragment = document.createDocumentFragment();
        for (const art of list) fragment.appendChild(createArtworkCard(art));
        wrapper.appendChild(fragment);

        const tagLabel = localFilterState.tags.length ? localFilterState.tags.map(tag => tag.translatedName || tag.name).join(' + ') : '全部作品';
        logMessage(`本地筛选完成：${list.length} 个作品 · ${tagLabel}`, 'success');
    }

    function applyCurrentLocalView() {
        const sort = document.getElementById('pixiv-rank-sort-select')?.value || 'bookmark';
        const minFav = Math.max(0, parseInt(document.getElementById('pixiv-min-fav')?.value || '0', 10) || 0);
        renderRankedArtworks(sort, minFav);
    }

    // ==========================================
    // 10. 控制面板与拖拽
    // ==========================================
    function enablePanelDrag(panel, handle) {
        let dragging = false, offsetX = 0, offsetY = 0;

        const restore = () => {
            try {
                const raw = localStorage.getItem(PANEL_POS_STORAGE_KEY);
                if (!raw) return;
                const pos = JSON.parse(raw);
                if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
                const rect = panel.getBoundingClientRect();
                panel.style.left = clamp(pos.left, 8, Math.max(8, window.innerWidth - rect.width - 8)) + 'px';
                panel.style.top = clamp(pos.top, 8, Math.max(8, window.innerHeight - 48)) + 'px';
                panel.style.right = 'auto';
            } catch (_) {}
        };

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('[data-no-drag]')) return;
            const rect = panel.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            panel.style.left = clamp(event.clientX - offsetX, 8, Math.max(8, window.innerWidth - rect.width - 8)) + 'px';
            panel.style.top = clamp(event.clientY - offsetY, 8, Math.max(8, window.innerHeight - 48)) + 'px';
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
        panel.style.cssText = 'position:fixed;top:75px;right:24px;z-index:99999;width:350px;background:#fff;color:#374151;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:13px;padding:16px;box-sizing:border-box;user-select:none;';

        panel.innerHTML = `
            <div id="pixiv-rank-drag-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;cursor:move;touch-action:none;">
                <span style="font-weight:600;font-size:14px;color:#111827;">Pixiv 本地作品引擎 V3</span>
                <span id="pixiv-rank-toggle-btn" data-no-drag style="cursor:pointer;color:#9ca3af;font-size:12px;">▼ 收起</span>
            </div>
            <div id="pixiv-rank-panel-body">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-size:11px;color:#6b7280;">
                    <span>本地作品: <strong id="pixiv-db-count" style="color:#0096fa;">0</strong></span>
                    <a id="btn-open-db" style="color:#0096fa;cursor:pointer;">Tag 数据库</a>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-size:11px;color:#6b7280;">
                    <span>当前 Fetch 延迟: <strong id="pixiv-fetch-delay" style="color:#111827;">-</strong></span>
                    <span id="pixiv-fetch-delay-state" class="pixiv-status-pill">基础</span>
                </div>

                <details id="pixiv-fetch-tuning" style="margin-bottom:10px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;">
                    <summary style="cursor:pointer;padding:7px 8px;font-size:11px;color:#4b5563;display:flex;justify-content:space-between;align-items:center;">
                        <span>Fetch 节流调节</span><span id="pixiv-fetch-profile-summary" style="color:#0096fa;">-</span>
                    </summary>
                    <div style="padding:0 8px 8px;">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 8px;margin-bottom:7px;">
                            <label style="font-size:10px;color:#6b7280;">基础延迟(ms)<input id="pixiv-delay-base" type="number" min="30" max="10000" step="10" style="width:100%;box-sizing:border-box;margin-top:2px;padding:4px 5px;border:1px solid #d1d5db;border-radius:4px;background:#fff;"></label>
                            <label style="font-size:10px;color:#6b7280;">最低延迟(ms)<input id="pixiv-delay-min" type="number" min="30" max="10000" step="10" style="width:100%;box-sizing:border-box;margin-top:2px;padding:4px 5px;border:1px solid #d1d5db;border-radius:4px;background:#fff;"></label>
                            <label style="font-size:10px;color:#6b7280;">最高延迟(ms)<input id="pixiv-delay-max" type="number" min="30" max="10000" step="50" style="width:100%;box-sizing:border-box;margin-top:2px;padding:4px 5px;border:1px solid #d1d5db;border-radius:4px;background:#fff;"></label>
                            <label style="font-size:10px;color:#6b7280;">成功 N 次加速<input id="pixiv-success-threshold" type="number" min="1" max="50" step="1" style="width:100%;box-sizing:border-box;margin-top:2px;padding:4px 5px;border:1px solid #d1d5db;border-radius:4px;background:#fff;"></label>
                            <label style="font-size:10px;color:#6b7280;">每次加速(ms)<input id="pixiv-speedup-step" type="number" min="1" max="1000" step="5" style="width:100%;box-sizing:border-box;margin-top:2px;padding:4px 5px;border:1px solid #d1d5db;border-radius:4px;background:#fff;"></label>
                            <label style="font-size:10px;color:#6b7280;">429 延迟倍率<input id="pixiv-rate-multiplier" type="number" min="1.05" max="4" step="0.05" style="width:100%;box-sizing:border-box;margin-top:2px;padding:4px 5px;border:1px solid #d1d5db;border-radius:4px;background:#fff;"></label>
                        </div>
                        <div style="display:flex;gap:5px;">
                            <button id="btn-fetch-preset-aggressive" class="pixiv-mini-btn" type="button" style="flex:1;">激进</button>
                            <button id="btn-fetch-preset-balanced" class="pixiv-mini-btn" type="button" style="flex:1;">均衡</button>
                            <button id="btn-fetch-preset-steady" class="pixiv-mini-btn" type="button" style="flex:1;">稳健</button>
                            <button id="btn-fetch-settings-apply" class="pixiv-mini-btn" type="button" style="flex:1;font-weight:600;">应用</button>
                        </div>
                    </div>
                </details>

                <div id="pixiv-rank-log-box" style="height:96px;overflow-y:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;margin-bottom:12px;"></div>
                <div id="pixiv-progress-container" style="display:none;margin-bottom:12px;padding:9px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;">
                    <div id="pixiv-scan-progress" style="font-size:11px;color:#6b7280;margin-bottom:5px;">搜索页扫描: -</div>
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-bottom:4px;">
                        <span id="pixiv-progress-text">详情解析: 0 / 0</span><span id="pixiv-progress-pct" style="font-weight:600;color:#0096fa;">0%</span>
                    </div>
                    <div class="pixiv-bar-track"><div id="pixiv-progress-fill" class="pixiv-bar-fill" style="width:0%;"></div></div>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:8px;">
                        <span id="pixiv-queue-state" class="pixiv-status-pill">等待</span>
                        <button id="btn-queue-pause" class="pixiv-mini-btn" type="button">暂停</button>
                        <button id="btn-queue-stop" class="pixiv-mini-btn danger" type="button">停止</button>
                    </div>
                </div>

                <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #e5e7eb;">
                    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px;">采集：Pixiv 只负责发现作品 ID</div>
                    <input id="pixiv-discovery-keyword" type="text" placeholder="采集关键词" style="width:100%;padding:6px 8px;margin-bottom:6px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:12px;">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:7px;">
                        <span style="font-size:11px;">从第</span><input type="number" id="pixiv-page-start" min="1" step="5" style="width:54px;padding:5px;background:#fff;border:1px solid #d1d5db;border-radius:4px;font-size:11px;text-align:center;">
                        <span style="font-size:11px;">页，连续</span><input type="number" id="pixiv-page-count" min="1" value="5" style="width:54px;padding:5px;background:#fff;border:1px solid #d1d5db;border-radius:4px;font-size:11px;text-align:center;"><span style="font-size:11px;">页</span>
                    </div>
                    <button id="btn-fetch-range" class="secondary-btn" style="width:100%;padding:7px 0;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500;">开始宽泛采集</button>
                    <div style="font-size:9px;color:#9ca3af;margin-top:4px;">不继承当前 URL 的任何筛选条件。</div>
                </div>

                <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px;">本地筛选：完全使用 V3 数据库</div>
                <div style="display:flex;gap:5px;margin-bottom:6px;">
                    <input id="pixiv-local-tag-input" list="pixiv-tag-datalist" type="text" placeholder="中文翻译或原 Tag" style="flex:1;min-width:0;padding:6px 8px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:11px;">
                    <datalist id="pixiv-tag-datalist"></datalist><button id="btn-add-local-tag" class="pixiv-mini-btn" type="button">添加</button>
                </div>
                <div id="pixiv-active-tag-filters" style="display:flex;flex-wrap:wrap;gap:4px;min-height:20px;margin-bottom:7px;"></div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:7px;">
                    <select id="pixiv-filter-ai" style="padding:6px;background:#fff;border:1px solid #d1d5db;border-radius:4px;font-size:11px;"><option value="all">AI：全部</option><option value="exclude">AI：排除</option><option value="only">AI：仅 AI</option></select>
                    <select id="pixiv-filter-r18" style="padding:6px;background:#fff;border:1px solid #d1d5db;border-radius:4px;font-size:11px;"><option value="all">R18：全部</option><option value="exclude">R18：排除</option><option value="only">R18：仅 R18</option></select>
                </div>
                <div style="display:grid;grid-template-columns:1fr 105px;gap:6px;margin-bottom:8px;">
                    <select id="pixiv-rank-sort-select" style="padding:7px 8px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:11px;"><option value="bookmark">收藏数最高</option><option value="rate">收藏率最高</option><option value="like">点赞数最高</option><option value="view">浏览量最高</option><option value="date">发布时间最新</option></select>
                    <input type="number" id="pixiv-min-fav" value="0" min="0" step="50" title="最低收藏数" placeholder="最低收藏" style="padding:6px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:4px;font-size:11px;">
                </div>
                <button id="btn-apply-sort" class="primary-btn" style="width:100%;padding:9px 0;background:#0096fa;color:#fff;font-weight:600;border:0;border-radius:4px;cursor:pointer;font-size:13px;">本地筛选并排序</button>
                <div style="display:flex;gap:6px;margin-top:6px;">
                    <button id="btn-clear-local-filters" class="secondary-btn" style="flex:1;padding:6px;background:#fff;color:#6b7280;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer;font-size:11px;">清空筛选</button>
                    <button id="btn-restore-native" class="secondary-btn" style="flex:1;padding:6px;background:#fff;color:#6b7280;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer;font-size:11px;">恢复原生结果</button>
                </div>
            </div>`;

        document.body.appendChild(panel);
        const discoveryKeyword = document.getElementById('pixiv-discovery-keyword');
        const inputStart = document.getElementById('pixiv-page-start');
        const inputCount = document.getElementById('pixiv-page-count');
        const btnFetchRange = document.getElementById('btn-fetch-range');
        const toggleBtn = document.getElementById('pixiv-rank-toggle-btn');
        const panelBody = document.getElementById('pixiv-rank-panel-body');
        const dragHeader = document.getElementById('pixiv-rank-drag-header');
        const localTagInput = document.getElementById('pixiv-local-tag-input');

        discoveryKeyword.value = getCurrentDiscoveryKeyword();
        inputStart.value = String(getCurrentPageNumber());
        inputStart.step = inputCount.value;
        inputCount.addEventListener('change', () => {
            const step = parseInt(inputCount.value, 10);
            if (Number.isFinite(step) && step > 0) inputStart.step = String(step);
        });

        document.getElementById('btn-open-db').onclick = renderDBDashboard;
        document.getElementById('btn-fetch-settings-apply').onclick = applyFetchSettingsFromUI;
        document.getElementById('btn-fetch-preset-aggressive').onclick = () => applyFetchPreset('aggressive');
        document.getElementById('btn-fetch-preset-balanced').onclick = () => applyFetchPreset('balanced');
        document.getElementById('btn-fetch-preset-steady').onclick = () => applyFetchPreset('steady');
        for (const id of ['pixiv-delay-base','pixiv-delay-min','pixiv-delay-max','pixiv-success-threshold','pixiv-speedup-step','pixiv-rate-multiplier']) document.getElementById(id)?.addEventListener('change', applyFetchSettingsFromUI);

        document.getElementById('btn-queue-pause').onclick = () => queue.togglePause();
        document.getElementById('btn-queue-stop').onclick = () => { scanAbortRequested = true; queue.stop(); };
        document.getElementById('btn-restore-native').onclick = restoreNativeResults;
        document.getElementById('btn-apply-sort').onclick = applyCurrentLocalView;
        document.getElementById('btn-add-local-tag').onclick = addTagFromFilterInput;
        localTagInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); addTagFromFilterInput(); }
        });

        document.getElementById('btn-clear-local-filters').onclick = () => {
            localFilterState.tags = [];
            localFilterState.ai = 'all';
            localFilterState.r18 = 'all';
            document.getElementById('pixiv-filter-ai').value = 'all';
            document.getElementById('pixiv-filter-r18').value = 'all';
            document.getElementById('pixiv-min-fav').value = '0';
            localTagInput.value = '';
            renderLocalFilterChips();
            logMessage('本地筛选条件已清空。', 'info');
        };

        toggleBtn.onclick = () => {
            const hidden = panelBody.style.display === 'none';
            panelBody.style.display = hidden ? 'block' : 'none';
            toggleBtn.textContent = hidden ? '▼ 收起' : '▶ 展开';
        };

        btnFetchRange.onclick = async () => {
            const keyword = discoveryKeyword.value.trim();
            const startPage = parseInt(inputStart.value, 10);
            const count = parseInt(inputCount.value, 10);
            if (!keyword) return logMessage('请输入采集关键词。', 'error');
            if (!Number.isFinite(startPage) || !Number.isFinite(count) || startPage < 1 || count < 1) return logMessage('无效的抓取范围配置。', 'error');

            const endPage = startPage + count - 1;
            scanAbortRequested = false;
            scanActive = true;
            queue.prepareForNewWork();
            scanTotal = count; scanProcessed = 0; scanDiscovered = 0;
            updateScanUI();
            btnFetchRange.disabled = true;
            logMessage(`宽泛采集「${keyword}」第 ${startPage}–${endPage} 页，不继承 URL 筛选。`, 'info');

            const discoveredSet = new Set();
            try {
                for (let page = startPage; page <= endPage; page += 1) {
                    await queue.waitIfPaused();
                    if (scanAbortRequested || queue.stopRequested) break;
                    logMessage(`发现作品 ID：搜索页 ${page}`);
                    const result = await fetchSearchPage(keyword, page);
                    if (result.cancelled || scanAbortRequested || queue.stopRequested) break;
                    if (!result.ok) {
                        const detail = result.status ? `HTTP ${result.status}` : result.errorType;
                        logMessage(`第 ${page} 页抓取失败：${detail}。停止本批扫描。`, 'error');
                        break;
                    }
                    scanProcessed += 1;
                    for (const id of result.ids) discoveredSet.add(id);
                    scanDiscovered = discoveredSet.size;
                    updateScanUI();
                    if (!result.ids.length) {
                        logMessage(`第 ${page} 页正常返回但无作品，停止向后扫描。`, 'warn');
                        break;
                    }
                    queue.enqueue(result.ids);
                }
            } finally {
                scanActive = false;
                btnFetchRange.disabled = false;
                if (!scanAbortRequested && !queue.stopRequested) {
                    inputStart.value = String(startPage + count);
                    logMessage(`ID 发现结束：本批共发现 ${scanDiscovered} 个唯一作品。`, 'success');
                }
                if (!queue.running && queue.queue.length === 0 && queue.totalInCurrentJob === 0) {
                    setTimeout(() => {
                        scanTotal = 0; scanProcessed = 0; scanDiscovered = 0;
                        updateScanUI(); queue.updateProgressUI();
                    }, 1500);
                }
            }
        };

        enablePanelDrag(panel, dragHeader);
        updateDBStats();
        syncFetchSettingsUI();
        updateDelayDisplay(fetcher.baseDelay, fetcher.statusLabel('基础'));
        updateScanUI();
        renderLocalFilterChips();
        refreshTagDatalist();
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

            const keywordInput = document.getElementById('pixiv-discovery-keyword');
            if (keywordInput && document.activeElement !== keywordInput) {
                keywordInput.value = getCurrentDiscoveryKeyword();
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
