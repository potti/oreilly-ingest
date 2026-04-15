import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../constants';

type Props = {
    bookName: string;
    outputDir: string;
    onClose: () => void;
};

export function ImageDrawer({ bookName, outputDir, onClose }: Props) {
    const [images, setImages] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
    const drawerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const ac = new AbortController();
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const q = new URLSearchParams({ book_name: bookName });
                const trimmed = outputDir.trim();
                if (trimmed) q.set('output_dir', trimmed);
                const res = await fetch(`${API}/api/knowledge/images?${q}`, { signal: ac.signal });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
                }
                const data = (await res.json()) as { images: string[] };
                if (!ac.signal.aborted) setImages(data.images ?? []);
            } catch (e) {
                if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!ac.signal.aborted) setLoading(false);
            }
        }
        void load();
        return () => ac.abort();
    }, [bookName, outputDir]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (lightboxIdx !== null) {
                if (e.key === 'Escape') { setLightboxIdx(null); e.preventDefault(); }
                else if (e.key === 'ArrowRight') setLightboxIdx((i) => Math.min((i ?? 0) + 1, images.length - 1));
                else if (e.key === 'ArrowLeft') setLightboxIdx((i) => Math.max((i ?? 0) - 1, 0));
                return;
            }
            if (e.key === 'Escape') { onClose(); e.preventDefault(); }
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [lightboxIdx, images.length, onClose]);

    const imgUrl = useCallback(
        (filename: string) => {
            const q = new URLSearchParams({ book_name: bookName, filename });
            const trimmed = outputDir.trim();
            if (trimmed) q.set('output_dir', trimmed);
            return `${API}/api/knowledge/image?${q}`;
        },
        [bookName, outputDir],
    );

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
                            {loading ? '加载中…' : `${images.length} 张介绍图片`}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-3 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

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
                                <button
                                    key={filename}
                                    type="button"
                                    onClick={() => setLightboxIdx(idx)}
                                    className="group relative rounded-lg overflow-hidden border border-zinc-200 hover:border-zinc-400 hover:shadow-md transition-all bg-zinc-50"
                                >
                                    <img
                                        src={imgUrl(filename)}
                                        alt={filename}
                                        loading="lazy"
                                        className="w-full h-auto object-contain"
                                    />
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
                                </button>
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
