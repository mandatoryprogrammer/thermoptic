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
