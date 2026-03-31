import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repo_root = path.resolve(__dirname, '..');

const compose_project_name = `thermoptic-ci-${Date.now()}`;
const compose_file_paths = [
    path.join(repo_root, 'docker-compose.yml'),
    path.join(repo_root, 'docker-compose.ci.yml')
];

const example_url = 'https://example.com/';
const cloudflare_url = 'https://cloudflare.thehackerblog.com/';
const proxy_url = 'http://127.0.0.1:1234';

const proxy_ready_attempts = 30;
const proxy_ready_interval_ms = 5000;
const cloudflare_request_timeout_seconds = 180;

const challenge_status_codes = new Set([403, 429, 503]);
const challenge_markers = [
    '/cdn-cgi/challenge-platform/',
    'Verify you are human by completing the action below.',
    'Verifying you are human. This may take a few seconds',
    'Performing security verification',
    'This website uses a security service to protect against malicious bots.',
    'Verification successful. Waiting for',
    'window._cf_chl_opt',
    'cf-turnstile-response',
    '<title>Just a moment...</title>'
];

function log_status(message, meta = null) {
    if (!meta) {
        console.log(`[STATUS] ${message}`);
        return;
    }

    console.log(`[STATUS] ${message} ${JSON.stringify(meta)}`);
}

function log_warn(message, meta = null) {
    if (!meta) {
        console.error(`[WARN] ${message}`);
        return;
    }

    console.error(`[WARN] ${message} ${JSON.stringify(meta)}`);
}

function log_phase(phase, message, meta = null) {
    log_status(`[${phase}] ${message}`, meta);
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function get_compose_args(extra_args) {
    const args = ['compose', '-p', compose_project_name];

    for (const compose_file_path of compose_file_paths) {
        args.push('-f', compose_file_path);
    }

    for (const extra_arg of extra_args) {
        args.push(extra_arg);
    }

    return args;
}

async function run_command(command, args, options = {}) {
    const {
        cwd = repo_root,
        env = process.env,
        inherit_stdio = false,
        allow_failure = false
    } = options;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd,
            env: env,
            stdio: inherit_stdio ? 'inherit' : ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        if (!inherit_stdio && child.stdout) {
            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString('utf8');
            });
        }

        if (!inherit_stdio && child.stderr) {
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString('utf8');
            });
        }

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0 || allow_failure) {
                resolve({
                    code: code,
                    stdout: stdout,
                    stderr: stderr
                });
                return;
            }

            const error = new Error(
                `${command} ${args.join(' ')} exited with code ${code}.`
            );
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
        });
    });
}

async function run_compose(extra_args, options = {}) {
    return run_command('docker', get_compose_args(extra_args), options);
}

function parse_header_map(raw_headers) {
    const header_map = {};
    const normalized = raw_headers.replace(/\r\n/g, '\n');
    const header_blocks = normalized
        .split(/\n\n+/)
        .map((block) => block.trim())
        .filter((block) => block !== '');

    const last_block = header_blocks.length > 0 ? header_blocks[header_blocks.length - 1] : '';
    const lines = last_block.split('\n');

    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index];
        const separator_index = line.indexOf(':');
        if (separator_index === -1) {
            continue;
        }

        const key = line.slice(0, separator_index).trim().toLowerCase();
        const value = line.slice(separator_index + 1).trim();
        header_map[key] = value;
    }

    return header_map;
}

function extract_title_text(html) {
    if (!html || typeof html !== 'string') {
        return '';
    }

    const title_match = html.match(/<title>([^<]*)<\/title>/i);
    if (!title_match) {
        return '';
    }

    return title_match[1].trim();
}

function build_response_summary(response, extra = {}) {
    if (!response || typeof response !== 'object') {
        return {
            ...extra,
            status_code: null,
            title: '',
            server: '',
            cf_mitigated: '',
            challenge_detected: false
        };
    }

    return {
        ...extra,
        status_code: response.status_code,
        title: response.title || '',
        server: response.headers?.server || '',
        cf_mitigated: response.headers?.['cf-mitigated'] || '',
        challenge_detected: is_cloudflare_challenge_response(response)
    };
}

function is_cloudflare_challenge_response(response) {
    if (!response || typeof response !== 'object') {
        return false;
    }

    const server_header = response.headers.server ? response.headers.server.toLowerCase() : '';
    const mitigated_header = response.headers['cf-mitigated'] ? response.headers['cf-mitigated'].toLowerCase() : '';
    const normalized_body = response.body ? response.body.toLowerCase() : '';
    const contains_marker = challenge_markers.some((marker) => normalized_body.includes(marker.toLowerCase()));
    const status_matches = challenge_status_codes.has(response.status_code);

    if (server_header && !server_header.includes('cloudflare')) {
        return false;
    }

    if (!contains_marker) {
        return false;
    }

    if (!status_matches && !mitigated_header.includes('challenge')) {
        return false;
    }

    return true;
}

async function fetch_url_with_curl({ url, proxy = '', insecure = false, max_time_seconds = 60 }) {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), 'thermoptic-ci-'));
    const header_path = path.join(temp_root, 'headers.txt');
    const body_path = path.join(temp_root, 'body.txt');
    const curl_args = [
        '--silent',
        '--show-error',
        '--location',
        '--max-time',
        String(max_time_seconds),
        '--dump-header',
        header_path,
        '--output',
        body_path,
        '--write-out',
        '%{http_code}',
        url
    ];

    if (proxy) {
        curl_args.unshift('--proxy', proxy);
    }

    if (insecure) {
        curl_args.unshift('--insecure');
    }

    const command_env = {
        ...process.env,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        NO_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        no_proxy: ''
    };

    try {
        const result = await run_command('curl', curl_args, {
            cwd: repo_root,
            env: command_env
        });
        const raw_headers = await fs.readFile(header_path, 'utf8');
        const body_buffer = await fs.readFile(body_path);
        const body_text = body_buffer.toString('utf8');
        const status_code = Number.parseInt(result.stdout.trim(), 10);

        return {
            status_code: Number.isFinite(status_code) ? status_code : 0,
            raw_headers: raw_headers,
            headers: parse_header_map(raw_headers),
            body: body_text,
            title: extract_title_text(body_text)
        };
    } finally {
        await fs.rm(temp_root, { recursive: true, force: true });
    }
}

function assert_example_domain_response(response) {
    if (!response || response.status_code !== 200) {
        throw new Error(`Expected example.com to return HTTP 200 through the proxy, received ${response ? response.status_code : 'unknown'}.`);
    }

    if (!response.body.includes('Example Domain')) {
        throw new Error('Expected example.com response body to contain "Example Domain".');
    }
}

function assert_cloudflare_response_unblocked(response, label) {
    if (!response) {
        throw new Error(`${label} did not produce a response.`);
    }

    if (!Number.isFinite(response.status_code) || response.status_code <= 0) {
        throw new Error(`${label} did not produce a valid HTTP status code.`);
    }

    if (is_cloudflare_challenge_response(response)) {
        throw new Error(`${label} still returned a Cloudflare challenge page.`);
    }
}

function count_occurrences(haystack, needle) {
    if (!haystack || !needle) {
        return 0;
    }

    let occurrence_count = 0;
    let search_start_index = 0;

    while (true) {
        const found_index = haystack.indexOf(needle, search_start_index);
        if (found_index === -1) {
            break;
        }

        occurrence_count += 1;
        search_start_index = found_index + needle.length;
    }

    return occurrence_count;
}

async function ensure_ssl_directory() {
    await fs.mkdir(path.join(repo_root, 'ssl'), { recursive: true });
}

async function wait_for_proxy_readiness() {
    log_phase('proxy-readiness', 'Waiting for the thermoptic proxy to answer a proxied request.', {
        proxy_url: proxy_url,
        probe_url: example_url,
        max_attempts: proxy_ready_attempts
    });

    for (let attempt = 1; attempt <= proxy_ready_attempts; attempt += 1) {
        try {
            const response = await fetch_url_with_curl({
                url: example_url,
                proxy: proxy_url,
                insecure: true,
                max_time_seconds: 30
            });

            assert_example_domain_response(response);
            log_phase('proxy-readiness', 'Proxy route smoke test succeeded.', {
                attempt: attempt,
                ...build_response_summary(response, {
                    proxy_url: proxy_url,
                    probe_url: example_url
                })
            });
            return;
        } catch (error) {
            log_warn('[proxy-readiness] Proxy is not ready yet.', {
                attempt: attempt,
                max_attempts: proxy_ready_attempts,
                proxy_url: proxy_url,
                probe_url: example_url,
                message: error instanceof Error ? error.message : String(error)
            });

            if (attempt === proxy_ready_attempts) {
                throw error;
            }

            await sleep(proxy_ready_interval_ms);
        }
    }
}

async function dump_compose_diagnostics() {
    log_warn('[diagnostics] Dumping docker compose service state and recent logs.');
    const compose_ps = await run_compose(['ps'], {
        allow_failure: true
    });
    const compose_logs = await run_compose(['logs', '--no-color', '--tail', '250'], {
        allow_failure: true
    });

    if (compose_ps.stdout) {
        console.log(compose_ps.stdout);
    }
    if (compose_ps.stderr) {
        console.error(compose_ps.stderr);
    }
    if (compose_logs.stdout) {
        console.log(compose_logs.stdout);
    }
    if (compose_logs.stderr) {
        console.error(compose_logs.stderr);
    }
}

async function verify_cloudflare_hook_flow() {
    log_phase('cloudflare-direct', 'Verifying the target presents a Cloudflare challenge to a direct HTTP client.', {
        target_url: cloudflare_url
    });
    const direct_response = await fetch_url_with_curl({
        url: cloudflare_url,
        max_time_seconds: 30
    });

    if (!is_cloudflare_challenge_response(direct_response)) {
        throw new Error(`Expected a direct request to ${cloudflare_url} to be challenged, but received HTTP ${direct_response.status_code} with title "${direct_response.title}".`);
    }

    log_phase('cloudflare-direct', 'Direct request returned a Cloudflare challenge as expected.', build_response_summary(direct_response, {
        target_url: cloudflare_url
    }));

    log_phase('cloudflare-proxy-first', 'Issuing the first proxied request to trigger the Cloudflare after-request solver.', {
        target_url: cloudflare_url,
        proxy_url: proxy_url,
        timeout_seconds: cloudflare_request_timeout_seconds
    });
    const first_proxied_response = await fetch_url_with_curl({
        url: cloudflare_url,
        proxy: proxy_url,
        insecure: true,
        max_time_seconds: cloudflare_request_timeout_seconds
    });
    assert_cloudflare_response_unblocked(first_proxied_response, 'First Cloudflare request');

    log_phase('cloudflare-proxy-first', 'First proxied request completed without a Cloudflare challenge.', build_response_summary(first_proxied_response, {
        target_url: cloudflare_url,
        proxy_url: proxy_url
    }));

    log_phase('cloudflare-proxy-second', 'Issuing the second proxied request to verify future requests remain unblocked.', {
        target_url: cloudflare_url,
        proxy_url: proxy_url,
        timeout_seconds: cloudflare_request_timeout_seconds
    });
    const second_proxied_response = await fetch_url_with_curl({
        url: cloudflare_url,
        proxy: proxy_url,
        insecure: true,
        max_time_seconds: cloudflare_request_timeout_seconds
    });
    assert_cloudflare_response_unblocked(second_proxied_response, 'Second Cloudflare request');

    log_phase('cloudflare-proxy-second', 'Second proxied request completed without a Cloudflare challenge.', build_response_summary(second_proxied_response, {
        target_url: cloudflare_url,
        proxy_url: proxy_url
    }));

    log_phase('cloudflare-log-check', 'Inspecting thermoptic service logs to confirm the challenge was solved exactly once.');
    const thermoptic_logs = await run_compose(['logs', '--no-color', 'thermoptic']);
    const all_logs = `${thermoptic_logs.stdout}\n${thermoptic_logs.stderr}`;
    const challenge_detection_message = 'Cloudflare challenge detected in proxied response, attempting browser solve.';
    const replay_message = 'Replayed request after Cloudflare solve and replaced blocked response.';
    const challenge_detection_count = count_occurrences(all_logs, challenge_detection_message);
    const replay_count = count_occurrences(all_logs, replay_message);

    if (challenge_detection_count !== 1) {
        throw new Error(`Expected exactly one Cloudflare challenge solve attempt, observed ${challenge_detection_count}.`);
    }

    if (replay_count !== 1) {
        throw new Error(`Expected exactly one replayed response after the Cloudflare solve, observed ${replay_count}.`);
    }

    log_phase('cloudflare-log-check', 'Thermoptic logs confirmed a single solve and replay cycle.', {
        challenge_detection_count: challenge_detection_count,
        replay_count: replay_count
    });

    log_phase('cloudflare-summary', 'Cloudflare after-request solver verified successfully.', {
        target_url: cloudflare_url,
        first_status_code: first_proxied_response.status_code,
        second_status_code: second_proxied_response.status_code,
        first_title: first_proxied_response.title,
        second_title: second_proxied_response.title
    });
}

async function main() {
    await ensure_ssl_directory();

    try {
        log_phase('setup', 'Prepared local runtime directories for the compose stack.', {
            ssl_directory: path.join(repo_root, 'ssl')
        });

        log_phase('compose-up', 'Starting the docker compose stack for CI validation.', {
            compose_project_name: compose_project_name
        });
        await run_compose(['up', '--build', '-d'], {
            inherit_stdio: true
        });

        log_phase('compose-ps', 'Printing docker compose service state after startup.');
        await run_compose(['ps'], {
            inherit_stdio: true
        });

        await wait_for_proxy_readiness();
        await verify_cloudflare_hook_flow();
    } catch (error) {
        log_warn('[failure] Compose CI validation failed, dumping diagnostics.', {
            message: error instanceof Error ? error.message : String(error)
        });
        await dump_compose_diagnostics();
        throw error;
    } finally {
        log_phase('teardown', 'Stopping and removing the docker compose stack.', {
            compose_project_name: compose_project_name
        });
        await run_compose(['down', '-v', '--remove-orphans'], {
            allow_failure: true,
            inherit_stdio: true
        });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
