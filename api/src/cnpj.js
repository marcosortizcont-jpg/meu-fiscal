// Consulta pública de CNPJ (dados cadastrais da Receita Federal) para preencher o cadastro de empresas.
// Fontes gratuitas: BrasilAPI e, se falhar, CNPJ.ws (API pública). Resultado em cache por 12 horas.
import { ErroHttp } from './http.js';
import { limitar } from './seguranca.js';

const FALSO = process.env.CNPJ_FALSO === '1' && process.env.NODE_ENV !== 'production';
const cache = new Map();
const soDig = s => String(s || '').replace(/\D/g, '');
const titulo = s => String(s || '').toLowerCase().replace(/(^|[\s/(-])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, x => x.toLowerCase()).replace(/\b(Ltda|Me|Epp|Eireli|S\/a|Sa|Mei)\b/gi, x => x.toUpperCase());

function cnpjValido(c) {
  c = soDig(c); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}
async function buscar(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MeuFiscal/1.0' }, signal: AbortSignal.timeout(9000) });
  if (r.status === 404) throw Object.assign(new Error('CNPJ não encontrado na Receita.'), { status: 404 });
  if (!r.ok) throw new Error('consulta indisponível (' + r.status + ')');
  return r.json();
}
const fone = (x) => { const d = soDig(x); return d.length >= 10 ? d : ''; };
function deBrasilApi(j) {
  const log = [j.descricao_tipo_de_logradouro || j.descricao_tipo_logradouro, j.logradouro].filter(Boolean).join(' ');
  return { razao: j.razao_social, fantasia: j.nome_fantasia, situacao: j.descricao_situacao_cadastral, abertura: j.data_inicio_atividade, cnae: j.cnae_fiscal ? String(j.cnae_fiscal) : '', atividade: j.cnae_fiscal_descricao,
    cep: soDig(j.cep), logradouro: log, numero: j.numero, complemento: j.complemento, bairro: j.bairro, municipio: j.municipio, uf: j.uf, email: j.email, telefone: fone(j.ddd_telefone_1),
    mei: j.opcao_pelo_mei === true, simples: j.opcao_pelo_simples === true, porte: j.descricao_porte || j.porte, natureza: j.natureza_juridica || '', socios: (j.qsa || []).map(s => ({ nome: s.nome_socio, qualificacao: s.qualificacao_socio || '' })) };
}
function deCnpjWs(j) {
  const e = j.estabelecimento || {};
  return { razao: j.razao_social, fantasia: e.nome_fantasia, situacao: e.situacao_cadastral, abertura: e.data_inicio_atividade, cnae: e.atividade_principal?.id || '', atividade: e.atividade_principal?.descricao,
    cep: soDig(e.cep), logradouro: [e.tipo_logradouro, e.logradouro].filter(Boolean).join(' '), numero: e.numero, complemento: e.complemento, bairro: e.bairro, municipio: e.cidade?.nome, uf: e.estado?.sigla,
    email: e.email, telefone: fone((e.ddd1 || '') + (e.telefone1 || '')), mei: j.simples?.mei === 'Sim', simples: j.simples?.simples === 'Sim', porte: j.porte?.descricao, natureza: j.natureza_juridica?.descricao || '',
    socios: (j.socios || []).map(s => ({ nome: s.nome, qualificacao: s.qualificacao_socio?.descricao || '' })) };
}
function arrumar(d) {
  const t = v => String(v ?? '').trim();
  const cnaeFmt = soDig(d.cnae).replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3');
  return { razao: t(d.razao), fantasia: titulo(t(d.fantasia)), situacao: t(d.situacao).toUpperCase(), abertura: t(d.abertura).slice(0, 10), cnae: cnaeFmt, atividade: t(d.atividade),
    endereco: { cep: soDig(d.cep).slice(0, 8), logradouro: titulo(t(d.logradouro)), numero: t(d.numero) || 'S/N', complemento: titulo(t(d.complemento)), bairro: titulo(t(d.bairro)) },
    municipio: titulo(t(d.municipio)), uf: t(d.uf).toUpperCase().slice(0, 2), email: t(d.email).toLowerCase(), telefone: d.telefone || '',
    regime: d.mei ? 'MEI' : d.simples ? 'SN' : 'OUTRO', porte: t(d.porte), natureza: t(d.natureza), socios: (d.socios || []).slice(0, 10).map(s => ({ nome: titulo(t(s.nome)), qualificacao: t(s.qualificacao) })) };
}

export async function consultarCnpj(cnpj) {
  const c = soDig(cnpj); if (!cnpjValido(c)) throw new ErroHttp(400, 'CNPJ inválido.');
  const k = cache.get(c); if (k && Date.now() - k.em < 12 * 3600e3) return k.d;
  let d;
  if (FALSO) d = arrumar({ razao: 'EMPRESA TESTE DA RECEITA LTDA', fantasia: 'TESTE RECEITA', situacao: 'ATIVA', abertura: '2021-03-15', cnae: '6201501', atividade: 'Desenvolvimento de programas de computador sob encomenda',
    cep: '79002000', logradouro: 'RUA 14 DE JULHO', numero: '1500', complemento: 'SALA 3', bairro: 'CENTRO', municipio: 'CAMPO GRANDE', uf: 'MS', email: 'contato@teste.com.br', telefone: '6733334444', simples: true, socios: [{ nome: 'MARIA DA SILVA', qualificacao: 'Sócio-Administrador' }] });
  else {
    try { d = arrumar(deBrasilApi(await buscar(`https://brasilapi.com.br/api/cnpj/v1/${c}`))); }
    catch (e1) {
      if (e1.status === 404) throw new ErroHttp(404, e1.message);
      try { d = arrumar(deCnpjWs(await buscar(`https://publica.cnpj.ws/cnpj/${c}`))); }
      catch (e2) { throw new ErroHttp(e2.status === 404 ? 404 : 502, e2.status === 404 ? e2.message : 'A consulta à Receita está indisponível agora. Preencha os dados à mão ou tente de novo em instantes.'); }
    }
  }
  // endereço sem rua (comum em MEI): completa pelo CEP
  if (!FALSO && d.endereco.cep.length === 8 && (!d.endereco.logradouro || !d.endereco.bairro || !d.municipio)) {
    try { const ce = await buscar(`https://brasilapi.com.br/api/cep/v2/${d.endereco.cep}`);
      if (!d.endereco.logradouro && ce.street) d.endereco.logradouro = titulo(ce.street); if (!d.endereco.bairro && ce.neighborhood) d.endereco.bairro = titulo(ce.neighborhood);
      if (!d.municipio && ce.city) d.municipio = titulo(ce.city); if (!d.uf && ce.state) d.uf = String(ce.state).toUpperCase(); } catch { }
  }
  cache.set(c, { em: Date.now(), d }); if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return d;
}

export function registrarCnpj(r, { exigir }) {
  r.get('/api/cnpj/:cnpj', async ctx => {
    const u = await exigir(ctx, { site: 'painel' });
    if (limitar(`cnpj:${u.id}`, 30, 300).bloqueado) throw new ErroHttp(429, 'Muitas consultas seguidas. Aguarde alguns minutos.');
    return { ok: true, dados: await consultarCnpj(ctx.params.cnpj) };
  });
  r.get('/api/cep/:cep', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); const cep = soDig(ctx.params.cep);
    if (cep.length !== 8) throw new ErroHttp(400, 'CEP inválido.');
    if (limitar(`cep:${u.id}`, 60, 300).bloqueado) throw new ErroHttp(429, 'Muitas consultas seguidas.');
    if (FALSO) return { ok: true, dados: { logradouro: 'Rua do Teste', bairro: 'Centro', municipio: 'Campo Grande', uf: 'MS' } };
    try { const c = await buscar(`https://brasilapi.com.br/api/cep/v2/${cep}`); return { ok: true, dados: { logradouro: titulo(c.street || ''), bairro: titulo(c.neighborhood || ''), municipio: titulo(c.city || ''), uf: String(c.state || '').toUpperCase() } }; }
    catch (e) { throw new ErroHttp(e.status === 404 ? 404 : 502, e.status === 404 ? 'CEP não encontrado.' : 'Consulta de CEP indisponível agora.'); }
  });
}
