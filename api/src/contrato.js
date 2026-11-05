// Contrato de prestação de serviços contábeis (Resolução CFC nº 1.590/2020) e comissões do comercial.
//
// Contrato: gerado em PDF automaticamente quando o cadastro é ativado (pagamento confirmado ou voucher), com os dados
// do cadastro, do plano e do contador responsável técnico (Configurações › Contrato). O comercial baixa, coleta as
// assinaturas e anexa o contrato assinado no cadastro. A Meu Fiscal aparece só como plataforma tecnológica.
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

export function montarContrato({ cfg, e, numero, data, financeiro = {} }) {
  const C = cfgContrato(cfg); const p = planoDe(e.plano?.nome || e.ativacao?.planoNome, e.regime); const at = e.ativacao || {};
  const valor = r2(e.plano?.valor || at.valor || p.preco); const dia = Number(e.plano?.diaVenc) || 10;
  const multa = Number(financeiro.multa ?? 2), juros = Number(financeiro.juros ?? 1);
  const en = e.endereco || {};
  const endCliente = [en.logradouro, en.numero || 'S/N', en.complemento, en.bairro, `${e.municipio || ''}/${e.uf || ''}`, en.cep ? 'CEP ' + fmtCep(en.cep) : ''].filter(x => x && x !== '/').join(', ');
  const rep = e.representante || e.contatos?.[0] || {};
  const B = []; const h = t => B.push({ t: 'h', texto: t }); const p_ = t => B.push({ t: 'p', texto: t }); const li = (t, m) => B.push({ t: 'li', texto: t, marcador: m });
  let n = 0; const cl = t => h(`CLÁUSULA ${++n}ª – ${t}`);

  B.push({ t: 'titulo', texto: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS PROFISSIONAIS CONTÁBEIS' });
  B.push({ t: 'subtitulo', texto: `Contrato nº ${numero} · celebrado nos termos da Resolução CFC nº 1.590/2020` });
  h('CONTRATANTE');
  B.push({ t: 'quadro', itens: [['Razão social', e.razao], ['Nome fantasia', e.fantasia || '—'], ['CNPJ', fmtDoc(e.cnpj)], ['Endereço', endCliente || '—'], ['E-mail / WhatsApp', [e.email, e.telefone].filter(Boolean).join(' · ')],
    ['Representante legal', [rep.nome, rep.cpf ? 'CPF ' + fmtDoc(rep.cpf) : ''].filter(Boolean).join(', ') || '—']] });
  h('CONTRATADO');
  B.push({ t: 'quadro', itens: [['Contador', C.contador || '—'], ['Registro', C.crc || '—'], ['CPF/CNPJ', fmtDoc(C.contadorDoc) || '—'], ['Endereço profissional', C.contadorEndereco || '—'],
    ['Contato', [cfg.email, cfg.telefone].filter(Boolean).join(' · ') || '—']] });
  p_(`As partes acima qualificadas celebram o presente contrato, que se rege pelas cláusulas a seguir e pela legislação aplicável, em especial o Código Civil, a Resolução CFC nº 1.590/2020 e o Código de Ética Profissional do Contador (NBC PG 01).`);

  cl('DO OBJETO');
  p_(`O CONTRATADO, contador regularmente registrado no Conselho Regional de Contabilidade, prestará ao CONTRATANTE os serviços profissionais contábeis do plano "${p.nome}"${p.sobMedida ? ' (condições sob medida)' : ''}, descritos na cláusula seguinte, assumindo a responsabilidade técnica por eles.`);
  cl('DOS SERVIÇOS CONTRATADOS');
  p_('Serviços permanentes e habituais, executados mensal ou anualmente, inclusos nos honorários mensais:');
  p.servicos.forEach(s => li(s));
  p_('Serviços eventuais, não inclusos e cobrados à parte mediante orçamento prévio aceito pelo CONTRATANTE: alterações contratuais e baixa de empresa (salvo quando o plano os incluir), regularização de períodos anteriores ao início deste contrato, retificações motivadas por informações incorretas ou entregues fora do prazo pelo CONTRATANTE, parcelamentos, defesas e recursos administrativos, certidões especiais, perícias, auditorias, consultorias e declarações de imposto de renda de pessoas físicas não previstas no plano.');
  if (p.folha) p_(`Funcionários e sócios na folha acima do limite do plano serão cobrados em adicional mensal${Number(e.plano?.adicionalFunc) > 0 ? ' de ' + brl(e.plano.adicionalFunc) + ' por pessoa' : ', conforme tabela vigente'}.`);
  cl('DOS SERVIÇOS EXECUTADOS PELO CONTRATANTE');
  p_('Cabe ao próprio CONTRATANTE, sem responsabilidade do CONTRATADO:');
  ['emitir as notas fiscais de suas vendas e serviços, inclusive pelo emissor integrado ao portal;', 'pagar nos vencimentos as guias de tributos, encargos e honorários disponibilizadas no portal;',
    'enviar mensalmente, pelo portal e até o dia 5 do mês seguinte, os documentos e informações necessários (notas fiscais de entrada e saída, extratos, folha e demais documentos solicitados);',
    'manter o certificado digital válido e informar alterações cadastrais, societárias, de atividade, de funcionários e de endereço;', 'acompanhar as notificações de órgãos públicos e repassá-las ao CONTRATADO em até 5 (cinco) dias úteis do recebimento;',
    'guardar os documentos originais pelo prazo legal e responder pela veracidade, integridade e licitude das informações e documentos entregues.'].forEach(t => li(t, '–'));
  cl('DA PLATAFORMA MEU FISCAL');
  p_(`Os serviços são prestados por meio da plataforma tecnológica Meu Fiscal${C.marca ? ' (marca ' + C.marca + ')' : ''}, utilizada pelo CONTRATADO como ferramenta de atendimento, envio e guarda de documentos, emissão de guias e relatórios. A plataforma não presta serviços contábeis, não exerce responsabilidade técnica e não substitui o CONTRATADO, que é o único responsável técnico pelos serviços deste contrato. O uso da plataforma também observa os Termos de Uso e a Política de Privacidade aceitos no portal.`);
  cl('DO PRAZO');
  p_(`Este contrato vigora por prazo indeterminado a partir de ${porExtenso(data)}, abrangendo os serviços a partir da competência ${String(e.inicioControle || data).slice(5, 7)}/${String(e.inicioControle || data).slice(0, 4)}. Os fatos anteriores a essa competência não são de responsabilidade do CONTRATADO.`);
  cl('DOS HONORÁRIOS E DO PAGAMENTO');
  p_(`Pelos serviços permanentes e habituais, o CONTRATANTE pagará honorários mensais de ${brl(valor)}, com vencimento todo dia ${dia} do mês seguinte ao da competência, por boleto ou PIX emitidos pela plataforma. A primeira mensalidade${at.total !== undefined ? ', no valor de ' + brl(at.total) + (at.desconto ? ' (com desconto de ' + brl(at.desconto) + (at.voucher?.codigo ? ', cupom ' + at.voucher.codigo : '') + ')' : '') : ''}, foi paga na ativação do cadastro.`);
  if (at.voucher && Number(at.voucher.meses) > 1) p_(`O desconto do cupom ${at.voucher.codigo} vale para as ${at.voucher.meses} primeiras mensalidades; depois, volta a valer o valor integral.`);
  p_(`Os serviços eventuais serão pagos conforme orçamento aprovado. O atraso no pagamento acarreta multa de ${multa}% e juros de ${juros}% ao mês, e o atraso superior a 30 (trinta) dias permite ao CONTRATADO suspender a execução dos serviços após aviso ao CONTRATANTE, sem prejuízo da cobrança.`);
  cl('DO REAJUSTE');
  p_(`Os honorários serão reajustados anualmente, no mês de aniversário do contrato, pela variação acumulada do ${C.reajuste} dos últimos 12 meses, ou por outro índice oficial que o substitua. Mudança de plano, de regime tributário, de volume de notas ou de funcionários pode alterar o valor mediante aditivo.`);
  cl('DAS RESPONSABILIDADES DO CONTRATADO');
  ['executar os serviços com zelo, diligência e observância das Normas Brasileiras de Contabilidade e da legislação;', 'manter sigilo sobre as informações do CONTRATANTE, salvo obrigação legal;',
    'disponibilizar as guias no portal com antecedência mínima de 3 (três) dias do vencimento, sempre que os documentos tiverem sido entregues no prazo;', 'responder pelos erros técnicos a que der causa, corrigindo-os sem custo;',
    'manter seu registro profissional regular no CRC durante toda a vigência do contrato.'].forEach(t => li(t, '–'));
  p_('O CONTRATADO não responde por multas, juros ou prejuízos decorrentes de documentos ou informações não entregues, entregues fora do prazo, incompletos ou incorretos, nem por guias não pagas ou decisões tomadas pelo CONTRATANTE.');
  cl('DOS ADITIVOS');
  p_('Qualquer alteração de plano, de serviços ou de honorários será formalizada por termo aditivo, inclusive por meio eletrônico com registro do aceite na plataforma.');
  cl('DA CARTA DE RESPONSABILIDADE DA ADMINISTRAÇÃO');
  p_('O CONTRATANTE fornecerá anualmente ao CONTRATADO, por ocasião do encerramento do exercício, a Carta de Responsabilidade da Administração, nos termos do art. 3º da Resolução CFC nº 1.590/2020, quando aplicável ao seu porte e regime. A recusa será analisada pelo CONTRATADO, que adotará as salvaguardas cabíveis.');
  cl('DA LEI Nº 9.613/1998 (PREVENÇÃO À LAVAGEM DE DINHEIRO)');
  p_('O CONTRATANTE declara ter ciência de que o CONTRATADO está sujeito à Lei nº 9.613/1998 e às normas do CFC sobre prevenção à lavagem de dinheiro e ao financiamento do terrorismo, devendo comunicar ao COAF as operações e propostas de operações previstas na norma, sem que isso configure quebra de sigilo.');
  cl('DA PROTEÇÃO DE DADOS');
  p_('As partes tratarão os dados pessoais envolvidos apenas para a execução deste contrato e o cumprimento de obrigações legais, conforme a Lei nº 13.709/2018 (LGPD), adotando medidas de segurança adequadas.');
  cl('DA RESCISÃO E DO DISTRATO');
  p_(`Qualquer das partes pode rescindir este contrato, sem multa, mediante aviso prévio por escrito de ${C.avisoPrevio} (${C.avisoPrevio === 30 ? 'trinta' : C.avisoPrevio}) dias, inclusive por e-mail ou pela plataforma, período em que os serviços e honorários seguem normalmente. O descumprimento de cláusula ou a inadimplência superior a 60 (sessenta) dias permite a rescisão imediata.`);
  p_('O encerramento será formalizado por distrato, que indicará a forma e o prazo de devolução dos documentos e arquivos do CONTRATANTE. O CONTRATADO cumprirá as obrigações acessórias cujos fatos geradores ocorreram durante a vigência, ainda que vençam depois, e comunicará ao novo responsável técnico os fatos de que este precise ter conhecimento.');
  cl('DO FORO');
  p_(`Fica eleito o foro da comarca de ${C.foro} para dirimir as questões deste contrato, com renúncia a qualquer outro, por mais privilegiado que seja.`);
  p_('E, por estarem de acordo, as partes assinam este contrato em duas vias de igual teor, ou eletronicamente, na presença das testemunhas abaixo.');
  B.push({ t: 'assinaturas', local: `${C.foro.split('/')[0]}, ${porExtenso(data)}.`, itens: [{ nome: String(e.razao || '').toUpperCase(), detalhe: 'CONTRATANTE' + (rep.nome ? ' · ' + rep.nome : '') }, { nome: (C.contador || 'CONTRATADO').toUpperCase(), detalhe: 'CONTRATADO · ' + (C.crc || '') },
    { nome: 'Testemunha 1: ____________________', detalhe: 'CPF:' }, { nome: 'Testemunha 2: ____________________', detalhe: 'CPF:' }] });
  return gerarPdf({ blocos: B, rodape: `Contrato nº ${numero} · ${e.razao}`, titulo: `Contrato ${numero}` });
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

  return { gerarContrato, gerarComissao, aoAtivar, aoFaturaPaga };
}

