// Leitura e validação das variáveis de ambiente. A API não sobe com configuração insegura em produção.
import fs from 'node:fs';
import path from 'node:path';

// .env local opcional (em produção as variáveis vêm do painel do Render/Railway)
const arquivoEnv = path.resolve(process.cwd(), '.env');
if (fs.existsSync(arquivoEnv)) {
  for (const linha of fs.readFileSync(arquivoEnv, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const e = process.env;
const lista = v => String(v || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
export const PRODUCAO = e.NODE_ENV === 'production';

export const CONFIG = {
  porta: Number(e.PORT || 8080),
  banco: e.DATABASE_URL,
  bancoDireto: e.DATABASE_URL_DIRECT || e.DATABASE_URL,      // LISTEN precisa de conexão direta (sem pooler)
  poolMax: Number(e.PG_POOL || 5),
  segredo: { cliente: e.JWT_SECRET_CLIENTE, painel: e.JWT_SECRET_PAINEL },
  origens: { cliente: lista(e.ORIGENS_CLIENTE), painel: lista(e.ORIGENS_PAINEL) },
  urlApiPublica: (e.URL_PUBLICA_API || '').replace(/\/$/, ''),
  cookieSeguro: e.COOKIE_SEGURO ? e.COOKIE_SEGURO === '1' : PRODUCAO,
  arquivos: {
    driver: e.ARQUIVOS_DRIVER || (e.S3_BUCKET ? 's3' : 'disco'),
    pasta: e.ARQUIVOS_PASTA || path.resolve(process.cwd(), 'arquivos'),
    maxBytes: 20 * 1024 * 1024,
    s3: { endpoint: (e.S3_ENDPOINT || '').replace(/\/$/, ''), regiao: e.S3_REGIAO || 'auto', bucket: e.S3_BUCKET, chave: e.S3_ACCESS_KEY_ID, segredo: e.S3_SECRET_ACCESS_KEY },
  },
  email: { resend: e.RESEND_API_KEY, remetente: e.EMAIL_REMETENTE || 'Meu Fiscal <nao-responda@meufiscal.com.br>' },
  ia: { chave: e.ANTHROPIC_API_KEY, modelo: e.IA_MODELO || 'claude-sonnet-5-5' },
};

export const SITES = ['cliente', 'painel'];
export const COOKIE = { cliente: 'client_session', painel: 'admin_session' };
export const AMBIENTE_DO_SITE = { cliente: 'cliente', painel: 'equipe' };
export const DURACAO = {
  sessaoCliente: 12 * 3600, sessaoClienteLembrar: 30 * 86400, sessaoPainel: 10 * 3600,
  conviteHoras: 72, redefinicaoMinutos: 30, ticketTempoReal: 15 * 60,
};
// Regra definida pelo escritório: exatamente 8 letras ou números
export const SENHA_RE = /^[A-Za-z0-9]{8}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validarConfig() {
  const erros = [];
  if (!CONFIG.banco) erros.push('DATABASE_URL não definida.');
  for (const s of SITES) {
    if (!CONFIG.segredo[s] || CONFIG.segredo[s].length < 32) erros.push(`JWT_SECRET_${s.toUpperCase()} precisa ter 32+ caracteres.`);
    if (!CONFIG.origens[s].length) erros.push(`ORIGENS_${s.toUpperCase()} não definida (domínio do site ${s}).`);
  }
  if (CONFIG.segredo.cliente && CONFIG.segredo.cliente === CONFIG.segredo.painel) erros.push('Os dois segredos JWT precisam ser diferentes.');
  if (PRODUCAO) {
    if (!CONFIG.urlApiPublica.startsWith('https://')) erros.push('URL_PUBLICA_API precisa ser https:// em produção.');
    [...CONFIG.origens.cliente, ...CONFIG.origens.painel].forEach(o => { if (!o.startsWith('https://')) erros.push('Origem sem https: ' + o); });
    if (CONFIG.arquivos.driver === 'disco') erros.push('ARQUIVOS_DRIVER=disco não serve em produção (o disco do plano gratuito é apagado a cada deploy). Configure o S3/R2.');
  }
  if (CONFIG.arquivos.driver === 's3') {
    const s = CONFIG.arquivos.s3;
    if (!s.endpoint || !s.bucket || !s.chave || !s.segredo) erros.push('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY são obrigatórios com ARQUIVOS_DRIVER=s3.');
  }
  if (erros.length) { console.error('Configuração inválida:\n - ' + erros.join('\n - ')); process.exit(1); }
}
