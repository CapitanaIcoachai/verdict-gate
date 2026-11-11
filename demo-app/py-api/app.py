#!/usr/bin/env python3
"""Tiny JSON API used by the ContractDiff demo. Standard library only.  python3 app.py --port 8080"""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class Api(BaseHTTPRequestHandler):
    def user(self, uid):
        return {"id": uid, "name": "Ada", "email": "ada@example.com", "roles": ["admin"]}
    def health(self):
        return {"ok": True}
    def do_GET(self):
        if self.path == "/health": return self.send(200, self.health())
        if self.path.startswith("/users/"):
            try: return self.send(200, self.user(int(self.path.rsplit("/", 1)[1])))
            except ValueError: return self.send(404, {"error": "not found"})
        if self.path == "/orders": return self.send(200, {"items": [{"sku": "A1", "qty": 2, "price": 9.5}], "total": 19.0})
        self.send(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/orders": return self.send(201, {"id": 42, "sku": body.get("sku"), "status": "created"})
        self.send(404, {"error": "not found"})
    def send(self, status, obj):
        data = json.dumps(obj).encode(); self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass

if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8080
    HTTPServer(("127.0.0.1", port), Api).serve_forever()
