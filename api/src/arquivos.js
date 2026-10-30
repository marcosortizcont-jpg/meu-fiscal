// Armazenamento de arquivos. Produção: qualquer serviço compatível com S3 (Cloudflare R2 no plano gratuito),
// com URL pré-assinada (AWS SigV4) para o navegador enviar e baixar direto, sem passar pela API.
// Desenvolvimento: pasta local.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const hex = s => crypto.createHash('sha256').update(s).digest('hex');
// RFC 3986, como a AWS exige
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function preAssinar({ metodo, endpoint, regiao, bucket, chave, idChave, segredo, expira = 600, cabecalhos = {}, data = new Date() }) {
  const u = new URL(endpoint);
  const host = u.host;
  const caminho = '/' + [u.pathname.replace(/^\/|\/$/g, ''), bucket, chave].filter(Boolean).join('/').split('/').map(enc).join('/');
  const amzData = data.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dia = amzData.slice(0, 8);
  const escopo = `${dia}/${regiao}/s3/aws4_request`;
  const cab = { host, ...Object.fromEntries(Object.entries(cabecalhos).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  const nomes = Object.keys(cab).sort();
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${idChave}/${escopo}`, 'X-Amz-Date': amzData,
    'X-Amz-Expires': String(expira), 'X-Amz-SignedHeaders': nomes.join(';'),
  };
  const consulta = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonica = [metodo, caminho, consulta, nomes.map(n => `${n}:${cab[n]}\n`).join(''), nomes.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const texto = ['AWS4-HMAC-SHA256', amzData, escopo, hex(canonica)].join('\n');
  const kAssin = hmac(hmac(hmac(hmac('AWS4' + segredo, dia), regiao), 's3'), 'aws4_request');
  const assinatura = crypto.createHmac('sha256', kAssin).update(texto).digest('hex');
  return `${u.protocol}//${host}${caminho}?${consulta}&X-Amz-Signature=${assinatura}`;
}

const s3 = () => CONFIG.arquivos.s3;
const nomeSeguro = id => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('id inválido'); return id; };

export function urlEnvio(arq) {
  if (CONFIG.arquivos.driver === 's3') {
    const c = s3();
    return {
      url: preAssinar({ metodo: 'PUT', endpoint: c.endpoint, regiao: c.regiao, bucket: c.bucket, chave: arq.chave, idChave: c.chave, segredo: c.segredo, expira: 600,
        cabecalhos: { 'content-type': arq.tipo, 'content-length': arq.tamanho } }),
      metodo: 'PUT', cabecalhos: { 'Content-Type': arq.tipo },
    };
  }
  // modos banco e disco: o envio passa pela própria API (mesma origem, via proxy do site)
  return { url: `/api/arquivos/${arq.id}/conteudo`, metodo: 'PUT', cabecalhos: { 'Content-Type': arq.tipo } };
}

export function urlDownload(arq) {
  const c = s3();
  return preAssinar({ metodo: 'GET', endpoint: c.endpoint, regiao: c.regiao, bucket: c.bucket, chave: arq.chave, idChave: c.chave, segredo: c.segredo, expira: 300 });
}

export function caminhoDisco(arq) { return path.join(CONFIG.arquivos.pasta, nomeSeguro(arq.id)); }
export async function gravarDisco(arq, buffer) {
  await fs.promises.mkdir(CONFIG.arquivos.pasta, { recursive: true });
  await fs.promises.writeFile(caminhoDisco(arq), buffer);
}
