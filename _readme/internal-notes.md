# Internal notes

## CDP cleanup and recovery

Targets are tracked as soon as Chrome returns their ID, before attaching a tab session. Browser discovery and tab attachment have a five-second deadline. Cleanup has a six-second budget per attempt, including transport shutdown. A close acknowledgement or HTTP 404 does not remove a target from tracking until its disappearance is confirmed; an explicit CDP “no target” error also confirms removal.

Cleanup tries the existing session, the HTTP close endpoint, and a fresh browser session. If Chrome is unavailable, targets remain tracked and retry with exponential backoff up to 30 seconds. Recovery resumes when the configured CDP endpoint is reachable again; cleanup does not restart a shared browser or discard its other sessions.

The cancellation adapter in `cdptransport.js` uses the existing `chrome-remote-interface` 0.33.3 implementation. It checks that version at startup because CRI's public connection factory cannot cancel a pending handshake. Review the adapter when upgrading CRI; an unsupported version fails explicitly rather than silently disabling transport cancellation. No Chrome launch-flag changes are required.
