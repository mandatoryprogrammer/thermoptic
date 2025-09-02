import * as cdp from './cdp.js';

export async function browser_manual_url_visit(url, protocol, method, path, headers, body) {
    const response = await cdp.manual_browser_visit(url);
    return response;
}

export async function form_submission(url, protocol, method, path, headers, body) {
    const response = await cdp.form_submission(url, protocol, method, path, headers, body);
    return response;
}

export async function fetch_request(url, protocol, method, path, headers, body) {
    const response = await cdp.fetch_request(url, protocol, method, path, headers, body);
    return response;
}

export async function resource_request(url, protocol, method, path, headers, body) {
    const response = await cdp.resource_request(url, protocol, method, path, headers, body);
    return response;
}