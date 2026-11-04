// Funções de apoio usadas pelos módulos que trabalham no servidor (integração com a Receita e financeiro):
// guardar arquivos, gravar registros (com aviso em tempo real pelo gatilho do banco) e achar os destinatários de uma empresa.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG } from './config.js';
import { gravarDisco, urlEnvio, caminhoDisco, urlDownload } from './arquivos.js';

export const soDig = s => String(s ?? '').replace(/\D/g, '');
export const pad = n => String(n).padStart(2, '0');
export const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtData = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';
export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const fmtComp = c => c ? MESES[+c.slice(5, 7) - 1] + '/' + c.slice(0, 4) : '';
export const addMes = (c, n) => { const d = new Date(Date.UTC(+c.slice(0, 4), +c.slice(5, 7) - 1 + n, 1)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); };
export const addDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
export const FUSO = process.env.FUSO_ESCRITORIO || 'America/Campo_Grande';
export function agoraLocal(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, comp: `${p.year}-${p.month}`, dia: +p.day, hora: +p.hour % 24 };
}
// feriados nacionais (fixos + Carnaval, Sexta-feira Santa e Corpus Christi)
export function feriados(a) {
  const f = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(x => `${a}-${x}`);
  const G = a % 19, C = Math.floor(a / 100), H = (C - Math.floor(C / 4) - Math.floor((8 * C + 13) / 25) + 19 * G + 15) % 30;
  const I = H - Math.floor(H / 28) * (1 - Math.floor(29 / (H + 1)) * Math.floor((21 - G) / 11)), J = (a + Math.floor(a / 4) + I + 2 - C + Math.floor(C / 4)) % 7;
  const L = I - J, mes = 3 + Math.floor((L + 40) / 44), dia = L + 28 - 31 * Math.floor(mes / 4);
  const pascoa = Date.UTC(a, mes - 1, dia); const d = n => new Date(pascoa + n * 86400000).toISOString().slice(0, 10);
  return new Set([...f, d(-48), d(-47), d(-2), d(60)]);
}
export const diaUtil = iso => { const d = new Date(iso + 'T12:00:00Z'); return ![0, 6].includes(d.getUTCDay()) && !feriados(+iso.slice(0, 4)).has(iso); };
export function ajustarUtil(iso, sentido = 'prorroga') { let d = iso; while (!diaUtil(d)) d = addDias(d, sentido === 'antecipa' ? -1 : 1); return d; }
export function ultimoUtil(comp) { return ajustarUtil(`${comp}-${pad(ultimoDia(+comp.slice(0, 4), +comp.slice(5, 7)))}`, 'antecipa'); }

export function criarApoio(db) {
  async function guardarArquivo(esc, empresaId, buf, nome, tipo = 'application/pdf', pasta = 'sistema') {
    const id = crypto.randomUUID(); const chave = `${esc}/${pasta}/${id}`; const local = CONFIG.arquivos.driver;
    await db.query('INSERT INTO arquivos (id, escritorio_id, empresa_id, chave, tipo, tamanho, criado_por, local) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)', [id, esc, empresaId, chave, tipo, buf.length, local]);
    if (local === 'banco') await db.query('INSERT INTO arquivos_conteudo (id, conteudo) VALUES ($1,$2)', [id, buf]);
    else if (local === 'disco') await gravarDisco({ id }, buf);
    else { const e = urlEnvio({ id, chave, tipo, tamanho: buf.length }); const rr = await fetch(e.url, { method: 'PUT', headers: e.cabecalhos, body: buf }); if (!rr.ok) throw new Error('falha no armazenamento ' + rr.status); }
    return { id, nome, url: `/api/arquivos/${id}`, tipo, tamanho: buf.length };
  }
  async function conteudoArquivo(id) {
    const [a] = await db.query('SELECT id, chave, tipo, local FROM arquivos WHERE id = $1', [id]); if (!a) return null;
    if (a.local === 'banco') { const [c] = await db.query('SELECT conteudo FROM arquivos_conteudo WHERE id = $1', [id]); return c?.conteudo || null; }
    if (a.local === 'disco') return fs.promises.readFile(caminhoDisco(a)).catch(() => null);
    const rr = await fetch(urlDownload(a)); return rr.ok ? Buffer.from(await rr.arrayBuffer()) : null;
  }
  const gravar = (esc, colecao, id, empresaId, dados) => db.query(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados) VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT (escritorio_id, colecao, id) DO UPDATE SET dados = EXCLUDED.dados, versao = registros.versao + 1, atualizado_em = now()`, [esc, colecao, id, empresaId, JSON.stringify(dados)]);
  async function registro(esc, colecao, id) { const [x] = await db.query('SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = $2 AND id = $3', [esc, colecao, String(id)]); return x?.dados || null; }
  const empresa = (esc, id) => registro(esc, 'empresas', id);
  async function configEscritorio(esc) { const [c] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'config' LIMIT 1`, [esc]); return c?.dados || {}; }
  async function emailsDaEmpresa(esc, empresaId, e) {
    const doAtend = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'contatos'`, [esc])).map(x => x.dados)
      .filter(x => (x.empresas || []).includes(String(empresaId)) && x.email && x.recebeEmail !== false && x.ativo !== false).map(x => x.email);
    return [...new Set([e?.email, ...(e?.contatos || []).map(x => x.email), ...doAtend].map(x => String(x || '').trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)))];
  }
  return { guardarArquivo, conteudoArquivo, gravar, registro, empresa, configEscritorio, emailsDaEmpresa };
}
