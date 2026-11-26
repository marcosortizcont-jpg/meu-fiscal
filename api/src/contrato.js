// Contrato de prestação de serviços contábeis (Resolução CFC nº 1.590/2020) e comissões do comercial.
//
// Contrato: gerado em PDF automaticamente quando o cadastro é ativado (pagamento confirmado ou voucher), com os dados
// do cadastro, do plano e do contador responsável técnico (Configurações › Contrato). O comercial baixa, coleta as
// assinaturas e anexa o contrato assinado no cadastro. O contrato é só entre o contador e o cliente (sem marca de plataforma).
//
// Comissões: quem cadastrou o cliente recebe um percentual (padrão 30%) do 1º pagamento. A comissão nasce "a pagar"
// no Financeiro › Comissões; cada usuário vê as próprias em Comercial › Minhas comissões. Fica numa tabela própria
// (não sincroniza com os navegadores), para um comercial não ver a comissão do outro.
import { ErroHttp } from './http.js';
import { gerarPdf } from './pdf.js';
import { planoDe } from './planos.js';
import { criarApoio, soDig, brl, fmtData, agoraLocal, marcaDe } from './apoio.js';

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const fmtDoc = d => { d = soDig(d); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d; };
const fmtCep = c => soDig(c).replace(/^(\d{5})(\d{3})$/, '$1-$2');
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const porExtenso = d => { const [a, m, dd] = String(d).slice(0, 10).split('-'); return `${Number(dd)} de ${MESES[Number(m) - 1]} de ${a}`; };
export const PLANOS_COMISSAO = ['p1', 'p13', 'p135'];
const PARCELAS_PLANO = { p1: [1], p13: [1, 3], p135: [1, 3, 5] };
const PADRAO_CONTRATO = { foro: 'Campo Grande/MS', reajuste: 'IPCA', avisoPrevio: 30, comissaoPct: 30 };

// configuração do contrato e o que falta preencher para gerar
export function cfgContrato(cfg) {
  const c = { ...PADRAO_CONTRATO, ...(cfg.contrato || {}) };
  const contador = String(c.contadorNome || cfg.responsavelTecnico || cfg.escritorio || '').replace(/\s*([·|-]\s*)?contabilidade\s*$/i, '').trim();
  const faltam = [!contador && 'nome do contador', !String(cfg.crc || '').trim() && 'registro no CRC', !soDig(c.contadorDoc) && 'CPF ou CNPJ do contador', !String(c.contadorEndereco || '').trim() && 'endereço profissional do contador'].filter(Boolean);
  return { ...c, contador, crc: String(cfg.crc || '').trim(), marca: marcaDe(cfg), faltam };
}

// Serviços do contrato: lista padrão por porte e regime, sem textos comerciais do plano.
function servicosContrato(e, p) {
  const mei = e.regime === 'MEI';
  const folha = Math.max(0, Number(e.plano?.funcInclusos ?? p.folha ?? 0) || 0);
  const icms = !!soDig(e.ie) || e.regimeId === 'reg2-sn-com-ie' || p.grupo === 'Comércio';
  if (mei) return [
    'Apuração e emissão mensal do Documento de Arrecadação do Simples Nacional do Microempreendedor Individual (DAS-MEI);',
    'Elaboração e transmissão da Declaração Anual do Simples Nacional do MEI (DASN-SIMEI);',
    'Acompanhamento do limite anual de receita bruta e orientação sobre o desenquadramento, quando cabível;',
    'Orientação sobre o relatório mensal das receitas brutas e sobre a emissão de documentos fiscais;',
    ...(folha ? ['Rotinas trabalhistas e previdenciárias do empregado do MEI (folha de pagamento, eSocial, DCTFWeb e FGTS Digital);'] : []),
    'Orientação técnica sobre as obrigações relativas aos serviços contratados.',
  ];
  return [
    'Escrituração contábil de acordo com as Normas Brasileiras de Contabilidade e elaboração das demonstrações contábeis exigidas para o porte e o regime da empresa;',
    'Escrituração fiscal e apuração mensal dos tributos devidos no regime tributário da empresa, com a emissão das respectivas guias de recolhimento;',
    ...(icms ? ['Apuração do ICMS e cumprimento das obrigações acessórias estaduais;'] : []),
    'Elaboração e transmissão das obrigações acessórias federais, estaduais e municipais, mensais e anuais, decorrentes das atividades da empresa;',
    folha ? `Folha de pagamento, pró-labore, encargos sociais e respectivas obrigações (eSocial, DCTFWeb e FGTS Digital), de até ${folha} ${folha === 1 ? 'pessoa' : 'pessoas'} entre sócios e empregados;`
      : 'Cálculo do pró-labore dos sócios, dos encargos correspondentes e das respectivas obrigações (eSocial e DCTFWeb);',
    'Orientação técnica sobre as obrigações contábeis, fiscais e trabalhistas relativas aos serviços contratados.',
  ];
}

export function montarContrato({ cfg, e, numero, data, financeiro = {}, alteracao = null }) {
  const C = cfgContrato(cfg); const p = planoDe(e.plano?.nome || e.ativacao?.planoNome, e.regime, cfg?.planosPrecos);
  const valor = r2(e.plano?.valor || e.ativacao?.valor || p.preco); const dia = Number(e.plano?.diaVenc) || 10;
  const multa = Number(financeiro.multa ?? 2), juros = Number(financeiro.juros ?? 1);
  const en = e.endereco || {};
  const endCliente = [en.logradouro, en.numero || 'S/N', en.complemento, en.bairro, `${e.municipio || ''}/${e.uf || ''}`, en.cep ? 'CEP ' + fmtCep(en.cep) : ''].filter(x => x && x !== '/').join(', ');
  const rep = e.representante || e.contatos?.[0] || {};
  const folha = Math.max(0, Number(e.plano?.funcInclusos ?? p.folha ?? 0) || 0);
  const B = []; const h = t => B.push({ t: 'h', texto: t }); const p_ = t => B.push({ t: 'p', texto: t }); const li = (t, m) => B.push({ t: 'li', texto: t, marcador: m });
  let n = 0; const cl = t => h(`CLÁUSULA ${++n}ª – ${t}`);
  const comp = d => `${String(d).slice(5, 7)}/${String(d).slice(0, 4)}`;

  B.push({ t: 'titulo', texto: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS PROFISSIONAIS CONTÁBEIS' });
  B.push({ t: 'subtitulo', texto: `Contrato nº ${numero}${alteracao ? ' · termo de alteração' : ''}` });
  h('CONTRATANTE');
  B.push({ t: 'quadro', itens: [['Razão social', e.razao], ['CNPJ', fmtDoc(e.cnpj)], ['Endereço', endCliente || '—'],
    ['Representante legal', [rep.nome, rep.cpf ? 'CPF ' + fmtDoc(rep.cpf) : ''].filter(Boolean).join(', ') || '—']] });
  h('CONTRATADO');
  B.push({ t: 'quadro', itens: [['Contador', C.contador || '—'], ['Registro no CRC', C.crc || '—'], ['CPF/CNPJ', fmtDoc(C.contadorDoc) || '—'], ['Endereço profissional', C.contadorEndereco || '—']] });
  p_('As partes acima qualificadas celebram o presente contrato de prestação de serviços profissionais contábeis, que se rege pelas cláusulas seguintes, pelo Código Civil, pela Resolução CFC nº 1.590/2020 e pelo Código de Ética Profissional do Contador (NBC PG 01).');
  if (alteracao) p_(`Este instrumento substitui, a partir de ${porExtenso(data)}, o contrato nº ${alteracao.anterior?.numero || '—'}${alteracao.anterior?.valor ? ', cujos honorários mensais eram de ' + brl(alteracao.anterior.valor) : ''}, em razão de ${alteracao.tipo === 'reajuste' ? 'reajuste de honorários' : 'alteração dos serviços contratados'}${alteracao.motivo ? ' (' + alteracao.motivo + ')' : ''}. Até essa data permanecem válidas as condições do contrato anterior.`);

  cl('DO OBJETO');
  p_('O presente contrato tem por objeto a prestação, pelo CONTRATADO, dos serviços profissionais contábeis relacionados na cláusula seguinte, sob sua responsabilidade técnica, de acordo com as Normas Brasileiras de Contabilidade e a legislação aplicável.');
  cl('DOS SERVIÇOS');
  p_('Serviços permanentes e habituais, incluídos nos honorários mensais:');
  servicosContrato(e, p).forEach(s => li(s));
  p_('Serviços eventuais, não incluídos nos honorários mensais, que dependem de orçamento prévio aprovado pelo CONTRATANTE: constituição, alteração e baixa de empresa; obtenção e renovação de alvarás, licenças e certidões especiais; regularização de períodos anteriores ao início deste contrato; retificações motivadas por informações incorretas ou entregues fora do prazo pelo CONTRATANTE; parcelamentos, defesas e recursos administrativos; declaração de imposto de renda de pessoa física; perícias, auditorias e consultorias específicas.');
  if (folha) p_(`Pessoas na folha de pagamento acima do limite indicado acima serão cobradas em adicional mensal${Number(e.plano?.adicionalFunc) > 0 ? ' de ' + brl(e.plano.adicionalFunc) + ' por pessoa' : ', mediante orçamento'}.`);

  cl('DAS OBRIGAÇÕES DO CONTRATANTE');
  ['entregar ao CONTRATADO, até o dia 5 (cinco) do mês seguinte ao da competência, todos os documentos e informações necessários à execução dos serviços, tais como notas fiscais de entrada e saída, extratos bancários, informações de folha de pagamento e demais documentos solicitados;',
    'emitir os documentos fiscais de suas operações e recolher, nos vencimentos, os tributos, encargos e honorários;',
    'manter válido o certificado digital da empresa e comunicar previamente ao CONTRATADO qualquer alteração cadastral, societária, de atividade, de endereço ou de pessoal;',
    'repassar ao CONTRATADO, em até 5 (cinco) dias úteis do recebimento, as notificações, intimações e comunicações de órgãos públicos;',
    'guardar os documentos originais pelo prazo legal e responder pela veracidade, integridade e licitude das informações e documentos fornecidos.'].forEach(t => li(t, '–'));
  p_('A entrega de documentos e informações poderá ser feita fisicamente ou por meio eletrônico indicado pelo CONTRATADO, valendo o registro de envio como comprovante.');

  cl('DAS OBRIGAÇÕES E RESPONSABILIDADES DO CONTRATADO');
  ['executar os serviços com zelo, diligência e observância das Normas Brasileiras de Contabilidade e da legislação vigente;', 'manter sigilo sobre as informações a que tiver acesso, salvo nos casos previstos em lei;',
    'disponibilizar ao CONTRATANTE as guias de recolhimento com antecedência razoável do vencimento, desde que os documentos tenham sido entregues no prazo;', 'corrigir, sem custo para o CONTRATANTE, os erros técnicos a que der causa;',
    'manter regular o seu registro no Conselho Regional de Contabilidade durante toda a vigência do contrato.'].forEach(t => li(t, '–'));
  p_('O CONTRATADO não responde por multas, juros ou prejuízos decorrentes de documentos ou informações não entregues, entregues fora do prazo, incompletos ou incorretos, nem pelo não recolhimento de tributos ou por decisões tomadas pelo CONTRATANTE contra a sua orientação.');

  cl('DO PRAZO');
  p_(`Este contrato vigora por prazo indeterminado a partir de ${porExtenso(data)} e abrange os serviços a partir da competência ${comp(e.inicioControle || data)}. Os fatos ocorridos antes dessa competência não são de responsabilidade do CONTRATADO.`);

  cl('DOS HONORÁRIOS');
  p_(`Pelos serviços permanentes e habituais, o CONTRATANTE pagará ao CONTRATADO honorários mensais de ${brl(valor)}${alteracao ? ', a partir da competência ' + comp(data) : ''}, com vencimento no dia ${dia} do mês seguinte ao da competência, por boleto bancário, PIX ou outro meio indicado pelo CONTRATADO.`);
  p_(`Os serviços eventuais serão pagos conforme o orçamento aprovado. O atraso no pagamento acarreta multa de ${multa}% e juros de ${juros}% ao mês sobre o valor devido. O atraso superior a 30 (trinta) dias permite ao CONTRATADO suspender a execução dos serviços, mediante comunicação prévia por escrito, sem prejuízo da cobrança.`);
  p_(`Os honorários serão reajustados anualmente, no mês de aniversário do contrato, pela variação acumulada do ${C.reajuste} nos últimos 12 (doze) meses, ou por outro índice oficial que o substitua. Mudanças no volume de documentos, no número de pessoas na folha, no regime tributário ou nos serviços poderão alterar os honorários, mediante termo aditivo.`);

  cl('DOS ADITIVOS');
  p_('Qualquer alteração dos serviços ou dos honorários será formalizada por termo aditivo ou novo instrumento, assinado pelas partes, inclusive eletronicamente.');
  cl('DA CARTA DE RESPONSABILIDADE DA ADMINISTRAÇÃO');
  p_('O CONTRATANTE fornecerá ao CONTRATADO, ao final de cada exercício, a Carta de Responsabilidade da Administração, nos termos da Resolução CFC nº 1.590/2020, confirmando que as informações e documentos entregues são completos e verdadeiros.');
  cl('DA PREVENÇÃO À LAVAGEM DE DINHEIRO');
  p_('O CONTRATANTE declara ciência de que o CONTRATADO está sujeito à Lei nº 9.613/1998 e às normas do Conselho Federal de Contabilidade sobre prevenção à lavagem de dinheiro e ao financiamento do terrorismo, inclusive quanto às comunicações ao COAF nelas previstas, sem que isso configure quebra de sigilo profissional.');
  cl('DA PROTEÇÃO DE DADOS');
  p_('As partes tratarão os dados pessoais envolvidos somente para a execução deste contrato e o cumprimento de obrigações legais e regulatórias, conforme a Lei nº 13.709/2018 (LGPD), adotando medidas de segurança adequadas.');
  cl('DA RESCISÃO');
  p_(`Qualquer das partes poderá rescindir este contrato, sem multa, mediante aviso prévio por escrito de ${C.avisoPrevio} (${C.avisoPrevio === 30 ? 'trinta' : C.avisoPrevio}) dias, período em que os serviços e os honorários seguem normalmente. O descumprimento de qualquer cláusula ou a inadimplência superior a 60 (sessenta) dias autoriza a rescisão imediata.`);
  p_('A rescisão será formalizada por distrato, com a indicação da data de encerramento da responsabilidade técnica e a devolução dos documentos e arquivos do CONTRATANTE mediante protocolo. O CONTRATADO cumprirá as obrigações acessórias cujos fatos geradores tenham ocorrido durante a vigência do contrato e prestará ao profissional que o suceder as informações de que este necessite, nos termos das normas profissionais.');
  cl('DO FORO');
  p_(`Fica eleito o foro da comarca de ${C.foro} para dirimir as questões decorrentes deste contrato, com renúncia a qualquer outro, por mais privilegiado que seja.`);
  p_('E, por estarem de acordo, as partes assinam o presente instrumento em 2 (duas) vias de igual teor, ou eletronicamente, na presença das testemunhas abaixo.');
  B.push({ t: 'assinaturas', local: `${C.foro.split('/')[0]}, ${porExtenso(data)}.`, itens: [{ nome: String(e.razao || '').toUpperCase(), detalhe: 'CONTRATANTE' + (rep.nome ? ' · ' + rep.nome : '') }, { nome: (C.contador || 'CONTRATADO').toUpperCase(), detalhe: 'CONTRATADO · ' + (C.crc || '') },
    { nome: 'Testemunha 1: ____________________', detalhe: 'CPF:' }, { nome: 'Testemunha 2: ____________________', detalhe: 'CPF:' }] });
  return gerarPdf({ blocos: B, rodape: `Contrato nº ${numero} · ${e.razao}`, titulo: `Contrato ${numero}`, produtor: C.contador || 'Contrato' });
}

export function registrarContratos(r, { db, exigir, log, pode }) {
  const A = criarApoio(db);
  const podeComercial = u => u.papel === 'master' || pode(u, 'comercial', 'editar') || pode(u, 'carteira', 'editar');
  const podeFin = u => u.papel === 'master' || pode(u, 'hon', 'editar');
  const numeroDe = (e, data) => `${String(data).slice(0, 4)}-${String(e.id).replace(/^e-/, '').slice(-6).toUpperCase()}`;

  async function gerarContrato(esc, empresaId, quem) {
    const e = await A.empresa(esc, empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const cfg = await A.configEscritorio(esc); const C = cfgContrato(cfg);
    if (C.faltam.length) throw new ErroHttp(412, 'Para gerar o contrato, preencha em Configurações › Contrato: ' + C.faltam.join(', ') + '.');
    const data = String(e.ativadaEm || new Date().toISOString()).slice(0, 10); const numero = e.contrato?.numero || numeroDe(e, data);
    const buf = montarContrato({ cfg, e, numero, data: agoraLocal().data > data ? data : agoraLocal().data, financeiro: cfg.financeiro || {} });
    const a = await A.guardarArquivo(esc, e.id, buf, `Contrato ${numero} - ${String(e.razao).replace(/[^\wÀ-ú .-]/g, '').slice(0, 50)}.pdf`, 'application/pdf', 'contratos');
    const atual = await A.empresa(esc, empresaId);
    const contrato = { ...(atual.contrato || {}), numero, status: atual.contrato?.status === 'assinado' ? 'assinado' : 'aguardando_assinatura', arquivoId: a.id, url: a.url, nome: a.nome,
      geradoEm: new Date().toISOString(), geradoPor: quem || 'Automático', versao: Number(atual.contrato?.versao || 0) + 1, plano: atual.plano?.nome || '', valor: Number(atual.plano?.valor || 0) };
    await A.gravar(esc, 'empresas', e.id, e.id, { ...atual, contrato });
    await log('contrato_gerado', { detalhe: `${e.razao} · nº ${numero} · v${contrato.versao}` });
    return contrato;
  }

  /* ---------- alteração de plano (upgrade, reajuste, mudança): vale do 1º dia do próximo mês, com novo contrato ---------- */
  const proximaComp = () => { const L = agoraLocal(); const [a, m] = L.comp.split('-').map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`; };
  async function alterarPlano(esc, empresaId, b, u) {
    const e = await A.empresa(esc, empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (e.status === 'aguardando_pagamento') throw new ErroHttp(409, 'O cadastro ainda está aguardando o pagamento da ativação.');
    const cfg = await A.configEscritorio(esc); const C = cfgContrato(cfg);
    if (C.faltam.length) throw new ErroHttp(412, 'Para gerar o contrato, preencha em Configurações › Contrato: ' + C.faltam.join(', ') + '.');
    const valor = r2(b.valor); if (!(valor > 0)) throw new ErroHttp(400, 'Informe o novo valor mensal.');
    const nome = String(b.nome || '').trim().slice(0, 60); if (!nome) throw new ErroHttp(400, 'Informe o nome do plano.');
    const tipo = ['upgrade', 'reajuste', 'downgrade'].includes(b.tipo) ? b.tipo : (valor >= Number(e.plano?.valor || 0) ? 'upgrade' : 'downgrade');
    const comp = proximaComp(); const vigencia = comp + '-01';
    const novo = { ...(e.plano || {}), nome, valor, funcInclusos: Math.max(0, Number(b.funcInclusos ?? e.plano?.funcInclusos ?? 0)), adicionalFunc: Math.max(0, r2(b.adicionalFunc ?? e.plano?.adicionalFunc ?? 0)),
      diaVenc: Math.min(28, Math.max(1, Number(b.diaVenc || e.plano?.diaVenc || 10))) };
    const anterior = { numero: e.contrato?.numero || '', plano: e.plano?.nome || '', valor: Number(e.plano?.valor || 0) };
    const versao = (e.contratos || []).length + (e.contrato ? 2 : 1);
    const numero = `${String(e.contrato?.numero || numeroDe(e, vigencia)).replace(/-A\d+$/, '')}-A${versao - 1}`;
    const alteracao = { tipo, motivo: String(b.motivo || '').slice(0, 200), anterior, vigencia };
    const buf = montarContrato({ cfg, e: { ...e, plano: novo, inicioControle: comp, ativacao: {} }, numero, data: vigencia, financeiro: cfg.financeiro || {}, alteracao });
    const a = await A.guardarArquivo(esc, e.id, buf, `Contrato ${numero} - ${String(e.razao).replace(/[^\wÀ-ú .-]/g, '').slice(0, 50)}.pdf`, 'application/pdf', 'contratos');
    const agora = new Date().toISOString(); const atual = await A.empresa(esc, empresaId);
    const contratos = [...(atual.contratos || []), ...(atual.contrato ? [{ ...atual.contrato, substituidoEm: vigencia }] : [])].slice(-30);
    const contrato = { numero, status: 'aguardando_assinatura', arquivoId: a.id, url: a.url, nome: a.nome, geradoEm: agora, geradoPor: u.nome, versao, plano: nome, valor, vigencia, alteracao: { tipo, motivo: alteracao.motivo, anterior } };
    const planoAgendado = { ...novo, comp, vigencia, tipo, agendadoEm: agora, agendadoPor: u.nome, anterior };
    const hist = [...(atual.planosHistorico || []), { em: agora, por: u.nome, tipo, de: anterior, para: { nome, valor }, vigencia, contrato: numero }].slice(-50);
    await A.gravar(esc, 'empresas', atual.id, atual.id, { ...atual, contrato, contratos, planoAgendado, planosHistorico: hist });
    await atualizarFaturasAbertas(esc, { ...atual, plano: { ...atual.plano, ...novo } }, comp);
    await log('plano_alterado', { usuarioId: u.id, detalhe: `${e.razao} · ${anterior.plano} ${brl(anterior.valor)} → ${nome} ${brl(valor)} · a partir de ${vigencia} · contrato ${numero}` });
    return { planoAgendado, contrato };
  }
  // mensalidades já geradas a partir da vigência (abertas, sem boleto) passam a ter o valor novo
  async function atualizarFaturasAbertas(esc, e, compIni) {
    const fs = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'faturas' AND empresa_id = $2 AND dados->>'comp' >= $3 AND coalesce(dados->>'status','') IN ('aberta','')`, [esc, e.id, compIni])).map(x => x.dados);
    for (const f of fs) {
      if (f.boleto?.id || f.ativacao) continue;
      const base = { desc: 'Honorários · ' + (e.plano.nome || 'plano contábil'), valor: r2(e.plano.valor), tipo: 'base' };
      const itens = (f.itens || []).some(i => i.tipo === 'base') ? f.itens.map(i => i.tipo === 'base' ? { ...i, ...base } : i) : [base, ...(f.itens || [])];
      const valor = r2(Math.max(0, itens.reduce((s, i) => s + Number(i.valor || 0), 0) - Number(f.desconto || 0)));
      await A.gravar(esc, 'faturas', f.id, f.empresaId, { ...f, itens, valor, atualizadaPorPlano: new Date().toISOString() });
    }
  }
  // quando chega o mês: o plano agendado vira o plano atual
  async function aplicarAgendados(esc) {
    const comp = agoraLocal().comp;
    const es = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND dados ? 'planoAgendado' AND dados->'planoAgendado'->>'comp' <= $2`, [esc, comp])).map(x => x.dados);
    for (const e of es) {
      const { comp: c, vigencia, tipo, agendadoEm, agendadoPor, anterior, ...pl } = e.planoAgendado;
      const novo = { ...e, plano: { ...(e.plano || {}), ...pl, desde: vigencia } }; delete novo.planoAgendado;
      await A.gravar(esc, 'empresas', e.id, e.id, novo); await atualizarFaturasAbertas(esc, novo, c);
      await log('plano_aplicado', { detalhe: `${e.razao} · ${pl.nome} ${brl(pl.valor)} desde ${vigencia}` });
    }
  }
  const rodarAgendados = async () => { try { for (const { id } of await db.query('SELECT id FROM escritorios')) await aplicarAgendados(id); } catch (er) { console.error('[planos]', er.message); } };
  if (process.env.NODE_ENV !== 'test') { setTimeout(rodarAgendados, 20000).unref?.(); setInterval(rodarAgendados, 60 * 60000).unref?.(); }
  r.post('/api/planos/:id/alterar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeComercial(u)) throw new ErroHttp(403, 'Seu acesso não permite alterar planos.');
    return { ok: true, ...(await alterarPlano(u.escritorio_id, String(ctx.params.id), ctx.corpo || {}, u)) };
  }, { limite: 16 * 1024 });
  r.post('/api/planos/:id/cancelar-agendamento', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeComercial(u)) throw new ErroHttp(403, 'Seu acesso não permite alterar planos.');
    const e = await A.empresa(u.escritorio_id, String(ctx.params.id)); if (!e?.planoAgendado) throw new ErroHttp(409, 'Não há alteração agendada.');
    const ant = (e.contratos || []).slice(-1)[0];
    const novo = { ...e, contrato: ant ? (({ substituidoEm, ...x }) => x)(ant) : e.contrato, contratos: ant ? e.contratos.slice(0, -1) : e.contratos,
      planosHistorico: [...(e.planosHistorico || []), { em: new Date().toISOString(), por: u.nome, tipo: 'cancelado', de: { nome: e.planoAgendado.nome, valor: e.planoAgendado.valor }, vigencia: e.planoAgendado.vigencia }].slice(-50) };
    delete novo.planoAgendado;
    await A.gravar(u.escritorio_id, 'empresas', e.id, e.id, novo); await atualizarFaturasAbertas(u.escritorio_id, novo, e.planoAgendado.comp);
    await log('plano_agendamento_cancelado', { usuarioId: u.id, detalhe: e.razao });
    return { ok: true };
  });

  // plano de comissão do usuário que cadastrou: em quais honorários pagos (1º, 3º, 5º) nasce comissão
  async function planoDoUsuario(esc, uid) { const [x] = await db.query('SELECT comissao_plano FROM usuarios WHERE escritorio_id = $1 AND id = $2', [esc, uid]); return PARCELAS_PLANO[x?.comissao_plano] || PARCELAS_PLANO.p1; }
  async function gerarComissao(esc, e, { valorPago, data, parcela = 1 }) {
    const quem = e.cadastradoPor || (e.criadoPor ? { id: e.criadoPor, nome: e.criadoPorNome } : null);
    if (!quem?.id || !(Number(valorPago) > 0)) return null;
    if (!(await planoDoUsuario(esc, quem.id)).includes(parcela)) return null;
    const cfg = await A.configEscritorio(esc); const pct = Number(cfgContrato(cfg).comissaoPct) || 30;
    const valor = r2(Number(valorPago) * pct / 100);
    const [x] = await db.query(`INSERT INTO comissoes (escritorio_id, empresa_id, empresa_nome, usuario_id, usuario_nome, base, percentual, valor, referencia)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (escritorio_id, empresa_id, referencia) DO NOTHING RETURNING id`,
    [esc, e.id, e.fantasia || e.razao, quem.id, quem.nome || '', r2(valorPago), pct, valor, 'p' + parcela]);
    if (x) await log('comissao_gerada', { detalhe: `${quem.nome} · ${e.razao} · ${parcela}º honorário · ${brl(valor)} (${pct}% de ${brl(valorPago)})` });
    return x || null;
  }
  // a cada honorário pago: descobre se é o 3º ou o 5º pago do cliente (a 1ª é a ativação)
  async function aoFaturaPaga(esc, f) {
    if (!f?.empresaId || f.ativacao) return;
    const e = await A.empresa(esc, f.empresaId); if (!e || !(e.cadastradoPor || e.criadoPor)) return;
    const pagas = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'faturas' AND empresa_id = $2 AND dados->>'status' = 'paga'`, [esc, e.id])).map(x => x.dados)
      .sort((a, b) => String(a.comp || '').localeCompare(String(b.comp || '')) || String(a.pagaEm || '').localeCompare(String(b.pagaEm || '')));
    const n = pagas.findIndex(x => x.id === f.id) + 1; if (n < 2) return;
    await gerarComissao(esc, e, { valorPago: Number(f.valorPago || f.valor), data: f.pagaEm, parcela: n }).catch(er => console.error('[comissao]', er.message));
  }

  // chamado pela ativação do cadastro
  async function aoAtivar(esc, empresaId, { pago, valorPago, data }) {
    const e = await A.empresa(esc, empresaId); if (!e) return;
    if (pago) await gerarComissao(esc, e, { valorPago, data, parcela: 1 }).catch(er => console.error('[comissao]', er.message));
    await gerarContrato(esc, empresaId, 'Automático (ativação)').catch(async er => {
      const at = await A.empresa(esc, empresaId);
      await A.gravar(esc, 'empresas', at.id, at.id, { ...at, contrato: { ...(at.contrato || {}), status: 'pendente', erro: er.message } });
    });
  }

  /* ---------- contrato ---------- */
  r.post('/api/contratos/:id/gerar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeComercial(u)) throw new ErroHttp(403, 'Seu acesso não permite esta ação.');
    const e = await A.empresa(u.escritorio_id, ctx.params.id); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (e.status === 'aguardando_pagamento') throw new ErroHttp(409, 'O contrato é gerado depois que o pagamento da ativação for confirmado.');
    return { ok: true, contrato: await gerarContrato(u.escritorio_id, e.id, u.nome) };
  });
  r.post('/api/contratos/:id/assinado', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeComercial(u)) throw new ErroHttp(403, 'Seu acesso não permite esta ação.');
    const esc = u.escritorio_id; const e = await A.empresa(esc, ctx.params.id); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const arqId = String(ctx.corpo?.arquivoId || '');
    const [a] = await db.query('SELECT id, tipo FROM arquivos WHERE id = $1 AND escritorio_id = $2', [arqId, esc]);
    if (!a) throw new ErroHttp(400, 'Envie o arquivo do contrato assinado.');
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(a.tipo)) throw new ErroHttp(415, 'Envie o contrato assinado em PDF, JPG ou PNG.');
    const nome = String(ctx.corpo?.nome || 'Contrato assinado.pdf').slice(0, 120); const agora = new Date().toISOString();
    await db.query('UPDATE arquivos SET empresa_id = $1 WHERE id = $2 AND escritorio_id = $3', [e.id, a.id, esc]);
    const contrato = { ...(e.contrato || {}), status: 'assinado', assinado: { arquivoId: a.id, url: `/api/arquivos/${a.id}`, nome, em: agora, por: u.nome, uid: u.id, data: String(ctx.corpo?.data || '').slice(0, 10) || agoraLocal().data } };
    await A.gravar(esc, 'empresas', e.id, e.id, { ...e, contrato });
    await A.gravar(esc, 'documentos', 'doc-contrato-' + e.id, e.id, { id: 'doc-contrato-' + e.id, empresaId: e.id, categoria: 'Contrato de prestação de serviços', nome: `Contrato ${contrato.numero || ''} assinado`.replace('  ', ' '),
      arquivo: { id: a.id, url: `/api/arquivos/${a.id}`, nome, tipo: a.tipo }, enviadoEm: agora, uid: u.id, origem: 'contrato' });
    await log('contrato_assinado_anexado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao} · nº ${contrato.numero || ''}` });
    return { ok: true, contrato };
  }, { limite: 16 * 1024 });

  /* ---------- comissões ---------- */
  const linha = x => ({ id: x.id, empresaId: x.empresa_id, empresa: x.empresa_nome, usuarioId: x.usuario_id, usuario: x.usuario_nome, base: Number(x.base), percentual: Number(x.percentual), valor: Number(x.valor),
    referencia: x.referencia, parcela: /^p\d+$/.test(x.referencia) ? Number(x.referencia.slice(1)) : 1, status: x.status, geradaEm: x.criado_em, pagaEm: x.paga_em, forma: x.forma, obs: x.obs, pagoPor: x.pago_por_nome });
  r.get('/api/comissoes', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); const todos = podeFin(u) && ctx.query?.minhas !== '1';
    const xs = await db.query(`SELECT * FROM comissoes WHERE escritorio_id = $1 ${todos ? '' : 'AND usuario_id = $2'} ORDER BY criado_em DESC LIMIT 2000`, todos ? [u.escritorio_id] : [u.escritorio_id, u.id]);
    const cfg = await A.configEscritorio(u.escritorio_id); const [eu] = await db.query('SELECT comissao_plano FROM usuarios WHERE id = $1', [u.id]);
    return { comissoes: xs.map(linha), todos, percentual: Number(cfgContrato(cfg).comissaoPct) || 30, plano: eu?.comissao_plano || 'p1', podePagar: podeFin(u) };
  });
  r.post('/api/comissoes/pagar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeFin(u)) throw new ErroHttp(403, 'Só o master ou quem edita o Financeiro registra pagamento de comissão.');
    const b = ctx.corpo || {}; const ids = [].concat(b.ids || []).map(String).filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 500);
    if (!ids.length) throw new ErroHttp(400, 'Selecione as comissões.');
    const desfazer = b.desfazer === true;
    const xs = desfazer
      ? await db.query(`UPDATE comissoes SET status = 'a_pagar', paga_em = NULL, forma = NULL, pago_por_nome = NULL WHERE escritorio_id = $1 AND id = ANY($2::uuid[]) RETURNING *`, [u.escritorio_id, ids])
      : await db.query(`UPDATE comissoes SET status = 'paga', paga_em = $3, forma = $4, obs = $5, pago_por_nome = $6 WHERE escritorio_id = $1 AND id = ANY($2::uuid[]) AND status <> 'cancelada' RETURNING *`,
        [u.escritorio_id, ids, String(b.data || agoraLocal().data).slice(0, 10), String(b.forma || 'PIX').slice(0, 30), String(b.obs || '').slice(0, 200) || null, u.nome]);
    await log(desfazer ? 'comissao_pagamento_desfeito' : 'comissao_paga', { usuarioId: u.id, ip: ctx.ip, detalhe: `${xs.length} comissão(ões) · ${brl(xs.reduce((a, x) => a + Number(x.valor), 0))}` });
    return { ok: true, atualizadas: xs.length };
  });
  r.post('/api/comissoes/:id/cancelar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeFin(u)) throw new ErroHttp(403, 'Sem permissão.');
    const [x] = await db.query(`UPDATE comissoes SET status = 'cancelada', obs = $3 WHERE escritorio_id = $1 AND id = $2 AND status = 'a_pagar' RETURNING *`, [u.escritorio_id, ctx.params.id, String(ctx.corpo?.motivo || '').slice(0, 200) || null]);
    if (!x) throw new ErroHttp(409, 'Só comissões a pagar podem ser canceladas.');
    await log('comissao_cancelada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${x.usuario_nome} · ${x.empresa_nome} · ${brl(x.valor)}` });
    return { ok: true };
  });

  return { gerarContrato, gerarComissao, aoAtivar, aoFaturaPaga, aplicarAgendados };
}

