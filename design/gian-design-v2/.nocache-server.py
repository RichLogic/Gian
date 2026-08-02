import http.server, socketserver, functools
DIR = '/Users/richlogic/Coding/Gian-Dev/design/gian-design-v2'
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
handler = functools.partial(H, directory=DIR)
with socketserver.TCPServer(('127.0.0.1', 4174), handler) as httpd:
    httpd.serve_forever()
