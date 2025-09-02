import { escape, parse as parseQuery } from 'querystring';

// Not ideal, should probably fix at some point
function escape_html(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const PAGE_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="icon" href="data:;base64,iVBORw0KGgo=">
{{HEAD_REPLACE_ME}}
</head>
<body>
{{BODY_REPLACE_ME}}
</body>
</html>
`

export function get_blank_response() {
    return PAGE_TEMPLATE.replace('{{BODY_REPLACE_ME}}', '').replace('{{HEAD_REPLACE_ME}}', '');
}

export function convert_headers_map_to_array(headers_map) {
    return Object.entries(headers_map).map(([key, value]) => ({
        key: key,
        value: value
    }));
}

export function get_header_value_ignore_case(key, headers) {
    const lower_key = key.toLowerCase();
    for (const header of headers) {
        if (header.key.toLowerCase() === lower_key) {
            return header.value;
        }
    }
    return undefined;
}

/*
  We do this in a slightly odd way because we don't want to accidentally reorder query
  parameters while we append our tracking ID to the parameter list.

  (If we reorder them that gives a fingerprintable change they can use against us).
*/
export function append_query_parameter(url, key, value) {
    const [base, query = '', hash = ''] = url.split(/[\?#]/g).concat('');
    const hasQuery = url.includes('?');
    const hasHash = url.includes('#');
    const queryPart = hasQuery ? query : '';
    const hashPart = hasHash ? url.slice(url.indexOf('#')) : '';
    const newParam = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;

    let newUrl;
    if (queryPart) {
        newUrl = `${base}?${queryPart}&${newParam}`;
    } else {
        newUrl = `${base}?${newParam}`;
    }

    return newUrl + hashPart;
}

// This is odd for the same reason as the above
export function remove_query_param(url_str, param_to_remove) {
    const query_start = url_str.indexOf('?');
    const fragment_start = url_str.indexOf('#');

    let original_query = '';
    if (query_start !== -1) {
        if (fragment_start !== -1) {
            original_query = url_str.substring(query_start + 1, fragment_start);
        } else {
            original_query = url_str.substring(query_start + 1);
        }
    }

    if (!original_query) return url_str;

    const filtered_params = original_query
        .split('&')
        .filter(pair => {
            const [key] = pair.split('=');
            return decodeURIComponent(key) !== param_to_remove;
        });

    const base_url = url_str.slice(0, query_start !== -1 ? query_start : url_str.length);
    const fragment = fragment_start !== -1 ? url_str.slice(fragment_start) : '';

    return filtered_params.length ?
        `${base_url}?${filtered_params.join('&')}${fragment}` :
        `${base_url}${fragment}`;
}

export function has_query_param_with_value(url_string, param, expected_value) {
    try {
        const url = new URL(url_string);
        return url.searchParams.get(param) === expected_value;
    } catch (err) {
        console.error('Invalid URL:', err.message);
        return false;
    }
}

/**
 * Generates an HTML page that triggers a request with a specific Sec-Fetch-Dest.
 * @param {string} fetch_dest - One of the valid Sec-Fetch-Dest values.
 * @param {string} resource_url - The resource URL to request.
 * @returns {string} HTML string.
 */
export function generate_resource_request_code(fetch_dest, resource_url) {
    const encoded_url = escape_html(resource_url);

    let fetch_script = '';

    switch (fetch_dest) {
        case 'audio':
            fetch_script = `<audio src="${encoded_url}" autoplay></audio>`;
            break;
        case 'audioworklet':
            fetch_script = `<script>
  (async () => {
    const audio_context = new (window.AudioContext || window.webkitAudioContext)();
    await audio_context.audioWorklet.addModule("${encoded_url}");
  })();
  </script>`;
            break;
        case 'embed':
            // type="application/octet-stream" is meant to prevent execution
            fetch_script = `<embed src="${encoded_url}" type="application/octet-stream">`;
            break;
        case 'fencedframe':
            fetch_script = `
  <!-- fencedframe is restricted; fallback using iframe -->
  <iframe src="${encoded_url}" sandbox></iframe>`;
            break;
        case 'font':
            fetch_script = `<style>
  @font-face {
    font-family: 'TestFont';
    src: url('${encoded_url}');
  }
  body { font-family: 'TestFont'; }
  </style>
  <p>Font test</p>`;
            break;
        case 'frame':
            // sandbox prevents execution
            fetch_script = `<frameset><frame src="${encoded_url}" sandbox></frameset>`;
            break;
        case 'iframe':
            // sandbox prevents execution
            fetch_script = `<iframe sandbox src="${encoded_url}"></iframe>`;
            break;
        case 'image':
            // No script execution possible
            fetch_script = `<img src="${encoded_url}" alt="image">`;
            break;
        case 'manifest':
            fetch_script = `<link rel="manifest" href="${encoded_url}">`;
            break;
        case 'object':
            // type="application/octet-stream" is meant to prevent execution
            fetch_script = `<object data="${encoded_url} type="application/octet-stream"></object>`;
            break;
        case 'paintworklet':
            fetch_script = `<script>
  if ('paintWorklet' in CSS) {
    CSS.paintWorklet.addModule('${encoded_url}');
  }
  </script>`;
            break;
        case 'report':
            throw `Unknown or unsupported Sec-Fetch-Dest: ${fetch_dest}</p>`;
        case 'script':
            // Execution prvented via the use of link as="script"
            // Ensures the sec-fetch-dest is still script though
            fetch_script = `<link rel="preload" href="${encoded_url}" as="script">`;
            break;
        case 'serviceworker':
            fetch_script = `<script>
  navigator.serviceWorker.register("${encoded_url}").then(() => {
    console.log("Service Worker registered");
  });
  </script>`;
            break;
        case 'sharedworker':
            fetch_script = `<script>new SharedWorker("${encoded_url}");</script>`;
            break;
        case 'style':
            // We use rel="preload" to prevent actually rendering the script
            fetch_script = `<link rel="stylesheet" href="${encoded_url}" rel="preload">`;
            break;
        case 'track':
            fetch_script = `<video controls>
    <source src="video.mp4" type="video/mp4">
    <track src="${encoded_url}" kind="subtitles" srclang="en" label="English">
  </video>`;
            break;
        case 'video':
            fetch_script = `<video src="${encoded_url}" autoplay></video>`;
            break;
        case 'webidentity':
            throw `Unknown or unsupported Sec-Fetch-Dest: ${fetch_dest}</p>`;
        case 'worker':
            fetch_script = `<script>new Worker("${encoded_url}");</script>`;
            break;
        case 'xslt':
            fetch_script = `<?xml version="1.0"?>
  <?xml-stylesheet type="text/xsl" href="${encoded_url}"?>
  <root><item>Test</item></root>`;
            break;
        default:
            throw `Unknown or unsupported Sec-Fetch-Dest: ${fetch_dest}</p>`;
    }

    return PAGE_TEMPLATE.replace('{{BODY_REPLACE_ME}}', fetch_script).replace('{{HEAD_REPLACE_ME}}', '');
    // .replace('{{HEAD_REPLACE_ME}}', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`)
}

export function generate_fetch_code(url, method = 'GET', headers = [], body, prettify = true) {
    const options = { method };

    const headerEntries = headers.map(h => [h.key, h.value]);
    if (headerEntries.length) {
        options.headers = Object.fromEntries(headerEntries);
    }

    const contentTypeEntry = headerEntries.find(([key]) => key.toLowerCase() === 'content-type');
    const contentType = contentTypeEntry && contentTypeEntry[1] ? contentTypeEntry[1].toLowerCase() : undefined;

    let bodySnippet = '';
    let bodyVarRef = null;

    const hasBody = body && Buffer.isBuffer(body) && body.length > 0;

    if (hasBody) {
        if (contentType === 'application/json') {
            const jsonString = body.toString('utf8');
            bodySnippet = `const body = JSON.stringify(${jsonString});`;
            bodyVarRef = 'body';

        } else if (
            contentType === 'application/x-www-form-urlencoded' ||
            contentType === 'text/plain'
        ) {
            const stringBody = body.toString('utf8');
            bodySnippet = `const body = ${JSON.stringify(stringBody)};`;
            bodyVarRef = 'body';

        } else if (contentType && contentType.startsWith('multipart/form-data')) {
            const lowerKeys = Object.keys(options.headers).map(k => k.toLowerCase());
            const idx = lowerKeys.indexOf('content-type');
            if (idx !== -1) {
                const originalKey = Object.keys(options.headers)[idx];
                delete options.headers[originalKey];
            }

            const base64Body = body.toString('base64');
            bodySnippet = `
const binaryString = atob(${JSON.stringify(base64Body)});
const len = binaryString.length;
const bytes = new Uint8Array(len);
for (let i = 0; i < len; i++) {
  bytes[i] = binaryString.charCodeAt(i);
}
const body = bytes.buffer;`;
            bodyVarRef = 'body';

        } else {
            const base64Body = body.toString('base64');
            bodySnippet = `
const binaryString = atob(${JSON.stringify(base64Body)});
const len = binaryString.length;
const bytes = new Uint8Array(len);
for (let i = 0; i < len; i++) {
  bytes[i] = binaryString.charCodeAt(i);
}
const body = bytes.buffer;`;
            bodyVarRef = 'body';
        }

        if (bodyVarRef) {
            options.body = 'BODY_PLACEHOLDER';
        }
    }

    let optsString = prettify ?
        JSON.stringify(options, null, 2) :
        JSON.stringify(options);

    if (optsString.includes('"BODY_PLACEHOLDER"')) {
        optsString = optsString.replace(`"BODY_PLACEHOLDER"`, bodyVarRef);
    }

    const fetch_script = `
<script>
${bodySnippet.trim()}
fetch(${JSON.stringify(url)}, ${optsString})
  .then(res => console.log(res));
</script>`;

    return PAGE_TEMPLATE.replace('{{BODY_REPLACE_ME}}', fetch_script).replace('{{HEAD_REPLACE_ME}}', '');
}

export function parse_multipart_form_data(raw_body, content_type) {
    const result = [];

    const boundary_match = content_type.match(/boundary=(.+)$/);
    if (!boundary_match) throw new Error('no boundary in content-type header');

    const boundary = Buffer.from('--' + boundary_match[1]);
    const delimiter = Buffer.from('\r\n\r\n');
    const end_boundary = Buffer.from('--' + boundary_match[1] + '--');

    let start_index = raw_body.indexOf(boundary) + boundary.length + 2; // skip initial boundary + CRLF

    while (start_index < raw_body.length) {
        const next_boundary_index = raw_body.indexOf(boundary, start_index);
        const part_end_index = next_boundary_index === -1 ?
            raw_body.indexOf(end_boundary, start_index) :
            next_boundary_index;

        if (part_end_index === -1) break;

        const part = raw_body.slice(start_index, part_end_index - 2); // trim trailing \r\n
        const header_end_index = part.indexOf(delimiter);
        if (header_end_index === -1) throw new Error('malformed part: missing header-body delimiter');

        const header_raw = part.slice(0, header_end_index).toString('latin1');
        const body = part.slice(header_end_index + delimiter.length);

        const name_match = /name="([^"]+)"/i.exec(header_raw);
        if (!name_match) throw new Error('missing name in part headers');

        const filename_match = /filename="([^"]*)"/i.exec(header_raw);
        const is_file = filename_match !== null;

        let content_type_match = header_raw.match(/Content-Type:\s*([^\r\n]+)/i);
        if (is_file && !content_type_match) {
            // Default fallback if Content-Type is omitted
            content_type_match = ['', 'application/octet-stream'];
        }

        result.push({
            key: name_match[1],
            value: is_file ? body : body.toString('utf8'),
            type: is_file ? 'file' : 'field',
            ...(is_file && {
                filename: filename_match[1],
                content_type: content_type_match[1].trim()
            })
        });

        start_index = part_end_index + boundary.length + 2; // skip boundary and \r\n
    }

    return result;
}

// Takes return data from parse_multipart_form_data and
// builds an appropriate HTML form
export function build_file_form_from_fields(url, fields) {
    const form_elements = fields.map(({ key, value, type }) => {
        const name_attr = `name="${escape_html(key)}"`;

        if (type === 'file') {
            return `<input type="file" ${name_attr}>`;
        } else if (type === 'field') {
            const value_attr = `value="${escape_html(value)}"`;
            return `<input type="text" ${name_attr} ${value_attr}>`;
        } else {
            throw new Error(`Unsupported field type: ${type}`);
        }
    });

    return PAGE_TEMPLATE.replace('{{BODY_REPLACE_ME}}', `<form method="POST" action="${escape_html(url)}" enctype="multipart/form-data">\n  ${form_elements.join('\n  ')}\n<button id="clickme" type="submit">Click me!</button></form>`).replace('{{HEAD_REPLACE_ME}}', '');
}

export function generate_form_code(url, method, content_type, body, autosubmit) {
    const allowedContentTypes = [
        'application/x-www-form-urlencoded',
        'multipart/form-data',
        'text/plain',
    ];

    let normalizedContentType = undefined;
    if (content_type !== undefined) {
        normalizedContentType = content_type.split(';')[0].trim().toLowerCase();

        if (!allowedContentTypes.includes(normalizedContentType)) {
            throw new Error(`Unsupported content-type for form: ${content_type}`);
        }
    }

    const formMethod = (method && ['GET', 'POST'].includes(method.toUpperCase())) ? method.toUpperCase() : 'POST';

    let fields = [];

    // Parse original URL query params
    const parsedUrl = new URL(url);
    const urlQueryParams = Object.fromEntries(parsedUrl.searchParams.entries());

    // We'll remove query params from URL for form action (for GET)
    parsedUrl.search = '';

    if (normalizedContentType === 'application/x-www-form-urlencoded') {
        const bodyStr = body.toString('utf8');
        const parsed = parseQuery(bodyStr);
        fields = Object.entries(parsed);

    } else if (normalizedContentType === 'text/plain') {
        const bodyStr = body.toString('utf8');
        fields = bodyStr
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                const eqIndex = line.indexOf('=');
                if (eqIndex < 0) return [line, ''];
                const key = line.slice(0, eqIndex);
                const val = line.slice(eqIndex + 1);
                return [key, val];
            });

    } else if (normalizedContentType === 'multipart/form-data') {
        // Special case
        console.log(`[DEBUG] Multipart form received!`);
        const result = parse_multipart_form_data(body, content_type)
        console.log(result);
        process.exit();
    }

    // Merge URL query params with body fields
    if (formMethod === 'GET') {
        // Turn both into an object so we can merge:
        const merged = {...urlQueryParams };
        for (const [k, v] of fields) {
            merged[k] = v;
        }
        fields = Object.entries(merged);
    } else {
        // For POST, keep the URL as is (with query params)
        parsedUrl.search = new URL(url).search;
    }

    const inputsHtml = fields.map(([key, val]) => {
        return `<input type="hidden" name="${escape_html(key)}" value="${escape_html(val)}">`;
    }).join('\n    ');

    const enctypeAttr = normalizedContentType ? ` enctype="${normalizedContentType}"` : '';

    let autosubmit_code = ``;

    if (autosubmit) {
        autosubmit_code = `
        <script>
        // MUST be requestSubmit to trigger our hack to trim ? on empty params
        document.querySelector('form').requestSubmit();
        </script>
        `;
    }

    return PAGE_TEMPLATE.replace('{{BODY_REPLACE_ME}}', `<form action="${escape_html(parsedUrl.toString())}" method="${formMethod}"${enctypeAttr} onsubmit="submitForm(event)">
    ${inputsHtml}
    <button id="clickme" type="submit">Click me!</button>
  </form>
<script>
// Hack to remove a ? from the URL if it's a blank submission
// e.g. https://example.com would otherwise be https://example.com/? due to
// <form> behavior.
// TODO: We SHOULD support both cases so we aren't caught lackin'
function submitForm(event) {
  const form = document.querySelector('form');
  const formData = new FormData(form);
  const hasParams = [...formData.keys()].length > 0;

  if (!hasParams) {
    event.preventDefault();
    window.location.href = form.action;
  }
}
</script>${autosubmit_code}`).replace('{{HEAD_REPLACE_ME}}', '');
}

/*
  Chrome sets completely different headers if requests are made via fetch() or
  via regular page navigation. The **order** of the headers is also different.

  Example fetch():

  GET / HTTP/1.1
  Host: 127.0.0.1:7777
  Connection: keep-alive
  Accept: *\/*
  User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36
  sec-ch-ua: "Not:A-Brand";v="24", "Chromium";v="134"
  sec-ch-ua-mobile: ?0
  sec-ch-ua-platform: "Linux"
  Sec-Fetch-Site: same-origin
  Sec-Fetch-Mode: cors
  Sec-Fetch-Dest: empty
  Accept-Encoding: gzip, deflate, br, zstd
  Accept-Language: en-US,en;q=0.9

  Example regular page nav:

  GET / HTTP/1.1
  Host: 127.0.0.1:7777
  Connection: keep-alive
  sec-ch-ua: "Not:A-Brand";v="24", "Chromium";v="134"
  sec-ch-ua-mobile: ?0
  sec-ch-ua-platform: "Linux"
  Upgrade-Insecure-Requests: 1
  User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36
  Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*\/*;q=0.8,application/signed-exchange;v=b3;q=0.7
  Sec-Fetch-Site: none
  Sec-Fetch-Mode: navigate
  Sec-Fetch-User: ?1
  Sec-Fetch-Dest: document
  Accept-Encoding: gzip, deflate, br, zstd
  Accept-Language: en-US,en;q=0.9

  Notable the "Accept" and "Sec-Fetch-*" headers are different values and the order
  of the headers has now changed completely.

  So to make sure our HTTP fingerprint is as realistic as possible we have to scan all
  requests and check if they're "SIMPLE" from a CORS perspective. If they are then we
  utilize an HTTP <form> to make the request instead of fetch().
*/
export function is_simple_cors_request(method, headers) {
    const simpleMethods = ['GET', 'POST'];
    const simpleHeaders = [
        'accept',
        'accept-language',
        'content-language',
        'content-type',
        'dpr',
        'downlink',
        'save-data',
        'viewport-width',
        'width',
        'content-length'
    ];

    const simpleContentTypes = [
        'application/x-www-form-urlencoded',
        'text/plain'
    ];

    const reqMethod = method.toUpperCase();
    if (!simpleMethods.includes(reqMethod)) {
        return false;
    }

    for (const { key, value }
        of headers) {
        const lowerKey = key.toLowerCase();

        if (!simpleHeaders.includes(lowerKey)) {
            return false;
        }

        if (lowerKey === 'content-type') {
            const mimeType = value.split(';')[0].trim().toLowerCase();

            if (mimeType === 'multipart/form-data') {
                return true;
            }

            if (!simpleContentTypes.includes(mimeType)) {
                return false;
            }
        }
    }

    return true;
}