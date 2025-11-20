#!/bin/bash
set -e

# Ensure CA certs exist before runtime and sync them to the mounted location
mkdir -p /work/cassl/
node /work/scripts/ensure-ca.js
if compgen -G "/work/ssl/*" > /dev/null; then
    cp /work/ssl/* /work/cassl/
fi

# Wait for Chrome DevTools Protocol to be ready
node /work/wait-for-cdp.js

# Start the proxy server
node /work/server.js
