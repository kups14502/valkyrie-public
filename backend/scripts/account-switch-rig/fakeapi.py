#!/usr/bin/env python3
# Loopback stand-in for api.anthropic.com. Only dummy tokens ever reach it.
# Token prefix decides the answer:
#   dummy-A...  429 five_hour rejection (5h 100%)
#   dummy-B...  200 tiny reply, 5h 2%
#   dummy-C...  200, 5h 95% (near the limit)
#   dummy-D...  401 (a refused token)
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = sys.argv[2]

def log(line):
    with open(LOG, 'a') as f:
        f.write(time.strftime('%H:%M:%S ') + line + '\n')

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _tok(self):
        a = self.headers.get('Authorization', '') or ''
        t = a.split(' ', 1)[1] if ' ' in a else '-'
        return t if t.startswith('dummy-') else ('<non-dummy len %d>' % len(t))

    def do_GET(self):
        log('GET %s tok=%s' % (self.path.split('?')[0], self._tok()[:9]))
        self.send_response(404)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"type":"error","error":{"type":"not_found_error","message":"fake"}}')

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n) if n else b''
        tok = self._tok()
        path = self.path.split('?')[0]
        model = '-'
        stream = False
        try:
            j = json.loads(body or b'{}')
            model = j.get('model', '-')
            stream = bool(j.get('stream'))
        except Exception:
            pass
        log('POST %s tok=%s model=%s stream=%s' % (path, tok[:9], model, stream))
        if not path.startswith('/v1/messages') or path.endswith('count_tokens'):
            self.send_response(404)
            self.end_headers()
            return
        now = int(time.time())
        if tok.startswith('dummy-A'):
            reset = now + 3 * 3600
            self.send_response(429)
            hdrs = {
                'content-type': 'application/json',
                'anthropic-ratelimit-unified-status': 'rejected',
                'anthropic-ratelimit-unified-representative-claim': 'five_hour',
                'anthropic-ratelimit-unified-reset': str(reset),
                'anthropic-ratelimit-unified-5h-status': 'rejected',
                'anthropic-ratelimit-unified-5h-utilization': '1.0',
                'anthropic-ratelimit-unified-5h-reset': str(reset),
                'anthropic-ratelimit-unified-7d-utilization': '0.40',
                'anthropic-ratelimit-unified-7d-reset': str(now + 4 * 86400),
                'anthropic-ratelimit-unified-overage-status': 'rejected',
                'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
                'retry-after': str(reset - now),
                'x-should-retry': 'false',
            }
            for k, v in hdrs.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(json.dumps({'type': 'error', 'error': {'type': 'rate_limit_error', 'message': 'This request would exceed your rate limit.'}}).encode())
            return
        if tok.startswith('dummy-D'):
            self.send_response(401)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"type":"error","error":{"type":"authentication_error","message":"invalid token"}}')
            return
        if tok.startswith('dummy-B') or tok.startswith('dummy-C'):
            util = '0.02' if tok.startswith('dummy-B') else '0.95'
            name = 'B' if tok.startswith('dummy-B') else 'C'
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream' if stream else 'application/json')
            self.send_header('anthropic-ratelimit-unified-status', 'allowed')
            self.send_header('anthropic-ratelimit-unified-5h-utilization', util)
            self.send_header('anthropic-ratelimit-unified-5h-reset', str(now + 4 * 3600))
            self.send_header('anthropic-ratelimit-unified-7d-utilization', '0.10')
            self.send_header('anthropic-ratelimit-unified-7d-reset', str(now + 5 * 86400))
            self.end_headers()
            if not stream:
                self.wfile.write(json.dumps({'id': 'msg_fake', 'type': 'message', 'role': 'assistant', 'model': model,
                                             'content': [{'type': 'text', 'text': 'x'}], 'stop_reason': 'max_tokens',
                                             'usage': {'input_tokens': 1, 'output_tokens': 1}}).encode())
                return

            def ev(nm, d):
                self.wfile.write(('event: %s\ndata: %s\n\n' % (nm, json.dumps(d))).encode())
            ev('message_start', {'type': 'message_start', 'message': {'id': 'msg_fake', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}}})
            ev('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
            ev('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'REPLY-FROM-ACCOUNT-' + name}})
            ev('content_block_stop', {'type': 'content_block_stop', 'index': 0})
            ev('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 3}})
            ev('message_stop', {'type': 'message_stop'})
            return
        self.send_response(401)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
