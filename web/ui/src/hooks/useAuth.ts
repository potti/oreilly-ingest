import { useCallback, useEffect, useRef, useState } from 'react';
import { API, AUTH_STATUS_TIMEOUT_MS } from '../constants';
import { dbg, dbgVerbose, logApiOffPath, logError, logErrorDetail, previewText, reasonToLabel } from '../utils';
import type { AuthStatus } from '../types';

/** Passed to AbortController.abort(reason)，便于区分「被新一轮 checkAuth 顶替」和「定时超时」 */
const AUTH_ABORT_REPLACED = 'auth_replaced';
const AUTH_ABORT_STATUS_TIMEOUT = 'auth_status_timeout';

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
        try {
            abortRef.current?.abort(AUTH_ABORT_REPLACED);
        } catch {
            /* ignore */
        }
        if (timeoutRef.current != null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        const ac = new AbortController();
        abortRef.current = ac;
        const myGen = ++genRef.current;

        setAuth({ phase: 'checking', valid: false, label: 'Checking...' });

        timeoutRef.current = window.setTimeout(() => {
            ac.abort(AUTH_ABORT_STATUS_TIMEOUT);
        }, AUTH_STATUS_TIMEOUT_MS);

        try {
            dbg('checkAuth: start', { myGen, url: `${API}/api/status` });
            const res = await fetch(`${API}/api/status`, { signal: ac.signal });
            dbg('checkAuth: fetch resolved', {
                myGen,
                status: res.status,
                ok: res.ok,
                note: '若只有 start 没有本行，说明 fetch 未完成或被 abort',
            });
            const rawText = await res.text();
            dbg('checkAuth: body received', {
                myGen,
                length: rawText.length,
                preview: previewText(rawText, 160),
                note: '若有 fetch resolved 无本行，说明卡在读取 body；若有本行无 response，多为 JSON.parse 失败',
            });
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
                dbg('checkAuth: parse failed (不会打印 checkAuth: response)', {
                    myGen,
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                    bodyPreview: previewText(rawText),
                });
                logApiOffPath('GET /api/status', '响应体不是合法 JSON，无法解析 valid', {
                    myGen,
                    genRefCurrent: genRef.current,
                    bodyPreview: previewText(rawText),
                    parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                logErrorDetail('checkAuth: JSON.parse failed', parseErr);
                throw parseErr;
            }

            dbg('checkAuth: response', {
                myGen,
                genRefCurrent: genRef.current,
                httpStatus: res.status,
                resOk: res.ok,
                parsed: data,
                bodyPreview: previewText(rawText),
            });

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
            dbg('checkAuth: catch', {
                myGen,
                genRefCurrent: genRef.current,
                errName: err instanceof Error ? err.name : typeof err,
                errMessage: err instanceof Error ? err.message : String(err),
                note: '进入 catch 时不会执行 checkAuth: response（解析成功后的日志）',
            });
            if (myGen !== genRef.current) {
                const abortReason =
                    typeof ac.signal.reason === 'string' ? ac.signal.reason : String(ac.signal.reason ?? '');
                logApiOffPath('GET /api/status', '出错时已有更新的 checkAuth，忽略本次错误（stale catch）', {
                    myGen,
                    genRefCurrent: genRef.current,
                    abortReason: abortReason || undefined,
                    err: err instanceof Error ? err.name + ': ' + err.message : String(err),
                });
                return;
            }
            if (err instanceof Error && err.name === 'AbortError') {
                const reason = ac.signal.reason;
                if (reason === AUTH_ABORT_STATUS_TIMEOUT) {
                    logApiOffPath('GET /api/status', `在 ${AUTH_STATUS_TIMEOUT_MS}ms 内未收到完整响应，判定为状态检查超时`, {
                        timeoutMs: AUTH_STATUS_TIMEOUT_MS,
                        myGen,
                        hint: '请确认服务端 /api/status 可访问、未被长时间阻塞，或适当增大 AUTH_STATUS_TIMEOUT_MS',
                    });
                } else {
                    logApiOffPath('GET /api/status', '请求被 AbortSignal 中止（非定时器超时），不更新为已登录', {
                        timeoutMs: AUTH_STATUS_TIMEOUT_MS,
                        myGen,
                        abortReason: reason,
                        hint:
                            reason === AUTH_ABORT_REPLACED
                                ? '若紧接着有新的 checkAuth，多为上一轮被顶替；否则为浏览器或扩展中止了请求'
                                : '可能是网络中断、页面隐藏策略或浏览器未把 abort(reason) 传入 signal.reason',
                    });
                }
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
        /** 推迟到下一 macrotask，避免 React StrictMode「effect → cleanup → effect」同步链里第一次 checkAuth 刚发出就被 abort。 */
        const scheduleId = window.setTimeout(() => {
            void checkAuth();
        }, 0);
        return () => {
            window.clearTimeout(scheduleId);
            genRef.current += 1;
            dbgVerbose('useAuth cleanup: genRef bumped', genRef.current);
            try {
                abortRef.current?.abort(AUTH_ABORT_REPLACED);
            } catch {
                /* ignore */
            }
            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, [checkAuth]);

    return { auth, checkAuth };
}
