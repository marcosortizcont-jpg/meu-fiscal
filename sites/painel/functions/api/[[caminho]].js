// Gerado por: node sites/build.mjs painel --configurar
// Cloudflare Pages Function: repassa /api/* para a API, mantendo o cookie de sessão no domínio do site.
// A variável API_URL (Settings → Variables) tem prioridade sobre o endereço abaixo.
const API_PADRAO = 'https://meufiscal-api.onrender.com';
export async function onRequest({ request, env }) {
  const api = String(env.API_URL || API_PADRAO).replace(/\/$/, '');
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
