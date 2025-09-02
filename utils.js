import { stat } from 'fs/promises';
import { resolve } from 'path';

export async function run_hook_file(hook_file_path, cdp, request, response) {
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
        const hook_module = await
        import (abs_hook_file_path);

        if (typeof hook_module.hook !== 'function') {
            console.error(`[ERROR] "hook" export not found or not a function in ${abs_hook_file_path}`);
            process.exit(1);
        }

        await hook_module.hook(cdp, request, response);
    } else {
        console.error(`[ERROR] Hook file does not exist or is not a file: ${abs_hook_file_path}`);
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

export function fetch_headers_to_proxy_response_headers(fetch_headers) {
    let formatted_headers = {};
    fetch_headers.map(header_pair => {
        formatted_headers[header_pair.name] = header_pair.value;
    });
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