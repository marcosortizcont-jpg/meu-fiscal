// Banco para cobranças (honorários e ativação de cadastro): Banco Inter (boleto com PIX, "Bolepix") ou Asaas.
//
// Inter: API de Cobrança v3 com certificado do próprio Inter (mTLS) + OAuth (client_id/secret).
//   Cada cobrança sai como boleto com QR Code PIX; o cliente paga pelo que preferir.
//   O aviso de pagamento (webhook) não é assinado: ele só diz qual cobrança olhar e o sistema
//   confere a situação direto no Inter antes de dar baixa. A URL do aviso leva um segredo do escritório.
// Credenciais ficam cifradas com a COFRE_CHAVE e nunca voltam ao navegador.
import https from 'node:https';
import crypto from 'node:crypto';
import { ErroHttp } from './http.js';
import { decifrar } from './cofre.js';
import { soDig, agoraLocal, addDias } from './apoio.js';

const FALSO = process.env.FINANCEIRO_FALSO === '1' && process.env.NODE_ENV !== 'production';
const INTER = { producao: 'https://cdpj.partners.bancointer.com.br', sandbox: 'https://cdpj-sandbox.partners.uatinter.co' };
const ESCOPOS_INTER = 'boleto-cobranca.read boleto-cobranca.write';
const ASAAS = { producao: 'https://api.asaas.com/v3', sandbox: 'https://api-sandbox.asaas.com/v3' };
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const PAGO_INTER = ['RECEBIDO', 'MARCADO_RECEBIDO'];
const PAGO_ASAAS = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

export function criarBanco(db, A) {
  async function cfg(esc) { const [c] = await db.query('SELECT * FROM financeiro_config WHERE escritorio_id = $1', [esc]); return c || null; }
  const provedor = c => FALSO ? (c?.provedor === 'asaas' ? 'asaas' : 'inter') : c?.provedor || 'manual';
  const pronto = c => FALSO || (c?.provedor === 'inter' && c.inter_client_id && c.inter_secret_cifrado && c.inter_cert_cifrado && c.inter_key_cifrada)
    || (c?.provedor === 'asaas' && !!c.api_key_cifrada);

  /* ================= Inter ================= */
  const tokens = new Map();
  function reqInter(c, metodo, caminho, { corpo, form, token } = {}) {
    return new Promise((ok, falha) => {
      const u = new URL(INTER[c.ambiente === 'sandbox' ? 'sandbox' : 'producao'] + caminho);
      const dados = form ? new URLSearchParams(form).toString() : corpo ? JSON.stringify(corpo) : '';
      const headers = { Accept: 'application/json', 'Content-Length': Buffer.byteLength(dados) };
      if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded'; else if (corpo) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = 'Bearer ' + token;
      if (c.inter_conta) headers['x-conta-corrente'] = String(c.inter_conta).replace(/\D/g, '');
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: metodo, headers, cert: decifrar(c.inter_cert_cifrado), key: decifrar(c.inter_key_cifrada), timeout: 40000 }, res => {
        const partes = []; res.on('data', d => partes.push(d));
        res.on('end', () => { const txt = Buffer.concat(partes).toString('utf8'); let json = null; try { json = txt ? JSON.parse(txt) : {}; } catch { } ok({ status: res.statusCode, json, txt }); });
      });
      req.on('timeout', () => req.destroy(new Error('O Inter não respondeu a tempo. Tente de novo em alguns minutos.')));
      req.on('error', e => falha(new ErroHttp(502, /certificate|key|PEM|ssl|tls/i.test(e.message) ? 'O Inter recusou o certificado. Confira se enviou o .crt e o .key da mesma integração, e se não venceram.' : 'Inter: ' + e.message)));
      req.end(dados);
    });
  }
  const erroInter = (rr, padrao) => { const j = rr.json || {}; const det = [j.title, j.detail, ...(j.violacoes || []).map(v => (v.propriedade ? v.propriedade + ': ' : '') + (v.razao || v.valor || ''))].filter(Boolean).join(' · ');
    return new ErroHttp(rr.status === 429 ? 429 : 502, (padrao ? padrao + ' ' : '') + (det || rr.txt.slice(0, 200) || 'HTTP ' + rr.status)); };
  async function tokenInter(c, forcar) {
    const t = tokens.get(c.escritorio_id); if (t && !forcar && t.expira > Date.now() + 60000) return t.access;
    const rr = await reqInter(c, 'POST', '/oauth/v2/token', { form: { client_id: c.inter_client_id, client_secret: decifrar(c.inter_secret_cifrado), scope: ESCOPOS_INTER, grant_type: 'client_credentials' } });
    if (rr.status !== 200 || !rr.json?.access_token) throw rr.status === 401 || rr.status === 400 ? new ErroHttp(502, 'O Inter recusou o Client ID/Secret ou as permissões da integração (marque Boleto/Cobrança: emitir e consultar). ' + (rr.json?.error_description || '')) : erroInter(rr, 'Falha ao autenticar no Inter:');
    tokens.set(c.escritorio_id, { access: rr.json.access_token, expira: Date.now() + (Number(rr.json.expires_in) || 3600) * 1000 });
    return rr.json.access_token;
  }
  async function inter(c, metodo, caminho, corpo) {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const tk = await tokenInter(c, tentativa > 0);
      const rr = await reqInter(c, metodo, caminho, { corpo, token: tk });
      if (rr.status === 401 && tentativa === 0) continue;
      if (rr.status >= 300) throw erroInter(rr, 'Inter:');
      return rr.json || {};
    }
  }
  function pagadorInter(e, email) {
    const en = e.endereco || {}; const doc = soDig(e.cnpj || e.cpf); const fone = soDig(e.telefone).replace(/^55(?=\d{10,11}$)/, '');
    const falta = [!doc && 'CNPJ', !soDig(en.cep) && 'CEP', !en.logradouro && 'endereço', !e.municipio && 'município', !e.uf && 'UF'].filter(Boolean);
    if (falta.length) throw new ErroHttp(400, `Para emitir boleto no Inter, complete no cadastro de ${e.fantasia || e.razao}: ${falta.join(', ')}.`);
    return { cpfCnpj: doc, tipoPessoa: doc.length === 11 ? 'FISICA' : 'JURIDICA', nome: String(e.razao || e.fantasia).slice(0, 100), endereco: String(en.logradouro).slice(0, 90), numero: String(en.numero || 'S/N').slice(0, 10),
      complemento: String(en.complemento || '').slice(0, 30) || undefined, bairro: String(en.bairro || 'Centro').slice(0, 60), cidade: String(e.municipio).slice(0, 60), uf: String(e.uf).toUpperCase().slice(0, 2), cep: soDig(en.cep).slice(0, 8),
      email: email || undefined, ddd: fone.length >= 10 ? fone.slice(0, 2) : undefined, telefone: fone.length >= 10 ? fone.slice(2) : undefined };
  }
  const seuNumero = () => 'M' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();   // até 15 caracteres
  // o Inter libera o PIX antes do boleto: espera a linha digitável (até ~25 s) para o boleto sair junto
  async function detalheInter(c, id, esperar) {
    let d = null;
    for (let i = 0; i < (esperar ? 16 : 1); i++) {
      d = await inter(c, 'GET', `/cobranca/v3/cobrancas/${encodeURIComponent(id)}`);
      const sit = d.cobranca?.situacao || d.situacao;
      if (sit === 'FALHA_EMISSAO') throw new ErroHttp(502, 'O Inter não conseguiu emitir a cobrança (FALHA_EMISSAO). Confira os dados do pagador.');
      if (!esperar || (sit && sit !== 'EM_PROCESSAMENTO' && d.boleto?.linhaDigitavel)) return d;
      await new Promise(ok => setTimeout(ok, 1500));
    }
    return d;
  }
  // PDF do boleto (com o QR Code PIX): o Inter pode demorar alguns segundos para liberar
  async function pdfInter(c, id, tentativas = 1) {
    for (let i = 0; i < tentativas; i++) {
      try { const d = await inter(c, 'GET', `/cobranca/v3/cobrancas/${encodeURIComponent(id)}/pdf`); if (d.pdf) { const b = Buffer.from(d.pdf, 'base64'); if (String(b.subarray(0, 4)) === '%PDF') return b; } }
      catch (er) { if (i === tentativas - 1) console.error('[inter] pdf', id, er.message); }
      if (i < tentativas - 1) await new Promise(ok => setTimeout(ok, 2500));
    }
    return null;
  }

  /* ================= Asaas (mantido para quem já usava) ================= */
  async function asaas(c, metodo, caminho, corpo) {
    const rr = await fetch(ASAAS[c.ambiente === 'sandbox' ? 'sandbox' : 'producao'] + caminho, { method: metodo,
      headers: { access_token: decifrar(c.api_key_cifrada), 'Content-Type': 'application/json', 'User-Agent': 'MeuFiscal' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(30000) });
    const txt = await rr.text(); let j = null; try { j = JSON.parse(txt); } catch { }
    if (!rr.ok) throw new ErroHttp(502, rr.status === 401 ? 'O Asaas recusou a chave da API.' : 'Asaas: ' + ((j?.errors || []).map(x => x.description).join(' ') || txt.slice(0, 200)));
    return j;
  }
  async function clienteAsaas(c, esc, e) {
    if (e.cobranca?.asaasId && e.cobranca?.ambiente === c.ambiente) return e.cobranca.asaasId;
    const doc = soDig(e.cnpj || e.cpf); let id = doc ? (await asaas(c, 'GET', '/customers?cpfCnpj=' + doc)).data?.[0]?.id : null;
    if (!id) id = (await asaas(c, 'POST', '/customers', { name: e.razao || e.fantasia, cpfCnpj: doc || undefined, email: (await A.emailsDaEmpresa(esc, e.id, e))[0], mobilePhone: soDig(e.telefone) || undefined, externalReference: e.id, notificationDisabled: true })).id;
    const atual = await A.empresa(esc, e.id) || e; await A.gravar(esc, 'empresas', e.id, e.id, { ...atual, cobranca: { ...(atual.cobranca || {}), asaasId: id, ambiente: c.ambiente } });
    return id;
  }

  /* ================= interface usada pelo Financeiro e pela Ativação ================= */
  // emite uma cobrança e devolve { provedor, id, linha, pix, link, venc, arquivo }
  async function emitir(esc, { ref, e, valor, venc, descricao, multa, juros }) {
    const c = await cfg(esc); if (!pronto(c)) throw new ErroHttp(412, 'Conecte o banco em Financeiro › Régua e automação › Banco para emitir boletos.');
    const prov = provedor(c); const hoje = agoraLocal().data; const v = venc && venc >= hoje ? venc : addDias(hoje, 1);
    if (r2(valor) < 2.5) throw new ErroHttp(400, 'O valor mínimo de um boleto é R$ 2,50.');
    const email = (await A.emailsDaEmpresa(esc, e.id, e))[0];
    let out;
    if (FALSO) {
      if (prov === 'inter') pagadorInter(e, email);
      const id = (prov === 'inter' ? 'inter-' : 'pay_') + crypto.randomUUID().slice(0, 12);
      out = { provedor: prov, id, seuNumero: seuNumero(), linha: '07790.00116 12345.678901 23456.789012 1 ' + Date.now().toString().slice(-14), pix: '00020101021226900014br.gov.bcb.pix2568simulado.inter.co/' + id + '5204000053039865802BR5913MEU FISCAL6012CAMPO GRANDE62070503***6304ABCD',
        link: prov === 'asaas' ? 'https://sandbox.asaas.com/i/' + id : '', venc: v, pdf: Buffer.from(`%PDF-1.4\n% boleto simulado ${prov} ${id}\n%%EOF\n`) };
    } else if (prov === 'inter') {
      const sn = seuNumero();
      const r0 = await inter(c, 'POST', '/cobranca/v3/cobrancas', { seuNumero: sn, valorNominal: r2(valor), dataVencimento: v, numDiasAgenda: 30, pagador: pagadorInter(e, email),
        ...(Number(multa) > 0 ? { multa: { codigo: 'PERCENTUAL', taxa: Number(multa) } } : {}), ...(Number(juros) > 0 ? { mora: { codigo: 'TAXAMENSAL', taxa: Number(juros) } } : {}),
        mensagem: { linha1: String(descricao || 'Honorários contábeis').slice(0, 78) } });
      const id = r0.codigoSolicitacao; if (!id) throw new ErroHttp(502, 'O Inter não devolveu o código da cobrança.');
      const d = await detalheInter(c, id, true);
      const pdf = await pdfInter(c, id, 6);
      out = { provedor: 'inter', id, seuNumero: sn, linha: d.boleto?.linhaDigitavel || '', pix: d.pix?.pixCopiaECola || '', link: '', venc: v, pdf };
    } else {
      const cliente = await clienteAsaas(c, esc, e);
      const p = await asaas(c, 'POST', '/payments', { customer: cliente, billingType: 'UNDEFINED', value: r2(valor), dueDate: v, description: String(descricao || '').slice(0, 500), externalReference: ref,
        fine: Number(multa) > 0 ? { value: Number(multa) } : undefined, interest: Number(juros) > 0 ? { value: Number(juros) } : undefined, postalService: false });
      const [pix, lin] = await Promise.all([asaas(c, 'GET', `/payments/${p.id}/pixQrCode`).catch(() => null), asaas(c, 'GET', `/payments/${p.id}/identificationField`).catch(() => null)]);
      let pdf = null; try { const b = Buffer.from(await (await fetch(p.bankSlipUrl, { signal: AbortSignal.timeout(30000) })).arrayBuffer()); if (String(b.subarray(0, 4)) === '%PDF') pdf = b; } catch { }
      out = { provedor: 'asaas', id: p.id, linha: lin?.identificationField || '', pix: pix?.payload || '', link: p.invoiceUrl, venc: p.dueDate || v, pdf };
    }
    await db.query('INSERT INTO banco_cobrancas (escritorio_id, provedor, cobranca_id, seu_numero, ref, valor, venc) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (escritorio_id, provedor, cobranca_id) DO NOTHING',
      [esc, out.provedor, out.id, out.seuNumero || null, ref, r2(valor), out.venc]);
    out.arquivo = out.pdf ? await A.guardarArquivo(esc, e.id, out.pdf, `Boleto ${String(descricao || '').replace(/[^\wÀ-ú -]/g, '').slice(0, 40) || 'cobrança'}.pdf`, 'application/pdf', 'boletos') : null;
    delete out.pdf; return out;
  }
  // situação no banco: { pago, situacao, valor, data, forma }
  async function consultar(esc, prov, id) {
    const c = await cfg(esc); if (!pronto(c)) throw new ErroHttp(412, 'Banco não conectado.');
    if (FALSO) { const [x] = await db.query('SELECT pago_simulado FROM banco_cobrancas WHERE escritorio_id = $1 AND cobranca_id = $2', [esc, id]); return { pago: !!x?.pago_simulado, situacao: x?.pago_simulado ? 'RECEBIDO' : 'A_RECEBER', data: agoraLocal().data, forma: 'PIX' }; }
    if (prov === 'inter') {
      const d = await detalheInter(c, id, false); const co = d.cobranca || d; const sit = co.situacao;
      return { pago: PAGO_INTER.includes(sit), situacao: sit, valor: r2(co.valorTotalRecebido || co.valorRecebido || co.valorNominal), data: String(co.dataSituacao || co.dataHoraSituacao || '').slice(0, 10) || agoraLocal().data,
        forma: co.origemRecebimento === 'PIX' ? 'PIX' : co.origemRecebimento === 'BOLETO' ? 'Boleto' : sit === 'MARCADO_RECEBIDO' ? 'Marcado como recebido' : 'Inter' };
    }
    const p = await asaas(c, 'GET', `/payments/${id}`);
    return { pago: PAGO_ASAAS.includes(p.status), situacao: p.status, valor: r2(p.value), data: String(p.paymentDate || p.clientPaymentDate || p.confirmedDate || '').slice(0, 10) || agoraLocal().data, forma: { BOLETO: 'Boleto', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito' }[p.billingType] || 'Asaas' };
  }
  async function cancelar(esc, prov, id, motivo) {
    const c = await cfg(esc); if (!pronto(c) || FALSO) return;
    if (prov === 'inter') await inter(c, 'POST', `/cobranca/v3/cobrancas/${encodeURIComponent(id)}/cancelar`, { motivoCancelamento: String(motivo || 'Cancelada pelo escritório').slice(0, 50) }).catch(er => { if (!/cancel|j[aá]|situa/i.test(er.message)) throw er; });
    else await asaas(c, 'DELETE', `/payments/${id}`).catch(() => { });
  }
  // baixa manual (recebeu por fora): o boleto deixa de valer no banco, para o cliente não pagar duas vezes
  async function baixarNoBanco(esc, prov, id, data, valor) {
    const c = await cfg(esc); if (!pronto(c) || FALSO) return;
    if (prov === 'inter') return cancelar(esc, prov, id, 'Pago por outro meio');
    await asaas(c, 'POST', `/payments/${id}/receiveInCash`, { paymentDate: data, value: valor, notifyCustomer: false }).catch(er => { if (!/já|already|received/i.test(er.message)) throw er; });
  }
  async function pdf(esc, prov, id) { const c = await cfg(esc); if (!pronto(c)) return null; if (FALSO) return Buffer.from(`%PDF-1.4\n% boleto simulado ${id}\n%%EOF\n`); return prov === 'inter' ? pdfInter(c, id, 4) : null; }
  async function testar(esc, urlAviso) {
    const c = await cfg(esc); if (!pronto(c)) throw new ErroHttp(412, 'Preencha os dados do banco e salve antes de testar.');
    if (FALSO) return 'Conexão simulada (teste local).';
    if (provedor(c) === 'inter') {
      await tokenInter(c, true);
      let aviso = '';
      if (urlAviso && urlAviso.startsWith('https://')) { try { await inter(c, 'PUT', '/cobranca/v3/cobrancas/webhook', { webhookUrl: urlAviso }); aviso = ' Aviso de pagamento (webhook) cadastrado no Inter.'; } catch (er) { aviso = ' Mas o aviso de pagamento não foi cadastrado: ' + er.message; } }
      else aviso = ' O aviso de pagamento só é cadastrado com a API publicada em https.';
      return `Conexão com o Inter (${c.ambiente === 'sandbox' ? 'sandbox' : 'produção'}) funcionando.` + aviso;
    }
    await asaas(c, 'GET', '/customers?limit=1'); return 'Conexão com o Asaas funcionando.';
  }
  async function refDe(esc, prov, id) { const [x] = await db.query('SELECT ref FROM banco_cobrancas WHERE escritorio_id = $1 AND provedor = $2 AND cobranca_id = $3', [esc, prov, String(id)]); return x?.ref || null; }
  async function simularPago(esc, id) { await db.query('UPDATE banco_cobrancas SET pago_simulado = true WHERE escritorio_id = $1 AND cobranca_id = $2', [esc, id]); }
  return { cfg, pronto, provedor, emitir, consultar, cancelar, baixarNoBanco, pdf, testar, refDe, simularPago, FALSO };
}
