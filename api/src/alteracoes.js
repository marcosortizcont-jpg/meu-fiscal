// Histórico de alterações: cada gravação nos cadastros fica registrada com o que mudou, quem, quando e o IP.
import { ErroHttp } from './http.js';
import { conferirSenha, limitar } from './seguranca.js';
import { MODULO_DA_COLECAO } from './permissoes.js';

// coleções que não entram (conversas e auditoria já têm histórico próprio; aceite de termos não muda)
const IGNORAR = new Set(['auditoria', 'conversas', 'consentimentos']);
// campos que mudam sozinhos e só poluem o histórico
const RUIDO = new Set(['atualizadoEm', 'alteradoEm', 'acessos', 'log', 'naoLidas']);
const curto = v => { if (v === undefined || v === null || v === '') return null; const t = typeof v === 'string' ? v : JSON.stringify(v); return t.length > 160 ? t.slice(0, 157) + '…' : t; };
const eObj = v => v && typeof v === 'object' && !Array.isArray(v);

// valores vazios e números em texto contam como iguais (o formulário normaliza campos sem que nada tenha mudado)
const norm = v => {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) return Number(v);
  if (Array.isArray(v)) return v.map(norm);
  if (eObj(v)) { const o = {}; for (const k of Object.keys(v).sort()) { const x = norm(v[k]); if (x !== null && !RUIDO.has(k)) o[k] = x; } return Object.keys(o).length ? o : null; }
  return v;
};
const igual = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const rotulo = (x, i) => (x && (x.nome || x.razao || x.descricao || x.tipo)) || `item ${i + 1}`;

export function diferencas(antes, depois, prefixo = '', out = [], nivel = 0) {
  const chaves = new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})]);
  for (const k of chaves) {
    if (RUIDO.has(k) || out.length >= 40) continue;
    const a = antes ? antes[k] : undefined, d = depois ? depois[k] : undefined, campo = prefixo + k;
    if (igual(a, d)) continue;
    if (eObj(a) && eObj(d) && nivel < 2) { diferencas(a, d, campo + '.', out, nivel + 1); continue; }
    if (Array.isArray(a) || Array.isArray(d)) {
      const A = a || [], D = d || [];
      const simples = [...A, ...D].every(x => typeof x !== 'object');
      if (simples) { out.push({ campo, de: curto(a), para: curto(d) }); continue; }
      // listas de objetos (sócios, contatos, anexos): mostra o que entrou, saiu ou mudou em cada item
      const n = Math.max(A.length, D.length);
      for (let i = 0; i < n && out.length < 40; i++) {
        if (igual(A[i], D[i])) continue;
        if (A[i] === undefined) out.push({ campo, de: null, para: 'incluído: ' + rotulo(D[i], i) });
        else if (D[i] === undefined) out.push({ campo, de: 'removido: ' + rotulo(A[i], i), para: null });
        else if (eObj(A[i]) && eObj(D[i]) && nivel < 2) diferencas(A[i], D[i], `${campo}[${rotulo(D[i], i)}].`, out, nivel + 1);
        else out.push({ campo, de: curto(A[i]), para: curto(D[i]) });
      }
      continue;
    }
    out.push({ campo, de: curto(a), para: curto(d) });
  }
  return out;
}
const nomeDe = d => d && (d.razao || d.fantasia || d.nome || d.tipo || d.descricao || d.portal || d.titulo) || '';

export function criarRegistroAlteracoes(db) {
  // q: função de consulta (dentro ou fora de transação)
  async function registrar(q, u, ip, { colecao, id, empresaId, acao, antes, depois, resumo, mudancas }) {
    if (IGNORAR.has(colecao)) return;
    const m = mudancas || (acao === 'alterou' ? diferencas(antes, depois) : null);
    if (acao === 'alterou' && !mudancas && (!m || !m.length)) return;
    await q(`INSERT INTO alteracoes (escritorio_id, usuario_id, usuario_nome, ambiente, ip, colecao, registro_id, empresa_id, acao, resumo, mudancas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [u.escritorio_id, u.id || null, u.nome || null, u.ambiente || null, ip || null, colecao, id ? String(id) : null, empresaId || null, acao,
      String(resumo || nomeDe(depois || antes)).slice(0, 200), m ? JSON.stringify(m) : null]);
  }
  return { registrar };
}

export function registrarRotasAlteracoes(r, { db, exigir, log, pode, alt }) {
  r.get('/api/admin/alteracoes', async ctx => {
    const u = await exigir(ctx, { site: 'painel', papeis: ['master'] });
    const lim = Math.min(Number(ctx.query.limite) || 300, 1000);
    const conds = ['escritorio_id = $1']; const p = [u.escritorio_id];
    if (ctx.query.empresa) { p.push(String(ctx.query.empresa)); conds.push(`empresa_id = $${p.length}`); }
    if (ctx.query.usuario) { p.push(String(ctx.query.usuario)); conds.push(`usuario_id = $${p.length}::uuid`); }
    if (!ctx.query.empresa && !ctx.query.usuario) throw new ErroHttp(400, 'Informe a empresa ou o usuário.');
    const linhas = await db.query(`SELECT id, em, usuario_id, usuario_nome, ambiente, ip, colecao, registro_id, empresa_id, acao, resumo, mudancas
      FROM alteracoes WHERE ${conds.join(' AND ')} ORDER BY em DESC LIMIT ${lim}`, p);
    return { alteracoes: linhas };
  });

  // exclusão de documento com a senha de quem está excluindo
  const EXCLUIVEIS = new Set(['documentos', 'checklist', 'docsinternos']);
  r.post('/api/registros/excluir', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const c = String(ctx.corpo.colecao || ''), id = String(ctx.corpo.id || '');
    if (!EXCLUIVEIS.has(c)) throw new ErroHttp(400, 'Este tipo de registro não pode ser excluído por aqui.');
    if (!pode(u, MODULO_DA_COLECAO[c], 'excluir')) throw new ErroHttp(403, 'Seu acesso não permite excluir documentos. Peça ao administrador master.');
    if (limitar(`excluir-reg:${u.id}`, 10, 900).bloqueado) throw new ErroHttp(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const [eu] = await db.query('SELECT senha_hash FROM usuarios WHERE id = $1', [u.id]);
    if (!await conferirSenha(String(ctx.corpo.senha || ''), eu?.senha_hash)) {
      await log('excluir_documento_senha_errada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${c}/${id}` });
      throw new ErroHttp(403, 'Senha incorreta. Nada foi excluído.');
    }
    const [reg] = await db.query('SELECT empresa_id, dados FROM registros WHERE escritorio_id = $1 AND colecao = $2 AND id = $3', [u.escritorio_id, c, id]);
    if (!reg) throw new ErroHttp(404, 'Documento não encontrado.');
    await db.tx(async q => {
      await q('DELETE FROM registros WHERE escritorio_id = $1 AND colecao = $2 AND id = $3', [u.escritorio_id, c, id]);
      const arq = reg.dados?.arquivo?.id;
      if (arq && /^[0-9a-f-]{36}$/.test(arq)) {
        const [uso] = await q(`SELECT 1 AS ok FROM registros WHERE escritorio_id = $1 AND dados::text LIKE $2 LIMIT 1`, [u.escritorio_id, '%' + arq + '%']);
        if (!uso) { await q('DELETE FROM arquivos_conteudo WHERE id = $1', [arq]); await q('DELETE FROM arquivos WHERE id = $1 AND escritorio_id = $2', [arq, u.escritorio_id]); }
      }
      await alt.registrar(q, u, ctx.ip, { colecao: c, id, empresaId: reg.empresa_id, acao: 'excluiu', antes: reg.dados,
        resumo: (reg.dados.nome || reg.dados.arquivo?.nome || 'Documento') + ' (confirmado com senha)' });
    });
    await log('documento_excluido', { usuarioId: u.id, ip: ctx.ip, detalhe: `${c} · ${reg.dados.nome || reg.dados.arquivo?.nome || id}` });
    return { ok: true };
  });
}
