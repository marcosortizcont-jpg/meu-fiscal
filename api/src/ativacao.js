// Cadastro de clientes com ativação por pagamento (ou voucher do master).
//
// Toda empresa nova nasce "aguardando_pagamento": a primeira mensalidade é cobrada no Banco Inter (um boleto com QR Code
// PIX) e o cadastro só fica ativo quando o banco confirma o pagamento (webhook) ou quando um voucher
// de isenção zera o valor. Vouchers são criados só pelo master (código, % ou valor, quantidade ou ilimitado,
// quantos meses vale e validade); o uso é conferido e contado aqui no servidor.
import crypto from 'node:crypto';
import { ErroHttp } from './http.js';
import { enviarEmail } from './externos.js';
import { limitar } from './seguranca.js';
import { criarApoio, soDig, brl, fmtData, fmtComp, addDias, agoraLocal, marcaDe } from './apoio.js';

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const FALSO = process.env.FINANCEIRO_FALSO === '1' && process.env.NODE_ENV !== 'production';
// cobrança única no banco: boleto com QR Code PIX (o cliente paga como preferir)
const METODOS = { bolepix: 'BOLEPIX' };
const NOME_METODO = { bolepix: 'boleto ou PIX' };
const REGIME_ID = { MEI: 'reg2-mei', SN: 'reg2-sn-sem-ie', 'SN-IE': 'reg2-sn-com-ie', OUTRO: 'reg2-outros' };
export function cnpjValido(c) {
  c = soDig(c); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +c[12] && dv(13) === +c[13];
}
// desconto de um voucher sobre um valor
export function descontoVoucher(v, valor) {
  if (!v) return 0;
  if (v.tipo === 'isencao') return r2(valor);
  if (v.tipo === 'percentual') return r2(Math.min(valor, valor * Number(v.valor) / 100));
  return r2(Math.min(valor, Number(v.valor)));
}

export function registrarAtivacao(r, { db, exigir, log, pode, wa, fin, ganchos }) {
  const A = criarApoio(db);
  const ehMaster = u => u.papel === 'master';
  const exigirMaster = u => { if (!ehMaster(u)) throw new ErroHttp(403, 'Só o usuário master gera e altera vouchers.'); };
  const podeCadastrar = u => pode(u, 'comercial', 'editar') || pode(u, 'carteira', 'editar');

  /* ---------------- vouchers ---------------- */
  const formatoV = x => ({ id: x.id, codigo: x.codigo, tipo: x.tipo, valor: Number(x.valor), quantidade: x.quantidade, usados: x.usados, meses: x.meses, validade: x.validade ? String(x.validade).slice(0, 10) : null,
    ativo: x.ativo, descricao: x.descricao, criadoEm: x.criado_em, criadoPor: x.criado_por_nome || null });
  async function buscarVoucher(q, esc, codigo, travar) {
    const [v] = await q(`SELECT * FROM vouchers WHERE escritorio_id = $1 AND upper(codigo) = upper($2)${travar ? ' FOR UPDATE' : ''}`, [esc, String(codigo || '').trim()]);
    return v || null;
  }
  function conferirVoucher(v) {
    if (!v) throw new ErroHttp(404, 'Voucher não encontrado. Confira o código.');
    if (!v.ativo) throw new ErroHttp(409, 'Este voucher foi desativado pelo master.');
    if (v.validade && String(v.validade).slice(0, 10) < agoraLocal().data) throw new ErroHttp(409, 'Este voucher venceu em ' + fmtData(String(v.validade).slice(0, 10)) + '.');
    if (v.quantidade != null && v.usados >= v.quantidade) throw new ErroHttp(409, 'Este voucher já foi usado todas as vezes permitidas.');
  }
  r.get('/api/vouchers', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    const l = await db.query(`SELECT v.*, us.nome AS criado_por_nome FROM vouchers v LEFT JOIN usuarios us ON us.id = v.criado_por WHERE v.escritorio_id = $1 ORDER BY v.criado_em DESC`, [u.escritorio_id]);
    const usos = await db.query(`SELECT voucher_id, empresa_id, empresa_nome, desconto, em, usuario_nome FROM voucher_usos WHERE escritorio_id = $1 ORDER BY em DESC LIMIT 300`, [u.escritorio_id]);
    return { vouchers: l.map(formatoV), usos };
  });
  r.post('/api/vouchers', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    const b = ctx.corpo || {};
    const codigo = String(b.codigo || '').trim().toUpperCase() || ('MF-' + crypto.randomBytes(4).toString('hex').toUpperCase());
    if (!/^[A-Z0-9][A-Z0-9_-]{3,29}$/.test(codigo)) throw new ErroHttp(400, 'Código do voucher: 4 a 30 letras, números, - ou _.');
    const tipo = ['percentual', 'valor', 'isencao'].includes(b.tipo) ? b.tipo : 'percentual';
    const valor = tipo === 'isencao' ? 100 : r2(b.valor);
    if (tipo === 'percentual' && !(valor > 0 && valor <= 100)) throw new ErroHttp(400, 'O percentual vai de 0,01% a 100%.');
    if (tipo === 'valor' && !(valor > 0)) throw new ErroHttp(400, 'Informe o valor do desconto.');
    const quantidade = b.ilimitado ? null : Math.max(1, Math.min(100000, Number(b.quantidade) || 1));
    const meses = Math.max(1, Math.min(60, Number(b.meses) || 1));
    const validade = /^\d{4}-\d{2}-\d{2}$/.test(b.validade || '') ? b.validade : null;
    if (await buscarVoucher(db.query, u.escritorio_id, codigo)) throw new ErroHttp(409, 'Já existe um voucher com este código.');
    const [v] = await db.query(`INSERT INTO vouchers (escritorio_id, codigo, tipo, valor, quantidade, meses, validade, descricao, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [u.escritorio_id, codigo, tipo, valor, quantidade, meses, validade, String(b.descricao || '').slice(0, 200), u.id]);
    await log('voucher_criado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${codigo} · ${tipo} ${valor} · ${quantidade ?? 'ilimitado'} uso(s) · ${meses} mês(es)` });
    return { ok: true, voucher: formatoV(v) };
  });
  r.put('/api/vouchers/:id', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    const b = ctx.corpo || {};
    const [v] = await db.query(`UPDATE vouchers SET ativo = $3 WHERE escritorio_id = $1 AND id = $2 RETURNING *`, [u.escritorio_id, String(ctx.params.id), !!b.ativo]);
    if (!v) throw new ErroHttp(404, 'Voucher não encontrado.');
    await log('voucher_alterado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${v.codigo} · ${v.ativo ? 'ativado' : 'desativado'}` });
    return { ok: true, voucher: formatoV(v) };
  });
  r.post('/api/vouchers/validar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeCadastrar(u)) throw new ErroHttp(403, 'Seu acesso não permite cadastrar clientes.');
    if (limitar(`voucher-val:${u.id}`, 60, 600).bloqueado) throw new ErroHttp(429, 'Muitas tentativas de voucher. Aguarde alguns minutos.');
    const v = await buscarVoucher(db.query, u.escritorio_id, ctx.corpo?.codigo); conferirVoucher(v);
    const valor = r2(ctx.corpo?.valor); const d = descontoVoucher(v, valor);
    return { ok: true, codigo: v.codigo, tipo: v.tipo, percentual: v.tipo === 'percentual' ? Number(v.valor) : null, meses: v.meses, desconto: d, total: r2(valor - d),
      texto: v.tipo === 'isencao' ? `Isenção total${v.meses > 1 ? ' por ' + v.meses + ' meses' : ' da 1ª mensalidade'}` : `${v.tipo === 'percentual' ? Number(v.valor) + '%' : brl(v.valor)} de desconto${v.meses > 1 ? ' por ' + v.meses + ' meses' : ' na 1ª mensalidade'}` };
  });

  /* ---------------- cobrança de ativação ---------------- */
  async function cobrar(esc, e, ativ) {
    const hoje = agoraLocal().data; const venc = addDias(hoje, 3);
    const b = await fin.banco.emitir(esc, { ref: 'ativ-' + e.id, e, valor: ativ.total, venc, descricao: `Ativação ${ativ.planoNome || 'plano contábil'} · 1ª mensalidade` });
    return { provedor: b.provedor, cobrancaId: b.id, link: b.link || '', linha: b.linha, pix: b.pix, venc: b.venc, arquivoId: b.arquivo?.id || null, arquivoUrl: b.arquivo?.url || '', emitidaEm: new Date().toISOString() };
  }
  const textoCobranca = at => [at.pix ? `PIX copia e cola:\n${at.pix}` : '', at.linha ? `Boleto (linha digitável): ${at.linha}` : '', at.link || ''].filter(Boolean).join('\n\n');
  async function avisarCliente(esc, e, ativ, quem) {
    const cfg = await A.configEscritorio(esc); const nome = String(e.contatos?.[0]?.nome || e.socios?.[0]?.nome || e.fantasia || e.razao || '').split(' ')[0];
    const texto = `Olá, ${nome}! Que bom ter a ${e.fantasia || e.razao} com a ${marcaDe(cfg)}. 🎉 Para ativar o seu plano ${ativ.planoNome || ''}, é só pagar a 1ª mensalidade de ${brl(ativ.total)}${ativ.desconto ? ' (já com ' + brl(ativ.desconto) + ' de desconto)' : ''} por boleto ou PIX (vencimento ${fmtData(ativ.venc)}):\n\n${textoCobranca(ativ)}\n\nAssim que o pagamento for confirmado, seu cadastro é ativado e enviamos o acesso ao portal.`;
    const res = {};
    let anexo = null; if (ativ.arquivoId) { const buf = await A.conteudoArquivo(ativ.arquivoId).catch(() => null); if (buf) anexo = { id: ativ.arquivoId, nome: 'Boleto ativação.pdf', tipo: 'application/pdf', conteudo: buf }; }
    try { const rw = await wa.enviarArquivos({ esc, empresaId: e.id, fone: e.telefone, anexos: anexo ? [anexo] : [], legenda: texto, u: { id: null, nome: 'Ativação do cadastro' + (quem ? ' por ' + quem : '') } }); res.whatsapp = 'WhatsApp enviado para ' + rw.para; }
    catch (er) { res.whatsapp = 'WhatsApp não enviado (' + er.message + ')'; }
    const para = await A.emailsDaEmpresa(esc, e.id, e);
    if (para.length) { const re = await enviarEmail({ para, assunto: 'Ativação do seu plano · ' + brl(ativ.total), texto, anexos: anexo ? [anexo] : [], html: `<p>${texto.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>` }); res.email = re.enviado ? 'e-mail enviado' : 'e-mail não enviado (' + (re.motivo || 'falha') + ')'; }
    else res.email = 'sem e-mail';
    return res;
  }
  async function ativar(esc, empresaId, { pago, valorPago, forma, quem, data } = {}) {
    const e = await A.empresa(esc, empresaId); if (!e || e.status !== 'aguardando_pagamento') return e;
    const agora = new Date().toISOString(); const L = agoraLocal(); const at = e.ativacao || {};
    const novo = { ...e, status: 'ativo', ativadaEm: agora, ativacao: { ...at, status: pago ? 'pago' : 'isento', pagoEm: data || L.data, valorPago: r2(valorPago ?? at.total), forma: forma || at.metodo },
      inicioControle: e.inicioControle || L.comp,
      ...(at.voucher && at.voucher.meses > 1 ? { voucherAplicado: { codigo: at.voucher.codigo, tipo: at.voucher.tipo, valor: at.voucher.valor, mesesRestantes: at.voucher.meses - 1 } } : {}) };
    await A.gravar(esc, 'empresas', e.id, e.id, novo);
    // a 1ª mensalidade fica registrada como paga (ou isenta) no Financeiro
    const f = { id: 'fat-' + e.id + '-' + L.comp, empresaId: e.id, comp: L.comp, venc: at.venc || L.data, itens: [{ desc: 'Honorários · ' + (at.planoNome || e.plano?.nome || 'plano contábil'), valor: r2(at.valor), tipo: 'base', detalhe: '1ª mensalidade (ativação do cadastro)' }],
      ...(at.desconto ? { desconto: r2(at.desconto), voucher: at.voucher?.codigo } : {}), valor: r2(at.total), status: 'paga', pagaEm: data || L.data, valorPago: r2(valorPago ?? at.total), formaPagamento: pago ? (forma || 'Banco') : 'Voucher (isenção)',
      baixaAutomatica: !!pago, ativacao: true, cobrancas: [], criadaEm: agora, criadaPor: quem || 'Ativação' };
    const [ja] = await db.query(`SELECT 1 FROM registros WHERE escritorio_id = $1 AND colecao = 'faturas' AND id = $2`, [esc, f.id]); if (!ja) await A.gravar(esc, 'faturas', f.id, e.id, f);
    if (e.leadId) {
      const l = await A.registro(esc, 'leads', e.leadId);
      if (l) await A.gravar(esc, 'leads', l.id, null, { ...l, etapa: 'ganho', status: 'convertido', empresaId: e.id, ganhoEm: l.ganhoEm || agora, etapaDesde: agora,
        atividades: [...(l.atividades || []), { em: agora, tipo: 'etapa', nome: 'Sistema', texto: pago ? `Pagamento da ativação confirmado (${brl(valorPago ?? at.total)}). Cliente ativo.` : 'Cadastro ativado com voucher de isenção.' }].slice(-300) });
    }
    if (ganchos.aoAtivar) await ganchos.aoAtivar(esc, e.id, { pago: !!pago, valorPago: valorPago ?? at.total, data: data || L.data }).catch(er => console.error('[ativacao] pós-ativação', er.message));
    await log('empresa_ativada', { detalhe: `${e.razao} · ${pago ? 'pagamento ' + brl(valorPago ?? at.total) : 'voucher ' + (at.voucher?.codigo || '')}` });
    return novo;
  }
  ganchos.ativacaoPaga = async (esc, empresaId, p) => ativar(esc, empresaId, { pago: true, valorPago: p.value, forma: { BOLETO: 'Boleto', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito' }[p.billingType] || p.billingType || 'Banco', data: String(p.paymentDate || '').slice(0, 10) || undefined, quem: 'Banco' });

  r.post('/api/ativacao/cadastrar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeCadastrar(u)) throw new ErroHttp(403, 'Seu acesso não permite cadastrar clientes.');
    if (limitar(`ativ-cad:${u.id}`, 40, 3600).bloqueado) throw new ErroHttp(429, 'Muitos cadastros seguidos. Aguarde alguns minutos.');
    const b = ctx.corpo || {}; const d = b.empresa || {}; const esc = u.escritorio_id;
    const cnpj = soDig(d.cnpj); if (!cnpjValido(cnpj)) throw new ErroHttp(400, 'CNPJ inválido. Confira os dígitos.');
    const razao = String(d.razao || '').trim(); if (razao.length < 3) throw new ErroHttp(400, 'Informe a razão social.');
    const email = String(d.email || '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ErroHttp(400, 'Informe um e-mail válido do cliente.');
    const fone = soDig(d.telefone); if (fone.length < 10) throw new ErroHttp(400, 'Informe o WhatsApp do cliente com DDD.');
    const valor = r2(b.plano?.valor); if (!(valor > 0)) throw new ErroHttp(400, 'Informe o valor mensal do plano.');
    const metodo = 'bolepix';
    const en = d.endereco || {}; const endereco = { cep: soDig(en.cep).slice(0, 8), logradouro: String(en.logradouro || '').trim().slice(0, 90), numero: String(en.numero || '').trim().slice(0, 10),
      complemento: String(en.complemento || '').trim().slice(0, 30), bairro: String(en.bairro || '').trim().slice(0, 60) };
    if (endereco.cep.length !== 8 || !endereco.logradouro || !String(d.municipio || '').trim() || String(d.uf || '').trim().length !== 2) throw new ErroHttp(400, 'Informe o endereço completo da empresa (CEP, rua, cidade e UF): o banco exige no boleto.');
    const [dup] = await db.query(`SELECT dados->>'razao' AS razao FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND regexp_replace(coalesce(dados->>'cnpj',''),'\\D','','g') = $2 LIMIT 1`, [esc, cnpj]);
    if (dup) throw new ErroHttp(409, 'Já existe uma empresa com este CNPJ: ' + dup.razao + '.');
    const id = 'e-' + crypto.randomBytes(6).toString('hex'); const agora = new Date().toISOString(); const L = agoraLocal();
    const regime = REGIME_ID[d.regime] ? d.regime : 'SN';
    let voucher = null, desconto = 0;
    await db.tx(async q => {
      if (String(b.voucher || '').trim()) {
        const v = await buscarVoucher(q, esc, b.voucher, true); conferirVoucher(v);
        desconto = descontoVoucher(v, valor);
        await q('UPDATE vouchers SET usados = usados + 1 WHERE id = $1', [v.id]);
        await q('INSERT INTO voucher_usos (escritorio_id, voucher_id, empresa_id, empresa_nome, desconto, usuario_id, usuario_nome) VALUES ($1,$2,$3,$4,$5,$6,$7)', [esc, v.id, id, razao, desconto, u.id, u.nome]);
        voucher = { id: v.id, codigo: v.codigo, tipo: v.tipo, valor: Number(v.valor), meses: v.meses };
      }
    });
    const total = r2(valor - desconto);
    const e = { id, razao, fantasia: String(d.fantasia || '').trim(), cnpj, regime: regime === 'SN-IE' ? 'SN' : regime, regimeId: REGIME_ID[regime], anexo: regime.startsWith('SN') ? (d.anexo || 'III') : null,
      email, telefone: fone, endereco, municipio: String(d.municipio || '').slice(0, 80), uf: String(d.uf || '').toUpperCase().slice(0, 2), abertura: String(d.abertura || '').slice(0, 10), cnae: String(d.cnae || '').slice(0, 12), atividade: String(d.atividade || '').slice(0, 200),
      contatos: d.contatoNome ? [{ nome: String(d.contatoNome).slice(0, 80), cargo: 'Responsável', telefone: fone, email }] : [], socios: (Array.isArray(d.socios) ? d.socios : []).slice(0, 10).map(s => ({ nome: String(s?.nome || '').slice(0, 100), qualificacao: String(s?.qualificacao || '').slice(0, 60) })).filter(s => s.nome),
      plano: { nome: String(b.plano?.nome || '').slice(0, 60), valor, funcInclusos: Number(b.plano?.funcInclusos || 0), adicionalFunc: Number(b.plano?.adicionalFunc || 0), metodo, diaVenc: Math.min(28, Math.max(1, Number(b.plano?.diaVenc) || 10)) },
      status: 'aguardando_pagamento', inicioControle: L.comp, checklist: [], origem: 'cadastro-comercial', leadId: b.leadId ? String(b.leadId) : null, criadoEm: agora, criadoPor: u.id, criadoPorNome: u.nome,
      cadastradoPor: { id: u.id, nome: u.nome, em: agora }, representante: { nome: String(d.contatoNome || '').slice(0, 80), cpf: soDig(d.representanteCpf).length === 11 ? soDig(d.representanteCpf) : '' },
      ativacao: { status: 'pendente', metodo, valor, desconto, total, voucher, planoNome: String(b.plano?.nome || '') } };
    await A.gravar(esc, 'empresas', id, id, e);
    let resultado = { empresaId: id, total, desconto };
    if (total <= 0) {
      await ativar(esc, id, { quem: u.nome }); resultado.status = 'ativo';
    } else {
      let cob;
      try { cob = await cobrar(esc, e, e.ativacao); }
      catch (er) { await A.gravar(esc, 'empresas', id, id, { ...e, ativacao: { ...e.ativacao, erro: er.message } }); throw new ErroHttp(er.status || 502, 'Cadastro salvo, mas a cobrança não foi gerada: ' + er.message + ' Use "Gerar cobrança" no cadastro.'); }
      const at = { ...e.ativacao, ...cob };
      await A.gravar(esc, 'empresas', id, id, { ...e, ativacao: at });
      resultado = { ...resultado, status: 'aguardando_pagamento', link: cob.link, linha: cob.linha, pix: cob.pix };
      if (b.avisar !== false) resultado.aviso = await avisarCliente(esc, { ...e, ativacao: at }, at, String(u.nome || '').split(' ')[0]);
    }
    if (e.leadId) { const l = await A.registro(esc, 'leads', e.leadId); if (l) await A.gravar(esc, 'leads', l.id, null, { ...l, empresaId: id, ...(resultado.status === 'ativo' ? {} : { etapa: 'negociacao', status: 'contato' }),
      atividades: [...(l.atividades || []), { em: agora, uid: u.id, nome: u.nome, tipo: 'sistema', texto: resultado.status === 'ativo' ? 'Cadastro criado e ativado (voucher de isenção).' : `Cadastro criado. Aguardando pagamento da ativação: ${brl(total)} por boleto ou PIX.` }].slice(-300) }); }
    await log('empresa_cadastrada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${razao} · ${brl(total)}${voucher ? ' · voucher ' + voucher.codigo : ''} · ${resultado.status}` });
    return { ok: true, ...resultado };
  }, { limite: 64 * 1024 });

  async function pendente(u, id) {
    const e = await A.empresa(u.escritorio_id, id); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (e.status !== 'aguardando_pagamento') throw new ErroHttp(409, 'Este cadastro já não está aguardando pagamento.'); return e;
  }
  r.post('/api/ativacao/:id/cobranca', async ctx => {           // gera de novo (ou troca o método)
    const u = await exigir(ctx, { site: 'painel' }); if (!podeCadastrar(u)) throw new ErroHttp(403, 'Seu acesso não permite esta ação.');
    const e = await pendente(u, ctx.params.id); const b = ctx.corpo || {};
    if (e.ativacao?.cobrancaId && e.ativacao.provedor) await fin.banco.cancelar(u.escritorio_id, e.ativacao.provedor, e.ativacao.cobrancaId, 'Substituida por nova cobranca').catch(() => { });
    const metodo = 'bolepix';
    const at0 = { ...e.ativacao, metodo }; delete at0.erro; delete at0.arquivoId; delete at0.arquivoUrl; delete at0.link;
    const cob = await cobrar(u.escritorio_id, e, at0); const at = { ...at0, ...cob };
    const novo = { ...e, plano: { ...e.plano, metodo }, ativacao: at }; await A.gravar(u.escritorio_id, 'empresas', e.id, e.id, novo);
    const aviso = b.avisar !== false ? await avisarCliente(u.escritorio_id, novo, at, String(u.nome || '').split(' ')[0]) : null;
    return { ok: true, link: cob.link, linha: cob.linha, pix: cob.pix, aviso };
  });
  r.post('/api/ativacao/:id/reenviar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeCadastrar(u)) throw new ErroHttp(403, 'Seu acesso não permite esta ação.');
    const e = await pendente(u, ctx.params.id); if (!e.ativacao?.cobrancaId) throw new ErroHttp(409, 'Ainda não há cobrança gerada. Use "Gerar cobrança".');
    return { ok: true, aviso: await avisarCliente(u.escritorio_id, e, e.ativacao, String(u.nome || '').split(' ')[0]) };
  });
  r.post('/api/ativacao/:id/verificar', async ctx => {           // confere no banco (caso o aviso automático não tenha chegado)
    const u = await exigir(ctx, { site: 'painel' }); const e = await pendente(u, ctx.params.id);
    if (!e.ativacao?.cobrancaId || !e.ativacao.provedor) throw new ErroHttp(409, 'Não há cobrança no banco para conferir.');
    const st = await fin.banco.consultar(u.escritorio_id, e.ativacao.provedor, e.ativacao.cobrancaId);
    if (st.pago) { await fin.pagamentoConfirmado(u.escritorio_id, 'ativ-' + e.id, st); return { ok: true, status: st.situacao, pago: true }; }
    return { ok: true, status: st.situacao, pago: false };
  });
  r.post('/api/ativacao/:id/cancelar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeCadastrar(u)) throw new ErroHttp(403, 'Seu acesso não permite esta ação.');
    const e = await pendente(u, ctx.params.id);
    if (e.ativacao?.cobrancaId && e.ativacao.provedor) await fin.banco.cancelar(u.escritorio_id, e.ativacao.provedor, e.ativacao.cobrancaId, 'Cadastro cancelado').catch(() => { });
    await A.gravar(u.escritorio_id, 'empresas', e.id, e.id, { ...e, status: 'inativo', inativoDesde: agoraLocal().comp, ativacao: { ...e.ativacao, status: 'cancelada', canceladaEm: new Date().toISOString(), canceladaPor: u.nome, motivo: String(ctx.corpo?.motivo || '').slice(0, 200) } });
    await log('ativacao_cancelada', { usuarioId: u.id, ip: ctx.ip, detalhe: e.razao });
    return { ok: true };
  });
  // só no teste local (sem banco real): simula a confirmação do pagamento
  r.post('/api/ativacao/:id/simular-pagamento', async ctx => {
    if (!FALSO) throw new ErroHttp(404, 'Não encontrado.');
    const u = await exigir(ctx, { site: 'painel' }); const e = await pendente(u, ctx.params.id);
    if (e.ativacao?.cobrancaId) await fin.banco.simularPago(u.escritorio_id, e.ativacao.cobrancaId);
    await fin.pagamentoConfirmado(u.escritorio_id, 'ativ-' + e.id, { valor: e.ativacao.total, data: agoraLocal().data, forma: 'PIX' });
    return { ok: true };
  });

  return { ativar, descontoVoucher };
}
