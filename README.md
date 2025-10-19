# thermoptic

<!-- ![Rare image of the Major smiling]() -->

<a href="https://www.youtube.com/watch?v=qkXReli7eC0" target="_blank"><img src="_readme/gits.gif" width="100%"></a>

> *"I don't believe it, thermoptic camouflage!"*

## What is it?

This is an HTTP proxy designed to bypass services that use fingerprinting such as [JA4+](https://blog.foxio.io/ja4%2B-network-fingerprinting) to block certain HTTP clients. Using this proxy, you can use your preferred HTTP clients like `curl` and still have [magically](#how-does-that-work-exactly) indistinguishable fingerprints from a real (Chrome/Chromium) web browser. `thermoptic` also comes with some [fun features](#handling-browser-javascript-fingerprinting-with-thermoptic-hooks) to mitigate JavaScript-based fingerprinting. It also makes it easy to do hybrid scraping using both a web browser and low-level HTTP clients together.

Even if you’re unfamiliar with JA4+ fingerprinting, if you’ve done any scraping you’ve probably been blocked by it before. Popular services such as Cloudflare use such techniques (and other tricks) to detect use of "non-human" HTTP clients to block requests. These services can also use this fingerprinting to detect if you start a session with a real browser and then switch to a low-level client like `curl` later. `thermoptic` solves all of these problems by presenting a unified "real" browser fingerprint for all scraping requests.

## Example

Here's an example JA4H (HTTP) fingerprint of `curl` without the proxy:

```
$ curl https://ja4db.com/id/ja4h/
ge11nn090000_b6a016211e8a_000000000000_e3b0c44298fc
```

This is quite different from the fingerprint that Chrome produces when you visit the URL directly:

```
ge11cn19enus_f2808f0d04cf_9a10d4221160_7068f58def6e
```

However, when we use the proxy to make the request, our JA4H fingerprint is magically identical:

```
$ curl --proxy http://username:password@thermoptic:1234 https://ja4db.com/id/ja4h/
ge11cn19enus_f2808f0d04cf_9a10d4221160_7068f58def6e
```

(The same goes for our JA4 TLS fingerprint as well, etc).

## Setup

To start a `thermoptic` proxy which cloaks your traffic through a containerized Chrome instance on Ubuntu 22.04:

```
docker compose up --build
```

That's all, now you can proxy traffic through it:

```
curl --proxy http://changeme:changeme@127.0.0.1:1234 --insecure https://ja4db.com/id/ja4h/
```

Important notes:
* Default proxy username and password are `changeme` please make sure you change them before exposing externally.
* If you don't want to use `---insecure` you need to use the generated CA file located in `./ssl/rootCA.crt`. This is generated the first time you run `thermoptic`.
* You can connect `thermoptic` to any Chrome/Chromium instance launched with the `--remote-debugging-port` flag. This is essential as you'll want to set up and proxy through more commonly used environments to keep your fingerprint as low profile as possible (e.g. Chrome on Windows).

## Features

- 🕵️ [Browser-parity proxying](#how-does-this-cloaking-work-exactly) that replays requests through a real Chrome session to match JA4 fingerprints byte-for-byte.
- 🤝 Little to no custom code required to integrate your HTTP client (e.g. `curl`, `requests`, etc) with `thermoptic`, just [set the proxy](#setup) and your fingerprints are taken care of.
- 🪝 [Hook framework](#handling-browser-javascript-fingerprinting-with-thermoptic-hooks) for before-request/after-request/on-start automation so you can drive the full browser to solve challenges, or capture artifacts.
  - 📘 An example Cloudflare turnstile solving hook can be seen in [`./hooks/onstart.js`](https://github.com/mandatoryprogrammer/thermoptic/blob/main/hooks/onstart.js).
- 🖥️ [Web-browser control UI](#control-the-dockerized-chrome-browser-via-web-ui-xpra) (at `http://127.0.0.1:14111`) to control the Dockerized Chrome browser window. Useful to manually log into sites manually and then seemlessly use the proxy to make requests as your logged-in session (and for debugging).
- 🛡️ Built-in health checks and restart control loop to detect frozen browsers and recover automatically without operator babysitting.

## How does this cloaking work exactly?

![Visual diagram example](_readme/diagram.png)

* An HTTP request is made using an HTTP client such as `curl` with `thermoptic` set as a proxy.
* `thermoptic` analyzes the request to best determine what type of browser request it's *supposed* to be (e.g. manual URL visit? Form submission? A `fetch()` request?).
* `thermoptic` uses the [Chrome Debugging Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) to puppet the browser and set up a page that mocks the request exactly as it normally would occur in a real web browser.
* `thermoptic` triggers the request via the mocked context and captures the HTTP response.
* `thermoptic` sends the HTTP response back to the client.

Due to the fact that the browser is actually making the request using its full stack, the resulting JA4 fingerprints are identitical.

NOTE: Due to many WAFs employing JavaScript-level fingerprinting of web browsers, `thermoptic` also exposes hooks to utilize the browser for key steps of the scraping process. See [this section](#handling-browser-javascript-fingerprinting-with-thermoptic-hooks) for more information on this.

## Why *this* approach vs other solutions?

To put it bluntly: other approaches have fundamental flaws which prevent them from being a practical long term solution to the browser fingerprinting problem.

Many other attempts to "beat" browser JA4+ fingerprinting do so by reimplementing the various layers of the browser stack. This approach has a number of serious drawbacks, such as:

* Requiring great care to match the behavior of the "real" browser implementation perfectly. As a result, *any* quirks or discrepancies can be used to differentiate these clients from the "real" browser implementation.
* Attempting to only solve the problem at one layer of the stack. Chrome utilizes multiple protocols to provide a web browsing experience. As a result, even if you've made a perfectly-matching TLS layer your HTTP layer may give you away if it's not byte-perfect.
* As the "real" browsers regularly change their behavior, their fingerprints change, and as a result these tools constantly require more intensive development work to compensate.

In contrast, because `thermoptic` uses the browser itself to perform HTTP requests:
* Each layer of the stack such as TCP, TLS, HTTP are indistinguishable from the real browser because the request is made *using* a real browser in the way it would *normally* occur.
* Changes to browser behavior at various layers are minimally disruptive, the browser `thermoptic` controls just needs to be updated in order to match the latest set of fingerprints.

Of course, no solution is without drawbacks. See the `DOWNSIDES.md` docs for a fleshed out list of downsides to the `thermoptic` approach.

## FAQ

### Why the name `thermoptic`?

"Thermoptic" (short for "thermoptic camouflage") is a reference to the fictional camouflage [used by the Major in the Ghost in the Shell (1995) anime](https://ghostintheshell.fandom.com/wiki/Thermoptic_camouflage). In the movie, this camouflage is shown to be able to hide the wearer across multiple spectrums of detection including both visual light and thermal radiation. Similarly, this tool attempts to cloak the user from fingerprinting across multiple channels (HTTP, TLS, etc).

### JA4+ is a **suite** of fingerprints! Which ones does it spoof?

This tool will spoof the following JA4 fingerprints to be exactly like the Chrome/Chromium browser you're connected to:
* JA4 (TLS fingerprint)
* JA4H (HTTP fingerprint)
* JA4X (X509 TLS certificate fingerprint)
* JA4T (TCP fingerprint)

### What if I want to use another HTTP proxy with this?

You can configure an HTTP proxy to be used by the web browser that `thermoptic` controls. Please note that depending on the context, this could cause fingerprinting differences (e.g. at the TCP stack level).

### What about cookies?

`thermoptic` will load the browser with the cookies your client specifies in the `Cookie` header. The request will then include these once it is executed in the browser context. This is done to ensure the server cannot fingerprint the ordering of the cookies or any other cheap tricks like that.

*NOTE: these cookies will stick around after the request as well. If you'd like to implement cleanup logic for cookies, please write a `thermoptic` hook.*

### OK, but need a full web browser to click through X prompt to pass human verification!

Yep, `thermoptic` supports hybrid usage like this, [see this section for more information.](#handling-browser-javascript-fingerprinting-with-thermoptic-hooks)

### What about proxies?

You [can set a proxy for Chrome to use](https://www.chromium.org/developers/design-documents/network-settings/) and then set `thermoptic` to use that Chrome instance. Future releases of `thermoptic` will streamline this process.

### My fingerprint for request X doesn't match the browser fingerprint!

You need to make sure that you're setting headers like `X-Fetch-*`, `Origin`, and `Referer` correctly. If you don't tell `thermoptic` about these headers then it won't be able to execute the request in the appropriately stealthy way.

Without setting contextual headers `thermoptic` will set default values which may not reflect exactly what your target site expects. For example, if you don't set an `Origin` header it will set an `Origin` of `null`, if you don't set a `Referer` header then it will simply not send a `Referer` at all.

It's in your best interest to include these contextual headers so that your request is as stealthy as possible! `thermoptic` can't read your mind, it can only read your request `:)`.

### The Chrome Debugging Protocol *itself* is fingerprintable!

Generally this would only apply in the case of `thermoptic` hooks which temporarily utilize the full web browser to pass JavaScript/browser-level checks. When temporarily using these hooks and full browser mode you'll have to take care to not be fingerprinted as a bot (e.g. avoid gotchas like [`Runtime.enable`](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/#:~:text=Provoking%20Object%20Serialization)).

### *Why* release this tool? Don't you care about the evil actors you're enabling?!

The ethical considerations and the complex game theory at play here is greater than can be answered in a README. Feel free to argue against any one of these over-simplified points when you flame me via email/Twitter/Github though:

* I don't believe scraping to be inherently unethical. To the contrary, the free flow of information in the form of scraping is key to how [many](https://archive.org/) [amazing](https://www.courtlistener.com/) [projects](https://findthatmeme.com/) [have](https://en.wikipedia.org/wiki/Google) [been](https://fccid.io/) [given](https://commoncrawl.org/) breath.
* Due to the incentives at play, web scraping and prevention of web bots has now become a boring game of capital burn. Want to prevent scraping? Pay a [service](https://www.cloudflare.com/application-services/products/bot-management/) [to](https://www.akamai.com/products/bot-manager) [do](https://aws.amazon.com/waf/features/bot-control/) [it](https://clouddocs.f5.com/bigip-next/20-2-0/waf_management/waf_bot_protection.html) for you. Want to bypass those same services? Pay a [service](https://www.scraperapi.com/solutions/scraping-api/) [to](https://www.scrapingbee.com/) [do](https://brightdata.com/pricing/web-unlocker) it for you. Scraping is far too important to be left to only those who can afford it, I'm releasing this open source project as an action of my belief to that effect.
* The current paradigm for anti-bot frameworks is intensely invasive due to its fingerprint-focus. Advanced browser fingerprinting scripts are barely distinguishable from browser exploit kits in their functionality. I hope, but don't expect, a step function increase on the scraping side to help subvert this feedback loop and encourage [alternative](https://en.wikipedia.org/wiki/Proof_of_work) [approaches](https://blog.cloudflare.com/introducing-cryptographic-attestation-of-personhood/).

For further banter around the scraping arms race I ask that you at least buy me a beer first. To be honest, I hate writing these boring ethical essays in my READMEs so feel free to just imagine me as an evil nerd who wants to make your life harder.

## Configuration

These environment variables specify how `thermoptic` should be configured when it runs.

`HTTP_PROXY_PORT`: The port that the `thermoptic` proxy should listen on. If you're running `thermoptic` in Docker you'll also need to change the `ports` mapping field to match.

`CHROME_DEBUGGING_PORT`: The port that the Chrome Debugging Protocol is exposed on. This port is specified when you launch Chrome/Chromium with the `--remote-debugging-port` flag set to a value such as `9222`.

`CHROME_DEBUGGING_HOST`: The host that the Chrome Debugging Protocol is exposed on. This is often `127.0.0.1` if the browser is launched locally and `thermoptic` is not running in Docker. If it is running in Docker you may have to use `host.docker.internal`, see the [Docker docs](https://docs.docker.com/desktop/features/networking/#i-want-to-connect-from-a-container-to-a-service-on-the-host) for information.

`PORT`: The CDP port the Chrome container publishes to the rest of the stack. Keep it aligned with `CHROME_DEBUGGING_PORT` so the `socat` bridge keeps working as expected.

`CHROME_CONTROL_PORT`: Chrome's control-service port that thermoptic uses to manage the browser (for example, sending restart requests).

`CHROME_CONTROL_COOLDOWN_MS`: Minimum time in milliseconds between Chrome restart attempts. Use this to avoid rapid restart loops when multiple failures occur in quick succession.

`ENABLE_GUI_CONTROL`: Set to `true` to launch the xpra web panel so you can drive the containerized Chrome by visiting `http://127.0.0.1:14111`. Disable it for headless-only runs.

`XPRA_PORT`: The TCP port xpra listens on when GUI control is enabled (defaults to `14111`). Change it if that port is already in use on your host.

`CHROME_SCREEN_WIDTH` / `CHROME_SCREEN_HEIGHT`: The pixel dimensions of the dockerized headful Chrome display.

`PROXY_USERNAME`: The username which is used to authenticate you to the proxy, default is `changeme`.

`PROXY_PASSWORD`: The password which is used to authenticate you to the proxy, default is `changeme`.

`THERMOPTIC_CONTAINER_RUNTIME`: Signals that thermoptic is running inside the bundled container. Leave this set to `true`; it gates behaviors like the built-in health checks that only make sense in the full Docker setup.

`HEALTHCHECK_ENDPOINT_PORT`: The port where thermoptic exposes its health-check web endpoint. The health worker calls this through the proxy; if it stops responding, Chrome is automatically restarted to unstick frozen sessions.

`HEALTHCHECK_ENDPOINT_PATH`: The HTTP path served by the health-check endpoint described above. Change it if you need a different URL.

`ON_START_HOOK_FILE_PATH`: Custom Node code to run on proxy start. The proxy will not begin listening until this hook has completed, see the example in `./hooks/`. The sample demonstrates using the browser to click through Cloudflare's JavaScript browser check before starting the proxy.

`BEFORE_REQUEST_HOOK_FILE_PATH`: Custom Node code to run before a request has been proxied. This is useful if you need the browser to pass some check before a site HTTP request is made.

`AFTER_REQUEST_HOOK_FILE_PATH`: Custom Node code to run after a request has been proxied. Often this is useful to do things like clean up cookies that have been set by the client via `Cookie` header.

`DEBUG`: Set this to `true` when you hit a bug so thermoptic prints verbose diagnostics before you file an issue; leave it `false` during normal operation.

## Handling browser JavaScript fingerprinting with `thermoptic` hooks

`thermoptic` allows you to configure custom scripting in order to perform browser actions when:
* The browser is first started (environment variable `ON_START_HOOK_FILE_PATH`)
* A request is about to be proxied (environment variable `BEFORE_REQUEST_HOOK_FILE_PATH`)
* A request has just finished being proxied (environment variable `AFTER_REQUEST_HOOK_FILE_PATH`)

This allows you to use the Chrome Debugging Protocol to click around and set the appropriate cookies for sites that require a real web browser for a verification step. You can then use the `thermoptic` proxy to continue your session cloaked through the same browser.

To do this, modify the appropriate hook JavaScript file with your custom code to orchestrate the browser appropriately via the provided `chrome-remote-interface` interface:

```
// `cdp` is an instance of a connected browser, use it to run your browser actions
export async function hook(cdp) {
    console.log(`[STATUS] Browser start hook called successfully!`);
}
```

For an example implementation, see the [`./hooks/onstart.js`](https://github.com/mandatoryprogrammer/thermoptic/blob/main/hooks/onstart.js) file which [bypasses the Cloudflare turnstile CAPTCHA](https://github.com/mandatoryprogrammer/thermoptic/blob/main/tutorials/turnstile/cloudflare-turnstile-bypass.md) (and other Cloudflare anti-bot checks).

## Control the Dockerized Chrome Browser via Web UI (Xpra)

`thermoptic` comes with Xpra web UI which is available at `http://127.0.0.1:14111`. This allows you to manually control the Dockerized Chrome browser with ease:

<img src="_readme/browser-control.png" width="100%">

This is useful for things such as:
* Logging into your account so that you can make authenticated requests through `thermoptic` using your preferred HTTP client like `curl`.
  * For example if you log into `reddit.com` with the browser, then all requests you make to Reddit through `thermoptic` will automatically be authenticated as your Reddit account!
* Debugging your custom `thermoptic` hooks and checking for issues with websites.

## Security

Note that at this time `thermoptic` is only meant to be used with HTTP clients you explicitly trust. It's *not* meant to be exposed to untrusted users.

For any security vulnerabilities please send a report to me at `mandatory@` Gmail.
