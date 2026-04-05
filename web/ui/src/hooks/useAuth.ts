import { useCallback, useEffect, useRef, useState } from 'react';
import { API, AUTH_STATUS_TIMEOUT_MS } from '../constants';
import { dbg, dbgVerbose, logApiOffPath, logError, logErrorDetail, previewText, reasonToLabel } from '../utils';
import type { AuthStatus } from '../types';

type AuthUi = {
    phase: 'checking' | 'ready';
    valid: boolean;
    label: string;
};

/**
 * Session check with per-hook generation + abort.
 * Avoids module-level seq (StrictMode double-mount / HMR) leaving the UI stuck on "Checking...".
 */
export function useAuth() {
    const [auth, setAuth] = useState<AuthUi>({
        phase: 'checking',
        valid: false,
        label: 'Checking...',
    });
    const genRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const timeoutRef = useRef<number | null>(null);

    const checkAuth = useCallback(async () => {
        abortRef.current?.abort();
        if (timeoutRef.current != null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        const ac = new AbortController();
        abortRef.current = ac;
        const myGen = ++genRef.current;

        setAuth({ phase: 'checking', valid: false, label: 'Checking...' });

        timeoutRef.current = window.setTimeout(() => {
            ac.abort();
        }, AUTH_STATUS_TIMEOUT_MS);

        try {
            dbg('checkAuth: start', { myGen, url: `${API}/api/status` });
            const res = await fetch(`${API}/api/status`, { signal: ac.signal });
            const rawText = await res.text();
            if (!res.ok) {
                logApiOffPath('GET /api/status', 'HTTP 状态不是 2xx，不当作会话有效', {
                    status: res.status,
                    statusText: res.statusText,
                    bodyPreview: previewText(rawText),
                });
            }
            let data: AuthStatus = {};
            try {
                data = rawText ? (JSON.parse(rawText) as AuthStatus) : {};
            } catch (parseErr) {
                logApiOffPath('GET /api/status', '响应体不是合法 JSON，无法解析 valid', {
                    myGen,
                    genRefCurrent: genRef.current,
                    bodyPreview: previewText(rawText),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                logErrorDetail('checkAuth: JSON.parse failed', parseErr);
                throw parseErr;
            }

            if (myGen !== genRef.current) {
                logApiOffPath('GET /api/status', '已有更新的 checkAuth，本次结果丢弃（stale）', {
                    myGen,
                    genRefCurrent: genRef.current,
                    parsedValid: data.valid,
                    reason: data.reason,
                });
                dbg('checkAuth: stale response ignored', { myGen, current: genRef.current });
                return;
            }

            const v = data.valid as unknown;
            const valid =
                !!data && (data.valid === true || v === 'true' || v === 1);

            if (valid) {
                if (!res.ok) {
                    logApiOffPath('GET /api/status', 'JSON 里 valid=true 但 HTTP 仍非 2xx，仍以 valid 展示', {
                        status: res.status,
                        bodyPreview: previewText(rawText),
                    });
                }
                setAuth({ phase: 'ready', valid: true, label: 'Session Valid' });
            } else {
                logApiOffPath('GET /api/status', '未判定为已登录（valid 不为 true）', {
                    resOk: res.ok,
                    status: res.status,
                    validField: data.valid,
                    validCoerced: v,
                    reason: data.reason,
                    bodyPreview: previewText(rawText),
                });
                setAuth({
                    phase: 'ready',
                    valid: false,
                    label: reasonToLabel(data.reason ?? undefined),
                });
            }
        } catch (err) {
            if (myGen !== genRef.current) {
                logApiOffPath('GET /api/status', '出错时已有更新的 checkAuth，忽略本次错误（stale catch）', {
                    myGen,
                    genRefCurrent: genRef.current,
                    err: err instanceof Error ? err.name + ': ' + err.message : String(err),
                });
                return;
            }
            if (err instanceof Error && err.name === 'AbortError') {
                logApiOffPath('GET /api/status', '请求被中止或超时，不更新为已登录', {
                    timeoutMs: AUTH_STATUS_TIMEOUT_MS,
                    myGen,
                });
                logError('checkAuth: aborted or timed out', AUTH_STATUS_TIMEOUT_MS, 'ms');
                setAuth({
                    phase: 'ready',
                    valid: false,
                    label: reasonToLabel('status_timeout'),
                });
            } else {
                logApiOffPath('GET /api/status', '网络或其它异常，无法完成状态检查', {
                    err: err instanceof Error ? err.name + ': ' + err.message : String(err),
                    myGen,
                });
                logErrorDetail('checkAuth failed', err);
                setAuth({ phase: 'ready', valid: false, label: 'Status check failed' });
            }
        } finally {
            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        }
    }, []);

    useEffect(() => {
        void checkAuth();
        return () => {
            genRef.current += 1;
            dbgVerbose('useAuth cleanup: genRef bumped', genRef.current);
            abortRef.current?.abort();
            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, [checkAuth]);

    return { auth, checkAuth };
}
