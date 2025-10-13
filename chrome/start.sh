#!/bin/bash
set -e

CHROME_CONTROL_PORT=${CHROME_CONTROL_PORT:-9223}
CHROME_CONTROL_PID_FILE=${CHROME_CONTROL_PID_FILE:-/tmp/chrome-main.pid}
CHROME_CONTROL_COOLDOWN_MS=${CHROME_CONTROL_COOLDOWN_MS:-5000}

export CHROME_CONTROL_PORT
export CHROME_CONTROL_PID_FILE
export CHROME_CONTROL_COOLDOWN_MS

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

# Launch chrome restart control server
echo "[STATUS] Starting Chrome restart control server on port ${CHROME_CONTROL_PORT}..."
python3 /app/restart_server.py &
chrome_control_pid=$!

cleanup() {
  if [ -n "${chrome_control_pid}" ]; then
    kill "${chrome_control_pid}" 2>/dev/null || true
    wait "${chrome_control_pid}" 2>/dev/null || true
  fi
  rm -f "${CHROME_CONTROL_PID_FILE}"
}

trap cleanup EXIT INT TERM

# Launch chrome with the debugging port
while true; do
  set +e
  /usr/bin/google-chrome-stable \
    --remote-debugging-port=3002 \
    --remote-debugging-address=0.0.0.0 \
    --no-sandbox \
    --user-data-dir=/tmp/chrome-profile \
    "about:blank" &
  chrome_pid=$!
  echo "${chrome_pid}" > "${CHROME_CONTROL_PID_FILE}"
  wait "${chrome_pid}"
  chrome_status=$?
  rm -f "${CHROME_CONTROL_PID_FILE}"
  set -e

  if [ "${chrome_status}" -eq 0 ]; then
    echo "[STATUS] Chrome exited cleanly. Restarting in 2 seconds..."
  else
    echo "[WARN] Chrome exited with code ${chrome_status}. Restarting in 2 seconds..."
  fi

  sleep 2
done
