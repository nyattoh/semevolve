import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

const page = `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>semevolve P0</title>
<main>
  <h1>semevolve P0・機構未完了</h1>
  <p>AT完了 0/34。現在は起動確認用の骨格です。</p>
  <p>実モデル接続、作業実行、保存・取出し、移行の機構は未実装です。</p>
</main>
</html>`;

export function createLocalUi(): Server {
  return createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createLocalUi();
  server.listen(4173, '127.0.0.1', () => {
    process.stdout.write('semevolve P0・機構未完了 http://127.0.0.1:4173\n');
  });
}
