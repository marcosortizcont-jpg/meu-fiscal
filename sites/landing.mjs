// Monta a página comercial (index.html do site do cliente) a partir de app/landing.html + app/landing.config.json.
// Os textos que mudam com frequência (preços, planos, depoimentos, números) ficam no JSON.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const CHECK = '<svg viewBox="0 0 24 24" class="mt-0.5 h-5 w-5 shrink-0 text-esmeralda" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>';

function planos(c) {
  return (c.planos || []).map(p => {
    const d = !!p.destaque;
    return `<article class="relative flex flex-col rounded-3xl ${d ? 'bg-marinho text-white shadow-2xl shadow-marinho/30 ring-2 ring-esmeralda lg:-my-4 lg:py-12' : 'border border-slate-200 bg-white'} p-7 sm:p-8">
  ${d ? `<span class="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-esmeralda px-4 py-1 text-xs font-bold uppercase tracking-wide text-white shadow">${esc(p.selo || 'Mais escolhido')}</span>` : ''}
  <h3 class="text-lg font-bold ${d ? 'text-white' : 'text-marinho'}">${esc(p.nome)}</h3>
  <p class="mt-1 text-sm ${d ? 'text-slate-300' : 'text-slate-500'}">${esc(p.subtitulo || '')}</p>
  <p class="mt-6 flex items-baseline gap-1"><span class="text-sm ${d ? 'text-slate-300' : 'text-slate-500'}">R$</span><span class="text-5xl font-extrabold tracking-tight ${d ? 'text-white' : 'text-marinho'}">${brl(p.preco)}</span><span class="text-sm ${d ? 'text-slate-300' : 'text-slate-500'}">/mês</span></p>
  <ul class="mt-7 flex-1 space-y-3 text-sm ${d ? 'text-slate-200' : 'text-slate-600'}">${(p.itens || []).map(i => `<li class="flex gap-2.5">${CHECK}<span>${esc(i)}</span></li>`).join('')}</ul>
  <a href="#comecar" data-plano="${esc(p.id)}" class="mt-8 block rounded-xl px-6 py-3.5 text-center font-semibold transition ${d ? 'bg-esmeralda text-white shadow-lg shadow-esmeralda/30 hover:bg-esmeralda-escuro' : 'border border-marinho text-marinho hover:bg-marinho hover:text-white'}">Quero este plano</a>
</article>`;
  }).join('\n');
}

function metricas(c) {
  return (c.metricas || []).map(m => `<div class="rounded-2xl border border-white/10 bg-white/5 p-6">
  <p class="text-4xl font-extrabold tracking-tight text-emerald-400">${esc(m.valor)}</p>
  <p class="mt-3 font-semibold text-white">${esc(m.titulo)}</p>
  <p class="mt-1.5 text-sm leading-relaxed text-slate-300">${esc(m.texto)}</p>
</div>`).join('\n');
}

// Só aparece quando houver depoimentos reais cadastrados no JSON (com autorização do cliente).
function depoimentos(c) {
  const d = (c.depoimentos || []).filter(x => x && x.texto && x.nome);
  if (!d.length) return '';
  return `<div class="mt-16"><p class="text-sm font-semibold uppercase tracking-wider text-emerald-400">Quem já é cliente</p>
<div class="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">${d.map(x => `<figure class="flex flex-col rounded-2xl bg-white p-6 text-slate-700">
  <blockquote class="flex-1 text-sm leading-relaxed">“${esc(x.texto)}”</blockquote>
  <figcaption class="mt-5 flex items-center gap-3"><span class="grid h-10 w-10 place-items-center rounded-full bg-emerald-50 text-sm font-bold text-esmeralda-escuro">${esc(iniciais(x.nome))}</span><span><span class="block text-sm font-semibold text-marinho">${esc(x.nome)}</span><span class="block text-xs text-slate-500">${esc([x.empresa, x.regime].filter(Boolean).join(' · '))}</span></span></figcaption>
</figure>`).join('')}</div></div>`;
}

const iniciais = n => { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return ((p[0] || '')[0] || '') + (p.length > 1 ? p[p.length - 1][0] : ''); };

export function montarLanding(tpl, c, { siteUrl, painelUrl }) {
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'AccountingService', name: 'Meu Fiscal', url: siteUrl + '/',
    description: 'Contabilidade online para MEI e empresas do Simples Nacional.',
    telephone: c.telefone, email: c.email, areaServed: 'BR',
    address: { '@type': 'PostalAddress', addressLocality: String(c.cidade || '').split('/')[0], addressRegion: String(c.cidade || '').split('/')[1] || undefined, addressCountry: 'BR' },
    founder: { '@type': 'Person', name: c.contador, jobTitle: 'Contador', ...(c.crc ? { identifier: c.crc } : {}) },
    makesOffer: (c.planos || []).map(p => ({ '@type': 'Offer', name: p.nome, price: p.preco, priceCurrency: 'BRL' })),
  };
  const clientes = Number(c.clientesAtivos) > 0
    ? `<li class="flex items-center gap-2"><svg viewBox="0 0 24 24" class="h-5 w-5 text-esmeralda" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/></svg>Mais de ${esc(c.clientesAtivos)} empresas atendidas</li>`
    : `<li class="flex items-center gap-2"><svg viewBox="0 0 24 24" class="h-5 w-5 text-esmeralda" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 7l8 4 8-4z"/><path d="M4 12l8 4 8-4M4 17l8 4 8-4"/></svg>Contador responsável${c.crc ? ' ' + esc(c.crc) : ' pela sua empresa'}</li>`;
  const vars = {
    ...c, SITE_URL: siteUrl, PAINEL_URL: painelUrl, ANO: new Date().getFullYear(),
    CTA_TOPO: c.aberturaGratis ? 'Abrir empresa grátis' : 'Mudar de contabilidade',
    INICIAIS: iniciais(c.contador),
    // CRC é opcional: com "crc" vazio no JSON, a página não mostra o registro em lugar nenhum
    CRC_PONTO: c.crc ? ' · ' + c.crc : '', CRC_PAREN: c.crc ? ' (' + c.crc + ')' : '', CRC_REG: c.crc ? ' registrado no ' + c.crc : '', CRC_VIRG: c.crc ? ', ' + c.crc : '',
  };
  return tpl
    .replace('<!--@JSONLD-->', `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>`)
    .replace('<!--@PLANOS-->', planos(c))
    .replace('<!--@PLANOS_OPCOES-->', (c.planos || []).map(p => `<option value="${esc(p.id)}">${esc(p.nome)} · R$ ${brl(p.preco)}/mês</option>`).join(''))
    .replace('<!--@METRICAS-->', metricas(c))
    .replace('<!--@DEPOIMENTOS-->', depoimentos(c))
    .replace('<!--@CLIENTES_BADGE-->', clientes)
    .replace(/\{\{(\w+)\}\}/g, (_, k) => k in vars ? esc(vars[k]) : _);
}
