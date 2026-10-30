// Gera um dos dois sites a partir do app compartilhado (../app).
//   node sites/build.mjs cliente               → sites/cliente/dist
//   node sites/build.mjs painel                → sites/painel/dist
//   node sites/build.mjs cliente --configurar  → regrava vercel.json e netlify.toml com a URL da API do .env.production
// Sem dependências: roda na Vercel, Netlify ou Cloudflare com Node 20+.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
for (const k of ['API_URL', 'ARQUIVOS_HOST']) if (process.env[k]) env[k] = process.env[k];
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
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(site === 'painel' ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] : []),
];
const ROTAS = site === 'cliente' ? {
  redirects: [
    ['/', '/dashboard'], ['/admin', '/login'], ['/admin/:caminho*', '/login'],     // o portal não tem área administrativa
    ['/cadastro', '/login?primeiro-acesso'],
  ],
  paginas: [['/login', '/login.html'], ['/definir-senha', '/login.html'], ['/dashboard', '/app.html']],
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
      { source: '/(app|login|acessos).html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
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

if (configurar) {
  fs.writeFileSync(path.join(DIR, 'vercel.json'), JSON.stringify(vercelJson(), null, 2) + '\n');
  fs.writeFileSync(path.join(DIR, 'netlify.toml'), netlifyToml());
  console.log(`sites/${site}/vercel.json e netlify.toml atualizados para ${API}`);
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
fs.writeFileSync(path.join(DIST, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#059669"/><text x="32" y="41" font-family="Arial,sans-serif" font-size="26" font-weight="700" text-anchor="middle" fill="#fff">MF</text></svg>`);
fs.writeFileSync(path.join(DIST, 'robots.txt'), site === 'painel' ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow: /dashboard\nDisallow: /api/\n');
console.log(`Site "${site}" gerado em sites/${site}/dist (API: ${API})`);
