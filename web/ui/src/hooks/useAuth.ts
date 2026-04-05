import { useCallback, useEffect, useState } from 'react';
import { API, AUTH_STATUS_TIMEOUT_MS } from '../constants';
import { dbg, logError, logErrorDetail, reasonToLabel } from '../utils';
import type { AuthStatus } from '../types';

type AuthUi = {
    phase: 'checking' | 'ready';
    valid: boolean;
    label: string;
};

let authCheckSeq = 0;

export function useAuth() {
    const [auth, setAuth] = useState<AuthUi>({
        phase: 'checking',
        valid: false,
        label: 'Checking...',
    });
    const checkAuth = useCallback(async () => {
        const seq = ++authCheckSeq;
        setAuth((a) => ({ ...a, phase: 'checking', label: 'Checking...' }));

        const ac = new AbortController();
        const timeoutId = window.setTimeout(() => ac.abort(), AUTH_STATUS_TIMEOUT_MS);

        try {
            dbg('checkAuth: start', { seq, url: `${API}/api/status` });
            const res = await fetch(`${API}/api/status`, { signal: ac.signal });
            const rawText = await res.text();
            let data: AuthStatus = {};
            try {
                data = rawText ? (JSON.parse(rawText) as AuthStatus) : {};
            } catch (parseErr) {
                logErrorDetail('checkAuth: JSON.parse failed', parseErr);
                throw parseErr;
            }

            if (seq !== authCheckSeq) {
                dbg('checkAuth: stale ignored', { seq, authCheckSeq });
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
            if (seq !== authCheckSeq) return;
            if (err instanceof Error && err.name === 'AbortError') {
                logError('checkAuth: timed out after', AUTH_STATUS_TIMEOUT_MS, 'ms');
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
            window.clearTimeout(timeoutId);
        }
    }, []);

    useEffect(() => {
        void checkAuth();
    }, [checkAuth]);

    return { auth, checkAuth };
}
