// Financeiro do escritório: mensalidades (honorários), boleto + PIX pelo Banco Inter (Asaas ainda aceito), baixa automática, régua de cobrança e envios.
//
// Configuração não secreta (dias, régua, mensagens, bloqueio) fica em config.financeiro (registro "config"), que o portal
// também lê para aplicar o bloqueio por inadimplência. A chave da API do banco fica cifrada na tabela financeiro_config.
// Sem banco integrado o módulo funciona do mesmo jeito: boleto anexado à mão e chave PIX do escritório.
import crypto from 'node:crypto';
import { ErroHttp } from './http.js';
import { cifrar, decifrar } from './cofre.js';
import { CONFIG } from './config.js';
import { enviarEmail } from './externos.js';
import { limitar } from './seguranca.js';
import { criarBanco } from './banco.js';
import { criarApoio, soDig, pad, brl, fmtData, fmtComp, addMes, addDias, diasEntre, ultimoDia, agoraLocal, marcaDe } from './apoio.js';

const ASAAS = { producao: 'https://api.asaas.com/v3', sandbox: 'https://api-sandbox.asaas.com/v3' };
const FALSO = process.env.FINANCEIRO_FALSO === '1' && process.env.NODE_ENV !== 'production';
const r2 = n => Math.round(Number(n || 0) * 100) / 100;

export const PADRAO = {
  gerarAuto: false, diaGeracao: 1, vencDia: 10, boletoAuto: true, hora: 9, multa: 2, juros: 1,
  envioAoGerar: { ativo: true, canais: ['portal', 'whatsapp', 'email'] },
  lembreteAntes: { ativo: true, dias: 3, canais: ['whatsapp'] },
  noVencimento: { ativo: true, canais: ['whatsapp'] },
  regua: [
    { dias: 1, ativo: true, canais: ['whatsapp', 'email'], mensagem: '' },
    { dias: 7, ativo: true, canais: ['whatsapp', 'email'], mensagem: '' },
    { dias: 15, ativo: true, canais: ['whatsapp', 'email'], mensagem: '' },
    { dias: 30, ativo: true, canais: ['whatsapp', 'email'], mensagem: '' },
  ],
  bloqueio: { ativo: true, dias: 30 },
  mensagens: {},
};
export const MSGS = {
  envio: 'Olá, {nome}! A mensalidade de {competencia} da {empresa} já está disponível: {valor}, com vencimento em {vencimento}. {pagamento}',
  antes: 'Olá, {nome}! Lembrete: a mensalidade de {competencia} da {empresa} ({valor}) vence em {vencimento}. {pagamento}',
  venc: 'Olá, {nome}! Hoje vence a mensalidade de {competencia} da {empresa}: {valor}. {pagamento}',
  atraso: 'Olá, {nome}! Não identificamos o pagamento da mensalidade de {competencia} da {empresa} ({valor}), vencida em {vencimento} ({dias} dia(s) de atraso). {pagamento} Se já pagou, por favor desconsidere ou informe no Portal em Plano e faturas.',
  atraso30: 'Olá, {nome}! A mensalidade de {competencia} da {empresa} ({valor}) está em atraso há {dias} dias. Para evitar a restrição de acesso ao Portal, regularize pelo link: {pagamento} Se precisar negociar, é só responder esta mensagem.',
};
export const cfgFin = c => {
  const f = { ...PADRAO, ...(c?.financeiro || {}) };
  ['envioAoGerar', 'lembreteAntes', 'noVencimento', 'bloqueio'].forEach(k => { f[k] = { ...PADRAO[k], ...((c?.financeiro || {})[k] || {}) }; });
  f.regua = Array.isArray(c?.financeiro?.regua) && c.financeiro.regua.length ? c.financeiro.regua : PADRAO.regua;
  return f;
};

export function registrarFinanceiro(r, { db, exigir, log, pode, wa, ganchos = {} }) {
  const A = criarApoio(db);
  const exigirHon = (u, nivel = 'editar') => { if (!pode(u, 'hon', nivel)) throw new ErroHttp(403, nivel === 'ver' ? 'Seu acesso não inclui o Financeiro.' : 'Seu acesso ao Financeiro é só de consulta.'); };
  const exigirMaster = u => { if (u.papel !== 'master' && !pode(u, 'config', 'editar')) throw new ErroHttp(403, 'Só o master altera a integração bancária.'); };
  const B = criarBanco(db, A);
  const cfgBanco = esc => B.cfg(esc); const temBanco = c => B.pronto(c);
  // pagamento confirmado no banco (aviso automático, verificação manual ou simulação): baixa a fatura ou ativa o cadastro
  async function pagamentoConfirmado(esc, ref, { valor, data, forma, liquido }) {
    if (!ref) return;
    if (ref.startsWith('cert-')) {   // renovação do certificado digital pedida no portal
      const t = await A.registro(esc, 'tickets', ref.slice(5)); if (!t?.renovacao || t.renovacao.status === 'pago') return;
      const agora = new Date().toISOString();
      await A.gravar(esc, 'tickets', t.id, t.empresaId, { ...t, status: t.status === 'aberto' ? 'em_andamento' : t.status,
        renovacao: { ...t.renovacao, status: 'pago', pagoEm: agora, formaPagamento: forma || 'Banco', valorPago: r2(valor || t.renovacao.valor), baixaAutomatica: true },
        eventos: [...(t.eventos || []), { em: agora, autor: 'Sistema', texto: `Pagamento da renovação confirmado pelo banco (${forma || 'PIX/boleto'}, ${brl(valor || t.renovacao.valor)}). O escritório vai agendar a validação.` }] });
      await log('renovacao_cert_paga', { detalhe: `${t.empresaId} · ${brl(valor || t.renovacao.valor)}` }); return;
    }
    if (ref.startsWith('ativ-')) { if (ganchos.ativacaoPaga) await ganchos.ativacaoPaga(esc, ref.slice(5), { value: valor, billingType: forma === 'PIX' ? 'PIX' : forma === 'Boleto' ? 'BOLETO' : forma, paymentDate: data }); return; }
    const f = await A.registro(esc, 'faturas', ref); if (!f || f.status === 'paga') return;
    await A.gravar(esc, 'faturas', f.id, f.empresaId, { ...f, status: 'paga', pagaEm: String(data || agoraLocal().data).slice(0, 10), valorPago: r2(valor || f.valor), ...(liquido ? { valorLiquido: r2(liquido) } : {}),
      formaPagamento: forma || 'Banco', baixaAutomatica: true, baixaEm: new Date().toISOString() });
    if (ganchos.faturaPaga) await ganchos.faturaPaga(esc, await A.registro(esc, 'faturas', f.id)).catch(() => { });
    await log('fatura_paga_banco', { detalhe: `${f.empresaId} · ${f.comp} · ${brl(valor || f.valor)} · ${forma || ''}` });
  }

  /* ---------- mensalidades ---------- */
  async function gerarMensalidades(esc, comp, { quem, empresas: somente } = {}) {
    const conf = cfgFin(await A.configEscritorio(esc));
    const emps = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas'`, [esc])).map(x => x.dados)
      .filter(e => !['inativo', 'aguardando_pagamento'].includes(e.status) && e.plano && Number(e.plano.valor) > 0 && (!somente || somente.includes(e.id)));
    const existentes = new Set((await db.query(`SELECT empresa_id FROM registros WHERE escritorio_id = $1 AND colecao = 'faturas' AND dados->>'comp' = $2 AND coalesce(dados->>'status','') <> 'cancelada'`, [esc, comp])).map(x => x.empresa_id));
    const criadas = [];
    for (const e of emps) {
      if (existentes.has(e.id)) continue;
      const nf = (await db.query(`SELECT count(*)::int AS n FROM registros WHERE escritorio_id = $1 AND colecao = 'funcionarios' AND empresa_id = $2 AND coalesce(dados->>'desligado','false') NOT IN ('true')`, [esc, e.id]))[0]?.n || 0;
      const inc = Number(e.plano.funcInclusos || 0), exc = Math.max(0, nf - inc), adic = Number(e.plano.adicionalFunc || 0);
      const itens = [{ desc: 'Honorários · ' + (e.plano.nome || 'plano contábil'), valor: r2(e.plano.valor), tipo: 'base', detalhe: 'inclui até ' + inc + ' funcionário' + (inc !== 1 ? 's' : '') }];
      if (exc && adic) itens.push({ desc: 'Funcionários excedentes', valor: r2(exc * adic), tipo: 'excedente', qtd: exc, unit: adic, detalhe: nf + ' ativos no mês, ' + inc + ' incluso' + (inc !== 1 ? 's' : '') + ' no plano' });
      const tks = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'tickets' AND empresa_id = $2 AND dados->>'status' = 'concluido' AND coalesce((dados->>'valor')::numeric,0) > 0 AND coalesce(dados->>'faturado','false') <> 'true'`, [esc, e.id])).map(x => x.dados);
      for (const t of tks) { itens.push({ desc: 'Serviço avulso: ' + t.titulo, valor: r2(t.valor), tipo: 'avulso', detalhe: 'concluído em ' + fmtData(String(t.concluidoEm || t.criadoEm || '').slice(0, 10)) }); await A.gravar(esc, 'tickets', t.id, e.id, { ...t, faturado: true }); }
      for (const ex of (e.plano.extras || [])) if (Number(ex.valor) > 0) itens.push({ desc: ex.desc || 'Adicional', valor: r2(ex.valor), tipo: 'adicional' });
      const dia = Math.min(Number(e.plano.diaVenc || conf.vencDia || 10), ultimoDia(+comp.slice(0, 4), +comp.slice(5, 7)));
      let desconto = r2(e.plano.desconto || 0); let voucherUsado = null;
      // voucher de vários meses: desconto nas mensalidades seguintes à ativação
      if (e.voucherAplicado && e.voucherAplicado.mesesRestantes > 0) {
        const bruto = itens.reduce((a, i) => a + i.valor, 0) - desconto; const v = e.voucherAplicado;
        const dv = v.tipo === 'isencao' ? bruto : v.tipo === 'percentual' ? bruto * Number(v.valor) / 100 : Math.min(bruto, Number(v.valor));
        desconto = r2(desconto + dv); voucherUsado = v.codigo;
        await A.gravar(esc, 'empresas', e.id, e.id, { ...e, voucherAplicado: { ...v, mesesRestantes: v.mesesRestantes - 1 } });
      }
      const f = { id: 'fat-' + e.id + '-' + comp, empresaId: e.id, comp, venc: `${comp}-${pad(dia)}`, itens, ...(desconto ? { desconto } : {}), valor: r2(Math.max(0, itens.reduce((a, i) => a + i.valor, 0) - desconto)), ...(voucherUsado ? { voucher: voucherUsado } : {}),
        status: r2(itens.reduce((a, i) => a + i.valor, 0) - desconto) <= 0 ? 'paga' : 'aberta', ...(r2(itens.reduce((a, i) => a + i.valor, 0) - desconto) <= 0 ? { pagaEm: agoraLocal().data, formaPagamento: 'Voucher (isenção)' } : {}), lembretes: [], cobrancas: [], criadaEm: new Date().toISOString(), criadaPor: quem || 'Automático' };
      await A.gravar(esc, 'faturas', f.id, e.id, f); criadas.push(f);
    }
    await log('mensalidades_geradas', { detalhe: `${comp} · ${criadas.length} fatura(s) · ${quem || 'automático'}` });
    return criadas;
  }

  /* ---------- boleto / PIX ---------- */
  async function emitirBoleto(esc, faturaId, quem) {
    const c = await cfgBanco(esc); if (!temBanco(c)) throw new ErroHttp(412, 'Conecte o banco (Inter) em Financeiro › Régua e automação para emitir boletos.');
    const f = await A.registro(esc, 'faturas', faturaId); if (!f) throw new ErroHttp(404, 'Fatura não encontrada.');
    if (['paga', 'cancelada'].includes(f.status)) throw new ErroHttp(409, 'Esta fatura já está ' + (f.status === 'paga' ? 'paga' : 'cancelada') + '.');
    if (f.boleto?.id && f.boleto?.provedor) return f;
    const e = await A.empresa(esc, f.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (!soDig(e.cnpj || e.cpf)) throw new ErroHttp(400, 'A empresa está sem CNPJ no cadastro (o banco exige para o boleto).');
    const conf = cfgFin(await A.configEscritorio(esc));
    const b = await B.emitir(esc, { ref: f.id, e, valor: f.valor, venc: f.venc, descricao: `Honorários ${fmtComp(f.comp)} · ${e.fantasia || e.razao}`, multa: conf.multa, juros: conf.juros });
    const atual = await A.registro(esc, 'faturas', faturaId);
    const novo = { ...atual, boleto: { provedor: b.provedor, id: b.id, nome: b.arquivo?.nome || 'Boleto', url: b.arquivo?.url || '', arquivoId: b.arquivo?.id || null,
      linkPagamento: b.link || '', linhaDigitavel: b.linha, pixCopiaCola: b.pix, emitidoEm: new Date().toISOString(), emitidoPor: quem || 'Automático', venc: b.venc } };
    await A.gravar(esc, 'faturas', faturaId, f.empresaId, novo);
    return novo;
  }

  /* ---------- envio de mensagens (boleto, lembretes e cobrança) ---------- */
  async function textoPagamento(esc, f) {
    if (f.boleto?.linkPagamento) return `Pague por boleto ou PIX: ${f.boleto.linkPagamento}`;
    if (f.boleto?.linhaDigitavel || f.boleto?.pixCopiaCola) return [f.boleto.pixCopiaCola ? `PIX copia e cola: ${f.boleto.pixCopiaCola}` : '', f.boleto.linhaDigitavel ? `Boleto (linha digitável): ${f.boleto.linhaDigitavel}` : ''].filter(Boolean).join('\n') + (f.boleto.arquivoId ? '\nO boleto em PDF segue anexado.' : '');
    const cfg = await A.configEscritorio(esc); return cfg.pix ? `Chave PIX: ${cfg.pix}${cfg.pixNome ? ' (' + cfg.pixNome + ')' : ''}.` : 'O boleto está no Portal do Cliente, em Plano e faturas.';
  }
  async function enviarFatura(esc, faturaId, { etapa = 'manual', canais = ['whatsapp', 'email'], mensagem, quem } = {}) {
    const f = await A.registro(esc, 'faturas', faturaId); if (!f) throw new ErroHttp(404, 'Fatura não encontrada.');
    if (['paga', 'cancelada'].includes(f.status)) throw new ErroHttp(409, 'Esta fatura já está ' + (f.status === 'paga' ? 'paga' : 'cancelada') + '.');
    const e = await A.empresa(esc, f.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const cfg = await A.configEscritorio(esc); const conf = cfgFin(cfg); const hoje = agoraLocal().data; const dias = Math.max(0, diasEntre(f.venc, hoje));
    const chave = etapa === 'envio' ? 'envio' : etapa === 'antes' ? 'antes' : etapa === 'venc' ? 'venc' : dias >= 30 ? 'atraso30' : 'atraso';
    const modelo = mensagem || conf.mensagens?.[etapa] || conf.mensagens?.[chave] || MSGS[etapa === 'manual' ? (dias > 0 ? chave : 'envio') : chave] || MSGS.atraso;
    const pag = await textoPagamento(esc, f);
    const nome = String(e.socios?.[0]?.nome || e.fantasia || e.razao || '').split(' ')[0];
    const texto = String(modelo).replace(/\{(\w+)\}/g, (_, k) => ({ nome, empresa: e.fantasia || e.razao, competencia: fmtComp(f.comp), valor: brl(f.valor), vencimento: fmtData(f.venc), dias: String(dias),
      pagamento: pag, link: f.boleto?.linkPagamento || '', linha: f.boleto?.linhaDigitavel || '', pix: f.boleto?.pixCopiaCola || cfg.pix || '', escritorio: marcaDe(cfg) }[k] ?? _)).trim();
    let anexo = null;
    if (f.boleto?.id && !f.boleto.arquivoId && !(f.boleto.url || '').startsWith('/api/arquivos/')) {
      try { const pdf = await B.pdf(esc, f.boleto.provedor, f.boleto.id); if (pdf) { const a = await A.guardarArquivo(esc, f.empresaId, pdf, 'Boleto honorários ' + f.comp + '.pdf', 'application/pdf', 'boletos'); f.boleto = { ...f.boleto, arquivoId: a.id, url: a.url, nome: a.nome }; const at0 = await A.registro(esc, 'faturas', faturaId); await A.gravar(esc, 'faturas', faturaId, f.empresaId, { ...at0, boleto: f.boleto }); } } catch { }
    }
    if (f.boleto?.arquivoId || (f.boleto?.url || '').startsWith('/api/arquivos/')) {
      const id = f.boleto.arquivoId || f.boleto.url.split('/').pop(); const buf = await A.conteudoArquivo(id);
      if (buf) anexo = { id, nome: f.boleto.nome || 'boleto.pdf', tipo: 'application/pdf', conteudo: buf };
    }
    const res = {};
    if (canais.includes('whatsapp')) {
      try { const rw = await wa.enviarArquivos({ esc, empresaId: f.empresaId, fone: e.telefone, anexos: anexo ? [anexo] : [], legenda: texto, u: { id: null, nome: etapa === 'manual' ? 'Cobrança enviada por ' + (quem || 'equipe') : 'Cobrança automática de honorários' } }); res.whatsapp = 'enviado para ' + rw.para; }
      catch (er) { res.whatsapp = 'não enviado: ' + er.message; }
    }
    if (canais.includes('email')) {
      const para = await A.emailsDaEmpresa(esc, f.empresaId, e);
      if (!para.length) res.email = 'sem e-mail cadastrado';
      else {
        const assunto = (dias > 0 && etapa !== 'envio' ? 'Mensalidade em atraso · ' : 'Mensalidade · ') + `${fmtComp(f.comp)} · ${brl(f.valor)}`;
        const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#0F172A"><p style="font-size:18px;font-weight:700">${marcaDe(cfg).replace(/[<>&]/g, '')}</p><p>${texto.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p></div>`;
        const re = await enviarEmail({ para, assunto, texto, html, anexos: anexo ? [anexo] : [] }); res.email = re.enviado ? 'enviado para ' + para.join(', ') : 'não enviado: ' + (re.motivo || 'falha');
      }
    }
    if (canais.includes('portal')) res.portal = 'disponível em Plano e faturas';
    const atual = await A.registro(esc, 'faturas', faturaId);
    const reg = { em: new Date().toISOString(), etapa, dias, canais, resultado: res, por: quem || 'Automático' };
    await A.gravar(esc, 'faturas', faturaId, f.empresaId, { ...atual, cobrancas: [...(atual.cobrancas || []), reg].slice(-60), ...(etapa === 'envio' ? { enviadaEm: reg.em } : {}) });
    return res;
  }

  /* ---------- régua automática (roda uma vez por dia, no horário configurado) ---------- */
  const rodando = new Set();
  async function rodarRegua(esc, { manual, quem } = {}) {
    if (rodando.has(esc)) throw new ErroHttp(409, 'A régua já está rodando. Aguarde terminar.');
    rodando.add(esc); const L = agoraLocal(); const resumo = { em: new Date().toISOString(), geradas: 0, boletos: 0, enviados: 0, falhas: 0, manual: !!manual };
    try {
      const cfg = await A.configEscritorio(esc); const conf = cfgFin(cfg); const banco = temBanco(await cfgBanco(esc));
      // 1) gera as mensalidades do mês no dia escolhido
      if (conf.gerarAuto && L.dia >= Number(conf.diaGeracao || 1)) {
        const novas = await gerarMensalidades(esc, L.comp, { quem: 'Automático' }); resumo.geradas = novas.length;
        for (const f of novas) {
          try { if (banco && conf.boletoAuto) { await emitirBoleto(esc, f.id); resumo.boletos++; } } catch (er) { resumo.falhas++; console.error('[financeiro] boleto', er.message); }
          if (conf.envioAoGerar.ativo) { try { await enviarFatura(esc, f.id, { etapa: 'envio', canais: conf.envioAoGerar.canais }); resumo.enviados++; } catch { resumo.falhas++; } }
        }
      }
      // 2) lembretes e cobranças das faturas em aberto
      const abertas = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'faturas' AND coalesce(dados->>'status','aberta') IN ('aberta')`, [esc])).map(x => x.dados);
      for (const f of abertas) {
        const d = diasEntre(f.venc, L.data); const feitas = new Set((f.cobrancas || []).filter(x => x.etapa !== 'manual').map(x => x.etapa));
        let etapa = null, canais = [];
        if (d < 0 && conf.lembreteAntes.ativo && -d <= Number(conf.lembreteAntes.dias || 3) && !feitas.has('antes')) { etapa = 'antes'; canais = conf.lembreteAntes.canais; }
        else if (d === 0 && conf.noVencimento.ativo && !feitas.has('venc')) { etapa = 'venc'; canais = conf.noVencimento.canais; }
        else if (d > 0) {
          // só a etapa mais recente que ainda não foi enviada (se o servidor dormiu, não dispara todas de uma vez)
          const et = conf.regua.filter(x => x.ativo && Number(x.dias) <= d).sort((a, b) => b.dias - a.dias)[0];
          if (et && !feitas.has('atraso-' + et.dias) && !conf.regua.some(x => Number(x.dias) > Number(et.dias) && feitas.has('atraso-' + x.dias))) { etapa = 'atraso-' + et.dias; canais = et.canais || ['whatsapp']; f._msg = et.mensagem; }
        }
        if (!etapa) continue;
        try { await enviarFatura(esc, f.id, { etapa, canais, mensagem: f._msg || undefined }); resumo.enviados++; } catch (er) { resumo.falhas++; }
        await new Promise(ok => setTimeout(ok, FALSO ? 20 : 1200));
      }
    } finally {
      rodando.delete(esc);
      await db.query(`INSERT INTO financeiro_config (escritorio_id, ultima_execucao) VALUES ($1,$2::jsonb) ON CONFLICT (escritorio_id) DO UPDATE SET ultima_execucao = EXCLUDED.ultima_execucao`, [esc, JSON.stringify({ ...resumo, dia: L.data, quem: quem || null })]).catch(() => { });
      await log('regua_cobranca', { detalhe: `${resumo.geradas} geradas · ${resumo.boletos} boletos · ${resumo.enviados} envios · ${resumo.falhas} falhas` });
    }
    return resumo;
  }
  async function verificarAgenda() {
    const escs = await db.query(`SELECT e.id, fc.ultima_execucao FROM escritorios e LEFT JOIN financeiro_config fc ON fc.escritorio_id = e.id`).catch(() => []);
    const L = agoraLocal();
    for (const x of escs) {
      const cfg = await A.configEscritorio(x.id); if (!cfg.financeiro) continue;      // só depois que o escritório configurar a régua
      const conf = cfgFin(cfg); const algo = conf.gerarAuto || conf.lembreteAntes.ativo || conf.noVencimento.ativo || conf.regua.some(r => r.ativo); if (!algo || conf.pausado) continue;
      if (L.hora < Number(conf.hora ?? 9) || x.ultima_execucao?.dia === L.data || rodando.has(x.id)) continue;
      rodarRegua(x.id).catch(e => console.error('[financeiro] régua', e.message));
    }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => verificarAgenda().catch(() => { }), 60000).unref?.(); setInterval(() => verificarAgenda().catch(() => { }), 10 * 60000).unref?.(); }

  /* ---------- rotas ---------- */
  const urlAvisoInter = (esc, c) => `${CONFIG.urlApiPublica || ''}/api/publico/inter/${esc}/${c?.webhook_token || ''}`;
  r.get('/api/financeiro', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u, 'ver');
    const c = await cfgBanco(u.escritorio_id); const master = u.papel === 'master';
    return { provedor: B.provedor(c), falso: FALSO, ambiente: c?.ambiente || 'producao', conectado: temBanco(c), temChave: !!c?.api_key_cifrada,
      inter: { clientId: c?.inter_client_id ? c.inter_client_id.slice(0, 6) + '…' : '', temSecret: !!c?.inter_secret_cifrado, temCert: !!c?.inter_cert_cifrado, temKey: !!c?.inter_key_cifrada, conta: c?.inter_conta || '' },
      webhookUrl: c?.provedor === 'inter' ? (master ? urlAvisoInter(u.escritorio_id, c) : '') : `${CONFIG.urlApiPublica || ''}/api/publico/cobranca/${u.escritorio_id}/webhook`,
      webhookToken: c?.provedor === 'inter' ? '' : (master && c?.webhook_token) || (c?.webhook_token ? '••••' + c.webhook_token.slice(-4) : ''),
      ultima: c?.ultima_execucao || null, rodando: rodando.has(u.escritorio_id), podeConfigurar: master || pode(u, 'config', 'editar') };
  });
  r.put('/api/financeiro', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    if (!CONFIG.cofreChave) throw new ErroHttp(503, 'Cofre indisponível: falta a variável COFRE_CHAVE no servidor.');
    const b = ctx.corpo || {}; const atual = await cfgBanco(u.escritorio_id) || {};
    const provedor = ['inter', 'asaas'].includes(b.provedor) ? b.provedor : 'manual'; const ambiente = b.ambiente === 'sandbox' ? 'sandbox' : 'producao';
    const chave = String(b.apiKey || '').trim() ? cifrar(String(b.apiKey).trim()) : atual.api_key_cifrada || null;
    const pem = (t, tipo) => { const x = String(t || '').trim(); if (!x) return null; if (!/-----BEGIN [A-Z ]*(CERTIFICATE|PRIVATE KEY)-----/.test(x)) throw new ErroHttp(400, tipo === 'cert' ? 'O certificado precisa ser o arquivo .crt do Inter (texto começando com -----BEGIN CERTIFICATE-----).' : 'A chave precisa ser o arquivo .key do Inter (texto começando com -----BEGIN … PRIVATE KEY-----).'); return x; };
    const cert = pem(b.interCert, 'cert'), key = pem(b.interKey, 'key');
    if (cert && !/CERTIFICATE/.test(cert)) throw new ErroHttp(400, 'O arquivo do certificado não é um .crt.'); if (key && !/PRIVATE KEY/.test(key)) throw new ErroHttp(400, 'O arquivo da chave não é um .key.');
    const token = atual.webhook_token || crypto.randomBytes(24).toString('base64url');
    await db.query(`INSERT INTO financeiro_config (escritorio_id, provedor, ambiente, api_key_cifrada, webhook_token, inter_client_id, inter_secret_cifrado, inter_cert_cifrado, inter_key_cifrada, inter_conta, atualizado_por, atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) ON CONFLICT (escritorio_id) DO UPDATE SET provedor = EXCLUDED.provedor, ambiente = EXCLUDED.ambiente, api_key_cifrada = EXCLUDED.api_key_cifrada,
      webhook_token = EXCLUDED.webhook_token, inter_client_id = EXCLUDED.inter_client_id, inter_secret_cifrado = EXCLUDED.inter_secret_cifrado, inter_cert_cifrado = EXCLUDED.inter_cert_cifrado,
      inter_key_cifrada = EXCLUDED.inter_key_cifrada, inter_conta = EXCLUDED.inter_conta, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
    [u.escritorio_id, provedor, ambiente, chave, token, String(b.interClientId || '').trim() || atual.inter_client_id || null,
      String(b.interSecret || '').trim() ? cifrar(String(b.interSecret).trim()) : atual.inter_secret_cifrado || null, cert ? cifrar(cert) : atual.inter_cert_cifrado || null, key ? cifrar(key) : atual.inter_key_cifrada || null,
      b.interConta !== undefined ? String(b.interConta || '').replace(/\D/g, '') || null : atual.inter_conta || null, u.id]);
    await log('banco_configurado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${provedor} · ${ambiente}` });
    return { ok: true };
  }, { limite: 64 * 1024 });
  r.post('/api/financeiro/testar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    const c = await cfgBanco(u.escritorio_id);
    return { ok: true, texto: await B.testar(u.escritorio_id, urlAvisoInter(u.escritorio_id, c)) };
  });
  // confere no banco as cobranças em aberto (caso algum aviso de pagamento não tenha chegado)
  r.post('/api/financeiro/conferir', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    const ids = [].concat(ctx.corpo?.faturas || ctx.corpo?.faturaId || []).map(String).slice(0, 200); let pagas = 0;
    for (const id of ids) { const f = await A.registro(u.escritorio_id, 'faturas', id); if (!f?.boleto?.id || f.status === 'paga') continue;
      const st = await B.consultar(u.escritorio_id, f.boleto.provedor, f.boleto.id).catch(() => null); if (st?.pago) { await pagamentoConfirmado(u.escritorio_id, f.id, st); pagas++; } }
    return { ok: true, pagas };
  });
  // só no teste local: simula o pagamento de um boleto
  r.post('/api/financeiro/simular-pagamento', async ctx => {
    if (!FALSO) throw new ErroHttp(404, 'Não encontrado.');
    const u = await exigir(ctx, { site: 'painel' }); const f = await A.registro(u.escritorio_id, 'faturas', String(ctx.corpo?.faturaId || ''));
    if (!f?.boleto?.id) throw new ErroHttp(409, 'Fatura sem boleto.'); await B.simularPago(u.escritorio_id, f.boleto.id);
    await pagamentoConfirmado(u.escritorio_id, f.id, { valor: f.valor, data: agoraLocal().data, forma: 'PIX' }); return { ok: true };
  });
  r.post('/api/financeiro/gerar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    const b = ctx.corpo || {}; const comp = /^\d{4}-\d{2}$/.test(b.comp || '') ? b.comp : agoraLocal().comp;
    const novas = await gerarMensalidades(u.escritorio_id, comp, { quem: u.nome, empresas: Array.isArray(b.empresas) && b.empresas.length ? b.empresas.map(String) : null });
    const conf = cfgFin(await A.configEscritorio(u.escritorio_id)); const banco = temBanco(await cfgBanco(u.escritorio_id));
    let boletos = 0, enviados = 0; const falhas = [];
    for (const f of novas) {
      if (banco && (b.boleto ?? conf.boletoAuto)) { try { await emitirBoleto(u.escritorio_id, f.id, u.nome); boletos++; } catch (er) { falhas.push(er.message); } }
      if (b.enviar) { try { await enviarFatura(u.escritorio_id, f.id, { etapa: 'envio', canais: conf.envioAoGerar.canais, quem: u.nome }); enviados++; } catch (er) { falhas.push(er.message); } }
    }
    return { ok: true, geradas: novas.length, boletos, enviados, falhas: [...new Set(falhas)].slice(0, 5) };
  });
  r.post('/api/financeiro/boleto', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    const ids = [].concat(ctx.corpo?.faturas || ctx.corpo?.faturaId || []).map(String).slice(0, 300);
    const ok = [], falhas = [];
    for (const id of ids) { try { await emitirBoleto(u.escritorio_id, id, u.nome); ok.push(id); } catch (er) { falhas.push(er.message); } }
    if (ids.length === 1 && falhas.length) throw new ErroHttp(502, falhas[0]);
    return { ok: true, emitidos: ok.length, falhas: [...new Set(falhas)].slice(0, 5) };
  });
  r.post('/api/financeiro/enviar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    if (limitar(`fin-envio:${u.id}`, 300, 3600).bloqueado) throw new ErroHttp(429, 'Muitos envios seguidos. Aguarde alguns minutos.');
    const b = ctx.corpo || {}; const ids = [].concat(b.faturas || b.faturaId || []).map(String).slice(0, 300);
    const canais = (Array.isArray(b.canais) ? b.canais : ['whatsapp', 'email']).filter(x => ['whatsapp', 'email', 'portal'].includes(x));
    const res = {}; let enviados = 0; const falhas = [];
    for (const id of ids) { try { res[id] = await enviarFatura(u.escritorio_id, id, { etapa: b.etapa === 'envio' ? 'envio' : 'manual', canais, mensagem: String(b.mensagem || '').slice(0, 1500) || undefined, quem: u.nome }); enviados++; } catch (er) { falhas.push(er.message); }
      if (ids.length > 1) await new Promise(ok => setTimeout(ok, FALSO ? 10 : 900)); }
    if (ids.length === 1 && falhas.length) throw new ErroHttp(409, falhas[0]);
    return { ok: true, enviados, resultados: res, falhas: [...new Set(falhas)].slice(0, 5) };
  }, { limite: 64 * 1024 });
  r.post('/api/financeiro/baixa', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    const b = ctx.corpo || {}; const f = await A.registro(u.escritorio_id, 'faturas', String(b.faturaId || '')); if (!f) throw new ErroHttp(404, 'Fatura não encontrada.');
    const data = /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : agoraLocal().data; const valor = r2(b.valor || f.valor);
    if (f.boleto?.id && f.boleto?.provedor) await B.baixarNoBanco(u.escritorio_id, f.boleto.provedor, f.boleto.id, data, valor);
    const novo = { ...f, status: 'paga', pagaEm: data, valorPago: valor, formaPagamento: String(b.forma || 'Manual').slice(0, 40), baixaPor: u.nome, baixaEm: new Date().toISOString() };
    await A.gravar(u.escritorio_id, 'faturas', f.id, f.empresaId, novo);
    await log('fatura_baixa', { usuarioId: u.id, ip: ctx.ip, detalhe: `${f.empresaId} · ${f.comp} · ${brl(valor)}` });
    if (ganchos.faturaPaga) await ganchos.faturaPaga(u.escritorio_id, novo).catch(() => { });
    return { ok: true };
  });
  r.post('/api/financeiro/cancelar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u, 'excluir');
    const b = ctx.corpo || {}; const f = await A.registro(u.escritorio_id, 'faturas', String(b.faturaId || '')); if (!f) throw new ErroHttp(404, 'Fatura não encontrada.');
    if (f.status === 'paga') throw new ErroHttp(409, 'Fatura paga não pode ser cancelada.');
    if (f.boleto?.id && f.boleto?.provedor) await B.cancelar(u.escritorio_id, f.boleto.provedor, f.boleto.id, b.motivo || 'Cancelada pelo escritório');
    await A.gravar(u.escritorio_id, 'faturas', f.id, f.empresaId, { ...f, status: 'cancelada', canceladaEm: new Date().toISOString(), canceladaPor: u.nome, motivoCancelamento: String(b.motivo || '').slice(0, 300) });
    return { ok: true };
  });
  r.post('/api/financeiro/regua', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    return { ok: true, resumo: await rodarRegua(u.escritorio_id, { manual: true, quem: u.nome }) };
  });
  // aviso do banco (Asaas, legado) de pagamento recebido: baixa automática
  r.post('/api/publico/cobranca/:esc/webhook', async ctx => {
    const esc = String(ctx.params.esc || ''); if (!/^[0-9a-f-]{36}$/.test(esc)) throw new ErroHttp(404, 'Não encontrado.');
    const c = await cfgBanco(esc); const tk = String(ctx.req.headers['asaas-access-token'] || '');
    if (!c?.webhook_token || tk.length !== c.webhook_token.length || !crypto.timingSafeEqual(Buffer.from(tk), Buffer.from(c.webhook_token))) throw new ErroHttp(401, 'Token inválido.');
    const ev = ctx.corpo || {}; const p = ev.payment || {}; const fid = String(p.externalReference || '');
    if (!fid) return { ok: true };
    if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH'].includes(ev.event)) {
      await pagamentoConfirmado(esc, fid, { valor: p.value, liquido: p.netValue, data: p.paymentDate || p.clientPaymentDate || p.confirmedDate, forma: { BOLETO: 'Boleto', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito' }[p.billingType] || p.billingType || 'Banco' });
      return { ok: true };
    }
    if (fid.startsWith('ativ-')) return { ok: true };
    const f = await A.registro(esc, 'faturas', fid); if (!f) return { ok: true };
    if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'].includes(ev.event) && f.status === 'paga') {
      await A.gravar(esc, 'faturas', f.id, f.empresaId, { ...f, status: 'aberta', estornadaEm: new Date().toISOString() });
    } else if (ev.event === 'PAYMENT_DELETED' && f.boleto?.id === p.id) {
      const { boleto, ...resto } = f; await A.gravar(esc, 'faturas', f.id, f.empresaId, resto);
    }
    return { ok: true };
  }, { semCabecalhoSite: true, limite: 64 * 1024 });

  /* ---------- renovação do certificado digital: cobrança no banco (boleto + QR Code PIX) ---------- */
  async function ticketRenovacao(ctx) {
    const u = await exigir(ctx); const t = await A.registro(u.escritorio_id, 'tickets', String(ctx.params.id || ''));
    if (!t?.renovacao) throw new ErroHttp(404, 'Pedido de renovação não encontrado.');
    if (u.ambiente === 'cliente' && !(u.empresas || []).some(x => String(x.id) === String(t.empresaId))) throw new ErroHttp(403, 'Sem acesso a esta empresa.');
    return { u, t };
  }
  r.post('/api/renovacao/:id/cobranca', async ctx => {
    const { u, t } = await ticketRenovacao(ctx); const esc = u.escritorio_id;
    if (t.renovacao.status === 'pago') return { ok: true, pago: true, cobranca: t.renovacao.cobranca || null };
    if (t.renovacao.cobranca?.id) return { ok: true, cobranca: t.renovacao.cobranca, falso: FALSO };
    if (limitar(`renov:${u.id}`, 10, 3600).bloqueado) throw new ErroHttp(429, 'Muitas tentativas. Aguarde um pouco.');
    const c = await cfgBanco(esc); if (!temBanco(c) || B.provedor(c) === 'manual') throw new ErroHttp(412, 'O escritório ainda não conectou o banco: pague pela chave PIX do escritório.');
    const e = await A.empresa(esc, t.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const cfg = await A.configEscritorio(esc); const valor = r2(Number(cfg.valorRenovacaoCert || 180));   // valor vem do escritório, não do pedido
    const b = await B.emitir(esc, { ref: 'cert-' + t.id, e, valor, venc: addDias(agoraLocal().data, 3), descricao: 'Renovação do certificado digital A1' });
    const cobranca = { provedor: b.provedor, id: b.id, pix: b.pix, linha: b.linha, link: b.link || '', venc: b.venc, valor, arquivoId: b.arquivo?.id || null, url: b.arquivo?.url || '', emitidaEm: new Date().toISOString() };
    const atual = await A.registro(esc, 'tickets', t.id);
    await A.gravar(esc, 'tickets', t.id, t.empresaId, { ...atual, renovacao: { ...atual.renovacao, valor, cobranca }, eventos: [...(atual.eventos || []), { em: cobranca.emitidaEm, autor: 'Sistema', texto: `Cobrança da renovação gerada no banco (${brl(valor)}, boleto + PIX, vence ${fmtData(b.venc)}).` }] });
    return { ok: true, cobranca, falso: FALSO };
  }, { limite: 8 * 1024 });
  r.post('/api/renovacao/:id/verificar', async ctx => {
    const { u, t } = await ticketRenovacao(ctx); const cb = t.renovacao.cobranca;
    if (t.renovacao.status === 'pago') return { ok: true, pago: true };
    if (!cb?.id) throw new ErroHttp(409, 'Ainda não há cobrança no banco para este pedido.');
    const st = await B.consultar(u.escritorio_id, cb.provedor, cb.id);
    if (st.pago) await pagamentoConfirmado(u.escritorio_id, 'cert-' + t.id, st);
    return { ok: true, pago: !!st.pago, situacao: st.situacao };
  });
  // só no teste local
  r.post('/api/renovacao/:id/simular-pagamento', async ctx => {
    if (!FALSO) throw new ErroHttp(404, 'Não encontrado.');
    const { u, t } = await ticketRenovacao(ctx); if (t.renovacao.cobranca?.id) await B.simularPago(u.escritorio_id, t.renovacao.cobranca.id);
    await pagamentoConfirmado(u.escritorio_id, 'cert-' + t.id, { valor: t.renovacao.valor, data: agoraLocal().data, forma: 'PIX' }); return { ok: true };
  });

  // aviso do Inter: não é assinado, então só diz qual cobrança olhar; a situação é conferida no próprio Inter
  r.post('/api/publico/inter/:esc/:token', async ctx => {
    const esc = String(ctx.params.esc || ''); if (!/^[0-9a-f-]{36}$/.test(esc)) throw new ErroHttp(404, 'Não encontrado.');
    const c = await cfgBanco(esc); const tk = String(ctx.params.token || '');
    if (!c?.webhook_token || tk.length !== c.webhook_token.length || !crypto.timingSafeEqual(Buffer.from(tk), Buffer.from(c.webhook_token))) throw new ErroHttp(404, 'Não encontrado.');
    if (limitar(`inter-aviso:${esc}`, 600, 600).bloqueado) throw new ErroHttp(429, 'Muitos avisos.');
    const itens = [].concat(Array.isArray(ctx.corpo) ? ctx.corpo : ctx.corpo?.cobrancas || [ctx.corpo || {}]).slice(0, 100);
    for (const it of itens) {
      const id = String(it?.codigoSolicitacao || it?.cobranca?.codigoSolicitacao || ''); if (!id) continue;
      const ref = await B.refDe(esc, 'inter', id); if (!ref) continue;
      try { const st = await B.consultar(esc, 'inter', id); if (st.pago) await pagamentoConfirmado(esc, ref, st); }
      catch (er) { console.error('[inter] aviso', er.message); }
    }
    return { ok: true };
  }, { semCabecalhoSite: true, limite: 256 * 1024 });

  return { gerarMensalidades, emitirBoleto, enviarFatura, rodarRegua, cfgBanco, temBanco, banco: B, pagamentoConfirmado };
}
