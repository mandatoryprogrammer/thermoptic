import * as fetchgen from './fetchgen.js';
import * as config from './config.js';
import * as routes from './routes.js';
import * as cdp from './cdp.js';

import * as cookie from 'cookie';

// Message if we couldn't figure out how to handle the request
const UNKNOWN_REQUEST_MSG = `You have found a request type that thermoptic doesn't know how to handle! If the browser would be able to make this request please submit a bug report at https://github.com/mandatoryprogrammer/thermoptic/issues`;

// // Sec-Fetch-Dest
// requester_resource: "document",
// // Sec-Fetch-Site
// requester_method: "navigate",
// // Sec-Fetch-Mode
// requester_site_type: "none",
// // Sec-Fetch-User
// is_user_navigation: false, 
const MATCH_RULES = [{
        "name": "Manual Browser URL Visit",
        "route": routes.browser_manual_url_visit,
        "requirements": {
            "method": "GET",
            "cors_simple": true,
            "requester_resource": "document",
            "requester_method": "none",
            "requester_site_type": "navigate",
            "is_user_navigation": true
        },
    },
    {
        "name": "Form Submission",
        "route": routes.form_submission,
        "requirements": {
            "cors_simple": true,
            "requester_resource": "document"
        },
    }, {
        "name": "fetch() Request",
        "route": routes.fetch_request,
        "requirements": {
            // "cors_simple": false,
            "requester_resource": "empty"
        },
    }, {
        "name": "Page Resource Request (<style>, <script>)",
        "route": routes.resource_request,
        "requirements": {
            "method": "GET",
            "cors_simple": true,
            "requester_resource": [
                "audio", // Audio resource (e.g., <audio> element)
                "audioworklet", // AudioWorklet script used in AudioWorkletNode
                "embed", // Embedded content such as legacy plugins (<embed>)
                "fencedframe", // <fencedframe> element (privacy-preserving iframe)
                "font", // Font resource (e.g., @font-face)
                "frame", // <frame> element (deprecated HTML feature)
                "iframe", // <iframe> element
                "image", // Image resource (e.g., <img>)
                "manifest", // Web Application Manifest
                "object", // <object> element (legacy embed mechanism)
                "paintworklet", // Paint Worklet script for CSS Paint API
                "report", // Report submission endpoint (e.g., Reporting API)
                "script", // JavaScript file (e.g., <script src>)
                "serviceworker", // Service Worker main script
                "sharedworker", // Shared Worker script
                "style", // CSS Stylesheet
                "track", // <track> element (e.g., captions, subtitles)
                "video", // Video resource (e.g., <video> element)
                "webidentity", // Federated credential exchange (Web Identity)
                "worker", // Web Worker script
                "xslt" // XSLT stylesheet transformation
            ]

        },
    }
];

/*
    This core routing logic just analyzes the proxied request and figures out
    which method we're going to user to emulate the request properly.

    e.g. Is it CORS simple? Does it have `Sec-Fetch-User: ?1`?, etc
*/
export async function process_request(url, protocol, method, path, headers, body) {
    // Check if the client is sending cookies, if so we'll set them on the browser
    // We set them narrowly for the specific URL defined in the request.
    const cookie_header = fetchgen.get_header_value_ignore_case('Cookie', headers);
    if (cookie_header) {
        const parsed_cookies = cookie.parse(cookie_header);
        const cookies_array = Object.entries(parsed_cookies).map(([name, value]) => ({
            name,
            value,
            url, // assumes 'url' is in scope
        }));

        await cdp.set_browser_cookies(cookies_array);
    }

    // Pull struct of the request's finer details for routing
    const request_details = get_request_details(url, protocol, method, path, headers, body);

    console.log(`[STATUS][${protocol}][${method}][${path}][Simple?:${request_details.cors_simple}][RR:${request_details.requester_resource}] Got inbound request to clean...`);

    const matching_rules = MATCH_RULES.filter(rule => {
        let is_match = true;
        Object.keys(rule.requirements).map(rule_key => {
            if (Array.isArray(rule.requirements[rule_key]) && rule.requirements[rule_key].includes(request_details[rule_key])) {
                return
            }

            if (rule.requirements[rule_key] === request_details[rule_key]) {
                return
            }
            // console.log(`[DEBUG] Rule "${rule.name}" don't match because of key ${rule_key}:`);
            // console.log(`Rule value: ${rule.requirements[rule_key]} !== ${request_details[rule_key]}`);
            is_match = false;
        });
        return is_match;
    });

    // We have a matching route, send it off to be handled in Chrome.
    if (matching_rules.length > 0) {
        const matching_rule = matching_rules[0];
        console.log(`[DEBUG] Request matched rule "${matching_rule.name}"!`)
        return matching_rule.route(url, protocol, method, path, headers, body);
    }

    console.log(`[WARN] No request router found, request details are:`);
    console.log(request_details);

    console.log(`[WARN] Headers from unrouted request:`);
    console.log(headers);

    return {
        statusCode: 500,
        header: {
            "Content-Type": "text/plain"
        },
        body: (new Buffer(UNKNOWN_REQUEST_MSG))
    }
}

/**
 * Analyze an HTTP request and return detailed metadata about its origin and type.
 *
 * @param {string} protocol - The protocol used for the request (e.g., "http" or "https").
 * @param {string} method - The HTTP method of the request (e.g., "GET", "POST").
 * @param {string} path - The request path (e.g., "/api/data").
 * @param {Array<{key: string, value: string}>} headers - An array of request headers as key-value pairs.
 * @param {string|Buffer|null} body - The body of the request, if present.
 * @returns {{
 *   cors_simple: boolean,
 *   requester_resource: string,
 *   requester_method: string,
 *   requester_site_type: string,
 *   is_user_navigation: boolean
 * }} Metadata describing the nature of the request.
 *
 * Example return value:
 * {
 *   cors_simple: false,
 *   requester_resource: "document",
 *   requester_method: "navigate",
 *   requester_site_type: "none",
 *   is_user_navigation: true
 * }
 */
function get_request_details(url, protocol, method, path, headers, body) {
    let request_details = {
        method: method,
        cors_simple: true,
        // Sec-Fetch-Dest
        requester_resource: "document",
        // Sec-Fetch-Site
        requester_method: "navigate",
        // Sec-Fetch-Mode
        requester_site_type: "none",
        // Sec-Fetch-User
        is_user_navigation: false,
    };

    // Strip headers that should always be rewritten for stealth purposes
    const filtered_headers = headers.filter(header => {
        return !config.ALWAYS_CLEAN_HEADERS.includes(header.key.toLowerCase());
    });

    // Determine if the request qualifies as a CORS simple request
    request_details.cors_simple = fetchgen.is_simple_cors_request(
        method,
        filtered_headers
    );

    // Set the values for requester_resource (Sec-Fetch-Dest)
    const sec_fetch_dest = fetchgen.get_header_value_ignore_case('Sec-Fetch-Dest', headers);
    if (sec_fetch_dest) {
        request_details.requester_resource = sec_fetch_dest;
    }

    // Set the values for requester_method (Sec-Fetch-Site)
    const sec_fetch_site = fetchgen.get_header_value_ignore_case('Sec-Fetch-Site', headers);
    if (sec_fetch_site) {
        request_details.requester_method = sec_fetch_site;
    }

    // Set the values for requester_site_type (Sec-Fetch-Mode)
    const sec_fetch_mode = fetchgen.get_header_value_ignore_case('Sec-Fetch-Mode', headers);
    if (sec_fetch_mode) {
        request_details.requester_site_type = sec_fetch_mode;
    }

    // Set is_user_navigation if Sec-Fetch-User is present
    const sec_fetch_user = fetchgen.get_header_value_ignore_case('Sec-Fetch-User', headers);
    if (sec_fetch_user) {
        request_details.is_user_navigation = true;
    }

    // Magic assumption logic below, this is attempting to "guess" the intention of
    // a request and make the safest choice possible. These should ONLY be used
    // if the requester has failed to supply the appropraite Sec-Fetch-* headers.

    // If this is not a CORS simple request then we should default the Sec-Fetch-Dest
    // to be 'empty' for a fetch() request.
    // Basically if they make a complex request that HAS to be CORS fetch() then we
    // set the request up like that (instead of it being treated weirdly).
    const is_likely_cors = (!request_details.cors_simple && // Is it a non-simple CORS request?
        !sec_fetch_user && // Is is NOT a manual request?
        !sec_fetch_dest // Is undeclared Sec-Fetch-Dest?
    )
    if (is_likely_cors) {
        request_details.requester_resource = 'empty';
    }

    // We're assume it's a direct visit if:
    // * It's a CORS simple request
    // * It's a GET request
    // * There is no Referer
    // * None of the Sec-Fetch-* headers are set
    // If so, we'll set the request details to match up with
    // the necessary rules to do a manual visit.
    const referer = fetchgen.get_header_value_ignore_case('Referer', headers);
    const is_likely_direct_visit = (
        request_details.cors_simple &&
        !referer && // No Referer header set
        method.toLocaleLowerCase() === 'get' && // Request was GET
        !sec_fetch_mode && // No Sec-Fetch-Mode set
        !sec_fetch_dest && // No Sec-Fetch-Dest set
        !sec_fetch_site // No Sec-Fetch-Site set
    );
    if (is_likely_direct_visit) {
        request_details.is_user_navigation = true;
        request_details.requester_site_type = 'navigate';
        request_details.requester_resource = 'document';
        request_details.requester_method = 'none';
    }

    return request_details;
}