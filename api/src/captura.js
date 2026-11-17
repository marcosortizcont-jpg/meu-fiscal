// Captura automática para a escrita fiscal:
//  - NFS-e emitidas pela empresa, no Ambiente de Dados Nacional (ADN) da NFS-e: GET /contribuintes/DFe/{NSU} com mTLS
//    pelo certificado A1 da própria empresa. A resposta traz LoteDFe[] com ArquivoXml em gzip+base64.
//  - Situação de NF-e/NFC-e emitidas (autorizada, cancelada, denegada) pelo NFeConsultaProtocolo4 da SEFAZ autorizadora.
// O XML vai para o navegador, que importa pelas mesmas regras das notas enviadas à mão (competência travada, cancelamentos etc.).
// Teste local: CAPTURA_FALSO=1 simula os dois serviços (nunca em produção).
import https from 'node:https';
import zlib from 'node:zlib';
import { ErroHttp } from './http.js';
import { decifrar } from './cofre.js';
import { criarApoio, soDig } from './apoio.js';

export const FALSO = process.env.CAPTURA_FALSO === '1' && process.env.NODE_ENV !== 'production';
const ADN = { producao: 'https://adn.nfse.gov.br', restrita: 'https://adn.producaorestrita.nfse.gov.br' };
// NFeConsultaProtocolo4 por UF autorizadora (código IBGE da UF = 2 primeiros dígitos da chave); demais UFs usam a SVRS
const CONSULTA = {
  55: { 50: 'https://nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4', 35: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx', 31: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
    41: 'https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4', 52: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4', 51: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
    43: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', 29: 'https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', 26: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
    13: 'https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4', svrs: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx' },
  65: { 50: 'https://nfce.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4', svrs: 'https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx' },
};
const SIT = c => ['100', '150'].includes(c) ? 'autorizada' : ['101', '135', '151', '155'].includes(c) ? 'cancelada' : ['110', '301', '302', '303'].includes(c) ? 'denegada' : c === '217' ? 'nao_encontrada' : 'outra';

function pedir(url, { metodo = 'GET', corpo = null, cabecalhos = {}, pfx, senha }) {
  return new Promise((ok, falha) => {
    const u = new URL(url); const dados = corpo ? Buffer.from(corpo, 'utf8') : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: metodo, pfx, passphrase: senha, timeout: 60000,
      headers: { 'User-Agent': 'MeuFiscal/2.0', Accept: 'application/json, text/xml', ...(dados ? { 'Content-Length': dados.length } : {}), ...cabecalhos } }, res => {
      const partes = []; res.on('data', c => partes.push(c)); res.on('end', () => ok({ status: res.statusCode, texto: Buffer.concat(partes).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('O serviço não respondeu a tempo.')));
    req.on('error', e => falha(new ErroHttp(502, /mac verify|passphrase|PKCS12/i.test(e.message) ? 'Senha do certificado A1 incorreta.' : 'Falha na comunicação: ' + e.message)));
    if (dados) req.write(dados); req.end();
  });
}
const tag = (xml, t) => { const m = new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${t}>`).exec(xml || ''); return m ? m[1].trim() : null; };

function simNfse(cnpj, n) {
  const dia = new Date(Date.now() - 86400000 * (3 + n)).toISOString().slice(0, 10); const num = 900 + n; const v = (1500 + n * 250).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS5002704${cnpj}${String(num).padStart(15, '0')}"><cLocIncid>5002704</cLocIncid><nNFSe>${num}</nNFSe><cLocEmi>5002704</cLocEmi><dhProc>${dia}T09:00:00-04:00</dhProc><emit><CNPJ>${cnpj}</CNPJ><xNome>PRESTADOR</xNome></emit><valores><vBC>${v}</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>${(v * 0.02).toFixed(2)}</vISSQN><vLiq>${v}</vLiq></valores><DPS versao="1.00"><infDPS Id="DPS${num}"><dhEmi>${dia}T08:59:00-04:00</dhEmi><dCompet>${dia}</dCompet><serie>900</serie><prest><CNPJ>${cnpj}</CNPJ></prest><toma><CNPJ>11222333000181</CNPJ><xNome>TOMADOR SIMULADO</xNome></toma><serv><cServ><cTribNac>010101</cTribNac><xDescServ>Servico simulado</xDescServ></cServ></serv><valores><vServPrest><vServ>${v}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
}

export function registrarCaptura(r, { db, exigir, log, pode }) {
  const A = criarApoio(db);
  const ambiente = () => (process.env.NFSE_ADN_AMBIENTE === 'restrita' ? 'restrita' : 'producao');
  async function equipe(ctx) {
    const u = await exigir(ctx);
    if (u.ambiente !== 'equipe' || !pode(u, 'guias', 'editar')) throw new ErroHttp(403, 'Seu acesso não permite capturar notas.');
    return u;
  }
  async function certificado(esc, empresaId) {
    const [c] = await db.query('SELECT pfx_cifrado, senha_cifrada, valido_ate FROM certificados_a1 WHERE escritorio_id = $1 AND empresa_id = $2', [esc, empresaId]);
    if (!c) return null;
    if (c.valido_ate && new Date(c.valido_ate) < new Date()) throw new ErroHttp(400, 'O certificado A1 da empresa está vencido.');
    return { pfx: decifrar(c.pfx_cifrado, false), senha: decifrar(c.senha_cifrada) };
  }

  // NFS-e emitidas pela empresa, a partir do último NSU (até 20 lotes por chamada)
  r.post('/api/captura/:empresaId/nfse', async ctx => {
    const u = await equipe(ctx); const e = await A.empresa(u.escritorio_id, ctx.params.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const cnpj = soDig(e.cnpj); const cert = FALSO ? null : await certificado(u.escritorio_id, e.id);
    if (!cert && !FALSO) throw new ErroHttp(400, 'Cadastre o certificado A1 da empresa (Notas de entrada > Certificados) para buscar as NFS-e no Ambiente Nacional.');
    const est = (await A.registro(u.escritorio_id, 'capturaestado', 'adn:' + e.id)) || { ultNSU: 0 };
    const docs = []; let nsu = Number(est.ultNSU || 0); let msg = '';
    for (let i = 0; i < 20; i++) {
      let lote;
      if (FALSO) lote = nsu >= 2 ? [] : [1, 2].map(k => ({ NSU: k, TipoDocumento: 'NFSE', xml: simNfse(cnpj, k) }));
      else {
        const resp = await pedir(`${ADN[ambiente()]}/contribuintes/DFe/${nsu}`, { pfx: cert.pfx, senha: cert.senha });
        if (resp.status === 404 || resp.status === 204) { msg = 'Nenhum documento novo no Ambiente Nacional.'; break; }
        if (resp.status >= 400) throw new ErroHttp(502, `O Ambiente Nacional da NFS-e respondeu ${resp.status}: ${resp.texto.slice(0, 200)}`);
        let j; try { j = JSON.parse(resp.texto); } catch { throw new ErroHttp(502, 'Resposta inesperada do Ambiente Nacional.'); }
        lote = (j.LoteDFe || j.loteDFe || []).map(x => ({ NSU: Number(x.NSU || x.nsu), TipoDocumento: x.TipoDocumento || x.tipoDocumento,
          xml: zlib.gunzipSync(Buffer.from(x.ArquivoXml || x.arquivoXml, 'base64')).toString('utf8') }));
        if (!lote.length) { msg = j.StatusProcessamento === 'NENHUM_DOCUMENTO_LOCALIZADO' ? 'Nenhum documento novo.' : (j.StatusProcessamento || ''); }
      }
      if (!lote.length) break;
      const ant = nsu; lote = lote.filter(d => d.NSU > ant); if (!lote.length) break;
      for (const d of lote) { nsu = Math.max(nsu, d.NSU); if (/NFSE/i.test(d.TipoDocumento || 'NFSE') && d.xml.includes(cnpj)) docs.push({ nome: `NFSe_NSU${d.NSU}.xml`, xml: d.xml }); }
      if (lote.length < 50 && !FALSO) break;
    }
    await A.gravar(u.escritorio_id, 'capturaestado', 'adn:' + e.id, e.id, { ultNSU: nsu, em: new Date().toISOString() });
    await log('captura_nfse', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao || ''} · ${docs.length} NFS-e · NSU ${nsu}` });
    return { docs, ultNSU: nsu, mensagem: msg };
  });

  // situação das NF-e/NFC-e na SEFAZ autorizadora
  r.post('/api/captura/:empresaId/situacao', async ctx => {
    const u = await equipe(ctx); const e = await A.empresa(u.escritorio_id, ctx.params.empresaId); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    const chaves = (ctx.corpo?.chaves || []).map(soDig).filter(c => c.length === 44).slice(0, 200);
    if (!chaves.length) throw new ErroHttp(400, 'Nenhuma chave de acesso válida.');
    const cert = FALSO ? null : await certificado(u.escritorio_id, e.id);
    if (!cert && !FALSO) throw new ErroHttp(400, 'Cadastre o certificado A1 da empresa para consultar a SEFAZ.');
    const resultado = [];
    for (const ch of chaves) {
      if (FALSO) { const n = Number(ch.slice(25, 34)); resultado.push({ chave: ch, cStat: n % 10 === 6 ? '101' : '100', situacao: n % 10 === 6 ? 'cancelada' : 'autorizada' }); continue; }
      const mod = ch.slice(20, 22) === '65' ? 65 : 55; const uf = Number(ch.slice(0, 2)); const url = CONSULTA[mod][uf] || CONSULTA[mod].svrs;
      const corpo = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4"><consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>1</tpAmb><xServ>CONSULTAR</xServ><chNFe>${ch}</chNFe></consSitNFe></nfeDadosMsg></soap12:Body></soap12:Envelope>`;
      try {
        const resp = await pedir(url, { metodo: 'POST', corpo, pfx: cert.pfx, senha: cert.senha, cabecalhos: { 'Content-Type': 'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF"' } });
        // cStat do protocolo/evento mais recente prevalece sobre o do retorno (que é 100/101 resumido)
        const ret = tag(resp.texto, 'retConsSitNFe') || resp.texto; const cRet = tag(ret, 'cStat');
        const cEv = [...(ret.matchAll(/<(?:\w+:)?retEvento[\s\S]*?<\/(?:\w+:)?retEvento>/g))].map(m => [tag(m[0], 'tpEvento'), tag(m[0], 'cStat')]).find(([t, c]) => ['110111', '110112'].includes(t) && ['135', '136', '155'].includes(c));
        const c = cEv ? '101' : cRet; resultado.push({ chave: ch, cStat: c, situacao: SIT(c), motivo: tag(ret, 'xMotivo') });
      } catch (er) { resultado.push({ chave: ch, cStat: 'erro', situacao: 'erro', motivo: er.message }); }
    }
    await log('captura_situacao', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao || ''} · ${chaves.length} chave(s)` });
    return { resultado };
  }, { limite: 64 * 1024 });
}
