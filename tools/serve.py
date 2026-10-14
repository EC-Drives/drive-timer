"""Serve the app on this laptop only, at http://localhost:8765/ (press Ctrl+C to stop).

    python tools/serve.py            serve on port 8765
    python tools/serve.py 9000       another port
    python tools/serve.py --open     also open the browser

Uses explicit file types (Windows sometimes reports .js files wrongly, which stops the app
loading) and tells the browser not to cache, so changes show on reload. Listens on 127.0.0.1
only, so nothing on the network can reach it.
"""
import functools
import http.server
import os
import sys
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.mp4': 'video/mp4',
    '.csv': 'text/csv; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # keep connections open; some browsers reset closed ones

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower()) or super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    port = int(args[0]) if args else 8765
    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    url = f'http://localhost:{port}/'
    print(f'Sepang Lap Timer is running at {url}  (press Ctrl+C to stop)', flush=True)
    if '--open' in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
