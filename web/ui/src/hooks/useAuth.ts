import { useCallback, useEffect, useRef, useState } from 'react';
import { API, AUTH_STATUS_TIMEOUT_MS } from '../constants';
import { dbg, logError, logErrorDetail, reasonToLabel } from '../utils';
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
            let data: AuthStatus = {};
            try {
                data = rawText ? (JSON.parse(rawText) as AuthStatus) : {};
            } catch (parseErr) {
                logErrorDetail('checkAuth: JSON.parse failed', parseErr);
                throw parseErr;
            }

            if (myGen !== genRef.current) {
                dbg('checkAuth: stale response ignored', { myGen, current: genRef.current });
                return;
            }

            const v = data.valid as unknown;
            const valid =
                !!data && (data.valid === true || v === 'true' || v === 1);

            if (valid) {
                setAuth({ phase: 'ready', valid: true, label: 'Session Valid' });
            } else {
                setAuth({
                    phase: 'ready',
                    valid: false,
                    label: reasonToLabel(data.reason ?? undefined),
                });
            }
        } catch (err) {
            if (myGen !== genRef.current) return;
            if (err instanceof Error && err.name === 'AbortError') {
                logError('checkAuth: aborted or timed out', AUTH_STATUS_TIMEOUT_MS, 'ms');
                setAuth({
                    phase: 'ready',
                    valid: false,
                    label: reasonToLabel('status_timeout'),
                });
            } else {
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
            abortRef.current?.abort();
            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, [checkAuth]);

    return { auth, checkAuth };
}
