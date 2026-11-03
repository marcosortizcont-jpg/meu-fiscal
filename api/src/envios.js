// Entrega de obrigações ao cliente: os arquivos anexados no Controle de obrigações seguem por e-mail e/ou WhatsApp.
// (A publicação no Portal do Cliente é feita pelo próprio Painel, como documento da empresa.)
import fs from 'node:fs';
import { ErroHttp } from './http.js';
import { enviarEmail } from './externos.js';
import { caminhoDisco, urlDownload } from './arquivos.js';
import { limitar } from './seguranca.js';

export function registrarEnvios(r, { db, exigir, log, pode, wa }) {
  async function conteudo(a) {
    if (a.local === 'banco') { const [c] = await db.query('SELECT conteudo FROM arquivos_conteudo WHERE id = $1', [a.id]); if (!c) throw new Error('arquivo vazio'); return c.conteudo; }
    if (a.local === 'disco') return fs.promises.readFile(caminhoDisco(a));
    const resp = await fetch(urlDownload(a)); if (!resp.ok) throw new Error('armazenamento ' + resp.status); return Buffer.from(await resp.arrayBuffer());
  }
  r.post('/api/envios/obrigacao', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'obrig', 'editar') && !pode(u, 'guias', 'editar')) throw new ErroHttp(403, 'Seu acesso não permite enviar obrigações ao cliente.');
    if (limitar(`envio-obr:${u.id}`, 60, 3600).bloqueado) throw new ErroHttp(429, 'Muitos envios seguidos. Aguarde alguns minutos.');
    const c = ctx.corpo || {};
    const canais = (Array.isArray(c.canais) ? c.canais : []).filter(x => ['email', 'whatsapp'].includes(x));
    const ids = (Array.isArray(c.arquivos) ? c.arquivos : []).filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 10);
    if (!canais.length) return { ok: true, resultados: {} };
    if (!ids.length) throw new ErroHttp(400, 'Anexe o arquivo da obrigação antes de enviar.');
    const [emp] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id = $2`, [u.escritorio_id, String(c.empresaId || '')]);
    if (!emp) throw new ErroHttp(404, 'Empresa não encontrada.');
    const e = emp.dados;
    const arqs = await db.query('SELECT id, chave, tipo, tamanho, local FROM arquivos WHERE escritorio_id = $1 AND id = ANY($2::uuid[])', [u.escritorio_id, ids]);
    if (arqs.reduce((t, a) => t + a.tamanho, 0) > 15 * 1024 * 1024) throw new ErroHttp(413, 'Os anexos passam de 15 MB.');
    const nomes = Array.isArray(c.nomes) ? c.nomes : [];
    const anexos = [];
    for (const a of arqs) anexos.push({ nome: String(nomes[ids.indexOf(a.id)] || `arquivo.${(a.tipo.split('/')[1] || 'pdf')}`).slice(0, 120), tipo: a.tipo, conteudo: await conteudo(a) });
    const assunto = String(c.assunto || 'Documento do escritório').slice(0, 150);
    const mensagem = String(c.mensagem || '').slice(0, 1500);
    const resultados = {};
    if (canais.includes('email')) {
      const para = [...new Set([e.email, ...(e.contatos || []).map(x => x.email)].map(x => String(x || '').trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)))];
      if (!para.length) resultados.email = { ok: false, erro: 'A empresa não tem e-mail no cadastro.' };
      else {
        const esc = s => String(s).replace(/[&<>"]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
        const rr = await enviarEmail({ para, assunto, anexos,
          texto: `${mensagem}\n\nOs arquivos seguem em anexo e também estão no Portal do Cliente.`,
          html: `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#0F172A"><p style="font-size:18px;font-weight:700">Meu Fiscal</p><p>${esc(mensagem).replace(/\n/g, '<br>')}</p><p style="font-size:13px;color:#64748B">Os arquivos seguem em anexo e também estão no Portal do Cliente.</p></div>` });
        resultados.email = rr.enviado ? { ok: true, para: para.join(', ') } : { ok: false, erro: rr.motivo || 'Falha no envio.' };
      }
    }
    if (canais.includes('whatsapp')) {
      try {
        const fone = e.telefone || (e.contatos || []).map(x => x.telefone).find(Boolean);
        let para = null;
        for (let i = 0; i < anexos.length; i++) {
          const x = anexos[i];
          ({ para } = await wa.enviarArquivo({ esc: u.escritorio_id, empresaId: String(c.empresaId), fone, buffer: x.conteudo, tipo: x.tipo, nome: x.nome, legenda: i === 0 ? mensagem : '' }));
        }
        resultados.whatsapp = { ok: true, para };
      } catch (er) { resultados.whatsapp = { ok: false, erro: er.message }; }
    }
    await log('obrigacao_enviada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${e.razao || ''} · ${assunto} · ${Object.entries(resultados).map(([k, v]) => k + ':' + (v.ok ? 'ok' : 'falhou')).join(' ')}` });
    return { ok: true, resultados };
  }, { limite: 64 * 1024 });
}
