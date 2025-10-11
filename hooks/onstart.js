import CDP from 'chrome-remote-interface';
import * as logger from '../logger.js';

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

// This text means we have to click the CAPTCHA to continue
const captcha_solve_required_text = `Verify you are human by completing the action below.`;

// This text means a JavaScript check if running on the turnstile.
const javascript_check_text = `Verifying you are human. This may take a few seconds`;

function rand_int(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// This function is called upon starting thermoptic
// You can visit pages, perform actions that require
// a full browser, etc here.
// e.g. Visit a page and have the Cloudflare "check"
// load and be passed so you can do cloaked requests.
export async function hook(cdp) {
    const hook_logger = logger.get_logger();
    /*
        This is an example that loads a page with Cloudflare's JavaScript
        challenge on it and waits for it to finish before closing the tab.

        Since the challenge is solved and cookies are set in the browser,
        we can now make direct HTTP requests to the site with our usual
        HTTP client. Nice and easy!
    */
    const { Target } = cdp;
    const { targetId } = await Target.createTarget({ url: 'about:blank' });
    let init_params = get_cdp_config();
    init_params.target = targetId;
    const client = await CDP(init_params);
    const { Page, DOM, Input } = client;

    await Page.enable();
    await DOM.enable();

    // Replace with the site that has the Cloudflare JavaScript check
    // that runs the first time you visit it.
    await Page.navigate({ url: 'https://example.com/' });
    await Page.loadEventFired();

    hook_logger.info('Waiting until Cloudflare JavaScript challenge is complete.');
    while (true) {
        let outerHTML = false;
        // If a fast page-nav occurs we may have throw an exception
        // So we catch it and ignore if it happens and continue
        try {
            let { root } = await DOM.getDocument({ depth: -1 });
            const result = await DOM.getOuterHTML({ nodeId: root.nodeId });
            outerHTML = result.outerHTML;
        } catch (e) {
            continue;
        }

        if (outerHTML.includes(captcha_solve_required_text)) {
            hook_logger.info('A Cloudflare turnstile CAPTCHA has appeared, attempting to click through it.');

            // Wait some fuzzy amount of time before clicking so we're
            // not superhuman with it :) 
            const fuzzy_wait_ms = rand_int((1000 * 1.5), (1000 * 5));
            hook_logger.debug('Waiting before clicking CAPTCHA to avoid robotic timing.', {
                wait_ms: fuzzy_wait_ms
            });
            await sleep(fuzzy_wait_ms);

            const { root: { nodeId: documentNodeId } } = await DOM.getDocument({ depth: -1, pierce: true });

            // Get all div elements in the document
            const { nodeIds: divNodeIds } = await DOM.querySelectorAll({
                nodeId: documentNodeId,
                selector: 'div'
            });

            let targetNodeId = null;

            for (const nodeId of divNodeIds) {
                const { attributes } = await DOM.getAttributes({ nodeId });

                // Convert array of [name1, value1, name2, value2, ...] to an object
                const attrs = {};
                for (let i = 0; i < attributes.length; i += 2) {
                    attrs[attributes[i]] = attributes[i + 1];
                }

                if (attrs.style && attrs.style.includes('display: grid')) {
                    targetNodeId = nodeId;
                    break;
                }
            }

            const { model } = await DOM.getBoxModel({ nodeId: targetNodeId });

            // model.content = [x1, y1, x2, y2, x3, y3, x4, y4]
            const x_top_left = model.content[0];
            const y_top_left = model.content[1];
            const x_bottom_left = model.content[6]; // x3
            const y_bottom_left = model.content[7]; // y3

            // Fuzz our click coordinates a bit so we're not weirdly
            // clicking in the precise place each time
            const x_fuzz = rand_int(-5, 5);
            const y_fuzz = rand_int(-5, 5);

            // Width is not strictly needed; we want 25px from left
            const click_x = (x_top_left + 25) + x_fuzz;

            // Vertical center: average of top and bottom y-coordinates
            const click_y = ((y_top_left + y_bottom_left) / 2) + y_fuzz;

            hook_logger.debug('Clicking CAPTCHA checkbox.', {
                click_x: click_x,
                click_y: click_y
            });

            // Then dispatch the mouse event
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
            // Now we wait for the checking action to do something before we rescan
            await sleep((1000 * 2));
        }

        if (!outerHTML.includes(javascript_check_text) && !outerHTML.includes(captcha_solve_required_text)) {
            hook_logger.info('Passed Cloudflare JavaScript check, continuing startup.');
            break;
        }
    }

    // Close tab now that we've passed the challenge
    await Target.closeTarget({ targetId: targetId });
    await client.close();
};
