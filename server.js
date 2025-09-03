import * as utils from './utils.js';
import * as proxy from './proxy.js';
import * as cdp from './cdp.js';
import * as requestengine from './requestengine.js';
import * as fetchgen from './fetchgen.js';

// Top-level error handling for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:');
    console.error('  Promise:', promise);
    console.error('  Reason:', reason);

    // If the reason is an Error object, print the stack
    if (reason instanceof Error) {
        console.error('  Stack:', reason.stack);
    }
});

// Optional: catch uncaught exceptions too
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    console.error('Stack:', err.stack);
});

(async() => {
    let http_proxy_port = 1234;
    if (process.env.HTTP_PROXY_PORT) {
        http_proxy_port = parseInt(process.env.HTTP_PROXY_PORT);
    }

    if (!process.env.PROXY_USERNAME || !process.env.PROXY_PASSWORD) {
        console.error(`[ERROR] PROXY_USERNAME and PROXY_PASSWORD must be set via environment variables! Quitting...`);
        process.exit(-1);
    }

    const http_proxy = await proxy.get_http_proxy(
        http_proxy_port,
        () => {
            console.log(`[STATUS] The thermoptic HTTP Proxy server is now running.`);
        },
        (error) => {
            console.log(`[STATUS] The thermoptic HTTP Proxy server encountered an unexpected error:`);
            console.error(error);
        },
        async(proxy_request) => {
            // First things first, ensure user is properly authenticated.
            const is_authenticated = get_authentication_status(proxy_request);

            if (!is_authenticated) {
                return AUTHENTICATION_REQUIRED_PROXY_RESPONSE;
            }

            let cdp_instance = null;
            // We now check if there is an before-request hook defined.
            if (process.env.BEFORE_REQUEST_HOOK_FILE_PATH) {
                cdp_instance = await cdp.start_browser_session();
                await utils.run_hook_file(process.env.BEFORE_REQUEST_HOOK_FILE_PATH, cdp_instance, proxy_request, null);
            }

            const response = await requestengine.process_request(
                proxy_request.url,
                proxy_request.protocol,
                proxy_request.requestOptions.method,
                proxy_request.requestOptions.path,
                utils.convert_headers_array(proxy_request._req.rawHeaders),
                proxy_request.requestData,
            );

            // We now check if there is an after-request hook defined.
            if (process.env.AFTER_REQUEST_HOOK_FILE_PATH) {
                if (!cdp_instance) {
                    cdp_instance = await cdp.start_browser_session();
                }
                await utils.run_hook_file(process.env.AFTER_REQUEST_HOOK_FILE_PATH, cdp_instance, proxy_request, response);
            }

            return {
                response: response
            };
        }
    );
    http_proxy.start();
})();

const AUTHENTICATION_REQUIRED_PROXY_RESPONSE = {
    response: {
        statusCode: 407,
        header: {
            'Proxy-Authenticate': 'Basic realm="Please provide valid credentials."'
        },
        body: 'Provide credentials.'
    }
};

function get_authentication_status(request) {
    const proxy_authentication = fetchgen.get_header_value_ignore_case(
        'Proxy-Authorization',
        fetchgen.convert_headers_map_to_array(request.requestOptions.headers),
    );

    if (!proxy_authentication || !(proxy_authentication.includes('Basic'))) {
        return false;
    }

    const proxy_auth_string = (
        new Buffer(
            proxy_authentication.replace(
                'Basic ',
                ''
            ).trim(),
            'base64'
        )
    ).toString();

    const proxy_auth_string_parts = proxy_auth_string.split(':');
    const username = proxy_auth_string_parts[0];
    const password = proxy_auth_string_parts[1];

    const creds_sent = `${username}:${password}`;
    const creds_set = `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`;

    return utils.time_safe_compare(creds_set, creds_sent);
}