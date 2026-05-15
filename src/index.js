const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizePathList(paths) {
  return Array.from(new Set((Array.isArray(paths) ? paths : [])
    .map(normalizePath)
    .filter(Boolean)));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  const legacyInterceptPaths = Array.isArray(config.interceptPaths)
    ? config.interceptPaths
    : config.interceptPath
      ? [config.interceptPath]
      : ['/v1/chat/completions'];

  const routes = Array.isArray(config.routes)
    ? config.routes
      .filter((item) => item && typeof item === 'object' && item.targetBaseUrl)
      .map((item) => ({
        targetBaseUrl: String(item.targetBaseUrl),
        matchPaths: normalizePathList(item.matchPaths),
        interceptPaths: normalizePathList(item.interceptPaths)
      }))
    : [];

  if (!routes.length) {
    if (!config.targetBaseUrl) {
      throw new Error('config.targetBaseUrl is required when config.routes is not set');
    }

    routes.push({
      targetBaseUrl: String(config.targetBaseUrl),
      matchPaths: ['/'],
      interceptPaths: normalizePathList(legacyInterceptPaths)
    });
  }

  const defaultRoute = routes.find((route) => route.matchPaths.includes('/')) || routes[0];

  return {
    listenPort: Number(config.listenPort || 8080),
    requestTimeoutMs: Number(config.requestTimeoutMs || 120000),
    streamDelayMs: Number(config.streamDelayMs || 0),
    routes,
    defaultRoute
  };
}

const config = loadConfig();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRoute(reqPath) {
  const matchedRoutes = config.routes
    .filter((route) => route.matchPaths.some((prefix) => reqPath.startsWith(prefix)))
    .sort((a, b) => {
      const aLongest = Math.max(...a.matchPaths.map((prefix) => prefix.length));
      const bLongest = Math.max(...b.matchPaths.map((prefix) => prefix.length));
      return bLongest - aLongest;
    });

  return matchedRoutes[0] || config.defaultRoute;
}

function pipeRequestToUpstream(req, res, { forceSse, route, reqPath }) {
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
    const targetBase = new URL(route.targetBaseUrl);
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
      console.log(`[mockoon-cli-proxy] upstream response: ${req.method} ${reqPath} -> ${targetUrl.origin}${requestOptions.path} status=${upstreamRes.statusCode || 0} mode=${forceSse ? 'sse' : 'passthrough'}`);
      if (forceSse) {
        res.socket?.setNoDelay(true);
        res.writeHead(upstreamRes.statusCode || 200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        res.flushHeaders();
      } else {
        res.writeHead(upstreamRes.statusCode || 200, copyHeaders(upstreamRes.headers));
      }

      let buffer = '';
      upstreamRes.setEncoding('utf8');

      upstreamRes.on('data', async (chunk) => {
        if (!forceSse) {
          res.write(chunk);
          return;
        }

        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          writeSseLine(res, line);
          if (config.streamDelayMs > 0) {
            await sleep(config.streamDelayMs);
          }
        }
      });

      upstreamRes.on('end', async () => {
        if (!forceSse) {
          res.end();
          return;
        }

        if (buffer.trim()) {
          writeSseLine(res, buffer);
          if (config.streamDelayMs > 0) {
            await sleep(config.streamDelayMs);
          }
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

const server = http.createServer((req, res) => {
  const reqPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const route = pickRoute(reqPath);
  const shouldIntercept = route.interceptPaths.includes(reqPath);

  console.log(`[mockoon-cli-proxy] incoming request: ${req.method} ${req.url} path=${reqPath} target=${route.targetBaseUrl} mode=${shouldIntercept ? 'sse' : 'passthrough'}`);

  res.on('finish', () => {
    console.log(`[mockoon-cli-proxy] response finished: ${req.method} ${reqPath} status=${res.statusCode} mode=${shouldIntercept ? 'sse' : 'passthrough'}`);
  });

  pipeRequestToUpstream(req, res, { forceSse: shouldIntercept, route, reqPath });
});

server.listen(config.listenPort, () => {
  console.log(`[mockoon-cli-proxy] listening on port ${config.listenPort}`);
  console.log(`[mockoon-cli-proxy] request timeout ms: ${config.requestTimeoutMs}`);
  console.log(`[mockoon-cli-proxy] stream delay ms: ${config.streamDelayMs}`);
  for (const route of config.routes) {
    console.log(`[mockoon-cli-proxy] route target: ${route.targetBaseUrl}`);
    console.log(`[mockoon-cli-proxy]   match paths: ${route.matchPaths.join(', ')}`);
    console.log(`[mockoon-cli-proxy]   intercept paths: ${route.interceptPaths.join(', ') || '(none)'}`);
  }
  console.log(`[mockoon-cli-proxy] config file: ${CONFIG_PATH}`);
});
