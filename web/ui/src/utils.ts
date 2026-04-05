import type { BookHit } from './types';

export function escapeHtml(text: unknown): string {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function getHighResCoverUrl(bookId: string): string {
    return `https://learning.oreilly.com/covers/urn:orm:book:${bookId}/400w/`;
}

export function reasonToLabel(reason: string | undefined): string {
    if (reason === 'not_authenticated') return 'Not signed in';
    if (reason === 'subscription_expired') return 'Subscription expired';
    if (reason === 'status_timeout') return 'Status check timed out';
    return reason || 'Invalid session';
}

export function normalizeSearchHit(raw: unknown): BookHit | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const idRaw =
        r.id != null && r.id !== '' ? r.id : r.archive_id != null && r.archive_id !== '' ? r.archive_id : null;
    const id = idRaw != null && idRaw !== '' ? String(idRaw) : '';
    if (!id) return null;

    let authors = r.authors;
    if (!Array.isArray(authors)) {
        authors =
            authors == null || authors === ''
                ? []
                : typeof authors === 'string'
                  ? [authors]
                  : [];
    }
    const authorList = (authors as unknown[]).map((a) => (a == null ? '' : String(a))).filter(Boolean);

    return {
        id,
        title: r.title != null ? String(r.title) : 'Untitled',
        authors: authorList,
        cover_url: r.cover_url != null ? String(r.cover_url) : '',
        publishers: Array.isArray(r.publishers) ? (r.publishers as string[]) : [],
    };
}

export function formatETA(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
}

export function oreillyDebugEnabled(): boolean {
    try {
        return localStorage.getItem('oreillyDebug') !== '0';
    } catch {
        return true;
    }
}

export function dbg(...args: unknown[]) {
    console.log('[oreilly-ingest]', ...args);
}

export function dbgVerbose(...args: unknown[]) {
    if (oreillyDebugEnabled()) console.log('[oreilly-ingest]', ...args);
}

export function logError(...args: unknown[]) {
    console.error('[oreilly-ingest]', ...args);
}

export function logErrorDetail(context: string, err: unknown) {
    logError(context, err);
    if (err && typeof err === 'object' && 'stack' in err && typeof (err as Error).stack === 'string') {
        console.error((err as Error).stack);
    }
}

/** Shorten long strings for console (e.g. response bodies). */
export function previewText(s: string, max = 240): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 请求已返回（或失败）后，未走「成功主路径」时打印原因与关键参数（调试）。
 */
export function logApiOffPath(endpoint: string, whyZh: string, details?: Record<string, unknown>): void {
    if (details && Object.keys(details).length > 0) {
        console.warn(`[API 非主路径] ${endpoint} — ${whyZh}`, details);
    } else {
        console.warn(`[API 非主路径] ${endpoint} — ${whyZh}`);
    }
}
