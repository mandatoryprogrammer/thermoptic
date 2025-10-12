#!/bin/bash
set -e

# Clean up Xvfb lock if needed
if [ -e /tmp/.X99-lock ]; then
  echo "Removing stale Xvfb lock..."
  rm -f /tmp/.X99-lock
fi

# Start Xvfb
echo "Starting Xvfb on :99..."
Xvfb :99 -screen 0 1024x768x16 &

# Forward the 3003 to 0.0.0.0 so we can hit it
# from the other containers.
socat TCP-LISTEN:3003,fork TCP:127.0.0.1:3002 &

# Launch chrome with the debugging port
while true; do
  set +e
  /usr/bin/google-chrome-stable \
    --remote-debugging-port=3002 \
    --remote-debugging-address=0.0.0.0 \
    --no-sandbox \
    --user-data-dir=/tmp/chrome-profile \
    "about:blank"
  chrome_status=$?
  set -e

  if [ "${chrome_status}" -eq 0 ]; then
    echo "[STATUS] Chrome exited cleanly. Restarting in 1 second..."
  else
    echo "[WARN] Chrome exited with code ${chrome_status}. Restarting in 2 seconds..."
  fi

  sleep 1
done
