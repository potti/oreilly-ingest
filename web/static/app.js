/**
 * O'Reilly Ingest - Frontend Application
 * Redesigned with Tailwind CSS
 */

const API = '';

/** Verbose logs: localStorage.setItem('oreillyDebug','0') to quiet non-auth noise. */
function oreillyDebugEnabled() {
    try {
        return localStorage.getItem('oreillyDebug') !== '0';
    } catch {
        return true;
    }
}

/** Always log auth/cookie flows; use dbgVerbose for search/UI noise. */
function dbg(...args) {
    console.log('[oreilly-ingest]', ...args);
}

function dbgVerbose(...args) {
    if (oreillyDebugEnabled()) console.log('[oreilly-ingest]', ...args);
}

/** Always log errors to the console (full visibility). */
function logError(...args) {
    console.error('[oreilly-ingest]', ...args);
}

function logErrorDetail(context, err) {
    logError(context, err);
    if (err && typeof err === 'object' && err.stack) {
        console.error(err.stack);
    }
}

/** Paste in DevTools on learning.oreilly.com (Console) after signing in. */
const COOKIE_CONSOLE_CMD =
    "JSON.stringify(document.cookie.split(';').map(c=>c.split('=')).reduce((r,[k,v])=>({...r,[k.trim()]:v?.trim()}),{}))";
let currentExpandedCard = null;
let selectedResultIndex = -1;
let defaultOutputDir = '';
const chaptersCache = {};
/** Incremented on each checkAuth(); stale responses must not update the UI. */
let authCheckSeq = 0;

/**
 * Get high-resolution cover URL for expanded view.
 * O'Reilly provides larger covers at /covers/urn:orm:book:{id}/400w/
 */
function getHighResCoverUrl(bookId) {
    return `https://learning.oreilly.com/covers/urn:orm:book:${bookId}/400w/`;
}

function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Normalize one search hit so the card template always gets safe, consistent fields. */
function normalizeSearchHit(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = raw.id != null ? String(raw.id) : '';
    if (!id) return null;
    let authors = raw.authors;
    if (!Array.isArray(authors)) {
        authors =
            authors == null || authors === ''
                ? []
                : typeof authors === 'string'
                  ? [authors]
                  : [];
    } else {
        authors = authors.map((a) => (a == null ? '' : String(a))).filter(Boolean);
    }
    return {
        id,
        title: raw.title != null ? String(raw.title) : 'Untitled',
        authors,
        cover_url: raw.cover_url != null ? String(raw.cover_url) : '',
        publishers: Array.isArray(raw.publishers) ? raw.publishers : [],
    };
}

function reasonToLabel(reason) {
    if (reason === 'not_authenticated') return 'Not signed in';
    if (reason === 'subscription_expired') return 'Subscription expired';
    return reason || 'Invalid session';
}

async function checkAuth() {
    const seq = ++authCheckSeq;
    dbg('checkAuth: start', { seq, currentSeq: authCheckSeq, url: `${API}/api/status` });
    const cookieHelp = document.getElementById('cookie-help-section');

    function setCheckingUi() {
        const el = document.getElementById('auth-status');
        const statusDot = el?.querySelector('.status-dot');
        const statusText = el?.querySelector('.status-text');
        dbg('checkAuth: setCheckingUi', {
            hasAuthEl: !!el,
            hasDot: !!statusDot,
            hasText: !!statusText,
        });
        if (!el || !statusDot) {
            dbg('checkAuth: setCheckingUi aborted (missing #auth-status or .status-dot)');
            return;
        }
        if (statusText) statusText.textContent = 'Checking...';
        statusDot.className =
            'status-dot w-2 h-2 rounded-full bg-zinc-300 animate-pulse-subtle';
        el.className = 'flex items-center gap-2 text-sm text-zinc-500';
    }

    function setValidUi(valid, reasonLabel) {
        dbg('checkAuth: setValidUi', { valid, reasonLabel, seq, authCheckSeq });
        if (cookieHelp) {
            cookieHelp.classList.toggle('hidden', !!valid);
            dbg('checkAuth: cookie-help-section hidden=', cookieHelp.classList.contains('hidden'));
        }
        const el = document.getElementById('auth-status');
        const statusDot = el?.querySelector('.status-dot');
        const statusText = el?.querySelector('.status-text');
        if (!el || !statusDot) {
            dbg('checkAuth: setValidUi aborted (missing #auth-status or .status-dot)');
            return;
        }
        if (valid) {
            if (statusText) statusText.textContent = 'Session Valid';
            statusDot.className = 'status-dot w-2 h-2 rounded-full bg-emerald-500';
            el.className = 'flex items-center gap-2 text-sm text-emerald-600';
        } else {
            if (statusText) statusText.textContent = reasonLabel;
            statusDot.className = 'status-dot w-2 h-2 rounded-full bg-amber-500';
            el.className = 'flex items-center gap-2 text-sm text-amber-600';
        }
        dbg('checkAuth: setValidUi applied', {
            statusText: statusText?.textContent,
            dotClass: statusDot.className,
        });
    }

    setCheckingUi();

    try {
        const res = await fetch(`${API}/api/status`);
        const rawText = await res.text();
        dbg('checkAuth: response', {
            seq,
            authCheckSeq,
            httpOk: res.ok,
            status: res.status,
            contentType: res.headers.get('Content-Type'),
            bodyPreview: rawText.slice(0, 300),
        });

        let data;
        try {
            data = rawText ? JSON.parse(rawText) : {};
        } catch (parseErr) {
            logErrorDetail('checkAuth: JSON.parse failed', parseErr);
            logError('checkAuth: body preview', rawText.slice(0, 200));
            throw parseErr;
        }

        if (seq !== authCheckSeq) {
            dbg('checkAuth: stale response ignored', { seq, authCheckSeq, data });
            return;
        }

        const valid =
            data &&
            (data.valid === true || data.valid === 'true' || data.valid === 1);
        dbg('checkAuth: parsed', { valid, reason: data?.reason, full: data });
        if (valid) {
            setValidUi(true);
        } else {
            setValidUi(false, reasonToLabel(data?.reason));
        }
    } catch (err) {
        if (seq !== authCheckSeq) {
            dbg('checkAuth: error on stale seq, ignored', { seq, authCheckSeq, err });
            return;
        }
        logErrorDetail('checkAuth failed', err);
        setValidUi(false, 'Status check failed');
    }
}

function showCookieModal() {
    const modal = document.getElementById('cookie-modal');
    dbg('showCookieModal', { found: !!modal });
    if (!modal) {
        logError('showCookieModal: #cookie-modal not found');
        return;
    }
    modal.classList.remove('hidden');
    document.getElementById('cookie-input').value = '';
    document.getElementById('cookie-error').classList.add('hidden');
    document.body.style.overflow = 'hidden';
    dbg('showCookieModal: open, classList=', modal.className);
}

function hideCookieModal() {
    const modal = document.getElementById('cookie-modal');
    dbg('hideCookieModal', { found: !!modal });
    if (!modal) {
        logError('hideCookieModal: #cookie-modal not found');
        return;
    }
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    dbg('hideCookieModal: closed, classList=', modal.className);
}

async function saveCookies() {
    dbg('saveCookies: invoked');
    const input = document.getElementById('cookie-input').value.trim();
    const errorEl = document.getElementById('cookie-error');

    if (!input) {
        dbg('saveCookies: empty input');
        errorEl.textContent = 'Please paste your cookie JSON';
        errorEl.classList.remove('hidden');
        return;
    }

    let cookies;
    try {
        cookies = JSON.parse(input);
        if (typeof cookies !== 'object' || Array.isArray(cookies)) {
            throw new Error('Must be a JSON object');
        }
        dbg('saveCookies: parsed keys count', Object.keys(cookies).length);
    } catch (e) {
        dbg('saveCookies: JSON parse failed', e.message);
        errorEl.textContent = 'Invalid JSON format: ' + e.message;
        errorEl.classList.remove('hidden');
        return;
    }

    try {
        const url = `${API}/api/cookies`;
        dbg('saveCookies: POST', url);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cookies),
        });
        const rawText = await res.text();
        dbg('saveCookies: response', {
            ok: res.ok,
            status: res.status,
            contentType: res.headers.get('Content-Type'),
            bodyLength: rawText.length,
            bodyPreview: rawText.slice(0, 400),
        });

        let data;
        try {
            data = rawText ? JSON.parse(rawText) : {};
        } catch (parseErr) {
            logErrorDetail('saveCookies: response is not JSON', parseErr);
            errorEl.textContent = 'Server returned non-JSON response';
            errorEl.classList.remove('hidden');
            return;
        }

        dbg('saveCookies: parsed JSON', data);

        if (!res.ok) {
            const msg = data?.error || `HTTP ${res.status}`;
            dbg('saveCookies: HTTP error', msg);
            errorEl.textContent = msg;
            errorEl.classList.remove('hidden');
            return;
        }

        if (data.error != null && data.error !== '') {
            dbg('saveCookies: API error field', data.error);
            errorEl.textContent = String(data.error);
            errorEl.classList.remove('hidden');
            return;
        }

        const success =
            data.success === true ||
            data.success === 'true' ||
            (data.success !== false && data.count != null);
        dbg('saveCookies: success gate', { success, successField: data.success, count: data.count });

        if (!success) {
            dbg('saveCookies: unexpected body (no success), still closing modal');
        }

        hideCookieModal();
        dbg('saveCookies: after hideCookieModal, scheduling checkAuth');
        try {
            await checkAuth();
            dbg('saveCookies: checkAuth finished');
        } catch (authErr) {
            logErrorDetail('saveCookies: checkAuth threw', authErr);
        }
    } catch (err) {
        logErrorDetail('saveCookies failed', err);
        errorEl.textContent = 'Failed to save cookies';
        errorEl.classList.remove('hidden');
    }
}

async function loadDefaultOutputDir() {
    try {
        dbgVerbose('loadDefaultOutputDir: GET /api/settings');
        const res = await fetch(`${API}/api/settings`);
        const raw = await res.text();
        dbgVerbose('loadDefaultOutputDir: status', res.status, 'len', raw.length);
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (e) {
            logErrorDetail('loadDefaultOutputDir: JSON.parse failed', e);
            logError('loadDefaultOutputDir: body preview', raw.slice(0, 200));
            return;
        }
        if (!res.ok) {
            logError('loadDefaultOutputDir: HTTP error', res.status, data);
            return;
        }
        defaultOutputDir = data.output_dir;
        dbgVerbose('loadDefaultOutputDir: output_dir=', defaultOutputDir);
    } catch (err) {
        logErrorDetail('loadDefaultOutputDir failed', err);
    }
}

async function search(query) {
    dbg('search: start', { query, api: API });
    const loader = document.getElementById('search-loader');
    const container = document.getElementById('search-results');

    if (!loader || !container) {
        logError('search: missing DOM', {
            hasLoader: !!loader,
            hasContainer: !!container,
        });
        return;
    }

    const url = `${API}/api/search?q=${encodeURIComponent(query)}`;
    const SEARCH_TIMEOUT_MS = 120000;
    const ac = new AbortController();
    const timeoutId = setTimeout(() => {
        logError('search: aborting fetch (timeout ms)', SEARCH_TIMEOUT_MS, url);
        ac.abort();
    }, SEARCH_TIMEOUT_MS);

    loader.classList.remove('hidden');

    try {
        dbg('search: fetch', url);
        let res;
        try {
            res = await fetch(url, { signal: ac.signal });
        } catch (fetchErr) {
            logErrorDetail('search: fetch threw', fetchErr);
            throw fetchErr;
        }

        dbg('search: response headers', {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            contentType: res.headers.get('Content-Type'),
        });

        let rawText;
        try {
            rawText = await res.text();
        } catch (textErr) {
            logErrorDetail('search: res.text() threw', textErr);
            throw textErr;
        }

        dbg('search: body', {
            length: rawText.length,
            preview: rawText.slice(0, 500),
        });

        let data;
        try {
            data = rawText ? JSON.parse(rawText) : {};
        } catch (parseErr) {
            logErrorDetail('search: JSON.parse failed', parseErr);
            logError('search: raw body (first 300 chars)', rawText.slice(0, 300));
            throw parseErr;
        }

        container.innerHTML = '';
        container.classList.remove('has-expanded');
        currentExpandedCard = null;
        selectedResultIndex = -1;

        if (!res.ok) {
            const msg = data?.error || `Search failed (HTTP ${res.status})`;
            logError('search: HTTP not OK', { status: res.status, msg, data });
            container.innerHTML = `
                <div class="text-center py-16 text-red-600">
                    <p>${escapeHtml(msg)}</p>
                </div>
            `;
            return;
        }

        let list = data.results;
        if (!Array.isArray(list)) {
            logError('search: data.results is not an array', {
                type: typeof list,
                dataKeys: data ? Object.keys(data) : [],
            });
            list = [];
        }

        if (list.length === 0) {
            dbg('search: empty results array', { data });
            container.innerHTML = `
                <div class="text-center py-16 text-zinc-500">
                    <p class="text-lg">No books found for "${escapeHtml(query)}"</p>
                    <p class="text-sm mt-2 text-zinc-400">Try a different search term or ISBN</p>
                </div>
            `;
            return;
        }

        dbg('search: rendering', list.length, 'raw hits');
        for (const raw of list) {
            const book = normalizeSearchHit(raw);
            if (!book) {
                logError('search: normalizeSearchHit returned null', { raw });
                continue;
            }
            try {
                const div = document.createElement('article');
                div.className =
                    'book-card group bg-white rounded-xl border border-zinc-200 overflow-hidden transition-all duration-200 hover:border-zinc-300 hover:shadow-card-hover';
                div.dataset.bookId = book.id;
                div.innerHTML = createBookCardHTML(book);

                setupBookCardEvents(div, book);
                container.appendChild(div);
            } catch (rowErr) {
                logErrorDetail('search: row render failed', rowErr);
                logError('search: row raw', raw);
            }
        }

        if (!container.children.length) {
            logError('search: no cards after loop (all rows failed?)');
            container.innerHTML = `
                <div class="text-center py-16 text-zinc-500">
                    <p class="text-lg">No books could be displayed</p>
                    <p class="text-sm mt-2 text-zinc-400">Check the browser console for details</p>
                </div>
            `;
        } else {
            dbg('search: done', container.children.length, 'cards');
        }
    } catch (err) {
        logErrorDetail('search: failed', err);
        try {
            if (container) {
                container.innerHTML = `
                    <div class="text-center py-16 text-red-600">
                        <p>Search failed: ${escapeHtml(err?.message || String(err))}</p>
                    </div>
                `;
            }
        } catch (uiErr) {
            logErrorDetail('search: could not render error UI', uiErr);
        }
    } finally {
        clearTimeout(timeoutId);
        try {
            loader.classList.add('hidden');
        } catch (loaderErr) {
            logError('search: could not hide loader', loaderErr);
        }
        dbg('search: finally (loader hidden)');
    }
}

function createBookCardHTML(book) {
    const title = escapeHtml(book.title);
    const authorsLine = escapeHtml(
        Array.isArray(book.authors) && book.authors.length
            ? book.authors.join(', ')
            : 'Unknown Author'
    );
    const coverSrc = escapeHtml(book.cover_url || '');
    return `
        <!-- Collapsed Summary -->
        <div class="book-summary flex items-center gap-4 p-4 cursor-pointer">
            <img src="${coverSrc}" alt="${title} cover" class="w-12 h-16 object-cover rounded shadow-sm flex-shrink-0" loading="lazy">
            <div class="flex-1 min-w-0">
                <h3 class="text-[0.9375rem] font-semibold text-zinc-900 leading-snug truncate">${title}</h3>
                <p class="text-sm text-zinc-500 truncate">${authorsLine}</p>
            </div>
            <svg class="expand-icon w-5 h-5 text-zinc-400 flex-shrink-0 transition-transform duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 9l6 6 6-6"/>
            </svg>
        </div>

        <!-- Expanded Content -->
        <div class="book-expanded hidden">
            <!-- Close Button -->
            <button class="close-btn absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-zinc-100 hover:bg-zinc-200 rounded-full transition-colors z-10">
                <svg class="w-4 h-4 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
            </button>

            <div class="relative px-5 pb-5 pt-2 border-t border-zinc-100 animate-fade-in">
                <!-- Book Detail -->
                <div class="flex gap-5 py-5">
                    <img class="w-24 h-32 object-cover rounded-lg shadow-md flex-shrink-0" src="${getHighResCoverUrl(book.id)}" alt="${title} cover">
                    <div class="flex-1 min-w-0">
                        <h2 class="text-xl font-semibold text-zinc-900 leading-tight mb-1">${title}</h2>
                        <p class="text-[0.9375rem] text-zinc-500 mb-3">by ${authorsLine}</p>
                        <p class="text-sm text-zinc-500 mb-0.5">
                            <span class="text-zinc-400">Publisher:</span>
                            <span class="publisher-value text-zinc-500 animate-pulse-subtle">Loading...</span>
                        </p>
                        <p class="text-sm text-zinc-500 mb-3">
                            <span class="text-zinc-400">Pages:</span>
                            <span class="pages-value text-zinc-500 animate-pulse-subtle">Loading...</span>
                        </p>
                        <div class="book-description text-sm text-zinc-600 leading-relaxed max-h-20 overflow-y-auto pr-2 animate-pulse-subtle">
                            Loading description...
                        </div>
                    </div>
                </div>

                <!-- Format & Scope Section -->
                <div class="py-5 border-t border-zinc-100">
                    <!-- Step 1: Format Selection -->
                    <div class="mb-5">
                        <h4 class="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-3">
                            <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-oreilly-blue text-white text-[0.625rem] font-bold rounded-full">1</span>
                            Format
                        </h4>
                        <div class="format-options flex flex-wrap gap-1.5">
                            <label class="format-option cursor-pointer">
                                <input type="radio" name="format" value="markdown" checked class="sr-only peer">
                                <span class="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                                        <path d="M7 15V9l2.5 3L12 9v6"/>
                                        <path d="M17 9v6l-2-2"/>
                                    </svg>
                                    Markdown
                                </span>
                            </label>
                            <label class="format-option cursor-pointer">
                                <input type="radio" name="format" value="json" class="sr-only peer">
                                <span class="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/>
                                        <path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>
                                    </svg>
                                    JSON
                                </span>
                            </label>
                            <label class="format-option cursor-pointer">
                                <input type="radio" name="format" value="plaintext" class="sr-only peer">
                                <span class="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                        <polyline points="14 2 14 8 20 8"/>
                                        <line x1="16" y1="13" x2="8" y2="13"/>
                                    </svg>
                                    Plain Text
                                </span>
                            </label>
                            <label class="format-option cursor-pointer">
                                <input type="radio" name="format" value="pdf" class="sr-only peer">
                                <span class="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                        <polyline points="14 2 14 8 20 8"/>
                                        <line x1="16" y1="13" x2="8" y2="13"/>
                                        <line x1="16" y1="17" x2="8" y2="17"/>
                                    </svg>
                                    PDF
                                </span>
                            </label>
                            <label class="format-option cursor-pointer relative">
                                <input type="radio" name="format" value="chunks" class="sr-only peer">
                                <span class="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <rect x="3" y="3" width="7" height="7"/>
                                        <rect x="14" y="3" width="7" height="7"/>
                                        <rect x="3" y="14" width="7" height="7"/>
                                        <rect x="14" y="14" width="7" height="7"/>
                                    </svg>
                                    Chunks
                                </span>
                                <span class="absolute -top-1.5 -right-1.5 text-[0.5rem] font-bold uppercase px-1 py-px bg-emerald-500 text-white rounded shadow-sm peer-checked:bg-oreilly-blue">RAG</span>
                            </label>
                            <label class="format-option cursor-pointer">
                                <input type="radio" name="format" value="epub" class="sr-only peer">
                                <span class="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                                    </svg>
                                    EPUB
                                </span>
                            </label>
                        </div>
                    </div>

                    <!-- Step 2: Chapters Selection -->
                    <div class="chapters-selection">
                        <h4 class="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-3">
                            <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-oreilly-blue text-white text-[0.625rem] font-bold rounded-full">2</span>
                            Chapters
                        </h4>
                        <div class="chapters-options grid grid-cols-2 gap-2">
                            <label class="chapters-option cursor-pointer">
                                <input type="radio" name="chapters-scope" value="all" checked class="sr-only peer">
                                <span class="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                    <span class="flex items-center justify-center w-8 h-8 bg-white rounded-md shadow-sm">
                                        <svg class="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                                        </svg>
                                    </span>
                                    <span class="flex flex-col min-w-0">
                                        <span class="text-sm font-medium text-zinc-700">All Chapters</span>
                                        <span class="text-[0.6875rem] text-zinc-400">Download everything</span>
                                    </span>
                                </span>
                            </label>
                            <label class="chapters-option cursor-pointer">
                                <input type="radio" name="chapters-scope" value="select" class="sr-only peer">
                                <span class="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                    <span class="flex items-center justify-center w-8 h-8 bg-white rounded-md shadow-sm">
                                        <svg class="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M9 11l3 3L22 4"/>
                                            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                                        </svg>
                                    </span>
                                    <span class="flex flex-col min-w-0">
                                        <span class="text-sm font-medium text-zinc-700">Select Chapters</span>
                                        <span class="text-[0.6875rem] text-zinc-400">Pick which ones</span>
                                    </span>
                                </span>
                            </label>
                        </div>
                    </div>

                    <!-- Chapter Picker -->
                    <div class="chapters-picker hidden mt-4 p-4 bg-zinc-50 rounded-xl border border-zinc-200">
                        <div class="flex items-center justify-between pb-3 border-b border-zinc-200 mb-3">
                            <span class="chapters-summary text-sm font-medium text-zinc-600">All chapters</span>
                            <div class="flex gap-1">
                                <button class="select-all-btn px-2 py-1 text-xs font-medium text-oreilly-blue hover:bg-oreilly-blue-light rounded transition-colors">All</button>
                                <button class="select-none-btn px-2 py-1 text-xs font-medium text-oreilly-blue hover:bg-oreilly-blue-light rounded transition-colors">None</button>
                            </div>
                        </div>
                        <div class="chapters-list max-h-52 overflow-y-auto space-y-0.5"></div>
                    </div>

                    <!-- Step 3: Output Structure -->
                    <div class="output-selection mt-5">
                        <h4 class="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-3">
                            <span class="inline-flex items-center justify-center w-[18px] h-[18px] bg-oreilly-blue text-white text-[0.625rem] font-bold rounded-full">3</span>
                            Output
                        </h4>
                        <div class="output-options grid grid-cols-2 gap-2">
                            <label class="output-option cursor-pointer">
                                <input type="radio" name="output-style" value="combined" checked class="sr-only peer">
                                <span class="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                    <span class="flex items-center justify-center w-8 h-8 bg-white rounded-md shadow-sm">
                                        <svg class="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                            <polyline points="14 2 14 8 20 8"/>
                                        </svg>
                                    </span>
                                    <span class="flex flex-col min-w-0">
                                        <span class="text-sm font-medium text-zinc-700">Combined</span>
                                        <span class="text-[0.6875rem] text-zinc-400">One book file</span>
                                    </span>
                                </span>
                            </label>
                            <label class="output-option cursor-pointer">
                                <input type="radio" name="output-style" value="separate" class="sr-only peer">
                                <span class="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                    <span class="flex items-center justify-center w-8 h-8 bg-white rounded-md shadow-sm">
                                        <svg class="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
                                        </svg>
                                    </span>
                                    <span class="flex flex-col min-w-0">
                                        <span class="text-sm font-medium text-zinc-700">Separate</span>
                                        <span class="text-[0.6875rem] text-zinc-400">One file per chapter</span>
                                    </span>
                                </span>
                            </label>
                        </div>
                        <!-- Output locked notice -->
                        <div class="output-locked-notice hidden flex items-center gap-2 p-3 mt-2 bg-zinc-50 border border-dashed border-zinc-200 rounded-lg text-sm text-zinc-500">
                            <svg class="w-4 h-4 flex-shrink-0 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="16" x2="12" y2="12"/>
                                <line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            <span>Combined only for this format</span>
                        </div>
                    </div>
                </div>

                <!-- Advanced Options -->
                <details class="advanced-options border-t border-zinc-100 pt-4">
                    <summary class="flex items-center gap-1.5 text-sm font-medium text-zinc-500 cursor-pointer select-none py-1 hover:text-zinc-700 transition-colors">
                        <svg class="toggle-icon w-3.5 h-3.5 transition-transform duration-150" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18l6-6-6-6"/>
                        </svg>
                        Advanced Options
                    </summary>
                    <div class="pt-4 space-y-4">
                        <div>
                            <label class="block text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Save Location</label>
                            <div class="flex gap-2">
                                <input type="text" class="output-dir-input flex-1 px-3 py-2 text-sm font-mono bg-zinc-50 border border-zinc-200 rounded-lg text-zinc-600 focus:outline-none focus:border-oreilly-blue focus:bg-white transition-colors" placeholder="Loading..." readonly>
                                <button class="browse-btn px-3 py-2 text-xs font-medium text-zinc-600 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50 transition-colors">Browse</button>
                            </div>
                        </div>

                        <label class="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" class="skip-images w-4 h-4 rounded border-zinc-300 text-oreilly-blue focus:ring-oreilly-blue/20">
                            <span class="text-sm text-zinc-600">Skip images</span>
                            <span class="text-xs text-zinc-400">Faster download, smaller files</span>
                        </label>

                        <div class="chunking-options hidden flex gap-4 p-4 bg-zinc-50 rounded-lg">
                            <div class="flex-1">
                                <label class="block text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Chunk Size (tokens)</label>
                                <input type="number" class="chunk-size-input w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:border-oreilly-blue transition-colors" value="4000" min="500" max="16000">
                            </div>
                            <div class="flex-1">
                                <label class="block text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Overlap (tokens)</label>
                                <input type="number" class="chunk-overlap-input w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:border-oreilly-blue transition-colors" value="200" min="0" max="1000">
                            </div>
                        </div>
                    </div>
                </details>

                <!-- Progress Section -->
                <div class="progress-section hidden py-5 border-t border-zinc-100">
                    <div class="flex justify-between items-center mb-2">
                        <span class="progress-label text-sm font-medium text-zinc-700">Downloading...</span>
                        <span class="progress-percent text-sm font-semibold text-oreilly-blue">0%</span>
                    </div>
                    <div class="h-1.5 bg-zinc-200 rounded-full overflow-hidden">
                        <div class="progress-fill h-full bg-oreilly-blue rounded-full transition-all duration-300" style="width: 0%"></div>
                    </div>
                    <p class="progress-status mt-2 text-sm text-zinc-500"></p>
                </div>

                <!-- Result Section -->
                <div class="result-section hidden py-5 border-t border-zinc-100">
                    <div class="flex items-center gap-2 mb-4 text-emerald-600 font-medium">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                        <span>Download Complete</span>
                    </div>
                    <div class="result-files space-y-2"></div>
                </div>

                <!-- Action Bar -->
                <div class="flex justify-end gap-2 pt-5 border-t border-zinc-100">
                    <button class="cancel-btn hidden px-5 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50 transition-colors">Cancel</button>
                    <button class="download-btn px-6 py-2 text-sm font-medium text-white bg-oreilly-blue hover:bg-oreilly-blue-dark rounded-lg transition-colors disabled:bg-zinc-300 disabled:cursor-not-allowed">Download</button>
                </div>
            </div>
        </div>
    `;
}

function setupBookCardEvents(div, book) {
    // Click on summary to expand
    div.querySelector('.book-summary').onclick = () => expandBook(div, book.id);

    // Close button
    div.querySelector('.close-btn').onclick = (e) => {
        e.stopPropagation();
        collapseBook();
    };

    // Download button
    div.querySelector('.download-btn').onclick = (e) => {
        e.stopPropagation();
        download(div);
    };

    // Cancel button
    div.querySelector('.cancel-btn').onclick = (e) => {
        e.stopPropagation();
        cancelDownload(div);
    };

    // Format selection - update scope visibility
    div.querySelectorAll('input[name="format"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            handleFormatChange(div, e.target.value, book.id);
        });
    });

    // Chapters scope selection - show/hide chapter picker
    div.querySelectorAll('input[name="chapters-scope"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            handleChaptersScopeChange(div, e.target.value, book.id);
        });
    });

    // Output style selection
    div.querySelectorAll('input[name="output-style"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            // No special handling needed, just tracks selection
        });
    });

    // Chapter selection buttons
    div.querySelector('.select-all-btn').onclick = (e) => {
        e.stopPropagation();
        selectAllChapters(div, true);
    };
    div.querySelector('.select-none-btn').onclick = (e) => {
        e.stopPropagation();
        selectAllChapters(div, false);
    };

    // Browse button
    div.querySelector('.browse-btn').onclick = (e) => {
        e.stopPropagation();
        browseOutputDir(div);
    };

    // Advanced options toggle icon rotation
    const advancedOptions = div.querySelector('.advanced-options');
    advancedOptions.addEventListener('toggle', () => {
        const icon = advancedOptions.querySelector('.toggle-icon');
        if (advancedOptions.open) {
            icon.style.transform = 'rotate(90deg)';
        } else {
            icon.style.transform = 'rotate(0deg)';
        }
    });
}

// Formats that only support combined output (entire book as single file)
const BOOK_ONLY_FORMATS = ['epub', 'chunks'];

function handleFormatChange(cardElement, format, bookId) {
    const outputSelection = cardElement.querySelector('.output-selection');
    const outputOptions = cardElement.querySelector('.output-options');
    const lockedNotice = cardElement.querySelector('.output-locked-notice');
    const chunkingOptions = cardElement.querySelector('.chunking-options');
    const chaptersPicker = cardElement.querySelector('.chapters-picker');

    // Show/hide chunking options
    chunkingOptions.classList.toggle('hidden', format !== 'chunks');

    if (BOOK_ONLY_FORMATS.includes(format)) {
        // Lock to "Combined" for EPUB and Chunks - hide output options, show notice
        outputOptions.classList.add('hidden');
        lockedNotice.classList.remove('hidden');

        // Reset to combined output
        const combinedRadio = cardElement.querySelector('input[name="output-style"][value="combined"]');
        if (combinedRadio) combinedRadio.checked = true;
    } else {
        // Show all output options
        outputOptions.classList.remove('hidden');
        lockedNotice.classList.add('hidden');
    }

    // Check current chapters scope and show chapter picker if needed
    const currentChaptersScope = cardElement.querySelector('input[name="chapters-scope"]:checked')?.value;
    if (currentChaptersScope === 'select') {
        loadChaptersIfNeeded(cardElement, bookId);
        chaptersPicker.classList.remove('hidden');
    }
}

function handleChaptersScopeChange(cardElement, chaptersScope, bookId) {
    const chaptersPicker = cardElement.querySelector('.chapters-picker');

    if (chaptersScope === 'select') {
        loadChaptersIfNeeded(cardElement, bookId);
        chaptersPicker.classList.remove('hidden');
    } else {
        chaptersPicker.classList.add('hidden');
    }
}

async function loadChaptersIfNeeded(cardElement, bookId) {
    if (chaptersCache[bookId]) {
        // Already loaded
        if (cardElement.querySelector('.chapters-list').children.length === 0) {
            renderChapters(cardElement, chaptersCache[bookId]);
        }
        return;
    }

    const listContainer = cardElement.querySelector('.chapters-list');
    listContainer.innerHTML = '<p class="text-sm text-zinc-400 animate-pulse-subtle py-2">Loading chapters...</p>';

    try {
        const res = await fetch(`${API}/api/book/${bookId}/chapters`);
        const data = await res.json();
        chaptersCache[bookId] = data.chapters;
        renderChapters(cardElement, data.chapters);
    } catch (err) {
        logErrorDetail(`loadChaptersIfNeeded failed (bookId=${bookId})`, err);
        listContainer.innerHTML = '<p class="text-sm text-red-600 py-2">Failed to load chapters</p>';
    }
}

async function expandBook(cardElement, bookId) {
    if (currentExpandedCard && currentExpandedCard !== cardElement) {
        collapseBook();
    }

    if (cardElement.classList.contains('expanded')) {
        return;
    }

    const expanded = cardElement.querySelector('.book-expanded');

    // Add expanded styles
    cardElement.classList.add('expanded');
    cardElement.classList.remove('hover:border-zinc-300', 'hover:shadow-card-hover');
    cardElement.classList.add('border-oreilly-blue', 'shadow-card-expanded');

    // Rotate expand icon
    const expandIcon = cardElement.querySelector('.expand-icon');
    expandIcon.style.transform = 'rotate(180deg)';

    expanded.classList.remove('hidden');
    document.getElementById('search-results').classList.add('has-expanded');
    currentExpandedCard = cardElement;

    // Smooth scroll into view
    setTimeout(() => {
        cardElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    // Set output directory
    const outputDirInput = expanded.querySelector('.output-dir-input');
    outputDirInput.value = defaultOutputDir || 'Loading...';

    // Fetch book details
    try {
        const res = await fetch(`${API}/api/book/${bookId}`);
        const book = await res.json();

        const publisherEl = expanded.querySelector('.publisher-value');
        const pagesEl = expanded.querySelector('.pages-value');
        const descEl = expanded.querySelector('.book-description');

        publisherEl.textContent = book.publishers?.join(', ') || 'Unknown';
        publisherEl.classList.remove('animate-pulse-subtle');

        pagesEl.textContent = book.virtual_pages || 'N/A';
        pagesEl.classList.remove('animate-pulse-subtle');

        descEl.innerHTML = book.description || 'No description available.';
        descEl.classList.remove('animate-pulse-subtle');
    } catch (error) {
        logErrorDetail(`expandBook fetch details failed (bookId=${bookId})`, error);
        const descEl = expanded.querySelector('.book-description');
        descEl.textContent = 'Failed to load details.';
        descEl.classList.remove('animate-pulse-subtle');
    }
}

function collapseBook() {
    if (currentExpandedCard) {
        const expanded = currentExpandedCard.querySelector('.book-expanded');

        // Remove expanded styles
        currentExpandedCard.classList.remove('expanded', 'border-oreilly-blue', 'shadow-card-expanded');
        currentExpandedCard.classList.add('hover:border-zinc-300', 'hover:shadow-card-hover');

        // Reset expand icon
        const expandIcon = currentExpandedCard.querySelector('.expand-icon');
        expandIcon.style.transform = 'rotate(0deg)';

        expanded.classList.add('hidden');

        // Reset sections
        const progressSection = currentExpandedCard.querySelector('.progress-section');
        const resultSection = currentExpandedCard.querySelector('.result-section');
        progressSection.classList.add('hidden');
        resultSection.classList.add('hidden');

        document.getElementById('search-results').classList.remove('has-expanded');
        currentExpandedCard = null;
    }
}

function renderChapters(cardElement, chapters) {
    const listContainer = cardElement.querySelector('.chapters-list');

    listContainer.innerHTML = chapters.map((ch) => `
        <label class="chapter-item flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer hover:bg-zinc-100 transition-colors">
            <input type="checkbox" class="chapter-checkbox w-4 h-4 rounded border-zinc-300 text-oreilly-blue focus:ring-oreilly-blue/20" data-index="${ch.index}" checked>
            <span class="flex-1 text-sm text-zinc-700 truncate">${ch.title || 'Chapter ' + (ch.index + 1)}</span>
            ${ch.pages ? `<span class="text-xs text-zinc-400 flex-shrink-0">${ch.pages}p</span>` : ''}
        </label>
    `).join('');

    updateChapterCount(cardElement);

    listContainer.querySelectorAll('.chapter-checkbox').forEach(cb => {
        cb.addEventListener('change', () => updateChapterCount(cardElement));
    });
}

function updateChapterCount(cardElement) {
    const checkboxes = cardElement.querySelectorAll('.chapter-checkbox');
    const checked = cardElement.querySelectorAll('.chapter-checkbox:checked');
    const summaryEl = cardElement.querySelector('.chapters-summary');

    if (checked.length === checkboxes.length) {
        summaryEl.textContent = `All ${checkboxes.length} chapters`;
    } else if (checked.length === 0) {
        summaryEl.textContent = 'No chapters selected';
    } else {
        summaryEl.textContent = `${checked.length} of ${checkboxes.length} chapters`;
    }
}

function selectAllChapters(cardElement, selectAll) {
    cardElement.querySelectorAll('.chapter-checkbox').forEach(cb => cb.checked = selectAll);
    updateChapterCount(cardElement);
}

async function download(cardElement) {
    const bookId = cardElement.dataset.bookId;

    // Get selected format
    const formatRadio = cardElement.querySelector('input[name="format"]:checked');
    const format = formatRadio ? formatRadio.value : null;

    if (!format) {
        // Shake animation for format options
        const formatOptions = cardElement.querySelector('.format-options');
        formatOptions.classList.add('animate-shake');
        setTimeout(() => formatOptions.classList.remove('animate-shake'), 500);
        return;
    }

    // Get chapters scope (all or select)
    const chaptersScopeRadio = cardElement.querySelector('input[name="chapters-scope"]:checked');
    const chaptersScope = chaptersScopeRadio ? chaptersScopeRadio.value : 'all';

    // Get output style (combined or separate)
    const outputStyleRadio = cardElement.querySelector('input[name="output-style"]:checked');
    const outputStyle = outputStyleRadio ? outputStyleRadio.value : 'combined';

    // Determine final format string based on format + output style
    let finalFormat = format;
    if (outputStyle === 'separate' && !BOOK_ONLY_FORMATS.includes(format)) {
        // For separate output, append -chapters to format (e.g., pdf-chapters, markdown-chapters)
        finalFormat = `${format}-chapters`;
    }

    // Get selected chapters if chapters scope is 'select'
    let selectedChapters = null;
    if (chaptersScope === 'select') {
        const chapterCheckboxes = cardElement.querySelectorAll('.chapter-checkbox');
        const checkedBoxes = cardElement.querySelectorAll('.chapter-checkbox:checked');

        if (checkedBoxes.length === 0) {
            // No chapters selected - shake the chapter picker
            const chaptersPicker = cardElement.querySelector('.chapters-picker');
            chaptersPicker.classList.add('animate-shake');
            setTimeout(() => chaptersPicker.classList.remove('animate-shake'), 500);
            return;
        }

        if (checkedBoxes.length < chapterCheckboxes.length) {
            selectedChapters = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.index));
        }
        // Note: separate/combined is determined by outputStyle, not by chapter selection
    }

    const progressSection = cardElement.querySelector('.progress-section');
    const resultSection = cardElement.querySelector('.result-section');
    const downloadBtn = cardElement.querySelector('.download-btn');
    const cancelBtn = cardElement.querySelector('.cancel-btn');
    const progressFill = cardElement.querySelector('.progress-fill');

    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
    downloadBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    progressFill.style.width = '0%';

    const outputDirInput = cardElement.querySelector('.output-dir-input');
    const outputDir = outputDirInput.value.trim();

    const requestBody = { book_id: bookId, format: finalFormat };
    if (selectedChapters !== null) {
        requestBody.chapters = selectedChapters;
    }
    if (outputDir && outputDir !== defaultOutputDir) {
        requestBody.output_dir = outputDir;
    }
    if (format === 'chunks') {
        const chunkSize = parseInt(cardElement.querySelector('.chunk-size-input').value) || 4000;
        const chunkOverlap = parseInt(cardElement.querySelector('.chunk-overlap-input').value) || 200;
        requestBody.chunking = {
            chunk_size: chunkSize,
            overlap: chunkOverlap
        };
    }
    if (cardElement.querySelector('.skip-images').checked) {
        requestBody.skip_images = true;
    }

    try {
        const res = await fetch(`${API}/api/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const result = await res.json();

        if (result.error) {
            cardElement.querySelector('.progress-status').textContent = `Error: ${result.error}`;
            downloadBtn.classList.remove('hidden');
            cancelBtn.classList.add('hidden');
            return;
        }

        pollProgress(cardElement);
    } catch (err) {
        logErrorDetail(`download POST failed (bookId=${cardElement.dataset.bookId || 'unknown'})`, err);
        cardElement.querySelector('.progress-status').textContent = 'Download failed. Please try again.';
        downloadBtn.classList.remove('hidden');
        cancelBtn.classList.add('hidden');
    }
}

async function cancelDownload(cardElement) {
    const cancelBtn = cardElement.querySelector('.cancel-btn');
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling...';

    try {
        await fetch(`${API}/api/cancel`, { method: 'POST' });
    } catch (err) {
        logErrorDetail('cancel request failed', err);
    }
}

function formatETA(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
}

async function pollProgress(cardElement) {
    try {
        const res = await fetch(`${API}/api/progress`);
        const data = await res.json();

        const progressFill = cardElement.querySelector('.progress-fill');
        const progressStatus = cardElement.querySelector('.progress-status');
        const progressPercent = cardElement.querySelector('.progress-percent');
        const progressSection = cardElement.querySelector('.progress-section');
        const resultSection = cardElement.querySelector('.result-section');
        const downloadBtn = cardElement.querySelector('.download-btn');
        const cancelBtn = cardElement.querySelector('.cancel-btn');

        let status = data.status || 'waiting';
        const details = [];

        if (data.current_chapter && data.total_chapters) {
            details.push(`Chapter ${data.current_chapter}/${data.total_chapters}`);
        }

        if (typeof data.percentage === 'number') {
            progressFill.style.width = `${data.percentage}%`;
            progressPercent.textContent = `${data.percentage}%`;
        }

        if (data.eta_seconds && data.eta_seconds > 0) {
            details.push(`~${formatETA(data.eta_seconds)} remaining`);
        }

        if (data.chapter_title) {
            const title = data.chapter_title.length > 40
                ? data.chapter_title.substring(0, 40) + '...'
                : data.chapter_title;
            status = title;
        }

        progressStatus.textContent = details.length > 0 ? details.join(' • ') : status;

        function restoreButtons() {
            downloadBtn.classList.remove('hidden');
            downloadBtn.disabled = false;
            cancelBtn.classList.add('hidden');
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancel';
        }

        if (data.status === 'completed') {
            restoreButtons();
            progressSection.classList.add('hidden');
            resultSection.classList.remove('hidden');

            let filesHTML = '';
            if (data.epub) filesHTML += createFileResultHTML('EPUB', data.epub);
            if (data.pdf) {
                if (Array.isArray(data.pdf)) {
                    filesHTML += `<div class="flex items-center gap-3 px-4 py-3 bg-zinc-50 rounded-lg text-sm"><span class="font-medium text-zinc-700 min-w-[70px]">PDF</span><span class="flex-1 font-mono text-xs text-zinc-500 truncate">${data.pdf.length} chapter files</span></div>`;
                } else {
                    filesHTML += createFileResultHTML('PDF', data.pdf);
                }
            }
            if (data.markdown) filesHTML += createFileResultHTML('Markdown', data.markdown);
            if (data.plaintext) filesHTML += createFileResultHTML('Plain Text', data.plaintext);
            if (data.json) filesHTML += createFileResultHTML('JSON', data.json);
            if (data.chunks) filesHTML += createFileResultHTML('Chunks', data.chunks);

            cardElement.querySelector('.result-files').innerHTML = filesHTML;
        } else if (data.status === 'error') {
            restoreButtons();
            progressStatus.textContent = `Error: ${data.error}`;
        } else {
            setTimeout(() => pollProgress(cardElement), 500);
        }
    } catch (err) {
        logErrorDetail('progress polling failed', err);
        setTimeout(() => pollProgress(cardElement), 1000);
    }
}

function createFileResultHTML(label, path) {
    const escapedPath = path.replace(/'/g, "\\'");
    return `
        <div class="flex items-center gap-3 px-4 py-3 bg-zinc-50 rounded-lg text-sm">
            <span class="font-medium text-zinc-700 min-w-[70px]">${label}</span>
            <span class="flex-1 font-mono text-xs text-zinc-500 truncate" title="${path}">${path}</span>
            <button class="px-2 py-1 text-xs font-medium text-oreilly-blue hover:bg-oreilly-blue-light rounded transition-colors" onclick="revealFile('${escapedPath}')">Reveal</button>
        </div>
    `;
}

async function revealFile(path) {
    try {
        const res = await fetch(`${API}/api/reveal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (data.error) {
            logError('reveal failed:', data.error);
        }
    } catch (err) {
        logErrorDetail('reveal request failed', err);
    }
}

async function browseOutputDir(cardElement) {
    const browseBtn = cardElement.querySelector('.browse-btn');
    const outputDirInput = cardElement.querySelector('.output-dir-input');

    browseBtn.disabled = true;
    browseBtn.textContent = 'Opening...';

    try {
        const res = await fetch(`${API}/api/settings/output-dir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ browse: true })
        });
        const data = await res.json();

        if (data.success && data.path) {
            outputDirInput.value = data.path;
        }
    } catch (err) {
        logErrorDetail('browse request failed', err);
    }

    browseBtn.disabled = false;
    browseBtn.textContent = 'Browse';
}

function updateSelectedResult() {
    const results = document.querySelectorAll('.book-card');
    results.forEach((r, i) => {
        if (i === selectedResultIndex) {
            r.classList.add('ring-2', 'ring-oreilly-blue/30');
        } else {
            r.classList.remove('ring-2', 'ring-oreilly-blue/30');
        }
    });
    if (selectedResultIndex >= 0 && results[selectedResultIndex]) {
        results[selectedResultIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('unhandledrejection', (event) => {
        logError('unhandledrejection:', event.reason);
        if (event.reason instanceof Error && event.reason.stack) {
            console.error(event.reason.stack);
        }
    });
    window.addEventListener('error', (event) => {
        logError(
            'window error:',
            event.message,
            event.filename,
            event.lineno,
            event.colno,
            event.error
        );
        if (event.error?.stack) console.error(event.error.stack);
    });

    dbg('DOMContentLoaded', {
        href: location.href,
        oreillyDebug: (() => {
            try {
                return localStorage.getItem('oreillyDebug');
            } catch {
                return null;
            }
        })(),
        hint: "set localStorage oreillyDebug='0' to reduce dbgVerbose logs",
    });
    const cookieSnippet = document.getElementById('cookie-cmd-snippet');
    if (cookieSnippet) cookieSnippet.textContent = COOKIE_CONSOLE_CMD;
    const copyCookieCmdBtn = document.getElementById('copy-cookie-cmd-btn');
    if (copyCookieCmdBtn) {
        const defaultCopyLabel = copyCookieCmdBtn.textContent;
        copyCookieCmdBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(COOKIE_CONSOLE_CMD);
                copyCookieCmdBtn.textContent = 'Copied';
                setTimeout(() => {
                    copyCookieCmdBtn.textContent = defaultCopyLabel;
                }, 2000);
            } catch (e) {
                logErrorDetail('copy cookie command failed', e);
            }
        });
    }

    // Auth
    checkAuth();
    loadDefaultOutputDir();

    // Cookie modal
    document.getElementById('login-btn').onclick = () => {
        dbg('login-btn click');
        showCookieModal();
    };
    document.getElementById('cancel-modal-btn').onclick = () => {
        dbg('cancel-modal-btn click');
        hideCookieModal();
    };
    document.getElementById('save-cookies-btn').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dbg('save-cookies-btn click');
        saveCookies();
    };
    document.getElementById('cookie-modal').onclick = (e) => {
        if (e.target.id === 'cookie-modal') hideCookieModal();
    };

    // Search
    let searchTimeout;
    const searchInput = document.getElementById('search-input');

    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        if (query.length >= 2) {
            searchTimeout = setTimeout(() => search(query), 300);
        } else if (query.length === 0) {
            document.getElementById('search-results').innerHTML = '';
            currentExpandedCard = null;
        }
    });

    // Click outside to collapse
    document.addEventListener('click', (e) => {
        if (currentExpandedCard && !currentExpandedCard.contains(e.target)) {
            collapseBook();
        }
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        const results = document.querySelectorAll('.book-card');
        const searchInput = document.getElementById('search-input');

        if (e.key === 'Escape') {
            if (currentExpandedCard) {
                collapseBook();
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'Enter' && document.activeElement === searchInput) {
            clearTimeout(searchTimeout);
            const query = searchInput.value.trim();
            if (query.length >= 2) {
                search(query);
            }
            e.preventDefault();
            return;
        }

        if (!results.length || currentExpandedCard) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedResultIndex = Math.min(selectedResultIndex + 1, results.length - 1);
            updateSelectedResult();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedResultIndex = Math.max(selectedResultIndex - 1, 0);
            updateSelectedResult();
        } else if (e.key === 'Enter' && selectedResultIndex >= 0) {
            e.preventDefault();
            const selected = results[selectedResultIndex];
            if (selected) {
                expandBook(selected, selected.dataset.bookId);
            }
        }
    });
});
