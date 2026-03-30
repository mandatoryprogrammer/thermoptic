import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo_root = resolve(__dirname, '..');

const cloudflare_test_url = process.env.CLOUDFLARE_TEST_URL || 'https://cloudflare.thehackerblog.com/';
const standard_proxy_test_url = process.env.STANDARD_PROXY_TEST_URL || 'https://example.com/';
const http_proxy_port = parse_integer_env(process.env.HTTP_PROXY_PORT || process.env.THERMOPTIC_PROXY_PORT, 1234);
const curl_timeout_seconds = parse_integer_env(process.env.THERMOPTIC_TEST_CURL_TIMEOUT_SECONDS, 120);
const project_suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const compose_project_name = sanitize_project_name(`thermoptic-ci-${project_suffix}`);

const compose_files = [
    join(repo_root, 'docker-compose.yml'),
    join(repo_root, 'docker-compose.ci.yml')
];

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

function sanitize_project_name(project_name) {
    return project_name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
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

function summarize_text(text, max_length = 2000) {
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

function get_compose_env() {
    return {
        ...process.env,
        COMPOSE_PROJECT_NAME: compose_project_name
    };
}

function get_compose_args(args = []) {
    const file_args = [];
    for (const compose_file of compose_files) {
        file_args.push('-f', compose_file);
    }
    return ['compose', ...file_args, ...args];
}

async function run_command(command, args, options = {}) {
    return new Promise((resolve_result, reject_result) => {
        const child = spawn(command, args, {
            cwd: options.cwd || repo_root,
            env: {
                ...(options.env || process.env)
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

async function docker_compose(args, options = {}) {
    return run_command('docker', get_compose_args(args), {
        cwd: options.cwd || repo_root,
        env: options.env || get_compose_env()
    });
}

function assert_command_succeeded(command_result, description) {
    if (command_result.code === 0) {
        return;
    }

    throw new Error(
        `${description} failed with exit code ${command_result.code}.\n` +
        `stdout:\n${summarize_text(command_result.stdout, 5000)}\n\n` +
        `stderr:\n${summarize_text(command_result.stderr, 5000)}`
    );
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
        env: options.env || process.env
    });

    const headers_text = await readFile(headers_path, 'utf8').catch(() => '');
    const body_text = await readFile(body_path, 'utf8').catch(() => '');
    const parsed_headers = parse_header_block(get_last_header_block(headers_text));

    return {
        command_result: command_result,
        headers_text: headers_text,
        body_text: body_text,
        parsed_headers: parsed_headers
    };
}

async function ensure_runtime_tools_exist() {
    const checks = await Promise.all([
        run_command('bash', ['-lc', 'command -v docker']),
        run_command('bash', ['-lc', 'docker compose version']),
        run_command('bash', ['-lc', 'command -v curl'])
    ]);

    for (const result of checks) {
        assert_command_succeeded(result, 'Runtime dependency check');
    }
}

async function get_compose_logs(service_name) {
    const logs_result = await docker_compose(['logs', '--no-color', '--timestamps', service_name]);
    assert_command_succeeded(logs_result, `docker compose logs ${service_name}`);
    return `${logs_result.stdout || ''}${logs_result.stderr || ''}`;
}

async function wait_for_service_log_marker(service_name, log_marker, timeout_ms) {
    const deadline = Date.now() + timeout_ms;

    while (Date.now() < deadline) {
        const logs_text = await get_compose_logs(service_name);
        if (logs_text.includes(log_marker)) {
            return logs_text;
        }

        await sleep(1000);
    }

    const logs_text = await get_compose_logs(service_name);
    throw new Error(
        `Timed out waiting for ${service_name} to emit "${log_marker}".\n` +
        `${service_name} log tail:\n${summarize_text(logs_text, 8000)}`
    );
}

async function wait_for_proxy_port(proxy_url, timeout_ms) {
    const deadline = Date.now() + timeout_ms;

    while (Date.now() < deadline) {
        const probe_result = await run_command('curl', [
            '-sS',
            '-k',
            '--proxy',
            proxy_url,
            '--max-time',
            '20',
            '-o',
            '/dev/null',
            standard_proxy_test_url
        ]).catch(() => null);

        if (probe_result && probe_result.code === 0) {
            return;
        }

        await sleep(1000);
    }

    throw new Error(`Timed out waiting for thermoptic to answer on ${proxy_url}.`);
}

function assert_standard_proxy_response(fetch_result) {
    assert_command_succeeded(fetch_result.command_result, 'Standard proxy request');

    const status_code = fetch_result.parsed_headers.status_code;
    if (status_code !== 200) {
        throw new Error(
            `Expected standard proxy request to return 200, received ${status_code}.\n` +
            `Headers:\n${fetch_result.headers_text}\n\n` +
            `Body excerpt:\n${summarize_text(fetch_result.body_text, 2000)}`
        );
    }

    if (!fetch_result.body_text.includes('Example Domain')) {
        throw new Error(
            'Expected the standard proxy request body to contain "Example Domain".\n' +
            `Body excerpt:\n${summarize_text(fetch_result.body_text, 2000)}`
        );
    }
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

function assert_solver_logs(logs_text, direct_response_requires_click) {
    for (const required_marker of required_solver_log_markers) {
        if (!logs_text.includes(required_marker)) {
            throw new Error(
                `Expected thermoptic log to include "${required_marker}".\n` +
                `Log tail:\n${summarize_text(logs_text, 10000)}`
            );
        }
    }

    if (direct_response_requires_click && !logs_text.includes(click_solver_log_marker)) {
        throw new Error(
            `Expected thermoptic log to include "${click_solver_log_marker}" for the interactive challenge path.\n` +
            `Log tail:\n${summarize_text(logs_text, 10000)}`
        );
    }
}

async function print_service_logs(service_name) {
    try {
        const logs_text = await get_compose_logs(service_name);
        console.error(`[${service_name} logs]`);
        console.error(summarize_text(logs_text, 12000));
    } catch (err) {
        console.error(`[WARN] Failed to collect logs for ${service_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function main() {
    const temp_root = await mkdtemp(join(tmpdir(), 'thermoptic-ci-'));
    const proxy_url = `http://127.0.0.1:${http_proxy_port}`;
    let stack_started = false;

    try {
        await ensure_runtime_tools_exist();

        log_status('Verifying that the Cloudflare test site still serves a challenge to plain curl.', {
            url: cloudflare_test_url
        });
        const direct_cloudflare_response = await fetch_via_curl(
            temp_root,
            'direct-cloudflare',
            cloudflare_test_url
        );
        assert_direct_challenge_response(direct_cloudflare_response);

        const direct_response_requires_click = contains_any_marker(
            direct_cloudflare_response.body_text,
            interactive_challenge_markers
        );

        log_status('Building the docker compose stack for the CI smoke test.', {
            project: compose_project_name
        });
        const build_result = await docker_compose(['build']);
        assert_command_succeeded(build_result, 'docker compose build');

        log_status('Starting the docker compose stack.');
        const up_result = await docker_compose(['up', '-d']);
        assert_command_succeeded(up_result, 'docker compose up -d');
        stack_started = true;

        await wait_for_service_log_marker('thermoptic', proxy_ready_log_marker, 120000);
        await wait_for_proxy_port(proxy_url, 120000);

        log_status('Running a standard proxied request through the dockerized thermoptic instance.', {
            url: standard_proxy_test_url
        });
        const standard_proxy_response = await fetch_via_curl(
            temp_root,
            'standard-proxy',
            standard_proxy_test_url,
            {
                proxy_url: proxy_url,
                insecure: true,
                max_time_seconds: 60
            }
        );
        assert_standard_proxy_response(standard_proxy_response);

        log_status('Running the proxied Cloudflare challenge solve against the docker compose stack.', {
            url: cloudflare_test_url
        });
        const proxied_cloudflare_result = await fetch_via_curl(
            temp_root,
            'proxied-cloudflare',
            cloudflare_test_url,
            {
                proxy_url: proxy_url,
                insecure: true,
                max_time_seconds: curl_timeout_seconds
            }
        );
        assert_solved_cloudflare_response(proxied_cloudflare_result);

        log_status('Replaying the Cloudflare request a second time to confirm the cleared session still works.');
        const replay_result = await fetch_via_curl(
            temp_root,
            'proxied-cloudflare-replay',
            cloudflare_test_url,
            {
                proxy_url: proxy_url,
                insecure: true,
                max_time_seconds: 60
            }
        );
        assert_solved_cloudflare_response(replay_result);

        const thermoptic_logs = await get_compose_logs('thermoptic');
        assert_solver_logs(thermoptic_logs, direct_response_requires_click);

        log_status('Docker compose build and runtime smoke test completed successfully.', {
            standard_status_code: standard_proxy_response.parsed_headers.status_code,
            final_status_code: proxied_cloudflare_result.parsed_headers.status_code,
            replay_status_code: replay_result.parsed_headers.status_code,
            challenge_required_click: direct_response_requires_click
        });
    } catch (err) {
        if (stack_started) {
            await print_service_logs('thermoptic');
            await print_service_logs('chrome');
            await print_service_logs('proxyrouter');
        }

        console.error('[ERROR] Docker compose proxy/Cloudflare smoke test failed.');
        console.error(err instanceof Error ? err.stack || err.message : String(err));
        process.exitCode = 1;
    } finally {
        if (stack_started) {
            const down_result = await docker_compose(['down', '-v', '--remove-orphans']).catch((err) => ({
                code: 1,
                stdout: '',
                stderr: err instanceof Error ? err.message : String(err)
            }));

            if (down_result.code !== 0) {
                console.error('[WARN] docker compose down failed.');
                console.error(summarize_text(`${down_result.stdout || ''}\n${down_result.stderr || ''}`, 4000));
            }
        }

        await rm(temp_root, {
            recursive: true,
            force: true
        }).catch(() => {});
    }

    if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
    }
}

main().catch((err) => {
    console.error('[ERROR] Docker compose proxy/Cloudflare smoke test crashed unexpectedly.');
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
});
