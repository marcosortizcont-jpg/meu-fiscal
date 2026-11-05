// Envio de documentos: avisos ao cliente (WhatsApp e e-mail) quando o escritório pede documentos, nega, pede complemento ou cobra o envio.
import { ErroHttp } from './http.js';
import { enviarEmail } from './externos.js';
import { limitar } from './seguranca.js';
import { criarApoio, fmtComp, fmtData, marcaDe } from './apoio.js';

export function registrarDocumentos(r, { db, exigir, log, pode, wa }) {
  const A = criarApoio(db);
  r.post('/api/documentos/cobrar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'docs', 'editar')) throw new ErroHttp(403, 'Seu acesso a Documentos é só de consulta.');
    if (limitar(`docs-cobrar:${u.id}`, 200, 3600).bloqueado) throw new ErroHttp(429, 'Muitos avisos seguidos. Aguarde alguns minutos.');
    const b = ctx.corpo || {}; const e = await A.empresa(u.escritorio_id, b.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const itens = (Array.isArray(b.itens) ? b.itens : []).map(x => String(x).slice(0, 100)).filter(Boolean).slice(0, 30);
    if (!itens.length) throw new ErroHttp(400, 'Nenhum documento informado.');
    const comp = /^\d{4}-\d{2}$/.test(b.comp || '') ? b.comp : null; const cfg = await A.configEscritorio(u.escritorio_id);
    const nome = String(e.socios?.[0]?.nome || e.fantasia || e.razao || '').split(' ')[0]; const lista = itens.map(x => '• ' + x).join('\n'); const empresa = e.fantasia || e.razao;
    const motivo = String(b.texto || '').slice(0, 500);
    const texto = b.tipo === 'negado' ? `Olá, ${nome}! Analisamos o documento "${itens[0]}" de ${fmtComp(comp)} da ${empresa} e ele precisa ser enviado de novo: ${motivo}\nÉ só reenviar pelo Portal do Cliente, em Envio mensal.`
      : b.tipo === 'pendencia' ? `Olá, ${nome}! Recebemos "${itens[0]}" de ${fmtComp(comp)} da ${empresa}, mas falta um complemento: ${motivo}\nEnvie só o que falta pelo Portal do Cliente, em Envio mensal (o que você já mandou fica guardado).`
      : b.avulso ? `Olá, ${nome}! A ${marcaDe(cfg)} precisa de um documento da ${empresa}:\n${lista}\nPrazo: ${fmtData(b.prazo || '')}. Envie pelo Portal do Cliente, em Envio mensal (competência ${fmtComp(comp)}).`
      : `Olá, ${nome}! Para fecharmos ${fmtComp(comp)} da ${empresa}, ainda precisamos de:\n${lista}\nEnvie pelo Portal do Cliente, em Envio mensal. Se não houve movimento em algum deles, é só marcar "Não tive movimento".`;
    const res = {};
    try { const rw = await wa.enviarArquivos({ esc: u.escritorio_id, empresaId: String(e.id), fone: e.telefone, anexos: [], legenda: texto, u: { id: u.id, nome: 'Cobrança de documentos por ' + String(u.nome || '').split(' ')[0] } }); res.whatsapp = 'WhatsApp enviado para ' + rw.para; }
    catch (er) { res.whatsapp = 'WhatsApp não enviado (' + er.message + ')'; }
    const para = await A.emailsDaEmpresa(u.escritorio_id, e.id, e);
    if (!para.length) res.email = 'sem e-mail cadastrado';
    else { const re = await enviarEmail({ para, assunto: (b.tipo === 'negado' ? 'Documento para reenviar' : b.tipo === 'pendencia' ? 'Complemento de documento' : 'Documentos pendentes') + (comp ? ' · ' + fmtComp(comp) : ''), texto, html: `<p>${texto.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/\n/g, '<br>')}</p>` }); res.email = re.enviado ? 'e-mail enviado' : 'e-mail não enviado (' + (re.motivo || 'falha') + ')'; }
    await log('documentos_cobrados', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao || ''} · ${comp || ''} · ${itens.join(', ')}` });
    return { ok: true, resumo: [res.whatsapp, res.email].join(' · '), res };
  }, { limite: 32 * 1024 });
}
