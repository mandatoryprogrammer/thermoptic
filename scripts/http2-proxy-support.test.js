import http2 from 'http2';
import net from 'net';
import tls from 'tls';
import { once } from 'events';

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

const TEST_SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC9/j8X8z/IMfOS
ZZvGbbA5QbL/+GF/PJ+O4ngJrabKAGxy/4oMPrs0g8tYtTq/wRa5dLu8x2HBOQ4s
zAenSh1DbIz7b7e8XA4QyraPW8C8E8P2qMGvDeC/XQAMp3WaQBWIIXPEPMYz/7Y+
jEPb6UzNRVj/lZB+VVp4HmhiAUvYdkNZYtxin1y43UCqvql3623gIwigX6/+mvGI
cpCLFKVSyN32RS82SlTHj48rrYipDQzOPRuQD1VKmvIqgZ1YgoTiP8W0eCYYpRhS
FBQ0aZ4zDahl1dKLICopTDZCQEyZG20iR9Rn5UOrZPO1Ltet/EIxAPGvBsGDLAnv
zmagGk95AgMBAAECggEAAfjJCS5uRjLKhIWccRnt/xzLnEokzOVsAdd03SOEZx/2
VYKJxBMZ7fNuNqykKvL4kZKAvkv9cObEMGUqW9XyPs26GtlFJBB6hDnDskeGqmJe
zB5ilYwEffKbpQX55lDC8xznGYLIoH0yFC0a09tJ1O7i0RLpeH4vSFmHG3lITbtL
50ENorHGZI1qyK6x3cXyLuzesp0OxOwxCdiNYFw9P52SKt/sutYiKTQome20zaFD
eu/Tf6PhJ9AkvX3w4vQHt5hJYlLP1AtKp8YRDTHcnIwRQDHyfsswXeUU36Nbp2Dz
KjuGgo0q+omm0o98V1lOPpa+03vupN9umMtSutwAuQKBgQDgDH/7fhwNI6Yt2oEH
DaKjb/I09oLG5XGRQqrli7prYkxn+MSgZUMQOqH2h6XLMvLdRUDi5eDliXCxBii9
JYrBleuiWJlAL72S9AellVGhf5KixjbXCf9W3rIoqYMjjhu6DYYiXwHoxTCobvG8
HSz9/NxlgXQ+tAnAvsWXH5ulHQKBgQDZFnQDjToSjJE3CKSOOm3xcRyU4JezeMbH
kwdhYrxLbtQ9HWWbg9wMR84d2Ityr7nKlxwMtDOIJYunVycdNlLoYxkeDFGCyc7b
GCWW+9dCncV+2BDkA/nPTtL5MIU4ktUW8N3FE1wZNOGLHbmJp+bRUpIK/m2D0s5t
fVgHc2wRDQKBgQCuznHoictfIQpeSlZTZ3sWo5hJZHBCuO/z0x09fdiUQhy1Hm5j
ar55YhXOIKXltbmxlH/8yDjBPovTQqf0c98gDVXM0+22G8mAZ6+zrJ4FMGD7aUWO
X/l+EMDWYvOzgQP3FOgr1w7JS1kcgXtQNz9MZ8aZ1/gXmCbn4LCPqZSprQKBgQCI
r0p8sf9OjpMgQ6DYrJFs4/tLAd6Cchk2r6yF9NT56d5YXJoNQQjb8pok0KN8oogo
ttxCY3PO1VUJGCbYjcvF5h96e+cWolpMOPfyCL+QgiZHp2N7LcWsccUEgThgVpM0
zpPT8kya0mDwZtbbhYwfYA30Ph5WUfUHm1RB3Lq+QQKBgQDLPLr5p987h78SLgmW
aOPVmgChCvaVk6IAP0X7vcfYUVD5ZK6Z7V4u99qv06/htvqA2lxqM4TWo54o0mTU
wrXedz3ONV89Ti7IJV7WrJLTj85O9uV3TN9Y8F4YKHcFODXOITwfXeQnXA/LBxPA
ZUOgXqgdtN1XbtzAH7BehdAo5Q==\n-----END PRIVATE KEY-----`;

const TEST_SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUFfYrRaBcxJCIRbTENRjePPGJTIswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI1MTAzMTE4MDUwNVoXDTI1MTEw
MTE4MDUwNVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAvf4/F/M/yDHzkmWbxm2wOUGy//hhfzyfjuJ4Ca2mygBs
cv+KDD67NIPLWLU6v8EWuXS7vMdhwTkOLMwHp0odQ2yM+2+3vFwOEMq2j1vAvBPD
9qjBrw3gv10ADKd1mkAViCFzxDzGM/+2PoxD2+lMzUVY/5WQflVaeB5oYgFL2HZD
WWLcYp9cuN1Aqr6pd+tt4CMIoF+v/prxiHKQixSlUsjd9kUvNkpUx4+PK62IqQ0M
zj0bkA9VSpryKoGdWIKE4j/FtHgmGKUYUhQUNGmeMw2oZdXSiyAqKUw2QkBMmRtt
IkfUZ+VDq2TztS7XrfxCMQDxrwbBgywJ785moBpPeQIDAQABo1MwUTAdBgNVHQ4E
FgQU9raU8MuR3P3aUq0pTyGqZsJagbIwHwYDVR0jBBgwFoAU9raU8MuR3P3aUq0p
TyGqZsJagbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEABe7t
u7x269U9JpgU1tUJIXmw69x61eGlqy2V+nsWJwD0p2LKCnj7fav0FzW5kgJUVyon
yqun8i8wGaQVyF8FE8pyBhNYPt2SZ8/IxUQllOnTD2hK6c/O/xeMrcOmP9kzWmWY
9/SWjdLQ9375MdGua3GFjgFUHG248PDdzOzqjI3upJ1JyJ9iUVOHPHPStUMnOk1V
kxVDGDMnTYbZgYovgcbqqEenDJtKAnDkI+Gy/Gx0DJ8hCbeXH3pHmG7GYnqRLmA/
8cAJKOnbj80AQXnraWOfQqneCFxXOCUhbtUydGhqgT+BUpExCJ0VMji9ZPjhxfM7
82AVjSUiOBPNxXSKTw==
-----END CERTIFICATE-----`;

function log_status(message) {
    console.log(`[STATUS] ${message}`);
}

function log_warn(message) {
    console.error(`[WARN] ${message}`);
}

function encode_basic_auth(username, password) {
    const safe_user = username || 'changeme';
    const safe_pass = password || 'changeme';
    return Buffer.from(`${safe_user}:${safe_pass}`, 'utf8').toString('base64');
}

async function start_http2_probe_server() {
    return new Promise((resolve, reject) => {
        const server = http2.createSecureServer({
            key: TEST_SERVER_KEY,
            cert: TEST_SERVER_CERT,
            allowHTTP1: true
        });

        let last_request = null;

        server.on('stream', (stream, headers) => {
            last_request = {
                protocol: 'h2',
                method: headers[':method'] || '',
                path: headers[':path'] || ''
            };
            stream.respond({
                ':status': 200,
                'content-type': 'application/json'
            });
            stream.end(JSON.stringify({ ok: true, protocol: 'h2' }));
        });

        server.on('request', (req, res) => {
            last_request = {
                protocol: 'http/1.1',
                method: req.method || '',
                path: req.url || ''
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, protocol: 'http/1.1' }));
        });

        server.on('session', (session) => {
            session.on('error', (err) => {
                log_warn(`HTTP/2 session error: ${err.message}`);
            });
        });

        const handle_error = (err) => {
            reject(err);
        };

        server.once('error', handle_error);

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to determine HTTP/2 server address.'));
                return;
            }
            server.off('error', handle_error);
            resolve({
                port: address.port,
                get_last_request() {
                    return last_request;
                },
                async stop() {
                    await new Promise((resolve_stop) => server.close(resolve_stop));
                }
            });
        });
    });
}

async function create_tls_socket_through_proxy({ proxy_host, proxy_port, proxy_auth, target_host, target_port }) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: proxy_host, port: proxy_port });
        let finished = false;
        let response_buffer = '';

        function cleanup() {
            socket.removeListener('connect', on_connect);
            socket.removeListener('data', on_data);
            socket.removeListener('error', on_error);
            socket.removeListener('close', on_close);
            socket.setTimeout(0);
        }

        function fail(err) {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            socket.destroy();
            reject(err);
        }

        function on_error(err) {
            fail(err);
        }

        function on_close() {
            fail(new Error('Proxy socket closed before CONNECT completed.'));
        }

        function on_connect() {
            const connect_lines = [
                `CONNECT ${target_host}:${target_port} HTTP/1.1`,
                `Host: ${target_host}:${target_port}`,
                'Proxy-Connection: Keep-Alive'
            ];
            if (proxy_auth) {
                connect_lines.push(`Proxy-Authorization: Basic ${proxy_auth}`);
            }
            connect_lines.push('', '');
            socket.write(connect_lines.join('\r\n'));
        }

        function on_data(chunk) {
            response_buffer += chunk.toString('latin1');
            const header_end_index = response_buffer.indexOf('\r\n\r\n');
            if (header_end_index === -1) {
                if (response_buffer.length > 8192) {
                    fail(new Error('Proxy CONNECT response exceeded header size limit.'));
                }
                return;
            }

            const raw_header = response_buffer.slice(0, header_end_index);
            const status_line = raw_header.split('\r\n')[0];
            const status_match = /^HTTP\/1\.\d (\d{3})/.exec(status_line);
            if (!status_match) {
                fail(new Error(`Invalid proxy CONNECT response: ${status_line}`));
                return;
            }

            const status_code = Number.parseInt(status_match[1], 10);
            if (!Number.isFinite(status_code)) {
                fail(new Error(`Failed to parse proxy CONNECT status from: ${status_line}`));
                return;
            }
            if (status_code !== 200) {
                fail(new Error(`Proxy CONNECT failed with status ${status_code}.`));
                return;
            }

            cleanup();

            const tls_socket = tls.connect({
                socket,
                servername: target_host,
                ALPNProtocols: ['h2', 'http/1.1'],
                rejectUnauthorized: false
            });

            let tls_finished = false;

            const on_tls_error = (err) => {
                if (tls_finished) {
                    return;
                }
                tls_finished = true;
                if (!finished) {
                    finished = true;
                    tls_socket.destroy();
                    reject(err);
                }
            };

            tls_socket.setTimeout(10000, () => {
                if (tls_finished) {
                    return;
                }
                tls_finished = true;
                if (!finished) {
                    finished = true;
                    tls_socket.destroy();
                    reject(new Error('TLS handshake timed out.'));
                }
            });

            tls_socket.once('error', on_tls_error);

            tls_socket.once('secureConnect', () => {
                if (tls_finished) {
                    return;
                }
                tls_finished = true;
                tls_socket.setTimeout(0);
                tls_socket.removeListener('error', on_tls_error);
                if (finished) {
                    return;
                }
                finished = true;
                resolve(tls_socket);
            });
        }

        socket.setTimeout(10000, () => {
            fail(new Error('Proxy CONNECT timed out.'));
        });

        socket.on('data', on_data);
        socket.on('error', on_error);
        socket.on('close', on_close);
        socket.once('connect', on_connect);
    });
}

async function probe_http2_via_proxy(target_url, { proxy_host, proxy_port, proxy_auth }) {
    const target = new URL(target_url);
    const target_host = target.hostname;
    const target_port = target.port ? Number.parseInt(target.port, 10) : 443;
    const target_path = `${target.pathname}${target.search || ''}`;
    const target_origin = `${target.protocol}//${target.host}`;

    const tls_socket = await create_tls_socket_through_proxy({
        proxy_host,
        proxy_port,
        proxy_auth,
        target_host,
        target_port
    });

    const negotiated_protocol = tls_socket.alpnProtocol || 'unknown';

    const session = http2.connect(target_origin, {
        createConnection: () => tls_socket
    });

    session.setTimeout(10000, () => {
        session.destroy(new Error('HTTP/2 session timed out.'));
    });

    let result;

    try {
        result = await new Promise((resolve, reject) => {
            let settled = false;

            const req = session.request({
                ':method': 'GET',
                ':path': target_path,
                ':scheme': target.protocol.replace(':', ''),
                ':authority': target.host
            });

            const chunks = [];

            const abort_with_error = (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                session.removeListener('error', abort_with_error);
                try {
                    req.destroy();
                } catch {
                    // ignore
                }
                try {
                    session.destroy(err);
                } catch {
                    // ignore
                }
                reject(err);
            };

            session.once('error', abort_with_error);
            req.once('error', abort_with_error);

            req.setTimeout(10000, () => {
                abort_with_error(new Error('HTTP/2 request timed out.'));
            });

            req.on('response', (headers) => {
                req.on('data', (chunk) => chunks.push(chunk));
                req.once('end', () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    session.removeListener('error', abort_with_error);
                    resolve({
                        status: headers[':status'],
                        headers,
                        body: Buffer.concat(chunks),
                        negotiated_protocol
                    });
                });
            });

            req.end();
        });
    } finally {
        session.setTimeout(0);
        session.close();
        try {
            await once(session, 'close');
        } catch (err) {
            log_warn(`HTTP/2 session close error: ${err.message}`);
        }
    }

    return result;
}

async function main() {
    const proxy_host = DEFAULT_PROXY_HOST;
    const proxy_port = DEFAULT_PROXY_PORT;
    const proxy_user = DEFAULT_PROXY_USER;
    const proxy_pass = DEFAULT_PROXY_PASS;
    const proxy_auth = encode_basic_auth(proxy_user, proxy_pass);

    log_status(`Using proxy ${proxy_host}:${proxy_port}`);

    const server = await start_http2_probe_server();
    log_status(`Started local HTTP/2 target on port ${server.port}`);

    const target_url = `https://127.0.0.1:${server.port}/http2-check`;

    try {
        const result = await probe_http2_via_proxy(target_url, {
            proxy_host,
            proxy_port,
            proxy_auth
        });

        const last_request = server.get_last_request();
        if (!last_request) {
            throw new Error('No request observed by the HTTP/2 test server.');
        }

        const response_body_text = result.body.toString('utf8');
        let response_payload;
        try {
            response_payload = JSON.parse(response_body_text);
        } catch (err) {
            throw new Error(`Failed to parse HTTP/2 server response JSON: ${err.message}`);
        }

        log_status(`Proxy negotiated ALPN protocol: ${result.negotiated_protocol}`);
        log_status(`Target server observed protocol: ${last_request.protocol}`);

        if (result.negotiated_protocol !== 'h2') {
            throw new Error(`Proxy did not negotiate HTTP/2 over TLS (ALPN was ${result.negotiated_protocol}).`);
        }

        if (last_request.protocol !== 'h2') {
            throw new Error(`HTTP/2 server observed protocol ${last_request.protocol} instead of h2.`);
        }

        if (result.status !== 200) {
            throw new Error(`Unexpected HTTP/2 response status ${result.status}.`);
        }

        if (!response_payload || response_payload.protocol !== 'h2') {
            throw new Error('HTTP/2 server response indicates fallback to HTTP/1.1.');
        }

        log_status('HTTP/2 request succeeded through thermoptic proxy.');
        log_status(`Response payload: ${JSON.stringify(response_payload)}`);
    } catch (err) {
        log_warn(err.stack ? err.stack : String(err));
        process.exitCode = 1;
    } finally {
        await server.stop();
        log_status('Shut down local HTTP/2 target server.');
    }
}

main().catch((err) => {
    log_warn(err.stack ? err.stack : String(err));
    process.exitCode = 1;
});
