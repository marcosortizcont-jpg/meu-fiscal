// Meu perfil (portal e painel): a própria pessoa vê seus dados, troca o nome e a senha.
// E-mail de login e telefone ficam só para consulta: a troca é pedida ao escritório (vira uma demanda).
import crypto from 'node:crypto';
import { ErroHttp } from './http.js';
import { SENHA_RE, EMAIL_RE } from './config.js';
import { hashSenha, conferirSenha, limitar } from './seguranca.js';
import { deptosDoUsuario } from './atendimento.js';

const soDig = s => String(s || '').replace(/\D/g, '');
const CAMPOS = { email: 'E-mail de acesso (login)', telefone: 'Telefone / WhatsApp' };

export function registrarPerfil(r, { db, exigir, log, hub, limparCacheDe }) {
  async function telefoneDe(u) {
    const [x] = await db.query('SELECT telefone FROM usuarios WHERE id = $1', [u.id]);
    if (x?.telefone) return x.telefone;
    if (u.ambiente !== 'cliente') return null;
    // cliente: telefone do contato com o mesmo e-mail (Atendimento › Contatos ou contatos do cadastro da empresa)
    const [ct] = await db.query(`SELECT dados->>'telefone' AS t FROM registros WHERE escritorio_id = $1 AND colecao = 'contatos' AND lower(dados->>'email') = $2 AND coalesce(dados->>'telefone','') <> '' LIMIT 1`, [u.escritorio_id, u.email.toLowerCase()]);
    if (ct?.t) return ct.t;
    const ids = u.empresas.map(e => e.id); if (!ids.length) return null;
    const es = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id = ANY($2::text[])`, [u.escritorio_id, ids]);
    for (const { dados: e } of es) { const c = (e.contatos || []).concat(e.socios || []).find(x => String(x.email || '').toLowerCase() === u.email.toLowerCase() && (x.telefone || x.celular)); if (c) return c.telefone || c.celular; }
    return null;
  }

  r.get('/api/perfil', async ctx => {
    const u = await exigir(ctx);
    const [x] = await db.query('SELECT nome, email, criado_em, ultimo_login_em FROM usuarios WHERE id = $1', [u.id]);
    let empresas = [];
    if (u.ambiente === 'cliente' && u.empresas.length) {
      const es = await db.query(`SELECT id, dados->>'razao' AS razao, dados->>'fantasia' AS fantasia, dados->>'cnpj' AS cnpj FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id = ANY($2::text[])`, [u.escritorio_id, u.empresas.map(e => e.id)]);
      empresas = u.empresas.map(e => ({ ...e, ...(es.find(y => y.id === e.id) || {}) }));
    }
    const pend = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'tickets' AND dados->>'perfilUid' = $2 AND coalesce(dados->>'status','') <> 'concluido' ORDER BY atualizado_em DESC LIMIT 5`, [u.escritorio_id, u.id]);
    return {
      nome: x.nome, email: x.email, telefone: await telefoneDe(u), ambiente: u.ambiente, papel: u.papel, funcao: u.funcao,
      deptos: u.ambiente === 'equipe' ? deptosDoUsuario(u) : undefined, empresas, criadoEm: x.criado_em, ultimoLogin: x.ultimo_login_em,
      solicitacoes: pend.map(p => ({ id: p.dados.id, titulo: p.dados.titulo, status: p.dados.status, criadoEm: p.dados.criadoEm })),
    };
  });

  r.patch('/api/perfil', async ctx => {
    const u = await exigir(ctx);
    const nome = String(ctx.corpo.nome || '').trim().replace(/\s+/g, ' ');
    if (nome.length < 3 || nome.length > 120) throw new ErroHttp(400, 'Informe o nome completo (mínimo de 3 letras).');
    await db.query('UPDATE usuarios SET nome = $1 WHERE id = $2', [nome, u.id]);
    limparCacheDe(u.id);
    await log('perfil_nome_alterado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${u.nome} → ${nome}` });
    return { ok: true, nome };
  });

  r.post('/api/perfil/senha', async ctx => {
    const u = await exigir(ctx);
    if (limitar(`perfil-senha:${u.id}`, 5, 900).bloqueado) throw new ErroHttp(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const atual = String(ctx.corpo.atual || ''), nova = String(ctx.corpo.nova || '');
    const [x] = await db.query('SELECT senha_hash FROM usuarios WHERE id = $1', [u.id]);
    if (!await conferirSenha(atual, x?.senha_hash)) { await log('perfil_senha_errada', { usuarioId: u.id, ip: ctx.ip }); throw new ErroHttp(403, 'A senha atual não confere.'); }
    if (!SENHA_RE.test(nova)) throw new ErroHttp(400, 'A nova senha precisa ter exatamente 8 letras ou números.');
    if (nova === atual) throw new ErroHttp(400, 'A nova senha precisa ser diferente da atual.');
    const hash = await hashSenha(nova);
    // as outras sessões abertas desta pessoa são encerradas; esta continua
    const outras = await db.tx(async q => {
      await q('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, u.id]);
      await q('UPDATE tokens SET usado_em = now() WHERE usuario_id = $1 AND usado_em IS NULL', [u.id]);
      return q('UPDATE sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL AND id <> $2 RETURNING id', [u.id, u.sessao_id]);
    });
    for (const s of outras) hub.encerrarSessao(s.id);
    limparCacheDe(u.id);
    await log('perfil_senha_alterada', { usuarioId: u.id, ip: ctx.ip, detalhe: outras.length ? `${outras.length} outra(s) sessão(ões) encerrada(s)` : null });
    return { ok: true, sessoesEncerradas: outras.length };
  });

  // pedido de troca do e-mail de acesso ou do telefone: vira uma demanda para o escritório
  r.post('/api/perfil/solicitar', async ctx => {
    const u = await exigir(ctx);
    if (limitar(`perfil-sol:${u.id}`, 5, 3600).bloqueado) throw new ErroHttp(429, 'Você já enviou vários pedidos. Aguarde o retorno do escritório.');
    const campo = String(ctx.corpo.campo || ''); if (!CAMPOS[campo]) throw new ErroHttp(400, 'Escolha o que deseja alterar.');
    const novo = String(ctx.corpo.novo || '').trim().slice(0, 160); const obs = String(ctx.corpo.obs || '').trim().slice(0, 600);
    if (campo === 'email' && !EMAIL_RE.test(novo)) throw new ErroHttp(400, 'Informe o novo e-mail corretamente.');
    if (campo === 'telefone' && soDig(novo).length < 10) throw new ErroHttp(400, 'Informe o novo telefone com DDD.');
    let empresaId = null;
    if (u.ambiente === 'cliente') { empresaId = u.empresas.some(e => e.id === String(ctx.corpo.empresaId)) ? String(ctx.corpo.empresaId) : (u.empresas[0]?.id || null); if (!empresaId) throw new ErroHttp(400, 'Seu acesso não tem empresa vinculada.'); }
    const agora = new Date(); const prazo = new Date(agora.getTime() + 3 * 86400000).toISOString().slice(0, 10);
    const quem = u.ambiente === 'cliente' ? 'Cliente' : 'Equipe';
    const t = { id: crypto.randomUUID(), empresaId, tipo: 'Alteração de dados de acesso', departamento: 'Cadastro', perfilUid: u.id,
      titulo: `Alterar ${CAMPOS[campo].toLowerCase()} de ${u.nome}`,
      descricao: `${u.ambiente === 'cliente' ? 'Usuário do portal' : 'Colaborador do painel'}: ${u.nome} (${u.email})\n${CAMPOS[campo]} novo: ${novo}${obs ? '\nObservação: ' + obs : ''}\n\nPedido feito em Meu perfil. ${campo === 'email' ? 'Depois de conferir, altere o e-mail de acesso em Equipe e permissões (colaborador) ou no acesso ao portal do cliente.' : 'Depois de conferir, atualize o telefone no cadastro.'}`,
      status: 'aberto', valor: 0, faturado: false, criadoEm: agora.toISOString(), prazo,
      eventos: [{ em: agora.toISOString(), autor: quem, texto: 'Solicitação aberta em Meu perfil.' }] };
    await db.query(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados, atualizado_por) VALUES ($1,'tickets',$2,$3,$4::jsonb,$5)`, [u.escritorio_id, t.id, empresaId, JSON.stringify(t), u.id]);
    await log('perfil_alteracao_solicitada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${campo}: ${novo}` });
    return { ok: true, id: t.id, prazo };
  });
}
