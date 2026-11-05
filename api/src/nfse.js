// Emissor de NFS-e no padrão nacional (Sistema Nacional NFS-e / SEFIN Nacional), feito no servidor.
//
// Fluxo: monta a DPS (leiaute 1.01) com os dados da empresa, do tomador e do serviço → assina (XMLDSig, rsa-sha1,
// C14N, assinatura irmã de infDPS) com o certificado A1 da empresa guardado no cofre → envia por mTLS para
// POST /nfse ({ dpsXmlGZipB64 }) → recebe a NFS-e autorizada (XML) → baixa o DANFSe no ADN → guarda tudo.
// Cancelamento: evento e101101 (pedRegEvento) em POST /nfse/{chave}/eventos.
// Ambiente por empresa: "homologacao" (produção restrita, sem valor fiscal) ou "producao".
// Quem emite onde: MEI e optantes do Simples emitem no padrão nacional. Em municípios com emissor próprio,
// as empresas fora do Simples emitem pelo emissor da prefeitura (ver EMISSOR_PROPRIO): o sistema não envia
// ao SEFIN e oferece gerar a DPS para emissão no portal do município.
// Campo Grande/MS (Sefaz, cronograma da reforma): desde 01/11/2026 os optantes do Simples emitem só no
// Emissor Nacional; os não optantes, só no emissor municipal (nfse.campogrande.ms.gov.br).
import crypto from 'node:crypto';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ErroHttp } from './http.js';
import { decifrar } from './cofre.js';
import { limitar } from './seguranca.js';
import { gerarPdf } from './pdf.js';
import { criarApoio, soDig, brl, fmtData, agoraLocal } from './apoio.js';
import { sugerirPorCnae, palavras } from './nfse-cnae.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DADOS = JSON.parse(fs.readFileSync(path.join(AQUI, 'nfse-dados.json'), 'utf8'));
const SERV = new Map(DADOS.servicos); const NBS = new Map(DADOS.nbs);
export const FALSO = process.env.NFSE_FALSO === '1' && process.env.NODE_ENV !== 'production';
const VERSAO = '1.01', NS = 'http://www.sped.fazenda.gov.br/nfse', DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const URLS = {
  producao: { sefin: 'https://sefin.nfse.gov.br/SefinNacional', adn: 'https://adn.nfse.gov.br' },
  homologacao: { sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional', adn: 'https://adn.producaorestrita.nfse.gov.br' },
};
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
// municípios em que os não optantes do Simples NÃO emitem no Emissor Nacional
export const EMISSOR_PROPRIO = {
  '5002704': { nome: 'Campo Grande/MS', portal: 'https://nfse.campogrande.ms.gov.br', desde: '2026-11-01' },
};
export const emissorDe = (e, ibge) => (e.regime === 'MEI' || /^SN/.test(e.regime || '') || !EMISSOR_PROPRIO[ibge]) ? 'nacional' : 'municipal';
const fmtIm = v => { const d = String(v || '').replace(/\s/g, ''); return !d ? '' : /^\d+$/.test(d) ? d.slice(-15).padStart(15, '0') : d.slice(0, 15); };
const dec = n => r2(n).toFixed(2);

/* ===================== XML ===================== */
// texto já no formato canônico (C14N): só &, < e > escapados; sem caracteres de controle
const txt = (s, max) => { let v = String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim(); if (max) v = v.slice(0, max); return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
const el = (n, v) => (v === undefined || v === null || v === '') ? '' : `<${n}>${v}</${n}>`;
const grupo = (n, corpo) => corpo ? `<${n}>${corpo}</${n}>` : '';

export function dataHoraBr(d = new Date(Date.now() - 60000)) {   // horário de Brasília, 1 min no passado (o SEFIN recusa dhEmi no futuro)
  const b = new Date(d.getTime() - 3 * 3600e3); const p = n => String(n).padStart(2, '0');
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}T${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}-03:00`;
}
export const idDps = ({ cMun, doc, serie, nDPS }) => 'DPS' + cMun + (soDig(doc).length === 11 ? '1' : '2') + soDig(doc).padStart(14, '0') + String(serie).padStart(5, '0') + String(nDPS).padStart(15, '0');

// regime do prestador no leiaute: opSimpNac 1 não optante, 2 MEI, 3 ME/EPP
const regimeDe = e => e.regime === 'MEI' ? 2 : /^SN/.test(e.regime || '') ? 3 : 1;

export function conferirDados({ e, t, s, valor }) {
  const falta = [];
  if (soDig(e.cnpj).length !== 14) falta.push('CNPJ da empresa');
  if (!/^\d{7}$/.test(String(e.ibge || ''))) falta.push('código IBGE do município da empresa');
  if (!t) falta.push('tomador'); else if (![11, 14].includes(soDig(t.doc).length)) falta.push('CPF/CNPJ do tomador');
  if (!s) falta.push('serviço'); else if (!/^\d{6}$/.test(String(s.cTribNac || ''))) falta.push('código de tributação nacional do serviço (6 dígitos)');
  else if (!SERV.has(String(s.cTribNac))) falta.push(`código ${s.cTribNac} não existe na lista nacional`);
  if (s?.cNBS && !/^\d{9}$/.test(String(s.cNBS))) falta.push('código NBS (9 dígitos)');
  if (!(Number(valor) > 0)) falta.push('valor do serviço');
  return falta;
}

export function montarDps({ e, n, t, s, tpAmb }) {
  const reg = regimeDe(e); const retido = !!n.issRetido; const aliq = Number(n.aliqISS ?? s.aliqISS ?? 0);
  const cMun = String(e.ibge); const id = idDps({ cMun, doc: e.cnpj, serie: n.serie, nDPS: n.nDPS });
  const docT = soDig(t.doc);
  const endT = t.cep && /^\d{7}$/.test(String(t.ibge || '')) && t.logradouro ? grupo('end', grupo('endNac', el('cMun', t.ibge) + el('CEP', soDig(t.cep))) + el('xLgr', txt(t.logradouro, 255)) + el('nro', txt(t.numero || 'S/N', 60)) + el('xCpl', txt(t.complemento, 156)) + el('xBairro', txt(t.bairro || 'Centro', 60))) : '';
  const tribMun = el('tribISSQN', '1') + el('tpRetISSQN', retido ? '2' : '1') + (retido && reg !== 2 && aliq > 0 ? el('pAliq', dec(aliq)) : '');
  const totTrib = reg === 1 ? grupo('pTotTrib', el('pTotTribFed', '0.00') + el('pTotTribEst', '0.00') + el('pTotTribMun', dec(aliq))) : el('indTotTrib', '0');
  const desc = [n.descricao || s.descricao, n.obs].filter(Boolean).join(' - ');
  const inf = el('tpAmb', String(tpAmb)) + el('dhEmi', n.dhEmi) + el('verAplic', 'MeuFiscal-2.0') + el('serie', String(n.serie)) + el('nDPS', String(n.nDPS))
    + el('dCompet', n.dCompet) + el('tpEmit', '1') + el('cLocEmi', cMun)
    + (n.substitui?.chave ? grupo('subst', el('chSubstda', soDig(n.substitui.chave)) + el('cMotivo', n.substitui.cMotivo || '99') + el('xMotivo', txt(n.substitui.motivo || 'Substituição da nota', 255))) : '')
    + grupo('prest', el('CNPJ', soDig(e.cnpj)) + el('IM', txt(fmtIm(e.nfse?.im || e.inscricaoMunicipal || e.im))) + el('fone', soDig(e.telefone).length >= 6 ? soDig(e.telefone).slice(-20) : '') + el('email', txt(e.email, 80))
      + grupo('regTrib', el('opSimpNac', String(reg)) + (reg === 3 ? el('regApTribSN', '1') : '') + el('regEspTrib', '0')))
    + grupo('toma', el(docT.length === 11 ? 'CPF' : 'CNPJ', docT) + el('xNome', txt(t.nome, 300)) + endT + el('fone', soDig(t.telefone).length >= 6 ? soDig(t.telefone).slice(-20) : '') + el('email', txt(t.email, 80)))
    + grupo('serv', grupo('locPrest', el('cLocPrestacao', String(n.cLocPrestacao || cMun))) + grupo('cServ', el('cTribNac', String(s.cTribNac)) + el('cTribMun', s.cTribMun ? soDig(s.cTribMun).slice(0, 3) : '') + el('xDescServ', txt(desc, 2000)) + el('cNBS', s.cNBS ? soDig(s.cNBS) : '')))
    + grupo('valores', grupo('vServPrest', el('vServ', dec(n.valor))) + grupo('trib', grupo('tribMun', tribMun) + grupo('totTrib', totTrib)));
  return { id, xml: `<DPS xmlns="${NS}" versao="${VERSAO}"><infDPS Id="${id}">${inf}</infDPS></DPS>` };
}

export function montarCancelamento({ chave, cnpj, cMotivo, xMotivo, tpAmb }) {
  const id = 'PRE' + soDig(chave) + '101101';
  const inf = el('tpAmb', String(tpAmb)) + el('verAplic', 'MeuFiscal-2.0') + el('dhEvento', dataHoraBr()) + el('CNPJAutor', soDig(cnpj)) + el('chNFSe', soDig(chave))
    + grupo('e101101', el('xDesc', 'Cancelamento de NFS-e') + el('cMotivo', String(cMotivo)) + el('xMotivo', txt(xMotivo, 255)));
  return { id, xml: `<pedRegEvento xmlns="${NS}" versao="${VERSAO}"><infPedReg Id="${id}">${inf}</infPedReg></pedRegEvento>` };
}

// assinatura enveloped: o elemento assinado (com o Id) recebe a <Signature> logo depois, dentro da raiz
export function assinarXml(xml, tag, { chave, certB64 }) {
  const ini = xml.indexOf(`<${tag} Id="`); const fim = xml.indexOf(`</${tag}>`) + tag.length + 3;
  if (ini < 0 || fim < tag.length + 3) throw new Error('Elemento a assinar não encontrado.');
  const alvo = xml.slice(ini, fim); const id = /Id="([^"]+)"/.exec(alvo)[1];
  const canon = alvo.replace(`<${tag} Id=`, `<${tag} xmlns="${NS}" Id=`);   // C14N: herda o namespace da raiz
  const digest = crypto.createHash('sha1').update(canon, 'utf8').digest('base64');
  const si = `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod><SignatureMethod Algorithm="${DS}rsa-sha1"></SignatureMethod><Reference URI="#${id}"><Transforms><Transform Algorithm="${DS}enveloped-signature"></Transform><Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${DS}sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference>`;
  const valor = crypto.createSign('RSA-SHA1').update(`<SignedInfo xmlns="${DS}">${si}</SignedInfo>`, 'utf8').sign(chave, 'base64');
  const sig = `<Signature xmlns="${DS}"><SignedInfo>${si}</SignedInfo><SignatureValue>${valor}</SignatureValue><KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
  return '<?xml version="1.0" encoding="UTF-8"?>' + xml.slice(0, fim) + sig + xml.slice(fim);
}

/* ===================== certificado A1 ===================== */
const cacheChaves = new Map();
// chave privada e certificado (PEM) a partir do .pfx, pelo openssl do servidor (aceita .pfx antigos com -legacy)
export function pemDoPfx(pfx, senha) {
  const k = crypto.createHash('sha256').update(pfx).update(String(senha)).digest('hex');
  const c = cacheChaves.get(k); if (c && Date.now() - c.em < 30 * 60e3) return c.v;
  const arq = path.join(os.tmpdir(), 'mf-' + crypto.randomBytes(8).toString('hex') + '.pfx');
  fs.writeFileSync(arq, pfx, { mode: 0o600 });
  try {
    let out = null, erro = '';
    for (const extra of [[], ['-legacy']]) {
      const r = spawnSync('openssl', ['pkcs12', '-in', arq, '-nodes', '-clcerts', '-passin', 'env:MF_P12', ...extra], { env: { ...process.env, MF_P12: String(senha) }, encoding: 'utf8', timeout: 15000 });
      if (r.error) { erro = r.error.code === 'ENOENT' ? 'openssl não está instalado no servidor' : r.error.message; break; }
      if (r.status === 0 && /PRIVATE KEY/.test(r.stdout)) { out = r.stdout; break; }
      erro = (r.stderr || '').split('\n')[0];
    }
    if (!out) throw new ErroHttp(422, /mac verify|password|invalid/i.test(erro) ? 'Senha do certificado A1 incorreta.' : 'Não foi possível ler o certificado A1: ' + erro);
    const chave = /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |ENCRYPTED )?PRIVATE KEY-----/.exec(out)[0];
    const certs = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const pub = crypto.createPublicKey(chave).export({ type: 'spki', format: 'der' }).toString('base64');
    const cert = certs.find(cp => crypto.createPublicKey(cp).export({ type: 'spki', format: 'der' }).toString('base64') === pub) || certs[0];
    if (!cert) throw new ErroHttp(422, 'O certificado A1 não tem o certificado público.');
    const x = new crypto.X509Certificate(cert);
    const v = { chave, certB64: cert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''), validoAte: new Date(x.validTo), titular: x.subject };
    cacheChaves.set(k, { em: Date.now(), v }); return v;
  } finally { try { fs.unlinkSync(arq); } catch { } }
}

/* ===================== SEFIN / ADN ===================== */
function requisitar(url, { metodo = 'GET', corpo, pfx, senha, aceitar = 'application/json', timeout = 45000 }) {
  return new Promise((ok, falha) => {
    const u = new URL(url); const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: metodo, pfx, passphrase: senha, timeout,
      headers: { Accept: aceitar, 'User-Agent': 'MeuFiscal/2.0', ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}) } }, res => {
      const partes = []; res.on('data', c => partes.push(c)); res.on('end', () => ok({ status: res.statusCode, tipo: String(res.headers['content-type'] || ''), corpo: Buffer.concat(partes) }));
    });
    req.on('timeout', () => req.destroy(new Error('O ambiente nacional da NFS-e não respondeu a tempo.')));
    req.on('error', e => falha(new ErroHttp(502, /mac verify|passphrase|PKCS12/i.test(e.message) ? 'Senha do certificado A1 incorreta.' : 'Falha ao falar com o ambiente nacional da NFS-e: ' + e.message)));
    if (dados) req.write(dados); req.end();
  });
}
const gunzipB64 = b => zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8');
const tagXml = (xml, t) => { const m = new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml || ''); return m ? m[1] : null; };
function lerResposta(r) {
  let j = null; try { j = JSON.parse(r.corpo.toString('utf8')); } catch { }
  const lista = j && (j.erros || j.erro || j.Erros || j.Erro);
  if (lista && (!Array.isArray(lista) || lista.length)) {
    const erros = [].concat(lista).map(x => ({ codigo: String(x.Codigo || x.codigo || ''), descricao: String(x.Descricao || x.descricao || ''), complemento: String(x.Complemento || x.complemento || '').slice(0, 300) }));
    return { ok: false, erros, json: j };
  }
  if (r.status >= 400) return { ok: false, erros: [{ codigo: 'HTTP ' + r.status, descricao: (j && (j.message || j.title)) || r.corpo.toString('utf8').slice(0, 300) || 'Erro no ambiente nacional', complemento: '' }], json: j };
  const campo = j && Object.keys(j).find(k => /XmlGZipB64$/.test(k));
  const xml = campo ? gunzipB64(j[campo]) : null;
  return { ok: true, json: j, xml, chave: j?.chaveAcesso || tagXml(xml, 'chNFSe') || (xml && (/Id="NFS(\d{50})"/.exec(xml) || [])[1]) || null };
}

export function registrarNfse(r, { db, exigir, log, pode }) {
  const A = criarApoio(db);
  async function acesso(ctx, empresaId) {
    const u = await exigir(ctx);
    if (u.ambiente === 'cliente') { if (!u.empresas.some(x => x.id === String(empresaId))) throw new ErroHttp(403, 'Você não tem acesso a esta empresa.'); }
    else if (!pode(u, 'guias', 'editar')) throw new ErroHttp(403, 'Seu acesso não permite emitir notas.');
    const e = await A.empresa(u.escritorio_id, String(empresaId)); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    return { u, e };
  }
  const ambienteDe = e => e.nfse?.ambiente === 'producao' ? 'producao' : 'homologacao';
  const resolverIbge = e => { if (/^\d{7}$/.test(String(e.ibge || ''))) return String(e.ibge);
    const n = String(e.municipio || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); const uf = String(e.uf || '').toUpperCase();
    for (const [cod, [nome, u]] of Object.entries(DADOS.ibge)) if (u === uf && nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === n) return cod;
    return ''; };
  async function certificado(esc, empresaId) {
    const [c] = await db.query('SELECT pfx_cifrado, senha_cifrada, valido_ate, cnpj FROM certificados_a1 WHERE escritorio_id = $1 AND empresa_id = $2', [esc, empresaId]);
    if (!c) return null;
    return { pfx: decifrar(c.pfx_cifrado, false), senha: decifrar(c.senha_cifrada), validoAte: c.valido_ate, cnpj: c.cnpj };
  }
  let chaveTeste = null;
  function assinaturaTeste() {   // só no teste local: certificado autoassinado
    if (chaveTeste) return chaveTeste;
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    chaveTeste = { chave: privateKey.export({ type: 'pkcs8', format: 'pem' }), certB64: 'TESTE' }; return chaveTeste;
  }

  // emite (ou reenvia) uma nota já gravada
  async function transmitir(esc, e, n, quem) {
    const t = n.tomador; const s = n.servico; const amb = ambienteDe(e); const tpAmb = amb === 'producao' ? 1 : 2;
    const ee = { ...e, ibge: resolverIbge(e) };
    const falta = conferirDados({ e: ee, t, s, valor: n.valor }); if (falta.length) throw new ErroHttp(400, 'Para emitir, falta: ' + falta.join(', ') + '.');
    if (emissorDe(ee, ee.ibge) === 'municipal') { const m = EMISSOR_PROPRIO[ee.ibge]; throw new ErroHttp(409, `Em ${m.nome}, empresas fora do Simples Nacional emitem a nota pelo emissor da prefeitura (${m.portal}), não pelo Emissor Nacional. Use "Gerar DPS da nota" e emita no portal do município.`); }
    const cert = await certificado(esc, e.id);
    if (!cert && !FALSO) throw new ErroHttp(412, 'A empresa não tem certificado digital A1 guardado. Envie o certificado em Certificado digital para emitir notas pelo sistema.');
    if (cert && cert.validoAte && String(cert.validoAte).slice(0, 10) < agoraLocal().data) throw new ErroHttp(412, 'O certificado digital A1 da empresa está vencido. Renove para emitir notas.');
    const pem = cert ? pemDoPfx(cert.pfx, cert.senha) : assinaturaTeste();
    n.dhEmi = dataHoraBr(); const hojeBr = n.dhEmi.slice(0, 10);
    const c = String(n.comp || hojeBr.slice(0, 7)); if (c > hojeBr.slice(0, 7)) throw new ErroHttp(400, 'A competência não pode ser posterior ao mês atual.');
    n.dCompet = c === hojeBr.slice(0, 7) ? hojeBr : new Date(Date.UTC(+c.slice(0, 4), +c.slice(5, 7), 0)).toISOString().slice(0, 10);
    const { id, xml } = montarDps({ e: ee, n, t, s, tpAmb });
    const assinado = assinarXml(xml, 'infDPS', pem);
    n.idDPS = id; n.ambiente = amb; n.transmissao = { em: new Date().toISOString(), por: quem, tentativas: Number(n.transmissao?.tentativas || 0) + 1 };
    const dpsArq = await A.guardarArquivo(esc, e.id, Buffer.from(assinado), `DPS ${n.nDPS}.xml`, 'application/xml', 'nfse');
    n.dps = { id: dpsArq.id, url: dpsArq.url };
    let res;
    if (FALSO) {
      const chave = cMunChave(ee.ibge) + String(Date.now()).padStart(43, '0').slice(-43);
      res = { ok: !/rejeitar/i.test(n.obs || ''), chave, xml: `<NFSe xmlns="${NS}" versao="${VERSAO}"><infNFSe Id="NFS${chave}"><nNFSe>${n.nDPS}</nNFSe><cVerif>TESTE</cVerif></infNFSe>${assinado.replace(/^<\?xml[^>]*>/, '')}</NFSe>`,
        erros: [{ codigo: 'E0312', descricao: 'Rejeição simulada (teste local).', complemento: '' }] };
    } else {
      const u = URLS[amb]; const gz = zlib.gzipSync(Buffer.from(assinado, 'utf8')).toString('base64');
      res = lerResposta(await requisitar(u.sefin + '/nfse', { metodo: 'POST', corpo: { dpsXmlGZipB64: gz }, pfx: cert.pfx, senha: cert.senha }));
      // DPS já enviada antes (ex.: queda de conexão): recupera a nota autorizada pelo Id da DPS
      if (!res.ok && res.erros.some(x => /E0014|ja existe|já existe|duplic/i.test(x.codigo + ' ' + x.descricao))) {
        const d = lerResposta(await requisitar(u.sefin + '/dps/' + id, { pfx: cert.pfx, senha: cert.senha }));
        const ch = d.json?.chaveAcesso; if (ch) { const nf = lerResposta(await requisitar(u.sefin + '/nfse/' + ch, { pfx: cert.pfx, senha: cert.senha })); if (nf.ok) res = { ...nf, chave: ch }; }
      }
    }
    if (!res.ok) {
      Object.assign(n, { status: 'rejeitada', erros: res.erros, rejeitadaEm: new Date().toISOString() });
      await gravarNota(esc, n); await log('nfse_rejeitada', { detalhe: `${e.razao} · DPS ${n.nDPS} · ${res.erros.map(x => x.codigo).join(', ')}` });
      return n;
    }
    const xmlNfse = res.xml || '';
    const arqXml = xmlNfse ? await A.guardarArquivo(esc, e.id, Buffer.from(xmlNfse), `NFS-e ${tagXml(xmlNfse, 'nNFSe') || n.nDPS}.xml`, 'application/xml', 'nfse') : null;
    Object.assign(n, { status: 'autorizada', chave: res.chave, numero: tagXml(xmlNfse, 'nNFSe') || n.numero || '', cVerif: tagXml(xmlNfse, 'cVerif') || '', erros: [], autorizadaEm: new Date().toISOString(),
      xml: arqXml ? { id: arqXml.id, url: arqXml.url, nome: arqXml.nome } : null });
    n.danfse = await baixarDanfse(esc, e, n, cert, amb).catch(er => { console.error('[nfse] danfse', er.message); return null; });
    await gravarNota(esc, n);
    if (n.substitui?.id) { const ant = await A.registro(esc, 'notas', n.substitui.id); if (ant) await gravarNota(esc, { ...ant, status: 'substituida', substituidaPor: n.id }); }
    await log('nfse_autorizada', { detalhe: `${e.razao} · NFS-e ${n.numero} · ${brl(n.valor)} · ${amb}` });
    return n;
  }
  const cMunChave = cMun => String(cMun || '0000000').padStart(7, '0');
  async function baixarDanfse(esc, e, n, cert, amb) {
    let pdf = null;
    if (!FALSO && cert) {
      for (let i = 0; i < 3 && !pdf; i++) {
        const rr = await requisitar(URLS[amb].adn + '/danfse/' + n.chave, { pfx: cert.pfx, senha: cert.senha, aceitar: 'application/pdf' }).catch(() => null);
        if (rr && rr.status === 200 && String(rr.corpo.subarray(0, 4)) === '%PDF') pdf = rr.corpo; else await new Promise(ok => setTimeout(ok, 2000));
      }
    }
    const oficial = !!pdf; if (!pdf) pdf = espelho(e, n);   // sem o DANFSe oficial: espelho com a chave para consulta
    const a = await A.guardarArquivo(esc, e.id, pdf, `DANFSe ${n.numero || n.nDPS}.pdf`, 'application/pdf', 'nfse');
    return { id: a.id, url: a.url, nome: a.nome, oficial };
  }
  function espelho(e, n) {
    return gerarPdf({ titulo: `NFS-e ${n.numero}`, rodape: `Chave ${n.chave}`, blocos: [
      { t: 'titulo', texto: n.ambiente === 'producao' ? 'NOTA FISCAL DE SERVIÇO ELETRÔNICA (NFS-e)' : 'NFS-e · AMBIENTE DE TESTE · SEM VALOR FISCAL' },
      { t: 'subtitulo', texto: `Número ${n.numero || '—'} · emitida em ${fmtData(String(n.autorizadaEm).slice(0, 10))} · consulte em nfse.gov.br/consultapublica` },
      { t: 'h', texto: 'Chave de acesso' }, { t: 'p', texto: String(n.chave || '') },
      { t: 'h', texto: 'Prestador' }, { t: 'quadro', itens: [['Razão social', e.razao], ['CNPJ', soDig(e.cnpj).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')], ['Município', `${e.municipio || ''}/${e.uf || ''}`]] },
      { t: 'h', texto: 'Tomador' }, { t: 'quadro', itens: [['Nome', n.tomador.nome], ['CPF/CNPJ', n.tomador.doc]] },
      { t: 'h', texto: 'Serviço' }, { t: 'quadro', itens: [['Código', `${n.servico.cTribNac} · ${SERV.get(String(n.servico.cTribNac)) || ''}`], ['Descrição', [n.descricao, n.obs].filter(Boolean).join(' - ')], ['Competência', n.comp], ['Valor', brl(n.valor)], ['ISS', n.issRetido ? 'Retido pelo tomador' : e.regime === 'MEI' ? 'Incluso no DAS-MEI' : 'Recolhido pelo prestador']] },
    ] });
  }
  async function gravarNota(esc, n) { await A.gravar(esc, 'notas', n.id, n.empresaId, n); }
  async function proximoNumero(esc, empresaId) {
    const [x] = await db.query(`SELECT max((dados->>'nDPS')::bigint) AS m FROM registros WHERE escritorio_id = $1 AND colecao = 'notas' AND empresa_id = $2 AND dados->>'nDPS' ~ '^[0-9]+$'`, [esc, empresaId]);
    return Number(x?.m || 0) + 1;
  }

  /* ---------- rotas ---------- */
  // situação para emitir: certificado, município, regime e ambiente
  r.get('/api/nfse/situacao/:empresaId', async ctx => {
    const { u, e } = await acesso(ctx, ctx.params.empresaId);
    const [c] = await db.query('SELECT valido_ate, titular FROM certificados_a1 WHERE escritorio_id = $1 AND empresa_id = $2', [u.escritorio_id, e.id]);
    const ibge = resolverIbge(e);
    const emissor = emissorDe(e, ibge);
    return { ambiente: ambienteDe(e), falso: FALSO, ibge, municipio: DADOS.ibge[ibge]?.[0] || e.municipio || '', uf: e.uf || '', emissor, portalMunicipal: emissor === 'municipal' ? EMISSOR_PROPRIO[ibge].portal : '',
      certificado: c ? { validoAte: c.valido_ate, vencido: String(c.valido_ate).slice(0, 10) < agoraLocal().data } : null, regime: e.regime || '', pronta: !!(c || FALSO) && !!ibge && emissor === 'nacional' };
  });
  r.post('/api/nfse/emitir', async ctx => {
    const b = ctx.corpo || {}; const { u, e } = await acesso(ctx, b.empresaId); const esc = u.escritorio_id;
    if (limitar(`nfse:${u.id}`, 60, 3600).bloqueado) throw new ErroHttp(429, 'Muitas emissões seguidas. Aguarde alguns minutos.');
    const t = await A.registro(esc, 'tomadores', String(b.tomadorId || '')); const s = await A.registro(esc, 'servicos', String(b.servicoId || ''));
    if (!t || t.empresaId !== e.id) throw new ErroHttp(400, 'Selecione o tomador.'); if (!s || s.empresaId !== e.id) throw new ErroHttp(400, 'Selecione o serviço.');
    const valor = r2(b.valor); const sub = b.substituiId ? await A.registro(esc, 'notas', String(b.substituiId)) : null;
    if (sub && (sub.empresaId !== e.id || sub.status !== 'autorizada')) throw new ErroHttp(409, 'Só é possível substituir uma nota autorizada.');
    let n = b.notaId ? await A.registro(esc, 'notas', String(b.notaId)) : null;
    if (n && (n.empresaId !== e.id || !['rejeitada', 'dps_gerada'].includes(n.status))) throw new ErroHttp(409, 'Esta nota não pode ser reenviada.');
    const base = { empresaId: e.id, serie: String(e.nfse?.serie || '1'), data: agoraLocal().data, comp: String(b.comp || agoraLocal().comp).slice(0, 7), tomadorId: t.id,
      tomador: { nome: t.nome, doc: soDig(t.doc), email: t.email || '', telefone: t.telefone || '', cep: t.cep || '', logradouro: t.logradouro || '', numero: t.numero || '', complemento: t.complemento || '', bairro: t.bairro || '', ibge: t.ibge || '' },
      servicoId: s.id, servico: { cTribNac: s.cTribNac, cTribMun: s.cTribMun || '', cNBS: s.cNBS || '', aliqISS: Number(s.aliqISS || 0), descricao: s.descricao },
      descricao: s.descricao, cTribNac: s.cTribNac, valor, issRetido: !!b.issRetido, aliqISS: Number(s.aliqISS || 0), obs: String(b.obs || '').slice(0, 1500),
      substitui: sub ? { id: sub.id, chave: sub.chave, cMotivo: ['01', '02', '03', '04', '05', '99'].includes(b.cMotivoSubst) ? b.cMotivoSubst : '99', motivo: String(b.motivoSubst || 'Substituição da nota').slice(0, 255) } : null, uid: u.id };
    n = n ? { ...n, ...base } : { id: 'nf-' + crypto.randomUUID(), nDPS: await proximoNumero(esc, e.id), numero: null, chave: '', status: 'processando', criadaEm: new Date().toISOString(), ...base };
    await gravarNota(esc, n);
    try { n = await transmitir(esc, e, n, u.nome); }
    catch (er) { if (er.status && er.status < 500) { await gravarNota(esc, { ...n, status: 'rejeitada', erros: [{ codigo: 'Sistema', descricao: er.message, complemento: '' }] }); } throw er; }
    return { ok: n.status === 'autorizada', nota: n };
  }, { limite: 64 * 1024 });
  r.post('/api/nfse/:id/cancelar', async ctx => {
    const b = ctx.corpo || {}; const u0 = await exigir(ctx); const n = await A.registro(u0.escritorio_id, 'notas', ctx.params.id); if (!n) throw new ErroHttp(404, 'Nota não encontrada.');
    const { u, e } = await acesso(ctx, n.empresaId); const esc = u.escritorio_id;
    if (n.status !== 'autorizada') throw new ErroHttp(409, 'Só notas autorizadas podem ser canceladas.');
    const xMotivo = String(b.motivo || '').trim(); if (xMotivo.length < 15) throw new ErroHttp(400, 'Descreva o motivo do cancelamento com pelo menos 15 caracteres.');
    const cMotivo = ['1', '2', '9'].includes(String(b.cMotivo)) ? String(b.cMotivo) : '9';
    const amb = n.ambiente || ambienteDe(e); const tpAmb = amb === 'producao' ? 1 : 2;
    const cert = await certificado(esc, e.id); if (!cert && !FALSO) throw new ErroHttp(412, 'A empresa não tem certificado digital A1 guardado.');
    const { xml } = montarCancelamento({ chave: n.chave, cnpj: e.cnpj, cMotivo, xMotivo, tpAmb });
    const assinado = assinarXml(xml, 'infPedReg', cert ? pemDoPfx(cert.pfx, cert.senha) : assinaturaTeste());
    let res = { ok: true };
    if (!FALSO) {
      res = lerResposta(await requisitar(URLS[amb].sefin + '/nfse/' + n.chave + '/eventos', { metodo: 'POST', corpo: { pedidoRegistroEventoXmlGZipB64: zlib.gzipSync(Buffer.from(assinado)).toString('base64') }, pfx: cert.pfx, senha: cert.senha }));
      if (!res.ok && res.erros.some(x => /E0840|já .*cancel/i.test(x.codigo + ' ' + x.descricao))) res = { ok: true };   // já estava cancelada
      if (!res.ok) throw new ErroHttp(422, 'O ambiente nacional recusou o cancelamento: ' + res.erros.map(x => `${x.codigo} ${x.descricao}`).join('; '));
    }
    const ev = res.xml ? await A.guardarArquivo(esc, e.id, Buffer.from(res.xml), `Cancelamento NFS-e ${n.numero}.xml`, 'application/xml', 'nfse') : null;
    const novo = { ...n, status: 'cancelada', motivoCanc: xMotivo, cMotivoCanc: cMotivo, canceladaEm: new Date().toISOString(), canceladaPor: u.nome, ...(ev ? { eventoCanc: { id: ev.id, url: ev.url } } : {}) };
    await gravarNota(esc, novo); await log('nfse_cancelada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao} · NFS-e ${n.numero} · ${xMotivo}` });
    return { ok: true, nota: novo };
  });
  r.post('/api/nfse/:id/danfse', async ctx => {   // baixa de novo o DANFSe oficial
    const u0 = await exigir(ctx); const n = await A.registro(u0.escritorio_id, 'notas', ctx.params.id); if (!n || n.status !== 'autorizada') throw new ErroHttp(404, 'Nota não encontrada.');
    const { u, e } = await acesso(ctx, n.empresaId); const cert = await certificado(u.escritorio_id, e.id);
    const d = await baixarDanfse(u.escritorio_id, e, n, cert, n.ambiente || ambienteDe(e)); await gravarNota(u.escritorio_id, { ...n, danfse: d });
    return { ok: true, danfse: d };
  });

  // sugestões de serviço pela atividade (CNAE) da empresa + busca na lista nacional
  r.get('/api/nfse/servicos', async ctx => {
    const q = ctx.query || {}; const { e } = await acesso(ctx, q.empresaId);
    const cnaes = [e.cnae, ...(e.cnaesSecundarios || []).map(x => x.codigo || x)].filter(Boolean);
    const porCnae = sugerirPorCnae(cnaes);
    const termos = palavras([q.q, porCnae.length ? '' : e.atividade].filter(Boolean).join(' '));
    // cada palavra: 2 pontos se aparece igual, 1 se parecida (mesmo começo); bônus quando todas aparecem
    const pontuar = d => { const ws = [...new Set(palavras(d))]; let tot = 0, achou = 0;
      for (const w of termos) { const p = ws.includes(w) ? 2 : ws.some(x => x.startsWith(w) || w.startsWith(x) || (x.length > 5 && w.length > 5 && x.slice(0, 6) === w.slice(0, 6))) ? 1 : 0; tot += p; if (p) achou++; }
      return tot + (termos.length > 1 && achou === termos.length ? 3 : 0); };
    const busca = termos.length ? DADOS.servicos.map(([c, d]) => [c, d, pontuar(d) + (String(q.q || '').replace(/\D/g, '') && c.startsWith(String(q.q).replace(/\D/g, '')) ? 5 : 0)]).filter(x => x[2] > 0).sort((a, b) => b[2] - a[2]).slice(0, 15) : [];
    const cod = String(q.q || '').replace(/\D/g, ''); const porCodigo = cod.length >= 2 ? DADOS.servicos.filter(([c]) => c.startsWith(cod.padEnd(2, '0').slice(0, cod.length))).slice(0, 15) : [];
    return { atividade: e.atividade || '', cnae: e.cnae || '', sugeridos: porCnae.map(c => ({ cTribNac: c, descricao: SERV.get(c) || '' })),
      resultados: [...porCodigo.map(([c, d]) => ({ cTribNac: c, descricao: d })), ...busca.map(([c, d]) => ({ cTribNac: c, descricao: d }))].filter((x, i, a) => a.findIndex(y => y.cTribNac === x.cTribNac) === i).slice(0, 20) };
  });
  r.get('/api/nfse/nbs', async ctx => {
    await exigir(ctx); const q = ctx.query || {};
    const termos = palavras([q.q, SERV.get(String(q.cTribNac || '')) || ''].join(' '));
    const cod = String(q.q || '').replace(/\D/g, '');
    const xs = DADOS.nbs.map(([c, d]) => { const ws = new Set(palavras(d)); return [c, d, termos.reduce((a, w) => a + (ws.has(w) ? 2 : 0), 0) + (cod.length >= 3 && c.startsWith(cod) ? 10 : 0)]; })
      .filter(x => x[2] > 0).sort((a, b) => b[2] - a[2]).slice(0, 12);
    return { resultados: xs.map(([c, d]) => ({ cNBS: c, descricao: d })) };
  });
  return { transmitir };
}
