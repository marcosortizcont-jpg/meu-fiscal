// WhatsApp do escritório conectado por QR code (o mesmo vínculo do WhatsApp Web, pela biblioteca Baileys).
// As mensagens recebidas viram conversas no Atendimento do Painel (coleção "conversas", canal "whatsapp").
// O copiloto de IA responde primeiro e passa para um atendente quando precisa; o atendente responde pelo Painel.
//
// A biblioteca é opcional: sem ela instalada (npm install), o resto da API funciona e o Painel avisa.
// Atenção: é uma conexão não oficial. Use um número do escritório e evite envios em massa (risco de bloqueio).
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { identidade } from './apoio.js';
import { ErroHttp } from './http.js';
import { perguntarIA, iaDisponivel } from './externos.js';
import { triar, deptoConv, cfgAtend, conversaVisivel, catsDocTheo } from './atendimento.js';
import { cfgTheo, OPTOUT } from './crm-theo.js';
import fs from 'node:fs';
import { urlEnvio, gravarDisco, caminhoDisco, urlDownload } from './arquivos.js';

const nada = () => { };
const LOG = { level: 'silent', child: () => LOG, trace: nada, debug: nada, info: nada, warn: nada, error: nada, fatal: nada };
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4' };
const foneDe = (k, jid) => { const pn = [k?.remoteJidAlt, k?.senderPn, k?.participantPn, jid].find(x => typeof x === 'string' && x.endsWith('@s.whatsapp.net')); return pn ? pn.split('@')[0].split(':')[0] : ''; };
const chaveFone = f => { let d = String(f || '').replace(/\D/g, ''); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : null; };
const limpar = t => String(t || '').replace(/^\s*(ANEXAR|ENVIAR):.*$/gim, '').replace(/\s*CONFIAN[CÇ]A:\s*(alta|m[eé]dia|baixa)\.?/gi, '').replace(/\*\*/g, '*').trim();
const PEDE_HUMANO = /\b(atendente|humano|falar com (o |a |um |uma )?(contador|contadora|algu[eé]m|pessoa|atendente))\b/i;

export function registrarWhatsApp(r, { db, exigir, log, pode }) {
  async function lerArquivo(a) {
    if (a.local === 'banco') { const [c] = await db.query('SELECT conteudo FROM arquivos_conteudo WHERE id = $1', [a.id]); if (!c) throw new ErroHttp(404, 'Arquivo vazio.'); return c.conteudo; }
    if (a.local === 'disco') return fs.promises.readFile(caminhoDisco(a));
    const resp = await fetch(urlDownload(a)); if (!resp.ok) throw new ErroHttp(502, 'Falha ao ler o arquivo.'); return Buffer.from(await resp.arrayBuffer());
  }
  const W = { status: 'desligado', qr: null, numero: null, nome: null, erro: null, sock: null, esc: null, tentativas: 0, qrs: 0, parando: false, vivo: null };
  const enviadas = new Map();   // id → mensagem enviada (a biblioteca pede para reenvios)
  let libCache;

  async function lib() {
    if (libCache !== undefined) return libCache;
    for (const nome of ['baileys', '@whiskeysockets/baileys']) {
      try {
        const m = await import(nome); const d = m.default;
        const pega = k => m[k] ?? d?.[k];
        const make = typeof d === 'function' ? d : (pega('makeWASocket') || d?.default);
        if (typeof make === 'function') {
          return (libCache = { make, DisconnectReason: pega('DisconnectReason') || {}, BufferJSON: pega('BufferJSON'), initAuthCreds: pega('initAuthCreds'), proto: pega('proto'),
            cache: pega('makeCacheableSignalKeyStore'), versao: pega('fetchLatestBaileysVersion'), baixar: pega('downloadMediaMessage'), Browsers: pega('Browsers') });
        }
      } catch (e) {
        if (!/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(`${e?.code} ${e?.message}`)) console.error('[whatsapp] falha ao carregar', nome, e?.message);
      }
    }
    return (libCache = null);
  }
  async function escritorio() {
    if (!W.esc) W.esc = (await db.query('SELECT id FROM escritorios ORDER BY criado_em LIMIT 1'))[0]?.id || null;
    return W.esc;
  }

  /* ---------- sessão do aparelho guardada no PostgreSQL (sobrevive a deploys e ao servidor dormir) ---------- */
  async function estadoAuth(L, esc) {
    const ser = v => JSON.stringify(v, L.BufferJSON.replacer);
    const des = t => JSON.parse(t, L.BufferJSON.reviver);
    const [c] = await db.query('SELECT valor FROM whatsapp_auth WHERE escritorio_id = $1 AND chave = $2', [esc, 'creds']);
    const creds = c ? des(c.valor) : L.initAuthCreds();
    const gravar = (q, k, v) => q(`INSERT INTO whatsapp_auth (escritorio_id, chave, valor) VALUES ($1,$2,$3)
      ON CONFLICT (escritorio_id, chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, [esc, k, ser(v)]);
    const keys = {
      async get(tipo, ids) {
        const out = {}; if (!ids?.length) return out;
        const linhas = await db.query('SELECT chave, valor FROM whatsapp_auth WHERE escritorio_id = $1 AND chave = ANY($2::text[])', [esc, ids.map(id => `${tipo}:${id}`)]);
        const mapa = new Map(linhas.map(l => [l.chave, l.valor]));
        for (const id of ids) {
          const t = mapa.get(`${tipo}:${id}`); if (!t) continue;
          let v = des(t);
          if (tipo === 'app-state-sync-key' && v && L.proto?.Message?.AppStateSyncKeyData) v = L.proto.Message.AppStateSyncKeyData.fromObject(v);
          out[id] = v;
        }
        return out;
      },
      async set(dados) {
        await db.tx(async q => {
          for (const tipo of Object.keys(dados)) for (const [id, v] of Object.entries(dados[tipo] || {})) {
            if (v == null) await q('DELETE FROM whatsapp_auth WHERE escritorio_id = $1 AND chave = $2', [esc, `${tipo}:${id}`]);
            else await gravar(q, `${tipo}:${id}`, v);
          }
        });
      },
    };
    return { creds, keys, salvarCreds: () => gravar(db.query, 'creds', creds) };
  }
  const limparAuth = async () => { const esc = await escritorio(); if (esc) await db.query('DELETE FROM whatsapp_auth WHERE escritorio_id = $1', [esc]); };

  // O plano gratuito do Render dorme sem visitas; com o WhatsApp ligado, a API chama a si mesma a cada 10 min.
  function manterVivo(ligar) {
    clearInterval(W.vivo); W.vivo = null;
    if (ligar && CONFIG.urlApiPublica) W.vivo = setInterval(() => fetch(CONFIG.urlApiPublica + '/api/vivo').catch(nada), 10 * 60 * 1000);
  }

  /* ---------- conexão ---------- */
  async function conectar() {
    const L = await lib();
    if (!L) { W.status = 'indisponivel'; return; }
    if (W.sock) return;
    const esc = await escritorio(); if (!esc) throw new ErroHttp(503, 'Escritório ainda não configurado.');
    W.status = 'iniciando'; W.erro = null; W.parando = false; W.qrs = 0;
    const auth = await estadoAuth(L, esc);
    let version; try { ({ version } = await L.versao()); } catch { }
    const sock = L.make({
      ...(version ? { version } : {}),
      auth: { creds: auth.creds, keys: L.cache ? L.cache(auth.keys, LOG) : auth.keys },
      logger: LOG, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false,
      browser: L.Browsers?.ubuntu ? L.Browsers.ubuntu('Meu Fiscal') : ['Meu Fiscal', 'Chrome', '120.0.0'],
      getMessage: async key => enviadas.get(key.id),
    });
    W.sock = sock;
    sock.ev.on('creds.update', () => auth.salvarCreds().catch(e => console.error('[whatsapp] credenciais', e.message)));
    sock.ev.on('connection.update', u => {
      if (u.qr) {
        W.qr = u.qr; W.status = 'qr';
        if (++W.qrs > 6) { W.parando = true; W.erro = 'O QR code expirou sem leitura. Clique em Conectar para gerar outro.'; try { sock.end(undefined); } catch { } }
      }
      if (u.connection === 'open') {
        W.status = 'conectado'; W.qr = null; W.tentativas = 0; W.erro = null;
        W.numero = String(sock.user?.id || '').split(':')[0].split('@')[0]; W.nome = sock.user?.name || null;
        manterVivo(true);
        log('whatsapp_conectado', { detalhe: W.numero });
      }
      if (u.connection === 'close') {
        const cod = u.lastDisconnect?.error?.output?.statusCode;
        if (W.sock === sock) W.sock = null;
        manterVivo(false);
        if (W.parando) { W.status = 'desligado'; W.qr = null; return; }
        if (cod === 401 || cod === L.DisconnectReason.loggedOut) {
          W.status = 'desligado'; W.numero = null; W.qr = null; W.erro = 'O WhatsApp foi desconectado pelo celular. Conecte de novo pelo QR code.';
          limparAuth().catch(nada); log('whatsapp_desconectado_no_celular', {}); return;
        }
        W.status = 'reconectando';
        setTimeout(() => conectar().catch(e => { W.status = 'erro'; W.erro = e.message; }), Math.min(30000, 1500 * 2 ** Math.min(W.tentativas++, 4)));
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => { for (const m of messages || []) enfileirar(m, type); });
  }
  async function desconectar() {
    W.parando = true;
    const s = W.sock;
    if (s) { try { await s.logout(); } catch { } try { s.end(undefined); } catch { } }
    W.sock = null; W.status = 'desligado'; W.qr = null; W.numero = null; manterVivo(false);
    await limparAuth();
  }

  /* ---------- recebimento ---------- */
  const filas = new Map();   // uma fila por contato: mensagens em sequência não se atropelam
  function enfileirar(m, tipo) {
    const k = m?.key?.remoteJid || '';
    const p = (filas.get(k) || Promise.resolve()).then(() => receber(m, tipo)).catch(e => console.error('[whatsapp] mensagem', e?.message));
    filas.set(k, p); p.finally(() => { if (filas.get(k) === p) filas.delete(k); });
  }

  async function empresaPorFone(esc, fone) {
    const alvo = chaveFone(fone); if (!alvo) return null;
    const es = await db.query(`SELECT id, dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND coalesce(dados->>'status','') <> 'inativo'`, [esc]);
    for (const e of es) {
      const fones = [e.dados.telefone, ...(e.dados.contatos || []).map(c => c.telefone)];
      if (fones.some(f => chaveFone(f) === alvo)) return e.id;
    }
    return null;
  }
  // contato salvo em Atendimento › Contatos (tem prioridade sobre o telefone do cadastro da empresa)
  async function leadPorFone(esc, fone) {
    const k = chaveFone(fone); if (!k) return null;
    const ls = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'leads' AND coalesce(dados->>'etapa', dados->>'status', '') NOT IN ('ganho','perdido','convertido','descartado') ORDER BY atualizado_em DESC LIMIT 500`, [esc]);
    return ls.map(x => x.dados).find(l => chaveFone(l.whatsapp) === k) || null;
  }
  async function gravarLead(esc, l) { await db.query(`UPDATE registros SET dados = $3::jsonb, versao = versao + 1, atualizado_em = now() WHERE escritorio_id = $1 AND colecao = 'leads' AND id = $2`, [esc, l.id, JSON.stringify(l)]); }
  async function lerLead(esc, id) { const [x] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'leads' AND id = $2`, [esc, String(id)]); return x?.dados || null; }
  async function iniciarConversaLead({ esc, fone, nome, texto, leadId }) {
    if (!W.sock || W.status !== 'conectado') throw new ErroHttp(503, 'O WhatsApp do escritório está desconectado.');
    const jid = await resolverJid(fone); const agora = new Date().toISOString();
    let c = await conversaAberta(esc, jid);
    if (!c) c = { id: 'wa-' + crypto.randomUUID(), empresaId: null, canal: 'whatsapp', waJid: jid, waFone: jid.split('@')[0], contatoNome: String(nome || '').slice(0, 80), status: 'ia', criadoEm: agora,
      mensagens: [{ de: 'sistema', texto: 'O Théo iniciou a conversa com um lead do site (CRM comercial).', em: agora }] };
    Object.assign(c, { leadId, modo: 'comercial', depto: 'Comercial' }); if (c.status !== 'humano') c.status = 'ia';
    const rt = await enviarTexto(jid, texto);
    c.mensagens.push({ de: 'ia', texto, em: new Date().toISOString(), canal: 'whatsapp', confianca: 'alta', waIds: rt?.key?.id ? [rt.key.id] : [] });
    await salvarConversa(esc, c); return c.id;
  }
  async function contatoPorFone(esc, fone) {
    const alvo = chaveFone(fone); if (!alvo) return null;
    const cs = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'contatos'`, [esc]);
    for (const { dados: c } of cs) if ([c.telefone, c.telefone2].some(f => chaveFone(f) === alvo)) return c;
    return null;
  }
  async function resolverJid(fone) {
    let d = String(fone || '').replace(/\D/g, ''); if (d.length < 10) throw new ErroHttp(400, 'Telefone inválido: informe DDD e número.');
    if (!d.startsWith('55') || d.length <= 11) d = '55' + d.replace(/^55(?=\d{10,11}$)/, '');
    const opcoes = [d]; if (d.length === 13) opcoes.push(d.slice(0, 4) + d.slice(5)); else if (d.length === 12) opcoes.push(d.slice(0, 4) + '9' + d.slice(4));
    for (const n of opcoes) { try { const [r] = await W.sock.onWhatsApp(n); if (r?.exists) return r.jid; } catch { } }
    throw new ErroHttp(404, `O número +${d} não tem WhatsApp.`);
  }
  // a mesma pessoa pode chegar com o número (…@s.whatsapp.net) ou com o identificador interno do WhatsApp (…@lid):
  // procura pelos dois e, se não achar, pelo telefone; ao achar por outro caminho, guarda o identificador novo
  async function conversaAberta(esc, jid, fone) {
    const [c] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'conversas' AND coalesce(dados->>'status','') <> 'encerrada'
      AND (dados->>'waJid' = $2 OR dados->>'waLid' = $2) ORDER BY atualizado_em DESC LIMIT 1`, [esc, jid]);
    if (c?.dados) return c.dados;
    const alvo = chaveFone(fone || (String(jid).endsWith('@s.whatsapp.net') ? jid.split('@')[0] : ''));
    if (!alvo) return null;
    const cs = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'conversas' AND coalesce(dados->>'status','') <> 'encerrada'
      AND coalesce(dados->>'canal','') = 'whatsapp' ORDER BY atualizado_em DESC LIMIT 300`, [esc]);
    const x = cs.map(r => r.dados).find(d => chaveFone(d.waFone) === alvo || chaveFone(String(d.waJid || '').split('@')[0]) === alvo);
    if (!x) return null;
    if (x.waJid !== jid) { if (String(jid).endsWith('@lid')) x.waLid = jid; else if (String(x.waJid).endsWith('@lid')) { x.waLid = x.waJid; x.waJid = jid; } }
    return x;
  }
  async function salvarConversa(esc, c) {
    if (c.mensagens.length > 200) c.mensagens.splice(0, c.mensagens.length - 200);
    await db.query(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados) VALUES ($1,'conversas',$2,$3,$4::jsonb)
      ON CONFLICT (escritorio_id, colecao, id) DO UPDATE SET dados = EXCLUDED.dados, empresa_id = EXCLUDED.empresa_id, versao = registros.versao + 1, atualizado_em = now(), atualizado_por = NULL`,
    [esc, c.id, c.empresaId || null, JSON.stringify(c)]);
  }
  async function guardarArquivo(esc, empresaId, buf, tipo, nome) {
    const limite = CONFIG.arquivos.driver === 'banco' ? CONFIG.arquivos.maxBytesBanco : CONFIG.arquivos.maxBytes;
    if (buf.length > limite) return null;
    const id = crypto.randomUUID(); const chave = `${esc}/whatsapp/${id}`; const local = CONFIG.arquivos.driver;
    await db.query('INSERT INTO arquivos (id, escritorio_id, empresa_id, chave, tipo, tamanho, criado_por, local) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)', [id, esc, empresaId || null, chave, tipo, buf.length, local]);
    if (local === 'banco') await db.query('INSERT INTO arquivos_conteudo (id, conteudo) VALUES ($1,$2)', [id, buf]);
    else if (local === 'disco') await gravarDisco({ id }, buf);
    else { const e = urlEnvio({ id, chave, tipo, tamanho: buf.length }); const r = await fetch(e.url, { method: 'PUT', headers: e.cabecalhos, body: buf }); if (!r.ok) throw new Error('falha no armazenamento ' + r.status); }
    return { id, nome, url: `/api/arquivos/${id}`, tipo, tamanho: buf.length };
  }

  async function receber(m, tipoEvento) {
    const k = m?.key || {}; const jid = k.remoteJid || '';
    if (!m?.message || !jid || jid === 'status@broadcast' || /@(g\.us|broadcast|newsletter)$/.test(jid)) return;
    const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) * 1000;
    if (tipoEvento !== 'notify' && (!ts || Date.now() - ts > 2 * 86400000)) return;   // sincronização antiga: ignora
    let msg = m.message;
    for (let i = 0; i < 3; i++) msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.documentWithCaptionMessage?.message || msg;
    const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption || '';
    const midia = msg.imageMessage ? ['imagem', msg.imageMessage] : msg.documentMessage ? ['documento', msg.documentMessage] : msg.audioMessage ? ['áudio', msg.audioMessage]
      : msg.videoMessage ? ['vídeo', msg.videoMessage] : msg.stickerMessage ? ['figurinha', null] : msg.contactMessage ? ['contato', null] : msg.locationMessage ? ['localização', null] : null;
    // o contato apagou a mensagem para todos no WhatsApp
    if (msg.protocolMessage && (msg.protocolMessage.type === 0 || msg.protocolMessage.type === 'REVOKE') && msg.protocolMessage.key?.id) {
      const esc0 = await escritorio(); const c0 = esc0 && await conversaAberta(esc0, jid, foneDe(k, jid));
      const m0 = c0 && c0.mensagens.find(x => x.waId === msg.protocolMessage.key.id);
      if (m0 && !m0.apagada) { Object.assign(m0, { apagada: true, apagadaEm: new Date().toISOString(), texto: '' }); delete m0.arquivos; await salvarConversa(esc0, c0); }
      return;
    }
    if (!texto && !midia) return;   // confirmações, reações e afins
    const esc = await escritorio(); if (!esc) return;
    const agora = new Date(ts || Date.now()).toISOString();

    // resposta enviada pelo próprio celular do escritório: entra no histórico (não abre conversa nova)
    if (k.fromMe) {
      if (enviadas.has(k.id)) return;
      const c = await conversaAberta(esc, jid, foneDe(k, jid)); if (!c || c.mensagens.some(x => x.waId === k.id)) return;
      c.mensagens.push({ de: 'humano', texto: texto || `[${midia[0]}]`, em: agora, nome: 'Equipe · pelo celular', canal: 'whatsapp', waId: k.id });
      await salvarConversa(esc, c); return;
    }

    let fone = foneDe(k, jid);
    if (!fone && jid.endsWith('@lid')) { try { const pn = await W.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid); if (pn) fone = String(pn).split('@')[0].split(':')[0]; } catch { } }
    let c = await conversaAberta(esc, jid, fone);
    if (c?.mensagens?.some(x => x.waId === k.id)) return;
    const nova = !c;
    if (!c) {
      const cfg = await configEscritorio(esc);
      const ct = await contatoPorFone(esc, fone);
      c = { id: 'wa-' + crypto.randomUUID(), empresaId: (ct && (ct.empresas || [])[0]) || await empresaPorFone(esc, fone), canal: 'whatsapp', waJid: jid, waFone: fone,
        contatoNome: ct?.nome || m.pushName || '', contatoId: ct?.id || null, atendenteUid: ct?.atendente || null,
        status: iaDisponivel() && cfg.whatsappIA !== false ? 'ia' : 'aguardando_humano', atendenteId: null, criadoEm: agora, mensagens: [] };
      if (!c.empresaId && !ct) {
        const ld = await leadPorFone(esc, fone);
        if (ld) { c.leadId = ld.id; c.modo = 'comercial'; c.depto = 'Comercial'; c.contatoNome = ld.nome || c.contatoNome; if (!(iaDisponivel() && cfgTheo(cfg).ativo && !ld.optOut)) c.status = 'aguardando_humano'; }
      }
    }
    if (m.pushName && !c.contatoNome) c.contatoNome = m.pushName;
    // conversa já aberta sem empresa: o número pode ter sido cadastrado depois (contato ou cadastro da empresa)
    if (!nova && !c.empresaId && fone) {
      const ct = await contatoPorFone(esc, fone); const eid = (ct && (ct.empresas || [])[0]) || await empresaPorFone(esc, fone);
      if (eid) { c.empresaId = String(eid); if (ct) { c.contatoId = ct.id; c.contatoNome = ct.nome || c.contatoNome; } if (!c.waFone || String(c.waFone).length > 13) c.waFone = fone;
        c.mensagens.push({ de: 'sistema', texto: 'Contato identificado pelo telefone cadastrado.', em: agora }); }
    }

    const arquivos = []; let imagemIA = null;
    if (midia && midia[1] && W.sock) {
      const info = midia[1]; const tipo = String(info.mimetype || 'application/octet-stream').split(';')[0];
      const nome = info.fileName || `${midia[0].normalize('NFD').replace(/[^\w]/g, '')}-${Date.now()}.${EXT[tipo] || 'bin'}`;
      try {
        const L = await lib();
        const buf = await L.baixar(m, 'buffer', {}, { logger: LOG, reuploadRequest: W.sock.updateMediaMessage });
        const a = await guardarArquivo(esc, c.empresaId, buf, tipo, nome);
        if (a) arquivos.push(a);
        if (midia[0] === 'imagem' && buf.length < 4 * 1024 * 1024) imagemIA = { tipo, base64: buf.toString('base64') };
      } catch (e) { console.error('[whatsapp] mídia', e.message); }
      if (!arquivos.length) arquivos.push({ nome: `${nome} (veja no WhatsApp do celular)` });
    }
    c.mensagens.push({ de: 'cliente', texto: texto || `[${midia[0]} recebido]`, em: agora, canal: 'whatsapp', nome: m.pushName || '', waId: k.id, ...(arquivos.length ? { arquivos } : {}) });
    c.naoLidas = (c.naoLidas || 0) + 1;
    if (nova && c.status === 'aguardando_humano') c.mensagens.push({ de: 'sistema', texto: 'Nova conversa pelo WhatsApp aguardando um atendente.', em: new Date().toISOString() });
    await salvarConversa(esc, c);

    if (tipoEvento === 'notify' && c.status === 'ia' && midia && midia[0] === 'áudio' && !texto) { await passarParaEquipe(esc, c, 'Recebi seu áudio! Vou passar para alguém da equipe ouvir e já te respondemos. 😊'); return; }
    if (tipoEvento === 'notify' && c.status === 'ia') await responderIA(esc, c, k, texto, imagemIA);
  }

  /* ---------- copiloto no WhatsApp ---------- */
  async function configEscritorio(esc) {
    const [c] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'config' LIMIT 1`, [esc]);
    return c?.dados || {};
  }
  // contexto do Théo + arquivos que ele pode enviar (refs D1, G1… → arquivo), só da empresa do contato identificado
  async function contexto(esc, empresaId, cfg) {
    if (!empresaId) return { dados: { contato_identificado: false }, refs: {} };
    const [e] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id = $2`, [esc, empresaId]);
    if (!e) return { dados: { contato_identificado: false }, refs: {} };
    const guias = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'guias' AND empresa_id = $2
      AND coalesce(dados->>'status','') NOT IN ('rascunho','paga') ORDER BY dados->>'venc' LIMIT 6`, [esc, empresaId]);
    const refs = {}; const d = e.dados; const hoje = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);   // dia em Campo Grande
    // guia vencida ou documento com validade vencida nunca é enviado: fica sem "ref" e marcado como vencido
    const guiasCtx = guias.map((g, i) => { const x = g.dados; const item = { tipo: x.tipo, competencia: x.comp, valor: x.valor, vencimento: x.venc };
      if (x.venc && String(x.venc).slice(0, 10) < hoje) { item.vencida = true; return item; }
      if (x.arquivo && x.arquivo.id) { item.ref = 'G' + (i + 1); refs[item.ref] = { arquivo: x.arquivo, nome: `${x.tipo || 'Guia'} ${x.comp || ''}`.trim(), rotulo: `guia ${x.tipo || ''} ${x.comp || ''}`.trim() }; }
      return item; });
    const cats = new Set(catsDocTheo(cfgAtend(cfg)));
    let docs = [];
    if (cats.size) docs = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'documentos' AND empresa_id = $2`, [esc, empresaId]))
      .map(x => x.dados).filter(x => x && x.arquivo && x.arquivo.id && cats.has(x.categoria) && !x.exemplo)
      .sort((a, b) => String(b.enviadoEm || '').localeCompare(String(a.enviadoEm || ''))).slice(0, 40);
    let n = 0;
    const docsCtx = docs.map(x => { if (x.validade && String(x.validade).slice(0, 10) < hoje) return { categoria: x.categoria, nome: x.nome, validade: x.validade, vencido: true };
      const ref = 'D' + (++n); const ext = (String(x.arquivo.nome || '').match(/\.[a-z0-9]{2,4}$/i) || ['.pdf'])[0];
      const nome = String(x.nome || x.categoria); refs[ref] = { arquivo: x.arquivo, nome: /\.[a-z0-9]{2,4}$/i.test(nome) ? nome : nome + ext, rotulo: x.categoria };
      return { ref, categoria: x.categoria, nome: x.nome, enviado_em: String(x.enviadoEm || '').slice(0, 10), validade: x.validade || null }; });
    return { refs, dados: { contato_identificado: true, hoje,
      empresa: { nome: d.fantasia || d.razao, regime: d.regimeNome || ({ MEI: 'MEI', SN: 'Simples Nacional', LP: 'Lucro Presumido', LR: 'Lucro Real' }[d.regime] || d.regime || ''), municipio: d.municipio },
      guias_em_aberto: guiasCtx, documentos_disponiveis: docsCtx } };
  }
  // envia ao cliente os arquivos que o Théo escolheu (linha ENVIAR); devolve o que foi enviado e o que falhou
  async function enviarRefs(esc, empresaId, c, refs, escolhidos) {
    const ok = [], falhas = [], waIds = [], arquivos = [];
    for (const ref of escolhidos) {
      const it = refs[ref]; if (!it) continue;
      try {
        const [arq] = await db.query('SELECT id, chave, tipo, tamanho, local, empresa_id FROM arquivos WHERE id = $1 AND escritorio_id = $2', [it.arquivo.id, esc]);
        if (!arq || (arq.empresa_id && String(arq.empresa_id) !== String(empresaId))) throw new Error('arquivo não encontrado');
        const buf = await lerArquivo(arq);
        const nome = String(it.nome || it.arquivo.nome || 'documento').slice(0, 120); const tipo = arq.tipo || 'application/pdf';
        const r = await W.sock.sendMessage(c.waJid, /^image\//.test(tipo) && !/gif/.test(tipo) ? { image: buf, caption: it.rotulo } : { document: buf, mimetype: tipo, fileName: nome });
        if (r?.key?.id) { enviadas.set(r.key.id, r.message); waIds.push(r.key.id); }
        arquivos.push({ id: arq.id, nome, tipo, tamanho: arq.tamanho, url: `/api/arquivos/${arq.id}` }); ok.push(it.rotulo);
      } catch (e) { console.error('[whatsapp] Théo enviar', ref, e.message); falhas.push(it.rotulo); }
    }
    return { ok, falhas, waIds, arquivos };
  }
  async function enviarTexto(jid, texto, quoted) {
    if (!W.sock || W.status !== 'conectado') throw new ErroHttp(503, 'O WhatsApp do escritório está desconectado. Conecte pelo QR code em Atendimento.');
    const r = await W.sock.sendMessage(jid, { text: texto }, quoted ? { quoted } : undefined);
    if (r?.key?.id) { enviadas.set(r.key.id, r.message); if (enviadas.size > 500) enviadas.delete(enviadas.keys().next().value); }
    return r;
  }
  async function passarParaEquipe(esc, c, aviso) {
    c.status = 'aguardando_humano';
    await deptoDaFila(esc, c);
    if (aviso) { await enviarTexto(c.waJid, aviso).catch(nada); c.mensagens.push({ de: 'ia', texto: aviso, em: new Date().toISOString(), canal: 'whatsapp' }); }
    c.mensagens.push({ de: 'sistema', texto: 'A conversa foi passada para a equipe do escritório.', em: new Date().toISOString() });
    await salvarConversa(esc, c);
  }
  // ao ir para a equipe: o Théo escolhe o setor (Atendimento › Regras do atendimento)
  async function deptoDaFila(esc, c, cfg) {
    if (c.modo === 'comercial') { c.depto = 'Comercial'; return; }
    if (deptoConv(c) === 'Triagem') await triar(c, cfg || await configEscritorio(esc));
  }
  async function exigirVisivel(u, c) {
    if (!conversaVisivel(u, c, cfgAtend(await configEscritorio(u.escritorio_id)))) throw new ErroHttp(403, 'Esta conversa é de outro setor. Peça para transferirem para você.');
  }
  let fluxoDas = null;   // Théo emite o DAS do MEI pela integração com a Receita (integra.js)
  async function responderIA(esc, c, chave, texto, imagemIA) {
    const cfg = await configEscritorio(esc);
    if (PEDE_HUMANO.test(texto || '')) return passarParaEquipe(esc, c, 'Certo! Vou chamar alguém da equipe do escritório para continuar com você. Aguarde um instante, por favor.');
    if (c.modo === 'comercial' && c.leadId) return responderComercial(esc, c, chave, texto, cfg);
    if (fluxoDas && c.empresaId && texto) {
      let fx = null; try { fx = await fluxoDas({ esc, empresaId: c.empresaId, chave: 'wa:' + c.id, texto }); } catch (e) { console.error('[whatsapp] DAS', e.message); }
      if (fx) {
        const agora = () => new Date().toISOString();
        await W.sock?.readMessages?.([chave]).catch?.(nada);
        const rt = await enviarTexto(c.waJid, fx.texto).catch(nada);
        const m = { de: 'ia', texto: fx.texto, em: agora(), confianca: 'alta', canal: 'whatsapp', waIds: rt?.key?.id ? [rt.key.id] : [] };
        if (fx.anexo) {
          const rd = await W.sock.sendMessage(c.waJid, { document: fx.anexo.conteudo, mimetype: 'application/pdf', fileName: fx.anexo.nome }).catch(nada);
          if (rd?.key?.id) { enviadas.set(rd.key.id, rd.message); m.waIds.push(rd.key.id); }
          m.arquivos = [{ id: fx.anexo.id, nome: fx.anexo.nome, tipo: 'application/pdf', tamanho: fx.anexo.tamanho, url: fx.anexo.url }];
        }
        c.mensagens.push(m);
        if (fx.passarEquipe) { c.status = 'aguardando_humano'; c.mensagens.push({ de: 'sistema', texto: 'O Théo não conseguiu emitir o DAS (' + (fx.erro || 'erro') + '). A equipe foi chamada.', em: agora() }); }
        await salvarConversa(esc, c); return;
      }
    }
    const { dados, refs } = await contexto(esc, c.empresaId, cfg);
    const idt = identidade(cfg);
    const regras = `Você é o Théo, assistente virtual da ${idt.marca}, e responde pelo WhatsApp. Apresente-se como "Théo, assistente da ${idt.marca}" na primeira resposta da conversa.
${idt.texto}
Regras:
- Português do Brasil, até 4 frases curtas, tom cordial, sem markdown, sem listas longas.
- Se "contato_identificado" for false: não fale de nenhuma empresa nem de valores. Cumprimente, pergunte o nome, a empresa (CNPJ) e o que a pessoa precisa, e diga que a equipe vai retornar. Use CONFIANCA: baixa quando a pessoa já tiver dito o que precisa. Se pedir documento ou guia, explique que, por segurança, documentos só são enviados ao WhatsApp cadastrado da empresa e que a equipe vai confirmar o cadastro e enviar (CONFIANCA: baixa).
- Com contato identificado: use só os DADOS. Informe valor e vencimento das guias se estiverem nos DADOS; elas também ficam no Portal do Cliente (menu Guias e impostos).
- Envio de documentos: se a pessoa pedir um documento da empresa (contrato social, alteração contratual, cartão CNPJ, certificado MEI ou CCMEI, inscrição, alvará, certidão, contrato de prestação de serviços, recibo de obrigação) ou uma guia, e ele estiver em "documentos_disponiveis" ou em "guias_em_aberto" com "ref", diga em uma frase que está enviando e acrescente uma linha "ENVIAR: D1" (ou "ENVIAR: D1, G2"), no máximo 3 refs, só refs que existem nos DADOS. Se houver mais de um da mesma categoria, envie o mais recente (enviado_em), salvo se a pessoa pedir outro. Isso pode ser CONFIANCA: alta.
- Itens com "vencida": true ou "vencido": true (guia com vencimento passado, certidão, alvará ou outro documento fora da validade) NUNCA são enviados e não têm ref: explique que está vencido e que a equipe vai emitir ou providenciar um atualizado, e use CONFIANCA: baixa.
- Se o documento pedido não estiver nos DADOS, não invente: diga que vai pedir para a equipe providenciar e use CONFIANCA: baixa. Nunca diga que enviou algo sem a linha ENVIAR.
- Valores calculados são estimativas. Nunca invente informação.
- Assuntos que exigem análise humana (rescisão, autuação, intimação, parcelamento, mudança de regime, pedido para FAZER uma alteração contratual, divergência de valores, documentos que o cliente manda para análise) recebem orientação geral e CONFIANCA: baixa.
- Se a pessoa pedir para falar com alguém, ou se você disser que vai solicitar algo à equipe, use CONFIANCA: baixa.
- Imagens recebidas: diga o que é o documento e os dados principais; a equipe confere.
- A última linha deve ser exatamente "CONFIANCA: alta", "CONFIANCA: media" ou "CONFIANCA: baixa".
DADOS (JSON): ${JSON.stringify(dados)}`;
    const hist = c.mensagens.filter(x => x.de !== 'sistema').slice(-12).map(x => ({ role: x.de === 'cliente' ? 'user' : 'assistant', content: x.texto }));
    try {
      await W.sock?.readMessages?.([chave]).catch?.(nada);
      const resp = await perguntarIA({ mensagens: [{ role: 'user', content: regras }, ...hist], imagens: imagemIA ? [imagemIA] : [] });
      const conf = ((resp.match(/CONFIAN[CÇ]A:\s*(alta|m[eé]dia|baixa)/i) || [])[1] || 'media').toLowerCase().replace('é', 'e');
      const escolhidos = [...new Set(((resp.match(/^\s*ENVIAR:\s*(.+)$/im) || [])[1] || '').toUpperCase().split(/[^A-Z0-9]+/).filter(x => refs[x]))].slice(0, 3);
      const corpo = limpar(resp) || (escolhidos.length ? 'Segue o documento solicitado.' : 'Recebi sua mensagem. A equipe do escritório vai responder em breve.');
      const rt = await enviarTexto(c.waJid, corpo);
      const m = { de: 'ia', texto: corpo, em: new Date().toISOString(), confianca: conf, canal: 'whatsapp', waIds: rt?.key?.id ? [rt.key.id] : [] };
      c.mensagens.push(m);
      let confFinal = conf;
      if (escolhidos.length) {
        const ev = await enviarRefs(esc, c.empresaId, c, refs, escolhidos);
        if (ev.arquivos.length) { m.arquivos = ev.arquivos; m.waIds.push(...ev.waIds); c.mensagens.push({ de: 'sistema', texto: 'O Théo enviou ao cliente: ' + ev.ok.join(', ') + '.', em: new Date().toISOString() }); }
        if (ev.falhas.length) {
          const aviso = 'Não consegui anexar ' + ev.falhas.join(', ') + ' agora. Já pedi para a equipe te enviar.';
          await enviarTexto(c.waJid, aviso).catch(nada); c.mensagens.push({ de: 'ia', texto: aviso, em: new Date().toISOString(), canal: 'whatsapp' }); confFinal = 'baixa';
        }
      }
      if (confFinal === 'baixa') { c.status = 'aguardando_humano'; await deptoDaFila(esc, c, cfg); c.mensagens.push({ de: 'sistema', texto: 'A IA chamou a equipe (' + c.depto + ') para continuar este atendimento.', em: new Date().toISOString() }); }
      await salvarConversa(esc, c);
    } catch (e) {
      console.error('[whatsapp] IA', e.message);
      c.status = 'aguardando_humano';
      c.mensagens.push({ de: 'sistema', texto: 'O copiloto não respondeu (' + e.message + '). Conversa na fila para um atendente.', em: new Date().toISOString() });
      await salvarConversa(esc, c);
    }
  }

  /* ---------- Théo comercial: conversa com lead do CRM ---------- */
  async function responderComercial(esc, c, chave, texto, cfg) {
    const agora = () => new Date().toISOString();
    const l = await lerLead(esc, c.leadId); const conf = cfgTheo(cfg);
    if (!l) { c.modo = null; await salvarConversa(esc, c); return; }
    const registrar = async (txt, extra = {}) => { const x = await lerLead(esc, c.leadId) || l; x.atividades = [...(x.atividades || []), { em: agora(), tipo: 'whatsapp', nome: 'Théo', texto: txt }].slice(-300); Object.assign(x, extra); await gravarLead(esc, x); return x; };
    if (OPTOUT.test(texto || '')) {
      const t = 'Tudo bem! Não vou mais te enviar mensagens. Se precisar da gente, é só chamar por aqui. 😊';
      await enviarTexto(c.waJid, t).catch(nada); c.mensagens.push({ de: 'ia', texto: t, em: agora(), canal: 'whatsapp' }); c.status = 'encerrada'; c.encerradaEm = agora();
      c.mensagens.push({ de: 'sistema', texto: 'O lead pediu para não receber mais mensagens (SAIR).', em: agora() }); await salvarConversa(esc, c);
      await registrar('Pediu para não receber mais mensagens (respondeu SAIR).', { optOut: true }); return;
    }
    // primeira resposta: o lead avança para "Primeiro contato"
    if ((l.etapa || 'novo') === 'novo') await registrar('Respondeu ao Théo pelo WhatsApp: "' + String(texto).slice(0, 140) + '"', { etapa: 'contato', status: 'contato', etapaDesde: agora() });
    if (!iaDisponivel() || !conf.ativo) return passarParaEquipe(esc, c, 'Obrigado! Um especialista do escritório vai continuar com você por aqui em instantes.');
    const dadosLead = { nome: l.nome, empresa: l.empresa, cnpj: l.cnpj ? 'informado' : 'não informado', funcionarios: l.funcionarios, ja_tem_contador: l.temContador, plano_escolhido: l.planoNome, valor_plano: l.valor, cidade: l.cidade, mensagem_do_site: l.mensagem };
    const idt = identidade(cfg);
    const regras = `Você é o Théo, assistente virtual da ${idt.marca}, falando pelo WhatsApp com um interessado que pediu contato pelo site.
${idt.texto}
Objetivo: entender a empresa e encaminhar para um especialista fechar a contratação. Você não fecha contrato nem dá desconto.
Regras:
- Português do Brasil, até 3 frases curtas por mensagem, tom cordial e direto, sem markdown, no máximo 1 emoji.
- Faça UMA pergunta por mensagem. Qualifique nesta ordem, pulando o que já se sabe: tipo de atividade (serviço, comércio ou indústria); se a empresa já existe (e o regime: MEI, Simples Nacional ou outro) ou se vai abrir; faturamento médio mensal aproximado; número de funcionários; cidade; o que é mais importante para ele (preço, atendimento, troca rápida de contador…).
- Use só as INFORMAÇÕES DO ESCRITÓRIO para falar de planos, preços e serviços. Se não souber, diga que o especialista confirma.
- Nunca prometa redução de impostos nem valores de imposto.
- Quando o interessado pedir proposta, contrato, desconto, negociação, ligação, reunião, falar com uma pessoa, ou quando você já tiver as respostas principais, diga que vai passar para um especialista que continua por aqui, e use CONFIANCA: baixa.
- Depois do texto, escreva uma linha "DADOS: " com um JSON só com o que o cliente informou nesta conversa: {"atividade":"","regime":"","faturamento_mensal":"","funcionarios":"","cidade":"","prioridade":"","resumo":""} (deixe vazio o que não souber; "resumo" com até 20 palavras sobre o caso).
- A última linha deve ser exatamente "CONFIANCA: alta", "CONFIANCA: media" ou "CONFIANCA: baixa".
INFORMAÇÕES DO ESCRITÓRIO: ${conf.info || 'Planos mensais de contabilidade online para MEI e Simples Nacional; o especialista apresenta valores.'}
DADOS DO LEAD (JSON): ${JSON.stringify(dadosLead)}`;
    const hist = c.mensagens.filter(x => x.de !== 'sistema').slice(-14).map(x => ({ role: x.de === 'cliente' ? 'user' : 'assistant', content: x.texto }));
    while (hist.length && hist[0].role !== 'user') hist.shift();
    try {
      await W.sock?.readMessages?.([chave]).catch?.(nada);
      const resp = await perguntarIA({ mensagens: [{ role: 'user', content: regras }, ...hist] });
      const conf2 = ((resp.match(/CONFIAN[CÇ]A:\s*(alta|m[eé]dia|baixa)/i) || [])[1] || 'media').toLowerCase().replace('é', 'e');
      let dados = null; const md = resp.match(/DADOS:\s*(\{[\s\S]*?\})\s*(?:\n|$)/i); if (md) { try { dados = JSON.parse(md[1]); } catch { } }
      const corpo = limpar(resp.replace(/^\s*DADOS:.*$/gim, '')) || 'Obrigado! Um especialista vai continuar com você por aqui.';
      await enviarTexto(c.waJid, corpo);
      c.mensagens.push({ de: 'ia', texto: corpo, em: agora(), confianca: conf2, canal: 'whatsapp' });
      if (dados) {
        const x = await lerLead(esc, c.leadId) || l; const q = { ...(x.qualificacao || {}) };
        for (const [k, v] of Object.entries(dados)) if (v && String(v).trim() && k !== 'resumo') q[k] = String(v).slice(0, 120);
        if (dados.resumo) q.resumo = String(dados.resumo).slice(0, 200);
        if (!x.cidade && dados.cidade) x.cidade = String(dados.cidade).slice(0, 80);
        x.qualificacao = q; await gravarLead(esc, x);
      }
      if (conf2 === 'baixa') {
        c.status = 'aguardando_humano'; c.depto = 'Comercial';
        c.mensagens.push({ de: 'sistema', texto: 'O Théo qualificou o lead e chamou o Comercial para continuar.', em: agora() });
        const x = await lerLead(esc, c.leadId) || l;
        await registrar('Théo encaminhou para o Comercial' + (x.qualificacao?.resumo ? ': ' + x.qualificacao.resumo : '.'), { proximaAcao: { data: agora().slice(0, 10), texto: 'Responder no WhatsApp (Théo encaminhou)' }, ...(['novo', 'contato'].includes(x.etapa || 'novo') ? { etapa: 'contato', status: 'contato' } : {}) });
      }
      await salvarConversa(esc, c);
    } catch (e) {
      console.error('[whatsapp] Théo comercial', e.message);
      c.status = 'aguardando_humano'; c.depto = 'Comercial';
      c.mensagens.push({ de: 'sistema', texto: 'O Théo não respondeu (' + e.message + '). Conversa na fila do Comercial.', em: agora() });
      await salvarConversa(esc, c);
    }
  }

  /* ---------- rotas do Painel ---------- */
  const podeConfigurar = u => u.papel === 'master' || pode(u, 'config', 'editar');
  r.get('/api/whatsapp', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'chat', 'ver')) throw new ErroHttp(403, 'Sem acesso ao Atendimento.');
    const instalado = !!(await lib());
    return { ativo: CONFIG.whatsapp.ativo, instalado, status: instalado ? W.status : 'indisponivel', qr: W.status === 'qr' ? W.qr : null,
      numero: W.numero, nome: W.nome, erro: W.erro, ia: iaDisponivel(), podeConfigurar: podeConfigurar(u) };
  });
  r.post('/api/whatsapp/conectar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!podeConfigurar(u)) throw new ErroHttp(403, 'Só o master (ou quem edita Configurações) conecta o WhatsApp.');
    if (!CONFIG.whatsapp.ativo) throw new ErroHttp(503, 'WhatsApp desligado no servidor (WHATSAPP=0).');
    if (!await lib()) throw new ErroHttp(503, 'O módulo do WhatsApp não está instalado no servidor. No Render, ajuste o Build Command para: npm install --omit=dev');
    if (!W.sock) await conectar();
    await log('whatsapp_conectar', { usuarioId: u.id, ip: ctx.ip });
    return { ok: true, status: W.status };
  });
  r.post('/api/whatsapp/desconectar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!podeConfigurar(u)) throw new ErroHttp(403, 'Só o master (ou quem edita Configurações) desconecta o WhatsApp.');
    await desconectar();
    await log('whatsapp_desconectar', { usuarioId: u.id, ip: ctx.ip });
    return { ok: true };
  });
  r.post('/api/whatsapp/enviar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'chat', 'editar')) throw new ErroHttp(403, 'Seu acesso ao Atendimento é só de consulta.');
    if (limitar_(u.id)) throw new ErroHttp(429, 'Muitas mensagens seguidas. Aguarde um instante.');
    const texto = String(ctx.corpo.texto || '').trim().slice(0, 4000);
    const anexos = (Array.isArray(ctx.corpo.arquivos) ? ctx.corpo.arquivos : []).filter(a => a && /^[0-9a-f-]{36}$/.test(a.id)).slice(0, 5);
    if (!texto && !anexos.length) throw new ErroHttp(400, 'Escreva a mensagem ou anexe um arquivo.');
    const esc = u.escritorio_id;
    const [l] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'conversas' AND id = $2`, [esc, String(ctx.corpo.conversaId || '')]);
    if (!l || l.dados.canal !== 'whatsapp') throw new ErroHttp(404, 'Conversa do WhatsApp não encontrada.');
    const c = l.dados;
    await exigirVisivel(u, c);
    // resposta a uma mensagem (citação, como no WhatsApp)
    const resp = ctx.corpo.resposta && typeof ctx.corpo.resposta === 'object' ? ctx.corpo.resposta : null;
    const orig = resp ? c.mensagens.find(m => m.em === resp.em && m.de === resp.de) : null;
    const quoted = orig && orig.waId ? { key: { remoteJid: c.waJid, id: orig.waId, fromMe: orig.de !== 'cliente' }, message: { conversation: String(orig.texto || '') } } : undefined;
    const waIds = [];
    if (texto) { const rt = await enviarTexto(c.waJid, texto, quoted); if (rt?.key?.id) waIds.push(rt.key.id); }
    for (const a of anexos) {
      const [arq] = await db.query('SELECT id, chave, tipo, tamanho, local FROM arquivos WHERE id = $1 AND escritorio_id = $2', [a.id, esc]);
      if (!arq) continue;
      const buf = await lerArquivo(arq);
      const tipo = arq.tipo; const nome = String(a.nome || 'arquivo').slice(0, 120);
      const msg = /^image\//.test(tipo) && !/gif/.test(tipo) ? { image: buf } : /^audio\/(ogg|mp4|mpeg|aac)/.test(tipo) ? { audio: buf, mimetype: tipo === 'audio/ogg' ? 'audio/ogg; codecs=opus' : tipo, ptt: tipo === 'audio/ogg' }
        : /^video\//.test(tipo) ? { video: buf } : { document: buf, mimetype: tipo, fileName: nome };
      const r = await W.sock.sendMessage(c.waJid, msg, !texto && quoted ? { quoted } : undefined);
      if (r?.key?.id) { enviadas.set(r.key.id, r.message); waIds.push(r.key.id); }
    }
    if (c.status !== 'humano' || !c.atendenteUid) { c.status = 'humano'; c.atendenteUid = u.id; c.assumidaEm = new Date().toISOString(); delete c.transferidaPara; c.mensagens.push({ de: 'sistema', texto: `${u.nome} assumiu a conversa.`, em: new Date().toISOString() }); }
    c.mensagens.push({ de: 'humano', texto, em: new Date().toISOString(), uid: u.id, nome: u.nome, canal: 'whatsapp', waIds, ...(resp ? { resposta: { em: String(resp.em || ''), de: String(resp.de || ''), nome: String(resp.nome || '').slice(0, 40), texto: String(resp.texto || '').slice(0, 140) } } : {}), ...(anexos.length ? { arquivos: anexos.map(a => ({ id: a.id, nome: a.nome, tipo: a.tipo, tamanho: a.tamanho, url: `/api/arquivos/${a.id}` })) } : {}) });
    c.naoLidas = 0;
    await salvarConversa(esc, c);
    return { ok: true };
  });
  // apagar para todos: só a própria mensagem e só se for recente (até 60 minutos)
  r.post('/api/whatsapp/apagar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'chat', 'editar')) throw new ErroHttp(403, 'Seu acesso ao Atendimento é só de consulta.');
    const [l] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'conversas' AND id = $2`, [u.escritorio_id, String(ctx.corpo.conversaId || '')]);
    if (!l) throw new ErroHttp(404, 'Conversa não encontrada.');
    const c = l.dados; await exigirVisivel(u, c); const m = c.mensagens.find(x => x.em === ctx.corpo.em && x.uid === u.id && x.de === 'humano');
    if (!m) throw new ErroHttp(404, 'Mensagem não encontrada ou não foi enviada por você.');
    if (Date.now() - new Date(m.em).getTime() > 60 * 60 * 1000) throw new ErroHttp(400, 'Só dá para apagar para todos mensagens enviadas na última hora.');
    if (c.canal === 'whatsapp' && W.sock && W.status === 'conectado') {
      for (const id of m.waIds || []) { try { await W.sock.sendMessage(c.waJid, { delete: { remoteJid: c.waJid, fromMe: true, id } }); } catch (e) { console.error('[whatsapp] apagar', e.message); } }
    }
    Object.assign(m, { apagada: true, apagadaEm: new Date().toISOString(), texto: '' }); delete m.arquivos; delete m.resposta;
    await salvarConversa(u.escritorio_id, c);
    return { ok: true };
  });
  const envios = new Map();
  function limitar_(id) { const a = Date.now(); const l = (envios.get(id) || []).filter(t => a - t < 60000); l.push(a); envios.set(id, l); return l.length > 40; }

  // religa sozinho quando o servidor sobe e já havia um aparelho vinculado
  setTimeout(async () => {
    try {
      if (!CONFIG.whatsapp.ativo) return;
      const esc = await escritorio(); if (!esc) return;
      const [c] = await db.query('SELECT valor FROM whatsapp_auth WHERE escritorio_id = $1 AND chave = $2', [esc, 'creds']);
      if (c && JSON.parse(c.valor).me && await lib()) await conectar();
    } catch (e) { console.error('[whatsapp] religar', e.message); }
  }, 3000).unref();

  // quem recebe as guias da empresa pelo WhatsApp: contatos marcados em Atendimento › Contatos; sem eles, o telefone do cadastro
  async function destinatarios(esc, empresaId, foneCadastro) {
    const cs = (await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'contatos'`, [esc])).map(x => x.dados)
      .filter(c => (c.empresas || []).includes(String(empresaId)) && c.telefone && c.recebeWhatsApp !== false && c.ativo !== false);
    if (cs.length) return cs.map(c => ({ fone: c.telefone, nome: c.nome, contatoId: c.id }));
    return foneCadastro ? [{ fone: foneCadastro, nome: '', contatoId: null }] : [];
  }
  // envia arquivo(s) e registra no atendimento daquele contato (fica no histórico)
  async function enviarArquivos({ esc, empresaId, fone, anexos, legenda, u }) {
    if (!W.sock || W.status !== 'conectado') throw new Error('O WhatsApp do escritório está desconectado.');
    const lista = await destinatarios(esc, empresaId, fone);
    if (!lista.length) throw new Error('A empresa não tem contato com WhatsApp: cadastre em Atendimento › Contatos.');
    const enviados = [], falhas = [], vistos = new Set();
    for (const d of lista) {
      try {
        const jid = await resolverJid(d.fone); if (vistos.has(jid)) continue; vistos.add(jid);
        const waIds = [];
        if (!anexos.length && legenda) { const r0 = await W.sock.sendMessage(jid, { text: legenda }); if (r0?.key?.id) { enviadas.set(r0.key.id, r0.message); waIds.push(r0.key.id); } }
        for (let i = 0; i < anexos.length; i++) {
          const a = anexos[i]; const cap = i === 0 ? legenda || '' : '';
          const r = await W.sock.sendMessage(jid, /^image\//.test(a.tipo) ? { image: a.conteudo, caption: cap } : { document: a.conteudo, mimetype: a.tipo, fileName: a.nome, caption: cap });
          if (r?.key?.id) { enviadas.set(r.key.id, r.message); waIds.push(r.key.id); }
        }
        let c = await conversaAberta(esc, jid); const nova = !c; const agora = new Date().toISOString();
        if (!c) c = { id: 'wa-' + crypto.randomUUID(), empresaId: String(empresaId), canal: 'whatsapp', waJid: jid, waFone: jid.split('@')[0], contatoNome: d.nome || '', contatoId: d.contatoId, status: 'encerrada', encerradaEm: agora, criadoEm: agora, mensagens: [] };
        c.mensagens.push({ de: 'humano', texto: legenda || '', em: agora, uid: u?.id || null, nome: u?.nome || 'Equipe', canal: 'whatsapp', waIds, ...(anexos.length ? { arquivos: anexos.map(a => ({ id: a.id, nome: a.nome, tipo: a.tipo, tamanho: a.conteudo.length, url: `/api/arquivos/${a.id}` })) } : {}) });
        if (nova) c.mensagens.push({ de: 'sistema', texto: u?.nome && /autom|cobran/i.test(u.nome) ? u.nome + '.' : 'Envio automático do Controle de obrigações.', em: agora });
        await salvarConversa(esc, c);
        enviados.push((d.nome ? d.nome + ' ' : '') + '+' + jid.split('@')[0]);
      } catch (e) { falhas.push((d.nome || d.fone) + ': ' + e.message); }
    }
    if (!enviados.length) throw new Error(falhas.join(' · ') || 'Nenhum contato recebeu.');
    return { para: enviados.join(', '), falhas };
  }

  // iniciar um atendimento pelo WhatsApp a partir de um contato
  r.post('/api/whatsapp/iniciar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (!pode(u, 'chat', 'editar')) throw new ErroHttp(403, 'Seu acesso ao Atendimento é só de consulta.');
    if (!W.sock || W.status !== 'conectado') throw new ErroHttp(503, 'O WhatsApp do escritório está desconectado. Conecte pelo QR code em Atendimento.');
    const b = ctx.corpo || {}; const esc = u.escritorio_id;
    const jid = await resolverJid(b.fone);
    const texto = String(b.texto || '').trim().slice(0, 4000);
    let c = await conversaAberta(esc, jid); const agora = new Date().toISOString();
    if (!c) c = { id: 'wa-' + crypto.randomUUID(), empresaId: b.empresaId ? String(b.empresaId) : null, canal: 'whatsapp', waJid: jid, waFone: jid.split('@')[0],
      contatoNome: String(b.nome || '').slice(0, 80), contatoId: b.contatoId ? String(b.contatoId) : null, status: 'humano', atendenteUid: u.id, assumidaEm: agora, criadoEm: agora,
      mensagens: [{ de: 'sistema', texto: `${String(u.nome || '').split(' ')[0]} iniciou o atendimento pelo WhatsApp.`, em: agora }] };
    else if (c.status !== 'humano') { c.status = 'humano'; c.atendenteUid = u.id; c.assumidaEm = agora; c.mensagens.push({ de: 'sistema', texto: `${String(u.nome || '').split(' ')[0]} assumiu a conversa.`, em: agora }); }
    if (texto) { const rt = await enviarTexto(jid, texto); c.mensagens.push({ de: 'humano', texto, em: new Date().toISOString(), uid: u.id, nome: u.nome, canal: 'whatsapp', waIds: rt?.key?.id ? [rt.key.id] : [] }); }
    await salvarConversa(esc, c);
    await log('whatsapp_atendimento_iniciado', { usuarioId: u.id, ip: ctx.ip, detalhe: '+' + jid.split('@')[0] });
    return { ok: true, conversaId: c.id };
  });
  return { status: () => W.status, enviarArquivos, iniciarConversaLead, definirFluxoDas: fn => { fluxoDas = fn; },
    _teste: { contexto, responderIA, receber, usarSock: s => { W.sock = s; W.status = 'conectado'; } } };   // só para testes automatizados
}
