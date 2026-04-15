import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../constants';
import type { DownloadListItem, DownloadListResponse } from '../types';
import { logApiOffPath, logErrorDetail, previewText } from '../utils';
import { ImageDrawer } from './ImageDrawer';

const PAGE_SIZE = 10;
const KNOWLEDGE_POLL_MS = 2500;

type DownloadFormat = 'pdf' | 'epub' | 'json';

const FORMAT_META: Record<DownloadFormat, { label: string; bg: string; text: string }> = {
    pdf:  { label: 'PDF',  bg: 'bg-red-100 hover:bg-red-200',    text: 'text-red-700' },
    epub: { label: 'EPUB', bg: 'bg-green-100 hover:bg-green-200', text: 'text-green-700' },
    json: { label: 'JSON', bg: 'bg-blue-100 hover:bg-blue-200',   text: 'text-blue-700' },
};

type Props = {
    outputDir: string;
};

export function DownloadedList({ outputDir }: Props) {
    const [page, setPage] = useState(1);
    const [data, setData] = useState<DownloadListResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [knowledgeBusy, setKnowledgeBusy] = useState<string | null>(null);
    const [knowledgeProgress, setKnowledgeProgress] = useState<{
        status?: string;
        percentage?: number;
        message?: string;
        book_dir?: string;
        agent_json?: string;
        kg_graph?: string;
        error?: string;
    } | null>(null);

    const [downloadPopover, setDownloadPopover] = useState<string | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [drawerItem, setDrawerItem] = useState<DownloadListItem | null>(null);

    useEffect(() => {
        if (!downloadPopover) return;
        function onClickOutside(e: MouseEvent) {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                setDownloadPopover(null);
            }
        }
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [downloadPopover]);

    const triggerDownload = useCallback(
        (item: DownloadListItem, fmt: DownloadFormat) => {
            const q = new URLSearchParams({
                book_name: item.folder_name,
                format: fmt,
            });
            const trimmed = outputDir.trim();
            if (trimmed) q.set('output_dir', trimmed);

            const link = document.createElement('a');
            link.href = `${API}/api/download-file?${q}`;
            link.download = '';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            setDownloadPopover(null);
        },
        [outputDir],
    );

    useEffect(() => {
        setPage(1);
    }, [outputDir]);

    useEffect(() => {
        const ac = new AbortController();
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const q = new URLSearchParams({
                    page: String(page),
                    page_size: String(PAGE_SIZE),
                });
                const trimmed = outputDir.trim();
                if (trimmed) q.set('output_dir', trimmed);
                const res = await fetch(`${API}/api/downloads?${q}`, { signal: ac.signal });
                const raw = await res.text();
                let parsed: DownloadListResponse = {
                    items: [],
                    page: 1,
                    page_size: PAGE_SIZE,
                    total: 0,
                    output_dir: '',
                };
                try {
                    parsed = raw ? (JSON.parse(raw) as DownloadListResponse) : parsed;
                } catch (parseErr) {
                    logApiOffPath('GET /api/downloads', '响应不是合法 JSON', {
                        status: res.status,
                        bodyPreview: previewText(raw),
                        parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                    });
                    throw new Error('Invalid JSON from server');
                }
                if (!res.ok) {
                    const msg =
                        typeof parsed.error === 'string' && parsed.error
                            ? parsed.error
                            : `Request failed (HTTP ${res.status})`;
                    logApiOffPath('GET /api/downloads', 'HTTP 非 2xx', {
                        status: res.status,
                        bodyPreview: previewText(raw),
                    });
                    throw new Error(msg);
                }
                if (ac.signal.aborted) return;
                setData(parsed);
            } catch (e) {
                if (ac.signal.aborted) return;
                logErrorDetail('downloads list failed', e);
                setData(null);
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!ac.signal.aborted) setLoading(false);
            }
        }
        void load();
        return () => ac.abort();
    }, [page, outputDir]);

    const total = data?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    useEffect(() => {
        if (!knowledgeBusy) return;
        let stopped = false;
        const timer = window.setInterval(() => {
            if (stopped) return;
            void (async () => {
                try {
                    const res = await fetch(`${API}/api/progress`);
                    const raw = await res.text();
                    if (!res.ok) return;
                    let parsed: any = {};
                    try {
                        parsed = raw ? JSON.parse(raw) : {};
                    } catch {
                        return;
                    }
                    setKnowledgeProgress(parsed);

                    const status = String(parsed?.status || '');
                    const bookDir = typeof parsed?.book_dir === 'string' ? parsed.book_dir : '';
                    const stillThisTask = bookDir && knowledgeBusy && bookDir === knowledgeBusy;
                    if (!stillThisTask) return;

                    if (status === 'knowledge_completed' || status === 'knowledge_error') {
                        setKnowledgeBusy(null);
                    }
                } catch {
                    // ignore transient polling failures
                }
            })();
        }, KNOWLEDGE_POLL_MS);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [knowledgeBusy]);

    const generateKnowledge = useCallback(
        async (item: DownloadListItem) => {
            // Keep a long-running busy state until /api/progress reports completion.
            setKnowledgeBusy(item.path);
            setKnowledgeProgress(null);
            try {
                const body: { book_name: string; output_dir?: string } = { book_name: item.folder_name };
                const trimmed = outputDir.trim();
                if (trimmed) body.output_dir = trimmed;

                const res = await fetch(`${API}/api/generate_knowledge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const raw = await res.text();
                let parsed: { error?: string; status?: string } = {};
                try {
                    parsed = raw ? (JSON.parse(raw) as typeof parsed) : {};
                } catch {
                    /* ignore */
                }
                if (!res.ok) {
                    const msg = parsed.error || `Request failed (HTTP ${res.status})`;
                    logApiOffPath('POST /api/generate_knowledge', '生成知识失败', {
                        status: res.status,
                        book_name: item.folder_name,
                        bodyPreview: previewText(raw),
                    });
                    setError(msg);
                    setKnowledgeBusy(null);
                    return;
                }
            } catch (err) {
                logErrorDetail('generate knowledge failed', err);
                setError(err instanceof Error ? err.message : String(err));
                setKnowledgeBusy(null);
            } finally {
                // Do not clear busy here: generation continues server-side.
            }
        },
        [outputDir],
    );

    const fmtTime = (iso: string) => {
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            return d.toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch {
            return iso;
        }
    };

    return (
        <section className="mb-10 rounded-xl border border-zinc-200 bg-surface-50 p-5 shadow-card">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between mb-4">
                <div>
                    <h2 className="text-sm font-semibold text-zinc-900">已下载</h2>
                    <p className="text-xs text-zinc-500 mt-0.5">
                        来自输出目录，按最近修改倒序 · 每页 {PAGE_SIZE} 条
                    </p>
                </div>
                {data?.output_dir && (
                    <p className="text-xs text-zinc-400 font-mono truncate max-w-full sm:max-w-[50%] text-right">
                        {data.output_dir}
                    </p>
                )}
            </div>

            {loading && (
                <p className="text-sm text-zinc-500 py-6 text-center">加载中…</p>
            )}
            {!loading && error && (
                <p className="text-sm text-red-600 py-4">{error}</p>
            )}
            {!loading && !error && total === 0 && (
                <p className="text-sm text-zinc-500 py-6 text-center">输出目录下暂无已下载书籍</p>
            )}
            {!loading && !error && total > 0 && data && (
                <>
                    <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-lg bg-white overflow-hidden">
                        {data.items.map((item) => {
                            const st = item.knowledge_stats;
                            const statsLine = (() => {
                                if (!st) return null;
                                if (st.message && !st.exists && st.error_count == null) {
                                    return (
                                        <span className="text-zinc-500">{st.message}</span>
                                    );
                                }
                                if (st.parse_error || (st.message && st.error_count == null && st.exists)) {
                                    return <span className="text-amber-700">{st.message || '统计不可用'}</span>;
                                }
                                if (st.exists && typeof st.error_count === 'number' && typeof st.chapter_count === 'number') {
                                    return (
                                        <span className={st.error_count > 0 ? 'text-red-600' : 'text-emerald-700'}>
                                            agent_knowledge.json：失败 {st.error_count} / 共 {st.chapter_count} 章
                                        </span>
                                    );
                                }
                                return st.message ? (
                                    <span className="text-zinc-600">{st.message}</span>
                                ) : null;
                            })();
                            return (
                            <li
                                key={`${item.path}-${item.modified_at}`}
                                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 hover:bg-zinc-50/80 transition-colors"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium text-zinc-900 truncate" title={item.folder_name}>
                                        {item.folder_name}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500 mt-1">
                                        {item.book_id ? (
                                            <span className="font-mono">ID {item.book_id}</span>
                                        ) : (
                                            <span>无 book_id</span>
                                        )}
                                        <span>{fmtTime(item.modified_at)}</span>
                                        {item.formats && (
                                            <div className="flex gap-1.5 ml-1">
                                                {item.formats.pdf && (
                                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700">PDF</span>
                                                )}
                                                {item.formats.epub && (
                                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">EPUB</span>
                                                )}
                                                {item.formats.json && (
                                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">JSON</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="shrink-0 self-start sm:self-center flex flex-col items-stretch sm:items-end gap-1">
                                <div className="flex items-center gap-2">
                                    {item.formats && (item.formats.pdf || item.formats.epub || item.formats.json) && (
                                        <div className="relative" ref={downloadPopover === item.path ? popoverRef : undefined}>
                                            <button
                                                type="button"
                                                onClick={() => setDownloadPopover(downloadPopover === item.path ? null : item.path)}
                                                className="px-3 py-1.5 text-xs font-medium text-zinc-700 border border-zinc-300 rounded-lg hover:bg-zinc-100 transition-colors flex items-center gap-1.5"
                                            >
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                                </svg>
                                                下载
                                            </button>
                                            {downloadPopover === item.path && (
                                                <div className="absolute right-0 top-full mt-1.5 z-30 bg-white rounded-lg shadow-lg border border-zinc-200 py-1.5 min-w-[120px] animate-in fade-in slide-in-from-top-1">
                                                    <p className="px-3 py-1 text-[10px] text-zinc-400 font-medium uppercase tracking-wider">选择格式</p>
                                                    {(['pdf', 'epub', 'json'] as DownloadFormat[])
                                                        .filter((f) => item.formats?.[f])
                                                        .map((f) => (
                                                            <button
                                                                key={f}
                                                                type="button"
                                                                onClick={() => triggerDownload(item, f)}
                                                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-50 transition-colors flex items-center gap-2"
                                                            >
                                                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${FORMAT_META[f].bg} ${FORMAT_META[f].text}`}>
                                                                    {FORMAT_META[f].label}
                                                                </span>
                                                                <span className="text-zinc-600">下载 {FORMAT_META[f].label} 文件</span>
                                                            </button>
                                                        ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {(item.knowledge_images_count ?? 0) > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => setDrawerItem(item)}
                                            className="px-3 py-1.5 text-xs font-medium text-violet-700 border border-violet-300 rounded-lg hover:bg-violet-50 transition-colors flex items-center gap-1.5"
                                        >
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                            </svg>
                                            图片 {item.knowledge_images_count}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        disabled={knowledgeBusy === item.path}
                                        onClick={() => void generateKnowledge(item)}
                                        className="px-3 py-1.5 text-xs font-medium text-oreilly-red border border-oreilly-red/30 rounded-lg hover:bg-oreilly-red/5 disabled:opacity-50 transition-colors"
                                    >
                                        {knowledgeBusy === item.path
                                            ? `生成中…${typeof knowledgeProgress?.percentage === 'number' ? ` ${knowledgeProgress.percentage}%` : ''}`
                                            : '生成知识'}
                                    </button>
                                </div>
                                {statsLine && (
                                    <p className="text-xs text-left sm:text-right max-w-md break-words mt-1">{statsLine}</p>
                                )}
                                </div>
                            </li>
                            );
                        })}
                    </ul>
                    <div className="flex items-center justify-between mt-4 gap-3">
                        <p className="text-xs text-zinc-500">
                            共 {total} 条 · 第 {page} / {totalPages} 页
                        </p>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                disabled={page <= 1}
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:pointer-events-none"
                            >
                                上一页
                            </button>
                            <button
                                type="button"
                                disabled={page >= totalPages}
                                onClick={() => setPage((p) => p + 1)}
                                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:pointer-events-none"
                            >
                                下一页
                            </button>
                        </div>
                    </div>
                </>
            )}
            {drawerItem && (
                <ImageDrawer
                    bookName={drawerItem.folder_name}
                    outputDir={outputDir}
                    onClose={() => setDrawerItem(null)}
                />
            )}
        </section>
    );
}
