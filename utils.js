import { stat } from 'fs/promises';
import { resolve } from 'path';
import * as logger from './logger.js';

export async function run_hook_file(hook_file_path, cdp, request, response, provided_logger) {
    const utils_logger = provided_logger || logger.get_logger();
    async function file_exists(path) {
        try {
            const stats = await stat(path);
            return stats.isFile();
        } catch {
            return false;
        }
    }

    const abs_hook_file_path = resolve(hook_file_path);

    if (await file_exists(abs_hook_file_path)) {
        const hook_module = await import(abs_hook_file_path);

        if (typeof hook_module.hook !== 'function') {
            utils_logger.error('"hook" export not found or not a function for hook file.', {
                hook_file: abs_hook_file_path
            });
            process.exit(1);
        }

        await hook_module.hook(cdp, request, response, utils_logger);
    } else {
        utils_logger.error('Hook file does not exist or is not a file.', {
            hook_file: abs_hook_file_path
        });
        process.exit(1);
    }
}

export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function convert_headers_array(flat_headers) {
    const result = [];

    for (let i = 0; i < flat_headers.length; i += 2) {
        result.push({
            key: flat_headers[i],
            value: flat_headers[i + 1],
        });
    }

    return result;
}

export function response_has_no_body(method, status_code) {
    return method.toUpperCase() === 'HEAD' || status_code < 200 ||
        status_code === 204 || status_code === 205 || status_code === 304;
}

export function fetch_headers_to_proxy_response_headers(fetch_headers, body, method, status_code) {
    // Chrome has already decoded the body. Rebuild framing for the downstream
    // connection instead of forwarding the upstream compression/transfer framing.
    const excluded_names = new Set([
        'content-encoding', 'content-length', 'transfer-encoding', 'trailer',
        'connection', 'keep-alive', 'proxy-connection', 'te', 'upgrade'
    ]);
    for (const header of fetch_headers) {
        if (header && typeof header.name === 'string' && header.name.toLowerCase() === 'connection') {
            for (const name of header.value.split(',')) {
                excluded_names.add(name.trim().toLowerCase());
            }
        }
    }

    const formatted_headers = Object.create(null);
    for (const header of fetch_headers) {
        if (!header || typeof header.name !== 'string') {
            continue;
        }
        const name = header.name.toLowerCase();
        if (name.startsWith(':') || excluded_names.has(name)) {
            continue;
        }
        const previous = formatted_headers[name];
        if (typeof previous === 'undefined') {
            formatted_headers[name] = header.value;
        } else if (Array.isArray(previous)) {
            previous.push(header.value);
        } else {
            // In particular, Set-Cookie must remain separate header fields.
            formatted_headers[name] = [previous, header.value];
        }
    }

    // HEAD/304 lengths describe a selected representation, not this empty body.
    // Its decoded size is unknown; omit the optional length. 1xx/204 forbid it.
    if (!response_has_no_body(method, status_code) || status_code === 205) {
        formatted_headers['content-length'] = String(body.length);
    }
    return formatted_headers;
}

import { timingSafeEqual } from "crypto";

export const time_safe_compare = (a, b) => {
    try {
        return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
    } catch {
        return false;
    }
};
