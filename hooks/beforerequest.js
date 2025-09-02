// This function is called before each request is
// handled by thermoptic.
// Keep logic here very lightweight!
export async function hook(cdp, request) {
    console.log(`[STATUS] Before-request hook called!`);
}