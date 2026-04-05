import { useCallback, useEffect, useRef, useState } from 'react';
import { API, COOKIE_CONSOLE_CMD, SEARCH_TIMEOUT_MS } from './constants';
import { BookCard } from './components/BookCard';
import { useAuth } from './hooks/useAuth';
import type { BookHit } from './types';
import { dbg, dbgVerbose, logApiOffPath, logError, logErrorDetail, normalizeSearchHit, previewText } from './utils';

async function loadDefaultOutputDir(): Promise<string> {
    try {
        const res = await fetch(`${API}/api/settings`);
        const raw = await res.text();
        let data: { output_dir?: string } = {};
        try {
            data = raw ? (JSON.parse(raw) as { output_dir?: string }) : {};
        } catch (parseErr) {
            logApiOffPath('GET /api/settings', '响应不是合法 JSON，无法读取 output_dir', {
                status: res.status,
                bodyPreview: previewText(raw),
                parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            return '';
        }
        if (!res.ok) {
            logApiOffPath('GET /api/settings', 'HTTP 非 2xx，不使用默认输出目录', {
                status: res.status,
                bodyPreview: previewText(raw),
            });
            return '';
        }
        return data.output_dir ?? '';
    } catch (err) {
        logApiOffPath('GET /api/settings', '请求失败（网络等）', {
            err: err instanceof Error ? err.message : String(err),
        });
        logErrorDetail('loadDefaultOutputDir failed', err);
        return '';
    }
}

export default function App() {
    const { auth, checkAuth } = useAuth();
    const [cookieModalOpen, setCookieModalOpen] = useState(false);
    const [cookieInput, setCookieInput] = useState('');
    const [cookieError, setCookieError] = useState('');
    const [copyCmdLabel, setCopyCmdLabel] = useState('Copy command');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<BookHit[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchMessage, setSearchMessage] = useState<{ type: 'empty' | 'error'; text: string } | null>(
        null,
    );
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [selectedIdx, setSelectedIdx] = useState(-1);
    const [defaultOutputDir, setDefaultOutputDir] = useState('');

    const searchSeqRef = useRef(0);
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const expandedCardRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        void loadDefaultOutputDir().then(setDefaultOutputDir);
    }, []);

    useEffect(() => {
        dbg('App mount', { href: location.href });
        const onRej = (event: PromiseRejectionEvent) => {
            logError('unhandledrejection:', event.reason);
            if (event.reason instanceof Error && event.reason.stack) console.error(event.reason.stack);
        };
        const onErr = (event: ErrorEvent) => {
            logError(
                'window error:',
                event.message,
                event.filename,
                event.lineno,
                event.colno,
                event.error,
            );
            if (event.error?.stack) console.error(event.error.stack);
        };
        window.addEventListener('unhandledrejection', onRej);
        window.addEventListener('error', onErr);
        return () => {
            window.removeEventListener('unhandledrejection', onRej);
            window.removeEventListener('error', onErr);
        };
    }, []);

    useEffect(() => {
        if (expandedId === null) expandedCardRef.current = null;
    }, [expandedId]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                if (expandedId) {
                    setExpandedId(null);
                    e.preventDefault();
                }
                if (cookieModalOpen) setCookieModalOpen(false);
                return;
            }
            if (e.key === 'Enter') {
                if (cookieModalOpen) return;
                const t = e.target as HTMLElement;
                if (t.closest('input, textarea, button, a, [contenteditable]')) return;
                if (!results.length || expandedId !== null || selectedIdx < 0) return;
                e.preventDefault();
                const b = results[selectedIdx];
                if (b) setExpandedId(b.id);
            }
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [expandedId, cookieModalOpen, results, selectedIdx]);

    const setCardRef = (bookId: string) => (node: HTMLElement | null) => {
        if (expandedId === bookId) expandedCardRef.current = node;
    };

    useEffect(() => {
        function onDocClick(e: MouseEvent) {
            if (!expandedId || !expandedCardRef.current) return;
            const t = e.target as Node;
            if (expandedCardRef.current.contains(t)) return;
            if (cookieModalOpen) return;
            setExpandedId(null);
        }
        document.addEventListener('click', onDocClick);
        return () => document.removeEventListener('click', onDocClick);
    }, [expandedId, cookieModalOpen]);

    const runSearch = useCallback(async (q: string) => {
        const seq = ++searchSeqRef.current;
        setSearchLoading(true);
        setSearchMessage(null);

        const ac = new AbortController();
        const timeoutId = window.setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
        const url = `${API}/api/search?q=${encodeURIComponent(q)}`;

        try {
            dbgVerbose('search: fetch', url);
            const res = await fetch(url, { signal: ac.signal });
            const rawText = await res.text();
            let data: { results?: unknown[]; error?: string } = {};
            try {
                data = rawText ? JSON.parse(rawText) : {};
            } catch (parseErr) {
                logApiOffPath('GET /api/search', '响应体不是合法 JSON', {
                    seq,
                    q,
                    status: res.status,
                    bodyPreview: previewText(rawText),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                logErrorDetail('search: JSON.parse failed', parseErr);
                throw parseErr;
            }

            if (seq !== searchSeqRef.current) {
                logApiOffPath('GET /api/search', '已有更新的搜索请求，本次结果丢弃（stale）', {
                    seq,
                    currentSeq: searchSeqRef.current,
                    q,
                    resOk: res.ok,
                });
                dbgVerbose('search: stale after parse', { seq });
                return;
            }

            if (!res.ok) {
                const msg = data?.error || `Search failed (HTTP ${res.status})`;
                logApiOffPath('GET /api/search', 'HTTP 非 2xx，展示错误文案', {
                    status: res.status,
                    q,
                    serverError: data?.error,
                    bodyPreview: previewText(rawText),
                });
                setResults([]);
                setSearchMessage({ type: 'error', text: msg });
                return;
            }

            let list = data.results;
            if (!Array.isArray(list)) {
                logApiOffPath('GET /api/search', 'JSON 里 results 不是数组，按空列表处理', {
                    q,
                    resultsType: list === undefined ? 'undefined' : typeof list,
                    bodyPreview: previewText(rawText),
                });
                logError('search: data.results is not an array');
                list = [];
            }

            const books: BookHit[] = [];
            let badHits = 0;
            for (const raw of list) {
                const b = normalizeSearchHit(raw);
                if (b) books.push(b);
                else {
                    badHits += 1;
                    logError('search: normalizeSearchHit returned null', { raw });
                }
            }
            if (badHits > 0) {
                logApiOffPath('GET /api/search', '部分结果项无法规范化（缺 id 等），已跳过', {
                    q,
                    badHits,
                    totalFromApi: list.length,
                });
            }

            if (books.length === 0) {
                setResults([]);
                setSearchMessage({
                    type: 'empty',
                    text: `No books found for "${q}"`,
                });
                return;
            }

            setResults(books);
            setSelectedIdx(-1);
            setExpandedId(null);
        } catch (err) {
            if (seq !== searchSeqRef.current) {
                logApiOffPath('GET /api/search', '出错时已有更新的搜索请求，忽略本次错误（stale）', {
                    seq,
                    currentSeq: searchSeqRef.current,
                    q,
                    err: err instanceof Error ? err.message : String(err),
                });
                return;
            }
            logApiOffPath('GET /api/search', '请求或解析过程异常', {
                q,
                err: err instanceof Error ? err.name + ': ' + err.message : String(err),
            });
            logErrorDetail('search: failed', err);
            setResults([]);
            setSearchMessage({
                type: 'error',
                text: err instanceof Error ? err.message : String(err),
            });
        } finally {
            window.clearTimeout(timeoutId);
            if (seq === searchSeqRef.current) setSearchLoading(false);
        }
    }, []);

    const onQueryChange = (value: string) => {
        setQuery(value);
        const trimmed = value.trim();
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        if (trimmed.length >= 2) {
            searchDebounceRef.current = setTimeout(() => void runSearch(trimmed), 300);
        } else if (trimmed.length === 0) {
            setResults([]);
            setSearchMessage(null);
            setExpandedId(null);
        }
    };

    const saveCookies = async () => {
        setCookieError('');
        const input = cookieInput.trim();
        if (!input) {
            setCookieError('Please paste your cookie JSON');
            return;
        }
        let cookies: unknown;
        try {
            cookies = JSON.parse(input);
            if (typeof cookies !== 'object' || cookies === null || Array.isArray(cookies)) {
                throw new Error('Must be a JSON object');
            }
        } catch (e) {
            setCookieError(e instanceof Error ? `Invalid JSON: ${e.message}` : 'Invalid JSON format');
            return;
        }
        try {
            const res = await fetch(`${API}/api/cookies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cookies),
            });
            const rawText = await res.text();
            const trimmedBody = rawText.replace(/^\uFEFF/, '').trim();
            let data: { error?: unknown; success?: boolean; count?: number } = {};
            try {
                data = trimmedBody ? (JSON.parse(trimmedBody) as typeof data) : {};
            } catch (parseErr) {
                logApiOffPath('POST /api/cookies', '响应体不是合法 JSON', {
                    status: res.status,
                    bodyPreview: previewText(trimmedBody),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                setCookieError('Server returned non-JSON response');
                return;
            }
            const errMsg =
                typeof data.error === 'string' && data.error.trim() !== ''
                    ? data.error.trim()
                    : undefined;
            if (!res.ok) {
                logApiOffPath('POST /api/cookies', 'HTTP 非 2xx，不关闭弹窗', {
                    status: res.status,
                    errMsg,
                    bodyPreview: previewText(trimmedBody),
                });
                setCookieError(errMsg ?? `HTTP ${res.status}`);
                return;
            }
            if (errMsg) {
                logApiOffPath('POST /api/cookies', 'JSON 含 error 字段，不关闭弹窗', {
                    errMsg,
                    bodyPreview: previewText(trimmedBody),
                });
                setCookieError(errMsg);
                return;
            }
            setCookieModalOpen(false);
            setCookieInput('');
            void checkAuth();
        } catch (err) {
            logApiOffPath('POST /api/cookies', 'fetch 或读 body 异常', {
                err: err instanceof Error ? err.name + ': ' + err.message : String(err),
            });
            logErrorDetail('saveCookies failed', err);
            setCookieError('Failed to save cookies');
        }
    };

    const copyCookieCmd = async () => {
        try {
            await navigator.clipboard.writeText(COOKIE_CONSOLE_CMD);
            setCopyCmdLabel('Copied');
            window.setTimeout(() => setCopyCmdLabel('Copy command'), 2000);
        } catch (e) {
            logErrorDetail('copy cookie command failed', e);
        }
    };

    const authDotClass =
        auth.phase === 'checking'
            ? 'bg-zinc-300 animate-pulse-subtle'
            : auth.valid
              ? 'bg-emerald-500'
              : 'bg-amber-500';
    const authTextClass =
        auth.phase === 'checking'
            ? 'text-zinc-500'
            : auth.valid
              ? 'text-emerald-600'
              : 'text-amber-600';

    return (
        <div className="min-h-screen flex flex-col bg-white font-sans text-zinc-900 antialiased">
            <header className="bg-white/95 backdrop-blur-sm border-b border-zinc-100 sticky top-0 z-40">
                <div className="max-w-4xl mx-auto px-5 py-4 flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                        <span className="text-[1.625rem] font-bold tracking-tight text-oreilly-red">
                            O'REILLY
                        </span>
                        <span className="text-base font-medium text-zinc-300">Ingest new</span>
                    </div>
                    <div className="flex items-center gap-3 sm:gap-4 flex-wrap justify-end">
                        <div className="flex items-center gap-2 sm:gap-3">
                            <div className={`flex items-center gap-2 text-sm ${authTextClass}`}>
                                <span className={`status-dot w-2 h-2 rounded-full ${authDotClass}`} />
                                <span>{auth.label}</span>
                            </div>
                            <button
                                type="button"
                                className="px-3 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium text-oreilly-red border border-oreilly-red/30 rounded-lg hover:bg-oreilly-red/5 transition-colors duration-150 whitespace-nowrap"
                                onClick={() => {
                                    setCookieInput('');
                                    setCookieError('');
                                    setCookieModalOpen(true);
                                }}
                            >
                                Set Cookies
                            </button>
                        </div>
                        <a
                            href="https://github.com/potti/oreilly-ingest"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-400 hover:text-zinc-700 transition-colors"
                            title="View on GitHub"
                        >
                            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                            </svg>
                        </a>
                    </div>
                </div>
            </header>

            <main className="flex-1 max-w-4xl w-full mx-auto px-5 py-10">
                {auth.phase === 'ready' && !auth.valid && (
                    <section className="mb-10 rounded-xl border border-zinc-200 bg-surface-50 p-5 shadow-card">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <h2 className="text-sm font-semibold text-zinc-900">Get cookies from O’Reilly</h2>
                                <p className="mt-1 text-sm text-zinc-600 leading-relaxed">
                                    Open{' '}
                                    <a
                                        href="https://learning.oreilly.com"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-oreilly-blue hover:underline font-medium"
                                    >
                                        learning.oreilly.com
                                    </a>
                                    , sign in, then press{' '}
                                    <kbd className="px-1.5 py-0.5 bg-zinc-200/80 rounded text-xs font-mono">
                                        F12
                                    </kbd>{' '}
                                    → <span className="font-medium">Console</span> and run:
                                </p>
                            </div>
                            <button
                                type="button"
                                className="shrink-0 self-start px-3 py-2 text-xs font-medium text-oreilly-blue border border-oreilly-blue/30 rounded-lg bg-white hover:bg-oreilly-blue-light transition-colors"
                                onClick={() => void copyCookieCmd()}
                            >
                                {copyCmdLabel}
                            </button>
                        </div>
                        <pre className="mt-4 bg-zinc-900 text-zinc-100 text-xs p-4 rounded-xl overflow-x-auto font-mono leading-relaxed border border-zinc-800">
                            <code>{COOKIE_CONSOLE_CMD}</code>
                        </pre>
                        <p className="mt-3 text-sm text-zinc-600">
                            Copy the printed JSON, click <span className="font-medium text-zinc-800">Set Cookies</span>
                            , and paste it there.
                        </p>
                    </section>
                )}

                <section className="mb-10">
                    <div className="relative group">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 transition-colors group-focus-within:text-oreilly-blue">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                                />
                            </svg>
                        </div>
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => onQueryChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                                    const t = query.trim();
                                    if (t.length >= 2) void runSearch(t);
                                    e.preventDefault();
                                    return;
                                }
                                if (!results.length || expandedId) return;
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
                                } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSelectedIdx((i) => Math.max(i - 1, 0));
                                }
                            }}
                            placeholder="Search by title, author, or ISBN..."
                            className="w-full pl-12 pr-12 py-4 text-base bg-surface-50 border border-zinc-200 rounded-xl placeholder:text-zinc-400 focus:outline-none focus:bg-white focus:border-oreilly-blue focus:ring-4 focus:ring-oreilly-blue/10 transition-all duration-200"
                            autoComplete="off"
                        />
                        {searchLoading && (
                            <div className="absolute right-4 top-1/2 -translate-y-1/2">
                                <svg
                                    className="animate-spin h-5 w-5 text-oreilly-blue"
                                    viewBox="0 0 24 24"
                                >
                                    <circle
                                        className="opacity-25"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        strokeWidth="4"
                                        fill="none"
                                    />
                                    <path
                                        className="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                    />
                                </svg>
                            </div>
                        )}
                    </div>
                </section>

                <section
                    id="search-results"
                    className={`space-y-3 ${expandedId ? 'has-expanded' : ''}`}
                >
                    {results.length === 0 && searchMessage && (
                        <div
                            className={`text-center py-16 ${
                                searchMessage.type === 'error' ? 'text-red-600' : 'text-zinc-500'
                            }`}
                        >
                            <p className="text-lg">{searchMessage.text}</p>
                            {searchMessage.type === 'empty' && (
                                <p className="text-sm mt-2 text-zinc-400">
                                    Try a different search term or ISBN
                                </p>
                            )}
                        </div>
                    )}
                    {results.map((b, i) => (
                        <div
                            key={b.id}
                            className={
                                selectedIdx === i && expandedId == null
                                    ? 'ring-2 ring-oreilly-blue/30 rounded-xl'
                                    : undefined
                            }
                        >
                            <BookCard
                                ref={setCardRef(b.id)}
                                book={b}
                                expanded={expandedId === b.id}
                                defaultOutputDir={defaultOutputDir}
                                onExpand={() => setExpandedId(b.id)}
                                onCollapse={() => setExpandedId(null)}
                            />
                        </div>
                    ))}
                </section>
            </main>

            <div
                id="cookie-modal"
                className={cookieModalOpen ? 'fixed inset-0 z-50 overflow-y-auto' : 'hidden'}
            >
                <div className="min-h-screen px-4 flex items-center justify-center">
                    <button
                        type="button"
                        className="fixed inset-0 bg-zinc-900/60 backdrop-blur-sm w-full h-full border-0 cursor-default"
                        aria-label="Close modal backdrop"
                        onClick={() => setCookieModalOpen(false)}
                    />
                    <div className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full p-7 animate-slide-down z-10">
                        <h3 className="text-xl font-semibold text-zinc-900 mb-5">Set Session Cookies</h3>
                        <div className="space-y-4 text-zinc-600 mb-6">
                            <p className="font-medium text-zinc-800">Follow these steps:</p>
                            <ol className="list-decimal list-inside space-y-2 text-sm leading-relaxed">
                                <li>
                                    Open{' '}
                                    <a
                                        href="https://learning.oreilly.com"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-oreilly-blue hover:underline font-medium"
                                    >
                                        learning.oreilly.com
                                    </a>{' '}
                                    and log in
                                </li>
                                <li>
                                    Open browser console{' '}
                                    <kbd className="px-1.5 py-0.5 bg-zinc-100 rounded text-xs font-mono">
                                        F12
                                    </kbd>{' '}
                                    → Console
                                </li>
                                <li>Paste this command and press Enter:</li>
                            </ol>
                            <pre className="bg-zinc-900 text-zinc-100 text-xs p-4 rounded-xl overflow-x-auto font-mono leading-relaxed">
                                <code>{COOKIE_CONSOLE_CMD}</code>
                            </pre>
                            <p className="text-sm">Copy the output and paste below:</p>
                        </div>
                        <textarea
                            value={cookieInput}
                            onChange={(e) => setCookieInput(e.target.value)}
                            placeholder='{"cookie_name": "value", ...}'
                            className="w-full h-28 px-4 py-3 border border-zinc-200 rounded-xl font-mono text-sm resize-none focus:outline-none focus:border-oreilly-blue focus:ring-4 focus:ring-oreilly-blue/10 transition-all duration-200"
                        />
                        {cookieError && <p className="mt-3 text-sm text-red-600 font-medium">{cookieError}</p>}
                        <div className="flex justify-end gap-3 mt-6">
                            <button
                                type="button"
                                className="px-5 py-2.5 text-zinc-600 hover:bg-zinc-100 rounded-lg font-medium transition-colors duration-150"
                                onClick={() => setCookieModalOpen(false)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="px-5 py-2.5 bg-oreilly-blue hover:bg-oreilly-blue-dark text-white rounded-lg font-medium transition-colors duration-150"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void saveCookies();
                                }}
                            >
                                Save Cookies
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <footer className="py-6 text-center text-sm text-zinc-400 border-t border-zinc-100">
                <a
                    href="https://github.com/potti/oreilly-ingest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-600 hover:text-oreilly-blue transition-colors"
                >
                    potti/oreilly-ingest
                </a>
            </footer>
        </div>
    );
}
