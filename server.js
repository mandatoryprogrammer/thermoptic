import { v4 as create_request_uuid } from 'uuid';
import * as utils from './utils.js';
import * as proxy from './proxy.js';
import * as cdp from './cdp.js';
import * as requestengine from './requestengine.js';
import * as fetchgen from './fetchgen.js';
import * as logger from './logger.js';
import { start_health_monitor } from './healthcheck.js';

// Top-level error handling for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    const app_logger = logger.get_logger();
    const error_payload = {
        promise: typeof promise === 'object' ? String(promise) : promise,
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined
    };
    app_logger.error('Unhandled promise rejection captured.', error_payload);
});

// Optional: catch uncaught exceptions too
process.on('uncaughtException', (err) => {
    const app_logger = logger.get_logger();
    app_logger.error('Uncaught exception encountered.', {
        message: err.message,
        stack: err.stack
    });
});

(async() => {
    const app_logger = logger.get_logger();
    let http_proxy_port = 1234;
    if (process.env.HTTP_PROXY_PORT) {
        http_proxy_port = parseInt(process.env.HTTP_PROXY_PORT);
    }

    if (!process.env.PROXY_USERNAME || !process.env.PROXY_PASSWORD) {
        app_logger.error('PROXY_USERNAME and PROXY_PASSWORD must be set via environment variables. Quitting...');
        process.exit(-1);
    }

    app_logger.info('thermoptic has begun the initializing process.');

    const http_proxy = await proxy.get_http_proxy(
        http_proxy_port,
        () => {
            app_logger.info('The thermoptic HTTP Proxy server is now running.');
        },
        (error) => {
            app_logger.error('The thermoptic HTTP Proxy server encountered an unexpected error.', {
                message: error && error.message ? error.message : String(error)
            });
        },
        async(proxy_request) => {
            // First things first, ensure user is properly authenticated.
            const request_id = create_request_uuid();
            const request_logger = logger.get_request_logger({ request_id });
            proxy_request.request_id = request_id;
            request_logger.info('Inbound proxy request received.', {
                url: proxy_request.url,
                protocol: proxy_request.protocol,
                method: proxy_request.requestOptions.method,
                path: proxy_request.requestOptions.path
            });

            const is_authenticated = get_authentication_status(proxy_request);

            if (!is_authenticated) {
                request_logger.warn('Authentication failed for inbound proxy request.');
                return AUTHENTICATION_REQUIRED_PROXY_RESPONSE;
            }

            request_logger.debug('Authentication successful for inbound proxy request.');

            let cdp_instance = null;
            let request_completed = false;
            let response_status_code = null;
            let request_error = null;
            try {
                // We now check if there is an before-request hook defined.
                if (process.env.BEFORE_REQUEST_HOOK_FILE_PATH) {
                    request_logger.info('Executing before-request hook.', {
                        hook_file: process.env.BEFORE_REQUEST_HOOK_FILE_PATH
                    });
                    cdp_instance = await cdp.start_browser_session();
                    await utils.run_hook_file(process.env.BEFORE_REQUEST_HOOK_FILE_PATH, cdp_instance, proxy_request, null, request_logger);
                }

                const response = await requestengine.process_request(
                    request_logger,
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
                    request_logger.info('Executing after-request hook.', {
                        hook_file: process.env.AFTER_REQUEST_HOOK_FILE_PATH
                    });
                    await utils.run_hook_file(process.env.AFTER_REQUEST_HOOK_FILE_PATH, cdp_instance, proxy_request, response, request_logger);
                }

                request_logger.info('Successfully generated response for proxy request.', {
                    status_code: response.statusCode,
                    headers_count: response.header ? Object.keys(response.header).length : 0
                });
                request_completed = true;
                response_status_code = response.statusCode;
                return {
                    response: response
                };
            } catch (err) {
                request_error = {
                    message: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined
                };
                request_logger.error('Proxy request failed.', request_error);
                throw err;
            } finally {
                if (cdp_instance) {
                    try {
                        await cdp_instance.close();
                    } catch (closeErr) {
                        request_logger.warn('Failed to close CDP session.', {
                            message: closeErr.message,
                            stack: closeErr.stack
                        });
                    }
                }
                const lifecycle_summary = {
                    success: request_completed,
                    status_code: response_status_code
                };
                if (request_error) {
                    lifecycle_summary.error = request_error;
                }
                request_logger.info('Completed proxy request lifecycle.', lifecycle_summary);
            }
        }
    );
    http_proxy.start();

    try {
        await start_health_monitor();
    } catch (monitor_error) {
        app_logger.error('Failed to start health monitor.', {
            message: monitor_error instanceof Error ? monitor_error.message : String(monitor_error),
            stack: monitor_error instanceof Error ? monitor_error.stack : undefined
        });
    }
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
    const connection_state = request.connection_state;
    if (connection_state && connection_state.is_authenticated) {
        connection_state.last_seen = Date.now();
        return true;
    }

    const proxy_authentication = request.proxy_authorization_header;

    if (!proxy_authentication || !(proxy_authentication.includes('Basic'))) {
        return false;
    }

    const proxy_auth_string = Buffer.from(
        proxy_authentication.replace(
            'Basic ',
            ''
        ).trim(),
        'base64'
    ).toString();

    const proxy_auth_string_parts = proxy_auth_string.split(':');
    const username = proxy_auth_string_parts[0];
    const password = proxy_auth_string_parts[1];

    const creds_sent = `${username}:${password}`;
    const creds_set = `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`;

    const is_authenticated = utils.time_safe_compare(creds_set, creds_sent);
    if (is_authenticated && connection_state) {
        connection_state.is_authenticated = true;
        connection_state.last_seen = Date.now();
    }
    return is_authenticated;
}
