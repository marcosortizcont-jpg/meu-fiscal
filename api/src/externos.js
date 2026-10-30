// Serviços externos opcionais: e-mail transacional (Resend) e IA (API da Anthropic). Sem chave, a API continua funcionando.
import { CONFIG } from './config.js';

export async function enviarEmail({ para, assunto, html, texto }) {
  if (!CONFIG.email.resend) { console.log(`[e-mail não enviado: RESEND_API_KEY ausente] para ${para} · ${assunto}\n${texto}`); return { enviado: false }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.email.resend}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: CONFIG.email.remetente, to: [para], subject: assunto, html, text: texto }),
  });
  if (!r.ok) { console.error('[e-mail] falha', r.status, await r.text().catch(() => '')); return { enviado: false }; }
  return { enviado: true };
}

export function emailLink({ nome, titulo, texto, rotulo, link, rodape }) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return {
    html: `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0F172A">
      <p style="font-size:18px;font-weight:700;margin:0 0 16px">Meu Fiscal</p>
      <p>Olá, ${esc(nome)}.</p><p>${esc(texto)}</p>
      <p style="margin:24px 0"><a href="${esc(link)}" style="background:#059669;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(rotulo)}</a></p>
      <p style="font-size:13px;color:#64748B">${esc(rodape)}</p></div>`,
    texto: `Olá, ${nome}.\n\n${texto}\n\n${rotulo}: ${link}\n\n${rodape}`,
    assunto: titulo,
  };
}

/* IA: recebe a conversa no formato do app e devolve o texto. As regras do escritório vão como "system". */
export async function perguntarIA({ mensagens, imagens = [] }) {
  if (!CONFIG.ia.chave) throw Object.assign(new Error('IA não configurada.'), { status: 503 });
  const msgs = (Array.isArray(mensagens) ? mensagens : []).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
  if (!msgs.length) throw Object.assign(new Error('Conversa vazia.'), { status: 400 });
  const sistema = msgs[0].role === 'user' ? msgs.shift().content : '';
  // junta mensagens seguidas do mesmo papel (a API exige alternância)
  const turnos = [];
  for (const m of msgs) { const ult = turnos.at(-1); if (ult && ult.role === m.role) ult.content += '\n\n' + m.content; else turnos.push({ ...m }); }
  while (turnos.length && turnos[0].role !== 'user') turnos.shift();
  if (!turnos.length) throw Object.assign(new Error('Conversa vazia.'), { status: 400 });
  const ultimo = turnos.at(-1);
  if (imagens.length && ultimo.role === 'user') {
    ultimo.content = [
      ...imagens.slice(0, 5).filter(i => /^image\/(jpeg|png|webp|gif)$/.test(i.tipo) && typeof i.base64 === 'string')
        .map(i => ({ type: 'image', source: { type: 'base64', media_type: i.tipo, data: i.base64 } })),
      { type: 'text', text: ultimo.content },
    ];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CONFIG.ia.chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.ia.modelo, max_tokens: 1500, system: sistema.slice(0, 60000), messages: turnos }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('[ia]', r.status, JSON.stringify(j).slice(0, 300)); throw Object.assign(new Error('A IA não respondeu agora.'), { status: 502 }); }
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
