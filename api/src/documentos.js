// Envio de documentos: avisos ao cliente (WhatsApp e e-mail) quando o escritório pede documentos, nega, pede complemento ou cobra o envio.
import { ErroHttp } from './http.js';
import { enviarEmail } from './externos.js';
import { limitar } from './seguranca.js';
import { criarApoio, fmtComp, fmtData, marcaDe, agoraLocal, addMes } from './apoio.js';

export function registrarDocumentos(r, { db, exigir, log, pode, wa }) {
  const A = criarApoio(db);

  // monta e envia a mensagem (WhatsApp + e-mail); usada pela rota e pela cobrança automática
  async function enviarCobranca({ esc, quem, e, comp, itens, b = {} }) {
    const cfg = await A.configEscritorio(esc);
    const nome = String(e.socios?.[0]?.nome || e.fantasia || e.razao || '').split(' ')[0]; const lista = itens.map(x => '• ' + x).join('\n'); const empresa = e.fantasia || e.razao;
    const motivo = String(b.texto || '').slice(0, 500);
    const texto = b.tipo === 'negado' ? `Olá, ${nome}! Analisamos o documento "${itens[0]}" de ${fmtComp(comp)} da ${empresa} e ele precisa ser enviado de novo: ${motivo}\nÉ só reenviar pelo Portal do Cliente, em Envio mensal.`
      : b.tipo === 'pendencia' ? `Olá, ${nome}! Recebemos "${itens[0]}" de ${fmtComp(comp)} da ${empresa}, mas falta um complemento: ${motivo}\nEnvie só o que falta pelo Portal do Cliente, em Envio mensal (o que você já mandou fica guardado).`
      : b.avulso ? `Olá, ${nome}! A ${marcaDe(cfg)} precisa de um documento da ${empresa}:\n${lista}\nPrazo: ${fmtData(b.prazo || '')}. Envie pelo Portal do Cliente, em Envio mensal (competência ${fmtComp(comp)}).`
      : `Olá, ${nome}! Para fecharmos ${fmtComp(comp)} da ${empresa}, ainda precisamos de:\n${lista}\nEnvie pelo Portal do Cliente, em Envio mensal. Se não houve movimento em algum deles, é só marcar "Não tive movimento".`;
    const res = {};
    try { const rw = await wa.enviarArquivos({ esc: esc, empresaId: String(e.id), fone: e.telefone, anexos: [], legenda: texto, u: { id: quem.id, nome: 'Cobrança de documentos por ' + String(quem.nome || '').split(' ')[0] } }); res.whatsapp = 'WhatsApp enviado para ' + rw.para; }
    catch (er) { res.whatsapp = 'WhatsApp não enviado (' + er.message + ')'; }
    const para = await A.emailsDaEmpresa(esc, e.id, e);
    if (!para.length) res.email = 'sem e-mail cadastrado';
    else { const re = await enviarEmail({ para, assunto: (b.tipo === 'negado' ? 'Documento para reenviar' : b.tipo === 'pendencia' ? 'Complemento de documento' : 'Documentos pendentes') + (comp ? ' · ' + fmtComp(comp) : ''), texto, html: `<p>${texto.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/\n/g, '<br>')}</p>` }); res.email = re.enviado ? 'e-mail enviado' : 'e-mail não enviado (' + (re.motivo || 'falha') + ')'; }
    return res;
  }
  r.post('/api/documentos/cobrar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'docs', 'editar')) throw new ErroHttp(403, 'Seu acesso a Documentos é só de consulta.');
    if (limitar(`docs-cobrar:${u.id}`, 200, 3600).bloqueado) throw new ErroHttp(429, 'Muitos avisos seguidos. Aguarde alguns minutos.');
    const b = ctx.corpo || {}; const e = await A.empresa(u.escritorio_id, b.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const itens = (Array.isArray(b.itens) ? b.itens : []).map(x => String(x).slice(0, 100)).filter(Boolean).slice(0, 30);
    if (!itens.length) throw new ErroHttp(400, 'Nenhum documento informado.');
    const comp = /^\d{4}-\d{2}$/.test(b.comp || '') ? b.comp : null;
    const res = await enviarCobranca({ esc: u.escritorio_id, quem: { id: u.id, nome: u.nome }, e, comp, itens, b });
    await log('documentos_cobrados', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao || ''} · ${comp || ''} · ${itens.join(', ')}` });
    return { ok: true, resumo: [res.whatsapp, res.email].join(' · '), res };
  }, { limite: 32 * 1024 });

  // cobrança automática: nos dias escolhidos (config.docsAuto = { ativo, dias: [5, 10], hora: 9 }), cobra quem não enviou os documentos do mês anterior
  const devido = (it, comp) => { if (it.ativo === false) return false; if (it.desde && comp < it.desde) return false; if (it.ate && comp > it.ate) return false; const m = +comp.slice(5, 7); const r = it.recorrencia || 'mensal';
    return r === 'mensal' ? true : r === 'trimestral' ? m % 3 === 0 : r === 'anual' ? m === Number(it.mesAnual || 12) : r === 'meses' ? (it.meses || []).includes(m) : true; };
  async function cobrancaAutomatica() {
    const { data, comp: atual, dia, hora } = agoraLocal(); const comp = addMes(atual, -1);
    const cfgs = await db.query(`SELECT escritorio_id, id, dados FROM registros WHERE colecao = 'config'`);
    for (const c of cfgs) {
      const a = c.dados?.docsAuto; if (!a?.ativo || !(a.dias || []).map(Number).includes(dia) || hora < Number(a.hora ?? 9)) continue;
      // controle da última execução fica num registro próprio (o navegador regrava a config inteira e apagaria a marca)
      const marca = await A.registro(c.escritorio_id, 'capturaestado', 'docsauto'); if (marca?.ultimo === data) continue;
      await A.gravar(c.escritorio_id, 'capturaestado', 'docsauto', null, { ultimo: data });
      const emps = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas'`, [c.escritorio_id]);
      const regs = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'checklist' AND dados->>'comp' = $2`, [c.escritorio_id, comp]);
      let n = 0;
      for (const { dados: e } of emps) {
        if (!e || e.exemplo || ['inativo', 'cancelado'].includes(e.status)) continue;
        const itens = [...(e.checklist || []).filter(it => devido(it, comp)), ...(e.docAvulsos || []).filter(x => x.comp === comp)]
          .filter(it => { const x = regs.find(r => r.dados.empresaId === e.id && r.dados.itemId === it.id); const k = x ? (x.dados.status || 'enviado') : 'pendente'; return ['pendente', 'recusado', 'pendencia'].includes(k); }).map(it => it.nome).slice(0, 30);
        if (!itens.length) continue;
        try { await enviarCobranca({ esc: c.escritorio_id, quem: { id: 'sistema', nome: 'Cobrança automática' }, e, comp, itens }); n++; } catch { }
      }
      await log('documentos_cobranca_automatica', { detalhe: `${fmtComp(comp)} · ${n} empresa(s)` }).catch(() => { });
    }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => cobrancaAutomatica().catch(() => { }), 120000).unref?.(); setInterval(() => cobrancaAutomatica().catch(() => { }), 30 * 60000).unref?.(); }
}
