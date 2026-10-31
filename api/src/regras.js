// Quem lê e quem grava o quê. Esta é a fronteira de segurança entre clientes: o navegador nunca decide.
//
// Equipe (Painel Contábil): lê e grava todas as empresas do próprio escritório.
// Cliente (Portal): lê só as empresas liberadas para ele e grava só o que o portal permite,
// campo a campo quando o registro pertence ao escritório (guias, faturas, empresas).

export const COLECOES = ['config', 'operadores', 'empresas', 'faturamento', 'despesas', 'guias', 'documentos', 'checklist', 'obrigacoes',
  'fechamentos', 'funcionarios', 'folhas', 'admissoes', 'notas', 'tomadores', 'servicos', 'certificados', 'tickets', 'conversas', 'cnds',
  'ecac', 'faturas', 'consentimentos', 'auditoria', 'catalogo', 'regimes', 'leads'];
import { MODULO_DA_COLECAO, SEMPRE_LEGIVEIS, pode } from './permissoes.js';

// Coleções que existem para o escritório inteiro (sem empresa)
const GLOBAIS = new Set(['config', 'operadores', 'auditoria', 'catalogo', 'regimes', 'leads']);
// O cliente nunca recebe estas coleções
const OCULTAS_CLIENTE = new Set(['operadores', 'auditoria', 'catalogo', 'regimes', 'leads']);

/*
 * Permissões do cliente por coleção.
 *   criar/apagar: pode inserir ou excluir registros da própria empresa
 *   campos: se definido, só estes caminhos podem mudar numa edição (o resto precisa ficar igual)
 *   bloqueados: caminhos que o cliente nunca altera
 *   status: valores de "status" que o cliente pode gravar (além de manter o atual)
 */
const CLIENTE = {
  documentos:     { criar: true, editar: true, apagar: true },
  checklist:      { criar: true, editar: true, status: ['pendente', 'enviado'] },
  tickets:        { criar: true, editar: true, status: ['aberto', 'em_andamento'], bloqueados: ['valor', 'faturado', 'prazo', 'renovacao.status', 'admissaoId'] },
  admissoes:      { criar: true, editar: true, status: ['em_analise'] },
  despesas:       { criar: true, editar: true, apagar: true },
  faturamento:    { criar: true, editar: true, apagar: true },
  funcionarios:   { criar: true, editar: true },
  conversas:      { criar: true, editar: true, bloqueados: ['atendenteUid', 'atendenteId'] },
  notas:          { criar: true, editar: true },
  tomadores:      { criar: true, editar: true, apagar: true },
  servicos:       { criar: true, editar: true, apagar: true },
  certificados:   { criar: true },
  // registros do escritório em que o cliente só informa algo
  guias:          { editar: true, campos: ['status', 'comprovante', 'pagaEm', 'informadaEm', 'recusaMotivo'], status: ['informada'], travadoEm: ['paga', 'rascunho'] },
  faturas:        { editar: true, campos: ['status', 'comprovante', 'informadaEm'], status: ['informada'], travadoEm: ['paga', 'cancelada'] },
  empresas:       { editar: true, campos: ['plano.metodo'] },
};

export const empresaDe = (colecao, dados) => colecao === 'empresas' ? String(dados.id) : (GLOBAIS.has(colecao) ? null : (dados.empresaId != null ? String(dados.empresaId) : null));

/* ---------- leitura ---------- */
// Monta o WHERE de leitura. Retorna [sql, params] a partir do índice inicial informado.
// Equipe: coleções dos módulos marcados como "nenhum" para a pessoa não são enviadas
export function ocultasEquipe(u) {
  return Object.keys(MODULO_DA_COLECAO).filter(c => !SEMPRE_LEGIVEIS.has(c) && !pode(u, MODULO_DA_COLECAO[c], 'ver'));
}
export function filtroLeitura(u, i = 2) {
  if (u.ambiente === 'equipe') { const o = ocultasEquipe(u); return o.length ? [` AND colecao <> ALL($${i}::text[])`, [o]] : ['', []]; }
  return [` AND colecao <> ALL($${i}::text[]) AND (empresa_id = ANY($${i + 1}::text[]) OR colecao = 'config'`
    + ` OR (colecao = 'consentimentos' AND dados->>'uid' = $${i + 2}))`
    + ` AND NOT (colecao = 'guias' AND dados->>'status' = 'rascunho')`, [[...OCULTAS_CLIENTE], u.empresas.map(e => e.id), u.id]];
}
// Registro que existe mas ainda não foi liberado ao cliente (ex.: guia em rascunho)
export function visivelAoCliente(colecao, dados) { return !(colecao === 'guias' && dados && dados.status === 'rascunho'); }
export function podeLer(u, colecao, empresaId) {
  if (u.ambiente === 'equipe') return SEMPRE_LEGIVEIS.has(colecao) || !MODULO_DA_COLECAO[colecao] || pode(u, MODULO_DA_COLECAO[colecao], 'ver');
  if (OCULTAS_CLIENTE.has(colecao)) return false;
  if (colecao === 'config') return true;
  return empresaId != null && u.empresas.some(e => e.id === empresaId);
}

// O acesso de clientes às empresas vem da tabela usuarios_empresas, não do JSON da empresa
export function prepararLeitura(u, colecao, dados, acessosPorEmpresa) {
  if (colecao === 'empresas') {
    const acessos = acessosPorEmpresa?.get(String(dados.id)) || [];
    return { ...dados, acessos: u.ambiente === 'equipe' ? acessos : acessos.filter(a => a.uid === u.id) };
  }
  return dados;
}

/* ---------- escrita ---------- */
const pegar = (o, c) => c.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function semCaminhos(o, caminhos) {
  const c = JSON.parse(JSON.stringify(o ?? {}));
  for (const cam of caminhos) { const ks = cam.split('.'); let x = c; for (let i = 0; i < ks.length - 1 && x; i++) x = x[ks[i]]; if (x && typeof x === 'object') delete x[ks.at(-1)]; }
  return c;
}
const igual = (a, b) => JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b));
function ordenar(v) { if (Array.isArray(v)) return v.map(ordenar); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, ordenar(v[k])])); return v; }

/**
 * Confere uma operação de escrita. Lança Error com mensagem para o usuário quando não pode.
 * op: { c, op: 'salvar'|'apagar', id, dados }, atual: registro existente ou null
 */
export function conferirEscrita(u, op, atual) {
  const { c } = op;
  if (!COLECOES.includes(c)) throw new Error(`Coleção desconhecida: ${c}.`);
  if (op.op === 'salvar') {
    if (!op.dados || typeof op.dados !== 'object' || Array.isArray(op.dados)) throw new Error('Registro inválido.');
    if (String(op.dados.id) !== String(op.id)) throw new Error('O id do registro não confere.');
  }
  if (c === 'auditoria' && (op.op === 'apagar' || atual)) throw new Error('O histórico de auditoria não pode ser alterado.');

  if (u.ambiente === 'equipe') {
    if (c === 'auditoria') return;
    const m = MODULO_DA_COLECAO[c];
    if (m && op.op === 'apagar' && !pode(u, m, 'excluir')) throw new Error('Seu acesso não permite excluir registros desta área. Peça ao administrador master.');
    if (m && !pode(u, m, 'editar')) throw new Error('Seu acesso a esta área é só de consulta. Peça ao administrador master para liberar a edição.');
    return;
  }

  // ---- cliente ----
  if (c === 'auditoria') return; // só inclusão (o servidor carimba autor e data)
  // aceite dos termos (LGPD) é da pessoa, não da empresa: só inclusão, sempre em nome de quem está logado
  if (c === 'consentimentos') { if (atual || op.op === 'apagar') throw new Error('O aceite dos termos não pode ser alterado.'); return; }
  const regra = CLIENTE[c];
  if (!regra) throw new Error('O Portal do Cliente não pode alterar esta área.');
  const minhas = new Set(u.empresas.map(e => e.id));
  if (atual && !minhas.has(atual.empresa_id)) throw new Error('Registro de outra empresa.');
  if (op.op === 'apagar') { if (!regra.apagar) throw new Error('Este registro não pode ser excluído pelo portal.'); return; }

  const novaEmpresa = empresaDe(c, op.dados);
  if (!minhas.has(novaEmpresa)) throw new Error('Você não tem acesso a esta empresa.');
  if (!atual) { if (!regra.criar) throw new Error('O portal não pode criar este registro.'); }
  else {
    if (!regra.editar) throw new Error('Este registro não pode ser alterado pelo portal.');
    if (atual.empresa_id !== novaEmpresa) throw new Error('Não é possível mover o registro para outra empresa.');
  }
  const antes = atual ? atual.dados : {};
  if (regra.campos && atual && !igual(semCaminhos(antes, regra.campos), semCaminhos(op.dados, regra.campos)))
    throw new Error('O portal só pode alterar: ' + regra.campos.join(', ') + '.');
  if (atual && regra.travadoEm && regra.travadoEm.includes(antes.status)) throw new Error('Este registro já foi concluído pelo escritório.');
  if (atual) for (const cam of regra.bloqueados || []) {
    if (!igual(pegar(antes, cam), pegar(op.dados, cam))) throw new Error(`O campo "${cam}" é definido pelo escritório.`);
  }
  if (regra.status) {
    const st = op.dados.status;
    if (st !== undefined && st !== antes.status && !regra.status.includes(st))
      throw new Error('Esta situação só pode ser definida pelo escritório.');
  }
  // pedido de renovação nasce sempre aguardando pagamento (o valor é conferido na rota, contra a configuração)
  if (!atual && c === 'tickets' && op.dados.renovacao && op.dados.renovacao.status !== 'aguardando_pagamento')
    throw new Error('Pedido de renovação inválido.');
}

// Dados que o servidor carimba e que o navegador não controla
export function carimbar(u, c, dados) {
  if (c === 'empresas') { const { acessos, ...resto } = dados; return resto; }
  if (c === 'auditoria') return { ...dados, uid: u.id, nome: u.nome, em: new Date().toISOString() };
  if (c === 'consentimentos') return { ...dados, uid: u.id, em: new Date().toISOString() };
  return dados;
}
