import * as logger from '../logger.js';

// This function is called before each request is
// handled by thermoptic.
// Keep logic here very lightweight!
export async function hook(cdp, request) {
    const hook_logger = request && request.request_id ? logger.get_request_logger({ request_id: request.request_id }) : logger.get_logger();
    hook_logger.debug('Before-request hook called.');
}
