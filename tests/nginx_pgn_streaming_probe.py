"""Synthetic loopback nginx regression; no application or production data.

Run as a non-root account on a host with nginx installed. Reproduces an
unwritable body spool with a slow request, then verifies route-local streaming,
the body-size rejection, and preservation of the request bytes upstream.
"""

import hashlib
import http.client
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    assert os.geteuid() != 0, "Run unprivileged; the permission regression requires it"
    binary = shutil.which("nginx") or "/usr/sbin/nginx"
    payload = json.dumps({"pgn": "{synthetic-padding}" * 4000}).encode()
    received = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            data = self.rfile.read(int(self.headers["Content-Length"]))
            received.append(hashlib.sha256(data).hexdigest())
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *args):
            pass

    upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    result = {}
    with tempfile.TemporaryDirectory(prefix="studio-pgn-nginx-") as directory:
        root = Path(directory)
        body = root / "body"
        body.mkdir(mode=0o500)
        try:
            for mode in ("on", "off"):
                listen = port()
                config = root / "nginx.conf"
                config.write_text(f"""daemon off;
master_process off;
pid {root}/nginx.pid;
error_log {root}/error.log notice;
events {{ worker_connections 16; }}
http {{
  access_log off;
  client_body_temp_path {body};
  server {{
    listen 127.0.0.1:{listen};
    location ~ ^/api/(parse-pgn|export-pgn)$ {{
      client_max_body_size 8m;
      client_body_timeout 30s;
      proxy_http_version 1.1;
      proxy_request_buffering {mode};
      proxy_send_timeout 60s;
      proxy_read_timeout 60s;
      proxy_pass http://127.0.0.1:{upstream.server_port};
    }}
  }}
}}
""")
                process = subprocess.Popen([binary, "-p", directory, "-c", str(config)],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                try:
                    for _ in range(50):
                        try:
                            with socket.create_connection(("127.0.0.1", listen), timeout=0.1):
                                break
                        except OSError:
                            assert process.poll() is None, "nginx failed to start"
                            time.sleep(0.02)
                    connection = http.client.HTTPConnection("127.0.0.1", listen, timeout=5)
                    connection.putrequest("POST", "/api/parse-pgn")
                    connection.putheader("Content-Type", "application/json")
                    connection.putheader("Content-Length", str(len(payload)))
                    connection.endheaders()
                    for offset in range(0, len(payload), 4096):
                        try:
                            connection.send(payload[offset:offset + 4096])
                        except (BrokenPipeError, ConnectionResetError):
                            break
                        time.sleep(0.003)
                    response = connection.getresponse()
                    result[mode] = response.status
                    response.read()
                    connection.close()
                    if mode == "off":
                        oversized = http.client.HTTPConnection("127.0.0.1", listen, timeout=5)
                        oversized.putrequest("POST", "/api/parse-pgn")
                        oversized.putheader("Content-Length", str(8 * 1024 * 1024 + 1))
                        oversized.endheaders()
                        result["oversized"] = oversized.getresponse().status
                        oversized.close()
                finally:
                    process.terminate()
                    process.communicate(timeout=5)
            result["permissionDeniedObserved"] = "Permission denied" in (root / "error.log").read_text()
            result["exactBodyDeliveredOnce"] = received == [hashlib.sha256(payload).hexdigest()]
            result["syntheticBytes"] = len(payload)
            assert result == {"on": 500, "off": 200, "oversized": 413,
                              "permissionDeniedObserved": True, "exactBodyDeliveredOnce": True,
                              "syntheticBytes": len(payload)}, result
        finally:
            body.chmod(0o700)
            upstream.shutdown()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
