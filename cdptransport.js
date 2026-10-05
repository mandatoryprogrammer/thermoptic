import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { lookup } from 'node:dns/promises';

const require = createRequire(import.meta.url);
const cri_require = createRequire(require.resolve('chrome-remote-interface'));
const cri_version = cri_require('./package.json').version;
// CRI's public factory does not expose a client until the handshake completes.
// Keep the cancellable-constructor/transport integration isolated and fail clearly
// on an unreviewed upgrade instead of silently losing cancellation support.
if (cri_version !== '0.33.3') {
    throw new Error(`Unsupported chrome-remote-interface ${cri_version}; review cdptransport.js before upgrading from 0.33.3`);
}
// Preserve CRI's normal initialization, including its IPv4-first DNS preference.
cri_require('./index.js');
const Chrome = cri_require('./lib/chrome.js');
const closing_sessions = new WeakMap();

export function with_deadline(promise, deadline, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} deadline exceeded`));
        }, Math.max(0, deadline - Date.now()));
        timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
        clearTimeout(timer);
    });
}

export async function request_cdp(config, path, deadline, max_bytes = 8 * 1024 * 1024) {
    if (Date.now() >= deadline) {
        throw new Error(`CDP HTTP ${path} deadline exceeded`);
    }
    const { address } = await with_deadline(lookup(config.host, { verbatim: false }), deadline, 'CDP DNS lookup');
    if (Date.now() >= deadline) {
        throw new Error(`CDP HTTP ${path} deadline exceeded`);
    }
    return new Promise((resolve, reject) => {
        let timer = null;
        let settled = false;
        const chunks = [];
        let size = 0;
        const finish = (error, result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            req.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        };
        const req = request({ ...config, host: address, path: path, method: 'GET' }, (res) => {
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > max_bytes) {
                    finish(new Error('CDP HTTP response exceeded size limit'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            });
            res.on('error', (err) => { finish(err); });
            res.on('aborted', () => { finish(new Error('CDP HTTP response aborted')); });
        });
        timer = setTimeout(() => {
            finish(new Error(`CDP HTTP ${path} deadline exceeded`));
        }, Math.max(0, deadline - Date.now()));
        timer.unref();
        req.on('error', (err) => { finish(err); });
        req.end();
    });
}

export async function get_json(config, path, deadline) {
    const response = await request_cdp(config, path, deadline);
    if (response.status !== 200) {
        throw new Error(`CDP HTTP ${path} returned ${response.status}`);
    }
    return JSON.parse(response.body);
}

export function terminate_session(client) {
    if (client && client._ws) {
        client._ws.terminate();
    }
}

export async function close_session(client, deadline) {
    if (!client) {
        return;
    }
    // CRI.close() replaces its close listener; calling it twice can strand the
    // first waiter. All callers share one close operation per client.
    let closing = closing_sessions.get(client);
    if (!closing) {
        closing = Promise.resolve().then(() => client.close());
        closing_sessions.set(client, closing);
    }
    try {
        await with_deadline(closing, deadline, 'CDP transport close');
    } catch {
        terminate_session(client);
    }
}

export async function connect(config, target_id, deadline, protocol = null) {
    let websocket_url;
    if (target_id) {
        const targets = await get_json(config, '/json/list', deadline);
        if (!Array.isArray(targets)) {
            throw new Error('Invalid CDP target list');
        }
        const target = targets.find(item => item.id === target_id);
        if (!target) {
            throw new Error('No target with given id');
        }
        websocket_url = target.webSocketDebuggerUrl;
    } else {
        const version = await get_json(config, '/json/version', deadline);
        websocket_url = version.webSocketDebuggerUrl;
        if (typeof websocket_url !== 'string' || !websocket_url.includes('/devtools/browser/')) {
            throw new Error('CDP endpoint did not provide a browser WebSocket URL');
        }
    }
    if (typeof websocket_url !== 'string' || !/^wss?:\/\//.test(websocket_url)) {
        throw new Error('Invalid CDP WebSocket URL');
    }
    const descriptor = protocol || await get_json(config, '/json/protocol', deadline);
    if (!Array.isArray(descriptor.domains)) {
        throw new Error('Invalid CDP protocol descriptor');
    }
    if (Date.now() >= deadline) {
        throw new Error('CDP connection deadline exceeded');
    }
    const notifier = new EventEmitter();
    const ready = new Promise((resolve, reject) => {
        notifier.once('connect', resolve);
        // Keep this listener after timeout to consume a late handshake error.
        notifier.once('error', reject);
    });
    // Discovery and protocol loading are already complete and bounded. The only
    // remaining asynchronous setup is this client's owned WebSocket handshake.
    const client = new Chrome({ target: websocket_url, protocol: descriptor }, notifier);
    try {
        await with_deadline(ready, deadline, 'CDP connection');
        return client;
    } catch (err) {
        terminate_session(client);
        throw err;
    }
}
