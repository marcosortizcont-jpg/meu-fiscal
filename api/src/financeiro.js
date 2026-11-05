// Financeiro do escritório: mensalidades (honorários), boletos/PIX pelo Asaas, baixa automática, régua de cobrança e envios.
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
import { criarApoio, soDig, pad, brl, fmtData, fmtComp, addMes, addDias, diasEntre, ultimoDia, agoraLocal } from './apoio.js';

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
  async function cfgBanco(esc) { const [c] = await db.query('SELECT * FROM financeiro_config WHERE escritorio_id = $1', [esc]); return c || null; }
  const temBanco = c => FALSO || !!(c && c.provedor === 'asaas' && c.api_key_cifrada);

  /* ---------- Asaas ---------- */
  async function asaas(c, metodo, caminho, corpo) {
    if (FALSO) return falsoAsaas(metodo, caminho, corpo);
    const rr = await fetch(ASAAS[c.ambiente === 'sandbox' ? 'sandbox' : 'producao'] + caminho, { method: metodo,
      headers: { access_token: decifrar(c.api_key_cifrada), 'Content-Type': 'application/json', 'User-Agent': 'MeuFiscal' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(30000) });
    const txt = await rr.text(); let j = null; try { j = JSON.parse(txt); } catch { }
    if (!rr.ok) { const m = (j?.errors || []).map(x => x.description).join(' ') || txt.slice(0, 200); throw new ErroHttp(rr.status === 401 ? 502 : 502, rr.status === 401 ? 'O Asaas recusou a chave da API. Confira em Integrações › Chaves de API no Asaas.' : 'Asaas: ' + m); }
    return j;
  }
  function falsoAsaas(metodo, caminho, corpo) {
    if (caminho.startsWith('/customers')) return metodo === 'GET' ? { data: [] } : { id: 'cus_' + crypto.randomUUID().slice(0, 8) };
    if (caminho === '/payments') { const id = 'pay_' + crypto.randomUUID().slice(0, 10); return { id, status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/' + id, bankSlipUrl: 'falso:' + id, value: corpo.value, dueDate: corpo.dueDate }; }
    if (/pixQrCode$/.test(caminho)) return { payload: '00020126580014br.gov.bcb.pix0136simulado5204000053039865802BR5913MEU FISCAL6009CAMPO GRANDE62070503***6304ABCD' };
    if (/identificationField$/.test(caminho)) return { identificationField: '34191.79001 01043.510047 91020.150008 1 ' + Date.now().toString().slice(-14) };
    if (/receiveInCash$/.test(caminho)) return { status: 'RECEIVED_IN_CASH' };
    if (metodo === 'DELETE') return { deleted: true };
    return {};
  }
  async function clienteAsaas(c, esc, e) {
    if (e.cobranca?.asaasId && e.cobranca?.ambiente === (c?.ambiente || 'falso')) return e.cobranca.asaasId;
    const doc = soDig(e.cnpj || e.cpf);
    let id = doc ? (await asaas(c, 'GET', '/customers?cpfCnpj=' + doc)).data?.[0]?.id : null;
    if (!id) {
      const email = (await A.emailsDaEmpresa(esc, e.id, e))[0];
      id = (await asaas(c, 'POST', '/customers', { name: e.razao || e.fantasia, cpfCnpj: doc || undefined, email, mobilePhone: soDig(e.telefone) || undefined, externalReference: e.id, notificationDisabled: true })).id;
    }
    await A.gravar(esc, 'empresas', e.id, e.id, { ...e, cobranca: { ...(e.cobranca || {}), asaasId: id, ambiente: c?.ambiente || 'falso' } });
    return id;
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
    const c = await cfgBanco(esc); if (!temBanco(c)) throw new ErroHttp(412, 'Conecte o banco (Asaas) em Financeiro › Régua e automação para emitir boletos.');
    const f = await A.registro(esc, 'faturas', faturaId); if (!f) throw new ErroHttp(404, 'Fatura não encontrada.');
    if (['paga', 'cancelada'].includes(f.status)) throw new ErroHttp(409, 'Esta fatura já está ' + (f.status === 'paga' ? 'paga' : 'cancelada') + '.');
    if (f.boleto?.provedor === 'asaas' && f.boleto.id) return f;
    const e = await A.empresa(esc, f.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (!soDig(e.cnpj || e.cpf)) throw new ErroHttp(400, 'A empresa está sem CNPJ no cadastro (o banco exige para o boleto).');
    const conf = cfgFin(await A.configEscritorio(esc)); const hoje = agoraLocal().data;
    const cliente = await clienteAsaas(c, esc, e);
    const p = await asaas(c, 'POST', '/payments', { customer: cliente, billingType: 'UNDEFINED', value: r2(f.valor), dueDate: f.venc < hoje ? hoje : f.venc,
      description: `Honorários contábeis ${fmtComp(f.comp)} · ${e.fantasia || e.razao}`.slice(0, 500), externalReference: f.id,
      fine: conf.multa ? { value: Number(conf.multa) } : undefined, interest: conf.juros ? { value: Number(conf.juros) } : undefined, postalService: false });
    const [pix, linha] = await Promise.all([asaas(c, 'GET', `/payments/${p.id}/pixQrCode`).catch(() => null), asaas(c, 'GET', `/payments/${p.id}/identificationField`).catch(() => null)]);
    let arquivo = null;
    try {
      const pdf = FALSO ? Buffer.from(`%PDF-1.4\n% boleto simulado ${p.id}\n%%EOF\n`) : Buffer.from(await (await fetch(p.bankSlipUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
      if (pdf.length > 100 && String(pdf.subarray(0, 4)) === '%PDF' || FALSO) arquivo = await A.guardarArquivo(esc, f.empresaId, pdf, `Boleto honorários ${f.comp.slice(5, 7)}-${f.comp.slice(0, 4)}.pdf`, 'application/pdf', 'boletos');
    } catch (er) { console.error('[financeiro] pdf do boleto', er.message); }
    const atual = await A.registro(esc, 'faturas', faturaId);
    const novo = { ...atual, boleto: { provedor: 'asaas', id: p.id, nome: arquivo?.nome || 'Boleto (link)', url: arquivo?.url || p.bankSlipUrl, arquivoId: arquivo?.id || null,
      linkPagamento: p.invoiceUrl, linhaDigitavel: linha?.identificationField || '', pixCopiaCola: pix?.payload || '', emitidoEm: new Date().toISOString(), emitidoPor: quem || 'Automático', venc: p.dueDate } };
    await A.gravar(esc, 'faturas', faturaId, f.empresaId, novo);
    return novo;
  }

  /* ---------- envio de mensagens (boleto, lembretes e cobrança) ---------- */
  async function textoPagamento(esc, f) {
    if (f.boleto?.linkPagamento) return `Pague por boleto ou PIX: ${f.boleto.linkPagamento}`;
    if (f.boleto?.linhaDigitavel) return `Linha digitável: ${f.boleto.linhaDigitavel}`;
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
      pagamento: pag, link: f.boleto?.linkPagamento || '', linha: f.boleto?.linhaDigitavel || '', pix: f.boleto?.pixCopiaCola || cfg.pix || '', escritorio: cfg.escritorio || '' }[k] ?? _)).trim();
    let anexo = null;
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
        const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#0F172A"><p style="font-size:18px;font-weight:700">${(cfg.escritorio || 'Meu Fiscal').replace(/[<>&]/g, '')}</p><p>${texto.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p></div>`;
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
  r.get('/api/financeiro', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u, 'ver');
    const c = await cfgBanco(u.escritorio_id);
    return { provedor: FALSO ? 'asaas' : c?.provedor || 'manual', falso: FALSO, ambiente: c?.ambiente || 'producao', conectado: temBanco(c), temChave: !!c?.api_key_cifrada,
      webhookUrl: `${CONFIG.urlApiPublica || ''}/api/publico/cobranca/${u.escritorio_id}/webhook`, webhookToken: (u.papel === 'master' && c?.webhook_token) || (c?.webhook_token ? '••••' + c.webhook_token.slice(-4) : ''),
      ultima: c?.ultima_execucao || null, rodando: rodando.has(u.escritorio_id), podeConfigurar: u.papel === 'master' || pode(u, 'config', 'editar') };
  });
  r.put('/api/financeiro', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    if (!CONFIG.cofreChave) throw new ErroHttp(503, 'Cofre indisponível: falta a variável COFRE_CHAVE no servidor.');
    const b = ctx.corpo || {}; const atual = await cfgBanco(u.escritorio_id) || {};
    const provedor = b.provedor === 'asaas' ? 'asaas' : 'manual'; const ambiente = b.ambiente === 'sandbox' ? 'sandbox' : 'producao';
    const chave = String(b.apiKey || '').trim() ? cifrar(String(b.apiKey).trim()) : atual.api_key_cifrada || null;
    const token = atual.webhook_token || crypto.randomBytes(24).toString('base64url');
    await db.query(`INSERT INTO financeiro_config (escritorio_id, provedor, ambiente, api_key_cifrada, webhook_token, atualizado_por, atualizado_em) VALUES ($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT (escritorio_id) DO UPDATE SET provedor = EXCLUDED.provedor, ambiente = EXCLUDED.ambiente, api_key_cifrada = EXCLUDED.api_key_cifrada, webhook_token = EXCLUDED.webhook_token, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
    [u.escritorio_id, provedor, ambiente, chave, token, u.id]);
    await log('banco_configurado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${provedor} · ${ambiente}` });
    return { ok: true };
  });
  r.post('/api/financeiro/testar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirMaster(u);
    const c = await cfgBanco(u.escritorio_id); if (!temBanco(c)) throw new ErroHttp(412, 'Informe a chave da API do Asaas e salve antes de testar.');
    await asaas(c, 'GET', '/customers?limit=1');
    return { ok: true, texto: FALSO ? 'Conexão simulada (teste local).' : `Conexão com o Asaas (${c.ambiente === 'sandbox' ? 'sandbox' : 'produção'}) funcionando.` };
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
    if (f.boleto?.provedor === 'asaas' && f.boleto.id) { const c = await cfgBanco(u.escritorio_id); if (temBanco(c)) await asaas(c, 'POST', `/payments/${f.boleto.id}/receiveInCash`, { paymentDate: data, value: valor, notifyCustomer: false }).catch(er => { if (!/já|already|received/i.test(er.message)) throw er; }); }
    const novo = { ...f, status: 'paga', pagaEm: data, valorPago: valor, formaPagamento: String(b.forma || 'Manual').slice(0, 40), baixaPor: u.nome, baixaEm: new Date().toISOString() };
    await A.gravar(u.escritorio_id, 'faturas', f.id, f.empresaId, novo);
    await log('fatura_baixa', { usuarioId: u.id, ip: ctx.ip, detalhe: `${f.empresaId} · ${f.comp} · ${brl(valor)}` });
    return { ok: true };
  });
  r.post('/api/financeiro/cancelar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u, 'excluir');
    const b = ctx.corpo || {}; const f = await A.registro(u.escritorio_id, 'faturas', String(b.faturaId || '')); if (!f) throw new ErroHttp(404, 'Fatura não encontrada.');
    if (f.status === 'paga') throw new ErroHttp(409, 'Fatura paga não pode ser cancelada.');
    if (f.boleto?.provedor === 'asaas' && f.boleto.id) { const c = await cfgBanco(u.escritorio_id); if (temBanco(c)) await asaas(c, 'DELETE', `/payments/${f.boleto.id}`).catch(() => { }); }
    await A.gravar(u.escritorio_id, 'faturas', f.id, f.empresaId, { ...f, status: 'cancelada', canceladaEm: new Date().toISOString(), canceladaPor: u.nome, motivoCancelamento: String(b.motivo || '').slice(0, 300) });
    return { ok: true };
  });
  r.post('/api/financeiro/regua', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirHon(u);
    return { ok: true, resumo: await rodarRegua(u.escritorio_id, { manual: true, quem: u.nome }) };
  });
  // aviso do banco (Asaas) de pagamento recebido: baixa automática
  r.post('/api/publico/cobranca/:esc/webhook', async ctx => {
    const esc = String(ctx.params.esc || ''); if (!/^[0-9a-f-]{36}$/.test(esc)) throw new ErroHttp(404, 'Não encontrado.');
    const c = await cfgBanco(esc); const tk = String(ctx.req.headers['asaas-access-token'] || '');
    if (!c?.webhook_token || tk.length !== c.webhook_token.length || !crypto.timingSafeEqual(Buffer.from(tk), Buffer.from(c.webhook_token))) throw new ErroHttp(401, 'Token inválido.');
    const ev = ctx.corpo || {}; const p = ev.payment || {}; const fid = String(p.externalReference || '');
    if (!fid) return { ok: true };
    // cobrança de ativação de um cadastro novo
    if (fid.startsWith('ativ-')) {
      if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH'].includes(ev.event) && ganchos.ativacaoPaga) await ganchos.ativacaoPaga(esc, fid.slice(5), p);
      return { ok: true };
    }
    const f = await A.registro(esc, 'faturas', fid); if (!f) return { ok: true };
    if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH'].includes(ev.event) && f.status !== 'paga') {
      await A.gravar(esc, 'faturas', f.id, f.empresaId, { ...f, status: 'paga', pagaEm: String(p.paymentDate || p.clientPaymentDate || p.confirmedDate || agoraLocal().data).slice(0, 10), valorPago: r2(p.value), valorLiquido: r2(p.netValue),
        formaPagamento: { BOLETO: 'Boleto', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito' }[p.billingType] || p.billingType || 'Banco', baixaAutomatica: true, baixaEm: new Date().toISOString() });
      await log('fatura_paga_banco', { detalhe: `${f.empresaId} · ${f.comp} · ${brl(p.value)}` });
    } else if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'].includes(ev.event) && f.status === 'paga') {
      await A.gravar(esc, 'faturas', f.id, f.empresaId, { ...f, status: 'aberta', estornadaEm: new Date().toISOString() });
    } else if (ev.event === 'PAYMENT_DELETED' && f.boleto?.id === p.id) {
      const { boleto, ...resto } = f; await A.gravar(esc, 'faturas', f.id, f.empresaId, resto);
    }
    return { ok: true };
  }, { semCabecalhoSite: true, limite: 64 * 1024 });

  return { gerarMensalidades, emitirBoleto, enviarFatura, rodarRegua, asaas, cfgBanco, temBanco, clienteAsaas };
}
