// Primitivas de segurança com o módulo nativo crypto: JWT HS256, hash de senha (scrypt), tokens e limite de tentativas.
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const aleatorio = (n = 32) => crypto.randomBytes(n).toString('base64url');

/* ---------- JWT HS256 ---------- */
export function assinarJwt(payload, segredo, segundos) {
  const agora = Math.floor(Date.now() / 1000);
  const corpo = { ...payload, iat: agora, exp: agora + segundos };
  const base = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(corpo));
  return base + '.' + crypto.createHmac('sha256', segredo).update(base).digest('base64url');
}
export function verificarJwt(token, segredo, audiencia) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.'); if (partes.length !== 3) return null;
  const esperado = crypto.createHmac('sha256', segredo).update(partes[0] + '.' + partes[1]).digest();
  const recebido = Buffer.from(partes[2], 'base64url');
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return null;
  try {
    const cab = JSON.parse(Buffer.from(partes[0], 'base64url'));
    if (cab.alg !== 'HS256') return null;
    const p = JSON.parse(Buffer.from(partes[1], 'base64url'));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    if (audiencia && p.aud !== audiencia) return null;
    return p;
  } catch { return null; }
}

/* ---------- senha: scrypt (parâmetros OWASP: N=2^17, r=8, p=1) ---------- */
const N = 2 ** 17, R = 8, P = 1, TAM = 32, MAXMEM = 256 * 1024 * 1024;
let emUso = 0; const espera = [];
async function vaga(fn) {           // no máximo 2 hashes simultâneos (128 MB cada) para caber no plano gratuito
  if (emUso >= 2) await new Promise(ok => espera.push(ok));
  emUso++;
  try { return await fn(); } finally { emUso--; espera.shift()?.(); }
}
const scrypt = (senha, sal, n) => new Promise((ok, falha) => crypto.scrypt(senha, sal, TAM, { N: n, r: R, p: P, maxmem: MAXMEM }, (e, k) => e ? falha(e) : ok(k)));

export async function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const k = await vaga(() => scrypt(senha, sal, N));
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${k.toString('base64')}`;
}
export async function conferirSenha(senha, hash) {
  if (!hash) { await vaga(() => scrypt(senha, 'sal-ficticio-para-tempo-constante', N)); return false; }
  const [alg, n, , , sal, k] = hash.split('$');
  if (alg !== 'scrypt') return false;
  const calc = await vaga(() => scrypt(senha, Buffer.from(sal, 'base64'), Number(n)));
  const ref = Buffer.from(k, 'base64');
  return calc.length === ref.length && crypto.timingSafeEqual(calc, ref);
}
// hash fictício para igualar o tempo de resposta quando o e-mail não existe
export const HASH_FICTICIO = null;

/* ---------- limite de tentativas (memória; a API roda em uma instância no plano gratuito) ---------- */
const baldes = new Map();
export function limitar(chave, max, janelaSeg) {
  const agora = Date.now(); let b = baldes.get(chave);
  if (!b || b.ate < agora) { b = { n: 0, ate: agora + janelaSeg * 1000 }; baldes.set(chave, b); }
  b.n++;
  return { bloqueado: b.n > max, restam: Math.ceil((b.ate - agora) / 1000) };
}
setInterval(() => { const a = Date.now(); for (const [k, b] of baldes) if (b.ate < a) baldes.delete(k); }, 60000).unref();
