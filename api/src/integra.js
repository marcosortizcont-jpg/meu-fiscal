// Integra Contador (SERPRO/Receita Federal): emissão do DAS do MEI (PGMEI) sem passar pelo portal com captcha.
//
// O escritório contrata o Integra Contador na Loja Serpro e cadastra aqui: CNPJ contratante, Consumer Key/Secret
// e o certificado e-CNPJ do escritório (A1). Cada MEI precisa ter dado procuração eletrônica ao escritório no e-CAC.
// Segredos ficam cifrados com a COFRE_CHAVE (cofre.js) e nunca voltam ao navegador.
//
// Fluxos:
//   - Painel: emitir o DAS de uma empresa (Controle de obrigações) e envio mensal automático a todos os MEI.
//   - Théo (portal e WhatsApp): o cliente pede a guia, o Théo pergunta competência e data de pagamento, confirma e envia.
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ErroHttp } from './http.js';
import { cifrar, decifrar, lerCertificadoA1 } from './cofre.js';
import { CONFIG } from './config.js';
import { enviarEmail } from './externos.js';
import { gravarDisco, urlEnvio } from './arquivos.js';
import { limitar } from './seguranca.js';

const URL_AUTH = 'https://autenticacao.sapi.serpro.gov.br/authenticate';
const GATEWAY = { producao: 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/', demonstracao: 'https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1/' };
const TOKEN_DEMO = '06aef429-a981-3ec5-a1f8-71d38d86481e';           // token público do ambiente de demonstração (dados fictícios)
const FUSO = process.env.FUSO_ESCRITORIO || 'America/Campo_Grande';
const FALSO = process.env.INTEGRA_FALSO === '1' && process.env.NODE_ENV !== 'production';   // só para testes locais

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_SA = MESES.map(m => m.normalize('NFD').replace(/[̀-ͯ]/g, ''));
const soDig = s => String(s ?? '').replace(/\D/g, '');
const pad = n => String(n).padStart(2, '0');
const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtData = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';
const fmtComp = c => c ? MESES[+c.slice(5, 7) - 1] + '/' + c.slice(0, 4) : '';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const addMes = (c, n) => { const d = new Date(Date.UTC(+c.slice(0, 4), +c.slice(5, 7) - 1 + n, 1)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); };
const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
export function agoraLocal(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, comp: `${p.year}-${p.month}`, dia: +p.day, hora: +p.hour % 24 };
}
// feriados nacionais fixos + móveis (Carnaval, Sexta-feira Santa, Corpus Christi) para o vencimento do dia 20
function feriados(a) {
  const f = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(x => `${a}-${x}`);
  const G = a % 19, C = Math.floor(a / 100), H = (C - Math.floor(C / 4) - Math.floor((8 * C + 13) / 25) + 19 * G + 15) % 30;
  const I = H - Math.floor(H / 28) * (1 - Math.floor(29 / (H + 1)) * Math.floor((21 - G) / 11)), J = (a + Math.floor(a / 4) + I + 2 - C + Math.floor(C / 4)) % 7;
  const L = I - J, mes = 3 + Math.floor((L + 40) / 44), dia = L + 28 - 31 * Math.floor(mes / 4);
  const pascoa = Date.UTC(a, mes - 1, dia); const d = n => new Date(pascoa + n * 86400000).toISOString().slice(0, 10);
  return new Set([...f, d(-48), d(-47), d(-2), d(60)]);
}
export function vencimentoDasMei(comp) {
  const c = addMes(comp, 1); const a = +c.slice(0, 4), m = +c.slice(5, 7); const F = feriados(a);
  let d = new Date(Date.UTC(a, m - 1, 20));
  while ([0, 6].includes(d.getUTCDay()) || F.has(d.toISOString().slice(0, 10))) d = new Date(d.getTime() + 86400000);
  return d.toISOString().slice(0, 10);
}
const ehMei = e => e && (e.regimeId === 'reg2-mei' || e.regime === 'MEI') && e.status !== 'inativo';

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
    const ano = (t.match(/\b(20\d{2})\b/) || [])[1] || ((t.match(new RegExp(MESES_SA[i].slice(0, 3) + '[a-z]*\\s*(?:\\/|-|de)\\s*(\\d{2})\\b')) || [])[1] ? '20' + t.match(new RegExp(MESES_SA[i].slice(0, 3) + '[a-z]*\\s*(?:\\/|-|de)\\s*(\\d{2})\\b'))[1] : null);
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
const PEDE_GUIA = /\b(das|guia|guias|boleto|boletos|2\s*[ªao°]?\s*via|segunda via|imposto do mei|carne do mei|mensalidade do mei)\b/i;
const CANCELA = /\b(cancela|cancelar|deixa pra la|deixa para la|esquece|nao precisa|não precisa|desisto)\b/i;

export function registrarIntegra(r, { db, exigir, log, pode, wa }) {
  const exigirConfig = (u, nivel = 'editar') => { if (u.papel !== 'master' && !pode(u, 'config', nivel)) throw new ErroHttp(403, 'Só o master (ou quem edita Configurações) altera a integração com a Receita.'); };
  const tokens = new Map();      // escritório → { access, jwt, expira }
  const estados = new Map();     // conversa → { etapa, comp, data, expira }   (conversa com o Théo sobre a guia)

  async function cfgIntegra(esc) { const [c] = await db.query('SELECT * FROM integra_config WHERE escritorio_id = $1', [esc]); return c || null; }
  const pronto = c => !!c && (c.ambiente === 'demonstracao' || (c.cnpj && c.consumer_key && c.consumer_secret_cifrado && c.pfx_cifrado)) || FALSO;

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
    const r = await requisitar(URL_AUTH, { pfx, senha, corpo: 'grant_type=client_credentials',
      cabecalhos: { Authorization: 'Basic ' + Buffer.from(`${c.consumer_key}:${segredo}`).toString('base64'), 'Role-Type': 'TERCEIROS', 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (r.status !== 200 || !r.json?.access_token) {
      const m = r.json?.error_description || r.json?.message || r.txt.slice(0, 200);
      throw new ErroHttp(502, r.status === 401 ? 'A SERPRO recusou a Consumer Key/Secret ou o certificado. Confira os dados do contrato na Área do Cliente Serpro.' : 'Falha na autenticação com a SERPRO: ' + (m || 'HTTP ' + r.status));
    }
    const novo = { access: r.json.access_token, jwt: r.json.jwt_token || '', expira: Date.now() + (Number(r.json.expires_in) || 1800) * 1000 };
    tokens.set(c.escritorio_id, novo); return novo;
  }
  async function chamar(c, tipo, contribuinte, pedido) {
    const corpo = JSON.stringify({ contratante: { numero: soDig(c.cnpj) || '00000000000000', tipo: 2 }, autorPedidoDados: { numero: soDig(c.cnpj) || '00000000000000', tipo: 2 },
      contribuinte: { numero: soDig(contribuinte), tipo: soDig(contribuinte).length === 11 ? 1 : 2 }, pedidoDados: { ...pedido, dados: JSON.stringify(pedido.dados || {}) } });
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const t = await token(c, tentativa > 0);
      const r = await requisitar(GATEWAY[c.ambiente] + tipo, { corpo, cabecalhos: { Authorization: 'Bearer ' + t.access, jwt_token: t.jwt, 'Content-Type': 'application/json', Accept: 'application/json' } });
      if (r.status === 401 && tentativa === 0) continue;
      const msgs = (r.json?.mensagens || []).map(m => `${m.texto || ''}`.trim()).filter(Boolean);
      if (r.status !== 200) {
        let m = msgs.join(' ') || r.json?.message || r.txt.slice(0, 200) || 'HTTP ' + r.status;
        if (/procura/i.test(m) || r.status === 403) m = 'Sem procuração eletrônica do MEI para o escritório no e-CAC. ' + m;
        throw new ErroHttp(r.status === 429 ? 429 : 502, m);
      }
      let dados = r.json?.dados; if (typeof dados === 'string') { try { dados = JSON.parse(dados); } catch { } }
      return { dados, mensagens: msgs };
    }
  }
  // gera o DAS do MEI em PDF (PGMEI › GERARDASPDF21)
  async function gerarDasPdf(c, cnpj, comp, dataConsolidacao) {
    if (FALSO) {
      if (soDig(cnpj).endsWith('0000')) throw new ErroHttp(502, 'Sem procuração eletrônica do MEI para o escritório no e-CAC. (simulação)');
      const venc = dataConsolidacao || vencimentoDasMei(comp); const multa = dataConsolidacao && dataConsolidacao > vencimentoDasMei(comp) ? 6.08 : 0;
      return { pdf: Buffer.from(`%PDF-1.4\n% DAS MEI ${cnpj} ${comp} (simulado)\n%%EOF\n`), venc, numero: '07' + Date.now().toString().slice(-14), valores: { principal: 81.05, multa, juros: multa ? 0.81 : 0, total: 81.05 + multa + (multa ? 0.81 : 0) } };
    }
    const dados = { periodoApuracao: comp.replace('-', '') }; if (dataConsolidacao) dados.dataConsolidacao = dataConsolidacao.replace(/-/g, '');
    const { dados: d } = await chamar(c, 'Emitir', cnpj, { idSistema: 'PGMEI', idServico: 'GERARDASPDF21', versaoSistema: '1.0', dados });
    const item = Array.isArray(d) ? d[0] : d;
    const pdf64 = item?.pdf || item?.PDF || item?.pdfBase64;
    if (!pdf64) throw new ErroHttp(502, 'A Receita não devolveu o PDF do DAS para esta competência (pode já estar paga, fora do período MEI ou sem valor devido).');
    const det = [].concat(item.detalhamento || [])[0] || {};
    const dv = String(det.dataVencimento || det.dataLimiteAcolhimento || '');
    const venc = /^\d{8}$/.test(dv) ? `${dv.slice(0, 4)}-${dv.slice(4, 6)}-${dv.slice(6, 8)}` : /^\d{4}-\d{2}-\d{2}/.test(dv) ? dv.slice(0, 10) : (dataConsolidacao || vencimentoDasMei(comp));
    const v = det.valores || {}; const num = x => Number(String(x ?? 0).replace(',', '.')) || 0;
    return { pdf: Buffer.from(pdf64, 'base64'), venc, numero: det.numeroDocumento || '', valores: { principal: num(v.principal), multa: num(v.multa), juros: num(v.juros), total: num(v.total) || num(v.principal) + num(v.multa) + num(v.juros) } };
  }

  /* ---------- arquivos e registros ---------- */
  async function guardarPdf(esc, empresaId, buf, nome) {
    const id = crypto.randomUUID(); const chave = `${esc}/pgmei/${id}`; const local = CONFIG.arquivos.driver;
    await db.query('INSERT INTO arquivos (id, escritorio_id, empresa_id, chave, tipo, tamanho, criado_por, local) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)', [id, esc, empresaId, chave, 'application/pdf', buf.length, local]);
    if (local === 'banco') await db.query('INSERT INTO arquivos_conteudo (id, conteudo) VALUES ($1,$2)', [id, buf]);
    else if (local === 'disco') await gravarDisco({ id }, buf);
    else { const e = urlEnvio({ id, chave, tipo: 'application/pdf', tamanho: buf.length }); const rr = await fetch(e.url, { method: 'PUT', headers: e.cabecalhos, body: buf }); if (!rr.ok) throw new Error('falha no armazenamento ' + rr.status); }
    return { id, nome, url: `/api/arquivos/${id}`, tipo: 'application/pdf', tamanho: buf.length };
  }
  const gravar = (esc, colecao, id, empresaId, dados) => db.query(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados) VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT (escritorio_id, colecao, id) DO UPDATE SET dados = EXCLUDED.dados, versao = registros.versao + 1, atualizado_em = now()`, [esc, colecao, id, empresaId, JSON.stringify(dados)]);
  async function empresa(esc, id) { const [e] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id = $2`, [esc, String(id)]); return e?.dados || null; }
  async function guiaDaComp(esc, empresaId, comp) {
    const g = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'guias' AND empresa_id = $2 AND dados->>'comp' = $3 AND dados->>'tipo' = 'DAS-MEI'
      ORDER BY (dados->>'origem' = 'pgmei') DESC, atualizado_em DESC`, [esc, String(empresaId), comp]);
    return g[0]?.dados || null;
  }
  async function conteudoArquivo(id) {
    const [a] = await db.query('SELECT id, chave, tipo, local FROM arquivos WHERE id = $1', [id]); if (!a) return null;
    if (a.local === 'banco') { const [c] = await db.query('SELECT conteudo FROM arquivos_conteudo WHERE id = $1', [id]); return c?.conteudo || null; }
    if (a.local === 'disco') { const { caminhoDisco } = await import('./arquivos.js'); return fs.promises.readFile(caminhoDisco(a)).catch(() => null); }
    const { urlDownload } = await import('./arquivos.js'); const rr = await fetch(urlDownload(a)); return rr.ok ? Buffer.from(await rr.arrayBuffer()) : null;
  }
  const registrarExec = (esc, x) => db.query('INSERT INTO integra_execucoes (escritorio_id, origem, empresa_id, comp, ok, valor, mensagem, lote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [esc, x.origem, x.empresaId || null, x.comp || null, !!x.ok, x.valor ?? null, String(x.mensagem || '').slice(0, 500), x.lote || null]).catch(() => { });

  /* Emite (ou reaproveita) o DAS-MEI, publica em "Guias e impostos" do portal e dá baixa na obrigação do mês. */
  async function emitirDasMei({ esc, empresaId, comp, dataPagamento, origem, quem, reaproveitar = true }) {
    const c = await cfgIntegra(esc); if (!pronto(c)) throw new ErroHttp(412, 'A integração com a Receita (Integra Contador) ainda não foi configurada em Configurações.');
    const e = await empresa(esc, empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (!ehMei(e)) throw new ErroHttp(400, 'Esta empresa não está no regime MEI.');
    if (soDig(e.cnpj).length !== 14) throw new ErroHttp(400, 'A empresa está sem CNPJ válido no cadastro.');
    if (!/^\d{4}-\d{2}$/.test(comp)) throw new ErroHttp(400, 'Competência inválida.');
    const hojeL = agoraLocal(); if (comp > hojeL.comp) throw new ErroHttp(400, 'Ainda não dá para gerar a guia de uma competência futura.');
    const vencNormal = vencimentoDasMei(comp);
    let consolidar = dataPagamento && dataPagamento !== 'venc' ? dataPagamento : null;
    if (consolidar) {
      if (consolidar < hojeL.data) throw new ErroHttp(400, 'A data de pagamento não pode ser anterior a hoje.');
      const fimMes = `${hojeL.comp}-${pad(ultimoDia(+hojeL.comp.slice(0, 4), +hojeL.comp.slice(5, 7)))}`;
      if (consolidar > fimMes && consolidar > vencNormal) throw new ErroHttp(400, `Para pagar depois do vencimento, a data precisa ser até ${fmtData(fimMes)} (último dia deste mês).`);
      if (consolidar <= vencNormal) consolidar = null;    // dentro do prazo: guia normal, sem multa
    } else if (vencNormal < hojeL.data) consolidar = hojeL.data;   // vencida sem data informada: atualiza para hoje
    const validade = consolidar || vencNormal;
    const existente = await guiaDaComp(esc, empresaId, comp);
    if (existente?.status === 'paga') throw new ErroHttp(409, `A guia de ${fmtComp(comp)} já consta como paga no sistema.`);
    // reaproveita a guia que ainda vale para a data pedida (não gera custo novo na SERPRO)
    if (reaproveitar && existente?.arquivo?.id && existente.venc && existente.venc >= validade && existente.venc >= hojeL.data && existente.venc <= (consolidar ? validade : vencNormal)) {
      const pdf = await conteudoArquivo(existente.arquivo.id);
      if (pdf) return { guia: existente, pdf, arquivo: existente.arquivo, reaproveitada: true, empresa: e };
    }
    const lote = origem.lote || null;
    let r;
    try { r = await gerarDasPdf(c, e.cnpj, comp, consolidar); }
    catch (er) { await registrarExec(esc, { origem: origem.tipo, empresaId, comp, ok: false, mensagem: er.message, lote }); throw er; }
    const nome = `DAS-MEI ${comp.slice(5, 7)}-${comp.slice(0, 4)} ${soDig(e.cnpj)}.pdf`;
    const arquivo = await guardarPdf(esc, String(empresaId), r.pdf, nome);
    const quando = new Date().toISOString();
    const g = { ...(existente || {}), id: existente?.id || 'pgmei-' + empresaId + '-' + comp, empresaId: String(empresaId), tipo: 'DAS-MEI', depto: 'Fiscal', comp,
      valor: Math.round(r.valores.total * 100) / 100, venc: r.venc, status: 'liberada', arquivo, liberadaEm: quando, origem: 'pgmei', numeroDocumento: r.numero,
      valores: r.valores, emitidaEm: quando, emitidaPor: quem || 'Integra Contador', ...(consolidar ? { atualizadaPara: consolidar } : {}) };
    await gravar(esc, 'guias', g.id, String(empresaId), g);
    // obrigação DAS-MEI do mês: entregue, com o PDF e o histórico
    const [ob] = await db.query(`SELECT id, dados FROM registros WHERE escritorio_id = $1 AND colecao = 'obrigacoes' AND empresa_id = $2 AND dados->>'comp' = $3
      AND (dados->>'catId' = 'das-mei' OR dados->>'tipo' = 'DAS-MEI') LIMIT 1`, [esc, String(empresaId), comp]);
    const texto = `${fmtData(quando.slice(0, 10))} DAS emitido no PGMEI pela integração (${brl(g.valor)}, pagamento até ${fmtData(g.venc)}) e publicado em "Guias e impostos" do portal.`;
    const o = ob ? ob.dados : { id: crypto.randomUUID(), empresaId: String(empresaId), comp, tipo: 'DAS-MEI', prazo: vencNormal, depto: 'Fiscal', catId: 'das-mei', status: 'pendente', criadaEm: quando, log: [] };
    o.arquivos = [...(o.arquivos || []), { ...arquivo, enviadoEm: quando }].slice(-10);
    o.log = [...(o.log || []), { em: quando, nome: quem || 'Integração', tipo: 'envio', texto }].slice(-200);
    if (!['entregue', 'dispensada'].includes(o.status)) { o.status = 'entregue'; o.concluidaEm = quando; o.protocolo = o.protocolo || ('PGMEI ' + (r.numero || '')).trim(); }
    o.valorGuia = g.valor; o.publicarGuia = true;
    await gravar(esc, 'obrigacoes', o.id, String(empresaId), o);
    await registrarExec(esc, { origem: origem.tipo, empresaId, comp, ok: true, valor: g.valor, mensagem: `Emitido · pagamento até ${fmtData(g.venc)}`, lote });
    await log('das_mei_emitido', { usuarioId: origem.uid || null, detalhe: `${e.razao || ''} · ${comp} · ${brl(g.valor)} · ${origem.tipo}` });
    return { guia: g, pdf: r.pdf, arquivo, reaproveitada: false, empresa: e };
  }

  const MSG_PADRAO = 'Olá, {nome}! Segue a guia DAS do MEI de {competencia} da {empresa}: {valor}, com vencimento em {vencimento}. Ela também está no Portal do Cliente, em Guias e impostos.';
  const montarMsg = (modelo, x) => String(modelo || MSG_PADRAO).replace(/\{(\w+)\}/g, (_, k) => ({ nome: x.nome, empresa: x.empresa, competencia: fmtComp(x.comp), valor: brl(x.valor), vencimento: fmtData(x.venc) }[k] ?? _));
  async function entregar({ esc, e, empresaId, emissao, canais, modelo }) {
    const res = {}; const g = emissao.guia;
    const legenda = montarMsg(modelo, { nome: String(e.socios?.[0]?.nome || e.fantasia || e.razao || '').split(' ')[0], empresa: e.fantasia || e.razao, comp: g.comp, valor: g.valor, venc: g.venc });
    const anexo = { id: emissao.arquivo.id, nome: emissao.arquivo.nome, tipo: 'application/pdf', conteudo: emissao.pdf };
    if (canais.includes('whatsapp')) {
      try { const r2 = await wa.enviarArquivos({ esc, empresaId: String(empresaId), fone: e.telefone, anexos: [anexo], legenda, u: { id: null, nome: 'Envio automático do DAS-MEI' } }); res.whatsapp = 'enviado para ' + r2.para; }
      catch (er) { res.whatsapp = 'não enviado: ' + er.message; }
    }
    if (canais.includes('email')) {
      const doAtend = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'contatos'`, [esc])).map(x => x.dados)
        .filter(x => (x.empresas || []).includes(String(empresaId)) && x.email && x.recebeEmail !== false && x.ativo !== false).map(x => x.email);
      const para = [...new Set([e.email, ...(e.contatos || []).map(x => x.email), ...doAtend].map(x => String(x || '').trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)))];
      if (!para.length) res.email = 'sem e-mail cadastrado';
      else { const rr = await enviarEmail({ para, assunto: `DAS do MEI de ${fmtComp(g.comp)} · vence ${fmtData(g.venc)}`, texto: legenda, html: `<p>${legenda.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`, anexos: [anexo] }); res.email = rr.enviado ? 'enviado para ' + para.join(', ') : 'não enviado: ' + (rr.motivo || 'falha'); }
    }
    return res;
  }

  /* ---------- envio mensal para todos os MEI ---------- */
  const rodando = new Set();
  async function executarLote(esc, { comp, manual, uid, somente } = {}) {
    if (rodando.has(esc)) throw new ErroHttp(409, 'O envio do DAS-MEI já está em andamento. Aguarde terminar.');
    const c = await cfgIntegra(esc); if (!pronto(c)) throw new ErroHttp(412, 'Configure a integração com a Receita antes.');
    const auto = (c && c.auto) || {}; comp = comp || addMes(agoraLocal().comp, -1);
    const lote = crypto.randomUUID(); rodando.add(esc);
    const emps = (await db.query(`SELECT id, dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas'`, [esc])).map(x => x.dados)
      .filter(e => ehMei(e) && !(auto.excluidas || []).includes(e.id) && (!somente || somente.includes(e.id)));
    const resumo = { lote, comp, inicio: new Date().toISOString(), total: emps.length, ok: 0, falhas: 0, puladas: 0, manual: !!manual };
    (async () => {
      try {
        for (const e of emps) {
          try {
            const ex = await guiaDaComp(esc, e.id, comp);
            if (ex?.status === 'paga') { resumo.puladas++; await registrarExec(esc, { origem: 'mensal', empresaId: e.id, comp, ok: true, mensagem: 'Pulada: guia já consta como paga', lote }); continue; }
            if (!manual && ex?.enviadaAutoEm) { resumo.puladas++; continue; }
            const em = await emitirDasMei({ esc, empresaId: e.id, comp, origem: { tipo: 'mensal', lote, uid }, quem: 'Envio automático' });
            const ent = await entregar({ esc, e, empresaId: e.id, emissao: em, canais: auto.canais || ['portal', 'whatsapp'], modelo: auto.mensagem });
            await gravar(esc, 'guias', em.guia.id, e.id, { ...em.guia, enviadaAutoEm: new Date().toISOString(), entrega: ent });
            if (em.reaproveitada) await registrarExec(esc, { origem: 'mensal', empresaId: e.id, comp, ok: true, valor: em.guia.valor, mensagem: 'Guia já emitida reaproveitada', lote });
            await registrarExec(esc, { origem: 'entrega', empresaId: e.id, comp, ok: !Object.values(ent).some(v => /^não|^sem/.test(v)), mensagem: ['Portal: publicada', ...Object.entries(ent).map(([k, v]) => (k === 'email' ? 'E-mail' : 'WhatsApp') + ': ' + v)].join(' · '), lote });
            resumo.ok++;
          } catch (er) { resumo.falhas++; }
          await new Promise(ok => setTimeout(ok, FALSO ? 50 : 1500));
        }
      } finally {
        resumo.fim = new Date().toISOString(); rodando.delete(esc);
        await db.query(`UPDATE integra_config SET auto = jsonb_set(coalesce(auto,'{}'::jsonb), '{ultimoLote}', $2::jsonb) WHERE escritorio_id = $1`, [esc, JSON.stringify(resumo)]).catch(() => { });
        await log('das_mei_lote', { usuarioId: uid || null, detalhe: `${comp} · ${resumo.ok} ok · ${resumo.falhas} falhas · ${resumo.puladas} puladas` });
      }
    })();
    return resumo;
  }
  async function verificarAgenda() {
    const lista = await db.query(`SELECT escritorio_id, auto FROM integra_config WHERE coalesce(auto->>'ativo','false') = 'true'`).catch(() => []);
    const L = agoraLocal();
    for (const x of lista) {
      const a = x.auto || {}; const dia = Math.min(Math.max(Number(a.dia) || 5, 1), 19); const hora = Math.min(Math.max(Number(a.hora ?? 8), 0), 22);
      // no dia marcado (ou depois, se o servidor estava dormindo), até o dia 19, uma vez por mês
      if (L.dia < dia || L.dia > 19 || (L.dia === dia && L.hora < hora) || a.ultimoMes === L.comp || rodando.has(x.escritorio_id)) continue;
      await db.query(`UPDATE integra_config SET auto = jsonb_set(coalesce(auto,'{}'::jsonb), '{ultimoMes}', $2::jsonb) WHERE escritorio_id = $1`, [x.escritorio_id, JSON.stringify(L.comp)]);
      executarLote(x.escritorio_id, { comp: addMes(L.comp, -1) }).catch(e => console.error('[integra] lote', e.message));
    }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => verificarAgenda().catch(() => { }), 45000).unref?.(); setInterval(() => verificarAgenda().catch(() => { }), 10 * 60000).unref?.(); }

  /* ---------- Théo: conversa para enviar a guia ---------- */
  // devolve null quando a mensagem não é sobre a guia do MEI (o Théo segue com a IA normal)
  async function fluxoTheo({ esc, empresaId, chave, texto }) {
    const t = String(texto || '').trim(); if (!t || !empresaId) return null;
    let st = estados.get(chave); if (st && st.expira < Date.now()) { estados.delete(chave); st = null; }
    if (!st && ((!PEDE_GUIA.test(norm(t)) && !PEDE_GUIA.test(t)) || /\b(paguei|ja paguei|foi paga|comprovante|parcelamento|parcelar|das ?n|dasn|declara)/.test(norm(t)))) return null;
    const c = await cfgIntegra(esc); if (!pronto(c)) return null;
    const e = await empresa(esc, empresaId); if (!ehMei(e)) return null;
    const L = agoraLocal();
    if (st && CANCELA.test(norm(t))) { estados.delete(chave); return { texto: 'Tudo bem, cancelei o pedido da guia. Se precisar, é só me chamar. 😊' }; }
    if (!st) { st = { etapa: 'comp' }; }
    st.expira = Date.now() + 30 * 60000; estados.set(chave, st);
    const perguntaData = comp => { const v = vencimentoDasMei(comp);
      return v >= L.data ? `A guia de ${fmtComp(comp)} vence em ${fmtData(v)}. Você vai pagar até o vencimento? Se for pagar em outra data, me diga qual (ex.: ${fmtData(L.data).slice(0, 5)}).`
        : `A guia de ${fmtComp(comp)} venceu em ${fmtData(v)}, então ela sai atualizada com multa e juros. Em que data você vai pagar? (hoje, amanhã ou uma data até o fim deste mês)`; };
    if (st.etapa === 'comp' || (st.etapa !== 'confirmar' && !st.comp)) {
      const comp = lerCompetencia(t, L);
      if (!comp) { st.etapa = 'comp'; return { texto: `Claro! Eu gero a guia DAS do MEI da ${e.fantasia || e.razao} direto na Receita. De qual competência (mês) você precisa? Ex.: ${fmtComp(addMes(L.comp, -1))}.` }; }
      if (comp > L.comp) return { texto: `A guia de ${fmtComp(comp)} ainda não pode ser gerada. Me diga uma competência até ${fmtComp(L.comp)}.` };
      st.comp = comp; st.etapa = 'data';
      const d = lerData(t.replace(/\b(0?[1-9]|1[0-2])\s*[\/\-.]\s*(20\d{2})\b/, ''), L);
      if (!d) return { texto: perguntaData(comp) };
      st.data = d;
    } else if (st.etapa === 'data') {
      const d = lerData(t, L) || (SIM.test(t) && vencimentoDasMei(st.comp) >= L.data ? 'venc' : null);
      const novaComp = !d && lerCompetencia(t, L);
      if (novaComp && novaComp <= L.comp) { st.comp = novaComp; return { texto: perguntaData(novaComp) }; }
      if (!d) return { texto: 'Não entendi a data. Pode me dizer no formato dia/mês (ex.: ' + fmtData(L.data).slice(0, 5) + '), ou "no vencimento"?' };
      st.data = d;
    } else if (st.etapa === 'confirmar') {
      if (NAO.test(t)) { st.etapa = 'comp'; delete st.comp; delete st.data; return { texto: 'Sem problema! Me diga a competência certa (e, se quiser, a data de pagamento).' }; }
      if (!SIM.test(t)) {
        const comp = lerCompetencia(t, L), d = lerData(t, L);
        if (comp || d) { if (comp) st.comp = comp; if (d) st.data = d; } else return { texto: 'Para eu gerar, responda SIM. Se algo estiver errado, me diga a competência ou a data certa.' };
      } else {
        estados.delete(chave);
        try {
          const em = await emitirDasMei({ esc, empresaId, comp: st.comp, dataPagamento: st.data, origem: { tipo: 'theo' }, quem: 'Théo (atendimento)' });
          const g = em.guia;
          return { texto: `Prontinho! Aqui está a guia DAS do MEI de ${fmtComp(g.comp)}: ${brl(g.valor)}, para pagamento até ${fmtData(g.venc)}.${g.valores?.multa || g.valores?.juros ? ` Já inclui multa e juros (${brl((g.valores.multa || 0) + (g.valores.juros || 0))}).` : ''} Ela também fica no Portal, em Guias e impostos.`,
            anexo: { id: em.arquivo.id, nome: em.arquivo.nome, tipo: 'application/pdf', conteudo: em.pdf, url: em.arquivo.url, tamanho: em.arquivo.tamanho }, guiaId: g.id };
        } catch (er) {
          return { texto: `Não consegui gerar a guia agora: ${er.message} Já chamei a equipe do escritório para te ajudar.`, passarEquipe: true, erro: er.message };
        }
      }
    }
    // validações da data antes de confirmar
    const v = vencimentoDasMei(st.comp);
    if (st.data !== 'venc') {
      if (st.data < L.data) { st.etapa = 'data'; delete st.data; return { texto: 'Essa data já passou. Em que data você vai pagar? (hoje ou uma data futura)' }; }
      const fimMes = `${L.comp}-${pad(ultimoDia(+L.comp.slice(0, 4), +L.comp.slice(5, 7)))}`;
      if (st.data > v && st.data > fimMes) { st.etapa = 'data'; delete st.data; return { texto: `Depois do vencimento, a Receita só gera a guia atualizada para pagar até ${fmtData(fimMes)}. Qual data até lá?` }; }
    } else if (v < L.data) { st.etapa = 'data'; delete st.data; return { texto: `Essa guia já venceu em ${fmtData(v)}. Em que data você vai pagar? (hoje, amanhã ou até o fim do mês)` }; }
    const dataTxt = st.data === 'venc' || st.data <= v ? `pagamento até ${fmtData(st.data === 'venc' ? v : st.data)} (no prazo)` : `pagamento em ${fmtData(st.data)} (atualizada com multa e juros)`;
    st.etapa = 'confirmar';
    return { texto: `Confirmando: guia DAS do MEI de ${fmtComp(st.comp)} da ${e.fantasia || e.razao}, ${dataTxt}. Posso gerar e te enviar? Responda SIM.` };
  }
  wa.definirFluxoDas?.(fluxoTheo);

  /* ---------- rotas ---------- */
  r.get('/api/integra', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const c = await cfgIntegra(u.escritorio_id);
    const ex = await db.query(`SELECT x.em, x.origem, x.empresa_id, x.comp, x.ok, x.valor, x.mensagem, x.lote, r.dados->>'razao' AS razao FROM integra_execucoes x
      LEFT JOIN registros r ON r.escritorio_id = x.escritorio_id AND r.colecao = 'empresas' AND r.id = x.empresa_id WHERE x.escritorio_id = $1 ORDER BY x.em DESC LIMIT 150`, [u.escritorio_id]);
    return { configurado: pronto(c), falso: FALSO, ambiente: c?.ambiente || 'producao', cnpj: c?.cnpj || '', consumerKey: c?.consumer_key ? c.consumer_key.slice(0, 4) + '…' + c.consumer_key.slice(-4) : '',
      temSegredo: !!c?.consumer_secret_cifrado, cert: c?.pfx_cifrado ? { titular: c.cert_titular, validade: c.cert_validade } : null, auto: c?.auto || {}, rodando: rodando.has(u.escritorio_id),
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
    const auto = { ...atual, ativo: !!b.ativo, dia: Math.min(Math.max(Number(b.dia) || 5, 1), 19), hora: Math.min(Math.max(Number(b.hora ?? 8), 0), 22),
      canais: canais.includes('portal') ? canais : ['portal', ...canais], mensagem: String(b.mensagem || '').slice(0, 600) || MSG_PADRAO,
      excluidas: (Array.isArray(b.excluidas) ? b.excluidas : []).map(String).slice(0, 2000) };
    await db.query(`INSERT INTO integra_config (escritorio_id, auto, atualizado_por) VALUES ($1,$2::jsonb,$3) ON CONFLICT (escritorio_id) DO UPDATE SET auto = EXCLUDED.auto, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
      [u.escritorio_id, JSON.stringify(auto), u.id]);
    return { ok: true, auto };
  });
  r.post('/api/integra/testar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirConfig(u, 'ver');
    const c = await cfgIntegra(u.escritorio_id); if (!pronto(c)) throw new ErroHttp(412, 'Preencha CNPJ, Consumer Key, Consumer Secret e o certificado do escritório antes de testar.');
    if (FALSO) return { ok: true, texto: 'Conexão simulada (ambiente de teste local).' };
    if (c.ambiente === 'demonstracao') { const d = await gerarDasPdf(c, '00000000000100', '2018-01', null).catch(e => ({ erro: e.message })); return d.erro ? { ok: false, texto: 'Demonstração respondeu: ' + d.erro } : { ok: true, texto: 'Ambiente de demonstração respondeu com um DAS fictício. Troque para Produção quando o contrato estiver ativo.' }; }
    await token(c, true);
    return { ok: true, texto: 'Autenticação com a SERPRO funcionando. Agora cada MEI precisa ter a procuração eletrônica para o escritório.' };
  });
  r.post('/api/integra/das-mei', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'obrig', 'editar') && !pode(u, 'guias', 'editar')) throw new ErroHttp(403, 'Seu acesso não permite emitir guias.');
    if (limitar(`das-mei:${u.id}`, 60, 3600).bloqueado) throw new ErroHttp(429, 'Muitas emissões seguidas. Aguarde alguns minutos.');
    const b = ctx.corpo || {};
    const em = await emitirDasMei({ esc: u.escritorio_id, empresaId: String(b.empresaId || ''), comp: String(b.comp || ''), dataPagamento: b.dataPagamento || null, origem: { tipo: 'painel', uid: u.id }, quem: u.nome, reaproveitar: !b.forcar });
    let entrega = {};
    const canais = (Array.isArray(b.canais) ? b.canais : []).filter(x => ['whatsapp', 'email'].includes(x));
    if (canais.length) { const c = await cfgIntegra(u.escritorio_id); entrega = await entregar({ esc: u.escritorio_id, e: em.empresa, empresaId: b.empresaId, emissao: em, canais, modelo: c?.auto?.mensagem }); }
    return { ok: true, guia: em.guia, reaproveitada: em.reaproveitada, entrega };
  });
  r.post('/api/integra/executar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirConfig(u);
    const b = ctx.corpo || {}; const comp = /^\d{4}-\d{2}$/.test(b.comp || '') ? b.comp : undefined;
    return { ok: true, resumo: await executarLote(u.escritorio_id, { comp, manual: true, uid: u.id, somente: Array.isArray(b.empresas) && b.empresas.length ? b.empresas.map(String) : null }) };
  });
  // portal: o cliente conversa com o Théo; se for pedido de guia do MEI, este fluxo responde
  r.post('/api/theo/das', async ctx => {
    const u = await exigir(ctx, { site: 'cliente' });
    const b = ctx.corpo || {}; const eid = String(b.empresaId || '');
    if (!(u.empresas || []).some(x => String(x.id) === eid)) throw new ErroHttp(403, 'Empresa não liberada para este acesso.');
    if (limitar(`theo-das:${u.id}`, 60, 3600).bloqueado) throw new ErroHttp(429, 'Muitas mensagens seguidas. Aguarde um pouco.');
    const res = await fluxoTheo({ esc: u.escritorio_id, empresaId: eid, chave: 'portal:' + String(b.conversaId || eid), texto: String(b.texto || '').slice(0, 1000) });
    if (!res) return { tratado: false };
    const { anexo, ...resto } = res;
    return { tratado: true, continua: estados.has('portal:' + String(b.conversaId || eid)), ...resto, arquivo: anexo ? { id: anexo.id, nome: anexo.nome, tipo: anexo.tipo, url: anexo.url, tamanho: anexo.tamanho } : null };
  });

  return { emitirDasMei, fluxoTheo, executarLote };
}
