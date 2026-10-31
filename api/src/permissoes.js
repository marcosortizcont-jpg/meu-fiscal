// Funções da equipe e permissões por módulo do Painel Contábil.
// Cada módulo tem um nível: 'nenhum' (não vê), 'ver' (só consulta) ou 'editar'.
// O master tem tudo; para os demais, a função traz um padrão que o master pode ajustar pessoa a pessoa.

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
export const NIVEIS = ['nenhum', 'ver', 'editar'];

export const FUNCOES = {
  'Master': Object.fromEntries(MODULOS.map(([m]) => [m, 'editar'])),
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
  guias: 'guias', faturamento: 'guias', despesas: 'guias', notas: 'guias', tomadores: 'guias', servicos: 'guias',
  documentos: 'docs', checklist: 'docs',
  conversas: 'chat',
  cnds: 'fiscal', ecac: 'fiscal',
  certificados: 'cert',
  tickets: 'dem', admissoes: 'dem', funcionarios: 'dem', folhas: 'dem',
  faturas: 'hon',
  config: 'config', operadores: 'config',
};
// Sempre legíveis pela equipe (nomes de empresas, dados do escritório, catálogo usado nas telas)
export const SEMPRE_LEGIVEIS = new Set(['empresas', 'config', 'operadores', 'catalogo', 'regimes', 'auditoria']);

export function permissoesEfetivas(u) {
  if (u.ambiente !== 'equipe') return {};
  if (u.papel === 'master') return { ...FUNCOES.Master };
  const base = FUNCOES[u.funcao] || FUNCOES[FUNCAO_PADRAO];
  const ajustes = u.permissoes && typeof u.permissoes === 'object' ? u.permissoes : {};
  const out = {};
  for (const [m] of MODULOS) out[m] = NIVEIS.includes(ajustes[m]) ? ajustes[m] : base[m];
  return out;
}
export const pode = (u, modulo, nivel = 'ver') => {
  if (u.ambiente !== 'equipe') return false;
  const p = (u.perm || permissoesEfetivas(u))[modulo] || 'nenhum';
  return nivel === 'ver' ? p !== 'nenhum' : p === 'editar';
};
export function limparPermissoes(obj) {
  const out = {};
  if (obj && typeof obj === 'object') for (const [m] of MODULOS) if (NIVEIS.includes(obj[m])) out[m] = obj[m];
  return out;
}
