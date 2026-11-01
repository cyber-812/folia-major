// ai-api/server.mjs
// 零依赖 Node (>=18) 适配层：把 Folia 仓库现成的 Edge 风格 ESM handler
// (api/generate-theme_openai.js、api/segment-lyrics.js，default export 收
// Web Request、返 Web Response) 挂到普通 Node http 服务上，供 Render
// Web Service 部署。不改动任何 Folia 业务代码。
//
// 路由：
//   POST /api/generate-theme_openai  -> api/generate-theme_openai.js
//   POST /api/segment-lyrics         -> api/segment-lyrics.js
//   GET  /                           -> 纯文本健康检查
//
// 环境变量（由部署平台注入，handler 内部读取）：
//   OPENAI_API_KEY        上游 OpenAI 兼容接口的 Key
//   OPENAI_API_URL        例如 https://infistar.cc/v1（handler 会规范化）
//   OPENAI_API_MODEL      例如 gpt-4o-mini
//   AI_PROVIDER           填 openai，让 segment-lyrics 也走 OpenAI 连接
//   PORT                  本服务监听端口（Render 自动注入）

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const themeHandler = (await import(join(repoRoot, 'api', 'generate-theme_openai.js'))).default;
const segmentHandler = (await import(join(repoRoot, 'api', 'segment-lyrics.js'))).default;

const ROUTES = new Map([
  ['/api/generate-theme_openai', themeHandler],
  ['/api/segment-lyrics', segmentHandler],
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    if (body.length > 0) init.body = body;
  }
  return new Request(url, init);
}

async function writeWebResponse(res, webResponse) {
  const headers = {};
  webResponse.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = Buffer.from(await webResponse.arrayBuffer());
  res.writeHead(webResponse.status, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('folia-ai-api ok\n');
      return;
    }

    const handler = ROUTES.get(pathname);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const webRequest = await toWebRequest(req);
    const webResponse = await handler(webRequest);
    await writeWebResponse(res, webResponse);
  } catch (error) {
    console.error('ai-api adapter error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
server.listen(port, () => {
  console.log(`folia-ai-api listening on port ${port}`);
});
