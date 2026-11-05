// Théo comercial: o lead que chega pelo site recebe uma primeira mensagem no WhatsApp em poucos minutos,
// o Théo conversa para entender a empresa (qualificação) e passa para o Comercial quando o lead está pronto.
//
// Boas práticas usadas no roteiro:
//  - velocidade: primeiro contato em até 5 minutos (os estudos de "speed to lead" mostram queda forte da chance de contato depois disso);
//  - personalização: nome, plano escolhido e situação (troca de contador ou abertura);
//  - uma pergunta por mensagem, mensagens curtas, identificação clara como assistente virtual;
//  - respeito ao horário comercial e opção de não receber mais mensagens (SAIR), em linha com a LGPD.
import { ErroHttp } from './http.js';
import { criarApoio, agoraLocal, addDias, marcaDe } from './apoio.js';

export const CRM_THEO_PADRAO = {
  ativo: false, atrasoMin: 2, inicio: 8, fim: 18, sabado: false,
  mensagem: 'Olá, {nome}! Aqui é o Théo, assistente virtual da {escritorio}. 😊 Recebi seu pedido{plano} pelo nosso site e já vou te ajudar. {pergunta}\n\nSe preferir que um especialista te ligue, é só dizer. (Para não receber mais mensagens, responda SAIR.)',
  info: '',
};
const pergunta = l => l.temContador === 'sim' ? 'Para indicar o melhor caminho: o que te fez pensar em trocar de contador?'
  : l.temContador === 'nao' ? 'Para começar: a empresa já está aberta ou você quer abrir o CNPJ agora?'
  : 'Para começar: você já tem empresa aberta ou quer abrir o CNPJ agora?';
export const cfgTheo = c => ({ ...CRM_THEO_PADRAO, ...((c && c.crmTheo) || {}) });
export const OPTOUT = /^\s*(sair|parar|pare|stop|cancelar|n[aã]o quero( mais)?( receber)?|remover)\s*[.!]*\s*$/i;

// próximo horário comercial (fuso do escritório) a partir de agora + atraso
export function quandoEnviar(conf, agora = new Date()) {
  let t = new Date(agora.getTime() + Math.max(0, Number(conf.atrasoMin) || 0) * 60000);
  for (let i = 0; i < 14 * 24; i++) {
    const L = agoraLocal(t); const dow = new Date(L.data + 'T12:00:00Z').getUTCDay();
    const diaOk = dow >= 1 && dow <= 5 || (dow === 6 && conf.sabado);
    if (diaOk && L.hora >= Number(conf.inicio) && L.hora < Number(conf.fim)) return t;
    // pula para a próxima hora cheia
    t = new Date(Math.floor(t.getTime() / 3600000) * 3600000 + 3600000 + 60000);
  }
  return t;
}

export function registrarCrmTheo(r, { db, exigir, log, pode, wa }) {
  const A = criarApoio(db);
  const montar = (conf, cfg, l) => String(conf.mensagem || CRM_THEO_PADRAO.mensagem).replace(/\bdo \{escritorio\}/g, 'da {escritorio}').replace(/\{(\w+)\}/g, (_, k) => ({
    nome: String(l.nome || '').trim().split(/\s+/)[0] || 'tudo bem', escritorio: marcaDe(cfg), empresa: l.empresa || 'sua empresa',
    plano: l.planoNome ? ' do plano ' + l.planoNome : '', pergunta: pergunta(l) }[k] ?? _));
  async function enviarPrimeira(esc, l, conf, cfg, quem) {
    if (!wa.status || wa.status() !== 'conectado') throw new ErroHttp(503, 'O WhatsApp do escritório está desconectado.');
    const texto = montar(conf, cfg, l);
    const conversaId = await wa.iniciarConversaLead({ esc, fone: l.whatsapp, nome: l.nome, texto, leadId: l.id });
    const atual = await A.registro(esc, 'leads', l.id) || l; const agora = new Date().toISOString();
    const at = [...(atual.atividades || []), { em: agora, tipo: 'whatsapp', nome: 'Théo', texto: 'Théo enviou a primeira mensagem pelo WhatsApp' + (quem ? ' (a pedido de ' + quem + ')' : '') + '.' }].slice(-300);
    await A.gravar(esc, 'leads', l.id, null, { ...atual, theo: { status: 'enviado', enviadoEm: agora, conversaId }, atividades: at });
    return conversaId;
  }
  // agenda e envia as primeiras mensagens (roda a cada minuto)
  let ocupado = false;
  async function ciclo() {
    if (ocupado) return; ocupado = true;
    try {
      const escs = await db.query(`SELECT DISTINCT escritorio_id FROM registros WHERE colecao = 'config'`);
      for (const { escritorio_id: esc } of escs) {
        const cfg = await A.configEscritorio(esc); const conf = cfgTheo(cfg); if (!conf.ativo) continue;
        const leads = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'leads'
          AND coalesce(dados->>'origem','site') = 'site' AND coalesce(dados->>'etapa', dados->>'status', 'novo') = 'novo'
          AND coalesce(dados->'theo'->>'status','') IN ('', 'agendado') AND coalesce(dados->>'optOut','false') <> 'true'
          AND (dados->>'criadoEm') > $2`, [esc, new Date(Date.now() - 3 * 86400000).toISOString()])).map(x => x.dados);
        for (const l of leads) {
          if (!String(l.whatsapp || '').replace(/\D/g, '')) continue;
          if (!l.theo) { const em = quandoEnviar(conf, new Date(l.criadoEm)).toISOString(); await A.gravar(esc, 'leads', l.id, null, { ...l, theo: { status: 'agendado', enviarEm: em } }); l.theo = { status: 'agendado', enviarEm: em }; }
          if (l.theo.enviarEm > new Date().toISOString()) continue;
          try { await enviarPrimeira(esc, l, conf, cfg); }
          catch (er) {
            if (er.status === 503) continue;   // WhatsApp desconectado: tenta de novo no próximo ciclo
            const atual = await A.registro(esc, 'leads', l.id) || l;
            await A.gravar(esc, 'leads', l.id, null, { ...atual, theo: { status: 'falhou', erro: er.message, em: new Date().toISOString() },
              atividades: [...(atual.atividades || []), { em: new Date().toISOString(), tipo: 'sistema', nome: 'Théo', texto: 'Não consegui enviar a primeira mensagem: ' + er.message }] });
          }
        }
      }
    } catch (e) { console.error('[crm-theo]', e.message); } finally { ocupado = false; }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => ciclo(), 30000).unref?.(); setInterval(() => ciclo(), 60000).unref?.(); }

  r.post('/api/crm/theo/iniciar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'comercial', 'editar')) throw new ErroHttp(403, 'Seu acesso ao Comercial é só de consulta.');
    const l = await A.registro(u.escritorio_id, 'leads', String(ctx.corpo?.leadId || '')); if (!l) throw new ErroHttp(404, 'Lead não encontrado.');
    if (l.optOut) throw new ErroHttp(409, 'Este contato pediu para não receber mensagens.');
    if (!String(l.whatsapp || '').replace(/\D/g, '')) throw new ErroHttp(400, 'O lead não tem WhatsApp.');
    const cfg = await A.configEscritorio(u.escritorio_id);
    const conversaId = await enviarPrimeira(u.escritorio_id, l, cfgTheo(cfg), cfg, String(u.nome || '').split(' ')[0]);
    return { ok: true, conversaId };
  });
  r.post('/api/crm/theo/previa', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    const cfg = await A.configEscritorio(u.escritorio_id); const b = ctx.corpo || {};
    const conf = { ...cfgTheo(cfg), ...(b.conf || {}) };
    const l = { nome: 'Ana Paula', planoNome: 'Unique', temContador: b.temContador || 'sim' };
    return { texto: montar(conf, cfg, l), quando: quandoEnviar(conf).toISOString() };
  });
}
