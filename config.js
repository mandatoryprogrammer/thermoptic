// These headers are automatically set by the browser and as a result
// need to be cleaned out before key checks to understand if a request
// is a CORS "simple" request.
// TODO: This needs to be comprehensive, do a final pass before releasing to
// make sure that every possible header is covered.
export const ALWAYS_CLEAN_HEADERS = [
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'connection',
    'content-length',
    // Content-Type is special as only SOME
    // values are allowed in CORS simple requests
    // 'content-type',
    'x-client-data',
    'attribution-reporting-eligible',
    'attribution-reporting-support',
    'cookie',
    'host',
    'origin',
    'priority',
    'pragma',
    'referer',
    'sec-ch-ua',
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list',
    'sec-ch-ua-mobile',
    'sec-ch-ua-model',
    'sec-ch-ua-platform',
    'sec-ch-ua-platform-version',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'sec-fetch-storage-access',
    'te',
    'upgrade-insecure-requests',
    'user-agent',
    'proxy-authorization',
    'proxy-connection',
];

export const ERROR_HEADER_NAME = 'X-Proxy-Error';

// export const PROXY_REQUEST_TIMEOUT = (1000 * 60 * 3);
export const PROXY_REQUEST_TIMEOUT = (1000 * 30);

const DEFAULT_TAB_MAX_LIFETIME_MS = (1000 * 60 * 2);
const DEFAULT_TAB_SWEEP_INTERVAL_MS = (1000 * 10);

function parse_env_milliseconds(env_value, default_value) {
    if (!env_value) {
        return default_value;
    }

    const parsed_value = parseInt(env_value, 10);
    if (Number.isNaN(parsed_value) || parsed_value <= 0) {
        return default_value;
    }

    return parsed_value;
}

const resolved_tab_max_lifetime_ms = parse_env_milliseconds(
    process.env.TAB_MAX_LIFETIME_MS,
    DEFAULT_TAB_MAX_LIFETIME_MS
);

const TAB_LIFETIME_SAFETY_BUFFER_MS = 2000;

export const TAB_MAX_LIFETIME_MS = Math.max(
    resolved_tab_max_lifetime_ms,
    PROXY_REQUEST_TIMEOUT + TAB_LIFETIME_SAFETY_BUFFER_MS
);

export const TAB_SWEEP_INTERVAL_MS = parse_env_milliseconds(
    process.env.TAB_SWEEP_INTERVAL_MS,
    DEFAULT_TAB_SWEEP_INTERVAL_MS
);
