import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../constants';

type Props = {
    bookName: string;
    outputDir: string;
    onClose: () => void;
    onImagesChanged?: () => void;
};

export function ImageDrawer({ bookName, outputDir, onClose, onImagesChanged }: Props) {
    const [images, setImages] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [selectMode, setSelectMode] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const drawerRef = useRef<HTMLDivElement>(null);

    const fetchImages = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        setError(null);
        try {
            const q = new URLSearchParams({ book_name: bookName });
            const trimmed = outputDir.trim();
            if (trimmed) q.set('output_dir', trimmed);
            const res = await fetch(`${API}/api/knowledge/images?${q}`, { signal });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
            }
            const data = (await res.json()) as { images: string[] };
            if (!signal?.aborted) setImages(data.images ?? []);
        } catch (e) {
            if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, [bookName, outputDir]);

    useEffect(() => {
        const ac = new AbortController();
        void fetchImages(ac.signal);
        return () => ac.abort();
    }, [fetchImages]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (lightboxIdx !== null) {
                if (e.key === 'Escape') { setLightboxIdx(null); e.preventDefault(); }
                else if (e.key === 'ArrowRight') setLightboxIdx((i) => Math.min((i ?? 0) + 1, images.length - 1));
                else if (e.key === 'ArrowLeft') setLightboxIdx((i) => Math.max((i ?? 0) - 1, 0));
                return;
            }
            if (e.key === 'Escape') {
                if (selectMode) { setSelectMode(false); setSelected(new Set()); }
                else onClose();
                e.preventDefault();
            }
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [lightboxIdx, images.length, onClose, selectMode]);

    const imgUrl = useCallback(
        (filename: string) => {
            const q = new URLSearchParams({ book_name: bookName, filename });
            const trimmed = outputDir.trim();
            if (trimmed) q.set('output_dir', trimmed);
            return `${API}/api/knowledge/image?${q}`;
        },
        [bookName, outputDir],
    );

    const toggleSelect = useCallback((filename: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(filename)) next.delete(filename);
            else next.add(filename);
            return next;
        });
    }, []);

    const toggleSelectAll = useCallback(() => {
        setSelected((prev) => {
            if (prev.size === images.length) return new Set();
            return new Set(images);
        });
    }, [images]);

    const exitSelectMode = useCallback(() => {
        setSelectMode(false);
        setSelected(new Set());
    }, []);

    const deleteSelected = useCallback(async () => {
        if (selected.size === 0) return;
        const count = selected.size;
        if (!window.confirm(`确定删除选中的 ${count} 张图片？此操作不可恢复。`)) return;

        setDeleting(true);
        try {
            const body: { book_name: string; filenames: string[]; output_dir?: string } = {
                book_name: bookName,
                filenames: Array.from(selected),
            };
            const trimmed = outputDir.trim();
            if (trimmed) body.output_dir = trimmed;

            const res = await fetch(`${API}/api/knowledge/images/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
            }

            const result = (await res.json()) as { deleted: string[]; remaining_count: number };
            setImages((prev) => prev.filter((f) => !result.deleted.includes(f)));
            setSelected(new Set());
            setSelectMode(false);
            onImagesChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setDeleting(false);
        }
    }, [selected, bookName, outputDir, onImagesChanged]);

    const deleteSingle = useCallback(async (filename: string) => {
        if (!window.confirm(`确定删除 "${filename}"？此操作不可恢复。`)) return;

        try {
            const body: { book_name: string; filenames: string[]; output_dir?: string } = {
                book_name: bookName,
                filenames: [filename],
            };
            const trimmed = outputDir.trim();
            if (trimmed) body.output_dir = trimmed;

            const res = await fetch(`${API}/api/knowledge/images/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
            }

            const result = (await res.json()) as { deleted: string[] };
            if (result.deleted.includes(filename)) {
                setImages((prev) => prev.filter((f) => f !== filename));
                onImagesChanged?.();
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [bookName, outputDir, onImagesChanged]);

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-40 bg-zinc-900/50 backdrop-blur-sm transition-opacity duration-200"
                onClick={onClose}
            />

            {/* Drawer */}
            <div
                ref={drawerRef}
                className="fixed top-0 right-0 z-50 h-full w-full max-w-md bg-white shadow-2xl flex flex-col animate-slide-in-right"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 shrink-0">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold text-zinc-900 truncate" title={bookName}>
                            {bookName}
                        </h3>
                        <p className="text-xs text-zinc-500 mt-0.5">
                            {loading ? '加载中…' : selectMode ? `已选 ${selected.size} / ${images.length}` : `${images.length} 张介绍图片`}
                        </p>
                    </div>
                    <div className="flex items-center gap-1.5 ml-3">
                        {!loading && images.length > 0 && !selectMode && (
                            <button
                                type="button"
                                onClick={() => setSelectMode(true)}
                                className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                title="管理图片"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </button>
                        )}
                        {selectMode && (
                            <button
                                type="button"
                                onClick={exitSelectMode}
                                className="px-2.5 py-1 text-xs font-medium text-zinc-600 border border-zinc-200 rounded-lg hover:bg-zinc-50 transition-colors"
                            >
                                取消
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Select mode toolbar */}
                {selectMode && images.length > 0 && (
                    <div className="flex items-center justify-between px-5 py-2.5 border-b border-zinc-100 bg-zinc-50/80 shrink-0">
                        <button
                            type="button"
                            onClick={toggleSelectAll}
                            className="text-xs font-medium text-oreilly-blue hover:underline"
                        >
                            {selected.size === images.length ? '取消全选' : '全选'}
                        </button>
                        <button
                            type="button"
                            disabled={selected.size === 0 || deleting}
                            onClick={() => void deleteSelected()}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center gap-1.5"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            {deleting ? '删除中…' : `删除 (${selected.size})`}
                        </button>
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-4 py-4">
                    {loading && (
                        <div className="grid grid-cols-2 gap-3">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} className="aspect-[3/4] rounded-lg bg-zinc-100 animate-pulse" />
                            ))}
                        </div>
                    )}

                    {!loading && error && (
                        <p className="text-sm text-red-600 py-8 text-center">{error}</p>
                    )}

                    {!loading && !error && images.length === 0 && (
                        <p className="text-sm text-zinc-500 py-12 text-center">暂无介绍图片</p>
                    )}

                    {!loading && !error && images.length > 0 && (
                        <div className="grid grid-cols-2 gap-3">
                            {images.map((filename, idx) => (
                                <div key={filename} className="relative group">
                                    {selectMode && (
                                        <button
                                            type="button"
                                            onClick={() => toggleSelect(filename)}
                                            className="absolute top-2 left-2 z-10"
                                        >
                                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                                                selected.has(filename)
                                                    ? 'bg-oreilly-blue border-oreilly-blue'
                                                    : 'bg-white/80 border-zinc-300 hover:border-oreilly-blue'
                                            }`}>
                                                {selected.has(filename) && (
                                                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                                                    </svg>
                                                )}
                                            </div>
                                        </button>
                                    )}

                                    {!selectMode && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); void deleteSingle(filename); }}
                                            className="absolute top-2 right-2 z-10 p-1 rounded-md bg-black/40 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-red-600 hover:text-white transition-all"
                                            title="删除"
                                        >
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        onClick={() => selectMode ? toggleSelect(filename) : setLightboxIdx(idx)}
                                        className={`w-full rounded-lg overflow-hidden border transition-all bg-zinc-50 ${
                                            selectMode && selected.has(filename)
                                                ? 'border-oreilly-blue ring-2 ring-oreilly-blue/30'
                                                : 'border-zinc-200 hover:border-zinc-400 hover:shadow-md'
                                        }`}
                                    >
                                        <img
                                            src={imgUrl(filename)}
                                            alt={filename}
                                            loading="lazy"
                                            className="w-full h-auto object-contain"
                                        />
                                        {!selectMode && (
                                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                                                <svg
                                                    className="w-6 h-6 text-white opacity-0 group-hover:opacity-80 transition-opacity drop-shadow"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24"
                                                >
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                                                </svg>
                                            </div>
                                        )}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Lightbox */}
            {lightboxIdx !== null && images[lightboxIdx] && (
                <div
                    className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
                    onClick={() => setLightboxIdx(null)}
                >
                    <button
                        type="button"
                        className="absolute top-4 right-4 p-2 text-white/70 hover:text-white transition-colors"
                        onClick={(e) => { e.stopPropagation(); setLightboxIdx(null); }}
                    >
                        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    {lightboxIdx > 0 && (
                        <button
                            type="button"
                            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-white/70 hover:text-white transition-colors"
                            onClick={(e) => { e.stopPropagation(); setLightboxIdx((i) => Math.max((i ?? 0) - 1, 0)); }}
                        >
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                    )}

                    {lightboxIdx < images.length - 1 && (
                        <button
                            type="button"
                            className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-white/70 hover:text-white transition-colors"
                            onClick={(e) => { e.stopPropagation(); setLightboxIdx((i) => Math.min((i ?? 0) + 1, images.length - 1)); }}
                        >
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                            </svg>
                        </button>
                    )}

                    <img
                        src={imgUrl(images[lightboxIdx])}
                        alt={images[lightboxIdx]}
                        className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    />

                    <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-sm">
                        {lightboxIdx + 1} / {images.length}
                    </p>
                </div>
            )}
        </>
    );
}
