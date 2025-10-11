import * as logger from '../logger.js';

// This function is called after each request is
// handled by thermoptic.
// Keep logic here very lightweight!
export async function hook(cdp, request, response) {
    const hook_logger = request && request.request_id ? logger.get_request_logger({ request_id: request.request_id }) : logger.get_logger();
    hook_logger.debug('After-request hook called.');
}
