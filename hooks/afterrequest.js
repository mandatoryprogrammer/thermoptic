import CDP from 'chrome-remote-interface';
import * as logger from '../logger.js';
import * as requestengine from '../requestengine.js';

const captcha_solve_required_text = 'Verify you are human by completing the action below.';
const javascript_check_text = 'Verifying you are human. This may take a few seconds';
const challenge_script_indicator = '/cdn-cgi/challenge-platform/';
const security_verification_text = 'Performing security verification';
const security_verification_description = 'This website uses a security service to protect against malicious bots.';
const verification_success_waiting_text = 'Verification successful. Waiting for';
const challenge_title_text = 'Just a moment...';
const cloudflare_solver_timeout_ms = 45000;
const cloudflare_solver_poll_interval_ms = 1000;
const cloudflare_post_click_wait_ms = 2500;
const cloudflare_min_click_spacing_ms = 2000;
const cloudflare_reload_delay_ms = 12000;
const cdp_attach_retry_delay_ms = 250;
const cdp_attach_max_attempts = 3;
const challenge_status_codes = new Set([403, 429, 503]);

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
    };
}

function rand_int(min, max) {
    const min_ceiling = Math.ceil(min);
    const max_floor = Math.floor(max);
    return Math.floor(Math.random() * (max_floor - min_ceiling + 1)) + min_ceiling;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connect_to_target(target_id, hook_logger) {
    let last_error = null;

    for (let attempt = 0; attempt < cdp_attach_max_attempts; attempt += 1) {
        try {
            return await CDP({
                ...get_cdp_config(),
                target: target_id
            });
        } catch (err) {
            last_error = err;
            const attempt_number = attempt + 1;
            const has_more_attempts = attempt < (cdp_attach_max_attempts - 1);

            hook_logger.warn('Failed to attach to solver tab, retrying.', {
                attempt: attempt_number,
                next_attempt: has_more_attempts ? attempt_number + 1 : undefined,
                message: err instanceof Error ? err.message : String(err)
            });

            if (!has_more_attempts) {
                break;
            }

            await sleep(cdp_attach_retry_delay_ms);
        }
    }

    if (last_error instanceof Error) {
        throw last_error;
    }
    throw new Error(String(last_error));
}

function get_header_value_ignore_case(headers, header_name) {
    if (!headers || typeof headers !== 'object') {
        return '';
    }

    const target = header_name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (typeof key === 'string' && key.toLowerCase() === target) {
            return value;
        }
    }
    return '';
}

function response_body_to_string(response) {
    if (!response || typeof response !== 'object') {
        return '';
    }

    const { body } = response;
    if (typeof body === 'string') {
        return body;
    }
    if (Buffer.isBuffer(body)) {
        return body.toString('utf8');
    }
    if (body && typeof body.toString === 'function') {
        try {
            return body.toString('utf8');
        } catch {
            try {
                return String(body);
            } catch {
                return '';
            }
        }
    }
    return '';
}

function is_html_response(headers) {
    const content_type = get_header_value_ignore_case(headers, 'content-type');
    if (!content_type) {
        return true;
    }
    return content_type.toLowerCase().includes('text/html');
}

function is_cloudflare_challenge_response(response) {
    if (!response || !response.body) {
        return false;
    }

    const status_code = typeof response.statusCode === 'number' ? response.statusCode : null;
    const server_header = get_header_value_ignore_case(response.header, 'server');
    if (!server_header || !server_header.toLowerCase().includes('cloudflare')) {
        return false;
    }

    const body_string = response_body_to_string(response);
    if (!body_string) {
        return false;
    }

    const normalized_body = body_string.toLowerCase();
    const has_challenge_marker = normalized_body.includes(challenge_script_indicator) ||
        body_string.includes(captcha_solve_required_text) ||
        body_string.includes(javascript_check_text) ||
        body_string.includes(security_verification_text) ||
        body_string.includes(security_verification_description) ||
        body_string.includes(verification_success_waiting_text) ||
        normalized_body.includes('window._cf_chl_opt') ||
        normalized_body.includes('just a moment') ||
        normalized_body.includes('cf-turnstile-response');

    if (!has_challenge_marker) {
        return false;
    }

    const cf_mitigated_header = get_header_value_ignore_case(response.header, 'cf-mitigated');
    const cf_mitigated_challenge = cf_mitigated_header && cf_mitigated_header.toLowerCase().includes('challenge');
    const is_challenge_status = status_code !== null && challenge_status_codes.has(status_code);

    if (!cf_mitigated_challenge && !is_challenge_status) {
        return false;
    }

    return is_html_response(response.header);
}

function has_cloudflare_challenge_marker(html) {
    if (!html || typeof html !== 'string') {
        return false;
    }

    const normalized_html = html.toLowerCase();
    return normalized_html.includes(challenge_script_indicator) ||
        html.includes(captcha_solve_required_text) ||
        html.includes(javascript_check_text) ||
        html.includes(security_verification_text) ||
        html.includes(security_verification_description) ||
        html.includes(verification_success_waiting_text) ||
        normalized_html.includes('window._cf_chl_opt') ||
        normalized_html.includes('just a moment') ||
        normalized_html.includes('cf-turnstile-response');
}

function build_request_url(request) {
    if (!request || typeof request !== 'object') {
        return '';
    }

    if (request.url) {
        try {
            const parsed_url = new URL(request.url);
            return parsed_url.toString();
        } catch {
            // Fall back to reconstructing the URL from request options.
        }
    }

    let protocol = '';
    if (request.protocol) {
        protocol = request.protocol.endsWith(':') ? request.protocol.slice(0, -1) : request.protocol;
    }

    const request_options = request.requestOptions || {};
    const hostname = request_options.hostname || request_options.host || '';
    const port = request_options.port ? `:${request_options.port}` : '';
    const path = request_options.path || '/';

    if (!protocol || !hostname) {
        return '';
    }

    return `${protocol}://${hostname}${port}${path}`;
}

function request_headers_to_array(request) {
    const raw_headers = request?._req?.rawHeaders;
    if (Array.isArray(raw_headers) && raw_headers.length > 0) {
        const result = [];
        for (let i = 0; i < raw_headers.length; i += 2) {
            result.push({
                key: raw_headers[i],
                value: raw_headers[i + 1],
            });
        }
        return result;
    }

    const headers = request?.requestOptions?.headers;
    if (!headers || typeof headers !== 'object') {
        return [];
    }

    return Object.entries(headers).map(([key, value]) => ({
        key: key,
        value: Array.isArray(value) ? value.join(', ') : String(value)
    }));
}

async function replay_request_after_cloudflare(request, hook_logger) {
    const target_url = build_request_url(request);
    if (!target_url) {
        return null;
    }

    return requestengine.process_request(
        hook_logger,
        target_url,
        request.protocol,
        request?.requestOptions?.method || 'GET',
        request?.requestOptions?.path || '/',
        request_headers_to_array(request),
        request?.requestData || null
    );
}

function overwrite_response(target_response, source_response) {
    target_response.statusCode = source_response.statusCode;
    target_response.header = source_response.header;
    target_response.body = source_response.body;
}

function build_solver_url(target_url) {
    try {
        const parsed_url = new URL(target_url);
        parsed_url.pathname = '/';
        parsed_url.search = '';
        parsed_url.hash = '';
        return parsed_url.toString();
    } catch {
        return target_url;
    }
}

function attrs_to_object(attributes) {
    const attr_map = {};
    for (let i = 0; i < attributes.length; i += 2) {
        attr_map[attributes[i]] = attributes[i + 1];
    }
    return attr_map;
}

function extract_title_text_from_html(html) {
    if (!html || typeof html !== 'string') {
        return '';
    }

    const title_match = html.match(/<title>([^<]*)<\/title>/i);
    if (!title_match) {
        return '';
    }

    return title_match[1].trim();
}

function is_verified_page_state(page_state) {
    if (!page_state || typeof page_state !== 'object') {
        return false;
    }

    if (page_state.challenge_active || page_state.response_input_present) {
        return false;
    }

    if (page_state.cf_clearance_present) {
        return true;
    }

    return Boolean(page_state.title_text) && page_state.title_text !== challenge_title_text;
}

async function get_turnstile_host_node_id(DOM, root_node_id) {
    const { nodeIds: div_node_ids } = await DOM.querySelectorAll({
        nodeId: root_node_id,
        selector: 'div'
    });

    for (const node_id of div_node_ids) {
        const { attributes } = await DOM.getAttributes({ nodeId: node_id });
        const attrs = attrs_to_object(attributes);

        if (attrs.style && attrs.style.includes('display: grid')) {
            return node_id;
        }
    }

    return null;
}

async function get_page_state(client, probe_url) {
    const { DOM, Network } = client;

    const { root } = await DOM.getDocument({ depth: -1, pierce: true });
    const { outerHTML } = await DOM.getOuterHTML({ nodeId: root.nodeId });
    const response_input = await DOM.querySelector({
        nodeId: root.nodeId,
        selector: 'input[name="cf-turnstile-response"]'
    });
    const success_container = await DOM.querySelector({
        nodeId: root.nodeId,
        selector: '#YtLM0'
    });

    let success_visible = false;
    if (success_container.nodeId) {
        const { attributes } = await DOM.getAttributes({ nodeId: success_container.nodeId });
        const attrs = attrs_to_object(attributes);
        success_visible = !(attrs.style || '').includes('display: none');
    }

    const challenge_host_node_id = await get_turnstile_host_node_id(DOM, root.nodeId);
    let challenge_host_box_model = null;
    if (challenge_host_node_id) {
        try {
            const { model } = await DOM.getBoxModel({ nodeId: challenge_host_node_id });
            challenge_host_box_model = model;
        } catch {
            challenge_host_box_model = null;
        }
    }

    const cookies = await Network.getCookies({
        urls: [probe_url]
    });

    return {
        title_text: extract_title_text_from_html(outerHTML),
        challenge_active: has_cloudflare_challenge_marker(outerHTML),
        response_input_present: Boolean(response_input.nodeId),
        challenge_host_node_id: challenge_host_node_id,
        challenge_host_box_model: challenge_host_box_model,
        success_visible: success_visible,
        cf_clearance_present: cookies.cookies.some((cookie) => cookie.name === 'cf_clearance'),
        cf_cookie_names: cookies.cookies
            .filter((cookie) => cookie.name.startsWith('cf_'))
            .map((cookie) => cookie.name)
    };
}

async function click_challenge_host(client, page_state, hook_logger) {
    if (!page_state || !page_state.challenge_host_box_model) {
        return false;
    }

    const { Input } = client;
    const model = page_state.challenge_host_box_model;
    const x_top_left = model.content[0];
    const y_top_left = model.content[1];
    const y_bottom_left = model.content[7];

    const click_x = (x_top_left + 25) + rand_int(-2, 2);
    const click_y = ((y_top_left + y_bottom_left) / 2) + rand_int(-2, 2);

    hook_logger.info('Clicking Cloudflare challenge host to advance verification.', {
        click_x: click_x,
        click_y: click_y
    });

    await Input.dispatchMouseEvent({
        type: 'mousePressed',
        x: click_x,
        y: click_y,
        button: 'left',
        clickCount: 1
    });

    await Input.dispatchMouseEvent({
        type: 'mouseReleased',
        x: click_x,
        y: click_y,
        button: 'left',
        clickCount: 1
    });

    return true;
}

async function solve_cloudflare_challenge(cdp, target_url, hook_logger) {
    const { Target } = cdp;
    const { targetId } = await Target.createTarget({ url: 'about:blank' });
    let client = null;
    const solver_url = build_solver_url(target_url);

    try {
        client = await connect_to_target(targetId, hook_logger);
        const { Page, DOM, Network } = client;

        await Page.enable();
        await DOM.enable();
        await Network.enable();

        hook_logger.info('Cloudflare challenge detected, opening browser to clear it.', {
            target_url: target_url,
            solver_url: solver_url
        });

        await Page.navigate({ url: solver_url });
        await Page.loadEventFired();
        await Page.bringToFront();

        const start_time = Date.now();
        let click_attempts = 0;
        let last_click_timestamp = 0;
        let last_reload_timestamp = Date.now();
        let last_state_signature = '';

        while (true) {
            if ((Date.now() - start_time) > cloudflare_solver_timeout_ms) {
                hook_logger.warn('Timed out while waiting for Cloudflare challenge to finish.', {
                    target_url: target_url,
                    timeout_ms: cloudflare_solver_timeout_ms,
                    click_attempts: click_attempts
                });
                break;
            }

            let page_state = null;
            try {
                page_state = await get_page_state(client, solver_url);
            } catch (_error) {
                await sleep(250);
                continue;
            }

            const state_signature = JSON.stringify({
                title_text: page_state.title_text,
                challenge_active: page_state.challenge_active,
                response_input_present: page_state.response_input_present,
                challenge_host_present: Boolean(page_state.challenge_host_node_id),
                success_visible: page_state.success_visible,
                cf_clearance_present: page_state.cf_clearance_present,
                cf_cookie_names: page_state.cf_cookie_names
            });

            if (state_signature !== last_state_signature) {
                hook_logger.debug('Observed Cloudflare solver page state.', JSON.parse(state_signature));
                last_state_signature = state_signature;
            }

            if (is_verified_page_state(page_state)) {
                hook_logger.info('Cloudflare challenge appears cleared in live browser tab.', {
                    target_url: target_url,
                    title_text: page_state.title_text,
                    cf_clearance_present: page_state.cf_clearance_present
                });
                return {
                    solved: true
                };
            }

            const now = Date.now();
            const enough_time_since_last_click = (now - last_click_timestamp) >= cloudflare_min_click_spacing_ms;
            const should_click = page_state.challenge_active &&
                page_state.challenge_host_node_id &&
                enough_time_since_last_click;

            if (should_click) {
                if (click_attempts === 0) {
                    const fuzzy_wait_ms = rand_int((1000 * 1.5), (1000 * 5));
                    hook_logger.debug('Waiting before clicking challenge host to avoid robotic timing.', {
                        wait_ms: fuzzy_wait_ms
                    });
                    await sleep(fuzzy_wait_ms);
                }

                await Page.bringToFront();
                const clicked = await click_challenge_host(client, page_state, hook_logger);
                if (clicked) {
                    click_attempts += 1;
                    last_click_timestamp = Date.now();
                    await sleep(cloudflare_post_click_wait_ms);
                    continue;
                }
            }

            const should_reload = page_state.challenge_active &&
                !page_state.challenge_host_node_id &&
                page_state.cf_clearance_present &&
                ((now - last_reload_timestamp) >= cloudflare_reload_delay_ms);

            if (should_reload) {
                hook_logger.info('Cloudflare clearance cookie is present, reloading solver page to verify access.', {
                    solver_url: solver_url
                });
                await Page.navigate({ url: solver_url });
                await Page.loadEventFired();
                await Page.bringToFront();
                last_reload_timestamp = Date.now();
                await sleep(1000);
                continue;
            }

            await sleep(cloudflare_solver_poll_interval_ms);
        }

        return {
            solved: false
        };
    } finally {
        try {
            await Target.closeTarget({ targetId: targetId });
        } catch (close_target_error) {
            hook_logger.warn('Failed to close Cloudflare solver tab.', {
                message: close_target_error && close_target_error.message ? close_target_error.message : String(close_target_error),
                stack: close_target_error && close_target_error.stack ? close_target_error.stack : undefined
            });
        }

        if (client) {
            try {
                await client.close();
            } catch (client_close_error) {
                hook_logger.warn('Failed to close CDP client after solving Cloudflare challenge.', {
                    message: client_close_error && client_close_error.message ? client_close_error.message : String(client_close_error),
                    stack: client_close_error && client_close_error.stack ? client_close_error.stack : undefined
                });
            }
        }
    }
}

export async function hook(cdp, request, response, hook_logger = null) {
    const active_logger = hook_logger || (request && request.request_id ? logger.get_request_logger({ request_id: request.request_id }) : logger.get_logger());

    if (!cdp) {
        active_logger.warn('CDP session missing in after-request hook, skipping Cloudflare handling.');
        return;
    }

    if (!is_cloudflare_challenge_response(response)) {
        return;
    }

    const target_url = build_request_url(request);
    if (!target_url) {
        active_logger.warn('Cloudflare challenge detected but request URL could not be determined.');
        return;
    }

    active_logger.info('Cloudflare challenge detected in proxied response, attempting browser solve.', {
        target_url: target_url,
        status_code: response && typeof response.statusCode === 'number' ? response.statusCode : undefined
    });

    try {
        const solve_result = await solve_cloudflare_challenge(cdp, target_url, active_logger);
        if (!solve_result || !solve_result.solved) {
            active_logger.warn('Cloudflare solve did not reach a verified page state.', {
                target_url: target_url
            });
            return;
        }

        const replayed_response = await replay_request_after_cloudflare(request, active_logger);
        if (!replayed_response) {
            active_logger.warn('Cloudflare solve succeeded but request replay could not be constructed.', {
                target_url: target_url
            });
            return;
        }

        if (is_cloudflare_challenge_response(replayed_response)) {
            active_logger.warn('Cloudflare solve succeeded in the browser but replay still returned a challenge response.', {
                target_url: target_url,
                status_code: replayed_response.statusCode
            });
            return;
        }

        overwrite_response(response, replayed_response);
        active_logger.info('Replayed request after Cloudflare solve and replaced blocked response.', {
            target_url: target_url,
            status_code: replayed_response.statusCode
        });
    } catch (err) {
        active_logger.warn('Failed to auto-solve Cloudflare challenge in after-request hook.', {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        });
    }
}
