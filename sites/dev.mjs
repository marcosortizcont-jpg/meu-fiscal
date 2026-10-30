// Servidor local que imita a Vercel: lê o vercel.json do site e aplica redirects, rewrites (inclusive o proxy /api) e headers.
// Uso: API_URL=http://localhost:8080 node sites/build.mjs cliente && API_URL=http://localhost:8080 node sites/dev.mjs cliente 4001
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const [site, porta = site === 'painel' ? '4002' : '4001'] = process.argv.slice(2);
const DIR = path.join(AQUI, site), DIST = path.join(DIR, 'dist');
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'vercel.json'), 'utf8'));
const API = (process.env.API_URL || 'http://localhost:8080').replace(/\/$/, '');
const API_PROD = new URL(cfg.rewrites.find(r => /^https?:/.test(r.destination)).destination.replace(':caminho*', '')).origin;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

function casar(padrao, caminho) {
  if (padrao.includes(':caminho*')) { const base = padrao.replace('/:caminho*', ''); return caminho === base || caminho.startsWith(base + '/') ? caminho.slice(base.length + 1) : null; }
  return padrao === caminho ? '' : null;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  for (const h of cfg.headers.find(h => h.source === '/(.*)').headers) res.setHeader(h.key, h.value.split(API_PROD).join(API));
  for (const r of cfg.redirects) if (casar(r.source, u.pathname) !== null) { res.writeHead(307, { Location: r.destination }).end(); return; }
  for (const r of cfg.rewrites) {
    const resto = casar(r.source, u.pathname); if (resto === null) continue;
    if (/^https?:/.test(r.destination)) {
      const alvo = new URL(API + '/api/' + resto + u.search);
      const mod = alvo.protocol === 'https:' ? https : http;
      const p = mod.request(alvo, { method: req.method, headers: { ...req.headers, host: alvo.host, 'x-forwarded-for': req.socket.remoteAddress } }, pr => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
      p.on('error', () => { res.writeHead(502).end('API indisponível'); });
      req.pipe(p); return;
    }
    return servir(r.destination, res);
  }
  servir(u.pathname, res);
}).listen(Number(porta), () => console.log(`site ${site} em http://localhost:${porta} (API ${API})`));

function servir(caminho, res) {
  const arq = path.join(DIST, path.normalize(caminho).replace(/^(\.\.[/\\])+/, ''));
  if (!arq.startsWith(DIST) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
  fs.createReadStream(arq).pipe(res);
}
