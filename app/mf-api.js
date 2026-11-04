/* Meu Fiscal · adaptador dos sites publicados
 * Liga o app (o mesmo do Portal e do Painel) à API única:
 *  - login por site (cookie do próprio domínio, chamadas via /api/* com proxy da hospedagem)
 *  - carrega só o que o usuário pode ver e grava registro a registro (a API confere cada alteração)
 *  - tempo real por SSE: o que um lado grava aparece no outro em segundos
 *  - arquivos por URL pré-assinada (R2/S3), IA opcional pela API
 * window.MF = { site: 'cliente' | 'painel', api: 'https://sua-api' } é definido no build de cada site.
 */
(function () {
  const M = window.MF = window.MF || {};
  const BASE = {};                  // coleção → Map(id → JSON do último estado confirmado pelo servidor)
  const LOGIN = M.site === 'painel' ? '/admin/login' : '/login';
  let es = null, espera = 1000, filaTr = [], timerTr = null;
  M.estado = 'conectando';

  /* ---------- chamadas ---------- */
  async function api(metodo, caminho, corpo, opcoes = {}) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo, credentials: 'same-origin', signal: opcoes.signal,
        headers: { 'X-MF-Site': M.site, ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw Object.assign(new Error('Sem conexão com o servidor.'), { code: 'unavailable' });
    }
    let j = null; try { j = await r.json(); } catch { }
    if (r.status === 401 && !opcoes.sem401) { irLogin(); throw Object.assign(new Error('Sessão encerrada.'), { code: 'sessao' }); }
    if (!r.ok) throw Object.assign(new Error((j && j.erro) || ('Erro ' + r.status)), { status: r.status, code: r.status >= 500 || r.status === 429 ? 'unavailable' : 'negado' });
    return j;
  }
  M.api = api;
  function irLogin() {
    const volta = location.hash ? '?voltar=' + encodeURIComponent(location.hash) : '';
    location.replace(LOGIN + volta);
  }

  const mapa = lista => new Map(lista.map(x => [String(x.id), JSON.stringify(x)]));

  async function carregarTudo() {
    const d = await api('GET', '/api/dados');
    COLS.forEach(c => {
      if (saving[c] || dirty[c]) return;        // não pisa em edição local ainda não gravada
      S[c] = d.colecoes[c] || []; BASE[c] = mapa(S[c]);
    });
  }

  /* ---------- gravação: diferença por registro ---------- */
  M.salvar = async function (col) {
    if (!BASE[col]) BASE[col] = new Map();
    const ops = [], vistos = new Set();
    for (const it of S[col]) {
      if (it.id == null) it.id = uid();
      const id = String(it.id); vistos.add(id);
      const j = JSON.stringify(it);
      if (BASE[col].get(id) !== j) ops.push({ c: col, op: 'salvar', id, dados: JSON.parse(j), _j: j });
    }
    if (col !== 'auditoria') for (const id of BASE[col].keys()) if (!vistos.has(id)) ops.push({ c: col, op: 'apagar', id });
    for (let i = 0; i < ops.length; i += 400) {
      const parte = ops.slice(i, i + 400);
      try {
        await api('POST', '/api/dados/lote', { ops: parte.map(({ _j, ...o }) => o) });
        parte.forEach(o => o.op === 'apagar' ? BASE[col].delete(o.id) : BASE[col].set(o.id, o._j));
      } catch (e) {
        if (e.code === 'negado') {
          // a API recusou: desfaz localmente e mostra o motivo
          toast(e.message, true);
          const d = await api('GET', '/api/dados').catch(() => null);
          if (d) { S[col] = d.colecoes[col] || []; BASE[col] = mapa(S[col]); }
          render(); return;
        }
        throw e; // 'unavailable' → o app tenta de novo sozinho
      }
    }
    selo();
  };

  /* ---------- tempo real ---------- */
  async function conectarTempoReal() {
    if (es) { es.close(); es = null; }
    let t;
    try { t = await api('GET', '/api/tempo-real/ticket'); }
    catch (e) { if (e.code !== 'sessao') setTimeout(conectarTempoReal, espera = Math.min(espera * 2, 30000)); return; }
    const base = t.url && /^https?:/.test(t.url) ? t.url : (M.api || '') + '/tempo-real';
    es = new EventSource(base + '?site=' + M.site + '&t=' + encodeURIComponent(t.ticket));
    es.addEventListener('pronto', async () => {
      const caiu = M.estado === 'reconectando'; M.estado = 'online'; espera = 1000; selo();
      if (caiu) { await carregarTudo().catch(() => { }); agendarRender(); }   // recupera o que mudou enquanto esteve fora
    });
    es.addEventListener('registro', ev => { try { enfileirar(JSON.parse(ev.data)); } catch { } });
    es.addEventListener('recarregar', async () => { await carregarTudo().catch(() => { }); agendarRender(); });
    es.addEventListener('sair', () => irLogin());
    es.onerror = () => {
      // ticket vence em 15 min ou a API reiniciou: pega outro ticket e reconecta
      es.close(); es = null; M.estado = 'reconectando'; selo();
      setTimeout(conectarTempoReal, espera); espera = Math.min(espera * 2, 30000);
    };
  }
  function enfileirar(d) {
    filaTr.push(d); clearTimeout(timerTr);
    timerTr = setTimeout(aplicarFila, 120);
  }
  async function aplicarFila() {
    const itens = [...new Map(filaTr.map(d => [d.c + '|' + d.id, { c: d.c, id: d.id }])).values()]; filaTr = [];
    if (!itens.length) return;
    let r; try { r = await api('POST', '/api/dados/buscar', { itens }); } catch { return; }
    let mudou = false;
    for (const { c, id, dados } of r.itens) {
      if (!S[c]) continue; if (!BASE[c]) BASE[c] = new Map();
      const idx = S[c].findIndex(x => String(x.id) === String(id));
      const local = idx >= 0 ? JSON.stringify(S[c][idx]) : null, base = BASE[c].get(String(id));
      if (local !== null && base !== undefined && local !== base) continue;   // há edição local pendente: ela prevalece
      if (dados === null) { if (idx >= 0) { S[c].splice(idx, 1); mudou = true; } BASE[c].delete(String(id)); continue; }
      const j = JSON.stringify(dados);
      if (j === local) { BASE[c].set(String(id), j); continue; }
      if (idx >= 0) { const alvo = S[c][idx]; Object.keys(alvo).forEach(k => delete alvo[k]); Object.assign(alvo, dados); }
      else S[c].push(dados);
      BASE[c].set(String(id), j); mudou = true;
    }
    if (mudou) { M.ultimaAtualizacao = new Date(); agendarRender(); }
  }

  /* ---------- capacidades que o app espera ---------- */
  const assets = {
    async upload(blob) {
      const tipo = blob.type || 'application/octet-stream';
      const a = await api('POST', '/api/arquivos', { tipo, tamanho: blob.size, empresaId: UI.empresaId });
      const mesmaOrigem = a.envio.url.startsWith('/');
      const r = await fetch(a.envio.url, {
        method: a.envio.metodo, body: blob, credentials: mesmaOrigem ? 'same-origin' : 'omit',
        headers: { ...a.envio.cabecalhos, ...(mesmaOrigem ? { 'X-MF-Site': M.site } : {}) },
      });
      if (!r.ok) throw Object.assign(new Error('Falha no envio'), { code: 'envio_' + r.status });
      return { id: a.id, url: a.url };
    },
  };

  async function reduzirImagem(file) {
    try {
      const bmp = await createImageBitmap(file);
      const esc = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * esc); c.height = Math.round(bmp.height * esc);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
      const b64 = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      return { tipo: 'image/jpeg', base64: b64 };
    } catch { return null; }
  }
  async function sample(turnos, opcoes = {}) {
    const imagens = (await Promise.all((opcoes.images || []).map(reduzirImagem))).filter(Boolean);
    try {
      const r = await api('POST', '/api/ia', { mensagens: turnos, imagens }, { signal: opcoes.signal });
      opcoes.onText?.({ text: r.texto });
      return { text: r.texto };
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(e, { code: 'aborted' });
      throw Object.assign(e, { code: e.status === 503 ? 'sampling_disabled' : e.status === 429 ? 'rate_limited' : e.status === 422 ? 'refused' : (e.code || 'erro') });
    }
  }
  sample.limits = async () => ({ images: { maxCount: 5 } });

  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
  };
  const usuarios = {
    async profiles(ids) {
      const r = await api('GET', '/api/usuarios/nomes?ids=' + ids.join(','));
      return Object.fromEntries(Object.entries(r.nomes).map(([k, v]) => [k, { name: v }]));
    },
  };

  /* ---------- rodapé da barra lateral ---------- */
  M.rodape = function () {
    const txt = M.estado === 'online' ? 'Tempo real · conectado' : M.estado === 'reconectando' ? 'Reconectando…' : 'Conectando…';
    return `<span class="conn ${M.estado === 'online' ? 'ok' : ''}" id="mf-selo"><i></i>${txt}</span>
      <span>${esc(ME.nome)}${M.site === 'painel' && (ME.funcao || ME.papel) ? ' · ' + esc(ME.funcao || ({ master: 'Master' }[ME.papel] || 'Equipe')) : ''}</span>
      <span style="display:flex;gap:10px;flex-wrap:wrap">${M.site === 'painel' && typeof podeMod === 'function' && podeMod('equipe', 'ver') ? '<a href="#a-equipe" style="color:inherit">Equipe e permissões</a>' : ''}<a href="#${M.site === 'painel' ? 'a-perfil' : 'c-perfil'}" style="color:inherit">Meu perfil</a><a href="#" data-act="mf-sair" style="color:inherit">Sair</a></span>`;
  };
  function selo() {
    const el = document.getElementById('mf-selo'); if (!el) return;
    el.className = 'conn ' + (M.estado === 'online' ? 'ok' : '');
    el.innerHTML = '<i></i>' + (M.estado === 'online' ? 'Tempo real · conectado' : M.estado === 'reconectando' ? 'Reconectando…' : 'Conectando…');
  }

  /* ---------- início ---------- */
  M.iniciar = async function () {
    telaCarregando('Conectando ao Meu Fiscal…');
    let eu;
    try { eu = await api('GET', '/api/eu'); }
    catch (e) {
      if (e.code === 'sessao') return;
      telaCarregando('Não foi possível falar com o servidor agora. Se o plano gratuito estava em repouso, ele leva até um minuto para acordar.', true);
      setTimeout(() => location.reload(), 15000); return;
    }
    M.eu = eu;
    ME.id = eu.usuario.id; ME.nome = eu.usuario.nome; ME.canEdit = M.site === 'painel';
    ME.papel = eu.usuario.papel; ME.funcao = eu.usuario.funcao; ME.perm = eu.usuario.permissoes || null;
    ME.deptos = M.site === 'painel' ? (eu.usuario.deptos === undefined ? null : eu.usuario.deptos) : undefined;
    M.urlCliente = eu.urls?.cliente || ''; M.urlPainel = eu.urls?.painel || '';
    if (M.site === 'painel' && typeof aplicarPermissoes === 'function') aplicarPermissoes();
    Object.assign(CAP, { db: null, sample: eu.recursos.ia ? sample : null, assets, downloads, user: M.site === 'painel' ? usuarios : null });
    try { await carregarTudo(); }
    catch (e) { if (e.code !== 'sessao') telaCarregando('Falha ao carregar os dados: ' + e.message, true); return; }
    MODO = 'api';
    if (M.site === 'painel' && !location.hash) { UI.modo = 'painel'; UI.view = 'a-home'; }
    lerHash();
    if (M.site === 'cliente' && UI.modo !== 'cliente') { UI.modo = 'cliente'; UI.view = 'c-dash'; }
    const v = empresasVisiveis(); UI.empresaId = v[0]?.id || null;
    ACT['mf-sair'] = async () => { try { await api('POST', '/api/sair', {}); } catch { } location.replace(LOGIN); };
    ACT['recarregar'] = () => location.reload();
    if (M.site === 'cliente' && !v.length) {
      document.getElementById('root').innerHTML = `<div class="loading"><div style="display:flex;flex-direction:column;gap:12px;align-items:center;max-width:440px;text-align:center"><div class="brand-mark" style="width:44px;height:44px;font-size:18px"><svg viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(32 32) scale(0.72) translate(-32 -31)" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M13 48V32a6 6 0 0 1 12 0v16M25 32a6 6 0 0 1 12 0M37 48V22a8 8 0 0 1 8-8h6" stroke="#fff"/><path d="M37 30H50" stroke="#34D399"/></g></svg></div><h1>Nenhuma empresa liberada</h1><p class="muted">Seu acesso está ativo, mas o escritório ainda não liberou nenhuma empresa para você. Fale com a equipe e tente de novo.</p><button class="btn" data-act="mf-sair">Sair</button></div></div>`;
      conectarTempoReal(); return;
    }
    render();
    conectarTempoReal();
  };
})();
