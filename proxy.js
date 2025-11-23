import * as node_crypto from 'crypto';
import { STATUS_CODES } from 'node:http';
import * as cdp from './cdp.js';
import * as utils from './utils.js';
import * as logger from './logger.js';
import { CA_CERTIFICATE_PATH, CA_PRIVATE_KEY_PATH, ensure_ca_material } from './certificates.js';
const CONNECTION_STATE_TTL_MS = 15 * 60 * 1000;
const FILTERED_RESPONSE_HEADER_NAMES = new Set(['content-encoding']);
const HTTP2_INCOMPATIBLE_RESPONSE_HEADER_NAMES = new Set([
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade'
]);
const PROXY_AUTHENTICATION_ENABLED = Boolean(process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD);
const TRACE_ENABLED = is_env_flag_enabled(process.env.TRACE);

const connection_states = new Map();
let mockttp_module = null;

seed_global_crypto();

function sanitize_proxy_response_headers(headers, options = {}) {
    if (!headers || typeof headers !== 'object') {
        return {};
    }

    const sanitized_headers = {};
    const strip_http2_incompatible_headers = Boolean(options.strip_http2_incompatible_headers);

    const append_header = (header_name, header_value) => {
        if (!header_name || typeof header_name !== 'string') {
            return;
        }
        const normalized_name = header_name.toLowerCase();
        if (normalized_name.startsWith(':')) {
            return;
        }
        if (should_filter_response_header(normalized_name, strip_http2_incompatible_headers)) {
            return;
        }
        sanitized_headers[header_name] = header_value;
    };

    if (headers instanceof Map) {
        headers.forEach((value, name) => append_header(name, value));
        return sanitized_headers;
    }

    if (Array.isArray(headers)) {
        headers.forEach((entry) => {
            if (entry && typeof entry.name === 'string') {
                append_header(entry.name, entry.value);
                return;
            }
            if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string') {
                append_header(entry[0], entry[1]);
            }
        });
        return sanitized_headers;
    }

    Object.entries(headers).forEach(([name, value]) => append_header(name, value));
    return sanitized_headers;
}

function should_filter_response_header(header_name, strip_http2_incompatible_headers) {
    if (FILTERED_RESPONSE_HEADER_NAMES.has(header_name)) {
        return true;
    }
    if (strip_http2_incompatible_headers && HTTP2_INCOMPATIBLE_RESPONSE_HEADER_NAMES.has(header_name)) {
        return true;
    }
    return false;
}

export async function get_http_proxy(port, ready_func, error_func, on_request_func) {
    const proxy_logger = logger.get_logger();

    const { getLocal: get_mockttp_local, generateCACertificate } = await load_mockttp();

    await ensure_ca_material(proxy_logger, generateCACertificate);
    await run_on_start_hook_if_configured(proxy_logger);

    const mockttp_server = get_mockttp_local({
        http2: true,
        https: {
            keyPath: CA_PRIVATE_KEY_PATH,
            certPath: CA_CERTIFICATE_PATH
        },
        debug: logger.is_debug_enabled()
    });

    await mockttp_server
        .forAnyRequest()
        .always()
        .waitForRequestBody()
        .thenCallback(async(mockttp_request) => {
            purge_expired_connection_states();
            const is_http2_downstream = is_http2_request(mockttp_request);
            const http_version = resolve_http_version(mockttp_request.httpVersion);
            const adapted_request = await adapt_request_for_handler(mockttp_request);
            try {
                const handler_result = await on_request_func(adapted_request);
                if (!handler_result || !handler_result.response) {
                    proxy_logger.error('Proxy request handler returned an invalid response payload.', {
                        request_id: adapted_request.request_id,
                        url: adapted_request.url || adapted_request.requestOptions?.path
                    });
                    return {
                        statusCode: 502,
                        headers: {
                            'Content-Type': 'text/plain'
                        },
                        body: 'Proxy handler failed to supply a response.'
                    };
                }

                const response = handler_result.response;
                const sanitized_headers = sanitize_proxy_response_headers(response.header ?? {}, {
                    strip_http2_incompatible_headers: is_http2_downstream
                });
                const response_payload = {
                    statusCode: response.statusCode ?? 500,
                    statusMessage: response.statusMessage,
                    headers: sanitized_headers,
                    body: response.body
                };
                if (TRACE_ENABLED) {
                    log_raw_proxy_request(adapted_request, http_version);
                    log_raw_proxy_response(adapted_request, response, sanitized_headers, http_version);
                }
                return response_payload;
            } catch (handler_error) {
                const normalized_error = handler_error instanceof Error ? handler_error : new Error(String(handler_error));
                proxy_logger.error('Proxy request handler threw an error.', {
                    message: normalized_error.message,
                    stack: normalized_error.stack
                });
                throw normalized_error;
            }
        });

    return new MockttpProxyWrapper(mockttp_server, port, ready_func, error_func, proxy_logger);
}

class MockttpProxyWrapper {
    constructor(mockttp_server, port, ready_func, error_func, proxy_logger) {
        this.mockttp_server = mockttp_server;
        this.port = port;
        this.ready_func = typeof ready_func === 'function' ? ready_func : () => {};
        this.error_func = typeof error_func === 'function' ? error_func : () => {};
        this.proxy_logger = proxy_logger;
        this.started = false;
        this.auth_listeners_attached = false;
    }

    async start() {
        if (this.started) {
            return;
        }
        try {
            await this.mockttp_server.start(this.port);
            this.attach_proxy_auth_listeners();
            this.started = true;
            this.ready_func();
        } catch (start_error) {
            const normalized_error = start_error instanceof Error ? start_error : new Error(String(start_error));
            this.error_func(normalized_error);
            this.proxy_logger.error('Mockttp proxy failed to start.', {
                message: normalized_error.message,
                stack: normalized_error.stack
            });
            throw normalized_error;
        }
    }

    async close() {
        if (!this.started) {
            return;
        }
        await this.mockttp_server.stop();
        this.started = false;
        connection_states.clear();
        this.auth_listeners_attached = false;
    }

    attach_proxy_auth_listeners() {
        if (this.auth_listeners_attached) {
            return;
        }
        const server = this.mockttp_server?.server;
        if (!server || typeof server.on !== 'function') {
            this.proxy_logger.warn('Mockttp server did not expose an attachable server instance for proxy auth listeners.');
            return;
        }
        if (typeof this.proxy_logger.debug === 'function') {
            this.proxy_logger.debug('Attaching proxy auth listeners.');
        }

        const handle_http_request = (req) => {
            if (!req || !req.headers) {
                return;
            }
            const proxy_auth = req.headers['proxy-authorization'];
            if (proxy_auth) {
                this.proxy_logger.debug?.('Captured proxy authorization on HTTP request.');
            }
            if (proxy_auth) {
                handle_proxy_authorization_header(req.socket, proxy_auth);
            }
        };

        const handle_connect = (req, socket) => {
            if (!req || !req.headers) {
                return;
            }
            const proxy_auth = req.headers['proxy-authorization'];
            if (proxy_auth) {
                this.proxy_logger.debug?.('Captured proxy authorization on CONNECT request.');
            }
            if (proxy_auth) {
                handle_proxy_authorization_header(socket, proxy_auth);
            }
        };

        if (typeof server.prependListener === 'function') {
            server.prependListener('request', handle_http_request);
            server.prependListener('connect', handle_connect);
        } else {
            server.on('request', handle_http_request);
            server.on('connect', handle_connect);
        }

        const http_server = server._httpServer;
        if (http_server && typeof http_server.on === 'function') {
            if (typeof this.proxy_logger.debug === 'function') {
                this.proxy_logger.debug('Attaching listeners to internal HTTP server.');
            }
            if (typeof http_server.prependListener === 'function') {
                http_server.prependListener('request', handle_http_request);
                http_server.prependListener('connect', handle_connect);
            } else {
                http_server.on('request', handle_http_request);
                http_server.on('connect', handle_connect);
            }
        }
        this.auth_listeners_attached = true;
    }
}

async function run_on_start_hook_if_configured(proxy_logger) {
    if (!process.env.ON_START_HOOK_FILE_PATH) {
        return;
    }

    proxy_logger.info('A thermoptic onstart hook has been declared, running hook before starting proxy server...', {
        hook_file: process.env.ON_START_HOOK_FILE_PATH
    });

    const cdp_instance = await cdp.start_browser_session();
    try {
        await utils.run_hook_file(
            process.env.ON_START_HOOK_FILE_PATH,
            cdp_instance,
            null,
            null,
            proxy_logger
        );
    } finally {
        try {
            await cdp_instance.close();
        } catch (closeErr) {
            proxy_logger.warn('Failed to close CDP session while completing onstart hook.', {
                message: closeErr.message,
                stack: closeErr.stack
            });
        }
    }
}

async function adapt_request_for_handler(request) {
    const connection_state = get_or_create_connection_state(request);
    const normalized_protocol = normalize_protocol(request.protocol);

    const headers = { ...request.headers };

    const proxy_authorization_header = headers['proxy-authorization'];
    if (proxy_authorization_header) {
        delete headers['proxy-authorization'];
    }

    for (const header_key of Object.keys(headers)) {
        const lower_key = header_key.toLowerCase();
        if (lower_key.startsWith(':')) {
            delete headers[header_key];
            continue;
        }
        if (lower_key === 'proxy-connection') {
            delete headers[header_key];
        }
    }

    const enforced_host_header = build_host_header(request.destination, request.protocol);
    if (enforced_host_header) {
        headers.host = enforced_host_header;
    }
    delete headers.connection;

    const request_options = {
        method: request.method,
        path: request.path,
        headers: headers,
        hostname: request.destination?.hostname,
        port: request.destination?.port
    };

    const raw_headers = flatten_raw_headers(request.rawHeaders, enforced_host_header);
    const has_host_raw_header = raw_headers.some((value, index) => {
        if (index % 2 !== 0) {
            return false;
        }
        return typeof value === 'string' && value.toLowerCase() === 'host';
    });
    if (!has_host_raw_header && enforced_host_header) {
        raw_headers.push('Host', enforced_host_header);
    }

    const adapted_request = {
        protocol: normalized_protocol,
        url: request.url,
        requestOptions: request_options,
        requestData: request.body.buffer,
        _req: {
            rawHeaders: raw_headers
        },
        connection_state: connection_state,
        proxy_authorization_header: proxy_authorization_header,
        original_request: request
    };

    return adapted_request;
}

function flatten_raw_headers(raw_headers, enforced_host_header) {
    if (!Array.isArray(raw_headers)) {
        return [];
    }

    const flattened = [];
    let has_host_header = false;
    for (const [header_name, header_value] of raw_headers) {
        if (typeof header_name !== 'string') {
            continue;
        }
        const lower_header = header_name.toLowerCase();
        if (lower_header.startsWith(':')) {
            continue;
        }
        if (lower_header === 'proxy-authorization') {
            continue;
        }
        if (lower_header === 'connection') {
            continue;
        }
        if (lower_header === 'proxy-connection') {
            continue;
        }
        if (lower_header === 'host') {
            has_host_header = true;
            flattened.push('Host', enforced_host_header || (header_value !== undefined ? String(header_value) : ''));
            continue;
        }
        flattened.push(String(header_name), header_value !== undefined ? String(header_value) : '');
    }

    if (!has_host_header && enforced_host_header) {
        flattened.push('Host', enforced_host_header);
    }

    return flattened;
}

function normalize_protocol(protocol) {
    if (!protocol) {
        return '';
    }
    return protocol.endsWith(':') ? protocol.slice(0, -1) : protocol;
}

function resolve_http_version(http_version) {
    if (typeof http_version === 'string' && http_version.trim() !== '') {
        return http_version;
    }
    return '1.1';
}

function is_http2_request(request) {
    if (!request || typeof request !== 'object') {
        return false;
    }

    if (typeof request.httpVersion === 'string' && request.httpVersion.startsWith('2')) {
        return true;
    }

    if (request.headers && typeof request.headers === 'object') {
        for (const header_name of Object.keys(request.headers)) {
            if (typeof header_name === 'string' && header_name.startsWith(':')) {
                return true;
            }
        }
    }

    return false;
}

function get_connection_key(request) {
    if (!request.remoteIpAddress || typeof request.remotePort !== 'number') {
        return null;
    }
    return `${request.remoteIpAddress}:${request.remotePort}`;
}

function build_host_header(destination, protocol) {
    if (!destination || !destination.hostname) {
        return null;
    }
    const hostname = destination.hostname;
    const port = destination.port;
    const normalized_protocol = normalize_protocol(protocol);

    const is_default_port = (!port) ||
        (normalized_protocol === 'https' && Number(port) === 443) ||
        (normalized_protocol === 'http' && Number(port) === 80);

    if (is_default_port) {
        return hostname;
    }
    return `${hostname}:${port}`;
}

function get_or_create_connection_state(request) {
    const key = get_connection_key(request);
    if (!key) {
        return null;
    }

    let state = connection_states.get(key);
    if (!state) {
        state = {
            key: key,
            is_authenticated: false,
            last_seen: Date.now()
        };
        connection_states.set(key, state);
    } else {
        state.last_seen = Date.now();
    }
    return state;
}

function purge_expired_connection_states(now = Date.now()) {
    for (const [key, state] of connection_states.entries()) {
        if (state.last_seen + CONNECTION_STATE_TTL_MS < now) {
            connection_states.delete(key);
        }
    }
}

function get_connection_key_from_socket(socket) {
    if (!socket) {
        return null;
    }
    const address = socket.remoteAddress;
    const port = socket.remotePort;
    if (!address || typeof port !== 'number') {
        return null;
    }
    return `${address}:${port}`;
}

function handle_proxy_authorization_header(socket, proxy_auth_header) {
    const connection_key = get_connection_key_from_socket(socket);
    if (!connection_key) {
        return;
    }

    let state = connection_states.get(connection_key);
    if (!state) {
        state = {
            key: connection_key,
            is_authenticated: false,
            last_seen: Date.now()
        };
        connection_states.set(connection_key, state);
    } else {
        state.last_seen = Date.now();
    }

    const is_valid = validate_proxy_authorization(proxy_auth_header);
    if (is_valid) {
        state.is_authenticated = true;
    }

    if (!state.cleanup_registered && socket && typeof socket.once === 'function') {
        state.cleanup_registered = true;
        socket.once('close', () => {
            connection_states.delete(connection_key);
        });
    }
}

function validate_proxy_authorization(header_value) {
    if (!PROXY_AUTHENTICATION_ENABLED) {
        return true;
    }

    if (!header_value || !header_value.includes('Basic')) {
        return false;
    }

    try {
        const encoded_part = header_value.replace('Basic', '').trim();
        const decoded = Buffer.from(encoded_part, 'base64').toString();
        const separator_index = decoded.indexOf(':');
        if (separator_index === -1) {
            return false;
        }
        const username = decoded.slice(0, separator_index);
        const password = decoded.slice(separator_index + 1);
        const expected = `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`;
        const provided = `${username}:${password}`;
        return utils.time_safe_compare(expected, provided);
    } catch {
        return false;
    }
}

function normalize_body_to_buffer(body) {
    if (!body) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (typeof body === 'string') {
        return Buffer.from(body);
    }
    if (ArrayBuffer.isView(body)) {
        return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body instanceof ArrayBuffer) {
        return Buffer.from(body);
    }
    if (typeof body === 'object' && body.type === 'Buffer' && Array.isArray(body.data)) {
        return Buffer.from(body.data);
    }

    try {
        return Buffer.from(body);
    } catch {
        return Buffer.from(String(body));
    }
}

function log_raw_proxy_request(request, http_version) {
    try {
        const request_options = request.requestOptions || {};
        const method = request_options.method || request.original_request?.method || 'GET';
        const path = request_options.path || request.original_request?.path || '/';
        const header_pairs = extract_request_headers(request);
        const header_lines = header_pairs.map(([name, value]) => `${name}: ${value !== undefined ? String(value) : ''}`);

        const body_buffer = normalize_body_to_buffer(request.requestData);

        const parts = [
            Buffer.from(`${method} ${path} HTTP/${http_version}\r\n`)
        ];

        if (header_lines.length > 0) {
            parts.push(Buffer.from(header_lines.join('\r\n')));
        }

        parts.push(Buffer.from('\r\n\r\n'));
        parts.push(body_buffer);

        const payload = Buffer.concat(parts);

        process.stdout.write('----- BEGIN PROXY RAW REQUEST -----\n');
        process.stdout.write(payload);
        process.stdout.write('\n----- END PROXY RAW REQUEST -----\n');
    } catch (trace_error) {
        process.stdout.write(`TRACE logging failed for request: ${trace_error instanceof Error ? trace_error.message : String(trace_error)}\n`);
    }
}

function log_raw_proxy_response(request, response, sanitized_headers, http_version) {
    try {
        const status_code = response.statusCode ?? 500;
        const status_message = response.statusMessage || STATUS_CODES[status_code] || '';
        const header_lines = [];

        Object.entries(sanitized_headers || {}).forEach(([header_name, header_value]) => {
            header_lines.push(`${header_name}: ${header_value}`);
        });

        const body_buffer = normalize_body_to_buffer(response.body);

        const parts = [
            Buffer.from(`HTTP/${http_version} ${status_code} ${status_message}\r\n`)
        ];

        if (header_lines.length > 0) {
            parts.push(Buffer.from(header_lines.join('\r\n')));
        }

        parts.push(Buffer.from('\r\n\r\n'));
        parts.push(body_buffer);

        const payload = Buffer.concat(parts);

        process.stdout.write('----- BEGIN PROXY RAW RESPONSE -----\n');
        process.stdout.write(payload);
        process.stdout.write('\n----- END PROXY RAW RESPONSE -----\n');
    } catch (trace_error) {
        process.stdout.write(`TRACE logging failed for response: ${trace_error instanceof Error ? trace_error.message : String(trace_error)}\n`);
    }
}

function extract_request_headers(request) {
    const header_sources = [
        request?._req?.rawHeaders,
        request?.original_request?.rawHeaders,
        request?.original_request?.headers,
        request?.requestOptions?.headers
    ];

    for (const source of header_sources) {
        const normalized = normalize_header_pairs(source);
        if (normalized.length > 0) {
            return normalized;
        }
    }

    return [];
}

function normalize_header_pairs(source) {
    if (!source) {
        return [];
    }

    if (source instanceof Map) {
        const map_pairs = [];
        source.forEach((value, name) => {
            map_pairs.push([String(name), value !== undefined ? String(value) : '']);
        });
        return map_pairs;
    }

    if (Array.isArray(source)) {
        if (source.length > 0 && source.every(entry => typeof entry === 'string')) {
            const pairs = [];
            for (let i = 0; i < source.length; i += 2) {
                const name = source[i];
                const value = source[i + 1];
                if (typeof name !== 'string') {
                    continue;
                }
                pairs.push([name, value !== undefined ? String(value) : '']);
            }
            return pairs;
        }

        const pairs = [];
        for (const entry of source) {
            if (Array.isArray(entry) && entry.length >= 2) {
                pairs.push([String(entry[0]), entry[1] !== undefined ? String(entry[1]) : '']);
                continue;
            }
            if (entry && typeof entry === 'object') {
                const name = typeof entry.name === 'string' ? entry.name : (typeof entry.key === 'string' ? entry.key : undefined);
                if (!name) {
                    continue;
                }
                const value = entry.value !== undefined ? entry.value : (entry.val !== undefined ? entry.val : '');
                pairs.push([name, value !== undefined ? String(value) : '']);
            }
        }
        if (pairs.length > 0) {
            return pairs;
        }
    }

    if (typeof source === 'object') {
        return Object.entries(source).map(([name, value]) => [name, value !== undefined ? String(value) : '']);
    }

    return [];
}

async function load_mockttp() {
    if (!mockttp_module) {
        mockttp_module = await import('mockttp');
    }
    return mockttp_module;
}

function seed_global_crypto() {
    const webcrypto = node_crypto.webcrypto;
    if (typeof globalThis.crypto === 'undefined') {
        globalThis.crypto = webcrypto || {};
    }
    if (webcrypto && typeof globalThis.crypto.subtle === 'undefined') {
        globalThis.crypto.subtle = webcrypto.subtle;
    }
    if (typeof globalThis.crypto.randomUUID !== 'function' && typeof node_crypto.randomUUID === 'function') {
        globalThis.crypto.randomUUID = node_crypto.randomUUID.bind(node_crypto);
    }
}

function is_env_flag_enabled(value) {
    if (typeof value === 'undefined') {
        return false;
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === '' || normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
        return false;
    }
    return true;
}
