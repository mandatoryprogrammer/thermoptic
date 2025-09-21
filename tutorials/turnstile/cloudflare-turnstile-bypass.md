# "Bypassing" Cloudflare's Turnstile CAPTCHA With `thermoptic`

NOTE: I appologize for any writing mistakes in this tutorial. Due to the subject matter popular LLMs refused to help me critique it 😂.

This is a tutorial on how to write hooks for the `thermoptic` proxy which allow you to bypass anti-bot services such as Cloudflare's turnstile CAPTCHA. You can use this tutorial as a template to write hooks to bypass whichever anti-bot frameworks are causing you trouble.

If you've spent some time browsing the web you're probably familiar with this dreaded CAPTCHA box:

![Cloudflare CAPTCHA image](./cloudflare-captcha.png)

Either the website you're visiting has turned on some paranoid security settings in Cloudflare, or your browser and source IP reputation is low enough that you're being stopped at the door. Whatever the case, it's now an annoyance that you have to deal with.

## A Scraping Headache

If you're trying to scrape a site this is especially painful because if you're using a low-level HTTP client like `curl` you are seemingly out of luck. Without a full browser to click through this CAPTCHA you're not getting anywhere.

You might think *"can't I just use my browser briefly and then copy the cookies into Chrome?"*. Sadly, this does not work. Cloudflare can detect if you *start* with a full-browser client and then suddenly switch to a different one. So if you switch to `curl` Cloudflare will stop you even if you have the correct cookies from passing this challenge in your browser.

So what can be done?

## Utilizing `thermoptic` Hooks to Pass the Turnstile

Luckily, `thermoptic` is built to solve exactly this problem without making any complex changes to your existing HTTP client. We can utilize `thermoptic` to pass this check and scrape the site as if it wasn't behind Cloudflare at all.

Since [the `thermoptic` HTTP proxy cloaks all of our requests to perfectly match the Chrome browser](https://github.com/mandatoryprogrammer/thermoptic?tab=readme-ov-file#what-is-it) we already have a solution to the "switching clients" problem. If we proxy our low-level client like `curl` through `thermoptic` we'll have an indistinguishable fingerprint from the real thing across all layers of the stack (TLS, HTTP, DNS, etc). Cloudflare will have no idea that we've ever switched to `curl`.

Now we're just left with clicking the turnstile CAPTCHA so Cloudflare will allow us through to the site. This is where [`thermoptic` hooks](https://github.com/mandatoryprogrammer/thermoptic?tab=readme-ov-file#handling-browser-javascript-fingerprinting-with-thermoptic-hooks) come in.

`thermoptic` hooks allow us to temporarily control the browser at either proxy start, pre-request, or post-request. So we'll write a hook on proxy start to load our target website and then click the turnstile CAPTCHA so we can pass the check.

### Gotchas When Going "Full Browser" With Frameworks Like `puppeteer`

Now, it's important to realize that if you're using the popular scraping libraries such as `puppeteer` to control the browser that you expose yourself to a bunch of common fingerprinting techniques.

A classic example is the `navigator.webdriver` window variable which is set to `true` on a variety of browser automation frameworks such as `puppeteer`, `selenium`, etc.

There are so many of these tricks that packages such as [`puppeteer-extra-plugin-stealth`](https://www.npmjs.com/package/puppeteer-extra-plugin-stealth) exist purely to mask these exposures. However, this is often a cat and mouse game as anti-bot services are always coming up with new clever tricks to fingerprint these frameworks. As a result these codebases need to be continually updated, and in the case of `puppeteer-extra-plugin-stealth` there sadly hasn't been an update in over three years.

### Using Just the Chrome Debugging Protocol

I have good news! You don't actually *need* to use a heavy framework like `puppeteer` to automate the browser. Ultimately `puppeteer` just utilizes the [Chrome Debugging Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) to control Chrome/Chromium-based browsers and you can also do the same.

There are some very real benefits to going this route as you immediately remove a number of easy paths for detecting that you're a bot. However, you've still got to be careful as using certain CDP APIs can still be fingerprinted.

Perhaps the biggest gotcha is using the `Runtime` API via `Runtime.enable`. This is usually done when you want to run some custom JavaScript on a given page and is a very large convenience feature when it comes to scraping. However, due to an [object-serialization nuance](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/#:~:text=Provoking%20Object%20Serialization) this makes your scraping immediately apparent to anti-bot services. Case in point, if you utilize this to try to click through Cloudflare's turnstile the check will **fail** and *you won't be let through.*

Sadly this means in practice the automation is a little bit trickier since we can't inject JavaScript to interact with the page. So no use of `document.querySelector().click()` or niceties like that. However, worry not, we can still accomplish our goal without use of the `Runtime` API!

### Writing a `thermoptic` Hook to Click Through the Cloudflare Turnstile

I've already taken the liberty of [writing a `thermoptic` hook](https://github.com/mandatoryprogrammer/thermoptic/blob/main/hooks/onstart.js) that runs on proxy start and clicks through the Cloudflare turnstile. The code makes no use of the `Runtime` API and passes all of Cloudflare's checks with ease!

The code makes use of only the `Target`, `Page`, `DOM`, and `Input` CDP APIs which prevents Cloudflare from easily flagging us as a bot. The core code of substance is pretty straightforward:

```js

// Get all div elements in the document
const { nodeIds: divNodeIds } = await DOM.querySelectorAll({
    nodeId: documentNodeId,
    selector: 'div'
});

// Find the <div> housing the Cloudflare <iframe>
// The Cloudflare turnstile CAPTCHA box is inside of it.
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
```

Once this code finds the parent `<iframe>` that houses the Cloudflare turnstile CAPTCHA we now know roughly where it is that we have to click. We're doing the click via the CDP `Input` API because we want to do it just like a real-user would. By doing it this way we also avoid all of the annoying pitfalls of attempting to slice through the turnstile [shadow-DOMs](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM), nested `<iframe>`s, and randomized DOM elements.

With the parent `<div>` element that houses the turnstile we simply calculate the bounding-box coordinates of the element and then calculate an offsetted coordinate to click at:

```js
// Get the bounding box of the element housing the Cloudflare
// turnstile CAPTCHA.
const { model } = await DOM.getBoxModel({ nodeId: targetNodeId });

// The checkbox square is roughly 25px from the left of the box
const click_x = (x_top_left + 25) + x_fuzz;

// The checkbox is in the exact middle of the parent element
// So we calculate the middle of the vertical space.
const click_y = ((y_top_left + y_bottom_left) / 2) + y_fuzz;

// Fuzz our click coordinates a bit so we're not weirdly
// clicking in the precise place each time
const x_fuzz = rand_int(-5, 5);
const y_fuzz = rand_int(-5, 5);

// Kick off the manual click action
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
```

To appear less robotic we also add some fuzziness to our delay before clicking the checkbox *and* to where we click the mouse. Humans aren't really so good at doing pixel perfect clicking at near-perfect pace (unless they're [world-class speedrunners](https://www.youtube.com/watch?v=U7RzoIEoSMY)).

Utilizing this [new hook](https://github.com/mandatoryprogrammer/thermoptic/blob/main/hooks/onstart.js), we now just need to enable it by setting the appropriate `ON_START_HOOK_FILE_PATH` environment variable in the `thermoptic` `docker-compose.yml`:

```yaml
thermoptic:
build: .
volumes:
    - ./ssl:/work/cassl
    - ./hooks:/work/hooks
depends_on:
    - chrome
ports:
    - 1234:1234
environment:
    HTTP_PROXY_PORT: 1234
    CHROME_DEBUGGING_PORT: 3003
    CHROME_DEBUGGING_HOST: chrome
    PROXY_USERNAME: changeme
    PROXY_PASSWORD: changeme
    # Updated to point to our newly-written Cloudflare turnstile hook
    ON_START_HOOK_FILE_PATH: /work/hooks/onstart.js
```

Now upon starting `thermoptic` will execute this hook in the browser that all requests are proxied through.

### Proof-of-Concept in Action

Armed with our new `thermoptic` hook we can now see that upon starting the proxy the Cloudflare turnstile CAPTCHA is automatically solved for us (pardon the slowed-down low-quality `.gif`):

![gif Video of turnstile hook in action](./solving-captcha-demo.gif)

Once the hook has finished running we can now scrape the site with `curl` easily by running it through the `thermoptic` proxy:

```sh
curl --proxy http://changeme:changeme@127.0.0.1:1234 --insecure https://example.com
```

Nice and easy, and no changes need to be made to our scraping client to handle Cloudflare! All of the work of browser cookies and byte-perfect protocol presentation is handled entirely by `thermoptic` fpr us.

To make things better, this [proof-of-concept `thermoptic` hook](https://github.com/mandatoryprogrammer/thermoptic/blob/main/hooks/onstart.js) also passes the lesser "Checking your browser..." non-interactive check as well. So unless Cloudflare has "hard blocked" your IP, you can scrape sites behind their service with ease.

# Closing

I hope this tutorial makes it clear how to write your own `thermoptic` hooks to bypass browser-level checks. If you'd like to learn more about why `thermoptic` is a unique approach to scraping [check out the main README](https://github.com/mandatoryprogrammer/thermoptic).

**Important**: Before you decide to flame me for this tutorial please see [this section of the `thermoptic` README.](https://github.com/mandatoryprogrammer/thermoptic?tab=readme-ov-file#why-release-this-tool-dont-you-care-about-the-evil-actors-youre-enabling)

Notably this tutorial isn't meant to imply that Cloudflare's approach is a bad one. In fact the Cloudflare folks behind turnstile and the anti-bot efforts are some sharp folks (just give [their blog](https://blog.cloudflare.com/turnstile-private-captcha-alternative/) a read!). However, it does serve as a clear example that even world-class anti-bot frameworks can be handled with `thermoptic`.