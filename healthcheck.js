import { createServer } from 'node:http';
import { request as http_request } from 'node:http';
import { request as https_request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as logger from './logger.js';
import * as requestengine from './requestengine.js';

function parse_truthy_or_falsy(value) {
    if (typeof value === 'undefined' || value === null) {
        return null;
    }
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return null;
}

function detect_container_environment() {
    const explicit = parse_truthy_or_falsy(process.env.THERMOPTIC_CONTAINER_RUNTIME);
    if (explicit !== null) {
        return explicit;
    }

    const docker_env_truthy = parse_truthy_or_falsy(process.env.DOCKER) || parse_truthy_or_falsy(process.env.DOCKER_CONTAINER);
    if (docker_env_truthy === true) {
        return true;
    }

    try {
        const cgroup_path = '/proc/1/cgroup';
        if (existsSync(cgroup_path)) {
            const cgroup_contents = readFileSync(cgroup_path, 'utf8');
            if (cgroup_contents.includes('docker') || cgroup_contents.includes('kubepods') || cgroup_contents.includes('containerd') || cgroup_contents.includes('podman')) {
                return true;
            }
        }
    } catch (err) {
        // Swallow errors, best effort detection only.
    }

    return false;
}

const DEFAULT_HEALTHCHECK_ENABLED = detect_container_environment();
const DEFAULT_HEALTHCHECK_INTERVAL_MS = 30000;
const DEFAULT_HEALTHCHECK_ENDPOINT_PORT = 8085;
const DEFAULT_HEALTHCHECK_ENDPOINT_PATH = '/__thermoptic_health';
const DEFAULT_HEALTHCHECK_RESPONSE_BODY = 'thermoptic-health-ok';
const DEFAULT_HEALTHCHECK_RESPONSE_CONTENT_TYPE = 'text/plain; charset=utf-8';
const DEFAULT_HEALTHCHECK_EXPECTED_STATUS = 200;
const DEFAULT_HEALTHCHECK_FAILURE_THRESHOLD = 1;
const DEFAULT_HEALTHCHECK_RESTART_TIMEOUT_MS = 5000;
const DEFAULT_HEALTHCHECK_RESTART_BACKOFF_MS = 10000;

const health_logger = logger.get_logger();

function parse_boolean(value, default_value) {
    const parsed = parse_truthy_or_falsy(value);
    if (parsed === null) {
        return default_value;
    }
    return parsed;
}

function parse_integer(value, default_value, minimum = null) {
    if (typeof value === 'undefined') {
        return default_value;
    }
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return default_value;
    }
    if (minimum !== null && parsed < minimum) {
        return default_value;
    }
    return parsed;
}

function normalize_path(value, fallback) {
    if (!value) {
        return fallback;
    }
    if (value.startsWith('/')) {
        return value;
    }
    return `/${value}`;
}

function safe_string(value, fallback) {
    if (typeof value === 'undefined' || value === null) {
        return fallback;
    }
    const str = String(value);
    if (!str.trim()) {
        return fallback;
    }
    return str;
}

function build_restart_url(default_port) {
    const host = safe_string(process.env.CHROME_RESTART_HOST, 'chrome');
    const control_port = safe_string(process.env.CHROME_CONTROL_PORT, default_port);
    const path = normalize_path(process.env.CHROME_RESTART_PATH || '/restart', '/restart');
    const protocol = safe_string(process.env.CHROME_RESTART_PROTOCOL, 'http');
    return `${protocol}://${host}:${control_port}${path}`;
}

function build_health_config() {
    const enabled = parse_boolean(process.env.HEALTHCHECK_ENABLED, DEFAULT_HEALTHCHECK_ENABLED);

    const endpoint_port = parse_integer(process.env.HEALTHCHECK_ENDPOINT_PORT, DEFAULT_HEALTHCHECK_ENDPOINT_PORT, 1);
    const endpoint_path = normalize_path(process.env.HEALTHCHECK_ENDPOINT_PATH, DEFAULT_HEALTHCHECK_ENDPOINT_PATH);
    const response_body = safe_string(process.env.HEALTHCHECK_RESPONSE_BODY, DEFAULT_HEALTHCHECK_RESPONSE_BODY);
    const response_content_type = safe_string(process.env.HEALTHCHECK_RESPONSE_CONTENT_TYPE, DEFAULT_HEALTHCHECK_RESPONSE_CONTENT_TYPE);

    const target_protocol = safe_string(process.env.HEALTHCHECK_TARGET_PROTOCOL, 'http');
    const target_host = safe_string(process.env.HEALTHCHECK_TARGET_HOST, 'thermoptic');
    const target_port = parse_integer(process.env.HEALTHCHECK_TARGET_PORT, endpoint_port, 1);
    const target_path = normalize_path(process.env.HEALTHCHECK_TARGET_PATH, endpoint_path);

    const interval_ms = parse_integer(process.env.HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_INTERVAL_MS, 1000);
    const expected_status = parse_integer(process.env.HEALTHCHECK_EXPECTED_STATUS, DEFAULT_HEALTHCHECK_EXPECTED_STATUS, 100);
    const expected_body = safe_string(process.env.HEALTHCHECK_EXPECTED_BODY, response_body);
    const failure_threshold = parse_integer(process.env.HEALTHCHECK_FAILURE_THRESHOLD, DEFAULT_HEALTHCHECK_FAILURE_THRESHOLD, 1);

    const restart_method = safe_string(process.env.HEALTHCHECK_RESTART_METHOD, 'POST').toUpperCase();
    const restart_url = safe_string(process.env.HEALTHCHECK_RESTART_URL, build_restart_url(process.env.CHROME_CONTROL_PORT || '9223'));
    const restart_timeout_ms = parse_integer(process.env.HEALTHCHECK_RESTART_TIMEOUT_MS, DEFAULT_HEALTHCHECK_RESTART_TIMEOUT_MS, 1000);
    const restart_backoff_ms = parse_integer(process.env.HEALTHCHECK_RESTART_BACKOFF_MS, DEFAULT_HEALTHCHECK_RESTART_BACKOFF_MS, 1000);

    const probe_headers = [
        { key: 'Host', value: `${target_host}:${target_port}` },
        { key: 'Accept', value: 'application/json, text/plain; q=0.9, */*;q=0.1' },
        { key: 'Sec-Fetch-Dest', value: 'empty' },
        { key: 'Sec-Fetch-Mode', value: 'cors' },
        { key: 'Sec-Fetch-Site', value: 'cross-site' }
    ];

    const target_url = `${target_protocol}://${target_host}:${target_port}${target_path}`;
    const target_url_object = new URL(target_url);

    return {
        enabled,
        endpoint_port,
        endpoint_path,
        response_body,
        response_content_type,
        interval_ms,
        expected_status,
        expected_body,
        failure_threshold,
        restart_method,
        restart_url,
        restart_timeout_ms,
        restart_backoff_ms,
        probe_headers,
        target_url,
        target_url_object
    };
}

function start_health_endpoint(config) {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            if (!req || !req.url) {
                res.statusCode = 400;
                res.end();
                return;
            }

            const method = req.method ? req.method.toUpperCase() : 'GET';
            const request_path = req.url.split('?')[0];

            if ((method !== 'GET' && method !== 'HEAD') || request_path !== config.endpoint_path) {
                res.statusCode = 404;
                res.end();
                return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', config.response_content_type);
            res.setHeader('Cache-Control', 'no-store, max-age=0');
            if (method === 'HEAD') {
                res.end();
                return;
            }
            res.end(config.response_body);
        });

        server.on('error', (err) => {
            reject(err);
        });

        server.listen(config.endpoint_port, '0.0.0.0', () => {
            health_logger.info('Health probe endpoint listening.', {
                port: config.endpoint_port,
                path: config.endpoint_path
            });
            resolve(server);
        });
    });
}

function decode_response_body(body) {
    if (body === null || typeof body === 'undefined') {
        return '';
    }
    if (Buffer.isBuffer(body)) {
        return body.toString('utf8');
    }
    if (typeof body === 'string') {
        return body;
    }
    if (Array.isArray(body)) {
        return body.join('');
    }
    if (typeof body === 'object' && typeof body.toString === 'function') {
        return body.toString();
    }
    return '';
}

async function perform_health_probe(config, state) {
    const probe_logger = logger.get_request_logger({ request_id: `health-${randomUUID()}` });
    const { target_url, target_url_object } = config;

    const protocol = target_url_object.protocol.replace(':', '');
    const path = `${target_url_object.pathname}${target_url_object.search || ''}`;

    const started_at = Date.now();
    const response = await requestengine.process_request(
        probe_logger,
        target_url,
        protocol,
        'GET',
        path,
        config.probe_headers,
        null
    );

    const duration_ms = Date.now() - started_at;
    const status_code = response && typeof response.statusCode === 'number' ? response.statusCode : null;
    const body_text = decode_response_body(response && response.body);

    const status_match = status_code === config.expected_status;
    const body_match = body_text.trim() === config.expected_body.trim();

    if (!status_match || !body_match) {
        const details = {
            expected_status: config.expected_status,
            actual_status: status_code,
            expected_body: config.expected_body,
            actual_body: body_text,
            duration_ms
        };
        const error = new Error('Health probe response mismatch.');
        error.details = details;
        throw error;
    }

    health_logger.info('Health probe succeeded.', {
        duration_ms
    });
    state.failure_count = 0;
    state.last_success_at = Date.now();
}

function select_http_module(url) {
    return url.startsWith('https://') ? https_request : http_request;
}

function trigger_chrome_restart(config, state) {
    const now = Date.now();
    if (now - state.last_restart_at < config.restart_backoff_ms) {
        health_logger.warn('Chrome restart skipped due to backoff.', {
            restart_url: config.restart_url,
            backoff_ms: config.restart_backoff_ms
        });
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const restart_url = new URL(config.restart_url);
        const request_module = select_http_module(config.restart_url);
        const options = {
            host: restart_url.hostname,
            port: restart_url.port ? parseInt(restart_url.port, 10) : (restart_url.protocol === 'https:' ? 443 : 80),
            path: `${restart_url.pathname}${restart_url.search}`,
            method: config.restart_method,
            timeout: config.restart_timeout_ms,
            headers: {
                'Content-Length': '0'
            }
        };

        const req = request_module(options, (res) => {
            res.resume();
            const success = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
            if (success) {
                state.last_restart_at = Date.now();
                health_logger.warn('Requested Chrome restart due to failed health probe.', {
                    restart_url: config.restart_url,
                    status_code: res.statusCode
                });
                resolve(true);
                return;
            }
            health_logger.warn('Chrome restart request returned unexpected status.', {
                restart_url: config.restart_url,
                status_code: res.statusCode
            });
            resolve(false);
        });

        req.on('timeout', () => {
            req.destroy(new Error('Restart request timed out.'));
        });

        req.on('error', (err) => {
            health_logger.error('Chrome restart request failed.', {
                restart_url: config.restart_url,
                message: err.message
            });
            resolve(false);
        });

        req.end();
    });
}

async function execute_probe_cycle(config, state) {
    if (state.probe_in_progress) {
        health_logger.warn('Skipping health probe because a previous check is still running.');
        return;
    }

    state.probe_in_progress = true;
    try {
        await perform_health_probe(config, state);
    } catch (error) {
        state.failure_count += 1;
        const details = error && error.details ? error.details : undefined;
        health_logger.warn('Health probe failed.', {
            message: error instanceof Error ? error.message : String(error),
            failure_count: state.failure_count,
            details
        });

        if (state.failure_count >= config.failure_threshold) {
            await trigger_chrome_restart(config, state);
            state.failure_count = 0;
        }
    } finally {
        state.probe_in_progress = false;
    }
}

function start_probe_timer(config, state) {
    const interval_handle = setInterval(() => {
        execute_probe_cycle(config, state).catch((err) => {
            health_logger.error('Health probe cycle encountered an uncaught error.', {
                message: err instanceof Error ? err.message : String(err)
            });
        });
    }, config.interval_ms);

    return interval_handle;
}

export async function start_health_monitor() {
    const config = build_health_config();

    if (!config.enabled) {
        health_logger.info('Health monitor disabled by configuration.');
        return null;
    }

    const state = {
        probe_in_progress: false,
        failure_count: 0,
        last_success_at: null,
        last_restart_at: 0
    };

    const health_endpoint = await start_health_endpoint(config);
    const interval_handle = start_probe_timer(config, state);

    // Kick off an immediate probe once the endpoint is ready
    execute_probe_cycle(config, state).catch((err) => {
        health_logger.warn('Initial health probe failed.', {
            message: err instanceof Error ? err.message : String(err)
        });
    });

    return {
        stop: () => {
            clearInterval(interval_handle);
            health_endpoint.close();
        }
    };
}
