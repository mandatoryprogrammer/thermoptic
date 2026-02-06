#!/bin/bash
set -e

CHROME_CONTROL_PORT=${CHROME_CONTROL_PORT:-9223}
CHROME_CONTROL_PID_FILE=${CHROME_CONTROL_PID_FILE:-/tmp/chrome-main.pid}
CHROME_CONTROL_COOLDOWN_MS=${CHROME_CONTROL_COOLDOWN_MS:-5000}
ENABLE_GUI_CONTROL=${ENABLE_GUI_CONTROL:-false}
XPRA_BIND_HOST=${XPRA_BIND_HOST:-0.0.0.0}
XPRA_PORT=${XPRA_PORT:-14111}
CHROME_PROXY_SERVER=${CHROME_PROXY_SERVER:-http://proxyrouter:3128}
CHROME_PROXY_BYPASS_LIST=${CHROME_PROXY_BYPASS_LIST:-"<-loopback>;thermoptic"}
CHROME_PROXY_ENABLE_DNS=${CHROME_PROXY_ENABLE_DNS:-true}
CHROME_PROXY_DNS_EXCLUSIONS=${CHROME_PROXY_DNS_EXCLUSIONS:-"localhost,thermoptic"}

export CHROME_CONTROL_PORT
export CHROME_CONTROL_PID_FILE
export CHROME_CONTROL_COOLDOWN_MS
export ENABLE_GUI_CONTROL
export XPRA_BIND_HOST
export XPRA_PORT
export CHROME_PROXY_SERVER
export CHROME_PROXY_BYPASS_LIST
export CHROME_PROXY_ENABLE_DNS
export CHROME_PROXY_DNS_EXCLUSIONS
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/runtime-chromeuser}
CHROME_PROFILE_DIR=${CHROME_PROFILE_DIR:-/home/chromeuser/profile}
CHROME_SCREEN_WIDTH=${CHROME_SCREEN_WIDTH:-1920}
CHROME_SCREEN_HEIGHT=${CHROME_SCREEN_HEIGHT:-1080}
LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-1}
CHROME_BOOTSTRAP_USER=${CHROME_BOOTSTRAP_USER:-chromeuser}
CHROME_BOOTSTRAP_UID=${CHROME_BOOTSTRAP_UID:-1001}
CHROME_BOOTSTRAP_GID=${CHROME_BOOTSTRAP_GID:-1001}

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "${XDG_RUNTIME_DIR}" "${CHROME_PROFILE_DIR}"
  if ! chown -R "${CHROME_BOOTSTRAP_UID}:${CHROME_BOOTSTRAP_GID}" "${XDG_RUNTIME_DIR}" "${CHROME_PROFILE_DIR}" 2>/dev/null; then
    echo "[WARN] Unable to set ownership on Chrome runtime/profile directories. Continuing."
  fi
  chmod 700 "${XDG_RUNTIME_DIR}" "${CHROME_PROFILE_DIR}" 2>/dev/null || true

  if command -v su >/dev/null 2>&1; then
    if ! su -s /bin/bash -c "test -w \"${CHROME_PROFILE_DIR}\"" "${CHROME_BOOTSTRAP_USER}" >/dev/null 2>&1; then
      fallback_profile_dir="/tmp/chrome-profile"
      echo "[WARN] Profile directory ${CHROME_PROFILE_DIR} is not writable by ${CHROME_BOOTSTRAP_USER}. Falling back to ${fallback_profile_dir}."
      CHROME_PROFILE_DIR="${fallback_profile_dir}"
      mkdir -p "${CHROME_PROFILE_DIR}"
      chown -R "${CHROME_BOOTSTRAP_UID}:${CHROME_BOOTSTRAP_GID}" "${CHROME_PROFILE_DIR}" 2>/dev/null || true
      chmod 700 "${CHROME_PROFILE_DIR}" 2>/dev/null || true
    fi
  else
    echo "[WARN] 'su' is unavailable. Skipping non-root write validation for the profile directory."
  fi

  export CHROME_PROFILE_DIR
  export XDG_RUNTIME_DIR
  bootstrap_home="/home/${CHROME_BOOTSTRAP_USER}"
  if command -v getent >/dev/null 2>&1; then
    resolved_home="$(getent passwd "${CHROME_BOOTSTRAP_USER}" | cut -d: -f6)"
    if [ -n "${resolved_home}" ]; then
      bootstrap_home="${resolved_home}"
    fi
  fi
  export HOME="${bootstrap_home}"
  export USER="${CHROME_BOOTSTRAP_USER}"
  export LOGNAME="${CHROME_BOOTSTRAP_USER}"
  if command -v su >/dev/null 2>&1; then
    exec su -m -s /bin/bash "${CHROME_BOOTSTRAP_USER}" -c "/app/start.sh"
  fi
  echo "[WARN] 'su' is unavailable. Continuing to run Chrome as root."
fi

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
  "--proxy-server=${CHROME_PROXY_SERVER}"
  "--proxy-bypass-list=${CHROME_PROXY_BYPASS_LIST}"
)

# Ensure Chrome can still resolve the proxy server when DNS proxying is enabled.
proxy_host=""
if [ -n "${CHROME_PROXY_SERVER}" ]; then
    proxy_host="$(python3 - "$CHROME_PROXY_SERVER" <<'PY'
import sys
from urllib.parse import urlsplit

uri = sys.argv[1].strip()
if not uri:
    print("")
    sys.exit(0)
if "://" not in uri:
    uri = f"http://{uri}"
parts = urlsplit(uri)
print(parts.hostname or "")
PY
)"
    proxy_host="$(printf '%s' "${proxy_host}" | xargs)"
fi

if [ -n "${proxy_host}" ]; then
    append_proxy_host=true
    if [ -n "${CHROME_PROXY_DNS_EXCLUSIONS}" ]; then
        IFS=',' read -ra current_exclusions <<< "${CHROME_PROXY_DNS_EXCLUSIONS}"
        for existing in "${current_exclusions[@]}"; do
            trimmed_existing="$(printf '%s' "${existing}" | xargs)"
            if [ "${trimmed_existing}" = "${proxy_host}" ]; then
                append_proxy_host=false
                break
            fi
        done
    fi

    if [ "${append_proxy_host}" = "true" ]; then
        if [ -z "${CHROME_PROXY_DNS_EXCLUSIONS}" ]; then
            CHROME_PROXY_DNS_EXCLUSIONS="${proxy_host}"
        else
            CHROME_PROXY_DNS_EXCLUSIONS="${CHROME_PROXY_DNS_EXCLUSIONS},${proxy_host}"
        fi
    fi
fi

if [ "${CHROME_PROXY_ENABLE_DNS}" = "true" ]; then
    resolver_rule="MAP * ~NOTFOUND"
    IFS=',' read -ra dns_exclusions <<< "${CHROME_PROXY_DNS_EXCLUSIONS}"
    for exclusion in "${dns_exclusions[@]}"; do
        trimmed="$(printf '%s' "${exclusion}" | xargs)"
        if [ -n "${trimmed}" ]; then
            resolver_rule="${resolver_rule} , EXCLUDE ${trimmed}"
        fi
    done
    CHROME_COMMON_FLAGS+=("--host-resolver-rules=${resolver_rule}")
fi
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
