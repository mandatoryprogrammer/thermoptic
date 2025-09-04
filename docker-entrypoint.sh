#!/bin/bash
set -e

# Ensure CA certs are available in the mounted location
cp /work/ssl/* /work/cassl/

# Wait for Chrome DevTools Protocol to be ready
node /work/wait-for-cdp.js

# Start the proxy server
node /work/server.js
