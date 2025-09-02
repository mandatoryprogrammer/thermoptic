// This function is called after each request is
// handled by thermoptic.
// Keep logic here very lightweight!
export async function hook(cdp, request, response) {
    console.log(`[STATUS] After-request hook called!`);
}