#!/bin/bash
set -e

CHROME_CONTROL_PORT=${CHROME_CONTROL_PORT:-9223}
CHROME_CONTROL_PID_FILE=${CHROME_CONTROL_PID_FILE:-/tmp/chrome-main.pid}
CHROME_CONTROL_COOLDOWN_MS=${CHROME_CONTROL_COOLDOWN_MS:-5000}
ENABLE_GUI_CONTROL=${ENABLE_GUI_CONTROL:-false}
XPRA_BIND_HOST=${XPRA_BIND_HOST:-0.0.0.0}
XPRA_PORT=${XPRA_PORT:-14500}

export CHROME_CONTROL_PORT
export CHROME_CONTROL_PID_FILE
export CHROME_CONTROL_COOLDOWN_MS
export ENABLE_GUI_CONTROL
export XPRA_BIND_HOST
export XPRA_PORT
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/runtime-chromeuser}
CHROME_PROFILE_DIR=${CHROME_PROFILE_DIR:-/home/chromeuser/profile}
CHROME_SCREEN_WIDTH=${CHROME_SCREEN_WIDTH:-1920}
CHROME_SCREEN_HEIGHT=${CHROME_SCREEN_HEIGHT:-1080}
LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-1}
CHROME_COMMON_FLAGS=(
  --remote-debugging-port=3002
  --remote-debugging-address=0.0.0.0
  --no-sandbox
  --user-data-dir="${CHROME_PROFILE_DIR}"
  --no-first-run
  --disable-first-run-ui
  --no-default-browser-check
  --disable-search-engine-choice-screen
  --disable-default-apps
  --disable-browser-signin
  --disable-sync
  --disable-features=ChromeWhatsNewUI,PermissionPromptSurveyUi,PrivacySandboxSettings4
  --window-position=0,0
  "--window-size=${CHROME_SCREEN_WIDTH},${CHROME_SCREEN_HEIGHT}"
  --start-maximized
  --force-device-scale-factor=1
  --disable-gpu
  --disable-accelerated-2d-canvas
  --disable-accelerated-video-decode
  --disable-accelerated-mjpeg-decode
  --disable-3d-apis
  --disable-webrtc-hw-encoding
  --disable-webrtc-hw-decoding
  --disable-gpu-compositing
  --disable-gpu-rasterization
  --disable-dev-shm-usage
  --disable-background-networking
  --disable-renderer-backgrounding
  --noerrdialogs
  --use-gl=swiftshader
  --disable-breakpad
  --disable-crash-reporter
)
export XDG_RUNTIME_DIR
export CHROME_PROFILE_DIR
export CHROME_SCREEN_WIDTH
export CHROME_SCREEN_HEIGHT
export LIBGL_ALWAYS_SOFTWARE

mkdir -p "${XDG_RUNTIME_DIR}"
mkdir -p "${CHROME_PROFILE_DIR}"

# Clear stale singleton locks from previous runs so Chrome can start cleanly
rm -f "${CHROME_PROFILE_DIR}/SingletonLock" \
      "${CHROME_PROFILE_DIR}/SingletonSocket" \
      "${CHROME_PROFILE_DIR}/SingletonCookie"

# Clean up Xvfb lock if needed
if [ -e /tmp/.X99-lock ]; then
  echo "Removing stale Xvfb lock..."
  rm -f /tmp/.X99-lock
fi

# Start Xvfb
echo "Starting Xvfb on :99 with ${CHROME_SCREEN_WIDTH}x${CHROME_SCREEN_HEIGHT} viewport..."
Xvfb :99 -screen 0 "${CHROME_SCREEN_WIDTH}x${CHROME_SCREEN_HEIGHT}x16" &
xvfb_pid=$!

xpra_pid=""

start_xpra_shadow() {
  echo "[STATUS] Starting xpra shadow server on port ${XPRA_PORT}..."
  xpra shadow :99 \
    --daemon=no \
    --bind-tcp="${XPRA_BIND_HOST}:${XPRA_PORT}" \
    --html=on \
    --auth=none \
    --mdns=no \
    --ssh=no \
    --pulseaudio=no \
    --notifications=no \
    --printing=no \
    --bell=no \
    --dbus-proxy=no \
    --dbus-control=no &
  xpra_pid=$!
}

if [ "${ENABLE_GUI_CONTROL}" = "true" ]; then
  start_xpra_shadow
fi

# Forward the 3003 to 0.0.0.0 so we can hit it
# from the other containers.
socat TCP-LISTEN:3003,fork TCP:127.0.0.1:3002 &

# Launch chrome restart control server
echo "[STATUS] Starting Chrome restart control server on port ${CHROME_CONTROL_PORT}..."
python3 /app/restart_server.py &
chrome_control_pid=$!

cleanup() {
  if [ -n "${xpra_pid}" ]; then
    kill "${xpra_pid}" 2>/dev/null || true
    wait "${xpra_pid}" 2>/dev/null || true
  fi
  if [ -n "${xvfb_pid}" ]; then
    kill "${xvfb_pid}" 2>/dev/null || true
    wait "${xvfb_pid}" 2>/dev/null || true
  fi
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
    "${CHROME_COMMON_FLAGS[@]}" \
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
