# Before Release

* Browser hooks
    * Write example Cloudflare turnstile demo
* Build Docker and `docker-compose.yml` files
    * For thermoptic itself
* Request handling
    * `<form>` `text/plain`?
    * Build comprehensive test suite to validate fingerprints
* Create default set of credentials for proxy

BUG:
```
curl --insecure 'https://example.com/?test=test'   -v   --proxy http://test:test@127.0.0.1:1234   -H 'Accept: */*'   -H 'Accept-Language: en-US,en;q=0.9'   -H 'Connection: keep-alive'   -H 'Content-Type: application/json'   -H 'Origin: http://127.0.0.1:8000'   -H 'Referer: http://127.0.0.1:8000/'   -H 'Sec-Fetch-Dest: empty'   -H 'Sec-Fetch-Mode: cors'   -H 'Sec-Fetch-Site: cross-site'   -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'   -H 'X-Custom-Header: custom-value'   -H 'sec-ch-ua: "Not:A-Brand";v="24", "Chromium";v="134"'   -H 'sec-ch-ua-mobile: ?0'   -H 'sec-ch-ua-platform: "Linux"'   --data-raw '{"id":"213123","timestamp":1231441,"value":"hokay"}'
```

curl --insecure -v --proxy http://test:test@127.0.0.1:1234 'https://ja4db.com/id/ja4/'

# ToDo

* Replace AnyProxy dependency with another more modern Node HTTP proxy library.
* Create end-to-end test suite to ensure fingerprints are correct on all layers.
