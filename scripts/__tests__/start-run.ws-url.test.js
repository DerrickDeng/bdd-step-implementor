const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { resolveWsUrl } = require('../start-run');  // new export

test('resolveWsUrl extracts webSocketDebuggerUrl from /json/version', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        Browser: 'Chrome/147.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/abc-123',
      }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ws = await resolveWsUrl(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
    assert.strictEqual(ws, 'ws://127.0.0.1:0/devtools/browser/abc-123');
  } finally {
    server.close();
  }
});

test('resolveWsUrl retries until endpoint is up then succeeds', async () => {
  // Start no server; start one after 300ms; resolver with 3s budget should succeed.
  let server;
  const started = new Promise((resolve) => {
    setTimeout(() => {
      server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://x/y' }));
      });
      server.listen(39222, '127.0.0.1', resolve);
    }, 300);
  });
  try {
    const ws = await resolveWsUrl('http://127.0.0.1:39222', { timeoutMs: 3000, pollIntervalMs: 100 });
    assert.strictEqual(ws, 'ws://x/y');
  } finally {
    await started;
    server && server.close();
  }
});
