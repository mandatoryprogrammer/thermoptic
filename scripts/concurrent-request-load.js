#!/usr/bin/env node
import { Command } from 'commander';
import request_module from 'request';
import * as logger from '../logger.js';

const script_logger = logger.get_logger();

const DEFAULT_TARGET_URL = 'https://example.com/';
const DEFAULT_TOTAL_REQUESTS = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PROXY_HOST = '127.0.0.1';
const DEFAULT_PROXY_PORT = 1234;
const DEFAULT_PROXY_USER = 'changeme';
const DEFAULT_PROXY_PASS = 'changeme';
const MAX_RECORDED_FAILURES = 50;
const DEFAULT_HEADERS = {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Priority: 'u=0',
    Referer: 'https://example.com/',
    'Sec-CH-UA': '"Not:A-Brand";v="24", "Chromium";v="134"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
};

function collect_header(value, previous) {
    previous.push(value);
    return previous;
}

function parse_positive_int(value, label) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error(`Invalid ${label}: "${value}".`);
    }
    return parsed;
}

function parse_headers(header_lines) {
    const headers = {};
    for (const line of header_lines) {
        const separator_index = line.indexOf(':');
        if (separator_index === -1) {
            throw new Error(`Invalid header format (expected "Name: value"): "${line}".`);
        }
        const name = line.slice(0, separator_index).trim();
        const value = line.slice(separator_index + 1).trim();
        if (!name) {
            throw new Error(`Invalid header name in "${line}".`);
        }
        headers[name] = value;
    }
    return headers;
}

function mask_proxy_credentials(raw_proxy_url) {
    try {
        const parsed = new URL(raw_proxy_url);
        if (parsed.username) {
            parsed.username = '***';
        }
        if (parsed.password) {
            parsed.password = '***';
        }
        return parsed.toString();
    } catch (error) {
        return raw_proxy_url;
    }
}

function compute_latency_stats(values) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (arr, p) => {
        const index = Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)));
        return arr[index];
    };
    return {
        min: sorted[0],
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        p99: percentile(sorted, 0.99),
        max: sorted[sorted.length - 1]
    };
}

function build_request_options(base_options, method, target_url, headers, body) {
    const request_headers = { ...headers };
    const request_options = {
        method,
        url: target_url,
        headers: request_headers,
        timeout: base_options.timeout,
        strictSSL: base_options.strictSSL,
        followAllRedirects: true,
        time: true
    };
    if (body !== undefined) {
        request_options.body = body;
    }
    return request_options;
}

function sanitize_request_options_for_log(request_options, proxy_url) {
    const sanitized = {
        method: request_options.method,
        url: request_options.url,
        headers: request_options.headers,
        timeout: request_options.timeout,
        followAllRedirects: request_options.followAllRedirects,
        body: request_options.body
    };
    sanitized.proxy = mask_proxy_credentials(proxy_url);
    return sanitized;
}

function record_failure(summary, failure) {
    if (summary.failures.length < MAX_RECORDED_FAILURES) {
        summary.failures.push({
            request_index: failure.request_index,
            error_message: failure.error_message,
            status_code: failure.status_code
        });
    }
}

async function main() {
    const program = new Command();
    program
        .name('concurrent-request-load')
        .description('Issue concurrent HTTP requests through the Thermoptic proxy using the request library.')
        .option('--url <url>', 'Target URL to fetch', DEFAULT_TARGET_URL)
        .option('--requests <count>', 'Total number of requests to send', String(DEFAULT_TOTAL_REQUESTS))
        .option('--concurrency <count>', 'Maximum concurrent in-flight requests', String(DEFAULT_CONCURRENCY))
        .option('--timeout <ms>', 'Request timeout in milliseconds', String(DEFAULT_TIMEOUT_MS))
        .option('--method <method>', 'HTTP method to use', 'GET')
        .option('--body <body>', 'Request body payload')
        .option('--header <header>', 'Additional header in "Name: value" format (can be repeated)', collect_header, [])
        .option('--proxy-host <host>', 'Thermoptic proxy host', DEFAULT_PROXY_HOST)
        .option('--proxy-port <port>', 'Thermoptic proxy port', String(DEFAULT_PROXY_PORT))
        .option('--proxy-user <username>', 'Thermoptic proxy username', DEFAULT_PROXY_USER)
        .option('--proxy-pass <password>', 'Thermoptic proxy password', DEFAULT_PROXY_PASS)
        .option('--trace', 'Log detailed request and response information for failures')
        .option('--verify', 'Enable TLS validation for upstream targets');

    program.parse(process.argv);
    const options = program.opts();

    const total_requests = parse_positive_int(options.requests, 'requests');
    let concurrency = parse_positive_int(options.concurrency, 'concurrency');
    if (concurrency > total_requests) {
        concurrency = total_requests;
    }
    const timeout_ms = parse_positive_int(options.timeout, 'timeout');
    const proxy_port = parse_positive_int(options.proxyPort, 'proxy-port');
    const method = options.method ? options.method.toUpperCase() : 'GET';
    const header_overrides = parse_headers(options.header ?? []);
    const target_url = options.url;

    let parsed_target;
    try {
        parsed_target = new URL(target_url);
    } catch (error) {
        throw new Error(`Invalid target URL: "${target_url}".`);
    }

    const headers = {
        ...DEFAULT_HEADERS,
        ...header_overrides
    };
    headers.Referer = headers.Referer ?? `https://${parsed_target.host}/`;

    const proxy_url = `http://${encodeURIComponent(options.proxyUser)}:${encodeURIComponent(options.proxyPass)}@${options.proxyHost}:${proxy_port}`;
    const verify_tls = Boolean(options.verify);
    const request_factory = request_module.defaults({
        proxy: proxy_url,
        timeout: timeout_ms,
        strictSSL: verify_tls
    });
    const traced_proxy = mask_proxy_credentials(proxy_url);
    const should_trace = Boolean(options.trace);

    script_logger.info('Starting request load.', {
        total_requests: total_requests,
        target_url: target_url,
        concurrency: concurrency
    });
    script_logger.info('Request load configuration.', {
        proxy: traced_proxy,
        timeout_ms: timeout_ms,
        method: method,
        tls_verify_enabled: verify_tls
    });

    const summary = {
        attempted: total_requests,
        succeeded: 0,
        failed: 0,
        durations: [],
        failures: []
    };

    let next_index = 0;

    const workers = Array.from({ length: concurrency }, () => worker());
    const start_time = Date.now();

    await Promise.all(workers);

    const elapsed_ms = Date.now() - start_time;
    const success_rate = summary.succeeded / total_requests * 100;
    const latency_stats = compute_latency_stats(summary.durations);

    script_logger.info('Completed request load.', {
        elapsed_ms: elapsed_ms,
        successes: summary.succeeded,
        failures: summary.failed,
        success_rate: Number.isNaN(success_rate) ? 0 : Number(success_rate.toFixed(2))
    });
    if (latency_stats) {
        script_logger.info('Latency metrics (ms).', {
            min: Number(latency_stats.min.toFixed(1)),
            p50: Number(latency_stats.p50.toFixed(1)),
            p90: Number(latency_stats.p90.toFixed(1)),
            p99: Number(latency_stats.p99.toFixed(1)),
            max: Number(latency_stats.max.toFixed(1))
        });
    }

    if (summary.failed > 0) {
        script_logger.error('Request load completed with failures.', {
            failed_requests: summary.failed,
            reported_failures: Math.min(summary.failed, summary.failures.length)
        });
        summary.failures.forEach((failure) => {
            script_logger.error('Failure summary.', {
                request_index: failure.request_index,
                error_message: failure.error_message,
                status_code: failure.status_code
            });
        });
        process.exitCode = 1;
    }

    async function worker() {
        while (true) {
            if (next_index >= total_requests) {
                return;
            }
            const request_index = next_index;
            next_index += 1;
            await execute_request(request_index).catch((error) => {
                if (!should_trace) {
                    return;
                }
                script_logger.error('Unexpected error in worker.', {
                    request_index: request_index,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
            });
        }
    }

    async function execute_request(request_index) {
        const request_options = build_request_options({
            timeout: timeout_ms,
            strictSSL: verify_tls
        }, method, target_url, headers, options.body);
        const started_at = Date.now();

        try {
            const { response, body } = await run_request(request_options);
            const status_code = response?.statusCode ?? 0;
            if (status_code >= 200 && status_code < 400) {
                summary.succeeded += 1;
                summary.durations.push(Date.now() - started_at);
                return;
            }
            const failure = build_failure({
                request_index,
                error_message: `Received status ${status_code}`,
                duration: Date.now() - started_at,
                request_options,
                response,
                response_body: body
            });
            summary.failed += 1;
            record_failure(summary, failure);
            if (should_trace) {
                log_trace_failure(failure, traced_proxy);
            }
        } catch (error) {
            const failure = build_failure({
                request_index,
                error_message: error instanceof Error ? error.message : String(error),
                duration: Date.now() - started_at,
                request_options,
                response: error.response,
                response_body: error.responseBody,
                error_stack: error instanceof Error ? error.stack : undefined
            });
            summary.failed += 1;
            record_failure(summary, failure);
            if (should_trace) {
                log_trace_failure(failure, traced_proxy);
            }
        }
    }

    function run_request(current_options) {
        return new Promise((resolve, reject) => {
            request_factory(current_options, (error, response, body) => {
                if (error) {
                    error.response = response;
                    error.responseBody = body;
                    reject(error);
                    return;
                }
                resolve({ response, body });
            });
        });
    }

    function build_failure({ request_index, error_message, duration, request_options, response, response_body, error_stack }) {
        let body_text = response_body;
        if (Buffer.isBuffer(response_body)) {
            body_text = response_body.toString('utf8');
        }
        const headers_for_log = response?.headers ? { ...response.headers } : undefined;
        const status_code = response?.statusCode;
        return {
            request_index,
            error_message,
            duration,
            status_code,
            response_headers: headers_for_log,
            response_body: body_text,
            request_options: sanitize_request_options_for_log(request_options, proxy_url),
            error_stack
        };
    }

    function log_trace_failure(failure, proxy) {
        script_logger.error('Trace failure.', {
            request_index: failure.request_index,
            duration_ms: failure.duration,
            error_message: failure.error_message,
            status_code: failure.status_code,
            proxy: proxy,
            request_options: failure.request_options,
            response_headers: failure.response_headers,
            response_body: failure.response_body,
            error_stack: failure.error_stack
        });
    }
}

main().catch((error) => {
    script_logger.error('Unhandled error during concurrent request load.', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exitCode = 1;
});
