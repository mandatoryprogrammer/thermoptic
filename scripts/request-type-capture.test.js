import http from 'http';
import net from 'net';
import { Buffer } from 'buffer';
import { EventEmitter } from 'events';

const DEFAULT_PROXY_HOST = process.env.THERMOPTIC_PROXY_HOST || process.env.HTTP_PROXY_HOST || '127.0.0.1';

const resolved_port = Number.parseInt(
    process.env.THERMOPTIC_PROXY_PORT ||
    process.env.HTTP_PROXY_PORT ||
    '1234',
    10
);
const DEFAULT_PROXY_PORT = Number.isFinite(resolved_port) ? resolved_port : 1234;

const DEFAULT_PROXY_USER = process.env.THERMOPTIC_PROXY_USERNAME || process.env.PROXY_USERNAME || 'changeme';
const DEFAULT_PROXY_PASS = process.env.THERMOPTIC_PROXY_PASSWORD || process.env.PROXY_PASSWORD || 'changeme';

function log_status(msg) {
    console.log(`[STATUS] ${msg}`);
}

async function start_capture_server() {
    const emitter = new EventEmitter();
    const requests = [];

    const server = http.createServer(async(req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async() => {
            const start_line = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
            const header_lines = [];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                header_lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            const body = Buffer.concat(chunks);

            const raw_request = `${start_line}\r\n${header_lines.join('\r\n')}\r\n\r\n${body.toString('latin1')}`;
            const entry = {
                method: req.method,
                path: req.url,
                raw: raw_request,
                timestamp: new Date()
            };
            requests.push(entry);
            emitter.emit('request', entry);

            // Serve fixtures for resource requests
            if (req.url === '/resource-script.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end('window.resource_script_loaded = true;');
                return;
            }
            if (req.url === '/resource-image.png') {
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000100ffff03000006000557bf0000000049454e44ae426082', 'hex'));
                return;
            }
            if (req.url === '/resource-style.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end('body { background: #eef; }');
                return;
            }
            if (req.url === '/resource-font.woff2') {
                res.writeHead(200, { 'Content-Type': 'font/woff2' });
                res.end(Buffer.from('774f46322d74657374', 'hex'));
                return;
            }
            if (req.url === '/resource-frame.html') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!doctype html><title>iframe resource</title>');
                return;
            }

            if (req.url === '/bundle') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!doctype html><title>bundle</title>');
                return;
            }

            if (req.url === '/manual-nav') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!doctype html><title>manual nav</title>');
                return;
            }

            if (req.url === '/form-submit') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('form ok');
                return;
            }

            if (req.url === '/fetch-call') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (req.url === '/resource-trigger') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Resource Trigger</title>
  <link rel="stylesheet" href="/resource-style.css">
  <style>
    @font-face {
      font-family: 'ThermopticFont';
      src: url('/resource-font.woff2');
    }
    body { font-family: 'ThermopticFont', sans-serif; }
  </style>
</head>
<body>
  <h1>Triggering resource requests…</h1>
  <img id="img-test" src="/resource-image.png" alt="resource img" />
  <iframe id="frame-test" src="/resource-frame.html" sandbox></iframe>
  <script>
    const script = document.createElement('script');
    script.src = '/resource-script.js?ts=' + Date.now();
    document.body.appendChild(script);
  </script>
</body>
</html>`);
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('captured');
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to determine capture server address.');
    }

    return { server, emitter, requests, port: address.port };
}

function encode_basic_auth(username, password) {
    const safe_user = username || 'changeme';
    const safe_pass = password || 'changeme';
    return Buffer.from(`${safe_user}:${safe_pass}`, 'utf8').toString('base64');
}

async function send_via_proxy({ proxy_host, proxy_port, proxy_auth, target_url, method, header_pairs, body }) {
    const url = new URL(target_url);
    const body_buffer = body ? Buffer.from(body, 'utf8') : null;

    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: proxy_host, port: proxy_port }, () => {
            const lines = [];
            lines.push(`${method.toUpperCase()} ${target_url} HTTP/1.1`);

            const headers = [];
            headers.push(['Host', url.host]);
            if (proxy_auth) {
                headers.push(['Proxy-Authorization', `Basic ${proxy_auth}`]);
            }
            headers.push(['Proxy-Connection', 'close']);
            headers.push(['Connection', 'close']);
            headers.push(['Accept', '*/*']);
            headers.push(['User-Agent', 'thermoptic-request-type-test/1.0']);
            headers.push(['Accept-Language', 'en-US,en;q=0.9']);

            if (Array.isArray(header_pairs)) {
                for (const [name, value] of header_pairs) {
                    headers.push([name, value]);
                }
            }

            const has_content_length = headers.some(([name]) => name.toLowerCase() === 'content-length');
            if (body_buffer && !has_content_length) {
                headers.push(['Content-Length', `${body_buffer.length}`]);
            }

            for (const [name, value] of headers) {
                lines.push(`${name}: ${value}`);
            }

            lines.push('');
            const request_payload = `${lines.join('\r\n')}\r\n`;
            socket.write(request_payload, 'utf8');

            if (body_buffer) {
                socket.write(body_buffer);
            }

            socket.end();
        });

        socket.setTimeout(20000);

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('Timed out waiting for proxy response.'));
        });

        const response_chunks = [];
        socket.on('data', chunk => response_chunks.push(chunk));
        socket.on('error', reject);
        socket.on('end', () => {
            const response_text = Buffer.concat(response_chunks).toString('utf8');
            resolve(response_text);
        });
    });
}

async function wait_for_request(emitter, requests, predicate, timeout_ms = 20000) {
    const existing = requests.find(predicate);
    if (existing) {
        return existing;
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for captured request.'));
        }, timeout_ms);

        function handler(entry) {
            if (predicate(entry)) {
                cleanup();
                resolve(entry);
            }
        }

        function cleanup() {
            clearTimeout(timeout);
            emitter.removeListener('request', handler);
        }

        emitter.on('request', handler);
    });
}

async function run() {
    const proxy_auth = encode_basic_auth(DEFAULT_PROXY_USER, DEFAULT_PROXY_PASS);
    const proxy_host = DEFAULT_PROXY_HOST;
    const proxy_port = DEFAULT_PROXY_PORT;

    const capture = await start_capture_server();
    const target_origin = `http://127.0.0.1:${capture.port}`;

    log_status(`Capture server listening on ${target_origin}`);
    log_status('Starting request variant replay. Ensure thermoptic proxy and debugging Chrome are running.');

    const variants = [
        {
            name: 'manual_browser_url_visit',
            method: 'GET',
            target_path: '/manual-nav',
            header_pairs: [
                ['Sec-Fetch-Dest', 'document'],
                ['Sec-Fetch-Mode', 'navigate'],
                ['Sec-Fetch-Site', 'none'],
                ['Sec-Fetch-User', '?1']
            ],
            body: ''
        },
        {
            name: 'form_submission',
            method: 'POST',
            target_path: '/form-submit',
            header_pairs: [
                ['Sec-Fetch-Dest', 'document'],
                ['Sec-Fetch-Mode', 'navigate'],
                ['Sec-Fetch-Site', 'same-origin'],
                ['Origin', target_origin],
                ['Referer', `${target_origin}/form`],
                ['Content-Type', 'application/x-www-form-urlencoded']
            ],
            body: 'field=value&next=1',
            expect_method: 'POST'
        },
        {
            name: 'fetch_request',
            method: 'POST',
            target_path: '/fetch-call',
            header_pairs: [
                ['Sec-Fetch-Dest', 'empty'],
                ['Sec-Fetch-Mode', 'cors'],
                ['Sec-Fetch-Site', 'same-origin'],
                ['Origin', target_origin],
                ['Referer', `${target_origin}/fetch`],
                ['Content-Type', 'application/json']
            ],
            body: JSON.stringify({ op: 'ping', timestamp: Date.now() }),
            expect_method: 'POST'
        }
    ];

    const resource_expectations = [
        { name: 'resource_request_script', path: '/resource-script.js', dest: 'script' },
        { name: 'resource_request_image', path: '/resource-image.png', dest: 'image' },
        { name: 'resource_request_style', path: '/resource-style.css', dest: 'style' },
        { name: 'resource_request_font', path: '/resource-font.woff2', dest: 'font' },
        { name: 'resource_request_iframe', path: '/resource-frame.html', dest: 'iframe' }
    ];

    variants.push({
        name: 'resource_request_trigger',
        method: 'GET',
        target_path: '/resource-trigger',
        header_pairs: [
            ['Sec-Fetch-Dest', 'document'],
            ['Sec-Fetch-Mode', 'navigate'],
            ['Sec-Fetch-Site', 'same-origin'],
            ['Sec-Fetch-User', '?1'],
            ['Referer', `${target_origin}/bundle`]
        ],
        body: ''
    });

    for (const variant of variants) {
        const target_url = `${target_origin}${variant.target_path}`;
        log_status(`Triggering ${variant.name} → ${target_url}`);

        const response = await send_via_proxy({
            proxy_host,
            proxy_port,
            proxy_auth,
            target_url,
            method: variant.method,
            header_pairs: variant.header_pairs,
            body: variant.body
        });

        console.log(`[INFO] Proxy response header for ${variant.name}: ${JSON.stringify(response.split('\r\n')[0])}`);
        console.log(`[DEBUG] Full proxy response for ${variant.name} (length ${response.length}):\n${response}`);

        if (variant.name === 'resource_request_trigger') {
            log_status('Dispatched resource trigger page; waiting for downstream resource requests.');
            continue;
        }

        const expected_method = variant.expect_method || variant.method.toUpperCase();
        const captured = await wait_for_request(
            capture.emitter,
            capture.requests,
            entry => entry.method === expected_method && entry.path && entry.path.split('?')[0] === variant.target_path
        );

        console.log(`[RESULT] Captured request for ${variant.name} (${captured.method} ${captured.path}):\n${captured.raw}\n`);
    }

    log_status('Waiting for resource request captures…');
    for (const resource of resource_expectations) {
        const resource_capture = await wait_for_request(
            capture.emitter,
            capture.requests,
            entry => entry.method === 'GET' && entry.path && entry.path.split('?')[0] === resource.path,
            30000
        );
        console.log(`[RESULT] Captured resource request (${resource.dest}):\n${resource_capture.raw}\n`);
    }

    capture.server.close();
    log_status('Capture server shut down.');
}

run().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(1);
});
