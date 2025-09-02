import AnyProxy from './anyproxy/proxy.js';
import * as cdp from './cdp.js';
import * as utils from './utils.js';

export async function get_http_proxy(port, ready_func, error_func, on_request_func) {
    const options = {
        port: port,
        rule: {
            beforeSendRequest: on_request_func
        },
        webInterface: {
            enable: false,
            webPort: 8002
        },
        //throttle: 10000,
        forceProxyHttps: true,
        wsIntercept: false,
        silent: false
    };

    // We now check if there is an on-start hook defined.
    // If there is we run it.
    if (process.env.ON_START_HOOK_FILE_PATH) {
        const cdp_instance = await cdp.start_browser_session();
        await utils.run_hook_file(process.env.ON_START_HOOK_FILE_PATH, cdp_instance);
    }

    const proxyServer = new AnyProxy.ProxyServer(options);
    proxyServer.on('ready', ready_func);
    proxyServer.on('error', error_func);
    return proxyServer;
}