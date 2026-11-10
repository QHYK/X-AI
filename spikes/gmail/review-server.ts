import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createReviewStore, ReviewError } from './review-data.js';

const maxBody = 2 * 1024 * 1024;
const parentCsp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export function checkLocalRequest(req: IncomingMessage, port: number, token: string, api: boolean) {
  const origin = `http://127.0.0.1:${port}`;
  if (
    req.socket.remoteAddress !== '127.0.0.1' ||
    req.headers.host !== `127.0.0.1:${port}` ||
    (req.headers.origin && req.headers.origin !== origin) ||
    req.headers['sec-fetch-site'] === 'cross-site'
  )
    throw new ReviewError(403, '仅允许本机同源访问');
  if (api) {
    const value = req.headers['x-review-token'];
    if (
      typeof value !== 'string' ||
      !/^([a-f0-9]{64})$/.test(value) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(token))
    )
      throw new ReviewError(403, '缺少本地页面访问令牌');
  }
  if (
    req.method === 'PUT' &&
    (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')
  )
    throw new ReviewError(403, '写入必须来自本机同源 JSON 请求');
}
function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0,
      tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        tooLarge = true;
        chunks.length = 0;
        reject(new ReviewError(413, '请求体超过 2 MiB 限制'));
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new ReviewError(400, '请求已中断')));
  });
}
const page = (token: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="review-token" content="${token}"><title>Newsletter Annotation Spike</title><link rel="stylesheet" href="/style.css"></head><body><header><h1>Newsletter 内容审核</h1><p>默认使用来源预选切分 · 可调整边界或补充遗漏 · 不加载远程资源</p><div class="toolbar"><label>来源<select id="source"></select></label><label>邮件<select id="message"></select></label><label><input id="all-history" type="checkbox">全部历史（默认每来源最近 5 封）</label><button id="previous">上一封</button><button id="next">下一封</button></div><div id="metadata"></div><div id="progress"></div></header><main><section class="preview-panel"><div class="preview-toolbar"><strong>Newsletter 预览</strong><button id="locate">定位当前内容</button><button id="pick-start">点击选择起点</button><button id="pick-end">点击选择终点</button><span id="location-status" role="status"></span></div><iframe id="preview" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="隔离的 Newsletter 预览"></iframe></section><section class="annotation-panel"><div class="annotation-toolbar"><strong>来源预选内容</strong><button id="load-guidance">重新载入来源预选</button><button id="add">新增遗漏内容</button><button id="save">保存本封邮件</button><span id="save-status" role="status"></span></div><div id="notice" role="alert"></div><div class="workspace"><nav id="units" aria-label="内容单元"></nav><div id="editor"></div></div></section></main><script type="module" src="/app.js"></script></body></html>`;

export async function createReviewServer(root?: string) {
  const store = createReviewStore(root, {
    annotationRoot: root ? undefined : resolve('spikes/gmail/runtime/source-annotations-v2'),
    annotationFallbackRoot: root ? undefined : resolve('spikes/gmail/runtime/source-annotations'),
    additionalRoot: root ? undefined : resolve('spikes/gmail/runtime/validation'),
  });
  const token = randomBytes(32).toString('hex');
  const source = await readFile(
    fileURLToPath(new URL('./review-client.ts', import.meta.url)),
    'utf8',
  );
  const client = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const css = await readFile(fileURLToPath(new URL('./review.css', import.meta.url)), 'utf8');
  const server = createServer(async (req, res) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': parentCsp,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Frame-Options': 'DENY',
      });
      res.end(body);
    };
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new ReviewError(503, '服务未就绪');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${address.port}`);
      checkLocalRequest(req, address.port, token, url.pathname.startsWith('/api/'));
      if (req.method === 'GET' && url.pathname === '/')
        return send(200, 'text/html; charset=utf-8', page(token));
      if (req.method === 'GET' && url.pathname === '/app.js')
        return send(200, 'text/javascript; charset=utf-8', client);
      if (req.method === 'GET' && url.pathname === '/style.css')
        return send(200, 'text/css; charset=utf-8', css);
      let result: unknown;
      if (req.method === 'GET' && url.pathname === '/api/messages') result = await store.list();
      else {
        const match = url.pathname.match(/^\/api\/(messages|annotations)\/([a-zA-Z0-9_-]{1,128})$/);
        if (!match) throw new ReviewError(404, '接口或文件不存在');
        if (req.method === 'GET' && match[1] === 'messages') result = await store.detail(match[2]);
        else if (req.method === 'PUT' && match[1] === 'annotations') {
          let body;
          try {
            body = JSON.parse(await readBody(req));
          } catch (e) {
            if (e instanceof ReviewError) throw e;
            throw new ReviewError(400, 'JSON 格式错误');
          }
          result = await store.save(match[2], body);
        } else throw new ReviewError(405, '不支持的操作');
      }
      send(200, 'application/json; charset=utf-8', JSON.stringify(result));
    } catch (error) {
      const known = error instanceof ReviewError;
      if (!known)
        console.error(
          '[gmail-review] local operation failed:',
          error instanceof Error ? error.name : 'UnknownError',
        );
      if (!res.headersSent)
        send(
          known ? error.status : 500,
          'application/json; charset=utf-8',
          JSON.stringify({
            error: known ? error.message : '本地文件读取或保存失败；请检查文件及权限。',
          }),
        );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, store };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.GMAIL_REVIEW_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('GMAIL_REVIEW_PORT must be 1024..65535');
  const args = process.argv.slice(2);
  if (args.length) throw new Error('Usage: spike:gmail:review');
  const { server, store } = await createReviewServer();
  const messages = await store.list();
  server.on('error', () => {
    console.error('Cannot start local review server; check port availability.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Newsletter review: http://127.0.0.1:${port} (${messages.length} messages, ${messages.reduce((n, m) => n + m.unit_count, 0)} source-selected units). Stop with Ctrl+C.`,
    ),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}
