// Roteador HTTP mínimo: rotas com parâmetros, JSON, cookies, CORS estrito por origem e erros padronizados.
import { CONFIG, SITES, PRODUCAO } from './config.js';

export class ErroHttp extends Error {
  constructor(status, mensagem, extra) { super(mensagem); this.status = status; this.extra = extra; }
}

const todasOrigens = () => [...CONFIG.origens.cliente, ...CONFIG.origens.painel];
export const siteDaOrigem = origem => SITES.find(s => CONFIG.origens[s].includes(origem)) || null;

export function criarRoteador() {
  const rotas = [];
  const add = (metodo, caminho, fn, opcoes = {}) => {
    const nomes = []; const re = new RegExp('^' + caminho.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, fn, opcoes });
  };
  const r = { get: (c, f, o) => add('GET', c, f, o), post: (c, f, o) => add('POST', c, f, o), put: (c, f, o) => add('PUT', c, f, o), patch: (c, f, o) => add('PATCH', c, f, o), delete: (c, f, o) => add('DELETE', c, f, o) };

  r.tratar = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const origem = (req.headers.origin || '').replace(/\/$/, '');
    // CORS: só os dois domínios dos sites. Nada de "*", nada de origem refletida sem conferir.
    if (origem && todasOrigens().includes(origem)) {
      res.setHeader('Access-Control-Allow-Origin', origem);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!origem || !todasOrigens().includes(origem)) { res.writeHead(403).end(); return; }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-MF-Site,Last-Event-ID',
        'Access-Control-Max-Age': '600',
      }).end(); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), origem, params: {}, cookies: lerCookies(req.headers.cookie), ip: ipDe(req) };
    try {
      const metodoOk = rotas.filter(x => x.re.test(url.pathname));
      const rota = metodoOk.find(x => x.metodo === req.method);
      if (!rota) throw new ErroHttp(metodoOk.length ? 405 : 404, metodoOk.length ? 'Método não permitido.' : 'Rota não encontrada.');
      const m = url.pathname.match(rota.re); rota.nomes.forEach((n, i) => ctx.params[n] = decodeURIComponent(m[i + 1]));

      // Proteção contra CSRF em toda escrita: origem conhecida (quando o navegador envia) + cabeçalho próprio.
      if (req.method !== 'GET') {
        if (origem && !todasOrigens().includes(origem)) throw new ErroHttp(403, 'Origem não autorizada.');
        if (!rota.opcoes.semCabecalhoSite && !SITES.includes(req.headers['x-mf-site'])) throw new ErroHttp(400, 'Cabeçalho X-MF-Site ausente.');
      }
      if (rota.opcoes.corpo !== 'bruto' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) ctx.corpo = await lerJson(req, rota.opcoes.limite || 1024 * 1024);
      const saida = await rota.fn(ctx);
      if (res.writableEnded || res.headersSent) return;
      enviar(res, 200, saida ?? { ok: true });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof ErroHttp) return enviar(res, e.status, { erro: e.message, ...(e.extra || {}) });
      if (e && e.code === '23505') return enviar(res, 409, { erro: 'Registro já existe.' });
      console.error('[erro]', req.method, url.pathname, e);
      enviar(res, 500, { erro: PRODUCAO ? 'Erro interno. Tente de novo em instantes.' : String(e && e.message || e) });
    }
  };
  return r;
}

export function enviar(res, status, corpo) {
  const txt = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(txt) });
  res.end(txt);
}

export function lerCorpoBruto(req, limite) {
  return new Promise((ok, falha) => {
    const partes = []; let total = 0;
    req.on('data', c => { total += c.length; if (total > limite) { falha(new ErroHttp(413, 'Conteúdo maior que o permitido.')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}
async function lerJson(req, limite) {
  const b = await lerCorpoBruto(req, limite);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new ErroHttp(400, 'JSON inválido.'); }
}

function lerCookies(h) {
  const out = {};
  String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
export function definirCookie(res, nome, valor, { maxAge, sameSite = 'Lax' } = {}) {
  const partes = [`${nome}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (CONFIG.cookieSeguro) partes.push('Secure');
  if (maxAge !== undefined) partes.push(`Max-Age=${maxAge}`);
  const atual = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(atual ? [].concat(atual) : []), partes.join('; ')]);
}
// A Vercel/Netlify colocam o IP real do visitante no primeiro item de X-Forwarded-For
function ipDe(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }
