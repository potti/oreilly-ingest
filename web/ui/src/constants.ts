export const API = '';

export const COOKIE_CONSOLE_CMD =
    "JSON.stringify(document.cookie.split(';').map(c=>c.split('=')).reduce((r,[k,v])=>({...r,[k.trim()]:v?.trim()}),{}))";

export const BOOK_ONLY_FORMATS = ['epub', 'chunks'] as const;

/** 应大于服务端拉取 O’Reilly profile 的超时（config.REQUEST_TIMEOUT），并留出 RTT 余量 */
export const AUTH_STATUS_TIMEOUT_MS = 60_000;
/** 头已返回后，读取 response body 的上限；卡住多为扩展/代理拖住 body 流 */
export const AUTH_STATUS_BODY_READ_MS = 25_000;
export const SEARCH_TIMEOUT_MS = 120_000;
