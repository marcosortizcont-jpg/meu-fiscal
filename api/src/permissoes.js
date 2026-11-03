// Funções da equipe e permissões por módulo do Painel Contábil.
// Cada módulo tem um nível: 'nenhum' (não vê), 'ver' (consulta), 'editar' (inclui e altera) ou 'excluir' (também apaga).
// Os níveis são cumulativos: quem exclui também edita e vê.
// O master tem tudo; para as demais funções o padrão vem daqui e o master pode mudar (tabela escritorios.funcoes)
// e ainda ajustar pessoa a pessoa (usuarios.permissoes).

export const MODULOS = [
  ['carteira', 'Carteira de clientes'],
  ['obrig', 'Obrigações, catálogo e regimes'],
  ['guias', 'Apuração, guias e notas'],
  ['docs', 'Documentos e envio mensal'],
  ['chat', 'Atendimento'],
  ['fiscal', 'Monitor fiscal (CND e e-CAC)'],
  ['cert', 'Certificados digitais'],
  ['cofre', 'Cofre de senhas dos portais'],
  ['dem', 'Demandas, admissões e folha'],
  ['hon', 'Honorários'],
  ['equipe', 'Equipe e auditoria'],
  ['config', 'Configurações do escritório'],
];
export const NIVEIS = ['nenhum', 'ver', 'editar', 'excluir'];
const RANK = { nenhum: 0, ver: 1, editar: 2, excluir: 3 };

export const FUNCOES = {
  'Master': Object.fromEntries(MODULOS.map(([m]) => [m, 'excluir'])),
  'Analista Fiscal': { carteira: 'ver', obrig: 'editar', guias: 'editar', docs: 'editar', chat: 'editar', fiscal: 'editar', cert: 'ver', cofre: 'ver', dem: 'editar', hon: 'nenhum', equipe: 'nenhum', config: 'nenhum' },
  'Analista de DP': { carteira: 'ver', obrig: 'editar', guias: 'ver', docs: 'editar', chat: 'editar', fiscal: 'ver', cert: 'ver', cofre: 'ver', dem: 'editar', hon: 'nenhum', equipe: 'nenhum', config: 'nenhum' },
  'Analista Contábil': { carteira: 'ver', obrig: 'editar', guias: 'ver', docs: 'editar', chat: 'editar', fiscal: 'ver', cert: 'ver', cofre: 'ver', dem: 'editar', hon: 'ver', equipe: 'nenhum', config: 'nenhum' },
  'Legalização': { carteira: 'editar', obrig: 'editar', guias: 'ver', docs: 'editar', chat: 'editar', fiscal: 'editar', cert: 'editar', cofre: 'editar', dem: 'editar', hon: 'nenhum', equipe: 'nenhum', config: 'nenhum' },
};
export const FUNCAO_PADRAO = 'Analista Fiscal';

// Coleção do app → módulo que a governa (para leitura e gravação da equipe)
export const MODULO_DA_COLECAO = {
  empresas: 'carteira', leads: 'carteira',
  catalogo: 'obrig', regimes: 'obrig', obrigacoes: 'obrig', fechamentos: 'obrig',
  guias: 'guias', faturamento: 'guias', despesas: 'guias', lancamentos: 'guias', notas: 'guias', tomadores: 'guias', servicos: 'guias',
  documentos: 'docs', checklist: 'docs', docsinternos: 'docs',
  conversas: 'chat',
  cnds: 'fiscal', ecac: 'fiscal',
  certificados: 'cert',
  tickets: 'dem', admissoes: 'dem', funcionarios: 'dem', folhas: 'dem',
  faturas: 'hon',
  config: 'config', operadores: 'config',
};
// Sempre legíveis pela equipe (nomes de empresas, dados do escritório, catálogo usado nas telas)
export const SEMPRE_LEGIVEIS = new Set(['empresas', 'config', 'operadores', 'catalogo', 'regimes', 'auditoria']);

// Padrões das funções deste escritório: o que o master salvou por cima do padrão do código
export function funcoesDoEscritorio(personalizadas) {
  const out = {};
  for (const [nome, base] of Object.entries(FUNCOES)) {
    const p = nome !== 'Master' && personalizadas && typeof personalizadas[nome] === 'object' ? personalizadas[nome] : {};
    out[nome] = Object.fromEntries(MODULOS.map(([m]) => [m, NIVEIS.includes(p[m]) ? p[m] : base[m]]));
  }
  return out;
}

export function permissoesEfetivas(u, funcoesEsc) {
  if (u.ambiente !== 'equipe') return {};
  if (u.papel === 'master') return { ...FUNCOES.Master };
  const todas = funcoesEsc || funcoesDoEscritorio(u.funcoes_escritorio);
  const base = todas[u.funcao] || todas[FUNCAO_PADRAO];
  const ajustes = u.permissoes && typeof u.permissoes === 'object' ? u.permissoes : {};
  const out = {};
  for (const [m] of MODULOS) out[m] = NIVEIS.includes(ajustes[m]) ? ajustes[m] : base[m];
  return out;
}
export const pode = (u, modulo, nivel = 'ver') => {
  if (u.ambiente !== 'equipe') return false;
  const p = (u.perm || permissoesEfetivas(u))[modulo] || 'nenhum';
  return (RANK[p] || 0) >= (RANK[nivel] || 1);
};
export function limparPermissoes(obj) {
  const out = {};
  if (obj && typeof obj === 'object') for (const [m] of MODULOS) if (NIVEIS.includes(obj[m])) out[m] = obj[m];
  return out;
}
