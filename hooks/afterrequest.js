import CDP from 'chrome-remote-interface';
import * as logger from '../logger.js';

const captcha_solve_required_text = 'Verify you are human by completing the action below.';
const javascript_check_text = 'Verifying you are human. This may take a few seconds';
const challenge_script_indicator = '/cdn-cgi/challenge-platform/';
const cloudflare_solver_timeout_ms = 45000;
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
        normalized_body.includes('window._cf_chl_opt') ||
        normalized_body.includes('just a moment');

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

async function solve_cloudflare_challenge(cdp, target_url, hook_logger) {
    const { Target } = cdp;
    const { targetId } = await Target.createTarget({ url: 'about:blank' });
    let client = null;

    try {
        client = await connect_to_target(targetId, hook_logger);
        const { Page, DOM, Input } = client;

        await Page.enable();
        await DOM.enable();

        hook_logger.info('Cloudflare challenge detected, opening browser to clear it.', {
            target_url: target_url
        });

        await Page.navigate({ url: target_url });
        await Page.loadEventFired();

        const start_time = Date.now();
        while (true) {
            if ((Date.now() - start_time) > cloudflare_solver_timeout_ms) {
                hook_logger.warn('Timed out while waiting for Cloudflare challenge to finish.', {
                    target_url: target_url,
                    timeout_ms: cloudflare_solver_timeout_ms
                });
                break;
            }

            let outer_html = '';
            try {
                const { root } = await DOM.getDocument({ depth: -1 });
                const result = await DOM.getOuterHTML({ nodeId: root.nodeId });
                outer_html = result.outerHTML || '';
            } catch (e) {
                await sleep(250);
                continue;
            }

            if (outer_html.includes(captcha_solve_required_text)) {
                hook_logger.info('A Cloudflare turnstile CAPTCHA has appeared, attempting to click through it.');

                const fuzzy_wait_ms = rand_int((1000 * 1.5), (1000 * 5));
                hook_logger.debug('Waiting before clicking CAPTCHA to avoid robotic timing.', {
                    wait_ms: fuzzy_wait_ms
                });
                await sleep(fuzzy_wait_ms);

                const { root: { nodeId: document_node_id } } = await DOM.getDocument({ depth: -1, pierce: true });
                const { nodeIds: div_node_ids } = await DOM.querySelectorAll({
                    nodeId: document_node_id,
                    selector: 'div'
                });

                let target_node_id = null;

                for (const node_id of div_node_ids) {
                    const { attributes } = await DOM.getAttributes({ nodeId: node_id });

                    const attrs = {};
                    for (let i = 0; i < attributes.length; i += 2) {
                        attrs[attributes[i]] = attributes[i + 1];
                    }

                    if (attrs.style && attrs.style.includes('display: grid')) {
                        target_node_id = node_id;
                        break;
                    }
                }

                if (target_node_id) {
                    const { model } = await DOM.getBoxModel({ nodeId: target_node_id });

                    const x_top_left = model.content[0];
                    const y_top_left = model.content[1];
                    const x_bottom_left = model.content[6];
                    const y_bottom_left = model.content[7];

                    const click_x = (x_top_left + 25) + rand_int(-5, 5);
                    const click_y = ((y_top_left + y_bottom_left) / 2) + rand_int(-5, 5);

                    hook_logger.debug('Clicking CAPTCHA checkbox.', {
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

                    hook_logger.debug('Clicked CAPTCHA checkbox, waiting briefly for verification.');
                    await sleep((1000 * 2));
                }
            }

            if (!outer_html.includes(javascript_check_text) && !outer_html.includes(captcha_solve_required_text)) {
                hook_logger.info('Passed Cloudflare JavaScript check, continuing.');
                break;
            }

            await sleep(rand_int(400, 800));
        }
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
        await solve_cloudflare_challenge(cdp, target_url, active_logger);
    } catch (err) {
        active_logger.warn('Failed to auto-solve Cloudflare challenge in after-request hook.', {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        });
    }
}
