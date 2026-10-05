# Internal notes

## CDP cleanup and recovery

Targets are tracked as soon as Chrome returns their ID, before attaching a tab session. Browser discovery and tab attachment have a five-second deadline. Cleanup has a six-second budget per attempt, including transport shutdown. A close acknowledgement or HTTP 404 does not remove a target from tracking until its disappearance is confirmed; an explicit CDP “no target” error also confirms removal.

Cleanup tries the existing session, the HTTP close endpoint, and a fresh browser session. If Chrome is unavailable, targets remain tracked and retry with exponential backoff up to 30 seconds. Recovery resumes when the configured CDP endpoint is reachable again; cleanup does not restart a shared browser or discard its other sessions.

The cancellation adapter in `cdptransport.js` uses the existing `chrome-remote-interface` 0.33.3 implementation. It checks that version at startup because CRI's public connection factory cannot cancel a pending handshake. Review the adapter when upgrading CRI; an unsupported version fails explicitly rather than silently disabling transport cancellation. No Chrome launch-flag changes are required.

## HTTP request scheme

The dedicated Chrome image preserves caller-requested HTTP by installing `chrome/policies/http_request_scheme.json` as a mandatory managed policy. `HttpsUpgradesEnabled: false` disables opportunistic HTTPS upgrades; `HttpsOnlyMode: "disallowed"` disables HTTPS-First ("Always use secure connections"), including when it was enabled in an existing profile. The two mechanisms are independent: disabling the `HttpsUpgrades` feature alone leaves HTTPS-First active.

Without these settings, Chrome can upgrade the navigation to HTTPS while `manual_browser_visit()` waits for a response matching the original HTTP URL, producing a 30-second timeout. An HTTP page used to establish a fetch context can also acquire the wrong scheme. Keeping these requests on HTTP is intentional proxy behavior; traffic that would otherwise have received an automatic upgrade can remain plaintext.

Rebuild and recreate the Chrome service to install the policy: `docker compose up -d --build chrome`. Existing profiles can be retained. In the dedicated browser, `chrome://policy` should show `HttpsUpgradesEnabled` as `false` and `HttpsOnlyMode` as `disallowed`, both mandatory and without errors. Chrome instances supplied separately from this image need equivalent configuration in their own dedicated environment; these files are not applied to the host's everyday browser.

Explicit HTTPS requests, certificate validation, HSTS, and server-issued redirects remain enabled. An HTTP URL covered by HSTS can still return Chrome's 307 upgrade redirect. These settings do not guarantee HTTP for HSTS hosts or measure TLS/HTTP fingerprint parity.

Policy references: [HttpsUpgradesEnabled](https://chromeenterprise.google/policies/#HttpsUpgradesEnabled) and [HttpsOnlyMode](https://chromeenterprise.google/policies/#HttpsOnlyMode).

## Captured response bytes and framing

Both CDP capture paths decode base64 directly into a `Buffer`, with UTF-8 for protocol text. Converting base64 through `atob()` and then UTF-8 re-encodes bytes above `0x7f`; it does not preserve binary or UTF-8 response bytes. Chrome also decompresses captured bodies, so upstream compression and transfer framing cannot describe the returned buffer.

The shared header formatter removes content encoding, every casing of content length, hop-by-hop fields (including fields named by `Connection`), and trailer declarations. Ordinary responses receive one length for the captured bytes; repeated headers remain separate values, including `Set-Cookie`. HEAD and 304 omit the optional representation length because the decoded representation size is unknown; 1xx and 204 omit the forbidden length, and 205 returns an empty body with length zero. Redirects retain their status and `Location` but return an empty body because CDP does not expose redirect bodies.

The proxy finalizes framing again after `AFTER_REQUEST_HOOK` has completed. Hooks still receive the captured body's initial length, but the send path discards all casings of `Content-Length`, `Transfer-Encoding`, and `Trailer`, converts the final body to bytes, and sets one length for those exact bytes where permitted. The same final buffer is sent to mockttp. Bodyless rules are reapplied to the final status, so a hook cannot accidentally send a body with HEAD, 204, 205, or 304. The handler's generated 502 fallback uses the same framing path, and TRACE reflects the finalized response.

The downstream HTTP/1 connection policy is derived from the client's HTTP version and `Connection` options, independently of the browser's upstream connection. This explicit header is needed because mockttp removes Node's default connection header. HTTP/2 receives no connection-specific headers. All final responses have a byte length or bodyless semantics; HTTP/1 persistence follows the client's version and connection options.

The existing synthetic OPTIONS preflight policy only applies when both `Origin` and `Access-Control-Request-Method` identify a real preflight. `Access-Control-Request-Headers` is optional; when absent, no `Access-Control-Allow-Headers` field is emitted. Ordinary same-origin OPTIONS requests, and requests whose preflight is cached, continue to the server. Chrome response-stage network errors fail promptly instead of being treated as new requests until timeout.

### Manual verification, 2026-10-04

Chrome 152.0.7977.64 and Node 18.20.4 were used with existing repository dependencies. The browser had a disposable profile and the repository's managed policies mounted into an isolated process. All upstream targets were loopback HTTP fixtures; the actual proxy used a temporary CA and generated credentials. No user Chrome profile or repository CA material was used.

The review-only harness was run with `CHECK_TIMEOUTS=1 node /tmp/thermoptic-response-fix-20261004/verify.mjs`; its source, `run.log`, and `results.json` are local review artifacts in that directory, not repository dependencies or a committed test suite. It sends ordinary requests through `get_http_proxy()` and `requestengine.process_request()` with an HTTP/1 keep-alive client.

All 38 end-to-end checks passed; 32 requests reused an existing downstream connection. Coverage includes navigation and fetch for ASCII/Unicode, gzip/Brotli/deflate, mixed header casing, chunked responses with trailers and connection-specific fields, empty bodies, redirects, 204/205/304, and partial responses; binary fetch, compressed HEAD, same-origin OPTIONS, cross-origin OPTIONS with and without custom headers, caller cookie forwarding, network errors, timeout expiry, and a successful request after timeouts. Body bytes and wire header lengths are checked, along with header uniqueness, removal of conflicting transfer framing, and connection reuse. Repeated `Set-Cookie` preservation is checked at the formatter boundary: this Chrome build omits those headers from the observed Fetch response events, so the live cookie check covers caller cookies reaching the upstream server.

Syntax checks: `node --check cdp.js`, `node --check utils.js`, and `node --check proxy.js`; whitespace check: `git diff --check`. These changes do not alter Chrome launch parameters, navigation mechanisms, TLS settings, or generated ordinary request headers. Fingerprint parity was not measured by the loopback checks.

### Post-hook verification, 2026-10-05

With the same installed Node, Chrome, and repository dependencies, `node /tmp/thermoptic-hook-framing-20261005/verify.mjs` passed 36 local wire checks over HTTP/1.1 and TLS HTTP/2. This temporary harness invokes an asynchronous hook through `utils.run_hook_file()` inside the actual proxy callback. It covers growing/shrinking UTF-8 bodies, empty/null bodies, binary buffers, typed-array slices and ArrayBuffers, object/Map/array header formats, replacement transfer/trailer headers, HEAD and 204/205/304, a hook restoring a body after 204, missing-status fallback, and the generated 502 response. Assertions check exact returned bytes, one correct length or its required omission, removal of transfer/trailer headers, repeated cookies, and HTTP/1 connection reuse. Sources, `run.log`, and `results.json` remain local review artifacts in that directory.

`node /tmp/thermoptic-response-fix-20261004/verify.mjs` also passed all 36 normal Chrome navigation/fetch checks again, including network-error recovery, with two downstream sockets. This rerun excludes the two 30-second timeout cases already verified above. Its log is `post-hook-run.log`; the earlier timeout run is preserved in `run-with-timeouts.log` and `results-with-timeouts.json`. Syntax and whitespace checks passed. No dependencies were installed and no test suite was added to the repository.

### Repeated-header hook compatibility, 2026-10-05

The bundled after-request hook reads metadata from both strings and arrays of strings. Its case-insensitive header reader creates a comma-separated string view for metadata checks and ignores non-string entries; it leaves the response header object and repeated `Set-Cookie` values untouched. This prevents repeated `Server`, `Content-Type`, or `CF-Mitigated` fields from causing `.toLowerCase()` failures after capture starts preserving duplicates.

`node /tmp/thermoptic-hook-framing-20261005/duplicate-headers.mjs` passed eight focused checks using the real formatter and bundled hook, covering ordinary and repeated metadata, mixed header casing, non-HTML and empty values, and unchanged cookies. The fixtures have no target URL and use a CDP sentinel to ensure no browser operations occur. `node /tmp/thermoptic-hook-framing-20261005/verify-bundled-hook.mjs` then passed all 36 HTTP/1.1 and TLS HTTP/2 wire checks with repeated `Server` fields passed through the bundled hook before the existing body-changing fixture hook. Results are in `duplicate-results.json` and `bundled-hook-wire-results.json`; the wire log is `bundled-hook-wire.log`. Hook syntax and whitespace checks passed; no dependencies or committed tests were added.
