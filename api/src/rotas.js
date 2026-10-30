// Rotas da API. Os dois sites chamam /api/* pelo próprio domínio (proxy da Vercel/Netlify),
// então o cookie de sessão é sempre do domínio do site e nunca de terceiros.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG, SITES, COOKIE, AMBIENTE_DO_SITE, DURACAO, SENHA_RE, EMAIL_RE } from './config.js';
import { ErroHttp, definirCookie, enviar, lerCorpoBruto, siteDaOrigem } from './http.js';
import { assinarJwt, verificarJwt, hashSenha, conferirSenha, sha256, aleatorio, limitar } from './seguranca.js';
import { COLECOES, empresaDe, filtroLeitura, podeLer, visivelAoCliente, prepararLeitura, conferirEscrita, carimbar } from './regras.js';
import { urlEnvio, urlDownload, caminhoDisco, gravarDisco } from './arquivos.js';
import { enviarEmail, emailLink, perguntarIA } from './externos.js';

const AUD = site => `meufiscal:${site}`;
export const ROTA_SENHA = { cliente: '/definir-senha', painel: '/admin/definir-senha' };
const AUD_TR = 'meufiscal:tempo-real';
const MSG_CLIENTE_NO_PAINEL = 'Este ambiente é exclusivo da equipe interna da contabilidade. Clientes entram pelo Portal do Cliente.';
const MSG_EQUIPE_NO_PORTAL = 'Esta conta é da equipe do escritório. Entre pelo Painel Contábil.';
const TIPOS_ARQUIVO = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'text/xml': 'xml', 'application/xml': 'xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/octet-stream': 'bin' };

export function registrarRotas(r, { db, hub }) {
  /* ================= sessões ================= */
  const cache = new Map(); // sid → { u, ate } (10 s) para não ir ao banco em toda requisição
  setInterval(() => { const a = Date.now(); for (const [k, v] of cache) if (v.ate < a) cache.delete(k); }, 30000).unref();

  async function carregarEmpresas(usuarioId) {
    const linhas = await db.query('SELECT empresa_id AS id, perfil FROM usuarios_empresas WHERE usuario_id = $1', [usuarioId]);
    return linhas.map(l => ({ id: l.id, perfil: l.perfil }));
  }

  async function usuarioDaSessao(site, sid) {
    const chave = sha256(sid);
    const c = cache.get(chave); if (c && c.ate > Date.now()) return c.u;
    const [u] = await db.query(`SELECT u.id, u.escritorio_id, u.nome, u.email, u.ambiente, u.papel, s.id AS sessao_id
      FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.id = $1 AND s.site = $2 AND s.revogada_em IS NULL AND s.expira_em > now() AND u.status = 'ativo' AND u.ambiente = $3`,
      [chave, site, AMBIENTE_DO_SITE[site]]);
    if (!u) return null;
    u.site = site;
    u.empresas = u.ambiente === 'cliente' ? await carregarEmpresas(u.id) : [];
    cache.set(chave, { u, ate: Date.now() + 10000 });
    return u;
  }

  // Descobre o site pela requisição: cabeçalho X-MF-Site (fetch) ou, em links de download, pelo cookie presente
  function siteDe(ctx) {
    const h = ctx.req.headers['x-mf-site'];
    if (SITES.includes(h)) return h;
    if (ctx.cookies[COOKIE.painel]) return 'painel';
    if (ctx.cookies[COOKIE.cliente]) return 'cliente';
    return null;
  }

  async function exigir(ctx, { site: exigido, papeis } = {}) {
    const site = siteDe(ctx);
    if (!site || (exigido && site !== exigido)) throw new ErroHttp(401, 'Faça login para continuar.');
    // a origem informada pelo navegador precisa ser do mesmo site (impede o domínio do cliente de falar como painel)
    if (ctx.origem && siteDaOrigem(ctx.origem) && siteDaOrigem(ctx.origem) !== site) throw new ErroHttp(403, 'Origem não autorizada para este ambiente.');
    const p = verificarJwt(ctx.cookies[COOKIE[site]], CONFIG.segredo[site], AUD(site));
    const u = p && await usuarioDaSessao(site, p.sid);
    if (!u) throw new ErroHttp(401, 'Sua sessão terminou. Entre novamente.');
    if (papeis && !papeis.includes(u.papel)) throw new ErroHttp(403, 'Seu nível de acesso não permite esta ação.');
    return u;
  }

  async function log(acao, { usuarioId = null, email = null, ip = null, detalhe = null } = {}) {
    await db.query('INSERT INTO acessos_log (acao, usuario_id, email, ip, detalhe) VALUES ($1,$2,$3,$4,$5)', [acao, usuarioId, email, ip, detalhe]).catch(() => { });
  }

  function siteDoParametro(ctx) {
    const s = ctx.params.site;
    if (!SITES.includes(s)) throw new ErroHttp(404, 'Ambiente desconhecido.');
    if (ctx.req.method !== 'GET' && ctx.req.headers['x-mf-site'] !== s) throw new ErroHttp(400, 'Ambiente não confere.');
    if (ctx.origem && siteDaOrigem(ctx.origem) !== s) throw new ErroHttp(403, 'Origem não autorizada para este ambiente.');
    return s;
  }

  /* ================= autenticação ================= */
  r.get('/api/saude', async () => {
    const [x] = await db.query('SELECT 1 AS ok');
    return { ok: x.ok === 1, tempoReal: hub.total(), em: new Date().toISOString() };
  });

  r.post('/api/:site/entrar', async ctx => {
    const site = siteDoParametro(ctx);
    const email = String(ctx.corpo.email || '').trim().toLowerCase();
    const senha = String(ctx.corpo.senha || '');
    if (!EMAIL_RE.test(email) || !senha) throw new ErroHttp(400, 'Informe e-mail e senha.');
    const lim1 = limitar(`entrar:${site}:${email}`, 5, 900), lim2 = limitar(`entrar-ip:${ctx.ip}`, site === 'painel' ? 20 : 30, 900);
    if (lim1.bloqueado || lim2.bloqueado) throw new ErroHttp(429, `Muitas tentativas. Tente de novo em ${Math.ceil(Math.max(lim1.restam, lim2.restam) / 60)} min.`);

    const [u] = await db.query('SELECT id, nome, email, ambiente, status, senha_hash FROM usuarios WHERE lower(email) = $1', [email]);
    const ok = await conferirSenha(senha, u?.senha_hash);
    if (!u || !ok) { await log(`entrar_falha_${site}`, { email, ip: ctx.ip }); throw new ErroHttp(401, 'E-mail ou senha incorretos.'); }
    // só depois da senha certa revelamos o tipo de conta
    if (u.ambiente !== AMBIENTE_DO_SITE[site]) {
      await log(site === 'painel' ? 'cliente_tentou_painel' : 'equipe_tentou_portal', { usuarioId: u.id, email, ip: ctx.ip });
      throw new ErroHttp(403, site === 'painel' ? MSG_CLIENTE_NO_PAINEL : MSG_EQUIPE_NO_PORTAL, { codigo: 'ambiente_errado' });
    }
    if (u.status !== 'ativo') throw new ErroHttp(403, u.status === 'convidado' ? 'Conclua o cadastro pelo link enviado no seu e-mail.' : 'Acesso bloqueado. Fale com o escritório.');

    const lembrar = site === 'cliente' && !!ctx.corpo.lembrar;
    const dur = site === 'painel' ? DURACAO.sessaoPainel : (lembrar ? DURACAO.sessaoClienteLembrar : DURACAO.sessaoCliente);
    const sid = aleatorio(32);
    await db.query(`INSERT INTO sessoes (id, usuario_id, site, expira_em, ip, user_agent) VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6)`,
      [sha256(sid), u.id, site, dur, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300)]);
    await db.query('UPDATE usuarios SET ultimo_login_em = now() WHERE id = $1', [u.id]);
    definirCookie(ctx.res, COOKIE[site], assinarJwt({ sid, aud: AUD(site) }, CONFIG.segredo[site], dur),
      { maxAge: (site === 'cliente' && !lembrar) ? undefined : dur, sameSite: site === 'painel' ? 'Strict' : 'Lax' });
    await log(`entrar_${site}`, { usuarioId: u.id, email, ip: ctx.ip });
    return { ok: true, nome: u.nome };
  });

  r.post('/api/sair', async ctx => {
    const site = siteDe(ctx);
    if (site) {
      const p = verificarJwt(ctx.cookies[COOKIE[site]], CONFIG.segredo[site], AUD(site));
      if (p) { const id = sha256(p.sid); await db.query('UPDATE sessoes SET revogada_em = now() WHERE id = $1', [id]); cache.delete(id); hub.encerrarSessao(id); }
      definirCookie(ctx.res, COOKIE[site], '', { maxAge: 0, sameSite: site === 'painel' ? 'Strict' : 'Lax' });
    }
    return { ok: true };
  });

  r.get('/api/eu', async ctx => {
    const u = await exigir(ctx);
    const [esc] = await db.query('SELECT id, nome FROM escritorios WHERE id = $1', [u.escritorio_id]);
    return {
      usuario: { id: u.id, nome: u.nome, email: u.email, ambiente: u.ambiente, papel: u.papel },
      site: u.site, escritorio: esc, empresas: u.empresas,
      recursos: { ia: !!CONFIG.ia.chave, arquivos: CONFIG.arquivos.driver },
    };
  });

  r.post('/api/:site/esqueci', async ctx => {
    const site = siteDoParametro(ctx);
    const email = String(ctx.corpo.email || '').trim().toLowerCase();
    const resposta = { ok: true }; // sempre igual: não revela se o e-mail existe
    if (!EMAIL_RE.test(email)) return resposta;
    if (limitar(`esqueci:${email}`, 3, 3600).bloqueado || limitar(`esqueci-ip:${ctx.ip}`, 20, 3600).bloqueado) return resposta;
    const [u] = await db.query(`SELECT id, nome, email FROM usuarios WHERE lower(email) = $1 AND ambiente = $2 AND status = 'ativo'`, [email, AMBIENTE_DO_SITE[site]]);
    if (u) {
      const token = aleatorio(32);
      await db.tx(async q => {
        await q(`UPDATE tokens SET usado_em = now() WHERE usuario_id = $1 AND tipo = 'redefinicao' AND usado_em IS NULL`, [u.id]);
        await q(`INSERT INTO tokens (hash, usuario_id, tipo, expira_em) VALUES ($1,$2,'redefinicao', now() + make_interval(mins => $3))`, [sha256(token), u.id, DURACAO.redefinicaoMinutos]);
      });
      const link = `${CONFIG.origens[site][0]}${ROTA_SENHA[site]}?token=${token}`;
      const m = emailLink({ nome: u.nome.split(' ')[0], titulo: 'Redefinição de senha · Meu Fiscal', texto: 'Recebemos um pedido para redefinir a sua senha. O link vale por 30 minutos e só pode ser usado uma vez.', rotulo: 'Criar nova senha', link, rodape: 'Se não foi você, ignore este e-mail: sua senha atual continua valendo.' });
      await enviarEmail({ para: u.email, assunto: m.assunto, html: m.html, texto: m.texto });
      await log(`senha_pedido_${site}`, { usuarioId: u.id, email, ip: ctx.ip });
    }
    return resposta;
  });

  async function tokenValido(site, token) {
    const [t] = await db.query(`SELECT t.hash, t.tipo, u.id AS usuario_id, u.nome, u.email, EXTRACT(EPOCH FROM (t.expira_em - now()))::int AS segundos
      FROM tokens t JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.hash = $1 AND t.usado_em IS NULL AND t.expira_em > now() AND u.ambiente = $2 AND u.status <> 'bloqueado'`, [sha256(String(token || '')), AMBIENTE_DO_SITE[site]]);
    return t || null;
  }

  r.get('/api/:site/token', async ctx => {
    const site = siteDoParametro(ctx);
    if (limitar(`token-ip:${ctx.ip}`, 30, 900).bloqueado) throw new ErroHttp(429, 'Muitas tentativas.');
    const t = await tokenValido(site, ctx.query.token);
    if (!t) throw new ErroHttp(410, 'Este link expirou ou já foi usado. Peça um novo.');
    return { tipo: t.tipo, nome: t.nome, email: t.email, segundos: t.segundos };
  });

  r.post('/api/:site/definir-senha', async ctx => {
    const site = siteDoParametro(ctx);
    const senha = String(ctx.corpo.senha || '');
    if (!SENHA_RE.test(senha)) throw new ErroHttp(400, 'A senha precisa ter exatamente 8 letras ou números.');
    if (limitar(`definir-ip:${ctx.ip}`, 10, 900).bloqueado) throw new ErroHttp(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const hash = await hashSenha(senha);
    const t = await db.tx(async q => {
      const [t] = await q(`UPDATE tokens t SET usado_em = now() FROM usuarios u
        WHERE t.usuario_id = u.id AND t.hash = $1 AND t.usado_em IS NULL AND t.expira_em > now() AND u.ambiente = $2 AND u.status <> 'bloqueado'
        RETURNING t.usuario_id, t.tipo`, [sha256(String(ctx.corpo.token || '')), AMBIENTE_DO_SITE[site]]);
      if (!t) return null;
      await q(`UPDATE usuarios SET senha_hash = $1, status = 'ativo' WHERE id = $2`, [hash, t.usuario_id]);
      await q('UPDATE sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL', [t.usuario_id]);
      return t;
    });
    if (!t) throw new ErroHttp(410, 'Este link expirou ou já foi usado. Peça um novo.');
    hub.encerrarUsuario(t.usuario_id);
    await log(t.tipo === 'convite' ? `convite_aceito_${site}` : `senha_redefinida_${site}`, { usuarioId: t.usuario_id, ip: ctx.ip });
    return { ok: true };
  });

  /* ================= dados ================= */
  async function mapaAcessos(escritorioId) {
    const linhas = await db.query(`SELECT ue.empresa_id, ue.usuario_id AS uid, ue.perfil, u.nome, u.email, u.status
      FROM usuarios_empresas ue JOIN usuarios u ON u.id = ue.usuario_id WHERE u.escritorio_id = $1`, [escritorioId]);
    const m = new Map();
    for (const l of linhas) { if (!m.has(l.empresa_id)) m.set(l.empresa_id, []); m.get(l.empresa_id).push({ uid: l.uid, perfil: l.perfil, nome: l.nome, email: l.email, status: l.status }); }
    return m;
  }

  r.get('/api/dados', async ctx => {
    const u = await exigir(ctx);
    const [filtro, extra] = filtroLeitura(u, 2);
    const linhas = await db.query(`SELECT colecao, dados FROM registros WHERE escritorio_id = $1 AND colecao <> 'auditoria'${filtro} ORDER BY atualizado_em`, [u.escritorio_id, ...extra]);
    const acessos = await mapaAcessos(u.escritorio_id);
    const colecoes = Object.fromEntries(COLECOES.map(c => [c, []]));
    for (const l of linhas) if (colecoes[l.colecao]) colecoes[l.colecao].push(prepararLeitura(u, l.colecao, l.dados, acessos));
    if (u.ambiente === 'equipe') {
      const aud = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'auditoria' ORDER BY atualizado_em DESC LIMIT 400`, [u.escritorio_id]);
      colecoes.auditoria = aud.map(a => a.dados);
    }
    return { colecoes, em: new Date().toISOString() };
  });

  r.post('/api/dados/buscar', async ctx => {
    const u = await exigir(ctx);
    const itens = Array.isArray(ctx.corpo.itens) ? ctx.corpo.itens.slice(0, 200) : [];
    const acessos = itens.some(i => i.c === 'empresas') ? await mapaAcessos(u.escritorio_id) : null;
    const out = [];
    for (const { c, id } of itens) {
      if (!COLECOES.includes(c)) continue;
      const [l] = await db.query('SELECT empresa_id, dados FROM registros WHERE escritorio_id = $1 AND colecao = $2 AND id = $3', [u.escritorio_id, c, String(id)]);
      out.push({ c, id, dados: l && podeLer(u, c, l.empresa_id) && (u.ambiente === 'equipe' || visivelAoCliente(c, l.dados)) ? prepararLeitura(u, c, l.dados, acessos) : null });
    }
    return { itens: out };
  });

  r.post('/api/dados/lote', async ctx => {
    const u = await exigir(ctx);
    const ops = Array.isArray(ctx.corpo.ops) ? ctx.corpo.ops : [];
    if (!ops.length) return { ok: true, aplicadas: 0 };
    if (ops.length > 500) throw new ErroHttp(413, 'Muitas alterações de uma vez.');
    if (limitar(`lote:${u.id}`, 600, 600).bloqueado) throw new ErroHttp(429, 'Muitas gravações seguidas. Aguarde um instante.');
    let aplicadas = 0;
    await db.tx(async q => {
      for (let i = 0; i < ops.length; i++) {
        const op = { ...ops[i], id: String(ops[i].id ?? '') };
        if (!op.id || op.id.length > 120) throw new ErroHttp(400, 'Registro sem identificador.');
        if (op.op === 'salvar') {
          op.dados = carimbar(u, op.c, op.dados || {});
          if (JSON.stringify(op.dados).length > 512 * 1024) throw new ErroHttp(413, 'Registro grande demais.');
        } else if (op.op !== 'apagar') throw new ErroHttp(400, 'Operação inválida.');
        const [atual] = await q('SELECT empresa_id, dados FROM registros WHERE escritorio_id = $1 AND colecao = $2 AND id = $3 FOR UPDATE', [u.escritorio_id, op.c, op.id]);
        try { conferirEscrita(u, op, atual || null); }
        catch (e) { throw new ErroHttp(403, e.message, { indice: i, colecao: op.c }); }

        // valor da renovação do certificado vem da configuração do escritório, não do navegador
        if (u.ambiente === 'cliente' && op.op === 'salvar' && !atual && op.c === 'tickets' && op.dados.renovacao) {
          const [cfg] = await q(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'config' LIMIT 1`, [u.escritorio_id]);
          const esperado = Number(cfg?.dados?.valorRenovacaoCert || 180);
          if (Number(op.dados.renovacao.valor) !== esperado || Number(op.dados.valor) !== esperado) throw new ErroHttp(403, 'Valor da renovação não confere com o do escritório.');
        }

        if (op.op === 'apagar') {
          const res = await q('DELETE FROM registros WHERE escritorio_id = $1 AND colecao = $2 AND id = $3', [u.escritorio_id, op.c, op.id]);
          aplicadas += res.count;
        } else {
          const res = await q(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados, atualizado_por) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
            ON CONFLICT (escritorio_id, colecao, id) DO UPDATE SET dados = EXCLUDED.dados, empresa_id = EXCLUDED.empresa_id,
              versao = registros.versao + 1, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por
            WHERE registros.dados IS DISTINCT FROM EXCLUDED.dados`,
          [u.escritorio_id, op.c, op.id, empresaDe(op.c, op.dados), JSON.stringify(op.dados), u.id]);
          aplicadas += res.count;
        }
      }
    });
    return { ok: true, aplicadas };
  }, { limite: 8 * 1024 * 1024 });

  r.get('/api/usuarios/nomes', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const ids = String(ctx.query.ids || '').split(',').filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
    if (!ids.length) return { nomes: {} };
    const linhas = await db.query('SELECT id, nome FROM usuarios WHERE escritorio_id = $1 AND id = ANY($2::uuid[])', [u.escritorio_id, ids]);
    return { nomes: Object.fromEntries(linhas.map(l => [l.id, l.nome])) };
  });

  /* ================= tempo real ================= */
  // O fluxo SSE vai direto ao domínio da API (proxies de hospedagem gratuita cortam conexões longas).
  // Como esse domínio é de terceiros para o navegador, a autorização usa um ticket curto obtido pelo proxy.
  r.get('/api/tempo-real/ticket', async ctx => {
    const u = await exigir(ctx);
    const p = verificarJwt(ctx.cookies[COOKIE[u.site]], CONFIG.segredo[u.site], AUD(u.site));
    const t = assinarJwt({ sid: p.sid, site: u.site, aud: AUD_TR }, CONFIG.segredo[u.site], DURACAO.ticketTempoReal);
    return { url: `${CONFIG.urlApiPublica || ''}/tempo-real`, site: u.site, ticket: t };
  });

  r.get('/tempo-real', async ctx => {
    const site = ctx.query.site;
    if (!SITES.includes(site)) throw new ErroHttp(400, 'Ambiente inválido.');
    if (ctx.origem && siteDaOrigem(ctx.origem) !== site) throw new ErroHttp(403, 'Origem não autorizada.');
    const p = verificarJwt(ctx.query.t, CONFIG.segredo[site], AUD_TR);
    const u = p && p.site === site && await usuarioDaSessao(site, p.sid);
    if (!u) throw new ErroHttp(401, 'Ticket expirado.');
    hub.conectar(ctx.req, ctx.res, { ...u, empresas: [...u.empresas] }, sha256(p.sid));
  });

  /* ================= arquivos ================= */
  r.post('/api/arquivos', async ctx => {
    const u = await exigir(ctx);
    const tipo = String(ctx.corpo.tipo || 'application/octet-stream').toLowerCase().split(';')[0];
    const tamanho = Number(ctx.corpo.tamanho);
    const empresaId = ctx.corpo.empresaId != null ? String(ctx.corpo.empresaId) : null;
    if (!TIPOS_ARQUIVO[tipo]) throw new ErroHttp(415, 'Tipo de arquivo não aceito.');
    if (!Number.isInteger(tamanho) || tamanho <= 0 || tamanho > CONFIG.arquivos.maxBytes) throw new ErroHttp(413, 'O arquivo precisa ter até 20 MB.');
    if (u.ambiente === 'cliente' && !u.empresas.some(e => e.id === empresaId)) throw new ErroHttp(403, 'Você não tem acesso a esta empresa.');
    if (limitar(`arq:${u.id}`, 200, 3600).bloqueado) throw new ErroHttp(429, 'Limite de envios por hora atingido.');
    const id = crypto.randomUUID();
    const chave = `${u.escritorio_id}/${empresaId || 'escritorio'}/${id}.${TIPOS_ARQUIVO[tipo]}`;
    await db.query('INSERT INTO arquivos (id, escritorio_id, empresa_id, chave, tipo, tamanho, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, u.escritorio_id, empresaId, chave, tipo, tamanho, u.id]);
    return { id, url: `/api/arquivos/${id}`, envio: urlEnvio({ id, chave, tipo, tamanho }) };
  });

  async function arquivoPermitido(u, id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ErroHttp(404, 'Arquivo não encontrado.');
    const [a] = await db.query('SELECT id, empresa_id, chave, tipo, tamanho, criado_por FROM arquivos WHERE id = $1 AND escritorio_id = $2', [id, u.escritorio_id]);
    if (!a) throw new ErroHttp(404, 'Arquivo não encontrado.');
    if (u.ambiente === 'cliente' && !u.empresas.some(e => e.id === a.empresa_id) && a.criado_por !== u.id) {
      // arquivo anexado pelo escritório a um registro desta empresa (ex.: PDF da guia, boleto da fatura)
      const [ref] = await db.query(`SELECT 1 AS ok FROM registros WHERE escritorio_id = $1 AND empresa_id = ANY($2::text[]) AND dados::text LIKE $3
        AND NOT (colecao = 'guias' AND dados->>'status' = 'rascunho') LIMIT 1`, [u.escritorio_id, u.empresas.map(e => e.id), '%' + a.id + '%']);
      if (!ref) throw new ErroHttp(404, 'Arquivo não encontrado.');
    }
    return a;
  }

  r.put('/api/arquivos/:id/conteudo', async ctx => {
    if (CONFIG.arquivos.driver !== 'disco') throw new ErroHttp(404, 'Rota não disponível.');
    const u = await exigir(ctx);
    const a = await arquivoPermitido(u, ctx.params.id);
    if (a.criado_por !== u.id) throw new ErroHttp(403, 'Envio não autorizado.');
    const corpo = await lerCorpoBruto(ctx.req, CONFIG.arquivos.maxBytes);
    if (corpo.length !== a.tamanho) throw new ErroHttp(400, 'Tamanho do arquivo não confere.');
    await gravarDisco(a, corpo);
    return { ok: true };
  }, { corpo: 'bruto' });

  r.get('/api/arquivos/:id', async ctx => {
    const u = await exigir(ctx);
    const a = await arquivoPermitido(u, ctx.params.id);
    if (CONFIG.arquivos.driver === 's3') { ctx.res.writeHead(302, { Location: urlDownload(a) }).end(); return; }
    const caminho = caminhoDisco(a);
    if (!fs.existsSync(caminho)) throw new ErroHttp(404, 'Arquivo ainda não enviado.');
    ctx.res.writeHead(200, { 'Content-Type': a.tipo, 'Content-Length': a.tamanho, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    fs.createReadStream(caminho).pipe(ctx.res);
  });

  /* ================= IA (opcional) ================= */
  r.post('/api/ia', async ctx => {
    const u = await exigir(ctx);
    if (limitar(`ia:${u.id}`, 40, 3600).bloqueado) throw new ErroHttp(429, 'Limite de perguntas por hora atingido.');
    try { return { texto: await perguntarIA({ mensagens: ctx.corpo.mensagens, imagens: ctx.corpo.imagens || [] }) }; }
    catch (e) { throw new ErroHttp(e.status || 502, e.message); }
  }, { limite: 12 * 1024 * 1024 });

  /* ================= gestão de acessos (painel) ================= */
  r.get('/api/admin/usuarios', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const usuarios = await db.query(`SELECT u.id, u.nome, u.email, u.ambiente, u.papel, u.status, u.ultimo_login_em,
        COALESCE((SELECT json_agg(json_build_object('id', ue.empresa_id, 'perfil', ue.perfil)) FROM usuarios_empresas ue WHERE ue.usuario_id = u.id), '[]'::json) AS empresas
      FROM usuarios u WHERE u.escritorio_id = $1 ORDER BY u.ambiente DESC, u.nome`, [u.escritorio_id]);
    const empresas = await db.query(`SELECT id, dados->>'razao' AS razao, dados->>'fantasia' AS fantasia, dados->>'cnpj' AS cnpj FROM registros
      WHERE escritorio_id = $1 AND colecao = 'empresas' ORDER BY dados->>'razao'`, [u.escritorio_id]);
    return { eu: { id: u.id, papel: u.papel }, usuarios, empresas };
  });

  async function enviarConvite(q, usuario, site, criadoPor) {
    const token = aleatorio(32);
    await q(`UPDATE tokens SET usado_em = now() WHERE usuario_id = $1 AND tipo = 'convite' AND usado_em IS NULL`, [usuario.id]);
    await q(`INSERT INTO tokens (hash, usuario_id, tipo, expira_em) VALUES ($1,$2,'convite', now() + make_interval(hours => $3))`, [sha256(token), usuario.id, DURACAO.conviteHoras]);
    const link = `${CONFIG.origens[site][0]}${ROTA_SENHA[site]}?token=${token}`;
    const m = emailLink({ nome: usuario.nome.split(' ')[0], titulo: site === 'painel' ? 'Seu acesso ao Painel Contábil' : 'Seu acesso ao Portal do Cliente · Meu Fiscal',
      texto: `${criadoPor} liberou o seu acesso ao ${site === 'painel' ? 'Painel Contábil do escritório' : 'Portal do Cliente do Meu Fiscal'}. Crie a sua senha pelo botão abaixo. O link vale por 72 horas.`,
      rotulo: 'Criar minha senha', link, rodape: 'Se você não esperava este convite, ignore este e-mail.' });
    const r = await enviarEmail({ para: usuario.email, assunto: m.assunto, html: m.html, texto: m.texto });
    return { link, emailEnviado: r.enviado };
  }

  function validarEmpresas(lista) {
    if (!Array.isArray(lista)) return [];
    return lista.filter(e => e && e.id).map(e => ({ id: String(e.id), perfil: ['Sócio', 'Financeiro', 'RH'].includes(e.perfil) ? e.perfil : 'Sócio' }));
  }

  r.post('/api/admin/usuarios', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const c = ctx.corpo;
    const ambiente = c.ambiente === 'equipe' ? 'equipe' : 'cliente';
    if (ambiente === 'equipe' && u.papel !== 'master') throw new ErroHttp(403, 'Só o administrador master cadastra colaboradores.');
    if (ambiente === 'cliente' && !['master', 'gestor'].includes(u.papel)) throw new ErroHttp(403, 'Só master e gestores liberam acesso de clientes.');
    const nome = String(c.nome || '').trim(), email = String(c.email || '').trim().toLowerCase();
    if (nome.length < 3) throw new ErroHttp(400, 'Informe o nome completo.');
    if (!EMAIL_RE.test(email)) throw new ErroHttp(400, 'E-mail inválido.');
    const papel = ambiente === 'equipe' ? (['master', 'gestor', 'analista'].includes(c.papel) ? c.papel : 'analista') : null;
    const empresas = ambiente === 'cliente' ? validarEmpresas(c.empresas) : [];
    if (ambiente === 'cliente' && !empresas.length) throw new ErroHttp(400, 'Escolha ao menos uma empresa.');
    const resultado = await db.tx(async q => {
      const [existe] = await q('SELECT id, ambiente FROM usuarios WHERE lower(email) = $1', [email]);
      if (existe) throw new ErroHttp(409, existe.ambiente === ambiente ? 'Este e-mail já tem acesso. Use "Editar" para liberar mais empresas.' : 'Este e-mail já é usado por uma conta do outro ambiente.');
      const [novo] = await q(`INSERT INTO usuarios (escritorio_id, nome, email, ambiente, papel, status) VALUES ($1,$2,$3,$4,$5,'convidado') RETURNING id, nome, email`, [u.escritorio_id, nome, email, ambiente, papel]);
      for (const e of empresas) await q('INSERT INTO usuarios_empresas (usuario_id, empresa_id, perfil) VALUES ($1,$2,$3)', [novo.id, e.id, e.perfil]);
      return { usuario: novo, ...(await enviarConvite(q, novo, ambiente === 'equipe' ? 'painel' : 'cliente', u.nome)) };
    });
    await log('usuario_convidado', { usuarioId: resultado.usuario.id, email, ip: ctx.ip, detalhe: `por ${u.email}` });
    return resultado;
  });

  r.patch('/api/admin/usuarios/:id', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const [alvo] = await db.query('SELECT id, ambiente, papel FROM usuarios WHERE id = $1 AND escritorio_id = $2', [ctx.params.id, u.escritorio_id]);
    if (!alvo) throw new ErroHttp(404, 'Usuário não encontrado.');
    if (alvo.ambiente === 'equipe' && u.papel !== 'master') throw new ErroHttp(403, 'Só o administrador master altera a equipe.');
    if (alvo.ambiente === 'cliente' && !['master', 'gestor'].includes(u.papel)) throw new ErroHttp(403, 'Sem permissão.');
    if (alvo.id === u.id && ctx.corpo.status === 'bloqueado') throw new ErroHttp(400, 'Você não pode bloquear a própria conta.');
    await db.tx(async q => {
      if (['ativo', 'bloqueado'].includes(ctx.corpo.status)) {
        await q(`UPDATE usuarios SET status = $1 WHERE id = $2 AND (status <> 'convidado' OR $1 = 'bloqueado')`, [ctx.corpo.status, alvo.id]);
        if (ctx.corpo.status === 'bloqueado') await q('UPDATE sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL', [alvo.id]);
      }
      if (alvo.ambiente === 'equipe' && ['master', 'gestor', 'analista'].includes(ctx.corpo.papel) && alvo.id !== u.id) await q('UPDATE usuarios SET papel = $1 WHERE id = $2', [ctx.corpo.papel, alvo.id]);
      if (alvo.ambiente === 'cliente' && Array.isArray(ctx.corpo.empresas)) {
        await q('DELETE FROM usuarios_empresas WHERE usuario_id = $1', [alvo.id]);
        for (const e of validarEmpresas(ctx.corpo.empresas)) await q('INSERT INTO usuarios_empresas (usuario_id, empresa_id, perfil) VALUES ($1,$2,$3)', [alvo.id, e.id, e.perfil]);
      }
    });
    for (const [k, v] of cache) if (v.u.id === alvo.id) cache.delete(k);
    if (ctx.corpo.status === 'bloqueado') hub.encerrarUsuario(alvo.id);
    await log('usuario_alterado', { usuarioId: alvo.id, ip: ctx.ip, detalhe: `por ${u.email}: ${JSON.stringify(ctx.corpo).slice(0, 300)}` });
    return { ok: true };
  });

  r.post('/api/admin/usuarios/:id/convite', async ctx => {
    const u = await exigir(ctx, { site: 'painel', papeis: ['master', 'gestor'] });
    const [alvo] = await db.query(`SELECT id, nome, email, ambiente FROM usuarios WHERE id = $1 AND escritorio_id = $2 AND status = 'convidado'`, [ctx.params.id, u.escritorio_id]);
    if (!alvo) throw new ErroHttp(404, 'Convite não encontrado (a conta já pode estar ativa).');
    if (alvo.ambiente === 'equipe' && u.papel !== 'master') throw new ErroHttp(403, 'Só o administrador master reenvia convites da equipe.');
    return db.tx(q => enviarConvite(q, alvo, alvo.ambiente === 'equipe' ? 'painel' : 'cliente', u.nome));
  });

  return { carregarEmpresas };
}
