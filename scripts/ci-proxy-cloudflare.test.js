import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo_root = resolve(__dirname, '..');

const cloudflare_test_url = process.env.CLOUDFLARE_TEST_URL || 'https://cloudflare.thehackerblog.com/';
const chrome_host = process.env.CHROME_DEBUGGING_HOST || '127.0.0.1';
const chrome_debugging_port = parse_integer_env(process.env.CHROME_DEBUGGING_PORT, 9222);
const http_proxy_port = parse_integer_env(process.env.HTTP_PROXY_PORT || process.env.THERMOPTIC_PROXY_PORT, 1234);
const xvfb_display = process.env.THERMOPTIC_TEST_DISPLAY || ':99';
const cdp_startup_timeout_ms = parse_integer_env(process.env.CDP_STARTUP_TIMEOUT_MS, 30000);
const curl_timeout_seconds = parse_integer_env(process.env.THERMOPTIC_TEST_CURL_TIMEOUT_SECONDS, 120);

const direct_challenge_markers = [
    'Verify you are human by completing the action below.',
    'Verifying you are human. This may take a few seconds',
    '/cdn-cgi/challenge-platform/',
    'Performing security verification',
    'This website uses a security service to protect against malicious bots.',
    'Verification successful. Waiting for',
    'window._cf_chl_opt',
    'cf-turnstile-response',
    'Just a moment...'
];

const interactive_challenge_markers = [
    'Verify you are human by completing the action below.',
    'cf-turnstile-response'
];

const required_solver_log_markers = [
    'Cloudflare challenge detected in proxied response, attempting browser solve.',
    'Replayed request after Cloudflare solve and replaced blocked response.',
    '"cf_clearance_present":true'
];

const click_solver_log_marker = 'Clicking Cloudflare challenge host to advance verification.';
const proxy_ready_log_marker = 'The thermoptic HTTP Proxy server is now running.';

function parse_integer_env(raw_value, fallback_value) {
    const parsed_value = Number.parseInt(raw_value || '', 10);
    if (Number.isFinite(parsed_value)) {
        return parsed_value;
    }
    return fallback_value;
}

function log_status(message, context = null) {
    if (context && Object.keys(context).length > 0) {
        console.log(`[STATUS] ${message}`, JSON.stringify(context));
        return;
    }

    console.log(`[STATUS] ${message}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize_text(text, max_length = 1600) {
    if (!text) {
        return '';
    }

    if (text.length <= max_length) {
        return text;
    }

    return text.slice(text.length - max_length);
}

function get_last_header_block(raw_headers_text) {
    if (!raw_headers_text) {
        return '';
    }

    const header_blocks = raw_headers_text
        .split(/\r?\n\r?\n/)
        .map((block) => block.trim())
        .filter(Boolean);

    if (header_blocks.length === 0) {
        return '';
    }

    return header_blocks[header_blocks.length - 1];
}

function parse_header_block(raw_header_block) {
    const parsed_headers = {
        status_code: null,
        status_line: '',
        headers: {}
    };

    if (!raw_header_block) {
        return parsed_headers;
    }

    const lines = raw_header_block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
        return parsed_headers;
    }

    parsed_headers.status_line = lines[0];

    const status_match = lines[0].match(/^HTTP\/[0-9.]+\s+(\d+)/i);
    if (status_match) {
        parsed_headers.status_code = Number.parseInt(status_match[1], 10);
    }

    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        const separator_index = line.indexOf(':');
        if (separator_index === -1) {
            continue;
        }

        const key = line.slice(0, separator_index).trim().toLowerCase();
        const value = line.slice(separator_index + 1).trim();
        parsed_headers.headers[key] = value;
    }

    return parsed_headers;
}

function contains_any_marker(text, markers) {
    if (!text) {
        return false;
    }

    return markers.some((marker) => text.includes(marker));
}

function create_process_capture(process_name) {
    return {
        process_name: process_name,
        full_output: '',
        append(chunk) {
            const text_chunk = chunk ? chunk.toString('utf8') : '';
            this.full_output += text_chunk;
            if (this.full_output.length > 240000) {
                this.full_output = this.full_output.slice(this.full_output.length - 240000);
            }
        },
        includes(pattern) {
            return this.full_output.includes(pattern);
        },
        tail() {
            return summarize_text(this.full_output, 8000);
        }
    };
}

function start_managed_process(process_name, command, args, options = {}) {
    const capture = create_process_capture(process_name);
    const child = spawn(command, args, {
        cwd: options.cwd || repo_root,
        env: {
            ...process.env,
            ...(options.env || {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => capture.append(chunk));
    child.stderr.on('data', (chunk) => capture.append(chunk));

    const exit_promise = new Promise((resolve_exit) => {
        child.once('exit', (code, signal) => {
            resolve_exit({
                code: code,
                signal: signal
            });
        });
    });

    return {
        name: process_name,
        child: child,
        capture: capture,
        exit_promise: exit_promise,
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            child.kill('SIGTERM');

            const exit_result = await Promise.race([
                exit_promise,
                sleep(10000).then(() => null)
            ]);

            if (!exit_result) {
                child.kill('SIGKILL');
                await exit_promise;
            }
        }
    };
}

async function wait_for_port(host, port, timeout_ms) {
    const deadline = Date.now() + timeout_ms;

    while (Date.now() < deadline) {
        const port_is_open = await new Promise((resolve) => {
            const socket = net.createConnection({
                host: host,
                port: port
            });

            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });

            socket.once('error', () => {
                socket.destroy();
                resolve(false);
            });

            socket.setTimeout(1000, () => {
                socket.destroy();
                resolve(false);
            });
        });

        if (port_is_open) {
            return;
        }

        await sleep(250);
    }

    throw new Error(`Timed out waiting for ${host}:${port} to accept connections.`);
}

async function wait_for_cdp(host, port, timeout_ms) {
    const deadline = Date.now() + timeout_ms;

    while (Date.now() < deadline) {
        const cdp_is_ready = await new Promise((resolve) => {
            const request = http.get(
                {
                    host: host,
                    port: port,
                    path: '/json/version',
                    timeout: 1500,
                    headers: {
                        host: '127.0.0.1'
                    }
                },
                (response) => {
                    let response_body = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => {
                        response_body += chunk || '';
                    });
                    response.on('end', () => {
                        if (response.statusCode !== 200) {
                            resolve(false);
                            return;
                        }

                        try {
                            const payload = JSON.parse(response_body || '{}');
                            resolve(Boolean(payload.Browser || payload.webSocketDebuggerUrl));
                        } catch {
                            resolve(false);
                        }
                    });
                }
            );

            request.on('timeout', () => {
                request.destroy(new Error('timeout'));
                resolve(false);
            });

            request.on('error', () => {
                resolve(false);
            });
        });

        if (cdp_is_ready) {
            return;
        }

        await sleep(250);
    }

    throw new Error(`Timed out waiting for CDP on ${host}:${port}.`);
}

async function wait_for_log_marker(process_handle, log_marker, timeout_ms) {
    const deadline = Date.now() + timeout_ms;

    while (Date.now() < deadline) {
        if (process_handle.capture.includes(log_marker)) {
            return;
        }

        const exit_result = await Promise.race([
            process_handle.exit_promise,
            sleep(250).then(() => null)
        ]);

        if (exit_result) {
            throw new Error(
                `${process_handle.name} exited before emitting the required log marker "${log_marker}".\n` +
                `${process_handle.name} log tail:\n${process_handle.capture.tail()}`
            );
        }
    }

    throw new Error(
        `Timed out waiting for ${process_handle.name} to emit "${log_marker}".\n` +
        `${process_handle.name} log tail:\n${process_handle.capture.tail()}`
    );
}

async function run_command(command, args, options = {}) {
    return new Promise((resolve_result, reject_result) => {
        const child = spawn(command, args, {
            cwd: options.cwd || repo_root,
            env: {
                ...process.env,
                ...(options.env || {})
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });

        child.once('error', (err) => {
            reject_result(err);
        });

        child.once('close', (code, signal) => {
            resolve_result({
                code: code,
                signal: signal,
                stdout: stdout,
                stderr: stderr
            });
        });
    });
}

async function start_local_probe_server() {
    const server = http.createServer((request, response) => {
        if (request.url !== '/proxy-health') {
            response.writeHead(404, {
                'Content-Type': 'text/plain'
            });
            response.end('not found');
            return;
        }

        response.writeHead(200, {
            'Content-Type': 'text/plain'
        });
        response.end('thermoptic proxy ok');
    });

    await new Promise((resolve_listen, reject_listen) => {
        server.once('error', reject_listen);
        server.listen(0, '127.0.0.1', resolve_listen);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to determine local probe server address.');
    }

    return {
        server: server,
        port: address.port,
        async close() {
            await new Promise((resolve_close) => {
                server.close(resolve_close);
            });
        }
    };
}

async function fetch_via_curl(artifacts_dir, name, url, options = {}) {
    const headers_path = join(artifacts_dir, `${name}.headers.txt`);
    const body_path = join(artifacts_dir, `${name}.body.txt`);
    const args = [
        '-sS',
        '--max-time',
        String(options.max_time_seconds || curl_timeout_seconds),
        '-D',
        headers_path,
        '-o',
        body_path
    ];

    if (options.insecure) {
        args.push('-k');
    }

    if (options.proxy_url) {
        args.push('--proxy', options.proxy_url);
    }

    args.push(url);

    const command_result = await run_command('curl', args, {
        env: options.env
    });

    const headers_text = await readFile(headers_path, 'utf8').catch(() => '');
    const body_text = await readFile(body_path, 'utf8').catch(() => '');
    const parsed_headers = parse_header_block(get_last_header_block(headers_text));

    return {
        command_result: command_result,
        headers_text: headers_text,
        body_text: body_text,
        parsed_headers: parsed_headers,
        headers_path: headers_path,
        body_path: body_path
    };
}

function assert_command_succeeded(command_result, description) {
    if (command_result.code === 0) {
        return;
    }

    throw new Error(
        `${description} failed with exit code ${command_result.code}.\n` +
        `stderr:\n${summarize_text(command_result.stderr, 4000)}`
    );
}

function assert_direct_challenge_response(fetch_result) {
    assert_command_succeeded(fetch_result.command_result, 'Baseline direct Cloudflare request');

    const headers = fetch_result.parsed_headers.headers;
    const body = fetch_result.body_text;

    if (headers.server !== 'cloudflare') {
        throw new Error(
            `Expected baseline response to come from Cloudflare, got server header "${headers.server || ''}".`
        );
    }

    if (!contains_any_marker(body, direct_challenge_markers)) {
        throw new Error(
            'Baseline direct request did not return a recognizable Cloudflare challenge body. ' +
            'The test site may have changed and the solver path would no longer be exercised.'
        );
    }

    if (headers['cf-mitigated'] !== 'challenge') {
        throw new Error(
            `Expected baseline response to include "cf-mitigated: challenge", got "${headers['cf-mitigated'] || ''}".`
        );
    }
}

function assert_basic_proxy_response(fetch_result) {
    assert_command_succeeded(fetch_result.command_result, 'Basic proxy probe request');

    if (fetch_result.body_text.trim() !== 'thermoptic proxy ok') {
        throw new Error(
            `Unexpected body from local proxy probe:\n${summarize_text(fetch_result.body_text, 1000)}`
        );
    }
}

function assert_solved_cloudflare_response(fetch_result) {
    assert_command_succeeded(fetch_result.command_result, 'Proxied Cloudflare request');

    const status_code = fetch_result.parsed_headers.status_code;
    if (status_code === null) {
        throw new Error(
            `Failed to parse the proxied Cloudflare status line.\nHeaders:\n${fetch_result.headers_text}`
        );
    }

    if ([403, 429, 503].includes(status_code)) {
        throw new Error(
            `Expected Cloudflare solve to avoid a challenge status, received ${status_code}.\n` +
            `Headers:\n${fetch_result.headers_text}\n\n` +
            `Body excerpt:\n${summarize_text(fetch_result.body_text, 3000)}`
        );
    }

    if ((fetch_result.parsed_headers.headers['cf-mitigated'] || '').toLowerCase().includes('challenge')) {
        throw new Error(
            `Expected proxied Cloudflare response to omit the challenge mitigation header.\nHeaders:\n${fetch_result.headers_text}`
        );
    }

    if (contains_any_marker(fetch_result.body_text, direct_challenge_markers)) {
        throw new Error(
            'Expected proxied Cloudflare response body to be cleared, but challenge markers were still present.\n' +
            `Body excerpt:\n${summarize_text(fetch_result.body_text, 3000)}`
        );
    }

}

function assert_solver_logs(proxy_process, direct_response_requires_click) {
    for (const required_marker of required_solver_log_markers) {
        if (!proxy_process.capture.includes(required_marker)) {
            throw new Error(
                `Expected proxy log to include "${required_marker}".\n` +
                `Proxy log tail:\n${proxy_process.capture.tail()}`
            );
        }
    }

    if (direct_response_requires_click && !proxy_process.capture.includes(click_solver_log_marker)) {
        throw new Error(
            `Expected proxy log to include "${click_solver_log_marker}" for the interactive challenge path.\n` +
            `Proxy log tail:\n${proxy_process.capture.tail()}`
        );
    }
}

async function ensure_runtime_tools_exist() {
    const checks = [
        run_command('bash', ['-lc', 'command -v curl']),
        run_command('bash', ['-lc', 'command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser'])
    ];

    if (!process.env.DISPLAY) {
        checks.push(run_command('bash', ['-lc', 'command -v Xvfb']));
    }

    const results = await Promise.all(checks);
    for (const result of results) {
        assert_command_succeeded(result, 'Runtime dependency check');
    }
}

async function main() {
    const temp_root = await mkdtemp(join(tmpdir(), 'thermoptic-ci-'));
    const temp_paths = {
        temp_root: temp_root,
        ca_dir: join(temp_root, 'ca'),
        artifacts_dir: join(temp_root, 'artifacts'),
        chrome_profile_dir: join(temp_root, 'chrome-profile'),
        xdg_runtime_dir: join(temp_root, 'xdg-runtime')
    };

    const managed_resources = [];
    let local_probe_server = null;

    try {
        await ensure_runtime_tools_exist();
        await mkdir(temp_paths.ca_dir, { recursive: true });
        await mkdir(temp_paths.artifacts_dir, { recursive: true });
        await mkdir(temp_paths.chrome_profile_dir, { recursive: true });
        await mkdir(temp_paths.xdg_runtime_dir, { recursive: true });

        log_status('Verifying that the Cloudflare test site still serves a challenge to plain curl.', {
            url: cloudflare_test_url
        });

        const direct_cloudflare_response = await fetch_via_curl(
            temp_paths.artifacts_dir,
            'direct-cloudflare',
            cloudflare_test_url
        );
        assert_direct_challenge_response(direct_cloudflare_response);

        const direct_response_requires_click = contains_any_marker(
            direct_cloudflare_response.body_text,
            interactive_challenge_markers
        );

        log_status('Starting display server for headful Chrome.', {
            display: process.env.DISPLAY || xvfb_display
        });

        if (!process.env.DISPLAY) {
            const xvfb_process = start_managed_process(
                'Xvfb',
                'Xvfb',
                [xvfb_display, '-screen', '0', '1920x1080x24', '-ac'],
                {
                    env: {
                        DISPLAY: xvfb_display
                    }
                }
            );
            managed_resources.push(xvfb_process);
            await sleep(1000);
        }

        const display_value = process.env.DISPLAY || xvfb_display;
        const chrome_command_result = await run_command('bash', [
            '-lc',
            'command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser'
        ]);
        assert_command_succeeded(chrome_command_result, 'Chrome binary lookup');
        const chrome_command = chrome_command_result.stdout.trim().split(/\r?\n/).filter(Boolean)[0];

        log_status('Launching Chrome for the CI smoke test.', {
            command: chrome_command,
            host: chrome_host,
            port: chrome_debugging_port
        });

        const chrome_process = start_managed_process(
            'Chrome',
            chrome_command,
            [
                `--remote-debugging-port=${chrome_debugging_port}`,
                '--remote-debugging-address=127.0.0.1',
                `--user-data-dir=${temp_paths.chrome_profile_dir}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-dev-shm-usage',
                '--disable-background-networking',
                '--disable-renderer-backgrounding',
                '--window-position=0,0',
                '--window-size=1920,1080',
                '--force-device-scale-factor=1',
                'about:blank'
            ],
            {
                env: {
                    DISPLAY: display_value,
                    XDG_RUNTIME_DIR: temp_paths.xdg_runtime_dir
                }
            }
        );
        managed_resources.push(chrome_process);

        await wait_for_cdp(chrome_host, chrome_debugging_port, cdp_startup_timeout_ms);

        log_status('Starting thermoptic with the Cloudflare after-request solver hook.');
        const proxy_process = start_managed_process(
            'thermoptic',
            process.execPath,
            [join(repo_root, 'server.js')],
            {
                env: {
                    CHROME_DEBUGGING_HOST: chrome_host,
                    CHROME_DEBUGGING_PORT: String(chrome_debugging_port),
                    HTTP_PROXY_PORT: String(http_proxy_port),
                    AFTER_REQUEST_HOOK_FILE_PATH: join(repo_root, 'hooks/afterrequest.js'),
                    THERMOPTIC_CA_DIR: temp_paths.ca_dir,
                    DEBUG: 'true'
                }
            }
        );
        managed_resources.push(proxy_process);

        await wait_for_log_marker(proxy_process, proxy_ready_log_marker, 30000);
        await wait_for_port('127.0.0.1', http_proxy_port, 10000);

        local_probe_server = await start_local_probe_server();

        log_status('Running a deterministic local proxy probe before the external Cloudflare solve test.', {
            port: local_probe_server.port
        });

        const proxy_url = `http://127.0.0.1:${http_proxy_port}`;
        const local_probe_result = await fetch_via_curl(
            temp_paths.artifacts_dir,
            'local-proxy-probe',
            `http://127.0.0.1:${local_probe_server.port}/proxy-health`,
            {
                proxy_url: proxy_url,
                max_time_seconds: 30
            }
        );
        assert_basic_proxy_response(local_probe_result);

        log_status('Running the proxied Cloudflare challenge solve and replay test.', {
            url: cloudflare_test_url
        });

        const proxied_cloudflare_result = await fetch_via_curl(
            temp_paths.artifacts_dir,
            'proxied-cloudflare',
            cloudflare_test_url,
            {
                proxy_url: proxy_url,
                insecure: true,
                max_time_seconds: curl_timeout_seconds
            }
        );
        assert_solved_cloudflare_response(proxied_cloudflare_result);

        assert_solver_logs(proxy_process, direct_response_requires_click);

        log_status('Replaying the Cloudflare request a second time to confirm the cleared session still works.');
        const replay_result = await fetch_via_curl(
            temp_paths.artifacts_dir,
            'proxied-cloudflare-replay',
            cloudflare_test_url,
            {
                proxy_url: proxy_url,
                insecure: true,
                max_time_seconds: 60
            }
        );
        assert_solved_cloudflare_response(replay_result);

        log_status('Proxy smoke test and Cloudflare solver validation completed successfully.', {
            final_status_code: proxied_cloudflare_result.parsed_headers.status_code,
            replay_status_code: replay_result.parsed_headers.status_code,
            challenge_required_click: direct_response_requires_click
        });
    } finally {
        if (local_probe_server) {
            await local_probe_server.close().catch(() => {});
        }

        for (let i = managed_resources.length - 1; i >= 0; i -= 1) {
            await managed_resources[i].stop().catch(() => {});
        }

        await rm(temp_root, {
            recursive: true,
            force: true
        }).catch(() => {});
    }
}

main().catch((err) => {
    console.error('[ERROR] CI proxy/Cloudflare smoke test failed.');
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
});
