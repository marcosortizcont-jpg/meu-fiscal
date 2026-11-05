// Catálogo de planos usado no contrato de prestação de serviços (serviços inclusos, limites e benefícios).
// Os textos de venda ficam em app/landing.config.json; aqui fica o que vai, com valor jurídico, para o contrato.
// Regras atuais: ligação só no Premium; atendimento prioritário do Profissional para cima;
// abertura de CNPJ e certificado digital A1 grátis só nos planos acima de R$ 450.

const COMUNS = [
  'Acesso ao portal do cliente Meu Fiscal (web e celular), com guias, documentos e relatórios organizados por competência',
  'Emissor de NFS-e integrado ao portal (a emissão das notas é feita pelo CONTRATANTE)',
  'Painel financeiro de receitas e despesas, com relatórios gerenciais do negócio',
  'Assistente virtual Théo, 24 horas, para dúvidas e solicitações',
  'Alertas de vencimento de guias, documentos e certificado digital',
];
const MEI = [
  'Emissão mensal da guia DAS-MEI e envio ao CONTRATANTE pelo portal, WhatsApp ou e-mail',
  'Elaboração e transmissão da Declaração Anual do Simples Nacional do MEI (DASN-SIMEI)',
  'Acompanhamento do limite anual de faturamento do MEI, com alerta de desenquadramento',
  'Orientação sobre obrigações do MEI e emissão da guia atualizada quando solicitado',
];
const BASE_EMPRESA = [
  'Escrituração contábil e elaboração das demonstrações contábeis exigidas pela legislação',
  'Escrituração fiscal e apuração mensal dos tributos do regime da empresa, com envio das guias',
  'Elaboração e transmissão das obrigações acessórias federais, estaduais e municipais de competência mensal e anual',
  'Cálculo do pró-labore dos sócios e respectivos encargos',
];
const ATEND_BASE = 'Atendimento por WhatsApp, chat e e-mail, em dias úteis, no horário comercial';
const ATEND_PRIOR = 'Atendimento prioritário por WhatsApp, chat e e-mail, com gerente de conta dedicado, das 8h às 21h em dias úteis';
const ATEND_PREMIUM = 'Atendimento prioritário por WhatsApp, chat, e-mail e ligação telefônica, com gerente de conta dedicado, das 8h às 21h em dias úteis';
const ABERTURA = 'Abertura do CNPJ (registro, inscrições e enquadramento), sem cobrança de honorários; taxas de órgãos públicos por conta do CONTRATANTE';
const CERT = 'Um certificado digital A1 (e-CNPJ) por ano de contrato, sem custo';

export const PLANOS = [
  { id: 'mei-servicos', nome: 'MEI Serviços', grupo: 'MEI', preco: 99.9, folha: 0, servicos: [...MEI, ...COMUNS, ATEND_BASE] },
  { id: 'mei-comercio', nome: 'MEI Comércio', grupo: 'MEI', preco: 159.9, folha: 0, servicos: [...MEI, 'Relatório mensal de receitas brutas (com e sem nota fiscal), conforme exigido do MEI', 'Controle das notas fiscais de compra e de venda de mercadorias', 'Orientação sobre ICMS e inscrição estadual', ...COMUNS, ATEND_BASE] },
  { id: 'essencial', nome: 'Essencial', grupo: 'Serviços', preco: 259, folha: 0, servicos: [...BASE_EMPRESA, ...COMUNS, ATEND_BASE] },
  { id: 'profissional', nome: 'Profissional', grupo: 'Serviços', preco: 450, folha: 5, servicos: [...BASE_EMPRESA, 'Folha de pagamento, eSocial e FGTS Digital de sócios e funcionários, até 5 pessoas', 'Importação de notas fiscais de serviço de qualquer município', ...COMUNS, ATEND_PRIOR] },
  { id: 'premium', nome: 'Premium', grupo: 'Serviços', preco: 700, folha: 10, servicos: [...BASE_EMPRESA, 'Folha de pagamento, eSocial e FGTS Digital de sócios e funcionários, até 10 colaboradores', 'Importação de notas fiscais de qualquer município, até 800 notas por mês', 'Importação e conciliação de extrato bancário de até 3 contas', ABERTURA, CERT, ...COMUNS, ATEND_PREMIUM] },
  { id: 'essencial-comercio', nome: 'Essencial Comércio', grupo: 'Comércio', preco: 359, folha: 3, servicos: [...BASE_EMPRESA, 'Apuração do ICMS e das obrigações estaduais', 'Folha de pagamento, eSocial e FGTS Digital de sócios e funcionários, até 3 pessoas', ...COMUNS, ATEND_BASE] },
  { id: 'profissional-comercio', nome: 'Profissional Comércio', grupo: 'Comércio', preco: 550, folha: 5, servicos: [...BASE_EMPRESA, 'Apuração do ICMS e das obrigações estaduais', 'Folha de pagamento, eSocial e FGTS Digital de sócios e funcionários, até 5 pessoas', 'Importação de notas fiscais de qualquer município', 'Declaração anual de Imposto de Renda Pessoa Física de um sócio', ABERTURA, CERT, ...COMUNS, ATEND_PRIOR] },
  { id: 'premium-comercio', nome: 'Premium Comércio', grupo: 'Comércio', preco: 900, folha: 10, servicos: [...BASE_EMPRESA, 'Apuração do ICMS e das obrigações estaduais', 'Folha de pagamento, eSocial e FGTS Digital de sócios e funcionários, até 10 colaboradores', 'Importação de notas fiscais de qualquer município', 'Importação e conciliação de extrato bancário de até 3 contas', 'Declaração anual de Imposto de Renda Pessoa Física de um sócio', ABERTURA, CERT, ...COMUNS, ATEND_PREMIUM] },
];

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// acha o plano pelo nome (ou id); planos sob medida ou antigos caem no mais parecido pelo tipo de empresa
export function planoDe(nome, regime) {
  const n = norm(nome);
  const p = PLANOS.find(x => norm(x.nome) === n || x.id === n);
  if (p) return p;
  if (regime === 'MEI' || /\bmei\b/.test(n)) return { ...PLANOS[/comerc/.test(n) ? 1 : 0], nome: nome || PLANOS[0].nome, sobMedida: true };
  const com = /comerc/.test(n); const nivel = /plus|premium/.test(n) ? 2 : /unique|profiss/.test(n) ? 1 : 0;
  const base = PLANOS.filter(x => x.grupo === (com ? 'Comércio' : 'Serviços'))[nivel];
  return { ...base, nome: nome || base.nome, sobMedida: true };
}
