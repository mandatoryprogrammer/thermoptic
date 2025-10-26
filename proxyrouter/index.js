import ProxyChain from 'proxy-chain';

const DEFAULT_PORT = 3128;

const parse_port = (value) => {
    if (!value) {
        return DEFAULT_PORT;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error(`PROXY_ROUTER_PORT must be a valid TCP port, received: ${value}`);
    }

    return parsed;
};

const proxy_router_port = parse_port(process.env.PROXY_ROUTER_PORT);
const upstream_proxy_url = process.env.UPSTREAM_PROXY ? process.env.UPSTREAM_PROXY.trim() : '';

if (upstream_proxy_url) {
    console.log('[STATUS] proxyrouter using an upstream proxy');
} else {
    console.log('[STATUS] proxyrouter starting without an upstream proxy');
}

let server_has_started = false;

const server = new ProxyChain.Server({
    port: proxy_router_port,
    verbose: false,
    prepareRequestFunction: () => {
        if (!upstream_proxy_url) {
            return {};
        }

        return {
            upstreamProxyUrl: upstream_proxy_url
        };
    }
});

server.on('error', (error) => {
    console.error('[WARN] proxyrouter encountered an error', error);
    if (!server_has_started) {
        process.exit(1);
    }
});

server.on('requestFailed', ({ error }) => {
    if (!error) {
        return;
    }

    console.error('[WARN] proxyrouter request failed', error);
});

server.listen(() => {
    server_has_started = true;
    console.log(`[STATUS] proxyrouter listening on port ${proxy_router_port}`);
});

const shutdown = async (signal) => {
    console.log(`[STATUS] proxyrouter shutting down due to ${signal}`);

    try {
        await server.close(false);
    } catch (error) {
        console.error('[WARN] proxyrouter shutdown experienced an error', error);
    } finally {
        process.exit(0);
    }
};

['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
        shutdown(signal).catch((error) => {
            console.error('[WARN] proxyrouter failed during shutdown', error);
            process.exit(1);
        });
    });
});
