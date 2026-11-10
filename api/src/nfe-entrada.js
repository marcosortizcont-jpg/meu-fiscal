// Notas fiscais de entrada: NF-e (modelo 55) emitidas por fornecedores contra o CNPJ do cliente.
//
// Fonte: serviço oficial e gratuito NFeDistribuicaoDFe do Ambiente Nacional da NF-e, consultado por mTLS com o
// certificado A1 da própria empresa (guardado cifrado em certificados_a1). Nada de intermediário pago.
//
// Como funciona:
//  - distNSU: pede os documentos a partir do último NSU recebido (lotes de até 50). Vêm resumos (resNFe), notas
//    completas (procNFe) e eventos (cancelamento etc.), compactados em gzip/base64.
//  - Regras da SEFAZ: ao chegar no maxNSU (ou receber 137 "nenhum documento") é preciso esperar 1 hora para
//    consultar de novo; consumo indevido devolve 656 e bloqueia por 1 hora. A rotina respeita isso por empresa.
//  - Ciência da operação (evento 210210, NFeRecepcaoEvento4 do Ambiente Nacional, assinado com o A1): libera o
//    XML completo da nota, que chega numa próxima consulta. Pode ser automática (padrão) ou manual.
//  - Notas ficam na coleção "nfentrada" (id = chave de acesso); o XML vai para arquivos, baixado por /api/arquivos/:id.
// Teste local: NFE_ENTRADA_FALSO=1 simula a SEFAZ (nunca em produção).
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ErroHttp } from './http.js';
import { decifrar } from './cofre.js';
import { pemDoPfx } from './nfse.js';
import { criarApoio, soDig } from './apoio.js';

export const FALSO = process.env.NFE_ENTRADA_FALSO === '1' && process.env.NODE_ENV !== 'production';
const NS = 'http://www.portalfiscal.inf.br/nfe', DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const URLS = {
  producao: { dist: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', evento: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx' },
  homologacao: { dist: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', evento: 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx' },
};
const UF_IBGE = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };
const UMA_HORA = 61 * 60e3;   // a SEFAZ pede 1 hora; 1 minuto de folga
const SIT = { 1: 'autorizada', 2: 'denegada', 3: 'cancelada' };

/* ===================== XML ===================== */
const tag = (xml, t) => { const m = new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${t}>`).exec(xml || ''); return m ? m[1].trim() : null; };
const bloco = (xml, t) => { const m = new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>[\\s\\S]*?</(?:\\w+:)?${t}>`).exec(xml || ''); return m ? m[0] : ''; };
const desesc = s => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const num = s => { const n = Number(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// hora de Brasília (UTC-3) um minuto no passado, no formato AAAA-MM-DDThh:mm:ss-03:00
export function dhBrasilia(d = new Date(Date.now() - 60000)) { return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 19) + '-03:00'; }

export function montarConsulta({ tpAmb, uf, cnpj, ultNSU }) {
  const cuf = UF_IBGE[String(uf || 'MS').toUpperCase()] || 50;
  return `<distDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${cuf}</cUFAutor><CNPJ>${soDig(cnpj)}</CNPJ><distNSU><ultNSU>${String(ultNSU || '0').padStart(15, '0')}</ultNSU></distNSU></distDFeInt>`;
}
export function envelopeConsulta(dados) {
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>${dados}</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;
}

// evento de manifestação do destinatário: 210210 ciência da operação (padrão), 210200 confirmação
const DESC = { 210210: 'Ciencia da Operacao', 210200: 'Confirmacao da Operacao' };
export function montarEvento({ tpAmb, cnpj, chave, tpEvento = 210210, seq = 1 }) {
  const id = 'ID' + tpEvento + soDig(chave) + String(seq).padStart(2, '0');
  const inf = `<infEvento Id="${id}"><cOrgao>91</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${soDig(cnpj)}</CNPJ><chNFe>${soDig(chave)}</chNFe><dhEvento>${dhBrasilia()}</dhEvento><tpEvento>${tpEvento}</tpEvento><nSeqEvento>${seq}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>${DESC[tpEvento]}</descEvento></detEvento></infEvento>`;
  return { id, xml: `<evento xmlns="${NS}" versao="1.00">${inf}</evento>` };
}
// XMLDSig enveloped (rsa-sha1, C14N), a Signature irmã de infEvento dentro de <evento>, como pede o leiaute da NF-e
export function assinarEvento(xml, { chave, certB64 }) {
  const ini = xml.indexOf('<infEvento Id="'); const fim = xml.indexOf('</infEvento>') + '</infEvento>'.length;
  if (ini < 0 || fim < 20) throw new Error('infEvento não encontrado.');
  const alvo = xml.slice(ini, fim); const id = /Id="([^"]+)"/.exec(alvo)[1];
  const canon = alvo.replace('<infEvento Id=', `<infEvento xmlns="${NS}" Id=`);   // herda o namespace de <evento>
  const digest = crypto.createHash('sha1').update(canon, 'utf8').digest('base64');
  const si = `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod><SignatureMethod Algorithm="${DS}rsa-sha1"></SignatureMethod><Reference URI="#${id}"><Transforms><Transform Algorithm="${DS}enveloped-signature"></Transform><Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${DS}sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference>`;
  const valor = crypto.createSign('RSA-SHA1').update(`<SignedInfo xmlns="${DS}">${si}</SignedInfo>`, 'utf8').sign(chave, 'base64');
  return xml.slice(0, fim) + `<Signature xmlns="${DS}"><SignedInfo>${si}</SignedInfo><SignatureValue>${valor}</SignatureValue><KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></Signature>` + xml.slice(fim);
}
export function envelopeEvento(eventoAssinado, idLote) {
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><envEvento xmlns="${NS}" versao="1.00"><idLote>${idLote}</idLote>${eventoAssinado.replace(` xmlns="${NS}"`, '')}</envEvento></nfeDadosMsg></soap12:Body></soap12:Envelope>`;
}

// lê retDistDFeInt: status, NSUs e os documentos já descompactados
export function lerRetornoDist(xml) {
  const ret = bloco(xml, 'retDistDFeInt');
  if (!ret) throw new Error('Resposta da SEFAZ sem retDistDFeInt.');
  const docs = [...ret.matchAll(/<(?:\w+:)?docZip\s+([^>]*)>([^<]+)<\/(?:\w+:)?docZip>/g)].map(m => {
    const nsu = (/NSU="(\d+)"/.exec(m[1]) || [])[1] || ''; const schema = (/schema="([^"]+)"/.exec(m[1]) || [])[1] || '';
    let conteudo = ''; try { conteudo = zlib.gunzipSync(Buffer.from(m[2].trim(), 'base64')).toString('utf8'); } catch { }
    return { nsu, schema, xml: conteudo };
  });
  return { cStat: tag(ret, 'cStat'), xMotivo: desesc(tag(ret, 'xMotivo')), ultNSU: tag(ret, 'ultNSU') || '0', maxNSU: tag(ret, 'maxNSU') || '0', docs };
}

// transforma um documento distribuído em { tipo: 'nota'|'evento', ... }
export function interpretarDoc({ nsu, schema, xml }) {
  if (/^resNFe/.test(schema) || /<resNFe[\s>]/.test(xml)) {
    return { tipo: 'nota', completa: false, chave: tag(xml, 'chNFe'), emitente: { cnpj: tag(xml, 'CNPJ') || tag(xml, 'CPF') || '', nome: desesc(tag(xml, 'xNome')), ie: tag(xml, 'IE') || '' },
      emissao: tag(xml, 'dhEmi'), valor: num(tag(xml, 'vNF')), tpNF: tag(xml, 'tpNF'), situacao: SIT[tag(xml, 'cSitNFe')] || 'autorizada', protocolo: tag(xml, 'nProt'), nsu, xml };
  }
  if (/^procNFe/.test(schema) || /<nfeProc[\s>]/.test(xml)) {
    const inf = bloco(xml, 'infNFe'); const ide = bloco(inf, 'ide'); const emit = bloco(inf, 'emit'); const tot = bloco(inf, 'ICMSTot'); const prot = bloco(xml, 'infProt');
    const chave = (/Id="NFe(\d{44})"/.exec(inf) || [])[1] || tag(prot, 'chNFe');
    return { tipo: 'nota', completa: true, chave, numero: tag(ide, 'nNF'), serie: tag(ide, 'serie'), natOp: desesc(tag(ide, 'natOp')),
      emitente: { cnpj: tag(emit, 'CNPJ') || tag(emit, 'CPF') || '', nome: desesc(tag(emit, 'xNome')), fantasia: desesc(tag(emit, 'xFant') || ''), ie: tag(emit, 'IE') || '', uf: tag(bloco(emit, 'enderEmit'), 'UF') || '' },
      emissao: tag(ide, 'dhEmi') || tag(ide, 'dEmi'), valor: num(tag(tot, 'vNF')), tpNF: tag(ide, 'tpNF'), itens: (inf.match(/<det\s+nItem=/g) || []).length,
      situacao: tag(prot, 'cStat') === '100' ? 'autorizada' : tag(prot, 'cStat') === '110' || tag(prot, 'cStat') === '301' ? 'denegada' : 'autorizada', protocolo: tag(prot, 'nProt'), nsu, xml };
  }
  if (/Evento/i.test(schema) || /<(resEvento|procEventoNFe|evento)[\s>]/.test(xml)) {
    return { tipo: 'evento', chave: tag(xml, 'chNFe'), tpEvento: tag(xml, 'tpEvento'), descricao: desesc(tag(xml, 'xEvento') || tag(xml, 'descEvento') || ''), em: tag(xml, 'dhEvento'), nsu };
  }
  return { tipo: 'outro', nsu };
}

/* ===================== simulação local ===================== */
const gz = s => zlib.gzipSync(Buffer.from(s)).toString('base64');
let simNsu = 0; const simCiencia = new Set();
function simChave(i) { const base = '50' + '2610' + '12345678000190' + '55' + '001' + String(1000 + i).padStart(9, '0') + '1' + String(10000000 + i).slice(-8); return base + '7'; }
function simular(tipo, corpo) {
  if (tipo === 'evento') { const ch = tag(corpo, 'chNFe'); simCiencia.add(ch); return `<soap:Envelope><soap:Body><nfeRecepcaoEventoNFResult><retEnvEvento><cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo><retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${ch}</chNFe><nProt>950260000${String(Math.random()).slice(2, 8)}</nProt></infEvento></retEvento></retEnvEvento></nfeRecepcaoEventoNFResult></soap:Body></soap:Envelope>`; }
  const ult = Number(tag(corpo, 'ultNSU') || 0); const docs = [];
  if (ult < 3) { for (let i = ult + 1; i <= 3; i++) docs.push(`<docZip NSU="${String(i).padStart(15, '0')}" schema="resNFe_v1.01.xsd">${gz(`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${simChave(i)}</chNFe><CNPJ>12345678000190</CNPJ><xNome>FORNECEDOR TESTE ${i} LTDA</xNome><IE>283000000</IE><dhEmi>2026-11-0${i}T10:00:00-04:00</dhEmi><tpNF>1</tpNF><vNF>${(1500 * i).toFixed(2)}</vNF><digVal>x</digVal><dhRecbto>2026-11-0${i}T10:01:00-04:00</dhRecbto><nProt>15026000000000${i}</nProt><cSitNFe>${i === 3 ? 3 : 1}</cSitNFe></resNFe>`)}</docZip>`); simNsu = 3; }
  else if (simCiencia.size && ult < 4) { const ch = [...simCiencia][0]; docs.push(`<docZip NSU="000000000000004" schema="procNFe_v4.00.xsd">${gz(`<nfeProc xmlns="${NS}" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00"><ide><cUF>50</cUF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>1001</nNF><dhEmi>2026-11-01T10:00:00-04:00</dhEmi><tpNF>1</tpNF></ide><emit><CNPJ>12345678000190</CNPJ><xNome>FORNECEDOR TESTE 1 LTDA</xNome><enderEmit><UF>MS</UF></enderEmit><IE>283000000</IE></emit><det nItem="1"><prod/></det><det nItem="2"><prod/></det><total><ICMSTot><vNF>1500.00</vNF></ICMSTot></total></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${ch}</chNFe><nProt>150260000000001</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`)}</docZip>`); simNsu = 4; }
  const fimNsu = Math.max(ult, simNsu);
  const cStat = docs.length ? '138' : '137';
  return `<soap:Envelope><soap:Body><nfeDistDFeInteresseResponse><nfeDistDFeInteresseResult><retDistDFeInt xmlns="${NS}" versao="1.01"><tpAmb>2</tpAmb><verAplic>1.0</verAplic><cStat>${cStat}</cStat><xMotivo>${docs.length ? 'Documento(s) localizado(s)' : 'Nenhum documento localizado'}</xMotivo><dhResp>${dhBrasilia()}</dhResp><ultNSU>${String(fimNsu).padStart(15, '0')}</ultNSU><maxNSU>${String(fimNsu).padStart(15, '0')}</maxNSU>${docs.length ? `<loteDistDFeInt>${docs.join('')}</loteDistDFeInt>` : ''}</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>`;
}

/* ===================== HTTP (SOAP 1.2 + mTLS) ===================== */
// Se um servidor da SEFAZ usar certificado da cadeia ICP-Brasil (fora das autoridades que o Node conhece),
// aponte NFE_CA_ARQUIVO para um .pem com as ACs raiz/intermediárias da ICP-Brasil: elas se somam às padrão.
let caExtra = null;
function autoridades() {
  if (caExtra !== null) return caExtra || undefined;
  caExtra = false;
  try { const arq = process.env.NFE_CA_ARQUIVO; if (arq && fs.existsSync(arq)) caExtra = [...tls.rootCertificates, fs.readFileSync(arq, 'utf8')]; } catch { }
  return caExtra || undefined;
}
function soap(url, corpo, acao, { pfx, senha }) {
  return new Promise((ok, falha) => {
    const u = new URL(url); const dados = Buffer.from(corpo, 'utf8');
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', pfx, passphrase: senha, timeout: 60000, ca: autoridades(),
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${acao}"`, 'Content-Length': dados.length, 'User-Agent': 'MeuFiscal/2.0' } }, res => {
      const partes = []; res.on('data', c => partes.push(c));
      res.on('end', () => { const txt = Buffer.concat(partes).toString('utf8'); if (res.statusCode >= 500 && !/retDistDFeInt|retEnvEvento/.test(txt)) falha(new ErroHttp(502, 'A SEFAZ respondeu com erro ' + res.statusCode + '.')); else ok(txt); });
    });
    req.on('timeout', () => req.destroy(new Error('A SEFAZ não respondeu a tempo.')));
    req.on('error', e => falha(new ErroHttp(502, /mac verify|passphrase|PKCS12/i.test(e.message) ? 'Senha do certificado A1 incorreta.'
      : /issuer certificate|self.signed|UNABLE_TO_VERIFY|unable to get local/i.test(e.message + (e.code || '')) ? 'O servidor da SEFAZ usa um certificado da ICP-Brasil que o sistema ainda não reconhece (configure NFE_CA_ARQUIVO).'
      : 'Falha ao falar com a SEFAZ: ' + e.message)));
    req.write(dados); req.end();
  });
}

/* ===================== rotas e rotina ===================== */
export function registrarNfeEntrada(r, { db, exigir, log, pode }) {
  const A = criarApoio(db);
  const ambiente = () => (process.env.NFE_ENTRADA_AMBIENTE === 'homologacao' ? 'homologacao' : 'producao');
  const emCurso = new Set();

  async function certificado(esc, empresaId) {
    const [c] = await db.query('SELECT pfx_cifrado, senha_cifrada, valido_ate, cnpj FROM certificados_a1 WHERE escritorio_id = $1 AND empresa_id = $2', [esc, empresaId]);
    if (!c) return null;
    return { pfx: decifrar(c.pfx_cifrado, false), senha: decifrar(c.senha_cifrada), validoAte: c.valido_ate, cnpj: c.cnpj };
  }
  async function estado(esc, empresaId) {
    const [s] = await db.query('SELECT * FROM nfe_entrada_estado WHERE escritorio_id = $1 AND empresa_id = $2', [esc, empresaId]);
    return s || null;
  }
  async function salvarEstado(esc, empresaId, s) {
    await db.query(`INSERT INTO nfe_entrada_estado (escritorio_id, empresa_id, ult_nsu, max_nsu, proxima_em, ultima_em, c_stat, mensagem, notas_novas)
      VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8)
      ON CONFLICT (escritorio_id, empresa_id) DO UPDATE SET ult_nsu = EXCLUDED.ult_nsu, max_nsu = EXCLUDED.max_nsu, proxima_em = EXCLUDED.proxima_em,
        ultima_em = now(), c_stat = EXCLUDED.c_stat, mensagem = EXCLUDED.mensagem, notas_novas = EXCLUDED.notas_novas`,
      [esc, empresaId, s.ultNSU, s.maxNSU, s.proximaEm, s.cStat, String(s.mensagem || '').slice(0, 300), s.novas || 0]);
  }
  const cfgEntrada = cfg => ({ ativo: cfg?.nfeEntrada?.ativo !== false, cienciaAuto: cfg?.nfeEntrada?.cienciaAuto !== false });

  async function gravarNota(esc, e, d, quem) {
    if (!d.chave || !/^\d{44}$/.test(d.chave)) return null;
    const atual = await A.registro(esc, 'nfentrada', d.chave);
    if (atual && atual.completa && !d.completa) return { nota: atual, nova: false };   // já temos a completa
    let xmlArq = atual?.xml || null;
    if (d.completa && d.xml) xmlArq = await A.guardarArquivo(esc, e.id, Buffer.from(d.xml, 'utf8'), `NFe${d.chave}.xml`, 'application/xml', 'nfe-entrada');
    const nota = { ...(atual || {}), id: d.chave, empresaId: e.id, chave: d.chave, emitente: { ...(atual?.emitente || {}), ...Object.fromEntries(Object.entries(d.emitente || {}).filter(([, v]) => v)) },
      emissao: d.emissao || atual?.emissao || null, valor: d.valor || atual?.valor || 0, situacao: d.situacao === 'cancelada' || atual?.situacao === 'cancelada' ? 'cancelada' : d.situacao || atual?.situacao || 'autorizada',
      completa: !!(d.completa || atual?.completa), numero: d.numero || atual?.numero || (d.chave ? String(Number(d.chave.slice(25, 34))) : null), serie: d.serie || atual?.serie || (d.chave ? String(Number(d.chave.slice(22, 25))) : null),
      natOp: d.natOp || atual?.natOp || '', itens: d.itens || atual?.itens || null, protocolo: d.protocolo || atual?.protocolo || null, xml: xmlArq,
      nsu: d.nsu || atual?.nsu, recebidaEm: atual?.recebidaEm || new Date().toISOString(), atualizadaEm: new Date().toISOString(), manifestacao: atual?.manifestacao || null };
    await A.gravar(esc, 'nfentrada', d.chave, e.id, nota);
    return { nota, nova: !atual };
  }

  // ciência da operação (210210) para liberar o XML completo
  async function manifestar(esc, e, chave, quem, tpEvento = 210210) {
    const cert = await certificado(esc, e.id);
    if (!cert && !FALSO) throw new ErroHttp(400, 'A empresa não tem certificado A1 cadastrado.');
    const tpAmb = ambiente() === 'producao' ? 1 : 2;
    const ev = montarEvento({ tpAmb, cnpj: e.cnpj, chave, tpEvento });
    const pem = cert ? pemDoPfx(cert.pfx, cert.senha) : { chave: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), certB64: 'TESTE' };
    const corpo = envelopeEvento(assinarEvento(ev.xml, pem), String(Date.now()).slice(-15));
    const resp = FALSO ? simular('evento', corpo) : await soap(URLS[ambiente()].evento, corpo, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento', cert);
    const ret = bloco(resp, 'retEvento'); const cStat = tag(ret, 'cStat') || tag(resp, 'cStat'); const xMotivo = desesc(tag(ret, 'xMotivo') || tag(resp, 'xMotivo'));
    const ok = ['135', '136', '573'].includes(cStat);   // 573 = já registrada (duplicidade)
    const nota = await A.registro(esc, 'nfentrada', chave);
    if (nota) { nota.manifestacao = ok ? { tipo: tpEvento === 210200 ? 'confirmacao' : 'ciencia', em: new Date().toISOString(), protocolo: tag(ret, 'nProt'), por: quem || 'Sistema' } : { ...(nota.manifestacao || {}), erro: `${cStat} ${xMotivo}`, tentativaEm: new Date().toISOString() };
      await A.gravar(esc, 'nfentrada', chave, e.id, nota); }
    return { ok, cStat, xMotivo };
  }

  // uma rodada de consulta para a empresa: segue os NSUs até o maxNSU (no máximo 20 lotes) e respeita o bloqueio de 1 hora
  async function buscar(esc, empresaId, { quem = 'Sistema', manual = false } = {}) {
    const chaveRun = esc + ':' + empresaId; if (emCurso.has(chaveRun)) throw new ErroHttp(409, 'Já existe uma busca em andamento para esta empresa.');
    const e = await A.empresa(esc, empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (soDig(e.cnpj).length !== 14) throw new ErroHttp(400, 'A empresa não tem CNPJ cadastrado.');
    const cert = await certificado(esc, empresaId);
    if (!cert && !FALSO) throw new ErroHttp(400, 'Cadastre o certificado A1 da empresa (Certificados digitais) para buscar as notas de entrada.');
    if (cert && cert.validoAte && new Date(cert.validoAte) < new Date()) throw new ErroHttp(400, 'O certificado A1 da empresa está vencido.');
    if (cert?.cnpj && soDig(cert.cnpj).slice(0, 8) !== soDig(e.cnpj).slice(0, 8)) throw new ErroHttp(400, 'O certificado A1 cadastrado é de outro CNPJ. A SEFAZ só entrega as notas com o certificado da própria empresa.');
    const st = await estado(esc, empresaId);
    if (st?.proxima_em && new Date(st.proxima_em) > new Date()) {
      const min = Math.ceil((new Date(st.proxima_em) - Date.now()) / 60000);
      if (manual) throw new ErroHttp(429, `A SEFAZ só permite nova consulta desta empresa em ${min} minuto(s) (regra da SEFAZ: 1 hora entre consultas quando não há mais notas na fila).`);
      return { pulou: true };
    }
    emCurso.add(chaveRun);
    const cfg = cfgEntrada(await A.configEscritorio(esc)); const tpAmb = ambiente() === 'producao' ? 1 : 2;
    let ult = st?.ult_nsu || '0', max = st?.max_nsu || '0', cStat = '', msg = '', novas = 0, lotes = 0; const paraCiencia = [];
    try {
      do {
        const corpo = envelopeConsulta(montarConsulta({ tpAmb, uf: e.uf, cnpj: e.cnpj, ultNSU: ult }));
        const resp = FALSO ? simular('dist', corpo) : await soap(URLS[ambiente()].dist, corpo, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse', cert);
        const ret = lerRetornoDist(resp); cStat = ret.cStat; msg = ret.xMotivo; lotes++;
        if (cStat === '656' || cStat === '137') break;
        if (cStat !== '138') throw new ErroHttp(502, `SEFAZ: ${cStat} ${msg}`);
        for (const doc of ret.docs) {
          const d = interpretarDoc(doc);
          if (d.tipo === 'nota') {
            const g = await gravarNota(esc, e, d, quem); if (g?.nova) novas++;
            if (g && !g.nota.completa && g.nota.situacao === 'autorizada' && !g.nota.manifestacao?.em) paraCiencia.push(d.chave);
          } else if (d.tipo === 'evento' && d.chave && d.tpEvento === '110111') {   // cancelamento pelo emitente
            const n = await A.registro(esc, 'nfentrada', d.chave); if (n && n.situacao !== 'cancelada') await A.gravar(esc, 'nfentrada', d.chave, empresaId, { ...n, situacao: 'cancelada', canceladaEm: d.em || new Date().toISOString() });
          }
        }
        ult = ret.ultNSU; max = ret.maxNSU;
      } while (BigInt(ult) < BigInt(max) && lotes < 20);
      // chegou ao fim da fila (ou 137/656): a próxima consulta só depois de 1 hora; com fila pendente, continua na próxima rodada
      const fim = cStat === '137' || cStat === '656' || BigInt(ult) >= BigInt(max);
      await salvarEstado(esc, empresaId, { ultNSU: ult, maxNSU: max, proximaEm: new Date(Date.now() + (fim ? UMA_HORA : 5 * 60e3)), cStat, mensagem: cStat === '656' ? 'Consumo indevido: a SEFAZ bloqueou novas consultas por 1 hora.' : msg, novas });
      let ciencias = 0;
      if (cfg.cienciaAuto) for (const ch of paraCiencia.slice(0, 20)) { const m = await manifestar(esc, e, ch, 'Ciência automática').catch(() => null); if (m?.ok) ciencias++; await new Promise(ok => setTimeout(ok, FALSO ? 5 : 800)); }
      if (manual) await log('nfe_entrada_busca', { detalhe: `${e.razao || ''} · ${novas} nova(s) · ${cStat} · por ${quem}` }).catch(() => { });
      return { cStat, mensagem: msg, novas, ciencias, ultNSU: ult, maxNSU: max };
    } catch (er) {
      await salvarEstado(esc, empresaId, { ultNSU: ult, maxNSU: max, proximaEm: new Date(Date.now() + 30 * 60e3), cStat: cStat || 'erro', mensagem: er.message, novas });
      throw er;
    } finally { emCurso.delete(chaveRun); }
  }

  async function equipe(ctx, nivel = 'ver') {
    const u = await exigir(ctx);
    if (u.ambiente !== 'equipe' || !pode(u, 'guias', nivel)) throw new ErroHttp(403, 'Seu acesso não permite as notas de entrada.');
    return u;
  }

  // situação de todas as empresas (certificado, última busca, próxima, NSU)
  r.get('/api/nfentrada/status', async ctx => {
    const u = await equipe(ctx);
    const certs = await db.query('SELECT empresa_id, valido_ate, cnpj FROM certificados_a1 WHERE escritorio_id = $1', [u.escritorio_id]);
    const est = await db.query('SELECT empresa_id, ult_nsu, max_nsu, proxima_em, ultima_em, c_stat, mensagem, notas_novas FROM nfe_entrada_estado WHERE escritorio_id = $1', [u.escritorio_id]);
    const cfg = cfgEntrada(await A.configEscritorio(u.escritorio_id));
    return { ambiente: ambiente(), falso: FALSO, ...cfg,
      certificados: Object.fromEntries(certs.map(c => [c.empresa_id, { validoAte: c.valido_ate, cnpj: c.cnpj }])),
      estados: Object.fromEntries(est.map(s => [s.empresa_id, { ultNSU: s.ult_nsu, maxNSU: s.max_nsu, proximaEm: s.proxima_em, ultimaEm: s.ultima_em, cStat: s.c_stat, mensagem: s.mensagem, novas: s.notas_novas }])) };
  });
  r.post('/api/nfentrada/:empresaId/buscar', async ctx => {
    const u = await equipe(ctx, 'editar');
    return buscar(u.escritorio_id, String(ctx.params.empresaId), { quem: u.nome, manual: true });
  });
  r.post('/api/nfentrada/:empresaId/:chave/ciencia', async ctx => {
    const u = await equipe(ctx, 'editar');
    const e = await A.empresa(u.escritorio_id, String(ctx.params.empresaId)); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const chave = soDig(ctx.params.chave); const n = await A.registro(u.escritorio_id, 'nfentrada', chave);
    if (!n || n.empresaId !== e.id) throw new ErroHttp(404, 'Nota não encontrada.');
    const m = await manifestar(u.escritorio_id, e, chave, u.nome);
    if (!m.ok) throw new ErroHttp(502, `SEFAZ: ${m.cStat} ${m.xMotivo}`);
    return { ok: true, mensagem: 'Ciência registrada. O XML completo chega na próxima busca (até 1 hora).' };
  });

  // rotina: a cada 10 minutos, busca as empresas com certificado A1 cuja próxima consulta já venceu (uma por vez)
  async function rotina() {
    const linhas = await db.query(`SELECT c.escritorio_id, c.empresa_id FROM certificados_a1 c
      LEFT JOIN nfe_entrada_estado s ON s.escritorio_id = c.escritorio_id AND s.empresa_id = c.empresa_id
      WHERE (c.valido_ate IS NULL OR c.valido_ate >= current_date) AND (s.proxima_em IS NULL OR s.proxima_em <= now())
      ORDER BY s.ultima_em NULLS FIRST LIMIT 30`);
    const cfgs = new Map();
    for (const l of linhas) {
      if (!cfgs.has(l.escritorio_id)) cfgs.set(l.escritorio_id, cfgEntrada(await A.configEscritorio(l.escritorio_id)));
      if (!cfgs.get(l.escritorio_id).ativo) continue;
      const e = await A.empresa(l.escritorio_id, l.empresa_id); if (!e || e.status === 'inativo' || soDig(e.cnpj).length !== 14) continue;
      await buscar(l.escritorio_id, l.empresa_id).catch(er => console.error('[nfe-entrada]', l.empresa_id, er.message));
      await new Promise(ok => setTimeout(ok, FALSO ? 10 : 3000));
    }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => rotina().catch(() => { }), 90000).unref?.(); setInterval(() => rotina().catch(() => { }), 10 * 60000).unref?.(); }
  return { buscar, manifestar, rotina };
}
