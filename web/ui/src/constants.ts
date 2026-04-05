export const API = '';

export const COOKIE_CONSOLE_CMD =
    "JSON.stringify(document.cookie.split(';').map(c=>c.split('=')).reduce((r,[k,v])=>({...r,[k.trim()]:v?.trim()}),{}))";

export const BOOK_ONLY_FORMATS = ['epub', 'chunks'] as const;

export const AUTH_STATUS_TIMEOUT_MS = 45_000;
export const SEARCH_TIMEOUT_MS = 120_000;
