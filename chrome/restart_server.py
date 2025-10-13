#!/usr/bin/env python3
import http.server
import json
import os
import signal
import threading
import time

DEFAULT_CONTROL_PORT = 9223
DEFAULT_PID_FILE_PATH = '/tmp/chrome-main.pid'
DEFAULT_RESTART_COOLDOWN_MS = 5000

_control_lock = threading.Lock()
_last_restart_epoch_ms = 0


def _get_logger_prefix():
    return '[STATUS]'


def _get_warn_prefix():
    return '[WARN]'


def _emit_status(message, **details):
    payload = {'message': message}
    if details:
        payload.update(details)
    print(f"{_get_logger_prefix()} Chrome control server: {json.dumps(payload, separators=(',', ':'))}", flush=True)


def _emit_warn(message, **details):
    payload = {'message': message}
    if details:
        payload.update(details)
    print(f"{_get_warn_prefix()} Chrome control server: {json.dumps(payload, separators=(',', ':'))}", flush=True)


class RestartRequestHandler(http.server.BaseHTTPRequestHandler):
    server_version = 'ThermopticChromeControl/1.0'

    def _read_pid(self):
        pid_file = self.server.pid_file
        try:
            with open(pid_file, 'r', encoding='utf-8') as handle:
                raw_pid = handle.read().strip()
            if not raw_pid:
                raise ValueError('PID file empty')
            return int(raw_pid)
        except (OSError, ValueError) as err:
            _emit_warn('Unable to load Chrome PID file.', error=str(err), pid_file=pid_file)
            return None

    def _kill_chrome(self):
        pid = self._read_pid()
        if pid is None:
            return False
        try:
            os.kill(pid, signal.SIGTERM)
            _emit_status('Sent SIGTERM to Chrome.', pid=pid)
            return True
        except ProcessLookupError:
            _emit_warn('Chrome PID not found during restart request.', pid=pid)
            return False
        except PermissionError as err:
            _emit_warn('Insufficient permissions to signal Chrome.', error=str(err), pid=pid)
            return False

    def _handle_restart(self):
        global _last_restart_epoch_ms
        now_ms = int(time.time() * 1000)
        cooldown_ms = self.server.restart_cooldown_ms

        with _control_lock:
            if now_ms - _last_restart_epoch_ms < cooldown_ms:
                self.send_response(429)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                payload = {'status': 'cooldown', 'cooldown_ms': cooldown_ms}
                self.wfile.write(json.dumps(payload).encode('utf-8'))
                return

            restart_triggered = self._kill_chrome()
            if restart_triggered:
                _last_restart_epoch_ms = now_ms

        status_code = 202 if restart_triggered else 500
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        payload = {'status': 'restarting' if restart_triggered else 'failed'}
        self.wfile.write(json.dumps(payload).encode('utf-8'))

    def do_POST(self):
        if self.path == '/restart':
            self._handle_restart()
        else:
            self.send_error(404, 'Not Found')

    def do_GET(self):
        if self.path == '/status':
            pid = self._read_pid()
            state = 'ready' if pid is not None else 'unknown'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            payload = {'status': state, 'pid': pid}
            self.wfile.write(json.dumps(payload).encode('utf-8'))
        else:
            self.send_error(404, 'Not Found')

    def log_message(self, format, *args):
        return


class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
    def __init__(self, server_address, RequestHandlerClass, pid_file, restart_cooldown_ms):
        super().__init__(server_address, RequestHandlerClass)
        self.pid_file = pid_file
        self.restart_cooldown_ms = restart_cooldown_ms


def main():
    port = int(os.environ.get('CHROME_CONTROL_PORT', DEFAULT_CONTROL_PORT))
    pid_file = os.environ.get('CHROME_CONTROL_PID_FILE', DEFAULT_PID_FILE_PATH)
    restart_cooldown_ms = int(os.environ.get('CHROME_CONTROL_COOLDOWN_MS', DEFAULT_RESTART_COOLDOWN_MS))

    server = ThreadedHTTPServer(('0.0.0.0', port), RestartRequestHandler, pid_file, restart_cooldown_ms)
    _emit_status('Chrome restart control server listening.', port=port, pid_file=pid_file)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        _emit_status('Chrome restart control server stopped.')


if __name__ == '__main__':
    main()
