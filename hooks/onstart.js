import CDP from 'chrome-remote-interface';
import * as utils from '../utils.js';

function get_cdp_config() {
    console.log(process.env);
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

// This function is called upon starting thermoptic
// You can visit pages, perform actions that require
// a full browser, etc here.
// e.g. Visit a page and have the Cloudflare "check"
// load and be passed so you can do cloaked requests.
export async function hook(cdp) {
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
    const { Page, DOM } = client;

    await Page.enable();
    await DOM.enable();

    // Replace with the site that has the Cloudflare JavaScript check
    // that runs the first time you visit it.
    await Page.navigate({ url: 'https://example.com/' });
    await Page.loadEventFired();

    console.log(`[STATUS] Waiting until Cloudflare JavaScript challenge is complete...`);
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

        if (!outerHTML.includes('Verifying you are human. This may take a few seconds')) {
            console.log(`[STATUS] Passed Cloudflare's JavaScript check! Moving along...`);
            break;
        }
    }

    // Close tab now that we've passed the challenge
    await Target.closeTarget({ targetId: targetId });
    await client.close();
};
