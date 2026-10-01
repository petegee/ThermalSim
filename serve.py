#!/usr/bin/env python3
"""Tiny static dev server with caching disabled, so edits to ES modules show up on reload.

Usage: python3 serve.py [port]   (default 8000)
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler) as httpd:
        print(f"Third Vector Trainer → http://localhost:{port}")
        httpd.serve_forever()
