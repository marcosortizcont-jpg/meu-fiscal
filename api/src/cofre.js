// Criptografia dos segredos dos clientes (senha do certificado, arquivo .pfx e senhas de portais).
// AES-256-GCM com chave que fica só nas variáveis do servidor (COFRE_CHAVE), nunca no banco.
// Quem tiver uma cópia do banco sem a chave vê apenas bytes cifrados.
import crypto from 'node:crypto';
import tls from 'node:tls';
import { CONFIG } from './config.js';

const VERSAO = 1;
const chave = () => {
  if (!CONFIG.cofreChave) throw Object.assign(new Error('Cofre indisponível: falta a variável COFRE_CHAVE no servidor.'), { status: 503 });
  return crypto.createHash('sha256').update('meufiscal-cofre:' + CONFIG.cofreChave).digest();
};

export function cifrar(valor) {
  const dados = Buffer.isBuffer(valor) ? valor : Buffer.from(String(valor), 'utf8');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const ct = Buffer.concat([c.update(dados), c.final()]);
  return Buffer.concat([Buffer.from([VERSAO]), iv, c.getAuthTag(), ct]);
}
export function decifrar(buf, comoTexto = true) {
  if (!buf || buf[0] !== VERSAO) throw new Error('Formato cifrado desconhecido.');
  const iv = buf.subarray(1, 13), tag = buf.subarray(13, 29), ct = buf.subarray(29);
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), iv); d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ct), d.final()]);
  return comoTexto ? out.toString('utf8') : out;
}

/* Lê um certificado A1 (.pfx/.p12): confere a senha e devolve titular, CNPJ e validade.
 * Requer o Node iniciado com --openssl-legacy-provider para os .pfx no formato antigo do ICP-Brasil. */
export function lerCertificadoA1(pfx, senha) {
  let ctx;
  try { ctx = tls.createSecureContext({ pfx, passphrase: senha }); }
  catch (e) {
    const m = String(e.message || '');
    if (/mac verify|bad decrypt|invalid password/i.test(m)) throw new Error('Senha do certificado incorreta.');
    if (/Unsupported PKCS12/i.test(m)) throw new Error('Formato de certificado antigo não suportado neste servidor.');
    throw new Error('Arquivo de certificado inválido. Envie o .pfx (ou .p12) completo, com a chave privada.');
  }
  const der = ctx.context.getCertificate?.();
  if (!der) throw new Error('O arquivo não contém o certificado.');
  const x = new crypto.X509Certificate(der);
  const cn = (x.subject.match(/CN=([^\n]+)/) || [])[1] || '';
  const cnpj = (cn.match(/:(\d{14})\b/) || x.subject.match(/\b(\d{14})\b/) || [])[1] || null;
  return {
    titular: cn.replace(/:\d{11,14}$/, '').trim() || cn,
    cnpj,
    emissor: (x.issuer.match(/CN=([^\n]+)/) || [])[1] || '',
    validoDe: new Date(x.validFrom).toISOString().slice(0, 10),
    validoAte: new Date(x.validTo).toISOString().slice(0, 10),
    serial: x.serialNumber,
  };
}
