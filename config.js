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