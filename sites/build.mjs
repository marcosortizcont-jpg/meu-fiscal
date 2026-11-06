// Gera um dos dois sites a partir do app compartilhado (../app).
//   node sites/build.mjs cliente               → sites/cliente/dist
//   node sites/build.mjs painel                → sites/painel/dist
//   node sites/build.mjs cliente --configurar  → regrava vercel.json e netlify.toml com a URL da API do .env.production
// Sem dependências: roda na Vercel, Netlify ou Cloudflare com Node 20+.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { montarLanding } from './landing.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(AQUI, '../app');
const site = process.argv[2];
const configurar = process.argv.includes('--configurar');
if (!['cliente', 'painel'].includes(site)) { console.error('Uso: node sites/build.mjs <cliente|painel> [--configurar]'); process.exit(1); }
const DIR = path.join(AQUI, site), DIST = path.join(DIR, 'dist');

/* ---------- variáveis: .env.production do site, sobrescritas pelas do painel da hospedagem ---------- */
const env = {};
for (const arq of ['.env.production', '.env.local']) {
  const p = path.join(DIR, arq); if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
}
for (const k of ['API_URL', 'ARQUIVOS_HOST', 'SITE_URL', 'PAINEL_URL']) if (process.env[k]) env[k] = process.env[k];
const API = String(env.API_URL || '').replace(/\/$/, '');
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API);
if (!/^https:\/\/[^/]+$/.test(API) && !LOCAL) { console.error(`API_URL inválida em sites/${site}/.env.production: "${API}". Ex.: API_URL=https://meufiscal-api.onrender.com`); process.exit(1); }
const ARQ_HOST = String(env.ARQUIVOS_HOST || 'https://*.r2.cloudflarestorage.com').replace(/\/$/, '');

/* ---------- rotas e cabeçalhos de segurança ---------- */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${ARQ_HOST}`,
  `media-src 'self' blob: ${ARQ_HOST}`,
  `connect-src 'self' ${API} ${ARQ_HOST}`,
  "worker-src 'self' blob:",
  `frame-src 'self' blob: ${ARQ_HOST}`,
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');
const SEGURANCA = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), payment=()' },
  ...(site === 'painel' ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] : []),
];
const ROTAS = site === 'cliente' ? {
  // "/" é a página comercial (index.html); o portal fica em /dashboard
  redirects: [
    ['/admin', '/login'], ['/admin/:caminho*', '/login'],     // o portal não tem área administrativa (a equipe usa o site do painel)
    ['/cadastro', '/#comecar'], ['/primeiro-acesso', '/login?primeiro-acesso'],
  ],
  paginas: [['/login', '/login.html'], ['/definir-senha', '/login.html'], ['/dashboard', '/app.html'], ['/termos', '/legal.html'], ['/privacidade', '/legal.html']],
} : {
  redirects: [['/', '/admin/dashboard'], ['/admin', '/admin/dashboard'], ['/login', '/admin/login'], ['/dashboard', '/admin/dashboard']],
  paginas: [['/admin/login', '/login.html'], ['/admin/definir-senha', '/login.html'], ['/admin/dashboard', '/app.html'], ['/admin/cadastro', '/acessos.html']],
};

function vercelJson() {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    installCommand: 'echo "sem dependências"',
    buildCommand: `node ../build.mjs ${site}`,
    outputDirectory: 'dist',
    redirects: ROTAS.redirects.map(([source, destination]) => ({ source, destination, permanent: false })),
    rewrites: [
      // proxy da API: o navegador só fala com o domínio do site, então o cookie de sessão é próprio (nada de cookie de terceiros)
      { source: '/api/:caminho*', destination: `${API}/api/:caminho*` },
      ...ROTAS.paginas.map(([source, destination]) => ({ source, destination })),
    ],
    headers: [
      { source: '/(.*)', headers: SEGURANCA },
      { source: '/(app|login|acessos|index|legal).html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ],
  };
}
function netlifyToml() {
  const r = [
    `[build]\n  base = "sites/${site}"\n  command = "node ../build.mjs ${site}"\n  publish = "dist"\n`,
    ...ROTAS.redirects.map(([de, para]) => `[[redirects]]\n  from = "${de.replace(':caminho*', '*')}"\n  to = "${para}"\n  status = 302\n  force = true\n`),
    `[[redirects]]\n  from = "/api/*"\n  to = "${API}/api/:splat"\n  status = 200\n  force = true\n`,
    ...ROTAS.paginas.map(([de, para]) => `[[redirects]]\n  from = "${de}"\n  to = "${para}"\n  status = 200\n  force = true\n`),
    `[[headers]]\n  for = "/*"\n  [headers.values]\n${SEGURANCA.map(h => `    ${h.key} = '''${h.value}'''`).join('\n')}\n`,
  ];
  return `# Gerado por: node sites/build.mjs ${site} --configurar\n# (Alternativa à Vercel. No Netlify, aponte o "Base directory" para sites/${site}.)\n\n` + r.join('\n');
}

// Cloudflare Pages: a ponte /api/* é uma Pages Function (o _redirects da Cloudflare não faz proxy para fora)
function funcaoCloudflare() {
  return `// Gerado por: node sites/build.mjs ${site} --configurar
// Cloudflare Pages Function: repassa /api/* para a API, mantendo o cookie de sessão no domínio do site.
// A variável API_URL (Settings → Variables) tem prioridade sobre o endereço abaixo.
const API_PADRAO = '${API}';
export async function onRequest({ request, env }) {
  const api = String(env.API_URL || API_PADRAO).replace(/\\/$/, '');
  const u = new URL(request.url);
  const destino = api + u.pathname + u.search;
  const h = new Headers(request.headers);
  h.delete('host');
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) h.set('x-forwarded-for', ip);   // a API usa o 1º IP para limitar tentativas de login
  h.set('x-forwarded-host', u.host); h.set('x-forwarded-proto', 'https');
  const comCorpo = !['GET', 'HEAD'].includes(request.method);
  const r = await fetch(destino, { method: request.method, headers: h, body: comCorpo ? await request.arrayBuffer() : undefined, redirect: 'manual' });
  const rh = new Headers(r.headers);
  rh.set('Cache-Control', rh.get('Cache-Control') || 'no-store');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: rh });
}
`;
}

if (configurar) {
  fs.writeFileSync(path.join(DIR, 'vercel.json'), JSON.stringify(vercelJson(), null, 2) + '\n');
  fs.writeFileSync(path.join(DIR, 'netlify.toml'), netlifyToml());
  fs.mkdirSync(path.join(DIR, 'functions', 'api'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'functions', 'api', '[[caminho]].js'), funcaoCloudflare());
  // Cloudflare Workers (static assets): o Worker só roda em /api/*; o resto sai direto de dist/ com _redirects e _headers
  fs.writeFileSync(path.join(DIR, 'worker.js'), funcaoCloudflare().replace('Cloudflare Pages Function', 'Cloudflare Worker')
    + `\nexport default { fetch: (request, env) => new URL(request.url).pathname.startsWith('/api/') ? onRequest({ request, env }) : env.ASSETS.fetch(request) };\n`);
  fs.writeFileSync(path.join(DIR, 'wrangler.jsonc'), `// Gerado por: node sites/build.mjs ${site} --configurar (Cloudflare Workers)
{
  "name": "${site === 'painel' ? 'meu-fiscal' : 'meufiscal-' + site}",
  "main": "worker.js",
  "compatibility_date": "2026-06-01",
  "build": { "command": "node ../build.mjs ${site}" },
  "assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": ["/api/*"], "not_found_handling": "none" },
  "observability": { "enabled": true }
}
`);
  console.log(`sites/${site}/vercel.json, netlify.toml e functions/ (Cloudflare) atualizados para ${API}`);
  process.exit(0);
}

// trava de segurança: a URL do proxy no vercel.json precisa ser a mesma da API configurada
const vj = path.join(DIR, 'vercel.json');
if (fs.existsSync(vj) && process.env.VERCEL) {
  const destino = (JSON.parse(fs.readFileSync(vj, 'utf8')).rewrites || []).find(r => r.source === '/api/:caminho*')?.destination || '';
  if (!destino.startsWith(API + '/')) { console.error(`vercel.json aponta o proxy para "${destino}", mas API_URL é "${API}". Rode: node sites/build.mjs ${site} --configurar`); process.exit(1); }
}

/* ---------- build ---------- */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
const cfg = `<script>window.MF=${JSON.stringify({ site, api: API })};</script>`;
const titulo = site === 'cliente' ? 'Portal do Cliente · Meu Fiscal' : 'Painel Contábil · Meu Fiscal';
const app = fs.readFileSync(path.join(APP, 'app.html'), 'utf8');
fs.writeFileSync(path.join(DIST, 'app.html'), `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0F172A">
${site === 'painel' ? '<meta name="robots" content="noindex,nofollow">\n' : ''}<title>${titulo}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
<link rel="manifest" href="/manifest.webmanifest">
${cfg}
<script src="/mf-api.js"></script>
</head>
<body>
${app}
</body>
</html>
`);
for (const p of ['login.html', ...(site === 'painel' ? ['acessos.html'] : [])])
  fs.writeFileSync(path.join(DIST, p), fs.readFileSync(path.join(APP, p), 'utf8').replace('<!--MF_CONFIG-->', cfg));
fs.copyFileSync(path.join(APP, 'mf-api.js'), path.join(DIST, 'mf-api.js'));
// marca: favicon, ícones de celular e logos (app/marca)
for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180.png', 'icon-192.png', 'icon-512.png', 'logo-horizontal.svg', 'logo-horizontal-negativa.svg'])
  fs.copyFileSync(path.join(APP, 'marca', f), path.join(DIST, f));
fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify({ name: titulo, short_name: 'Meu Fiscal', start_url: site === 'cliente' ? '/dashboard' : '/admin/dashboard', display: 'standalone', background_color: '#F8FAFC', theme_color: '#0F172A', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }, null, 2));
const MF_OG = '<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="7" transform="translate(32 32) scale(0.72) translate(-32 -31)"><path d="M13 48V32a6 6 0 0 1 12 0v16M25 32a6 6 0 0 1 12 0M37 48V22a8 8 0 0 1 8-8h6" stroke="#fff"/><path d="M37 30H50" stroke="#34D399"/></g>';
if (site === 'cliente') {
  // página comercial em "/" + termos/privacidade, montadas a partir de app/landing.config.json
  const SITE_URL = String(env.SITE_URL || 'https://meufiscal-cliente.vercel.app').replace(/\/$/, '');
  const PAINEL_URL = String(env.PAINEL_URL || 'https://meufiscal-painel.vercel.app').replace(/\/$/, '');
  const lc = JSON.parse(fs.readFileSync(path.join(APP, 'landing.config.json'), 'utf8'));
  fs.writeFileSync(path.join(DIST, 'index.html'), montarLanding(fs.readFileSync(path.join(APP, 'landing.html'), 'utf8'), lc, { siteUrl: SITE_URL, painelUrl: PAINEL_URL }));
  const data = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  fs.writeFileSync(path.join(DIST, 'legal.html'), montarLanding(fs.readFileSync(path.join(APP, 'legal.html'), 'utf8'), { ...lc, DATA: data }, { siteUrl: SITE_URL, painelUrl: PAINEL_URL }));
  fs.copyFileSync(path.join(APP, 'landing.css'), path.join(DIST, 'landing.css'));
  fs.writeFileSync(path.join(DIST, 'og.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#0F172A"/><g transform="translate(80 80) scale(1.5)"><rect x="1" y="1" width="62" height="62" rx="15" fill="#1E293B" stroke="#334155" stroke-width="2"/>${MF_OG}</g><text x="80" y="330" font-family="Arial,sans-serif" font-size="78" font-weight="700" fill="#fff">Meu Fiscal</text><text x="80" y="420" font-family="Arial,sans-serif" font-size="40" fill="#94A3B8">Contabilidade online para MEI e Simples Nacional</text><text x="80" y="520" font-family="Arial,sans-serif" font-size="32" fill="#34D399">Impostos calculados · NFS-e · IA 24h · Contador responsável</text></svg>`);
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_URL}/</loc></url><url><loc>${SITE_URL}/termos</loc></url><url><loc>${SITE_URL}/privacidade</loc></url></urlset>\n`);
}
fs.writeFileSync(path.join(DIST, 'robots.txt'), site === 'painel' ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nDisallow: /dashboard\nDisallow: /login\nDisallow: /api/\nSitemap: ${String(env.SITE_URL || 'https://meufiscal-cliente.vercel.app').replace(/\/$/, '')}/sitemap.xml\n`);
// Cloudflare Pages: cada rota vira um arquivo no próprio caminho (a Cloudflare serve /x a partir de x.html),
// mais _redirects e _headers equivalentes ao vercel.json
for (const [rota, arq] of ROTAS.paginas) {
  const destino = path.join(DIST, rota.replace(/^\//, '') + '.html');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(path.join(DIST, arq.replace(/^\//, '')), destino);
}
fs.writeFileSync(path.join(DIST, '_redirects'), ROTAS.redirects.map(([de, para]) => `${de.replace(':caminho*', '*')} ${para} 302`).join('\n') + '\n');
const semCache = ['/', ...ROTAS.paginas.map(([r]) => r)];
fs.writeFileSync(path.join(DIST, '_headers'), `/*\n${SEGURANCA.map(h => `  ${h.key}: ${h.value}`).join('\n')}\n\n` + semCache.map(r => `${r}\n  Cache-Control: no-cache\n`).join('\n'));
console.log(`Site "${site}" gerado em sites/${site}/dist (API: ${API})`);
