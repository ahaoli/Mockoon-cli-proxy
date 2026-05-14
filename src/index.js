const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  if (!config.targetBaseUrl) {
    throw new Error('config.targetBaseUrl is required');
  }

  return {
    listenPort: Number(config.listenPort || 8080),
    interceptPath: config.interceptPath || '/v1/chat/completions',
    targetBaseUrl: config.targetBaseUrl,
    requestTimeoutMs: Number(config.requestTimeoutMs || 120000)
  };
}

const config = loadConfig();
const targetBase = new URL(config.targetBaseUrl);

function copyHeaders(sourceHeaders = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(sourceHeaders)) {
    if (typeof v !== 'undefined') headers[k] = v;
  }
  return headers;
}

function writeSseLine(res, line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  res.write(`${trimmed}\n\n`);
}

function proxyStreamingRequest(req, res) {
  const bodyChunks = [];

  req.on('data', (chunk) => bodyChunks.push(chunk));
  req.on('error', (err) => {
    console.error('Request stream error:', err);
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Bad request stream' }));
  });

  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);
    const targetUrl = new URL(req.url, targetBase);

    const headers = copyHeaders(req.headers);
    headers.host = targetBase.host;
    headers.connection = 'keep-alive';

    const requestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      timeout: config.requestTimeoutMs
    };

    const transport = targetUrl.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request(requestOptions, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });

      let buffer = '';
      upstreamRes.setEncoding('utf8');

      upstreamRes.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          writeSseLine(res, line);
        }
      });

      upstreamRes.on('end', () => {
        if (buffer.trim()) {
          writeSseLine(res, buffer);
        }
        res.end();
      });

      upstreamRes.on('error', (err) => {
        console.error('Upstream response error:', err);
        if (!res.writableEnded) {
          res.end();
        }
      });
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream request timeout'));
    });

    upstreamReq.on('error', (err) => {
      console.error('Upstream request error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Upstream request failed', details: err.message }));
      } else {
        res.end();
      }
    });

    if (body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

function passthrough(req, res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      error: 'Not intercepted',
      hint: `Only ${config.interceptPath} is intercepted. Configure interceptPath in config.json if needed.`
    })
  );
}

const server = http.createServer((req, res) => {
  const reqPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (reqPath === config.interceptPath) {
    proxyStreamingRequest(req, res);
    return;
  }
  passthrough(req, res);
});

server.listen(config.listenPort, () => {
  console.log(`[mockoon-cli-proxy] listening on port ${config.listenPort}`);
  console.log(`[mockoon-cli-proxy] intercept path: ${config.interceptPath}`);
  console.log(`[mockoon-cli-proxy] target base url: ${config.targetBaseUrl}`);
  console.log(`[mockoon-cli-proxy] config file: ${CONFIG_PATH}`);
});
