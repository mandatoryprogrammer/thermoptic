import * as logger from '../logger.js';

// This function is called before each request is
// handled by thermoptic.
// Keep logic here very lightweight!
export async function hook(cdp, request, response, hook_logger = null) {
    const active_logger = hook_logger || (request && request.request_id ? logger.get_request_logger({ request_id: request.request_id }) : logger.get_logger());
    active_logger.info('Before-request hook running.');
}
