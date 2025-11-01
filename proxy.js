import { access, mkdir, writeFile } from 'fs/promises';
import { constants as fs_constants } from 'fs';
import { resolve } from 'path';
import * as node_crypto from 'crypto';
import * as cdp from './cdp.js';
import * as utils from './utils.js';
import * as logger from './logger.js';

const CA_DIRECTORY_PATH = resolve('./ssl');
const CA_CERTIFICATE_PATH = resolve('./ssl/rootCA.crt');
const CA_PRIVATE_KEY_PATH = resolve('./ssl/rootCA.key');
const CONNECTION_STATE_TTL_MS = 15 * 60 * 1000;

const connection_states = new Map();
let mockttp_module = null;

seed_global_crypto();

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
                return {
                    statusCode: response.statusCode ?? 500,
                    statusMessage: response.statusMessage,
                    headers: response.header ?? {},
                    body: response.body
                };
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

async function ensure_ca_material(proxy_logger, generateCACertificate) {
    const [cert_exists, key_exists] = await Promise.all([
        does_file_exist(CA_CERTIFICATE_PATH),
        does_file_exist(CA_PRIVATE_KEY_PATH)
    ]);

    if (cert_exists && key_exists) {
        return;
    }

    await mkdir(CA_DIRECTORY_PATH, { recursive: true });
    proxy_logger.info('Generating root CA for thermoptic proxy.', {
        certificate_path: CA_CERTIFICATE_PATH
    });

    const { key, cert } = await generateCACertificate({
        subject: {
            commonName: 'thermoptic Root CA',
            organizationName: 'thermoptic',
            countryName: 'US'
        }
    });

    await writeFile(CA_PRIVATE_KEY_PATH, key, { mode: 0o600 });
    await writeFile(CA_CERTIFICATE_PATH, cert, { mode: 0o644 });
}

async function does_file_exist(path) {
    try {
        await access(path, fs_constants.F_OK);
        return true;
    } catch {
        return false;
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
