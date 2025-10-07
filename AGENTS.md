# Repository Guidelines

## Project Structure & Module Organization
- `server.js` composes `proxy.js`, `requestengine.js`, and `cdp.js` to translate incoming HTTP requests into Chrome-driven sessions.
- `routes.js` handles request classification; `fetchgen.js` and `utils.js` emit browser-side helpers and shared utilities.
- Hooks live in `hooks/` and must export `async hook`; keep logic focused and human-paced.
- Vendorized AnyProxy sources stay under `anyproxy/`; refer to `_readme/`, `browser-tests/`, and `tutorials/` for diagrams, fixtures, and walkthroughs.

## Build, Test, and Development Commands
- `npm install` — install repository dependencies once per environment.
- `google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/thermoptic` — launch Chrome with a writable profile for CDP control.
- `source env.sh && node server.js` — load credentials, then run the proxy server locally.
- `docker compose up --build` — build the container image, mint certificates, and wait for CDP readiness.
- `curl --proxy http://<user>:<pass>@127.0.0.1:1234 https://ja4db.com/id/ja4h/` — verify outbound fingerprints remain browser-identical.

## Coding Style & Naming Conventions
- Use ES modules with four-space indentation and explicit semicolons; avoid implicit returns for side-effectful steps.
- Use snake_case for variables and function names; reserve PascalCase for factory or constructor helpers and UPPER_SNAKE_CASE for constants.
- Use `import * as` when sharing utility bundles and preserve `[STATUS]`/`[WARN]` log tags.
- Keep hooks deterministic with short randomized delays to emulate human pacing.
- Skip double-question-mark (`??`) and similar ternary shortcuts that our tooling rewrites; use explicit ternary expressions or logical fallbacks instead.
- Do not reuse a single CDP session/tab across concurrent requests; each request must isolate its DevTools state.
- Preserve the bookmark-driven navigation hack—direct `Page.navigate` calls cannot replace it without breaking JA4 parity.

## Testing Guidelines
- No automated suite exists; document manual runs with Chrome build, target page, and command sequence.
- Exercise one navigation and one `fetch()` per CDP change to confirm redirect, cookie, and timeout handling.
- For new routes, capture upstream headers and generated fetch payloads; store artifacts alongside PR notes.
- With the proxy and debugging Chrome already running, execute `node scripts/abort-midstream-request.test.js` (native TLS client, bypasses cert validation) to stress abort handling and confirm stability after an aborted stream.
- Load test concurrency with `node scripts/concurrent-load.test.js`; tune `LOAD_TEST_REQUESTS` and `LOAD_TEST_CONCURRENCY` to match lab capacity and watch for failures or latency spikes.
- To mirror fetch-style traffic via curl, run `node scripts/concurrent-load-curl.test.js`; it spawns parallel curl clients with the same headers and validates responses for browser parity.

## Commit & Pull Request Guidelines
- Follow the prevailing single-line imperative style, e.g., `Improve fetch route timeout handling`; link issues with `Refs #123` when relevant.
- Describe scraping scenarios, call out env or hook changes, and include manual verification steps in PRs.
- Update README, tutorials, or launch scripts whenever CDP parameters or operator workflows shift.

## Security & Configuration Tips
- Rotate proxy credentials in `env.sh` and documentation; never ship defaults.
- Treat `ssl/` and `cassl/` contents as secrets and prevent hooks from leaking session data.
- Announce Chrome debugging parameter changes early so operators can adjust launch scripts.
