// Integra Contador (SERPRO/Receita Federal): emissão de guias pela API oficial, sem entrar nos portais com captcha.
//
// Guias:  DAS-MEI (PGMEI), DAS do Simples Nacional (PGDAS-D, depois da declaração transmitida),
//         DARF da DCTFWeb e parcelas dos parcelamentos do Simples Nacional e do MEI (PARCSN, PERTSN, RELPSN, PARCMEI…).
// O escritório contrata o Integra Contador na Loja Serpro e cadastra aqui: CNPJ contratante, Consumer Key/Secret e o
// e-CNPJ A1 do escritório. Cada cliente dá procuração eletrônica ao escritório no e-CAC. Segredos ficam cifrados.
// Parcelamentos comuns da Receita (fora do Simples) e da PGFN não estão no Integra Contador (PGFN é pelo Regularize).
import https from 'node:https';
import crypto from 'node:crypto';
import { ErroHttp } from './http.js';
import { cifrar, decifrar, lerCertificadoA1 } from './cofre.js';
import { CONFIG } from './config.js';
import { enviarEmail } from './externos.js';
import { limitar } from './seguranca.js';
import { criarApoio, soDig, pad, brl, fmtData, fmtComp, addMes, ultimoDia, agoraLocal, ajustarUtil, ultimoUtil, MESES } from './apoio.js';
export { agoraLocal } from './apoio.js';

const URL_AUTH = 'https://autenticacao.sapi.serpro.gov.br/authenticate';
const GATEWAY = { producao: 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/', demonstracao: 'https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1/' };
const TOKEN_DEMO = '06aef429-a981-3ec5-a1f8-71d38d86481e';           // token público do ambiente de demonstração (dados fictícios)
const FALSO = process.env.INTEGRA_FALSO === '1' && process.env.NODE_ENV !== 'production';   // só para testes locais

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MESES_SA = MESES.map(norm);
export const vencimentoDasMei = comp => ajustarUtil(`${addMes(comp, 1)}-20`, 'prorroga');
const ehMei = e => !!e && (e.regimeId === 'reg2-mei' || e.regime === 'MEI');
const ehSimples = e => !!e && (String(e.regimeId || '').startsWith('reg2-sn') || e.regime === 'SN');
const ativa = e => e && e.status !== 'inativo';

/* ---------- catálogo das guias emitidas pela API ---------- */
export const PROGRAMAS = {
  PARCSN: ['PARCSN', 'GERARDAS161', 'Parcelamento ordinário do Simples Nacional'], 'PARCSN-ESP': ['PARCSN-ESP', 'GERARDAS171', 'Parcelamento especial do Simples Nacional'],
  PERTSN: ['PERTSN', 'GERARDAS181', 'Pert do Simples Nacional'], RELPSN: ['RELPSN', 'GERARDAS191', 'Relp do Simples Nacional'],
  PARCMEI: ['PARCMEI', 'GERARDAS201', 'Parcelamento ordinário do MEI'], 'PARCMEI-ESP': ['PARCMEI-ESP', 'GERARDAS211', 'Parcelamento especial do MEI'],
  PERTMEI: ['PERTMEI', 'GERARDAS221', 'Pert do MEI'], RELPMEI: ['RELPMEI', 'GERARDAS231', 'Relp do MEI'],
};
const AAAAMM = c => c.replace('-', '');
export const SERVICOS = {
  mei: { nome: 'DAS-MEI', tipoGuia: 'DAS-MEI', cat: ['das-mei'], consolida: true, compAuto: -1, diaMax: 19,
    pedido: (comp, data) => ({ idSistema: 'PGMEI', idServico: 'GERARDASPDF21', dados: { periodoApuracao: AAAAMM(comp), ...(data ? { dataConsolidacao: data.replace(/-/g, '') } : {}) } }),
    venc: comp => vencimentoDasMei(comp), elegivel: e => ehMei(e) },
  das: { nome: 'DAS do Simples Nacional', tipoGuia: 'DAS', cat: ['pgdas'], consolida: true, compAuto: -1, diaMax: 19,
    pedido: (comp, data) => ({ idSistema: 'PGDASD', idServico: 'GERARDAS12', dados: { periodoApuracao: AAAAMM(comp), ...(data ? { dataConsolidacao: data.replace(/-/g, '') } : {}) } }),
    venc: comp => ajustarUtil(`${addMes(comp, 1)}-20`, 'prorroga'), elegivel: e => ehSimples(e) },
  dctfweb: { nome: 'DARF da DCTFWeb', tipoGuia: 'DCTFWeb', cat: ['dctfweb'], consolida: false, compAuto: -1, diaMax: 19,
    pedido: comp => ({ idSistema: 'DCTFWEB', idServico: 'GERARGUIA31', dados: { categoria: 'GERAL_MENSAL', anoPA: comp.slice(0, 4), mesPA: comp.slice(5, 7) } }),
    venc: comp => ajustarUtil(`${addMes(comp, 1)}-20`, 'antecipa'), elegivel: () => true },
  parc: { nome: 'Parcela de parcelamento', tipoGuia: 'Parcelamento', cat: ['parc-simples'], consolida: false, compAuto: 0, diaMax: 25,
    pedido: (comp, data, prog) => { const p = PROGRAMAS[prog]; if (!p) throw new ErroHttp(400, 'Programa de parcelamento inválido.'); return { idSistema: p[0], idServico: p[1], dados: { parcelaParaEmitir: AAAAMM(comp) } }; },
    venc: comp => ultimoUtil(comp), elegivel: () => true },
};
const nomeGuia = (s, prog) => s === 'parc' ? (PROGRAMAS[prog]?.[2] || 'Parcelamento') : SERVICOS[s].nome;

/* ---------- leitura de competência e data no texto do cliente ---------- */
export function lerCompetencia(texto, hojeL) {
  const t = norm(texto); const atual = hojeL.comp;
  if (/\b(mes passado|ultimo mes|mes anterior)\b/.test(t)) return addMes(atual, -1);
  if (/\b(este mes|esse mes|mes atual|deste mes|desse mes)\b/.test(t)) return atual;
  let m = t.match(/\b(0?[1-9]|1[0-2])\s*[\/\-.]\s*(20\d{2}|\d{2})\b/);
  if (m) { const a = m[2].length === 2 ? 2000 + +m[2] : +m[2]; return `${a}-${pad(+m[1])}`; }
  m = t.match(/\b(20\d{2})\s*[\/\-.]\s*(0?[1-9]|1[0-2])\b/); if (m) return `${m[1]}-${pad(+m[2])}`;
  const i = MESES_SA.findIndex(n => new RegExp(`\\b${n.slice(0, 3)}${n.length > 3 ? '(' + n.slice(3) + ')?' : ''}\\b`).test(t));
  if (i >= 0) {
    const m2 = t.match(new RegExp(MESES_SA[i].slice(0, 3) + '[a-z]*\\s*(?:\\/|-|de)\\s*(\\d{2})\\b'));
    const ano = (t.match(/\b(20\d{2})\b/) || [])[1] || (m2 ? '20' + m2[1] : null);
    if (ano) return `${ano}-${pad(i + 1)}`;
    const c = `${atual.slice(0, 4)}-${pad(i + 1)}`; return c > atual ? `${+atual.slice(0, 4) - 1}-${pad(i + 1)}` : c;
  }
  return null;
}
export function lerData(texto, hojeL) {
  const t = norm(texto); const h = new Date(hojeL.data + 'T12:00:00Z'); const iso = d => d.toISOString().slice(0, 10);
  if (/\bhoje\b/.test(t)) return hojeL.data;
  if (/\bdepois de amanha\b/.test(t)) return iso(new Date(h.getTime() + 2 * 86400000));
  if (/\bamanha\b/.test(t)) return iso(new Date(h.getTime() + 86400000));
  if (/\b(no |ate o |pelo )?vencimento\b/.test(t)) return 'venc';
  let m = t.match(/\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(20\d{2}|\d{2}))?\b/);
  if (m) { const a = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +hojeL.data.slice(0, 4); const d = `${a}-${pad(+m[2])}-${pad(+m[1])}`; return isNaN(Date.parse(d)) ? null : d; }
  m = t.match(/\bdia\s+(\d{1,2})\b/);
  if (m && +m[1] >= 1 && +m[1] <= 31) { const a = +hojeL.data.slice(0, 4), mm = +hojeL.data.slice(5, 7); return `${a}-${pad(mm)}-${pad(Math.min(+m[1], ultimoDia(a, mm)))}`; }
  return null;
}
const SIM = /^\s*(s|sim|isso|isso mesmo|pode|pode sim|pode mandar|pode enviar|confirmo|confirmado|ok|okay|certo|claro|correto|manda|envia|positivo|por favor|uhum|aham|👍)\b/i;
const NAO = /^\s*(n|nao|não|negativo|errado|nao e|não é)\b/i;
const PEDE_GUIA = /\b(das|guia|guias|boleto|boletos|2\s*[ªao°]?\s*via|segunda via|imposto do mei|carne do mei|darf|parcela|parcelamento)\b/i;
const CANCELA = /\b(cancela|cancelar|deixa pra la|deixa para la|esquece|nao precisa|desisto)\b/i;

/* ---------- leitura genérica da resposta (os serviços devolvem formatos diferentes) ---------- */
function acharPdf(x, prof = 0) {
  if (prof > 6 || x == null) return null;
  if (typeof x === 'string') { if (x.length > 200 && /^JVBER/.test(x)) return x; if (/^\s*[\[{]/.test(x)) { try { return acharPdf(JSON.parse(x), prof + 1); } catch { } } return null; }
  if (Array.isArray(x)) { for (const y of x) { const p = acharPdf(y, prof + 1); if (p) return p; } return null; }
  if (typeof x === 'object') { for (const k of Object.keys(x)) { if (/pdf/i.test(k) && typeof x[k] === 'string' && x[k].length > 200) return x[k]; } for (const k of Object.keys(x)) { const p = acharPdf(x[k], prof + 1); if (p) return p; } }
  return null;
}
function acharCampo(x, re, prof = 0) {
  if (prof > 6 || x == null || typeof x !== 'object') return undefined;
  for (const k of Object.keys(x)) if (re.test(k) && (typeof x[k] === 'string' || typeof x[k] === 'number')) return x[k];
  for (const k of Object.keys(x)) { const v = acharCampo(x[k], re, prof + 1); if (v !== undefined) return v; }
  return undefined;
}
const num = x => { if (x == null || x === '') return 0; const s = String(x); return Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s) || 0; };
const dataIso = v => { const s = String(v || ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? `${s.slice(6)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : null; };

export function registrarIntegra(r, { db, exigir, log, pode, wa }) {
  const A = criarApoio(db);
  const exigirConfig = (u, nivel = 'editar') => { if (u.papel !== 'master' && !pode(u, 'config', nivel)) throw new ErroHttp(403, 'Só o master (ou quem edita Configurações) altera a integração com a Receita.'); };
  const tokens = new Map();      // escritório → { access, jwt, expira }
  const estados = new Map();     // conversa → { etapa, servico, programa, comp, data, expira }

  async function cfgIntegra(esc) { const [c] = await db.query('SELECT * FROM integra_config WHERE escritorio_id = $1', [esc]); return c || null; }
  const pronto = c => (!!c && (c.ambiente === 'demonstracao' || (c.cnpj && c.consumer_key && c.consumer_secret_cifrado && c.pfx_cifrado))) || FALSO;

  /* ---------- HTTP com certificado (mTLS) ---------- */
  function requisitar(url, { metodo = 'POST', cabecalhos = {}, corpo = '', pfx, senha, timeout = 40000 }) {
    return new Promise((ok, falha) => {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: metodo, headers: { ...cabecalhos, 'Content-Length': Buffer.byteLength(corpo) }, ...(pfx ? { pfx, passphrase: senha } : {}), timeout }, res => {
        const partes = []; res.on('data', d => partes.push(d));
        res.on('end', () => { const txt = Buffer.concat(partes).toString('utf8'); let json = null; try { json = JSON.parse(txt); } catch { } ok({ status: res.statusCode, json, txt }); });
      });
      req.on('timeout', () => req.destroy(new Error('A Receita não respondeu a tempo. Tente de novo em alguns minutos.')));
      req.on('error', e => falha(new ErroHttp(502, /mac verify|passphrase|PKCS12/i.test(e.message) ? 'Senha do certificado do escritório incorreta.' : e.message)));
      req.end(corpo);
    });
  }
  async function token(c, forcar) {
    if (c.ambiente === 'demonstracao') return { access: TOKEN_DEMO, jwt: TOKEN_DEMO };
    const t = tokens.get(c.escritorio_id); if (t && !forcar && t.expira > Date.now() + 60000) return t;
    const pfx = decifrar(c.pfx_cifrado, false), senha = decifrar(c.senha_cifrada), segredo = decifrar(c.consumer_secret_cifrado);
    const rr = await requisitar(URL_AUTH, { pfx, senha, corpo: 'grant_type=client_credentials',
      cabecalhos: { Authorization: 'Basic ' + Buffer.from(`${c.consumer_key}:${segredo}`).toString('base64'), 'Role-Type': 'TERCEIROS', 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (rr.status !== 200 || !rr.json?.access_token) {
      const m = rr.json?.error_description || rr.json?.message || rr.txt.slice(0, 200);
      throw new ErroHttp(502, rr.status === 401 ? 'A SERPRO recusou a Consumer Key/Secret ou o certificado. Confira os dados do contrato na Área do Cliente Serpro.' : 'Falha na autenticação com a SERPRO: ' + (m || 'HTTP ' + rr.status));
    }
    const novo = { access: rr.json.access_token, jwt: rr.json.jwt_token || '', expira: Date.now() + (Number(rr.json.expires_in) || 1800) * 1000 };
    tokens.set(c.escritorio_id, novo); return novo;
  }
  async function chamar(c, tipo, contribuinte, pedido) {
    const corpo = JSON.stringify({ contratante: { numero: soDig(c.cnpj) || '00000000000000', tipo: 2 }, autorPedidoDados: { numero: soDig(c.cnpj) || '00000000000000', tipo: 2 },
      contribuinte: { numero: soDig(contribuinte), tipo: soDig(contribuinte).length === 11 ? 1 : 2 }, pedidoDados: { versaoSistema: '1.0', ...pedido, dados: JSON.stringify(pedido.dados || {}) } });
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const t = await token(c, tentativa > 0);
      const rr = await requisitar(GATEWAY[c.ambiente] + tipo, { corpo, cabecalhos: { Authorization: 'Bearer ' + t.access, jwt_token: t.jwt, 'Content-Type': 'application/json', Accept: 'application/json' } });
      if (rr.status === 401 && tentativa === 0) continue;
      const msgs = (rr.json?.mensagens || []).map(m => `${m.texto || ''}`.trim()).filter(Boolean);
      if (rr.status !== 200) {
        let m = msgs.join(' ') || rr.json?.message || rr.txt.slice(0, 200) || 'HTTP ' + rr.status;
        if (/procura/i.test(m) || rr.status === 403) m = 'Sem procuração eletrônica do cliente para o escritório no e-CAC. ' + m;
        throw new ErroHttp(rr.status === 429 ? 429 : 502, m);
      }
      let dados = rr.json?.dados; if (typeof dados === 'string') { try { dados = JSON.parse(dados); } catch { } }
      return { dados, mensagens: msgs };
    }
  }
  async function gerarPdf(c, cnpj, servico, comp, dataConsolidacao, programa) {
    const S = SERVICOS[servico]; const vencNormal = S.venc(comp);
    if (FALSO) {
      if (soDig(cnpj).endsWith('0000')) throw new ErroHttp(502, 'Sem procuração eletrônica do cliente para o escritório no e-CAC. (simulação)');
      const base = { mei: 81.05, das: 1834.27, dctfweb: 912.4, parc: 455.9 }[servico];
      const atraso = dataConsolidacao && dataConsolidacao > vencNormal; const multa = atraso ? Math.round(base * 0.075 * 100) / 100 : 0, juros = atraso ? Math.round(base * 0.01 * 100) / 100 : 0;
      return { pdf: Buffer.from(`%PDF-1.4\n% ${servico} ${programa || ''} ${cnpj} ${comp} (simulado)\n%%EOF\n`), venc: dataConsolidacao || vencNormal, numero: '07' + Date.now().toString().slice(-14), valores: { principal: base, multa, juros, total: Math.round((base + multa + juros) * 100) / 100 } };
    }
    const { dados: d } = await chamar(c, 'Emitir', cnpj, S.pedido(comp, dataConsolidacao, programa));
    const pdf64 = acharPdf(d);
    if (!pdf64) throw new ErroHttp(502, `A Receita não devolveu o PDF (${nomeGuia(servico, programa)} de ${fmtComp(comp)}). Pode já estar paga, sem valor devido${servico === 'das' ? ', ou o PGDAS-D do mês ainda não foi transmitido' : servico === 'dctfweb' ? ', ou a DCTFWeb ainda não foi transmitida' : servico === 'parc' ? ', ou não há parcela disponível neste mês' : ''}.`);
    const venc = dataIso(acharCampo(d, /^data(Vencimento|Validade|LimiteAcolhimento|Arrecadacao)$/i)) || dataConsolidacao || vencNormal;
    const principal = num(acharCampo(d, /^(principal|valorPrincipal)$/i)), multa = num(acharCampo(d, /^(multa|valorMulta)$/i)), juros = num(acharCampo(d, /^(juros|valorJuros)$/i));
    const total = num(acharCampo(d, /^(total|valorTotal|valorTotalConsolidado|valor|valorDocumento|valorParcela)$/i)) || principal + multa + juros;
    return { pdf: Buffer.from(pdf64, 'base64'), venc, numero: String(acharCampo(d, /^(numeroDocumento|numeroDas|numero)$/i) || ''), valores: { principal: principal || total, multa, juros, total } };
  }

  const registrarExec = (esc, x) => db.query('INSERT INTO integra_execucoes (escritorio_id, origem, empresa_id, comp, ok, valor, mensagem, lote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [esc, x.origem, x.empresaId || null, x.comp || null, !!x.ok, x.valor ?? null, String((x.servico && x.servico !== 'mei' ? '[' + nomeGuia(x.servico, x.programa) + '] ' : '') + (x.mensagem || '')).slice(0, 500), x.lote || null]).catch(() => { });
  async function guiaDaComp(esc, empresaId, tipoGuia, comp, programa) {
    const g = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'guias' AND empresa_id = $2 AND dados->>'comp' = $3 AND dados->>'tipo' = $4
      AND ($5::text IS NULL OR coalesce(dados->>'programa','') = $5) ORDER BY (dados->>'origem' IN ('pgmei','receita')) DESC, atualizado_em DESC`, [esc, String(empresaId), comp, tipoGuia, programa || null]);
    return g[0]?.dados || null;
  }

  /* Emite (ou reaproveita) a guia, publica em "Guias e impostos" do portal e dá baixa na obrigação do mês. */
  async function emitirGuia({ esc, empresaId, servico = 'mei', programa, comp, dataPagamento, origem, quem, reaproveitar = true }) {
    const S = SERVICOS[servico]; if (!S) throw new ErroHttp(400, 'Tipo de guia inválido.');
    const c = await cfgIntegra(esc); if (!pronto(c)) throw new ErroHttp(412, 'A integração com a Receita (Integra Contador) ainda não foi configurada em Configurações.');
    const e = await A.empresa(esc, empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (!S.elegivel(e)) throw new ErroHttp(400, servico === 'mei' ? 'Esta empresa não está no regime MEI.' : 'Esta empresa não está no Simples Nacional.');
    if (servico === 'parc' && !PROGRAMAS[programa]) throw new ErroHttp(400, 'Escolha o programa de parcelamento.');
    if (soDig(e.cnpj).length !== 14) throw new ErroHttp(400, 'A empresa está sem CNPJ válido no cadastro.');
    if (!/^\d{4}-\d{2}$/.test(comp)) throw new ErroHttp(400, 'Competência inválida.');
    const L = agoraLocal(); if (comp > L.comp) throw new ErroHttp(400, 'Ainda não dá para gerar a guia de uma competência futura.');
    const vencNormal = S.venc(comp);
    let consolidar = null;
    if (S.consolida) {
      consolidar = dataPagamento && dataPagamento !== 'venc' ? dataPagamento : null;
      if (consolidar) {
        if (consolidar < L.data) throw new ErroHttp(400, 'A data de pagamento não pode ser anterior a hoje.');
        const fimMes = `${L.comp}-${pad(ultimoDia(+L.comp.slice(0, 4), +L.comp.slice(5, 7)))}`;
        if (consolidar > fimMes && consolidar > vencNormal) throw new ErroHttp(400, `Para pagar depois do vencimento, a data precisa ser até ${fmtData(fimMes)} (último dia deste mês).`);
        if (consolidar <= vencNormal) consolidar = null;    // dentro do prazo: guia normal, sem multa
      } else if (vencNormal < L.data) consolidar = L.data;    // vencida sem data informada: atualiza para hoje
    }
    const validade = consolidar || vencNormal;
    const existente = await guiaDaComp(esc, empresaId, S.tipoGuia, comp, servico === 'parc' ? programa : null);
    if (existente?.status === 'paga') throw new ErroHttp(409, `A guia de ${fmtComp(comp)} já consta como paga no sistema.`);
    if (reaproveitar && existente?.arquivo?.id && existente.venc && existente.venc >= validade && existente.venc >= L.data && existente.venc <= (consolidar ? validade : vencNormal)) {
      const pdf = await A.conteudoArquivo(existente.arquivo.id);
      if (pdf) return { guia: existente, pdf, arquivo: existente.arquivo, reaproveitada: true, empresa: e };
    }
    const lote = origem.lote || null; let rr;
    try { rr = await gerarPdf(c, e.cnpj, servico, comp, consolidar, programa); }
    catch (er) { await registrarExec(esc, { origem: origem.tipo, empresaId, comp, ok: false, mensagem: er.message, lote, servico, programa }); throw er; }
    const rot = servico === 'parc' ? programa : S.tipoGuia;
    const arquivo = await A.guardarArquivo(esc, String(empresaId), rr.pdf, `${rot} ${comp.slice(5, 7)}-${comp.slice(0, 4)} ${soDig(e.cnpj)}.pdf`, 'application/pdf', 'receita');
    const quando = new Date().toISOString();
    const g = { ...(existente || {}), id: existente?.id || (servico === 'mei' ? 'pgmei-' : 'rf-' + servico + (programa ? '-' + programa : '') + '-') + empresaId + '-' + comp, empresaId: String(empresaId),
      tipo: S.tipoGuia, depto: servico === 'dctfweb' ? 'Pessoal' : 'Fiscal', comp, valor: Math.round(rr.valores.total * 100) / 100, venc: rr.venc, status: 'liberada', arquivo, liberadaEm: quando,
      origem: servico === 'mei' ? 'pgmei' : 'receita', servico, ...(programa ? { programa, descricao: PROGRAMAS[programa][2] } : {}), numeroDocumento: rr.numero, valores: rr.valores,
      emitidaEm: quando, emitidaPor: quem || 'Integra Contador', ...(consolidar ? { atualizadaPara: consolidar } : {}) };
    await A.gravar(esc, 'guias', g.id, String(empresaId), g);
    // obrigação do mês: entregue, com o PDF e o histórico
    const [ob] = await db.query(`SELECT id, dados FROM registros WHERE escritorio_id = $1 AND colecao = 'obrigacoes' AND empresa_id = $2 AND dados->>'comp' = $3
      AND (dados->>'catId' = ANY($4::text[]) OR dados->>'tipo' = $5) LIMIT 1`, [esc, String(empresaId), comp, S.cat, S.tipoGuia]);
    const texto = `${fmtData(quando.slice(0, 10))} ${nomeGuia(servico, programa)} emitido(a) pela integração com a Receita (${brl(g.valor)}, pagamento até ${fmtData(g.venc)}) e publicado(a) em "Guias e impostos" do portal.`;
    const catNome = { mei: 'DAS-MEI', das: 'PGDAS-D', dctfweb: 'DCTFWeb', parc: 'Parcelamento do Simples Nacional' }[servico];
    const o = ob ? ob.dados : { id: crypto.randomUUID(), empresaId: String(empresaId), comp, tipo: catNome, prazo: vencNormal, depto: g.depto, catId: S.cat[0], status: 'pendente', criadaEm: quando, log: [] };
    o.arquivos = [...(o.arquivos || []), { ...arquivo, enviadoEm: quando }].slice(-10);
    o.log = [...(o.log || []), { em: quando, nome: quem || 'Integração', tipo: 'envio', texto }].slice(-200);
    // DAS do Simples: a obrigação (PGDAS-D) só fica entregue quando a equipe confirma a declaração; aqui só anexa a guia
    if (servico !== 'das' && !['entregue', 'dispensada'].includes(o.status)) { o.status = 'entregue'; o.concluidaEm = quando; o.protocolo = o.protocolo || ('Receita ' + (rr.numero || '')).trim(); }
    o.valorGuia = g.valor; o.publicarGuia = true;
    await A.gravar(esc, 'obrigacoes', o.id, String(empresaId), o);
    await registrarExec(esc, { origem: origem.tipo, empresaId, comp, ok: true, valor: g.valor, mensagem: `Emitido · pagamento até ${fmtData(g.venc)}`, lote, servico, programa });
    await log('guia_receita_emitida', { usuarioId: origem.uid || null, detalhe: `${e.razao || ''} · ${nomeGuia(servico, programa)} · ${comp} · ${brl(g.valor)} · ${origem.tipo}` });
    return { guia: g, pdf: rr.pdf, arquivo, reaproveitada: false, empresa: e };
  }
  const emitirDasMei = o => emitirGuia({ ...o, servico: 'mei' });

  const MSG_PADRAO = 'Olá, {nome}! Segue a guia {guia} de {competencia} da {empresa}: {valor}, com vencimento em {vencimento}. Ela também está no Portal do Cliente, em Guias e impostos.';
  const montarMsg = (modelo, x) => String(modelo || MSG_PADRAO).replace(/\{(\w+)\}/g, (_, k) => ({ nome: x.nome, empresa: x.empresa, competencia: fmtComp(x.comp), valor: brl(x.valor), vencimento: fmtData(x.venc), guia: x.guia }[k] ?? _));
  async function entregar({ esc, e, empresaId, emissao, canais, modelo }) {
    const res = {}; const g = emissao.guia;
    const legenda = montarMsg(modelo, { nome: String(e.socios?.[0]?.nome || e.fantasia || e.razao || '').split(' ')[0], empresa: e.fantasia || e.razao, comp: g.comp, valor: g.valor, venc: g.venc, guia: g.programa ? 'da parcela do ' + g.programa : g.tipo === 'DAS-MEI' ? 'DAS do MEI' : g.tipo === 'DAS' ? 'DAS do Simples Nacional' : 'DARF da DCTFWeb' });
    const anexo = { id: emissao.arquivo.id, nome: emissao.arquivo.nome, tipo: 'application/pdf', conteudo: emissao.pdf };
    if (canais.includes('whatsapp')) {
      try { const r2 = await wa.enviarArquivos({ esc, empresaId: String(empresaId), fone: e.telefone, anexos: [anexo], legenda, u: { id: null, nome: 'Envio automático de guias' } }); res.whatsapp = 'enviado para ' + r2.para; }
      catch (er) { res.whatsapp = 'não enviado: ' + er.message; }
    }
    if (canais.includes('email')) {
      const para = await A.emailsDaEmpresa(esc, empresaId, e);
      if (!para.length) res.email = 'sem e-mail cadastrado';
      else { const r3 = await enviarEmail({ para, assunto: `${g.programa || g.tipo} de ${fmtComp(g.comp)} · vence ${fmtData(g.venc)}`, texto: legenda, html: `<p>${legenda.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]))}</p>`, anexos: [anexo] }); res.email = r3.enviado ? 'enviado para ' + para.join(', ') : 'não enviado: ' + (r3.motivo || 'falha'); }
    }
    return res;
  }

  /* ---------- rotinas mensais automáticas ---------- */
  const ROTINAS = ['mei', 'das', 'dctfweb', 'parc'];
  const rotinasDe = auto => { const R = { ...(auto.rotinas || {}) }; if (!R.mei && auto.ativo != null) R.mei = { ativo: !!auto.ativo, dia: auto.dia, hora: auto.hora }; return R; };
  // quem recebe cada rotina: MEI marcados (mei); Simples com DAS automático (das); empresas marcadas no cadastro (dctfweb, parcelamentos)
  const alvos = (emps, rotina, auto) => {
    const exc = new Set(auto.excluidas || []);
    if (rotina === 'mei') return emps.filter(e => ativa(e) && ehMei(e) && !exc.has(e.id)).map(e => ({ e }));
    if (rotina === 'das') return emps.filter(e => ativa(e) && ehSimples(e) && e.integra?.das !== false).map(e => ({ e }));
    if (rotina === 'dctfweb') return emps.filter(e => ativa(e) && e.integra?.dctfweb === true).map(e => ({ e }));
    return emps.filter(ativa).flatMap(e => (e.integra?.parcelamentos || []).filter(p => PROGRAMAS[p]).map(programa => ({ e, programa })));
  };
  const rodando = new Set();
  async function executarLote(esc, { rotina = 'mei', comp, manual, uid, somente } = {}) {
    if (!ROTINAS.includes(rotina)) throw new ErroHttp(400, 'Rotina inválida.');
    const chaveR = esc + ':' + rotina;
    if (rodando.has(chaveR)) throw new ErroHttp(409, 'Este envio já está em andamento. Aguarde terminar.');
    const c = await cfgIntegra(esc); if (!pronto(c)) throw new ErroHttp(412, 'Configure a integração com a Receita antes.');
    const auto = (c && c.auto) || {}; const S = SERVICOS[rotina]; comp = comp || addMes(agoraLocal().comp, S.compAuto);
    const lote = crypto.randomUUID(); rodando.add(chaveR);
    const emps = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas'`, [esc])).map(x => x.dados);
    const lista = alvos(emps, rotina, auto).filter(x => !somente || somente.includes(x.e.id));
    const resumo = { lote, rotina, comp, inicio: new Date().toISOString(), total: lista.length, ok: 0, falhas: 0, puladas: 0, manual: !!manual };
    (async () => {
      try {
        for (const { e, programa } of lista) {
          try {
            const ex = await guiaDaComp(esc, e.id, S.tipoGuia, comp, rotina === 'parc' ? programa : null);
            if (ex?.status === 'paga') { resumo.puladas++; await registrarExec(esc, { origem: 'mensal', empresaId: e.id, comp, ok: true, mensagem: 'Pulada: guia já consta como paga', lote, servico: rotina, programa }); continue; }
            if (!manual && ex?.enviadaAutoEm) { resumo.puladas++; continue; }
            const em = await emitirGuia({ esc, empresaId: e.id, servico: rotina, programa, comp, origem: { tipo: 'mensal', lote, uid }, quem: 'Envio automático' });
            const ent = await entregar({ esc, e, empresaId: e.id, emissao: em, canais: auto.canais || ['portal', 'whatsapp'], modelo: auto.mensagem });
            await A.gravar(esc, 'guias', em.guia.id, e.id, { ...em.guia, enviadaAutoEm: new Date().toISOString(), entrega: ent });
            if (em.reaproveitada) await registrarExec(esc, { origem: 'mensal', empresaId: e.id, comp, ok: true, valor: em.guia.valor, mensagem: 'Guia já emitida reaproveitada', lote, servico: rotina, programa });
            await registrarExec(esc, { origem: 'entrega', empresaId: e.id, comp, ok: !Object.values(ent).some(v => /^não|^sem/.test(v)), mensagem: ['Portal: publicada', ...Object.entries(ent).map(([k, v]) => (k === 'email' ? 'E-mail' : 'WhatsApp') + ': ' + v)].join(' · '), lote, servico: rotina, programa });
            resumo.ok++;
          } catch (er) { resumo.falhas++; }
          await new Promise(ok => setTimeout(ok, FALSO ? 50 : 1500));
        }
      } finally {
        resumo.fim = new Date().toISOString(); rodando.delete(chaveR);
        await db.query(`UPDATE integra_config SET auto = jsonb_set(jsonb_set(coalesce(auto,'{}'::jsonb), '{lotes}', coalesce(auto->'lotes','{}'::jsonb)), ARRAY['lotes',$3::text], $2::jsonb) WHERE escritorio_id = $1`, [esc, JSON.stringify(resumo), rotina]).catch(er => console.error('[integra] resumo', er.message));
        await log('guias_receita_lote', { usuarioId: uid || null, detalhe: `${rotina} · ${comp} · ${resumo.ok} ok · ${resumo.falhas} falhas · ${resumo.puladas} puladas` });
      }
    })();
    return resumo;
  }
  async function verificarAgenda() {
    const lista = await db.query(`SELECT escritorio_id, auto FROM integra_config`).catch(() => []);
    const L = agoraLocal();
    for (const x of lista) {
      const a = x.auto || {}; const R = rotinasDe(a);
      for (const rot of ROTINAS) {
        const cfg = R[rot]; if (!cfg?.ativo) continue; const S = SERVICOS[rot];
        const dia = Math.min(Math.max(Number(cfg.dia) || 5, 1), S.diaMax); const hora = Math.min(Math.max(Number(cfg.hora ?? 8), 0), 22);
        // no dia marcado (ou depois, se o servidor estava dormindo), até o limite da rotina, uma vez por mês
        if (L.dia < dia || L.dia > S.diaMax || (L.dia === dia && L.hora < hora) || (a.ultimo || {})[rot] === L.comp || (rot === 'mei' && a.ultimoMes === L.comp) || rodando.has(x.escritorio_id + ':' + rot)) continue;
        await db.query(`UPDATE integra_config SET auto = jsonb_set(jsonb_set(coalesce(auto,'{}'::jsonb), '{ultimo}', coalesce(auto->'ultimo','{}'::jsonb)), ARRAY['ultimo',$3::text], $2::jsonb) WHERE escritorio_id = $1`, [x.escritorio_id, JSON.stringify(L.comp), rot]);
        executarLote(x.escritorio_id, { rotina: rot }).catch(e => console.error('[integra] lote', e.message));
      }
    }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => verificarAgenda().catch(() => { }), 45000).unref?.(); setInterval(() => verificarAgenda().catch(() => { }), 10 * 60000).unref?.(); }

  /* ---------- Théo: conversa para enviar a guia ---------- */
  // devolve null quando a mensagem não é um pedido de guia que a integração atende (o Théo segue com a IA normal)
  async function fluxoTheo({ esc, empresaId, chave, texto }) {
    const t = String(texto || '').trim(); if (!t || !empresaId) return null;
    let st = estados.get(chave); if (st && st.expira < Date.now()) { estados.delete(chave); st = null; }
    const tn = norm(t);
    if (!st && (!PEDE_GUIA.test(tn) || /\b(paguei|ja paguei|foi paga|comprovante|das ?n|dasn|declara|como (faco|fazer) (o |um )?parcelamento|quero parcelar|posso parcelar)/.test(tn))) return null;
    const c = await cfgIntegra(esc); if (!pronto(c)) return null;
    const e = await A.empresa(esc, empresaId); if (!e || !ativa(e)) return null;
    const L = agoraLocal();
    if (st && CANCELA.test(tn)) { estados.delete(chave); return { texto: 'Tudo bem, cancelei o pedido da guia. Se precisar, é só me chamar. 😊' }; }
    const progs = (e.integra?.parcelamentos || []).filter(p => PROGRAMAS[p]);
    if (!st) {
      let servico = /\bparcel/.test(tn) ? 'parc' : ehMei(e) ? 'mei' : ehSimples(e) ? 'das' : null;
      if (/\bdarf\b|dctf|inss|previdenc/.test(tn) && e.integra?.dctfweb) servico = 'dctfweb';
      if (!servico || (servico === 'parc' && !progs.length) || (servico === 'das' && e.integra?.das === false)) return null;
      st = { etapa: servico === 'parc' ? 'programa' : 'comp', servico };
    }
    st.expira = Date.now() + 30 * 60000; estados.set(chave, st);
    const S = SERVICOS[st.servico]; const nome = () => nomeGuia(st.servico, st.programa);
    const emp = e.fantasia || e.razao;

    if (st.servico === 'parc') {
      if (st.etapa === 'programa') {
        const escolhido = progs.length === 1 ? progs[0] : progs.find(p => tn.includes(norm(p).replace('-esp', '')) || tn.includes(norm(PROGRAMAS[p][2]).split(' ').slice(-3).join(' '))) || progs[Number((tn.match(/^\s*(\d)\b/) || [])[1]) - 1];
        if (!escolhido) return { texto: `Claro! A ${emp} tem ${progs.length} parcelamentos. De qual você precisa da parcela? ${progs.map((p, i) => `${i + 1}) ${PROGRAMAS[p][2]}`).join(' · ')}` };
        st.programa = escolhido; st.comp = L.comp; st.etapa = 'confirmar';
        return { texto: `A parcela de ${fmtComp(st.comp)} do ${PROGRAMAS[escolhido][2]} vence em ${fmtData(S.venc(st.comp))}. Posso gerar e te enviar? Responda SIM.` };
      }
      if (st.etapa === 'confirmar') {
        if (NAO.test(t)) { estados.delete(chave); return { texto: 'Sem problema! Se precisar de outra guia, é só me chamar.' }; }
        if (!SIM.test(t)) return { texto: 'Para eu gerar a parcela, responda SIM.' };
        return emitirPeloTheo();
      }
    }

    const perguntaData = comp => { const v = S.venc(comp);
      return v >= L.data ? `A guia de ${fmtComp(comp)} vence em ${fmtData(v)}. Você vai pagar até o vencimento? Se for pagar em outra data, me diga qual (ex.: ${fmtData(L.data).slice(0, 5)}).`
        : `A guia de ${fmtComp(comp)} venceu em ${fmtData(v)}, então ela sai atualizada com multa e juros. Em que data você vai pagar? (hoje, amanhã ou uma data até o fim deste mês)`; };
    if (st.etapa === 'comp' || (st.etapa !== 'confirmar' && !st.comp)) {
      const comp = lerCompetencia(t, L);
      if (!comp) { st.etapa = 'comp'; return { texto: `Claro! Eu gero ${st.servico === 'dctfweb' ? 'o DARF da DCTFWeb' : st.servico === 'das' ? 'a guia DAS do Simples Nacional' : 'a guia DAS do MEI'} da ${emp} direto na Receita. De qual competência (mês) você precisa? Ex.: ${fmtComp(addMes(L.comp, -1))}.` }; }
      if (comp > L.comp) return { texto: `A guia de ${fmtComp(comp)} ainda não pode ser gerada. Me diga uma competência até ${fmtComp(L.comp)}.` };
      st.comp = comp;
      if (!S.consolida) { st.etapa = 'confirmar'; st.data = 'venc'; return { texto: `Confirmando: ${nome()} de ${fmtComp(comp)} da ${emp}, vencimento ${fmtData(S.venc(comp))}. Posso gerar e te enviar? Responda SIM.` }; }
      st.etapa = 'data';
      const d = lerData(t.replace(/\b(0?[1-9]|1[0-2])\s*[\/\-.]\s*(20\d{2})\b/, ''), L);
      if (!d) return { texto: perguntaData(comp) };
      st.data = d;
    } else if (st.etapa === 'data') {
      const d = lerData(t, L) || (SIM.test(t) && S.venc(st.comp) >= L.data ? 'venc' : null);
      const novaComp = !d && lerCompetencia(t, L);
      if (novaComp && novaComp <= L.comp) { st.comp = novaComp; return { texto: perguntaData(novaComp) }; }
      if (!d) return { texto: 'Não entendi a data. Pode me dizer no formato dia/mês (ex.: ' + fmtData(L.data).slice(0, 5) + '), ou "no vencimento"?' };
      st.data = d;
    } else if (st.etapa === 'confirmar') {
      if (NAO.test(t)) { st.etapa = 'comp'; delete st.comp; delete st.data; return { texto: 'Sem problema! Me diga a competência certa (e, se quiser, a data de pagamento).' }; }
      if (!SIM.test(t)) {
        const comp = lerCompetencia(t, L), d = S.consolida ? lerData(t, L) : null;
        if (comp || d) { if (comp) st.comp = comp; if (d) st.data = d; } else return { texto: 'Para eu gerar, responda SIM. Se algo estiver errado, me diga a competência ou a data certa.' };
      } else return emitirPeloTheo();
    }
    const v = S.venc(st.comp);
    if (st.data !== 'venc') {
      if (st.data < L.data) { st.etapa = 'data'; delete st.data; return { texto: 'Essa data já passou. Em que data você vai pagar? (hoje ou uma data futura)' }; }
      const fimMes = `${L.comp}-${pad(ultimoDia(+L.comp.slice(0, 4), +L.comp.slice(5, 7)))}`;
      if (st.data > v && st.data > fimMes) { st.etapa = 'data'; delete st.data; return { texto: `Depois do vencimento, a Receita só gera a guia atualizada para pagar até ${fmtData(fimMes)}. Qual data até lá?` }; }
    } else if (v < L.data) { st.etapa = 'data'; delete st.data; return { texto: `Essa guia já venceu em ${fmtData(v)}. Em que data você vai pagar? (hoje, amanhã ou até o fim do mês)` }; }
    const dataTxt = st.data === 'venc' || st.data <= v ? `pagamento até ${fmtData(st.data === 'venc' ? v : st.data)} (no prazo)` : `pagamento em ${fmtData(st.data)} (atualizada com multa e juros)`;
    st.etapa = 'confirmar';
    return { texto: `Confirmando: ${st.servico === 'mei' ? 'guia DAS do MEI' : nome()} de ${fmtComp(st.comp)} da ${emp}, ${dataTxt}. Posso gerar e te enviar? Responda SIM.` };

    async function emitirPeloTheo() {
      estados.delete(chave);
      try {
        const em = await emitirGuia({ esc, empresaId, servico: st.servico, programa: st.programa, comp: st.comp, dataPagamento: st.data, origem: { tipo: 'theo' }, quem: 'Théo (atendimento)' });
        const g = em.guia;
        return { texto: `Prontinho! Aqui está ${st.servico === 'parc' ? 'a parcela de ' + fmtComp(g.comp) + ' do ' + PROGRAMAS[st.programa][2] : (st.servico === 'mei' ? 'a guia DAS do MEI' : st.servico === 'das' ? 'a guia DAS do Simples' : 'o DARF da DCTFWeb') + ' de ' + fmtComp(g.comp)}: ${brl(g.valor)}, para pagamento até ${fmtData(g.venc)}.${g.valores?.multa || g.valores?.juros ? ` Já inclui multa e juros (${brl((g.valores.multa || 0) + (g.valores.juros || 0))}).` : ''} Ela também fica no Portal, em Guias e impostos.`,
          anexo: { id: em.arquivo.id, nome: em.arquivo.nome, tipo: 'application/pdf', conteudo: em.pdf, url: em.arquivo.url, tamanho: em.arquivo.tamanho }, guiaId: g.id };
      } catch (er) {
        return { texto: `Não consegui gerar a guia agora: ${er.message} Já chamei a equipe do escritório para te ajudar.`, passarEquipe: true, erro: er.message };
      }
    }
  }
  wa.definirFluxoDas?.(fluxoTheo);

  /* ---------- rotas ---------- */
  r.get('/api/integra', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const c = await cfgIntegra(u.escritorio_id);
    const ex = await db.query(`SELECT x.em, x.origem, x.empresa_id, x.comp, x.ok, x.valor, x.mensagem, x.lote, r.dados->>'razao' AS razao FROM integra_execucoes x
      LEFT JOIN registros r ON r.escritorio_id = x.escritorio_id AND r.colecao = 'empresas' AND r.id = x.empresa_id WHERE x.escritorio_id = $1 ORDER BY x.em DESC LIMIT 200`, [u.escritorio_id]);
    const auto = c?.auto || {};
    return { configurado: pronto(c), falso: FALSO, ambiente: c?.ambiente || 'producao', cnpj: c?.cnpj || '', consumerKey: c?.consumer_key ? c.consumer_key.slice(0, 4) + '…' + c.consumer_key.slice(-4) : '',
      temSegredo: !!c?.consumer_secret_cifrado, cert: c?.pfx_cifrado ? { titular: c.cert_titular, validade: c.cert_validade } : null,
      auto: { ...auto, rotinas: rotinasDe(auto), lotes: { ...(auto.ultimoLote ? { mei: auto.ultimoLote } : {}), ...(auto.lotes || {}) } },
      rodando: ROTINAS.filter(x => rodando.has(u.escritorio_id + ':' + x)), programas: Object.fromEntries(Object.entries(PROGRAMAS).map(([k, v]) => [k, v[2]])),
      execucoes: ex, podeEditar: u.papel === 'master' || pode(u, 'config', 'editar') };
  });
  r.put('/api/integra', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirConfig(u);
    if (!CONFIG.cofreChave) throw new ErroHttp(503, 'Cofre indisponível: falta a variável COFRE_CHAVE no servidor.');
    const b = ctx.corpo || {}; const atual = await cfgIntegra(u.escritorio_id) || {};
    const ambiente = b.ambiente === 'demonstracao' ? 'demonstracao' : 'producao';
    let cnpj = soDig(b.cnpj ?? atual.cnpj); const key = String(b.consumerKey || '').trim() || atual.consumer_key || null;
    let pfx = atual.pfx_cifrado || null, senha = atual.senha_cifrada || null, titular = atual.cert_titular || null, validade = atual.cert_validade || null;
    if (b.certificado) {
      const buf = Buffer.from(String(b.certificado), 'base64'); if (!buf.length || buf.length > 100 * 1024) throw new ErroHttp(400, 'Envie o .pfx do e-CNPJ do escritório (até 100 KB).');
      if (!b.senha) throw new ErroHttp(400, 'Informe a senha do certificado.');
      let info; try { info = lerCertificadoA1(buf, String(b.senha)); } catch (e) { throw new ErroHttp(400, e.message); }
      if (info.validoAte && info.validoAte < new Date().toISOString().slice(0, 10)) throw new ErroHttp(400, 'Este certificado está vencido.');
      if (info.cnpj && cnpj && info.cnpj !== cnpj) throw new ErroHttp(409, 'O certificado é de outro CNPJ (' + info.cnpj + '). O contratante do Integra Contador deve ser o mesmo CNPJ do certificado.');
      cnpj = cnpj || info.cnpj || ''; pfx = cifrar(buf); senha = cifrar(String(b.senha)); titular = info.titular; validade = info.validoAte;
    }
    if (ambiente === 'producao' && cnpj && cnpj.length !== 14) throw new ErroHttp(400, 'CNPJ do escritório inválido.');
    const segredo = String(b.consumerSecret || '').trim() ? cifrar(String(b.consumerSecret).trim()) : atual.consumer_secret_cifrado || null;
    await db.query(`INSERT INTO integra_config (escritorio_id, ambiente, cnpj, consumer_key, consumer_secret_cifrado, pfx_cifrado, senha_cifrada, cert_titular, cert_validade, atualizado_por, atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) ON CONFLICT (escritorio_id) DO UPDATE SET ambiente = EXCLUDED.ambiente, cnpj = EXCLUDED.cnpj, consumer_key = EXCLUDED.consumer_key,
      consumer_secret_cifrado = EXCLUDED.consumer_secret_cifrado, pfx_cifrado = EXCLUDED.pfx_cifrado, senha_cifrada = EXCLUDED.senha_cifrada, cert_titular = EXCLUDED.cert_titular,
      cert_validade = EXCLUDED.cert_validade, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`, [u.escritorio_id, ambiente, cnpj || null, key, segredo, pfx, senha, titular, validade, u.id]);
    tokens.delete(u.escritorio_id);
    await log('integra_configurado', { usuarioId: u.id, ip: ctx.ip, detalhe: `${ambiente} · ${cnpj || ''}${b.certificado ? ' · certificado trocado' : ''}` });
    return { ok: true };
  }, { limite: 200 * 1024 });
  r.put('/api/integra/auto', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirConfig(u);
    const b = ctx.corpo || {}; const atual = (await cfgIntegra(u.escritorio_id))?.auto || {};
    const canais = (Array.isArray(b.canais) ? b.canais : []).filter(x => ['portal', 'whatsapp', 'email'].includes(x));
    const rot = {}; const R0 = rotinasDe(atual);
    for (const k of ROTINAS) { const x = (b.rotinas || {})[k] || R0[k] || {}; rot[k] = { ativo: !!x.ativo, dia: Math.min(Math.max(Number(x.dia) || 5, 1), SERVICOS[k].diaMax), hora: Math.min(Math.max(Number(x.hora ?? 8), 0), 22) }; }
    const { ativo, dia, hora, ...resto } = atual;
    const auto = { ...resto, rotinas: rot, canais: canais.includes('portal') ? canais : ['portal', ...canais], mensagem: String(b.mensagem || '').slice(0, 600) || MSG_PADRAO,
      excluidas: (Array.isArray(b.excluidas) ? b.excluidas : atual.excluidas || []).map(String).slice(0, 2000) };
    await db.query(`INSERT INTO integra_config (escritorio_id, auto, atualizado_por) VALUES ($1,$2::jsonb,$3) ON CONFLICT (escritorio_id) DO UPDATE SET auto = EXCLUDED.auto, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
      [u.escritorio_id, JSON.stringify(auto), u.id]);
    return { ok: true, auto };
  });
  r.post('/api/integra/testar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirConfig(u, 'ver');
    const c = await cfgIntegra(u.escritorio_id); if (!pronto(c)) throw new ErroHttp(412, 'Preencha CNPJ, Consumer Key, Consumer Secret e o certificado do escritório antes de testar.');
    if (FALSO) return { ok: true, texto: 'Conexão simulada (ambiente de teste local).' };
    if (c.ambiente === 'demonstracao') { const d = await gerarPdf(c, '00000000000100', 'mei', '2018-01', null).catch(e => ({ erro: e.message })); return d.erro ? { ok: false, texto: 'Demonstração respondeu: ' + d.erro } : { ok: true, texto: 'Ambiente de demonstração respondeu com um DAS fictício. Troque para Produção quando o contrato estiver ativo.' }; }
    await token(c, true);
    return { ok: true, texto: 'Autenticação com a SERPRO funcionando. Agora cada cliente precisa ter a procuração eletrônica para o escritório.' };
  });
  const rotaEmitir = async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'obrig', 'editar') && !pode(u, 'guias', 'editar')) throw new ErroHttp(403, 'Seu acesso não permite emitir guias.');
    if (limitar(`guia-rf:${u.id}`, 80, 3600).bloqueado) throw new ErroHttp(429, 'Muitas emissões seguidas. Aguarde alguns minutos.');
    const b = ctx.corpo || {};
    const em = await emitirGuia({ esc: u.escritorio_id, empresaId: String(b.empresaId || ''), servico: b.servico || 'mei', programa: b.programa || null, comp: String(b.comp || ''), dataPagamento: b.dataPagamento || null, origem: { tipo: 'painel', uid: u.id }, quem: u.nome, reaproveitar: !b.forcar });
    let entrega = {};
    const canais = (Array.isArray(b.canais) ? b.canais : []).filter(x => ['whatsapp', 'email'].includes(x));
    if (canais.length) { const c = await cfgIntegra(u.escritorio_id); entrega = await entregar({ esc: u.escritorio_id, e: em.empresa, empresaId: b.empresaId, emissao: em, canais, modelo: c?.auto?.mensagem }); }
    return { ok: true, guia: em.guia, reaproveitada: em.reaproveitada, entrega };
  };
  r.post('/api/integra/guia', rotaEmitir);
  r.post('/api/integra/das-mei', rotaEmitir);
  r.post('/api/integra/executar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirConfig(u);
    const b = ctx.corpo || {}; const comp = /^\d{4}-\d{2}$/.test(b.comp || '') ? b.comp : undefined;
    return { ok: true, resumo: await executarLote(u.escritorio_id, { rotina: b.rotina || 'mei', comp, manual: true, uid: u.id, somente: Array.isArray(b.empresas) && b.empresas.length ? b.empresas.map(String) : null }) };
  });
  // portal: o cliente conversa com o Théo; se for pedido de guia que a integração atende, este fluxo responde
  r.post('/api/theo/das', async ctx => {
    const u = await exigir(ctx, { site: 'cliente' });
    const b = ctx.corpo || {}; const eid = String(b.empresaId || '');
    if (!(u.empresas || []).some(x => String(x.id) === eid)) throw new ErroHttp(403, 'Empresa não liberada para este acesso.');
    if (limitar(`theo-das:${u.id}`, 60, 3600).bloqueado) throw new ErroHttp(429, 'Muitas mensagens seguidas. Aguarde um pouco.');
    const k = 'portal:' + String(b.conversaId || eid);
    const res = await fluxoTheo({ esc: u.escritorio_id, empresaId: eid, chave: k, texto: String(b.texto || '').slice(0, 1000) });
    if (!res) return { tratado: false };
    const { anexo, ...resto } = res;
    return { tratado: true, continua: estados.has(k), ...resto, arquivo: anexo ? { id: anexo.id, nome: anexo.nome, tipo: anexo.tipo, url: anexo.url, tamanho: anexo.tamanho } : null };
  });

  /* ================= procurações eletrônicas (e-CAC) ================= */
  // Consulta, pelo Integra Contador (PROCURACOES/OBTERPROCURACAO41), se a empresa deu procuração ao escritório
  // (outorgado = CNPJ do certificado do escritório) e até quando vale. Resultado guardado no cadastro da empresa.
  const dataProc = v => { const s = String(v || '').replace(/\D/g, ''); return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : ''; };
  function lerProcuracao(d, msgs) {
    const lista = [].concat(Array.isArray(d) ? d : d && typeof d === 'object' ? (d.procuracoes || d.lista || [d]) : []);
    let validade = '', sistemas = [];
    for (const it of lista) {
      if (!it || typeof it !== 'object') continue;
      const k = Object.keys(it).find(x => /expira|validade|dtfim|datafim/i.test(x)); const v = k ? dataProc(it[k]) : '';
      if (v && v > validade) validade = v;
      const ss = it.sistemas || it.servicos || it.listaSistemas; if (Array.isArray(ss)) sistemas.push(...ss.map(x => typeof x === 'string' ? x : x.descricao || x.nome || x.codigo || JSON.stringify(x)));
    }
    const txt = (msgs || []).join(' ');
    if (!validade) return { status: 'inexistente', validade: '', sistemas: [], mensagem: txt || 'Nenhuma procuração do cliente para o escritório foi encontrada no e-CAC.' };
    return { status: validade < agoraLocal().data ? 'vencida' : 'ativa', validade, sistemas: [...new Set(sistemas)].slice(0, 60), mensagem: txt };
  }
  async function consultarProcuracao(esc, empresaId, quem) {
    const e = await A.empresa(esc, empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const c = await cfgIntegra(esc); if (!pronto(c)) throw new ErroHttp(412, 'Configure a integração com a Receita (certificado do escritório) em Configurações para consultar procurações.');
    const doc = soDig(e.cnpj || e.cpf); if (![11, 14].includes(doc.length)) throw new ErroHttp(400, 'A empresa está sem CNPJ no cadastro.');
    let res;
    try {
      if (FALSO) {
        const n = parseInt(doc.slice(-4), 10);
        res = doc.endsWith('0000') ? lerProcuracao([], ['Não existe procuração (simulação).']) : lerProcuracao([{ dtexpiracao: addDiasIso(agoraLocal().data, (n % 9) * 45 - 40).replace(/-/g, ''), nrsistemas: 3, sistemas: ['Simples Nacional / PGDAS-D', 'DCTFWeb', 'Caixa Postal'] }], []);
      } else {
        const outorgado = soDig(c.cnpj);
        const { dados, mensagens } = await chamar(c, 'Consultar', doc, { idSistema: 'PROCURACOES', idServico: 'OBTERPROCURACAO41', versaoSistema: '1',
          dados: { outorgante: doc, tipoOutorgante: doc.length === 11 ? '1' : '2', outorgado, tipoOutorgado: outorgado.length === 11 ? '1' : '2' } });
        res = lerProcuracao(dados, mensagens);
      }
    } catch (er) {
      if (/procura/i.test(er.message) && !/autentica|Consumer|certificado do escrit/i.test(er.message)) res = { status: 'inexistente', validade: '', sistemas: [], mensagem: er.message };
      else res = { status: 'erro', validade: e.procuracao?.validade || '', sistemas: e.procuracao?.sistemas || [], mensagem: er.message };
    }
    const atual = await A.empresa(esc, empresaId);
    const procuracao = { ...(atual.procuracao || {}), ...res, origem: 'receita', outorgado: soDig(c.cnpj) || '', consultadoEm: new Date().toISOString(), consultadoPor: quem || 'Automático' };
    if (res.status === 'erro') procuracao.ultimoErro = res.mensagem; else delete procuracao.ultimoErro;
    await A.gravar(esc, 'empresas', atual.id, atual.id, { ...atual, procuracao });
    return procuracao;
  }
  const addDiasIso = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const consultando = new Set();
  async function consultarTodas(esc, { quem, somente, idadeDias = 0 } = {}) {
    if (consultando.has(esc)) throw new ErroHttp(409, 'Já existe uma consulta de procurações em andamento. Aguarde terminar.');
    consultando.add(esc);
    try {
      const es = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND coalesce(dados->>'status','') NOT IN ('inativo','aguardando_pagamento') AND coalesce(dados->>'exemplo','') <> 'true'`, [esc])).map(x => x.dados)
        .filter(e => !somente || somente.includes(String(e.id)))
        .filter(e => !idadeDias || !e.procuracao?.consultadoEm || (Date.now() - new Date(e.procuracao.consultadoEm)) > idadeDias * 86400e3);
      const r0 = { total: es.length, ativa: 0, vencida: 0, inexistente: 0, erro: 0 };
      for (const e of es) { const p = await consultarProcuracao(esc, e.id, quem).catch(er => ({ status: 'erro', mensagem: er.message })); r0[p.status] = (r0[p.status] || 0) + 1; if (es.length > 1) await new Promise(ok => setTimeout(ok, FALSO ? 5 : 1500)); }
      return r0;
    } finally { consultando.delete(esc); }
  }
  // de 7 em 7 dias o sistema confere de novo cada empresa (uma vez por dia, de madrugada)
  async function rotinaProcuracoes() {
    const L = agoraLocal(); if (Number(L.hora ?? new Date().getHours()) !== 6) return;
    const cs = await db.query('SELECT escritorio_id FROM integra_config');
    for (const { escritorio_id: esc } of cs) { const c = await cfgIntegra(esc); if (!pronto(c) || c.ambiente === 'demonstracao') continue; await consultarTodas(esc, { quem: 'Automático', idadeDias: 7 }).catch(er => console.error('[procuracoes]', er.message)); }
  }
  if (process.env.NODE_ENV !== 'test') setInterval(() => rotinaProcuracoes().catch(() => { }), 60 * 60000).unref?.();

  const exigirCarteira = (u, nivel = 'editar') => { if (u.papel !== 'master' && !pode(u, 'carteira', nivel) && !pode(u, 'config', nivel)) throw new ErroHttp(403, 'Seu acesso não permite gerenciar procurações.'); };
  r.get('/api/procuracoes', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirCarteira(u, 'ver'); const c = await cfgIntegra(u.escritorio_id);
    return { configurado: pronto(c), falso: FALSO, ambiente: c?.ambiente || '', outorgado: soDig(c?.cnpj || ''), cert: c?.pfx_cifrado ? { titular: c.cert_titular, validade: c.cert_validade } : null, consultando: consultando.has(u.escritorio_id) };
  });
  r.post('/api/procuracoes/consultar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirCarteira(u);
    if (limitar(`proc:${u.id}`, 20, 3600).bloqueado) throw new ErroHttp(429, 'Muitas consultas seguidas. Aguarde um pouco.');
    const b = ctx.corpo || {};
    if (b.empresaId) return { ok: true, procuracao: await consultarProcuracao(u.escritorio_id, String(b.empresaId), u.nome) };
    const somente = Array.isArray(b.empresas) && b.empresas.length ? b.empresas.map(String) : null;
    const resumo = await consultarTodas(u.escritorio_id, { quem: u.nome, somente });
    await log('procuracoes_consultadas', { usuarioId: u.id, ip: ctx.ip, detalhe: JSON.stringify(resumo) });
    return { ok: true, resumo };
  });
  // registro manual (quando a integração não está configurada ou para conferir o que o cliente mandou)
  r.put('/api/procuracoes/:empresaId', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirCarteira(u); const b = ctx.corpo || {};
    const e = await A.empresa(u.escritorio_id, ctx.params.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    let procuracao;
    if (b.remover) procuracao = null;
    else {
      const validade = /^\d{4}-\d{2}-\d{2}$/.test(String(b.validade || '')) ? b.validade : ''; if (!validade) throw new ErroHttp(400, 'Informe a data de validade da procuração.');
      procuracao = { ...(e.procuracao || {}), status: validade < agoraLocal().data ? 'vencida' : 'ativa', validade, sistemas: (Array.isArray(b.sistemas) ? b.sistemas : String(b.sistemas || '').split(/[,;\n]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 40),
        origem: 'manual', obs: String(b.obs || '').slice(0, 300), outorgado: soDig(b.outorgado || e.procuracao?.outorgado || ''), consultadoEm: new Date().toISOString(), consultadoPor: u.nome, mensagem: 'Registrada manualmente' };
    }
    const novo = { ...e }; if (procuracao) novo.procuracao = procuracao; else delete novo.procuracao;
    await A.gravar(u.escritorio_id, 'empresas', e.id, e.id, novo);
    await log('procuracao_registrada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao} · ${procuracao ? 'válida até ' + procuracao.validade : 'removida'}` });
    return { ok: true, procuracao };
  });
  // pede ao cliente para dar (ou renovar) a procuração: WhatsApp e e-mail com o passo a passo
  r.post('/api/procuracoes/:empresaId/pedir', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirCarteira(u); const esc = u.escritorio_id;
    const e = await A.empresa(esc, ctx.params.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const c = await cfgIntegra(esc); const cfg = await A.configEscritorio(esc); const outorgado = soDig(c?.cnpj || ctx.corpo?.outorgado || '');
    if (outorgado.length !== 14 && outorgado.length !== 11) throw new ErroHttp(412, 'Cadastre o CNPJ do escritório (certificado) em Configurações › Integração com a Receita.');
    const fmt = d => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    const nome = String(e.contatos?.[0]?.nome || e.socios?.[0]?.nome || '').split(' ')[0] || 'tudo bem';
    const renovar = e.procuracao?.status === 'ativa' || e.procuracao?.status === 'vencida';
    const texto = String(ctx.corpo?.mensagem || '').trim() || `Olá, ${nome}! ${renovar ? `A procuração eletrônica da ${e.fantasia || e.razao} para a nossa contabilidade ${e.procuracao.status === 'vencida' ? 'venceu' : 'vence em ' + fmtData(e.procuracao.validade)}` : `Para cuidarmos das guias e declarações da ${e.fantasia || e.razao} direto na Receita, precisamos de uma procuração eletrônica`}. É rápido:
1) Acesse cav.receita.fazenda.gov.br (e-CAC) com o gov.br nível prata/ouro ou o certificado da empresa;
2) Vá em "Senhas e Procurações" › "Procuração eletrônica" › "Cadastrar";
3) Procurador: CNPJ ${fmt(outorgado)}${cfg.escritorio ? ' (' + cfg.escritorio + ')' : ''};
4) Marque "Todos os serviços" (ou pelo menos Simples Nacional/MEI, DCTFWeb, Caixa Postal e parcelamentos) e a validade máxima (até 5 anos);
5) Confirme e nos avise por aqui.
Se preferir, fazemos com você por videochamada. 😊`;
    const res = {};
    try { const rw = await wa.enviarArquivos({ esc, empresaId: e.id, fone: e.telefone, anexos: [], legenda: texto, u: { id: u.id, nome: u.nome } }); res.whatsapp = 'WhatsApp enviado para ' + rw.para; } catch (er) { res.whatsapp = 'WhatsApp não enviado (' + er.message + ')'; }
    const para = await A.emailsDaEmpresa(esc, e.id, e);
    if (para.length) { const re = await enviarEmail({ para, assunto: (renovar ? 'Renovação da procuração eletrônica · ' : 'Procuração eletrônica · ') + (e.fantasia || e.razao), texto, html: `<p>${texto.replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/\n/g, '<br>')}</p>` }); res.email = re.enviado ? 'e-mail enviado' : 'e-mail não enviado (' + (re.motivo || 'falha') + ')'; }
    const atual = await A.empresa(esc, e.id); await A.gravar(esc, 'empresas', atual.id, atual.id, { ...atual, procuracao: { ...(atual.procuracao || { status: 'inexistente' }), pedidoEm: new Date().toISOString(), pedidoPor: u.nome } });
    await log('procuracao_pedida', { usuarioId: u.id, ip: ctx.ip, detalhe: e.razao });
    return { ok: true, ...res };
  });

  return { emitirGuia, emitirDasMei, fluxoTheo, executarLote, consultarProcuracao };
}
