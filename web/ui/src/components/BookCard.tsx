import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { API, BOOK_ONLY_FORMATS } from '../constants';
import { chaptersCache } from '../chaptersCache';
import type { BookHit, ChapterRow, ProgressPayload } from '../types';
import { escapeHtml, formatETA, getHighResCoverUrl, logApiOffPath, logErrorDetail, previewText } from '../utils';

type Props = {
    book: BookHit;
    expanded: boolean;
    defaultOutputDir: string;
    onExpand: () => void;
    onCollapse: () => void;
};

async function revealFile(path: string) {
    try {
        const res = await fetch(`${API}/api/reveal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        const raw = await res.text();
        let data: { error?: string } = {};
        try {
            data = raw ? (JSON.parse(raw) as { error?: string }) : {};
        } catch (parseErr) {
            logApiOffPath('POST /api/reveal', '响应不是合法 JSON', {
                status: res.status,
                pathPreview: previewText(path, 120),
                bodyPreview: previewText(raw),
                parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            return;
        }
        if (!res.ok) {
            logApiOffPath('POST /api/reveal', 'HTTP 非 2xx', {
                status: res.status,
                pathPreview: previewText(path, 120),
                serverError: data.error,
                bodyPreview: previewText(raw),
            });
        }
        if (data.error) {
            logApiOffPath('POST /api/reveal', '服务端返回 error，未在 Finder 中展示成功', {
                error: data.error,
                pathPreview: previewText(path, 120),
            });
            console.error('[oreilly-ingest] reveal failed:', data.error);
        }
    } catch (err) {
        logApiOffPath('POST /api/reveal', 'fetch 或读 body 失败', {
            err: err instanceof Error ? err.name + ': ' + err.message : String(err),
        });
        logErrorDetail('reveal request failed', err);
    }
}

export const BookCard = forwardRef<HTMLElement, Props>(function BookCard(
    { book, expanded, defaultOutputDir, onExpand, onCollapse },
    ref,
) {
    const [format, setFormat] = useState('markdown');
    const [chaptersScope, setChaptersScope] = useState<'all' | 'select'>('all');
    const [outputStyle, setOutputStyle] = useState<'combined' | 'separate'>('combined');
    const [chapters, setChapters] = useState<ChapterRow[] | null>(null);
    const [chaptersLoading, setChaptersLoading] = useState(false);
    const [chapterChecked, setChapterChecked] = useState<Record<number, boolean>>({});
    const [publisher, setPublisher] = useState('Loading...');
    const [pages, setPages] = useState('Loading...');
    const [descriptionHtml, setDescriptionHtml] = useState('Loading description...');
    const [detailLoading, setDetailLoading] = useState(true);
    const [outputDir, setOutputDir] = useState(defaultOutputDir);
    const [chunkSize, setChunkSize] = useState(4000);
    const [chunkOverlap, setChunkOverlap] = useState(200);
    const [skipImages, setSkipImages] = useState(false);
    const [shakeFormat, setShakeFormat] = useState(false);
    const [shakeChapters, setShakeChapters] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [polling, setPolling] = useState(false);
    const [progress, setProgress] = useState<ProgressPayload | null>(null);
    const [showResults, setShowResults] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);
    const pollCancel = useRef(false);

    const bookOnly = BOOK_ONLY_FORMATS.includes(format as (typeof BOOK_ONLY_FORMATS)[number]);

    useEffect(() => {
        if (bookOnly) setOutputStyle('combined');
    }, [bookOnly]);

    useEffect(() => {
        if (progress?.status === 'completed' || progress?.status === 'error' || progress?.status === 'cancelled') {
            setDownloading(false);
        }
    }, [progress?.status]);

    useEffect(() => {
        setOutputDir(defaultOutputDir || 'Loading...');
    }, [defaultOutputDir]);

    useEffect(() => {
        if (!expanded) return;
        setDetailLoading(true);
        setPublisher('Loading...');
        setPages('Loading...');
        setDescriptionHtml('Loading description...');
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API}/api/book/${encodeURIComponent(book.id)}`);
                const raw = await res.text();
                let b: {
                    publishers?: string[];
                    virtual_pages?: number;
                    description?: string;
                } = {};
                try {
                    b = raw ? (JSON.parse(raw) as typeof b) : {};
                } catch (parseErr) {
                    logApiOffPath(`GET /api/book/${book.id}`, '详情响应不是合法 JSON', {
                        status: res.status,
                        bodyPreview: previewText(raw),
                        parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                    });
                    if (!cancelled) setDescriptionHtml('Failed to load details.');
                    return;
                }
                if (!res.ok) {
                    logApiOffPath(`GET /api/book/${book.id}`, 'HTTP 非 2xx，仍尝试用已解析字段展示', {
                        status: res.status,
                        bodyPreview: previewText(raw),
                    });
                }
                if (cancelled) return;
                setPublisher(b.publishers?.join(', ') || 'Unknown');
                setPages(b.virtual_pages != null ? String(b.virtual_pages) : 'N/A');
                setDescriptionHtml(b.description || 'No description available.');
            } catch (err) {
                logApiOffPath(`GET /api/book/${book.id}`, '请求或读 body 异常', {
                    err: err instanceof Error ? err.name + ': ' + err.message : String(err),
                });
                logErrorDetail(`expandBook fetch details failed (bookId=${book.id})`, err);
                if (!cancelled) setDescriptionHtml('Failed to load details.');
            } finally {
                if (!cancelled) setDetailLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [expanded, book.id]);

    const loadChapters = useCallback(async () => {
        if (chaptersCache[book.id]) {
            const list = chaptersCache[book.id];
            setChapters(list);
            const chk: Record<number, boolean> = {};
            list.forEach((c) => {
                chk[c.index] = true;
            });
            setChapterChecked(chk);
            return;
        }
        setChaptersLoading(true);
        try {
            const res = await fetch(`${API}/api/book/${encodeURIComponent(book.id)}/chapters`);
            const raw = await res.text();
            let data: { chapters?: ChapterRow[] } = {};
            try {
                data = raw ? (JSON.parse(raw) as { chapters?: ChapterRow[] }) : {};
            } catch (parseErr) {
                logApiOffPath(`GET /api/book/.../chapters (${book.id})`, '章节列表响应不是合法 JSON', {
                    status: res.status,
                    bodyPreview: previewText(raw),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                setChapters([]);
                return;
            }
            if (!res.ok) {
                logApiOffPath(`GET /api/book/.../chapters (${book.id})`, 'HTTP 非 2xx，章节列表可能为空', {
                    status: res.status,
                    bodyPreview: previewText(raw),
                });
            }
            const list = data.chapters ?? [];
            if (!Array.isArray(data.chapters) && raw.trim() !== '' && res.ok) {
                logApiOffPath(`GET /api/book/.../chapters (${book.id})`, 'JSON 中 chapters 缺失或非数组，使用空列表', {
                    chaptersType: data.chapters === undefined ? 'undefined' : typeof data.chapters,
                });
            }
            chaptersCache[book.id] = list;
            setChapters(list);
            const chk: Record<number, boolean> = {};
            list.forEach((c) => {
                chk[c.index] = true;
            });
            setChapterChecked(chk);
        } catch (err) {
            logApiOffPath(`GET /api/book/.../chapters (${book.id})`, '请求或读 body 异常', {
                err: err instanceof Error ? err.name + ': ' + err.message : String(err),
            });
            logErrorDetail(`loadChaptersIfNeeded failed (bookId=${book.id})`, err);
            setChapters([]);
        } finally {
            setChaptersLoading(false);
        }
    }, [book.id]);

    useEffect(() => {
        if (expanded && chaptersScope === 'select') void loadChapters();
    }, [expanded, chaptersScope, loadChapters]);

    useEffect(() => {
        if (!polling) return;
        pollCancel.current = false;
        const run = async () => {
            while (!pollCancel.current) {
                try {
                    const res = await fetch(`${API}/api/progress`);
                    const raw = await res.text();
                    if (!res.ok) {
                        logApiOffPath('GET /api/progress', 'HTTP 非 2xx，本轮轮询跳过', {
                            status: res.status,
                            bodyPreview: previewText(raw),
                        });
                    }
                    let data: ProgressPayload = {};
                    try {
                        data = raw ? (JSON.parse(raw) as ProgressPayload) : {};
                    } catch (parseErr) {
                        logApiOffPath('GET /api/progress', '进度响应不是合法 JSON，本轮跳过', {
                            status: res.status,
                            bodyPreview: previewText(raw),
                            parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                        });
                        await new Promise((r) => setTimeout(r, 500));
                        continue;
                    }
                    if (pollCancel.current) return;
                    setProgress(data);
                    if (
                        data.status === 'completed' ||
                        data.status === 'error' ||
                        data.status === 'cancelled'
                    ) {
                        if (data.status === 'error') {
                            logApiOffPath('GET /api/progress', '任务状态为 error，停止轮询', {
                                error: data.error,
                                status: data.status,
                            });
                        }
                        if (data.status === 'cancelled') {
                            logApiOffPath('GET /api/progress', '任务状态为 cancelled，停止轮询', {
                                status: data.status,
                            });
                        }
                        setPolling(false);
                        if (data.status === 'completed') setShowResults(true);
                        return;
                    }
                } catch (err) {
                    logApiOffPath('GET /api/progress', '请求或解析异常，稍后重试轮询', {
                        err: err instanceof Error ? err.name + ': ' + err.message : String(err),
                    });
                    logErrorDetail('progress polling failed', err);
                }
                await new Promise((r) => setTimeout(r, 500));
            }
        };
        void run();
        return () => {
            pollCancel.current = true;
        };
    }, [polling]);

    useEffect(() => {
        if (!expanded) {
            pollCancel.current = true;
            setDownloading(false);
            setPolling(false);
            setProgress(null);
            setShowResults(false);
        }
    }, [expanded]);

    const chapterSummary = () => {
        if (!chapters?.length) return 'All chapters';
        const total = chapters.length;
        const checked = chapters.filter((c) => chapterChecked[c.index]).length;
        if (checked === total) return `All ${total} chapters`;
        if (checked === 0) return 'No chapters selected';
        return `${checked} of ${total} chapters`;
    };

    const toggleChapter = (index: number) => {
        setChapterChecked((prev) => ({ ...prev, [index]: !prev[index] }));
    };

    const selectAllChapters = (all: boolean) => {
        if (!chapters) return;
        const chk: Record<number, boolean> = {};
        chapters.forEach((c) => {
            chk[c.index] = all;
        });
        setChapterChecked(chk);
    };

    const browseOutputDir = async () => {
        try {
            const res = await fetch(`${API}/api/settings/output-dir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ browse: true }),
            });
            const raw = await res.text();
            let data: { success?: boolean; path?: string } = {};
            try {
                data = raw ? (JSON.parse(raw) as typeof data) : {};
            } catch (parseErr) {
                logApiOffPath('POST /api/settings/output-dir', '响应不是合法 JSON', {
                    status: res.status,
                    bodyPreview: previewText(raw),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                return;
            }
            if (!res.ok) {
                logApiOffPath('POST /api/settings/output-dir', 'HTTP 非 2xx，不更新输出路径', {
                    status: res.status,
                    bodyPreview: previewText(raw),
                });
                return;
            }
            if (data.success && data.path) {
                setOutputDir(data.path);
            } else {
                logApiOffPath('POST /api/settings/output-dir', 'JSON 未同时给出 success 与 path，不更新输入框', {
                    success: data.success,
                    hasPath: Boolean(data.path),
                    bodyPreview: previewText(raw),
                });
            }
        } catch (err) {
            logApiOffPath('POST /api/settings/output-dir', '请求或读 body 失败', {
                err: err instanceof Error ? err.name + ': ' + err.message : String(err),
            });
            logErrorDetail('browse request failed', err);
        }
    };

    const startDownload = async () => {
        if (!format) {
            setShakeFormat(true);
            window.setTimeout(() => setShakeFormat(false), 500);
            return;
        }

        let finalFormat = format;
        if (outputStyle === 'separate' && !bookOnly) {
            finalFormat = `${format}-chapters`;
        }

        let selectedChapters: number[] | null = null;
        if (chaptersScope === 'select') {
            const checked = chapters?.filter((c) => chapterChecked[c.index]) ?? [];
            if (checked.length === 0) {
                setShakeChapters(true);
                window.setTimeout(() => setShakeChapters(false), 500);
                return;
            }
            if (chapters && checked.length < chapters.length) {
                selectedChapters = checked.map((c) => c.index);
            }
        }

        setDownloading(true);
        setShowResults(false);
        setProgress(null);

        const body: Record<string, unknown> = {
            book_id: book.id,
            format: finalFormat,
        };
        if (selectedChapters !== null) body.chapters = selectedChapters;
        if (outputDir && outputDir !== defaultOutputDir) body.output_dir = outputDir;
        if (format === 'chunks') {
            body.chunking = { chunk_size: chunkSize, overlap: chunkOverlap };
        }
        if (skipImages) body.skip_images = true;

        try {
            const res = await fetch(`${API}/api/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const raw = await res.text();
            let result: { error?: string } = {};
            try {
                result = raw ? (JSON.parse(raw) as { error?: string }) : {};
            } catch (parseErr) {
                logApiOffPath('POST /api/download', '响应不是合法 JSON，无法启动轮询', {
                    bookId: book.id,
                    status: res.status,
                    bodyPreview: previewText(raw),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                setProgress({ status: 'error', error: 'Invalid server response' });
                setDownloading(false);
                return;
            }
            if (!res.ok) {
                logApiOffPath('POST /api/download', 'HTTP 非 2xx，不启动进度轮询', {
                    bookId: book.id,
                    status: res.status,
                    serverError: result.error,
                    bodyPreview: previewText(raw),
                });
                setProgress({
                    status: 'error',
                    error: result.error || `HTTP ${res.status}`,
                });
                setDownloading(false);
                return;
            }
            if (result.error) {
                logApiOffPath('POST /api/download', '服务端返回 error，不启动轮询', {
                    bookId: book.id,
                    error: result.error,
                    bodyPreview: previewText(raw),
                });
                setProgress({ status: 'error', error: result.error });
                setDownloading(false);
                return;
            }
            setPolling(true);
        } catch (err) {
            logApiOffPath('POST /api/download', '请求或读 body 失败', {
                bookId: book.id,
                err: err instanceof Error ? err.name + ': ' + err.message : String(err),
            });
            logErrorDetail(`download POST failed (bookId=${book.id})`, err);
            setProgress({ status: 'error', error: 'Download failed' });
            setDownloading(false);
        }
    };

    const cancelDownload = async () => {
        try {
            const res = await fetch(`${API}/api/cancel`, { method: 'POST' });
            const raw = await res.text();
            if (!res.ok) {
                logApiOffPath('POST /api/cancel', 'HTTP 非 2xx，取消请求可能未生效', {
                    status: res.status,
                    bodyPreview: previewText(raw),
                });
            }
        } catch (err) {
            logApiOffPath('POST /api/cancel', '请求失败', {
                err: err instanceof Error ? err.name + ': ' + err.message : String(err),
            });
            logErrorDetail('cancel request failed', err);
        }
    };

    const authorsLine =
        book.authors.length > 0 ? book.authors.join(', ') : 'Unknown Author';
    const coverSrc = escapeHtml(book.cover_url || '');

    const fmtName = `format-${book.id}`;
    const chName = `chapters-scope-${book.id}`;
    const outName = `output-style-${book.id}`;

    return (
        <article
            ref={ref}
            data-book-id={book.id}
            className={`book-card group bg-white rounded-xl border overflow-hidden transition-all duration-200 ${
                expanded
                    ? 'expanded border-oreilly-blue shadow-card-expanded'
                    : 'border-zinc-200 hover:border-zinc-300 hover:shadow-card-hover'
            } relative`}
        >
            <button
                type="button"
                className="book-summary flex w-full items-center gap-4 p-4 cursor-pointer text-left"
                onClick={() => onExpand()}
            >
                <img
                    src={coverSrc || undefined}
                    alt=""
                    className="w-12 h-16 object-cover rounded shadow-sm flex-shrink-0"
                    loading="lazy"
                />
                <div className="flex-1 min-w-0">
                    <h3 className="text-[0.9375rem] font-semibold text-zinc-900 leading-snug truncate">
                        {book.title}
                    </h3>
                    <p className="text-sm text-zinc-500 truncate">{authorsLine}</p>
                </div>
                <svg
                    className="expand-icon w-5 h-5 text-zinc-400 flex-shrink-0 transition-transform duration-200"
                    style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <path d="M6 9l6 6 6-6" />
                </svg>
            </button>

            {expanded && (
                <div className="book-expanded relative border-t border-zinc-100 animate-fade-in">
                    <button
                        type="button"
                        className="close-btn absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center bg-zinc-100 hover:bg-zinc-200 rounded-full transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            onCollapse();
                        }}
                    >
                        <svg className="w-4 h-4 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>

                    <div className="relative px-5 pb-5 pt-2">
                        <div className="flex gap-5 py-5">
                            <img
                                className="w-24 h-32 object-cover rounded-lg shadow-md flex-shrink-0"
                                src={getHighResCoverUrl(book.id)}
                                alt=""
                            />
                            <div className="flex-1 min-w-0">
                                <h2 className="text-xl font-semibold text-zinc-900 leading-tight mb-1">{book.title}</h2>
                                <p className="text-[0.9375rem] text-zinc-500 mb-3">by {authorsLine}</p>
                                <p className="text-sm text-zinc-500 mb-0.5">
                                    <span className="text-zinc-400">Publisher:</span>{' '}
                                    <span className={detailLoading ? 'animate-pulse-subtle' : ''}>{publisher}</span>
                                </p>
                                <p className="text-sm text-zinc-500 mb-3">
                                    <span className="text-zinc-400">Pages:</span>{' '}
                                    <span className={detailLoading ? 'animate-pulse-subtle' : ''}>{pages}</span>
                                </p>
                                <div
                                    className="book-description text-sm text-zinc-600 leading-relaxed max-h-20 overflow-y-auto pr-2"
                                    dangerouslySetInnerHTML={{ __html: descriptionHtml }}
                                />
                            </div>
                        </div>

                        <div className="py-5 border-t border-zinc-100">
                            <div className="mb-5">
                                <h4 className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-3">
                                    <span className="inline-flex items-center justify-center w-[18px] h-[18px] bg-oreilly-blue text-white text-[0.625rem] font-bold rounded-full">
                                        1
                                    </span>
                                    Format
                                </h4>
                                <div className={`format-options flex flex-wrap gap-1.5 ${shakeFormat ? 'animate-shake' : ''}`}>
                                    {(
                                        [
                                            ['markdown', 'Markdown'],
                                            ['json', 'JSON'],
                                            ['plaintext', 'Plain Text'],
                                            ['pdf', 'PDF'],
                                            ['chunks', 'Chunks'],
                                            ['epub', 'EPUB'],
                                        ] as const
                                    ).map(([value, label]) => (
                                        <label key={value} className="cursor-pointer">
                                            <input
                                                type="radio"
                                                name={fmtName}
                                                value={value}
                                                checked={format === value}
                                                onChange={() => setFormat(value)}
                                                className="sr-only peer"
                                            />
                                            <span className="flex items-center gap-1.5 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light peer-checked:text-oreilly-blue-dark hover:bg-white hover:border-zinc-300">
                                                {label}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <h4 className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-3">
                                    <span className="inline-flex items-center justify-center w-[18px] h-[18px] bg-oreilly-blue text-white text-[0.625rem] font-bold rounded-full">
                                        2
                                    </span>
                                    Chapters
                                </h4>
                                <div className="grid grid-cols-2 gap-2">
                                    <label className="cursor-pointer">
                                        <input
                                            type="radio"
                                            name={chName}
                                            checked={chaptersScope === 'all'}
                                            onChange={() => setChaptersScope('all')}
                                            className="sr-only peer"
                                        />
                                        <span className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                            <span className="text-sm font-medium text-zinc-700">All Chapters</span>
                                        </span>
                                    </label>
                                    <label className="cursor-pointer">
                                        <input
                                            type="radio"
                                            name={chName}
                                            checked={chaptersScope === 'select'}
                                            onChange={() => setChaptersScope('select')}
                                            className="sr-only peer"
                                        />
                                        <span className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                            <span className="text-sm font-medium text-zinc-700">Select Chapters</span>
                                        </span>
                                    </label>
                                </div>
                            </div>

                            {chaptersScope === 'select' && (
                                <div
                                    className={`chapters-picker mt-4 p-4 bg-zinc-50 rounded-xl border border-zinc-200 ${shakeChapters ? 'animate-shake' : ''}`}
                                >
                                    <div className="flex items-center justify-between pb-3 border-b border-zinc-200 mb-3">
                                        <span className="text-sm font-medium text-zinc-600">{chapterSummary()}</span>
                                        <div className="flex gap-1">
                                            <button
                                                type="button"
                                                className="px-2 py-1 text-xs font-medium text-oreilly-blue hover:bg-oreilly-blue-light rounded"
                                                onClick={() => selectAllChapters(true)}
                                            >
                                                All
                                            </button>
                                            <button
                                                type="button"
                                                className="px-2 py-1 text-xs font-medium text-oreilly-blue hover:bg-oreilly-blue-light rounded"
                                                onClick={() => selectAllChapters(false)}
                                            >
                                                None
                                            </button>
                                        </div>
                                    </div>
                                    <div className="chapters-list max-h-52 overflow-y-auto space-y-0.5">
                                        {chaptersLoading && (
                                            <p className="text-sm text-zinc-400 py-2">Loading chapters...</p>
                                        )}
                                        {!chaptersLoading &&
                                            chapters?.map((ch) => (
                                                <label
                                                    key={ch.index}
                                                    className="chapter-item flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer hover:bg-zinc-100 transition-colors"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        className="w-4 h-4 rounded border-zinc-300 text-oreilly-blue"
                                                        checked={!!chapterChecked[ch.index]}
                                                        onChange={() => toggleChapter(ch.index)}
                                                    />
                                                    <span className="flex-1 text-sm text-zinc-700 truncate">
                                                        {ch.title || `Chapter ${ch.index + 1}`}
                                                    </span>
                                                    {ch.pages != null && (
                                                        <span className="text-xs text-zinc-400 flex-shrink-0">{ch.pages}p</span>
                                                    )}
                                                </label>
                                            ))}
                                    </div>
                                </div>
                            )}

                            <div className="output-selection mt-5">
                                <h4 className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-3">
                                    <span className="inline-flex items-center justify-center w-[18px] h-[18px] bg-oreilly-blue text-white text-[0.625rem] font-bold rounded-full">
                                        3
                                    </span>
                                    Output
                                </h4>
                                {!bookOnly ? (
                                    <div className="output-options grid grid-cols-2 gap-2">
                                        <label className="cursor-pointer">
                                            <input
                                                type="radio"
                                                name={outName}
                                                checked={outputStyle === 'combined'}
                                                onChange={() => setOutputStyle('combined')}
                                                className="sr-only peer"
                                            />
                                            <span className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                                <span className="text-sm font-medium text-zinc-700">Combined</span>
                                            </span>
                                        </label>
                                        <label className="cursor-pointer">
                                            <input
                                                type="radio"
                                                name={outName}
                                                checked={outputStyle === 'separate'}
                                                onChange={() => setOutputStyle('separate')}
                                                className="sr-only peer"
                                            />
                                            <span className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg transition-all peer-checked:border-oreilly-blue peer-checked:bg-oreilly-blue-light hover:bg-white hover:border-zinc-300">
                                                <span className="text-sm font-medium text-zinc-700">Separate</span>
                                            </span>
                                        </label>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 p-3 mt-2 bg-zinc-50 border border-dashed border-zinc-200 rounded-lg text-sm text-zinc-500">
                                        <span>Combined only for this format</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        <details
                            className="advanced-options border-t border-zinc-100 pt-4"
                            open={advOpen}
                            onToggle={(e) => setAdvOpen((e.target as HTMLDetailsElement).open)}
                        >
                            <summary className="flex items-center gap-1.5 text-sm font-medium text-zinc-500 cursor-pointer select-none py-1 hover:text-zinc-700">
                                <svg
                                    className="w-3.5 h-3.5 transition-transform duration-150"
                                    style={{ transform: advOpen ? 'rotate(90deg)' : undefined }}
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    <path d="M9 18l6-6-6-6" />
                                </svg>
                                Advanced Options
                            </summary>
                            <div className="pt-4 space-y-4">
                                <div>
                                    <label className="block text-[0.6875rem] font-semibold uppercase tracking-wide text-zinc-400 mb-2">
                                        Save Location
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={outputDir}
                                            className="flex-1 px-3 py-2 text-sm font-mono bg-zinc-50 border border-zinc-200 rounded-lg text-zinc-600 focus:outline-none focus:border-oreilly-blue focus:bg-white"
                                        />
                                        <button
                                            type="button"
                                            className="px-3 py-2 text-xs font-medium text-zinc-600 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50"
                                            onClick={() => void browseOutputDir()}
                                        >
                                            Browse
                                        </button>
                                    </div>
                                </div>
                                <label className="flex items-center gap-2 cursor-pointer flex-wrap">
                                    <input
                                        type="checkbox"
                                        className="w-4 h-4 rounded border-zinc-300"
                                        checked={skipImages}
                                        onChange={(e) => setSkipImages(e.target.checked)}
                                    />
                                    <span className="text-sm text-zinc-600">Skip images</span>
                                    <span className="text-xs text-zinc-400">Faster download, smaller files</span>
                                </label>
                                {format === 'chunks' && (
                                    <div className="flex gap-4 p-4 bg-zinc-50 rounded-lg">
                                        <div className="flex-1">
                                            <label className="block text-[0.6875rem] font-semibold uppercase text-zinc-400 mb-2">
                                                Chunk Size
                                            </label>
                                            <input
                                                type="number"
                                                value={chunkSize}
                                                onChange={(e) => setChunkSize(Number(e.target.value) || 4000)}
                                                className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg"
                                                min={500}
                                                max={16000}
                                            />
                                        </div>
                                        <div className="flex-1">
                                            <label className="block text-[0.6875rem] font-semibold uppercase text-zinc-400 mb-2">
                                                Overlap
                                            </label>
                                            <input
                                                type="number"
                                                value={chunkOverlap}
                                                onChange={(e) => setChunkOverlap(Number(e.target.value) || 200)}
                                                className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg"
                                                min={0}
                                                max={1000}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </details>

                        {(downloading || polling || progress?.status === 'error') && !showResults && (
                            <div className="progress-section py-5 border-t border-zinc-100">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-sm font-medium text-zinc-700">Downloading...</span>
                                    <span className="text-sm font-semibold text-oreilly-blue">
                                        {typeof progress?.percentage === 'number' ? `${progress.percentage}%` : '0%'}
                                    </span>
                                </div>
                                <div className="h-1.5 bg-zinc-200 rounded-full overflow-hidden">
                                    <div
                                        className="progress-fill h-full bg-oreilly-blue rounded-full transition-all duration-300"
                                        style={{ width: `${progress?.percentage ?? 0}%` }}
                                    />
                                </div>
                                <p className="progress-status mt-2 text-sm text-zinc-500">
                                    {(() => {
                                        if (progress?.status === 'error')
                                            return `Error: ${progress.error ?? 'Unknown'}`;
                                        const details: string[] = [];
                                        if (progress?.current_chapter && progress?.total_chapters) {
                                            details.push(
                                                `Chapter ${progress.current_chapter}/${progress.total_chapters}`,
                                            );
                                        }
                                        if (progress?.eta_seconds && progress.eta_seconds > 0) {
                                            details.push(`~${formatETA(progress.eta_seconds)} remaining`);
                                        }
                                        let status = progress?.chapter_title || progress?.status || 'waiting';
                                        if (progress?.chapter_title && progress.chapter_title.length > 40) {
                                            status = progress.chapter_title.slice(0, 40) + '...';
                                        }
                                        return details.length ? details.join(' • ') : status;
                                    })()}
                                </p>
                            </div>
                        )}

                        {showResults && progress?.status === 'completed' && (
                            <div className="result-section py-5 border-t border-zinc-100">
                                <div className="flex items-center gap-2 mb-4 text-emerald-600 font-medium">
                                    <span>Download Complete</span>
                                </div>
                                <div className="result-files space-y-2">
                                    {progress.epub && (
                                        <FileRow label="EPUB" path={progress.epub} onReveal={revealFile} />
                                    )}
                                    {progress.pdf &&
                                        (Array.isArray(progress.pdf) ? (
                                            <div className="flex items-center gap-3 px-4 py-3 bg-zinc-50 rounded-lg text-sm">
                                                <span className="font-medium text-zinc-700 min-w-[70px]">PDF</span>
                                                <span className="flex-1 font-mono text-xs text-zinc-500 truncate">
                                                    {progress.pdf.length} chapter files
                                                </span>
                                            </div>
                                        ) : (
                                            <FileRow label="PDF" path={progress.pdf} onReveal={revealFile} />
                                        ))}
                                    {progress.markdown && (
                                        <FileRow label="Markdown" path={progress.markdown} onReveal={revealFile} />
                                    )}
                                    {progress.plaintext && (
                                        <FileRow label="Plain Text" path={progress.plaintext} onReveal={revealFile} />
                                    )}
                                    {progress.json && <FileRow label="JSON" path={progress.json} onReveal={revealFile} />}
                                    {progress.chunks && (
                                        <FileRow label="Chunks" path={progress.chunks} onReveal={revealFile} />
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end gap-2 pt-5 border-t border-zinc-100">
                            {(downloading || polling) && (
                                <button
                                    type="button"
                                    className="px-5 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50"
                                    onClick={() => void cancelDownload()}
                                >
                                    Cancel
                                </button>
                            )}
                            <button
                                type="button"
                                disabled={downloading || polling}
                                className="px-6 py-2 text-sm font-medium text-white bg-oreilly-blue hover:bg-oreilly-blue-dark rounded-lg disabled:bg-zinc-300 disabled:cursor-not-allowed"
                                onClick={() => void startDownload()}
                            >
                                Download
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </article>
    );
});

function FileRow({
    label,
    path,
    onReveal,
}: {
    label: string;
    path: string;
    onReveal: (p: string) => void;
}) {
    return (
        <div className="flex items-center gap-3 px-4 py-3 bg-zinc-50 rounded-lg text-sm">
            <span className="font-medium text-zinc-700 min-w-[70px]">{label}</span>
            <span className="flex-1 font-mono text-xs text-zinc-500 truncate" title={path}>
                {path}
            </span>
            <button
                type="button"
                className="px-2 py-1 text-xs font-medium text-oreilly-blue hover:bg-oreilly-blue-light rounded"
                onClick={() => onReveal(path)}
            >
                Reveal
            </button>
        </div>
    );
}
