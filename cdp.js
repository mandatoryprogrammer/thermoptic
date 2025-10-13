import CDP from 'chrome-remote-interface';
import * as fetchgen from './fetchgen.js';
import * as utils from './utils.js';
import * as config from './config.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { request as http_request } from 'node:http';
import * as logger from './logger.js';

const REDIRECT_STATUS_CODES = [
    301, 302, 303, 307, 308
];

const TEMP_RESPONSE = {
    statusCode: 502,
    header: {
        [config.ERROR_HEADER_NAME]: `Request error: Debug`
    },
    body: ''
}

const open_tabs = new Map();
let tab_reaper_timer = null;
const cdp_logger = logger.get_logger();

function normalize_error_message(err) {
    if (!err) {
        return '';
    }

    if (err instanceof Error) {
        return err.message || '';
    }

    return String(err);
}

function is_target_already_closed_error(err) {
    const message = normalize_error_message(err);
    return message.includes('No target with given id') || message.includes('No such target');
}

function is_transient_close_error(err) {
    const message = normalize_error_message(err);
    if (!message) {
        return false;
    }

    if (message.includes('WebSocket is not open') || message.includes('WebSocket connection closed')) {
        return true;
    }

    return false;
}

function attach_disconnect_handler(tab_info) {
    if (tab_info.disconnect_handler || !tab_info.tab || typeof tab_info.tab.on !== 'function') {
        return;
    }

    const handler = () => handle_tracked_tab_disconnect(tab_info.target_id);
    tab_info.tab.on('disconnect', handler);
    tab_info.disconnect_handler = handler;
}

function detach_disconnect_handler(tab_info) {
    if (!tab_info.disconnect_handler) {
        return;
    }

    if (tab_info.tab && typeof tab_info.tab.removeListener === 'function') {
        tab_info.tab.removeListener('disconnect', tab_info.disconnect_handler);
    }

    tab_info.disconnect_handler = null;
}

function handle_tracked_tab_disconnect(target_id) {
    const tab_info = open_tabs.get(target_id);
    if (!tab_info || tab_info.closing) {
        return;
    }

    cdp_logger.warn('Tab disconnected unexpectedly; cleaning up.', {
        target_id: target_id
    });
    release_tracked_tab(tab_info, 'cdp disconnect').catch((err) => {
        cdp_logger.error('Failed to cleanup tab after disconnect.', {
            target_id: target_id,
            message: err && err.message ? err.message : String(err),
            stack: err && err.stack ? err.stack : undefined
        });
    });
}

function register_open_tab(browser, tab, target_id) {
    const tab_info = {
        browser: browser,
        tab: tab,
        target_id: target_id,
        created_at: Date.now(),
        closing: false,
        disconnect_handler: null,
        retry_count: 0
    };

    attach_disconnect_handler(tab_info);

    open_tabs.set(target_id, tab_info);
    ensure_tab_reaper();
    return tab_info;
}

async function close_target_with_fresh_session(target_id) {
    let fallback_browser = null;
    try {
        fallback_browser = await start_browser_session();
        const { Target } = fallback_browser;
        await Target.closeTarget({ targetId: target_id });
        return {
            success: true
        };
    } catch (err) {
        if (is_target_already_closed_error(err)) {
            return {
                success: true
            };
        }
        if (is_transient_close_error(err)) {
            return {
                success: false,
                error: err,
                transient: true
            };
        }
        return {
            success: false,
            error: err
        };
    } finally {
        await close_browser_session(fallback_browser);
    }
}

async function close_target_via_http(target_id) {
    const { host, port } = get_cdp_config();

    return new Promise((resolve) => {
        const req = http_request({
            host: host,
            port: port,
            path: `/json/close/${target_id}`,
            method: 'GET',
            timeout: 3000
        }, (res) => {
            res.resume();

            if (!res.statusCode) {
                resolve({ success: false, error: new Error('No status code from closeTarget HTTP call') });
                return;
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ success: true });
                return;
            }

            if (res.statusCode === 404) {
                resolve({ success: true });
                return;
            }

            resolve({
                success: false,
                error: new Error(`Unexpected status ${res.statusCode} from closeTarget HTTP call`)
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('HTTP closeTarget timeout'));
        });

        req.on('error', (err) => {
            resolve({ success: false, error: err });
        });

        req.end();
    });
}

async function perform_tab_closure(tab_info, reason) {
    const target_id = tab_info.target_id;
    let target_closed = false;

    if (tab_info.browser && tab_info.browser.Target && typeof tab_info.browser.Target.closeTarget === 'function') {
        try {
            await tab_info.browser.Target.closeTarget({ targetId: target_id });
            target_closed = true;
        } catch (err) {
            if (is_target_already_closed_error(err)) {
                target_closed = true;
            } else if (is_transient_close_error(err)) {
                cdp_logger.info('Primary CDP session already closed while closing target; falling back.', {
                    target_id: target_id,
                    reason: reason
                });
            } else {
                cdp_logger.error('Failed to close target via existing session.', {
                    target_id: target_id,
                    reason: reason,
                    message: err && err.message ? err.message : String(err),
                    stack: err && err.stack ? err.stack : undefined
                });
            }
        }
    }

    if (!target_closed) {
        const fresh_result = await close_target_with_fresh_session(target_id);
        if (!fresh_result.success && fresh_result.error) {
            if (fresh_result.transient) {
                cdp_logger.info('Fallback CDP session closed early; attempting HTTP endpoint.', {
                    target_id: target_id,
                    reason: reason
                });
            } else if (!is_target_already_closed_error(fresh_result.error)) {
                cdp_logger.error('Fallback closeTarget failed.', {
                    target_id: target_id,
                    reason: reason,
                    message: fresh_result.error && fresh_result.error.message ? fresh_result.error.message : String(fresh_result.error),
                    stack: fresh_result.error && fresh_result.error.stack ? fresh_result.error.stack : undefined
                });
            }
        }
        target_closed = target_closed || fresh_result.success;
    }

    if (!target_closed) {
        const http_result = await close_target_via_http(target_id);
        if (!http_result.success && http_result.error && !is_target_already_closed_error(http_result.error)) {
            cdp_logger.error('HTTP closeTarget failed.', {
                target_id: target_id,
                reason: reason,
                message: http_result.error && http_result.error.message ? http_result.error.message : String(http_result.error),
                stack: http_result.error && http_result.error.stack ? http_result.error.stack : undefined
            });
        }
        target_closed = target_closed || http_result.success;
    }

    if (tab_info.tab && typeof tab_info.tab.close === 'function') {
        try {
            await tab_info.tab.close();
        } catch (err) {
            if (is_transient_close_error(err)) {
                cdp_logger.debug('Tab transport already closed; assuming target gone.', {
                    target_id: target_id,
                    reason: reason
                });
            } else if (!is_target_already_closed_error(err)) {
                cdp_logger.error('Failed to close tab session.', {
                    target_id: target_id,
                    reason: reason,
                    message: err && err.message ? err.message : String(err),
                    stack: err && err.stack ? err.stack : undefined
                });
            }
        }
    }

    tab_info.browser = null;
    tab_info.tab = null;

    return target_closed;
}

function schedule_tab_retry(tab_info, reason) {
    const attempts = (tab_info.retry_count || 0);
    const delay = Math.min(5000, 500 * Math.max(1, attempts));

    const timer = setTimeout(() => {
        if (!open_tabs.has(tab_info.target_id) || tab_info.closing) {
            return;
        }
        release_tracked_tab(tab_info, `${reason} (retry)`);
    }, delay);

    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
}

async function release_tracked_tab(tab_info, reason) {
    if (!tab_info || tab_info.closing) {
        return;
    }

    tab_info.closing = true;
    detach_disconnect_handler(tab_info);

    let closed = false;

    try {
        closed = await perform_tab_closure(tab_info, reason);
    } catch (err) {
        cdp_logger.error('Unexpected error while closing tab.', {
            target_id: tab_info.target_id,
            reason: reason,
            message: err && err.message ? err.message : String(err),
            stack: err && err.stack ? err.stack : undefined
        });
    } finally {
        if (closed) {
            open_tabs.delete(tab_info.target_id);
            maybe_stop_tab_reaper();
            return;
        }

        tab_info.retry_count = (tab_info.retry_count || 0) + 1;
        tab_info.closing = false;
        attach_disconnect_handler(tab_info);
        schedule_tab_retry(tab_info, reason);
        ensure_tab_reaper();
    }
}

function run_tab_reaper_sweep() {
    const now = Date.now();
    const expired_tabs = [];

    for (const tab_info of open_tabs.values()) {
        if (tab_info.closing) {
            continue;
        }

        if ((now - tab_info.created_at) >= config.TAB_MAX_LIFETIME_MS) {
            expired_tabs.push(tab_info);
        }
    }

    for (const tab_info of expired_tabs) {
        cdp_logger.warn('Tab exceeded max lifetime; forcing closure.', {
            target_id: tab_info.target_id
        });
        release_tracked_tab(tab_info, 'max lifetime exceeded').catch((err) => {
            cdp_logger.error('Failed to reap tab after max lifetime exceeded.', {
                target_id: tab_info.target_id,
                message: err && err.message ? err.message : String(err),
                stack: err && err.stack ? err.stack : undefined
            });
        });
    }
}

function ensure_tab_reaper() {
    if (tab_reaper_timer) {
        return;
    }

    tab_reaper_timer = setInterval(() => {
        run_tab_reaper_sweep();
    }, config.TAB_SWEEP_INTERVAL_MS);

    if (tab_reaper_timer && typeof tab_reaper_timer.unref === 'function') {
        tab_reaper_timer.unref();
    }
}

function maybe_stop_tab_reaper() {
    if (open_tabs.size > 0 || !tab_reaper_timer) {
        return;
    }

    clearInterval(tab_reaper_timer);
    tab_reaper_timer = null;
}

function timeout_action(reject_func) {
    setTimeout(() => {
        reject_func();
    }, (config.PROXY_REQUEST_TIMEOUT))
}

async function close_browser_session(browser) {
    if (!browser) {
        return;
    }
    try {
        await browser.close();
    } catch (err) {
        cdp_logger.error('Failed to close browser session.', {
            message: err && err.message ? err.message : String(err),
            stack: err && err.stack ? err.stack : undefined
        });
    }
}

/*
    https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-setCookies 
    https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-CookieParam
    cookies_array = [{
        'name': "examplecookie",
        "value": "examplevalue2",
        "url": "https://example.com"
    }]
*/
export async function set_browser_cookies(cookies_array) {
    const browser = await start_browser_session();
    try {
        const { Storage } = browser;
        await Storage.setCookies({
            'cookies': cookies_array
        });
    } finally {
        await close_browser_session(browser);
    }
}

// Requests which are from inclusion on another page such as <link>, <script>,
// <iframe>, etc. Specifically due to the Sec-Fetch-Dest header which is 
// different for each of these inclusion types.
export async function resource_request(url, protocol, method, path, headers, body) {
    try {
        return await _resource_request(url, protocol, method, path, headers, body);
    } catch (error) {
        return {
            statusCode: 502,
            header: {
                [config.ERROR_HEADER_NAME]: `Request error: ${error instanceof Error ? error.message : String(error)}`
            },
            body: ''
        };
    }
}

async function _resource_request(url, protocol, method, path, headers, body) {
    return new Promise((outerResolve, outerReject) => {
        let settled = false;

        const resolve = (val) => {
            if (!settled) {
                settled = true;
                outerResolve(val);
            }
        };

        const reject = (err) => {
            if (!settled) {
                settled = true;
                outerReject(err instanceof Error ? err : new Error(String(err)));
            }
        };

        // Trigger a timeout if the request takes too long
        timeout_action(() => reject(new Error('TIMEOUT')));

        // Run the resource capture logic
        (async() => {
            let browser = null;
            try {
                // Get the URL that the fetch() should be served from
                // We use the headers to inform this.
                let fetch_page_url = get_page_url_from_headers(url, headers);

                let serve_base_page = true;

                // Get Sec-Fetch-Dest header value
                const sec_fetch_dest = fetchgen.get_header_value_ignore_case('Sec-Fetch-Dest', headers);

                // Generate page HTML to request the other resource
                const resource_request_html = fetchgen.generate_resource_request_code(
                    sec_fetch_dest,
                    url
                );

                // For edge cases where Origin is null or something else nonsensical
                if (!fetch_page_url || !(fetch_page_url.startsWith('http:') || fetch_page_url.startsWith('https:'))) {
                    fetch_page_url = `data:text/html;base64,${btoa(resource_request_html)}`;
                    serve_base_page = false;
                }

                if (!fetch_page_url) {
                    reject(new Error('Error mocking resource request/inclusion context, couldn\'t determine page URL to host it on!'));
                    return;
                }

                browser = await start_browser_session();
                const new_tab_info = await new_tab(browser, 'about:blank');
                const tab = new_tab_info.tab;

                const request_result = await intercept_navigation_and_capture(
                    tab,
                    fetch_page_url,
                    resource_request_html,
                    true, // No manual action, resources are included automatically
                    serve_base_page,
                    false,
                    false
                ).finally(async() => {
                    // Always close the tab, even if navigation or capture fails
                    try {
                        await close_tab(browser, tab, new_tab_info.target_id);
                    } catch (closeErr) {
                        cdp_logger.error('Failed to close tab after resource request capture.', {
                            message: closeErr && closeErr.message ? closeErr.message : String(closeErr),
                            stack: closeErr && closeErr.stack ? closeErr.stack : undefined
                        });
                    }
                });

                resolve(request_result);
            } catch (err) {
                reject(err);
            } finally {
                await close_browser_session(browser);
            }
        })();
    });
}

// Requests which are kicked off by fetch()
export async function fetch_request(url, protocol, method, path, headers, body, request_logger = null) {
    const active_logger = request_logger || cdp_logger;

    try {
        return await _fetch_request(url, protocol, method, path, headers, body, active_logger);
    } catch (error) {
        active_logger.error('fetch_request caught error.', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        return {
            statusCode: 502,
            header: {
                [config.ERROR_HEADER_NAME]: `Request error: ${error instanceof Error ? error.message : error}`
            },
            body: ''
        };
    }
}

async function _fetch_request(url, protocol, method, path, headers, body, active_logger) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const safeResolve = (val) => {
            if (!settled) {
                settled = true;
                resolve(val);
            }
        };

        const safeReject = (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        };

        setTimeout(() => {
            safeReject('TIMEOUT');
        }, config.PROXY_REQUEST_TIMEOUT);

        (async() => {
            let browser = null;
            try {
                let fetch_page_url = get_page_url_from_headers(url, headers);
                let serve_base_page = true;

                const filtered_headers = headers.filter(header => {
                    return !config.ALWAYS_CLEAN_HEADERS.includes(header.key.toLowerCase());
                });

                const fetch_html = fetchgen.generate_fetch_code(
                    url,
                    method,
                    filtered_headers,
                    body,
                    false
                );

                if (!fetch_page_url || !(fetch_page_url.startsWith('http:') || fetch_page_url.startsWith('https:'))) {
                    fetch_page_url = `data:text/html;base64,${btoa(fetch_html)}`;
                    serve_base_page = false;
                }

                browser = await start_browser_session();
                const new_tab_info = await new_tab(browser, 'about:blank');
                const tab = new_tab_info.tab;

                let is_options_preflight = false;
                if (method === 'options') {
                    is_options_preflight = true;
                }

                let request_result;
                try {
                    request_result = await intercept_navigation_and_capture(
                        tab,
                        fetch_page_url,
                        fetch_html,
                        true,
                        serve_base_page,
                        is_options_preflight,
                        false
                    );
                } finally {
                    try {
                        await close_tab(browser, tab, new_tab_info.target_id);
                    } catch (finalError) {
                        // Avoid unhandled rejection in finally
                        active_logger.error('Failed to close tab after fetch request capture.', {
                            message: finalError && finalError.message ? finalError.message : String(finalError),
                            stack: finalError && finalError.stack ? finalError.stack : undefined
                        });
                    }
                }

                safeResolve(request_result);
            } catch (err) {
                safeReject(err);
            } finally {
                await close_browser_session(browser);
            }
        })();
    });
}

function generate_random_subdomain_url_for_url(url) {
    try {
        const parsed_url = new URL(url);
        const protocol = parsed_url.protocol;
        const hostname = parsed_url.hostname;
        const pathname = parsed_url.pathname + parsed_url.search + parsed_url.hash;

        const random_subdomain = Math.random().toString(36).substring(2, 10);
        return `${protocol}//${random_subdomain}.${hostname}${pathname}`;
    } catch (e) {
        throw new Error("Invalid URL");
    }
}

export async function write_files_to_tmp(fields) {
    const master_dir = join('/tmp', 'upload_' + await random_bytes_hex(8));
    await mkdir(master_dir, { recursive: true });

    const output_paths = [];

    for (const field of fields) {
        if (field.type !== 'file') continue;

        const original_name = field.filename || 'unnamed.bin';
        const unique_dir = join(master_dir, await random_bytes_hex(8));
        await mkdir(unique_dir);

        const file_path = join(unique_dir, original_name);
        await writeFile(file_path, field.value);

        output_paths.push(file_path);
    }

    return {
        'directory': master_dir,
        files: output_paths
    };
}

async function random_bytes_hex(size) {
    return new Promise((resolve, reject) => {
        randomBytes(size, (err, buf) => {
            if (err) reject(err);
            else resolve(buf.toString('hex'));
        });
    });
}


function get_page_url_from_headers(url, headers) {
    // Pull Origin and Referer header if present
    // These values inform which page we'll mock the browser
    // to host the form submission HTML on.
    const origin = fetchgen.get_header_value_ignore_case('Origin', headers);
    const referer = fetchgen.get_header_value_ignore_case('Referer', headers);

    // Check Sec-Fetch-Site header to understand if the
    // request is from the same origin or from another.
    const sec_fetch_site = fetchgen.get_header_value_ignore_case('Sec-Fetch-Site', headers);

    let form_page_url = false;
    if (sec_fetch_site && sec_fetch_site.toLowerCase() === 'same-origin') {
        // Since it's same-origin, just set the URL to be the same as the
        // one that is being requested.
        form_page_url = url;
    } else if (referer) {
        // If Referer is set we use that as the base page URL
        // that the form is hosted on. Otherwise we fail back to
        // Origin if it is set, and if no Origin we fall back to
        // a null Origin case (via data: URI).
        form_page_url = referer;
    } else if (origin) {
        form_page_url = origin;
    } else if (sec_fetch_site && sec_fetch_site.toLowerCase() === 'same-site') {
        // "same-site" just means the base domain is the same, so we set
        // a URL for a random other sub-domain of the URL being requested.
        // This is a fallback if we can't infer properly from the "Origin"
        // and the "Referer" headers.
        form_page_url = generate_random_subdomain_url_for_url(url);
    }

    return form_page_url;
}
// For requests that are browser <form> submissions
// (both automatic and manual)
export async function form_submission(url, protocol, method, path, headers, body) {
    // Clean up the directory where temp files are written (if any)
    let state = {
        file_hold_directory: false,
    };

    try {
        const result = await _form_submission(url, protocol, method, path, headers, body, state);
        return result;
    } catch (error) {
        return {
            statusCode: 502,
            header: {
                [config.ERROR_HEADER_NAME]: `Request error: ${error instanceof Error ? error.message : String(error)}`
            },
            body: ''
        };
    } finally {
        if (state.file_hold_directory) {
            await rm(state.file_hold_directory, { recursive: true, force: true });
        }
    }
}

async function _form_submission(url, protocol, method, path, headers, body, state) {
    return new Promise((outerResolve, outerReject) => {
        let settled = false;

        const resolve = (val) => {
            if (!settled) {
                settled = true;
                outerResolve(val);
            }
        };

        const reject = (err) => {
            if (!settled) {
                settled = true;
                outerReject(err instanceof Error ? err : new Error(String(err)));
            }
        };

        // Timeout rejection
        timeout_action(() => reject(new Error('TIMEOUT')));

        (async() => {
            let browser = null;
            try {
                // Determine if the user manually submitted the form based
                // off the presence of the Sec-Fetch-User header
                let is_automatic_submission = true;

                const sec_fetch_user = fetchgen.get_header_value_ignore_case('Sec-Fetch-User', headers);
                if (sec_fetch_user) {
                    is_automatic_submission = false;
                }

                // Get Content-Type
                const content_type = fetchgen.get_header_value_ignore_case('Content-Type', headers);

                let form_html = false;

                // Check if it's a file upload, if it is we have to
                // perform special handling since you can't generate a
                // pre-filled file upload field.
                const is_file_upload = (
                    content_type &&
                    content_type.toLowerCase().startsWith('multipart/form-data') &&
                    content_type.toLowerCase().includes('boundary=')
                );

                if (!is_file_upload) {
                    // Get <form> HTML to host on the URL we mock
                    form_html = fetchgen.generate_form_code(
                        url,
                        method,
                        content_type,
                        body,
                        is_automatic_submission
                    );
                }

                // Files to set (if any)
                let files_to_set = false;

                if (is_file_upload) {
                    // File uploads can't be automatic
                    is_automatic_submission = false;

                    // First we parse out all fields
                    const file_upload_fields = fetchgen.parse_multipart_form_data(body, content_type);

                    // Then we generate form HTML with those fields (file params
                    // are left empty, we'll set them shortly).
                    form_html = fetchgen.build_file_form_from_fields(url, file_upload_fields);

                    // Now we need to write a bunch of files to the FS
                    // under /tmp/ so we can use the CDP to set these
                    // fields after we mock out the page.
                    const write_file_result = await write_files_to_tmp(file_upload_fields);
                    files_to_set = write_file_result.files;
                    state.file_hold_directory = write_file_result.directory;
                }

                let serve_base_page = true;

                let form_page_url = get_page_url_from_headers(url, headers);

                // For edge cases where Origin is null or something else nonsensical
                if (!form_page_url || !(form_page_url.startsWith('http:') || form_page_url.startsWith('https:'))) {
                    form_page_url = `data:text/html;base64,${btoa(form_html)}`;
                    serve_base_page = false;
                }

                if (!form_page_url) {
                    reject(new Error('Error mocking form submission context, couldn\'t determine <form> page URL to host it on!'));
                    return;
                }

                browser = await start_browser_session();
                const new_tab_info = await new_tab(browser, 'about:blank');
                const tab = new_tab_info.tab;

                // Mock the <form> data on the URL specified
                const request_result = await intercept_navigation_and_capture(
                    tab,
                    form_page_url,
                    form_html,
                    is_automatic_submission,
                    serve_base_page,
                    false, // No CORS preflight on a form submission
                    files_to_set
                ).finally(async() => {
                    try {
                        await close_tab(browser, tab, new_tab_info.target_id);
                    } catch (closeErr) {
                        cdp_logger.error('Failed to close tab after form submission capture.', {
                            message: closeErr && closeErr.message ? closeErr.message : String(closeErr),
                            stack: closeErr && closeErr.stack ? closeErr.stack : undefined
                        });
                    }
                });

                resolve(request_result);
            } catch (err) {
                reject(err);
            } finally {
                await close_browser_session(browser);
            }
        })();
    });
}

/**
 * Uses CDP to assign each file path to the corresponding <input type="file"> element
 * via Input.setFileInputFiles. Enables Runtime, DOM, and Input domains internally.
 *
 * @param {object} cdp - Chrome DevTools Protocol session object.
 * @param {string} selector - CSS selector for the target file inputs.
 * @param {string[]} file_paths - Array of absolute file paths, one per input.
 */
export async function set_each_file_input_via_input_api(cdp, file_paths) {
    const { DOM } = cdp;

    await DOM.enable();

    // Get document root
    const { root: { nodeId: documentNodeId } } = await DOM.getDocument();

    // Query all input[type="file"] elements
    const { nodeIds } = await DOM.querySelectorAll({
        nodeId: documentNodeId,
        selector: 'input[type="file"]'
    });

    if (!nodeIds || nodeIds.length === 0) {
        throw new Error('No <input type="file"> found.');
    }

    if (file_paths.length > nodeIds.length) {
        throw new Error(`Too many file paths (${file_paths.length}) for ${nodeIds.length} input elements`);
    }

    for (let i = 0; i < file_paths.length; i++) {
        const nodeId = nodeIds[i];

        // Describe node to get backendNodeId (required by setFileInputFiles)
        const { node: { backendNodeId } } = await DOM.describeNode({ nodeId });

        await DOM.setFileInputFiles({
            backendNodeId,
            files: [file_paths[i]]
        });
    }
}

/*
    Serves the HTML on the URL specified and captures and returns the raw HTTP response.
*/
async function intercept_navigation_and_capture(tab, url_to_host_on, html_to_serve, is_automatic_submission, serve_base_page, pass_cors_preflight, files_to_set) {
    return new Promise((outerResolve, outerReject) => {
        let settled = false;

        const resolve = (val) => {
            if (!settled) {
                settled = true;
                outerResolve(val);
            }
        };

        const reject = (err) => {
            if (!settled) {
                settled = true;
                outerReject(err instanceof Error ? err : new Error(String(err)));
            }
        };

        // Timeout rejection
        timeout_action(() => reject(new Error('TIMEOUT')));

        (async() => {
            const { Fetch } = tab;

            await Fetch.enable({
                patterns: [
                    { urlPattern: '*', requestStage: 'Request' },
                    { urlPattern: '*', requestStage: 'Response' }
                ]
            });

            let is_cors_preflight_handled = !pass_cors_preflight;

            // Bool to only replace the initial base page request
            // The next request that'll come is the one generated by the synthetic
            // fetch() call.
            // If serve_base_page is false then we don't swap the base page
            // This is useful for if we're using something like a data: URI
            // where no swapping is required.
            let base_page_handled = !serve_base_page;

            tab.on('Fetch.requestPaused', async({
                requestId,
                request,
                frameId,
                resourceType,
                responseErrorReason,
                responseStatusCode,
                responseStatusText,
                responseHeaders
            }) => {
                try {
                    const { url } = request;
                    const is_request = (responseStatusCode === undefined);

                    cdp_logger.debug('Intercepted request during navigation capture.', {
                        url: request.url,
                        is_request: is_request,
                        resource_type: resourceType,
                        frame_id: frameId
                    });

                    // Is this a preflight OPTIONS request? 
                    // If so, we'll just mock a response that allows the next request to continue
                    // TODO: Make this configurable as some users may *want* the requests to occur
                    // as normal for anti-fingerprinting reasons. It's a tricky tradeoff that we
                    // should allow the user to configure.
                    if (is_request && request.method && request.method.toLowerCase() === 'options' && !is_cors_preflight_handled) {
                        cdp_logger.debug('Pre-flight OPTIONS request detected, mocking a passing response.', {
                            url: request.url
                        });

                        const headers = fetchgen.convert_headers_map_to_array(request.headers);
                        // Pull Origin header so we now what to reply with to pass the CORS check
                        const cors_origin = fetchgen.get_header_value_ignore_case('Origin', headers);
                        const cors_method = fetchgen.get_header_value_ignore_case('Access-Control-Request-Method', headers);
                        const cors_headers = fetchgen.get_header_value_ignore_case('Access-Control-Request-Headers', headers);

                        await Fetch.fulfillRequest({
                            requestId,
                            responseCode: 200,
                            responseHeaders: [
                                { name: 'Access-Control-Allow-Origin', value: cors_origin },
                                { name: 'Access-Control-Allow-Methods', value: cors_method },
                                { name: 'Access-Control-Allow-Headers', value: cors_headers },
                                { name: 'Access-Control-Allow-Credentials', value: 'true' },
                                // Never cache CORS preflight, we need to make sure the request
                                // chain happens in the same order each time in case the user is doing
                                // an OPTIONS request through the proxy.
                                { name: 'Access-Control-Max-Age', value: '0' },
                                { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
                                { name: 'Content-Length', value: String(Buffer.byteLength('')) },
                            ],
                            body: Buffer.from('').toString('base64'),
                        });
                        is_cors_preflight_handled = true;
                        return;
                    }

                    // Catch the base request and swap it
                    if (is_request && !base_page_handled) {
                        cdp_logger.debug('Mocking pseudo response to set up request.', {
                            url: request.url
                        });
                        base_page_handled = true;
                        await Fetch.fulfillRequest({
                            requestId,
                            responseCode: 200,
                            responseHeaders: [
                                { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                                { name: 'Content-Length', value: String(Buffer.byteLength(html_to_serve)) },
                            ],
                            body: Buffer.from(html_to_serve).toString('base64'),
                        });

                        // Fill out file fields with proxy-supplied files
                        if (files_to_set) {
                            await set_each_file_input_via_input_api(tab, files_to_set);
                        }

                        // Click the button "manually", this is for the Sec-Fetch-User
                        // header which requires a user submit not script-based one.
                        if (!is_automatic_submission) {
                            await click_element_as_user(tab, "#clickme");
                        }

                        return;
                    }

                    // Catch the initiated response
                    if (!is_request) {
                        cdp_logger.debug('Captured response from synthetic submission.', {
                            url: request.url,
                            status_code: responseStatusCode
                        });

                        let body = '';
                        if (!REDIRECT_STATUS_CODES.includes(responseStatusCode)) {
                            const response_tmp = await Fetch.getResponseBody({ requestId });
                            body = response_tmp.body;
                            if (response_tmp.base64Encoded) {
                                body = atob(body);
                            }
                        }
                        const raw_body = Buffer.from(body);

                        let formatted_headers = {};
                        responseHeaders.forEach(header_pair => {
                            formatted_headers[header_pair.name] = header_pair.value;
                        });

                        const response_string = fetchgen.get_blank_response();
                        await Fetch.fulfillRequest({
                            requestId,
                            responseCode: 200,
                            responseHeaders: [
                                { name: 'Content-Type', value: 'text/html' },
                                { name: 'Content-Length', value: String(Buffer.byteLength(response_string)) }
                            ],
                            body: Buffer.from(response_string).toString('base64')
                        });

                        // We're done, close out the session
                        await Fetch.disable();
                        resolve({
                            statusCode: responseStatusCode,
                            header: formatted_headers,
                            body: raw_body
                        });
                    } else {
                        await Fetch.continueRequest({ requestId });
                    }
                } catch (err) {
                    reject(err);
                }
            });

            // For direct page navigation we do a slightly different hack here
            await open_tab_to_intercept(tab, url_to_host_on);

            // If it's a request where we don't need to serve the base
            // page (data: URI) we can click right away
            if (!is_automatic_submission && !serve_base_page) {
                // Fill out file fields with proxy-supplied files
                if (files_to_set) {
                    await set_each_file_input_via_input_api(tab, files_to_set);
                }

                await click_element_as_user(tab, "#clickme");
            }
        })().catch(reject);
    });
}

// If you understand why I'm doing it in this way then you too know suffering.
// We are brothers, forged in pain, galvanized by the heat and pressure of hell.
export async function manual_browser_visit(url) {
    const browser = await start_browser_session();
    const new_tab_info = await new_tab(browser, 'chrome://bookmarks-side-panel.top-chrome/');
    const tab = new_tab_info.tab;

    try {
        const result = await _manual_browser_visit(tab, url);
        return result;
    } catch (error) {
        return {
            statusCode: 502,
            header: {
                [config.ERROR_HEADER_NAME]: `Request error: ${error instanceof Error ? error.message : String(error)}`
            },
            body: ''
        };
    } finally {
        try {
            await close_tab(browser, tab, new_tab_info.target_id);
        } catch (closeErr) {
            cdp_logger.error('Failed to close tab after manual browser visit.', {
                message: closeErr && closeErr.message ? closeErr.message : String(closeErr),
                stack: closeErr && closeErr.stack ? closeErr.stack : undefined
            });
        } finally {
            await close_browser_session(browser);
        }
    }
}

async function _manual_browser_visit(tab, url) {
    return new Promise((outerResolve, outerReject) => {
        let settled = false;

        const resolve = (val) => {
            if (!settled) {
                settled = true;
                outerResolve(val);
            }
        };

        const reject = (err) => {
            if (!settled) {
                settled = true;
                outerReject(err instanceof Error ? err : new Error(String(err)));
            }
        };

        // Timeout rejection
        timeout_action(() => reject(new Error('TIMEOUT')));

        (async() => {
            try {
                // Close the tab, delete the bookmark
                async function clean_up() {
                    if (bookmark_id_to_cleanup === -1) {
                        cdp_logger.error('Bookmark ID is -1 during cleanup.', {
                            context: 'manual_browser_visit_cleanup'
                        });
                        return;
                    }
                    await delete_chrome_bookmark_by_id(bookmark_id_to_cleanup);
                }

                const { Runtime, Fetch, Page } = tab;

                // Catch the response so the request is side-effect free.
                await Fetch.enable({
                    patterns: [{ urlPattern: '*', requestStage: 'Response' }]
                });

                Fetch.requestPaused(async({ requestId, responseStatusCode, responseHeaders, responseErrorReason }) => {
                    // Our request failed for some reason
                    if (responseErrorReason) {
                        resolve({
                            statusCode: 502,
                            header: {
                                [config.ERROR_HEADER_NAME]: `Request error: ${responseErrorReason}`
                            },
                            body: ''
                        });
                        return;
                    }

                    let body = '';
                    if (!REDIRECT_STATUS_CODES.includes(responseStatusCode)) {
                        const response_tmp = await Fetch.getResponseBody({ requestId });
                        body = response_tmp.body;
                        if (response_tmp.base64Encoded) {
                            body = atob(body);
                        }
                    }
                    const raw_body = Buffer.from(body);

                    // Send a NOP response so the request is side-effect free.
                    await Fetch.fulfillRequest({
                        requestId,
                        responseCode: 200,
                        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
                        body: Buffer.from(fetchgen.get_blank_response()).toString('base64'),
                    });

                    // Return formatted proxy response
                    await clean_up();
                    resolve({
                        statusCode: responseStatusCode,
                        header: utils.fetch_headers_to_proxy_response_headers(responseHeaders),
                        body: raw_body
                    });
                });

                await Runtime.enable();
                await Page.enable();

                await new Promise(resolveLoad => {
                    Page.loadEventFired(() => resolveLoad());
                });

                let bookmark_id_to_cleanup = -1;

                const create_bookmark_script = `
(async () => {
    async function create_bookmark(url) {
        const proxy = await import('chrome://bookmarks-side-panel.top-chrome/bookmarks_api_proxy.js');
        const booker = proxy.BookmarksApiProxyImpl.getInstance();

        const top_level_folder = document.querySelector("body > power-bookmarks-list").getParentFolder_();
        booker.bookmarkCurrentTabInFolder(top_level_folder.id);

        const created_bookmarks = await chrome.bookmarks.getRecent(1);
        const created_bookmark = created_bookmarks[0];
        chrome.bookmarks.update(created_bookmark.id, {
            title: 'tmpBookmark',
            url: url
        });
        return created_bookmark.id;
    }

    return create_bookmark(${JSON.stringify(url)});
})();
                `;

                const create_bookmark_result = await Runtime.evaluate({
                    expression: create_bookmark_script,
                    awaitPromise: true
                });
                bookmark_id_to_cleanup = create_bookmark_result.result.value;

                const visit_bookmark_script = `
(async () => {
    const proxy = await import('chrome://bookmarks-side-panel.top-chrome/bookmarks_api_proxy.js');
    const booker = proxy.BookmarksApiProxyImpl.getInstance();
    booker.openBookmark(parseInt(JSON.stringify(${bookmark_id_to_cleanup})), 0, {
        "middleButton": false,
        "altKey": false,
        "ctrlKey": false,
        "metaKey": false,
        "shiftKey": false
    }, 0);
})();
                `;

                await Runtime.evaluate({
                    expression: visit_bookmark_script,
                    awaitPromise: true
                });
            } catch (err) {
                reject(err);
            }
        })();
    });
}

export async function delete_chrome_bookmark_by_id(id) {
    const browser = await start_browser_session();
    const new_tab_info = await new_tab(browser, 'chrome://bookmarks-side-panel.top-chrome/');
    const tab = new_tab_info.tab;
    try {
        return await _delete_chrome_bookmark_by_id(tab, id);
    } finally {
        try {
            await close_tab(browser, tab, new_tab_info.target_id);
        } catch (closeErr) {
            cdp_logger.error('Failed to close tab after deleting bookmark by id.', {
                message: closeErr && closeErr.message ? closeErr.message : String(closeErr),
                stack: closeErr && closeErr.stack ? closeErr.stack : undefined
            });
        } finally {
            await close_browser_session(browser);
        }
    }
}
async function _delete_chrome_bookmark_by_id(tab, id) {
    cdp_logger.debug('Deleting bookmark by id.', {
        bookmark_id: id
    });
    const { Runtime, Fetch, Page } = tab;
    await Runtime.enable();
    await Page.enable();

    // Wait for page to load
    await new Promise(resolve => {
        Page.loadEventFired(() => resolve());
    });

    const delete_bookmark_script = `
(async () => {
    async function delete_bookmark(id) {
        const proxy = await import('chrome://bookmarks-side-panel.top-chrome/bookmarks_api_proxy.js');
        const booker = proxy.BookmarksApiProxyImpl.getInstance();
        booker.contextMenuDelete([parseInt(id)], 0)
    }

    return delete_bookmark(${JSON.stringify(id)});
})();`

    // Run bookmark deletion script
    await Runtime.evaluate({
        expression: delete_bookmark_script,
        awaitPromise: true
    });
}

function get_cdp_config() {
    let port = 9222;
    let host = '127.0.0.1';

    if (process.env.CHROME_DEBUGGING_HOST) {
        host = process.env.CHROME_DEBUGGING_HOST;
    }
    if (process.env.CHROME_DEBUGGING_PORT) {
        port = parseInt(process.env.CHROME_DEBUGGING_PORT);
    }

    return {
        host: host,
        port: port,
    }
}

export async function start_browser_session() {
    return CDP(get_cdp_config());
}

export async function new_tab(browser, initial_url = 'about:blank') {
    const { Target } = browser;
    const { targetId: target_id } = await Target.createTarget({
        url: initial_url
    });
    const tab = await CDP({
        ... {
            target: target_id
        },
        ...get_cdp_config(),
    });
    register_open_tab(browser, tab, target_id);
    return {
        'tab': tab,
        'target_id': target_id
    };
}

async function click_element_as_user(tab, selector = '#clickme') {
    const { DOM, Input } = tab;

    // Enable required domains
    await DOM.enable();

    // Get the document root
    const { root: { nodeId: document_node_id } } = await DOM.getDocument();

    // Query the target element
    const { nodeId } = await DOM.querySelector({
        selector,
        nodeId: document_node_id,
    });

    if (!nodeId) {
        throw new Error(`Element not found for selector: ${selector}`);
    }

    // Get the element's box model
    const { model: box_model } = await DOM.getBoxModel({ nodeId });

    if (!box_model) {
        throw new Error(`Could not get box model for selector: ${selector}`);
    }

    const [x1, y1, x2, y2, x3, y3, x4, y4] = box_model.content;
    const center_x = (x1 + x3) / 2;
    const center_y = (y1 + y3) / 2;

    // Dispatch real mouse events
    await Input.dispatchMouseEvent({
        type: 'mouseMoved',
        x: center_x,
        y: center_y,
        button: 'none',
    });

    await Input.dispatchMouseEvent({
        type: 'mousePressed',
        x: center_x,
        y: center_y,
        button: 'left',
        clickCount: 1,
    });

    await Input.dispatchMouseEvent({
        type: 'mouseReleased',
        x: center_x,
        y: center_y,
        button: 'left',
        clickCount: 1,
    });

    cdp_logger.debug('Clicked element to simulate user interaction.', {
        selector: selector,
        x: center_x,
        y: center_y
    });
}

export async function close_tab(browser, tab, target_id) {
    const tracked_tab = open_tabs.get(target_id);
    if (tracked_tab) {
        await release_tracked_tab(tracked_tab, 'manual close');
        return;
    }

    const synthetic_tab_info = {
        browser: browser,
        tab: tab,
        target_id: target_id,
        created_at: Date.now(),
        closing: true,
        disconnect_handler: null
    };

    await perform_tab_closure(synthetic_tab_info, 'manual close');
}

export async function open_tab_to_intercept(tab, url) {
    const { Page } = tab;
    await Page.enable();
    await Page.navigate({ url: url, transitionType: 'other' });
    await Page.loadEventFired();
}
