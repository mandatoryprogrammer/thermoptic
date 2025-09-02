# Downsides of the `thermoptic` Approach

While the `README` is a clear pitch on the advantages of the `thermoptic` approach, this page attempts to be a counter-balance with all perceivable downsides of it. If anything is not convered here please feel free to submit a PR. Notably some of these downsides apply not only to `thermoptic` but to all browser-based scraping approaches (e.g. such as latency).

## Complex problem of request parsing and request rewriting

* How much do we respect the clients request form? How much do we rewrite?

## Errors in inference of the requestor's request context

* If the client lacks sufficient headers to inform `thermoptic` of the request context, we will fail to replicate it properly.

## Latency

Of course, because we're using a full browser stack to construct and execute a request there is considerably more latency than a low-level client would normally require. As a result, your requests will take slightly longer as `thermoptic` executes the request.

## Dependence on Chrome, the Chrome Debugging Protocol, and browser quirkyness

`thermoptic` tries to cleanly construct requests in the way that Chrome itself would execute them. However, there are situations where it isn't always that simple due to Chrome Debugging Protocol (CDP) limitations.

For example, say you want to make a request using the CDP that directly mimics a user entering a website into their browser URL bar and visiting it. Sounds simple, but the CDP lacks the ability to do a direct `Page.navigate` while also catching the request details with `Fetch.requestPaused`. The CDP only supports intercepting requests *after* an initial tab has been loaded to a URL, which would be a cross-site navigation, not a direct navigation action. To counteract this limitation, [`thermoptic` does some very hacky dark-magic](https://github.com/search?q=repo%3Amandatoryprogrammer/thermoptic%20_manual_browser_visit&type=code). As with all hacky dark-magic though, there is a risk of breakage that will have to be addressed in future revisions of Chrome.

Quirks like this in the glue (CDP) and in Chrome can lead to potential problems from a fingerprinting point of view (and a maintenance one). Ideally use of hacks like this won't be necessary someday, but given `thermoptic` attempts to do an entirely new thing that not many other clients do, it's unlikely the Chrome maintainers will jump to address these shortcomings.

## Lack of page resource requests is itself a signal

* Requesting a page without any of its images, JavaScript, CSS, etc is itself a signal.