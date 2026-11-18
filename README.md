# Meu Fiscal · dois sites, uma API

```
meufiscal-cliente.vercel.app ─┐  /api/* (proxy da Vercel, mesmo domínio)
                              ├──────────────► meufiscal-api.onrender.com ──► PostgreSQL (Neon)
meufiscal-painel.vercel.app ──┘  SSE direto (CORS estrito) ◄── LISTEN/NOTIFY ──┘
                                        │
                                        └──► arquivos: Cloudflare R2 (URL pré-assinada)
```

| Peça | Onde roda (grátis) | Pasta |
|---|---|---|
| Site 1 · Portal do Cliente | Vercel (ou Netlify) | `sites/cliente` |
| Site 2 · Painel Contábil | Vercel (ou Netlify) | `sites/painel` |
| API única | Render (Web Service free) | `api` |
| Banco | Neon (PostgreSQL free) | `api/db/schema.sql` |
| Arquivos (XML, PDFs, comprovantes) | No próprio banco nesta fase (até 4 MB cada); depois Neon Object Storage ou Cloudflare R2 | — |

Os dois sites são gerados do mesmo app (`app/app.html`). Cada build fixa o site (`cliente` ou `painel`) e a URL da API. Não há dependências npm em nenhuma das partes: só Node 20+.

### Serviços prestados e tomados (NFS-e, todos os regimes)

O menu Movimento do fiscal ganhou duas telas: **Serviços prestados** (`#f-nfse-p`) e **Serviços tomados** (`#f-nfse-t`). Elas aceitam XML de NFS-e do padrão nacional e do ABRASF, avulso ou em ZIP, inclusive de vários clientes no mesmo arquivo.

- **Prestada** (o cliente é o prestador): vai para as notas de saída e gera a receita do regime.
- **Tomada** (o cliente é o tomador): vira um lançamento de serviço tomado (`lancfiscais`, `id tom-…`). Leva as retenções da nota: ISS, INSS, IRRF, PIS, Cofins e CSLL. O acumulador é 201, ou 202 quando há INSS. Assim entra na EFD-Reinf (R-2010/R-4020), na DCTFWeb e nos livros.
- Retenções federais destacadas nas NFS-e prestadas entram em `retSofridas`, que é usado nas apurações do Lucro Presumido e do Lucro Real.
- **Buscar na Receita:** consulta o Ambiente de Dados Nacional (ADN) com o certificado A1 da empresa e traz as notas emitidas e as recebidas.
- **Automático:** liga a busca por empresa (`capturaAuto`). Ela roda sem abrir janela quando o fiscal está aberto: 20 s depois de abrir e a cada 30 min, no máximo uma vez a cada 6 h por empresa.
- "Notas fiscais de saída" passou a abrir para todos os regimes.

### DARF pelo SICALC (Lucro Presumido e Real)

Em **Lucro Presumido e Real → Guias geradas**, cada guia de PIS, Cofins, IRPJ e CSLL tem **Emitir**, e há um botão para emitir todas de uma vez. A emissão usa o serviço SICALC do Integra Contador (`CONSOLIDARGERARDARF51`, rota `POST /api/integra/darf`), sem o captcha do SICALC Web.

- O DARF oficial em PDF fica anexado à guia, que vai para "Guias e impostos" do portal (opcional) e pode ser enviada por WhatsApp e e-mail.
- Guia vencida sai com multa e juros até a data de pagamento escolhida. Com data anterior ao vencimento, sai o DARF normal.
- **Quotas:** IRPJ e CSLL trimestrais a partir de R$ 2 mil podem ser divididos em até 3 quotas (mínimo R$ 1 mil cada), e cada quota tem o seu DARF.
- O município vai pelo código SIAFI (Campo Grande/MS = 9051 já vem preenchido). O código digitado fica salvo no cadastro.
- ICMS e ISS não saem pelo SICALC: são guias estaduais e municipais.
- **A confirmar na primeira chamada real** (o Integra estava inativo quando foi escrito): o formato de `dataPA` nos trimestrais e o campo `cota`. Os dois ficam em `pedidoSicalc()`, no `api/src/integra.js`. Com `INTEGRA_FALSO=1` a emissão é simulada.

### Livros e relatórios (todos os regimes)

A tela **Livros e relatórios** do fiscal (`#f-rel`) abre para qualquer empresa e mostra só o que vale para o regime dela. Usa o período de/até do topo; tudo sai em tela, planilha (CSV) ou PDF com cabeçalho da empresa e assinaturas.

- **Livros fiscais:** Registro de Saídas, Registro de Entradas, Registro de Apuração do ICMS (P9, só LP/LR com IE), Serviços Prestados (ISS) e Serviços Tomados. Opção de termos de abertura e encerramento no PDF.
- **Apurações:** Simples Nacional (DAS por tributo), PIS e Cofins (cumulativo, não cumulativo ou partilha do DAS), IRPJ e CSLL (trimestral, estimativa ou partilha do DAS), ISS, ICMS DIFAL e antecipação, base do PGDAS-D.
- **Faturamento:** mensal com acumulado no ano, relação dos 12 meses com declaração assinada, por cliente, por dia e por modelo.
- **Movimento:** entradas × saídas por mês, por CFOP, compras por fornecedor, resumos por CFOP/CST/NCM, itens e lançamentos por acumulador.
- **Impostos:** guias pagas e a pagar (com código do DARF), resumo por tributo e retenções.

No painel, a aba de relatórios do Simples usa a mesma tela.

### Regimes do lucro e encargos patronais

- Regimes **Lucro Presumido C/ IE, LP S/ IE, Lucro Real C/ IE e LR S/ IE** (`reg2-lp-*`, `reg2-lr-*`), com pacote de obrigações: contabilidade, eSocial, DCTFWeb, FGTS, Reinf, PIS/COFINS, EFD-Contribuições, IRPJ/CSLL, ECD, ECF, ISS próprio e, com IE, ICMS próprio e EFD ICMS/IPI. Catálogo ganhou ICMS próprio, ISS próprio e DeSTDA (no pacote do SN C/ IE). Migração única (`config.regimesV3`) cria os regimes e remapeia as empresas LP/LR; empresas sem regime válido voltam ao regime do cadastro.
- No fiscal, empresa "S/ IE" não apura ICMS próprio nem gera EFD ICMS/IPI.
- No DP, "Configurar FPAS, RAT e FAP": CPP 20% (22,5% instituição financeira), RAT × FAP e terceiros pelo FPAS (515, 507, 612, 566, 736 ou total informado), com o detalhamento na folha.

### Escrita fiscal: Lucro Presumido/Real, ICMS, arquivos, IBS/CBS e captura

- **Documentos do cliente na Central**: coluna com o que cada cliente enviou, "Cobrar N clientes agora" e **cobrança automática** (`config.docsAuto = {ativo, dias, hora}`), rodada pela API (`documentos.js`, a cada 30 min) para a competência anterior.
- **Lucro Presumido e Real** (`#f-lucro`): PIS/COFINS cumulativo (0,65%/3%) ou não cumulativo (1,65%/7,6% com créditos das entradas para revenda/insumo, sem o ICMS, e receitas financeiras 0,65%/4%), excluindo monofásico, exportação e o ICMS destacado (Tema 69); IRPJ/CSLL trimestral por presunção (com o acréscimo de 10% da LC 224/2025 sobre a receita acima de R$ 5 milhões no ano: IRPJ desde o 1º tri/2026, CSLL desde o 2º tri/2026, desligável por liminar), LR trimestral pelo resultado da Contabilidade com adições/exclusões/prejuízo (30%) ou estimativa mensal; ICMS próprio (débitos − créditos − saldo credor anterior) e ISS próprio. Gera guias PIS, COFINS, ICMS, ISS, IRPJ e CSLL com o código do DARF.
- **ICMS nas entradas** (`#f-icms`): destino de cada NF de compra (revenda, insumo, uso, ativo); DIFAL pela fórmula de base dupla da IN SAT/MS 4/2023 (alíquota interna configurável, 17% padrão; interestadual pela nota ou pela regra do art. 9º quando o fornecedor é do Simples); antecipação configurável; guia ICMS-DIFAL. **DeSTDA** (Ato COTEPE 47/2015) para o Simples.
- **Arquivos** (`#f-arq`): EFD ICMS/IPI (leiaute 020: 0000/0005/0100/0150/0190/0200, C100/C170/C190, E110/E116), EFD-Contribuições (cumulativo em F550; não cumulativo em F100 com M100/M105/M500/M505) e EFD-Reinf (R-2010, R-4020, R-2099, R-4099 em XML para assinar). Sempre validar no PVA.
- **IBS/CBS** (`#f-ibs`): lê o grupo IBSCBS das NF-e e confere obrigatoriedade (regime normal desde 03/08/2026; Simples a partir de 2027), alíquotas de 2026 (CBS 0,9%, IBS UF 0,1%, municipal 0) e valores.
- **Captura** (`api/src/captura.js`): NFS-e emitidas pelo ADN (`/contribuintes/DFe/{NSU}`, mTLS com o A1) e situação das NF-e/NFC-e no NFeConsultaProtocolo4; o XML entra pela mesma importação (travas, retenções). `CAPTURA_FALSO=1` simula localmente.

### Escrita fiscal: proteções e atalhos do analista

- **Competência travada** (encerrada ou com DAS liberado/pago): notas e cancelamentos que chegam depois ficam **retidos** (guardados, fora da receita) até o analista decidir "Incluir" (soma à receita e a guia aparece como divergente) ou "Descartar". Lançamento manual em mês travado pede confirmação.
- **Receita informada nunca é sobrescrita** pelas notas (`faturamento.origem` ≠ `lancamentos`); se diferir da soma das notas no mês em apuração, a geração da guia é bloqueada até escolher "Usar as notas" ou ajustar.
- **RBT12 incompleto bloqueia a apuração**: botão "Informar histórico" com colagem do extrato do PGDAS-D (preenche os 12 meses), data de abertura e FS12.
- **Guia liberada ou paga com valor diferente** da apuração atual aparece como divergente (crítico) na Central e na tela.
- **Importação multiempresa**: um ZIP com notas de vários clientes distribui cada nota pelo CNPJ; cancelamento que chega antes da nota fica guardado (`empresas.cancPend`) e é aplicado quando a nota chega; nota entre dois clientes vira saída de um e entrada do outro. Resumo por empresa e mês, com números faltando.
- **Guarda do XML original**: ZIP por empresa e competência (até ~3,5 MB cada) em `arquivos`; "Baixar XML do período" monta um ZIP com os originais.
- **Números faltando** por modelo/série (continua do último número do mês anterior), com "Estão inutilizados".
- **Busca de notas** em todas as empresas (Ctrl+K): número, chave, participante ou CNPJ.
- **Lançamento duplicado**: avisa número repetido e nota que já entrou por XML.
- **PDFs das guias em lote** na Central: casa pelo CNPJ no nome do arquivo ou dentro do PDF e libera as que batem com a apuração.
- A Central mostra todas as empresas (filtro por regime, incluindo Lucro Presumido e Real).

### Fechamento da folha (DP)

- "Fechar folha" fica ao lado de "Calcular" (na tela da folha e no card de competência) e pede confirmação com o resumo: líquido, guias e pendências críticas (estas exigem marcar "Conferi").
- Ao fechar, gera em rascunho no módulo de Guias (origem `folha`): **FGTS Digital (GFD)** e **DARF DCTFWeb** (INSS segurados + patronal − salário-família + IRRF, que desde mai/2023 vai na DCTFWeb). Vencimento dia 20, antecipado se não for dia útil. Fechar de novo atualiza os rascunhos; guias já liberadas/pagas não são alteradas.
- "Enviar ao eSocial" põe S-1200, S-1210, S-1299 e a DCTFWeb na fila de transmissão (`dpfolhas.transmissao`). A transmissão automática depende do certificado / Integra Contador; até lá há o botão "Já transmiti por fora".
- Demonstrativo das guias em PDF.

### API em domínio próprio

Os sites repassam `/api/*` para **https://api.omeufiscal.com.br** (domínio próprio no Render; CNAME `api` → `meufiscal-api.onrender.com` no Cloudflare, *DNS only*). O endereço `*.onrender.com` passou a exigir verificação "Confirme que é humano" (HTTP 429) para as chamadas vindas dos Workers, o que derrubava o login.

## Como os dois sites ficam separados e seguros

1. **Cookie próprio por domínio.** Cada site chama `/api/*` no próprio domínio e a hospedagem faz o proxy até a API. Assim o cookie de sessão (`client_session` no portal, `admin_session` no painel) é de primeira parte, `HttpOnly`, `Secure` e `SameSite`. Isso funciona mesmo em navegadores que bloqueiam cookies de terceiros (Safari, Chrome).
2. **Dois segredos, duas audiências.** O token do portal é assinado com `JWT_SECRET_CLIENTE`; o do painel com `JWT_SECRET_PAINEL`. Copiar ou renomear um cookie não abre o outro ambiente.
3. **A conta tem ambiente.** Cliente com a senha certa no painel recebe: *"Este ambiente é exclusivo da equipe interna da contabilidade."* Colaborador no portal recebe o aviso inverso. Quem erra a senha só vê "E-mail ou senha incorretos".
4. **Rotas.** No portal, `/admin` e `/admin/*` redirecionam para `/login` (regra no `vercel.json`, antes de qualquer página). No painel, sem sessão de equipe, tudo volta para `/admin/login`, e a API recusa qualquer chamada.
5. **Isolamento entre clientes (multitenant).** Toda linha carrega `escritorio_id`, e quem decide o que cada um vê é a API (`api/src/regras.js`), nunca o navegador:
   - o cliente recebe só as empresas liberadas para ele. Guias em rascunho, a auditoria e a lista de operadores não chegam ao portal.
   - nas guias, faturas e na própria empresa, o cliente altera **campo a campo** só o que o portal permite: informar pagamento ou trocar a forma de pagamento. Valor, vencimento, regime e o status "paga" são do escritório.
   - o valor da renovação do certificado é conferido contra a configuração do escritório.
6. **CORS estrito.** A API responde `Access-Control-Allow-Origin` só para os domínios de `ORIGENS_CLIENTE` e `ORIGENS_PAINEL` (nunca `*`). Toda escrita exige o cabeçalho `X-MF-Site` e uma origem conhecida, o que bloqueia CSRF. O portal não consegue falar com a API "como painel": a origem é conferida contra o site.
7. **Cabeçalhos de segurança** em cada site: CSP, `X-Frame-Options: DENY`, `nosniff` e `Referrer-Policy`. O painel também leva `noindex`.

## Módulos do Painel Contábil

- **Equipe e permissões** (só o master altera): funções Master, Analista Fiscal, Analista de DP, Analista Contábil e Legalização. Cada função tem um padrão por módulo (sem acesso, consultar, editar), que o master ajusta pessoa a pessoa. O master também cria contas já com senha, redefine senhas e desativa colaboradores; as sessões abertas dessa pessoa caem na hora. A API confere as permissões em cada leitura e gravação (`api/src/permissoes.js`).
- **Carteira 360°** (toque no nome da empresa), em cinco abas:
  - **Dados gerais e acesso:** cadastro completo (inscrições estadual e municipal, endereço, sócios e contatos) e criação do acesso do cliente ao portal, com senha inicial de 8 caracteres ou convite por link.
  - **Certificado digital:** o .pfx e a senha ficam cifrados. A API confere a senha, lê titular, CNPJ e validade do próprio certificado e alimenta os alertas de 30, 15 e 7 dias.
  - **Cofre de senhas:** portais como Prefeitura/NFS-e, SEFAZ, e-CAC, FGTS Digital, Junta Comercial e SIMEI. Toda senha revelada fica registrada com o nome de quem viu.
  - **Responsáveis:** quem cuida da empresa no Fiscal, no Pessoal, no Contábil e na Legalização. As obrigações geradas já saem atribuídas a essas pessoas.
  - **Obrigações vinculadas:** o pacote que vem do regime, mais as obrigações avulsas e as retiradas só daquela empresa.
- **Motor de obrigações** (Obrigações › Catálogo e Regimes):
  - Cada obrigação tem recorrência (mensal, trimestral, anual ou eventual), regra de vencimento (dia fixo, n-ésimo dia útil ou último dia útil, com antecipação ou prorrogação), condição (por exemplo, só com funcionários) e alocação em lote para regimes ou empresas.
  - Ao cadastrar uma empresa, o regime escolhido vincula o pacote inteiro e gera as obrigações do mês.
  - O botão **Criar catálogo e regimes padrão** traz 16 obrigações e 8 regimes (MEI, Simples Anexos I a V, Lucro Presumido e Real). Confira os prazos estaduais, como o da EFD ICMS/IPI.
- **Celular:** o menu vira uma gaveta lateral (80% da tela), aberta pelo botão ☰, com fundo desfocado. Ela fecha ao tocar fora, ao escolher um item ou com Esc.

### Novidades: atendimento, permissões e controle de obrigações

- **Permissões por função:** em Equipe e permissões › Permissões por função, o master marca para cada tipo de acesso o que a pessoa pode **visualizar**, **editar** e **excluir** em cada módulo. Excluir exige o nível "excluir" também na API.
- **Excluir cliente:** só o master, na Carteira (lista ou cadastro), sempre digitando a própria senha. Apaga cadastro, guias, notas, documentos, arquivos, conversas, certificado, cofre e os acessos de cliente que só serviam àquela empresa. Fica registrado em Acessos e segredos.
- **Carteira:** pesquisa e filtros por regime, responsável, **grupo de empresas** (campo novo no cadastro) e situação.
- **Documentos e Certificado digital** saíram do menu e ficam no cadastro de cada cliente, com botão **Ativar/Desativar**. Desativado, o cliente não vê o recurso no portal e os alertas somem.
- **Controle de obrigações** (antiga Apuração e guias): lista única de obrigações e guias com pesquisa, filtros (cliente, imposto, competência, vencimento, situação, responsável, departamento) e **Imprimir / salvar PDF**. A apuração do DAS continua na segunda aba. O antigo menu Obrigações agora se chama **Matriz e catálogo**.
- **Atendimento único:** conversas do portal e do WhatsApp na mesma caixa, com filtros (aguardando, comigo, copiloto, WhatsApp) e busca. O copiloto responde primeiro e passa para a equipe quando a pergunta exige análise ou quando o cliente pede um atendente.

- **Gestão de obrigações** (Controle de obrigações › Gestão de obrigações): filtros por situação (pendentes, justificadas, entregues, dispensadas), competência, prazo técnico, prazo legal e data de entrega, etiquetas de obrigação/responsável/departamento/cliente e ordenação por coluna. Ao abrir uma obrigação: protocolo de entrega, anexos, envio ao cliente (Portal, e-mail e WhatsApp), prazo técnico, responsável, comentários, justificativa/dispensa e histórico completo. Ações em lote, exportação CSV e impressão. O prazo técnico padrão de cada obrigação fica no catálogo ("dias antes do vencimento legal"). E-mail exige `RESEND_API_KEY` no Render.
- **Obrigações a partir do cadastro:** tudo o que está em "Obrigações vinculadas" de cada empresa (pacote do regime + avulsas, inclusive parcelamentos federal, Simples, PGFN, estadual e municipal) aparece no Controle de obrigações em todas as competências, desde "Controlar obrigações a partir da competência", com vencimento legal e prazo técnico. Não precisa gerar matriz. "Remover" dispensa só a partir da competência escolhida; as anteriores ficam. Ao anexar o PDF e salvar, a guia entra em "Guias e impostos" do mês no portal.
- **Regimes:** MEI, Simples Nacional S/ Inscrição Estadual, Simples Nacional C/ Inscrição Estadual e Outros. A troca dos regimes antigos acontece sozinha na primeira vez que o master abre o painel (empresas de Lucro Presumido/Real vão para Outros com as obrigações que já tinham como avulsas).
- **Exclusão de documentos com senha:** na aba Documentos do cadastro, quem tem permissão de excluir confirma com a própria senha. O arquivo é apagado e a exclusão vai para o histórico.
- **Histórico de alterações (só master):** aba no cadastro de cada empresa com tudo o que foi incluído, alterado, excluído ou consultado (campo a campo: de → para), com usuário, data, hora e IP. Em Equipe e permissões, o botão Histórico mostra o que cada pessoa alterou.
- **Documentos para a equipe:** no cadastro do cliente, aba Documentos, anexe arquivos com nome e departamento (ou todos). Só a equipe vê, a menos que marque "mostrar no portal".
- **Gestão do negócio (portal do cliente):** o próprio cliente lança receitas e despesas com categoria, cliente/fornecedor, forma de pagamento, situação (pago/pendente), vencimento, repetição mensal e comprovante. Abas: Visão geral (resultado, margem, a receber, a pagar, gráfico mensal, receitas por categoria, maiores gastos, principais clientes e fornecedores, alertas), Receitas, Despesas, Consolidação (DRE simplificada por mês, exportável) e Indicadores fiscais.

- **Atendimento:** a IA se chama **Théo**. Na conversa (portal e painel) dá para enviar e receber arquivos, fotos, áudios (gravados no microfone ou anexados) e emojis; imagens, áudios e vídeos aparecem na própria conversa. As mensagens mostram o primeiro nome do cliente e do atendente. Áudios do cliente vão direto para a equipe (o Théo ainda não ouve áudio). A aba **Histórico de atendimentos** filtra por cliente, canal, atendente, situação, período e competência, com exportação.

- **Meu perfil (portal e painel):** no menu e no rodapé. A pessoa troca o próprio nome e a senha (pede a senha atual; as outras sessões abertas são encerradas). E-mail de login e telefone aparecem bloqueados: o botão "Solicitar alteração" abre uma demanda para o escritório. O escritório altera e-mail e telefone em Equipe e permissões › Editar (colaborador) ou no cadastro do cliente › Acesso ao portal › Editar dados.
- **Salvar e fechar:** no cadastro do cliente, nas demandas e nas janelas com "Salvar", depois de salvar a tela fecha e aparece a confirmação em verde.
- **Receita bruta da competência (obrigação mensal de todos os clientes):** criada sozinha no catálogo e no pacote dos 4 regimes, com o mesmo vencimento e prazo técnico da PGDAS-D, a partir do mês anterior à atualização. No Controle de obrigações, abra a obrigação, informe a receita bruta do mês (a mesma declarada no PGDAS-D; sem movimento = 0) e salve. O valor vira o faturamento do mês do cliente: portal, BI (Visão geral e Indicadores fiscais), RBT12, alíquota estimada e respostas do Théo. Entregar em lote ou pelo atalho de situação não vale para ela sem o valor.
- **Regras do atendimento (Atendimento › Regras do atendimento, master ou quem edita Configurações):**
  - **Triagem pelo Théo:** conversa que vai para a equipe sem setor definido é lida pelo Théo, que encaminha para Fiscal, Pessoal, Contábil, Legalização, Financeiro ou Comercial. Sem IA, usa palavras-chave; se não der para saber o assunto, fica na Triagem (recepção).
  - **Cada atendente vê só o próprio setor:** em Equipe e permissões › Editar, marque os departamentos da pessoa (pode ser mais de um, ou "Todos os setores"). A API só entrega as conversas desses setores, mais as que estão com a pessoa ou foram transferidas para ela. O master vê tudo.
  - **Devolução por inatividade:** se o cliente está esperando e o atendente fica X minutos sem responder (padrão 30), a conversa volta para a fila do setor (ou da Triagem), com todo o histórico e uma nota interna.
  - **Etiquetas automáticas:** cada atendimento mostra os departamentos por onde passou e o nome de quem atendeu.
- **Contatos (Atendimento › Contatos):** cada contato tem WhatsApp, e-mail, cargo, as empresas pelas quais responde (a primeira é a principal), o atendente responsável e se recebe guias pelo WhatsApp e/ou e-mail. Botões para iniciar o atendimento pelo WhatsApp do escritório, pelo portal ou por e-mail; "Importar dos cadastros" traz os contatos e telefones já cadastrados nas empresas. Conversas de WhatsApp de números salvos já chegam com a empresa e o atendente certos.
- **Guias pelo WhatsApp:** no Controle de obrigações, ao escolher "Portal + WhatsApp", a guia vai para todos os contatos vinculados à empresa que recebem pelo WhatsApp (o detalhe da obrigação mostra para quem vai). Sem contato, usa o telefone do cadastro. O envio fica registrado na conversa daquele contato.
- **CRM comercial (departamento Comercial):** funil em kanban (Novos leads, Primeiro contato, Proposta enviada, Negociação, Ganhos, Perdidos) com arrastar e soltar, indicadores (em aberto, ganhos no mês, conversão, ações atrasadas), filtros, lista e exportação CSV. Ao abrir um lead: dados da empresa, plano e valor, responsável, próxima ação com data, linha do tempo de movimentações (ligação, WhatsApp, e-mail, reunião, proposta), WhatsApp direto e "Cadastrar como cliente" (o cadastro abre preenchido e o lead vira ganho). Perdido sempre pede o motivo. A função **Comercial** em Equipe e permissões dá acesso ao CRM.

- **Clientes, fornecedores e prestadores (Gestão do negócio › Clientes e fornecedores):** o cliente cadastra cada um com CPF/CNPJ (validado, sem repetir), apelido, contato e categoria padrão de receita/despesa. Sem CPF/CNPJ só com a opção "Cadastrar sem CPF/CNPJ" marcada. Ao lançar, o campo sugere os cadastros a partir do primeiro nome (ou do CPF/CNPJ) digitado; nome novo abre o cadastro rápido ali mesmo, e o lançamento só salva com o cadastro feito. Receitas, despesas e o B.I. (principais clientes, fornecedores, % das receitas) agrupam pelo cadastro. "Trazer dos lançamentos e notas" cria os cadastros a partir do que já foi lançado e dos tomadores da NFS-e.
### Financeiro (honorários)
Menu **Financeiro** (antigo Honorários), com quatro abas:
- **Visão geral**: faturado e recebido no mês, a vencer, em atraso, inadimplência dos últimos 3 meses, gráfico de 12 meses, atraso por faixa e maiores devedores.
- **Cobranças**: mensalidades por competência e situação; gerar mensalidades (plano + funcionários excedentes + serviços avulsos concluídos), emitir boletos, enviar/cobrar por WhatsApp e e-mail (individual ou em lote), baixa manual, editar vencimento/desconto/itens, cancelar e histórico de envios de cada fatura.
- **Inadimplência**: clientes em atraso com total, faturas, maior atraso e última cobrança; botão Cobrar (ou Cobrar todos) e controle de bloqueio: bloquear agora, liberar por alguns dias, isentar ou voltar à regra automática.
- **Régua e automação**: geração automática no dia escolhido, vencimento padrão (ou o dia do plano do cliente), multa e juros, envio do boleto ao gerar, lembrete antes do vencimento, aviso no dia, etapas de cobrança após o vencimento (dias, canais e mensagem de cada uma) e bloqueio do portal por dias de atraso. Roda uma vez por dia no horário escolhido; cada etapa sai uma única vez por fatura.

**Banco (boleto + PIX com baixa automática): Banco Inter.** Todas as cobranças (mensalidades, régua e ativação de cadastros) saem como **boleto com QR Code PIX** (Bolepix, API Cobrança v3 do Inter, com certificado mTLS). Não há cartão.
1. No **Internet Banking PJ do Inter** (no computador): **Soluções para sua empresa › Nova integração**. Dê um nome e marque as permissões de **Boleto com PIX / Cobrança** (emitir/escrita e consultar/leitura).
2. Baixe o **certificado (.crt)** e a **chave (.key)** e copie o **Client ID** e o **Client Secret**. Eles valem 1 ano: renove antes de vencer e envie os novos pelo painel.
3. No painel, master: **Financeiro › Régua e automação › Banco**: Banco Inter, Produção, preencha Client ID e Secret, envie os dois arquivos e salve (tudo fica cifrado no cofre, com a COFRE_CHAVE). "Conta corrente" só se a integração tiver mais de uma conta.
4. Clique em **Testar conexão**: além de testar, o sistema cadastra no Inter o **aviso de pagamento (webhook)** com uma URL que tem um código secreto. O Inter não assina os avisos, por isso cada aviso só diz qual cobrança olhar: o servidor consulta a situação no próprio Inter antes de dar baixa.
5. Os boletos exigem o **endereço completo** do cliente (CEP, rua, município, UF): o cadastro novo já pede; complete os antigos antes de emitir.
"Conferir pagamentos no banco" consulta os boletos em aberto, caso algum aviso não tenha chegado. Baixa manual ou cancelamento de uma fatura também cancela o boleto no Inter, para o cliente não pagar duas vezes. Sem banco, anexe o PDF do boleto em cada fatura e o cliente paga pela chave PIX do escritório. No portal, o cliente vê linha digitável, PIX copia e cola e o PDF. (O Asaas continua aceito só para quem já usava.)

- **Envio e recebimento de documentos**:
  - No cadastro do cliente, aba **Envio de documentos**: documentos recorrentes (formatos, instruções, todo mês / trimestral / anual / meses escolhidos, prazo, departamento, obrigatório, vários arquivos, "não tive movimento"), modelos prontos e **solicitações avulsas** para competências específicas (com aviso ao cliente por WhatsApp e e-mail). Grade dos últimos 6 meses.
  - No portal, **Envio mensal** mostra o que é pedido no mês, prazo, motivo de negativa e pedido de complemento (o cliente envia só o que falta; o que já mandou fica guardado).
  - No painel, **Recebimento de documentos**: fila por documento ou por cliente, filtros (competência, situação, departamento, responsável), indicadores, análise com Aprovar, Pedir complemento, Negar, Dispensar no mês e Reabrir, histórico, baixar arquivos, anexar pela equipe e cobrar quem não enviou. O fechamento do mês considera os documentos aprovados ou dispensados.
- **Atendimento por departamentos**: cada conversa tem departamento (Triagem, Fiscal, Pessoal, Contábil, Legalização, Financeiro, Comercial). Quando o Théo passa para a equipe, o assunto define o departamento. A caixa de entrada filtra por departamento (e "Meus", pela função de quem está logado), com contagem do que está aguardando. **Transferir**: para outro departamento (fila) ou direto para uma pessoa, com nota interna (o cliente não vê) e aviso opcional ao cliente no portal ou no WhatsApp. Quem recebe vê um aviso ao abrir o painel.
- **Théo comercial (CRM)**: em CRM comercial › "🤖 Théo", ligue para os leads do site. O Théo manda a primeira mensagem no WhatsApp em poucos minutos (dentro do horário comercial escolhido), personalizada com o nome, o plano e a situação (troca de contador ou abertura), sempre com a opção SAIR. Na conversa ele qualifica (atividade, regime, faturamento, funcionários, cidade, prioridade), responde sobre planos só com o texto configurado e passa para o Comercial quando o lead pede proposta, desconto, ligação ou está pronto. Tudo vai para a linha do tempo do lead, que avança para "Primeiro contato" na primeira resposta; a qualificação aparece no cartão. Também há o botão "Théo: enviar primeira mensagem agora" em cada lead.
- **Cadastro de clientes com ativação por pagamento**: "Novo cliente" (Carteira, ou "Cadastrar como cliente" no CRM; disponível para o Comercial e para quem edita a Carteira). O cadastro nasce **aguardando pagamento** e o servidor não deixa ativá-lo pelo navegador: ele só fica ativo quando o Banco Inter confirma o pagamento da 1ª mensalidade (aviso automático, conferido no banco) ou, na hora, com voucher de isenção. A cobrança é um boleto com PIX (vence em 3 dias); o cadastro pede o endereço completo, exigido no boleto. PIX copia e cola, linha digitável e PDF vão ao cliente por WhatsApp e e-mail; no cadastro pendente há Copiar PIX, Copiar linha, Boleto PDF, Reenviar, Verificar pagamento, Gerar nova cobrança e Cancelar. Enquanto pendente, não gera obrigações nem mensalidades. Ao pagar: empresa ativa, 1ª mensalidade registrada como paga no Financeiro e lead do CRM marcado como ganho.
- **Vouchers (Financeiro › Vouchers, só o master)**: código (próprio ou gerado), percentual, valor ou isenção total, quantidade de usos (ou ilimitado), por quantas mensalidades vale e validade. O uso é conferido e contado no servidor; dá para desativar e ver quem usou.
#### Copiloto com IA gratuita (Groq)
1. Entre em **console.groq.com** e crie a conta (Google ou e-mail). **Não pede cartão de crédito.**
2. Menu **API Keys** → **Create API Key** → dê um nome (ex.: Meu Fiscal) → copie a chave (começa com `gsk_`).
3. No Render: serviço **meufiscal-api** → **Environment** → **Add Environment Variable** → nome `GROQ_API_KEY`, valor = a chave → **Save**. Depois, **Manual Deploy → Deploy latest commit**.
4. Não cole a chave em chats nem no GitHub.

A camada gratuita da Groq tem limite de pedidos por minuto e por dia (quando estoura, a conversa vai para a equipe) e não usa as conversas para treinar modelos. Fotos são analisadas por um modelo com visão; se ele não estiver disponível, a equipe confere a imagem.
Alternativa: `GEMINI_API_KEY` (Google AI Studio, gratuito sem ativar faturamento). Se o Google pedir para ativar faturamento ou comprar créditos, não é necessário para a camada gratuita, e prefira a Groq.

#### Guias federais direto da Receita (Integra Contador)
Os portais da Receita têm captcha e não podem ser automatizados pelo navegador. O caminho oficial é a API **Integra Contador** (SERPRO/Receita), que emite em PDF: **DAS do MEI** (PGMEI), **DAS do Simples Nacional** (PGDAS-D, depois da declaração transmitida), **DARF da DCTFWeb** (depois da DCTFWeb transmitida) e **parcelas dos parcelamentos do Simples e do MEI** (PARCSN, PARCSN-ESP, PERTSN, RELPSN, PARCMEI, PARCMEI-ESP, PERTMEI, RELPMEI). Parcelamentos comuns da Receita e da PGFN (Regularize) não estão na API: continuam com o PDF anexado na obrigação.
1. Na **Loja Serpro**, contrate o Integra Contador com o CNPJ do escritório (cobrança por consulta/emissão).
2. Na Área do Cliente Serpro, copie **Consumer Key** e **Consumer Secret**.
3. Painel → **Configurações › Integração com a Receita**: CNPJ do escritório, Key, Secret e o **e-CNPJ A1 do escritório** (.pfx + senha, guardados cifrados) → **Testar conexão**.
4. Cada MEI dá **procuração eletrônica** ao CNPJ do escritório no e-CAC. Sem ela, a emissão daquela empresa falha e aparece no histórico.

Com isso:
- **Théo** (portal e WhatsApp): o cliente pede a guia, o Théo pergunta a competência e a data de pagamento (guia vencida sai atualizada, com data até o fim do mês), confirma e envia o PDF. A guia também entra em "Guias e impostos" e a obrigação DAS-MEI fica entregue. Se a Receita recusar, a conversa vai para a equipe.
- **Controle de obrigações**: nas obrigações DAS-MEI, PGDAS-D, DCTFWeb e Parcelamento do Simples, bloco "Emitir na Receita" (data de pagamento, programa do parcelamento e envio por WhatsApp/e-mail). Ali também se marca quem entra no envio automático (DAS e DCTFWeb por empresa; programas de parcelamento de cada empresa).
- **Envio automático mensal**, uma rotina por tipo (DAS-MEI, DAS do Simples, DCTFWeb e parcelas), cada uma com seu dia e horário, para as empresas marcadas, pelo portal + WhatsApp e/ou e-mail. Sai a competência anterior; guias pagas ou já enviadas são puladas; guia já emitida e ainda válida é reaproveitada (sem nova cobrança). Se o Render estiver dormindo no horário, o envio acontece quando ele acordar, até o dia 19.
- Tudo fica no **Histórico de emissões e envios** da mesma tela.

#### WhatsApp por QR code
1. No Render: **Settings → Build Command** = `npm install --omit=dev --no-audit --no-fund` e **Health Check Path** = `/api/vivo`. Depois, **Manual Deploy → Deploy latest commit**.
2. No Painel: **Atendimento → Conectar WhatsApp** e leia o QR code no celular do escritório (WhatsApp › Dispositivos conectados › Conectar dispositivo).
3. A sessão fica guardada no banco: deploys e reinícios reconectam sozinhos. Desconectar pelo celular encerra a sessão.

É uma conexão do tipo WhatsApp Web (biblioteca Baileys), **não oficial**: use um número do escritório, não faça envios em massa e saiba que o WhatsApp pode bloquear números que violam os termos dele. Com o WhatsApp conectado, a API chama a si mesma a cada 10 minutos para o Render gratuito não dormir (consome as 750 horas mensais do plano, suficientes para 1 serviço ligado o mês todo). Contatos são identificados pelo telefone da empresa ou dos contatos do cadastro; números desconhecidos podem ser vinculados a uma empresa ou registrados como interessados.

> **Chave do cofre (`COFRE_CHAVE`).** O Render gera a chave sozinho. Ela cifra os certificados e as senhas dos portais e **nunca pode ser trocada nem perdida**: sem ela, esses segredos ficam ilegíveis. Guarde uma cópia em local seguro: no Render, abra **Environment → COFRE_CHAVE → Reveal**.

## Sincronização em tempo real

1. O cliente envia um documento ou abre uma solicitação no Site 1. A API grava na tabela `registros`.
2. Um gatilho do PostgreSQL dispara `pg_notify('meufiscal', …)`. A API, que mantém um `LISTEN`, repassa o aviso por **Server-Sent Events** só para quem pode ver aquele registro.
3. O painel busca o registro atualizado e redesenha a tela. Medido no teste: **0,4 a 0,5 s** entre um site e o outro.
4. O contador libera a guia ou conclui a demanda no Site 2, e o mesmo caminho leva a mudança ao portal.

Proxies gratuitos cortam conexões longas, por isso o fluxo SSE vai direto ao domínio da API, autorizado por um ticket de 15 minutos obtido pelo proxy. Se a conexão cair (a API reiniciou ou o ticket venceu), o site mostra "Reconectando…". Ao voltar, ele baixa tudo de novo para não perder nada; no teste, levou 1 s.

## Passo a passo do deploy (tudo no plano gratuito)

### 1. Repositório
Suba esta pasta para um repositório no GitHub (pode ser privado).

### 2. Banco · Neon
1. Em neon.tech, crie o projeto `meufiscal`. Escolha a região São Paulo (`sa-east-1`) se estiver disponível.
2. Em **Connection details**, copie duas strings:
   - **Pooled connection** (o host tem `-pooler`): vai em `DATABASE_URL`.
   - **Direct connection** (sem `-pooler`): vai em `DATABASE_URL_DIRECT`. O tempo real (`LISTEN`) precisa dela.

Não precisa rodar nada no banco à mão: a API aplica `db/schema.sql` sozinha a cada início, e o schema é idempotente.

### 3. Arquivos (opcional nesta fase)
Na configuração inicial (`ARQUIVOS_DRIVER=banco`), os arquivos ficam no próprio PostgreSQL, com limite de 4 MB cada, e este passo pode ser pulado. Quando o volume crescer, migre para um armazenamento S3: troque para `ARQUIVOS_DRIVER=s3` e preencha as variáveis `S3_*`. Os arquivos antigos continuam abrindo, porque cada arquivo guarda onde foi salvo.

#### Usando Cloudflare R2
1. No painel da Cloudflare, abra **R2** e crie o bucket `meufiscal-arquivos`. A ativação do R2 pede um cartão, mas não há cobrança dentro da cota gratuita.
2. Em **R2 → Manage API tokens**, crie um token com permissão *Object Read & Write* só nesse bucket. Anote:
   - Access Key ID → `S3_ACCESS_KEY_ID`
   - Secret Access Key → `S3_SECRET_ACCESS_KEY`
   - endpoint `https://<ID-DA-CONTA>.r2.cloudflarestorage.com` → `S3_ENDPOINT`
3. No bucket, abra **Settings → CORS policy** e cole o conteúdo de `api/r2-cors.json`, já com os dois domínios finais.

### 4. API · Render
1. Em render.com, clique em **New → Blueprint** e escolha o repositório. O `render.yaml` da raiz cria o serviço `meufiscal-api` (plano free) e **gera os dois segredos JWT sozinho**.
2. Preencha as variáveis pedidas (modelo comentado em `api/.env.example`):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` / `DATABASE_URL_DIRECT` | as duas strings do Neon |
   | `ORIGENS_CLIENTE` | `https://meufiscal-cliente.vercel.app` |
   | `ORIGENS_PAINEL` | `https://meufiscal-painel.vercel.app` |
   | `URL_PUBLICA_API` | `https://meufiscal-api.onrender.com` (a URL que o Render mostrar) |
   | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | os dados do R2 |
   | `RESEND_API_KEY` (opcional) | para enviar convites e redefinição de senha por e-mail |
   | `ANTHROPIC_API_KEY` (opcional) | liga o Copiloto de IA |

3. Depois do deploy, abra `https://meufiscal-api.onrender.com/api/saude`. A resposta esperada é `{"ok":true,…}`.
4. Na aba **Shell** do serviço, crie o escritório e o primeiro master, e importe os dados atuais:
   ```bash
   npm run criar-master -- "Marcos Alexandre Ortiz · Contabilidade" "Marcos Alexandre Ortiz" seu@email.com.br
   npm run importar -- dados-atuais.json
   ```
   - O primeiro comando imprime um link `/admin/definir-senha?token=…` (vale 72 h) para você criar a senha.
   - O segundo carrega a carteira, guias, notas e configurações exportadas do app atual, incluindo CRC e chave PIX.

> A API não sobe com configuração insegura em produção. Ela recusa iniciar se faltar algo, se os dois segredos forem iguais, se alguma origem não for `https` ou se os arquivos estiverem configurados para gravar em disco.

### 5. Sites · Vercel (dois projetos do mesmo repositório)

1. Ajuste a URL da API nos dois sites, se for diferente de `https://meufiscal-api.onrender.com`. Edite `API_URL` em `sites/cliente/.env.production` e `sites/painel/.env.production`. Em `ARQUIVOS_HOST`, coloque o endpoint do R2.
2. Rode `--configurar` para regravar o `vercel.json` e o `netlify.toml` de cada site com a URL da API. A Vercel não lê variáveis dentro do `vercel.json`, por isso a URL fica gravada no arquivo.
   ```bash
   node sites/build.mjs cliente --configurar
   node sites/build.mjs painel  --configurar
   ```
   Faça commit.
3. Crie o primeiro projeto: Vercel → **Add New → Project** → importe o repositório.
   - **Project Name:** `meufiscal-cliente`
   - **Root Directory:** `sites/cliente`
   - **Framework Preset:** Other

   Build, saída e rotas vêm do `vercel.json`. Deixe ligada a opção *Include files outside the Root Directory* (vem ligada por padrão): o build lê o app em `../../app`.
4. Repita para o segundo projeto: **Project Name** `meufiscal-painel`, **Root Directory** `sites/painel`.
5. Se a Vercel der outra URL (por exemplo, um nome já ocupado), atualize `ORIGENS_*` no Render e o CORS do R2.

O build tem uma trava: se o proxy do `vercel.json` apontar para uma API diferente de `API_URL`, o deploy falha com a instrução de correção.

**Netlify em vez de Vercel:** crie o site com **Base directory** `sites/cliente` (e outro com `sites/painel`). O `netlify.toml` gerado já traz build, proxy `/api/*`, redirects e cabeçalhos.

### 6. Liberar o acesso dos clientes
1. No painel, abra **Acessos e equipe** (rodapé da barra lateral) e clique em **Liberar acesso de cliente**.
2. Preencha nome e e-mail e escolha as empresas, cada uma com um perfil: Sócio, Financeiro ou RH.
3. A pessoa recebe um link `/definir-senha` (72 h).
   - Com o Resend configurado, o link vai por e-mail.
   - Sem o Resend, o painel mostra o link para você copiar e mandar por WhatsApp.
4. Na mesma tela você cadastra colaboradores (só o master), reenvia convites, troca empresas e bloqueia acessos. O bloqueio derruba a sessão aberta na hora.

### 7. Domínio próprio: omeufiscal.com.br

| Endereço | Onde | Registro DNS |
|---|---|---|
| `www.omeufiscal.com.br` (site + portal do cliente, endereço principal) | Vercel, projeto cliente | `CNAME www` → valor que a Vercel mostrar (ex.: `xxxx.vercel-dns-017.com`) |
| `omeufiscal.com.br` (redireciona para o www) | Vercel, projeto cliente | `A` no domínio raiz (@), com o IP que a Vercel mostrar (ex.: 216.198.79.1) |
| `painel.omeufiscal.com.br` (painel da equipe) | Vercel, projeto painel | `CNAME painel` → valor que a Vercel mostrar |

- A API continua em `meufiscal-api.onrender.com` (os sites chamam `/api/*` no próprio domínio e a Vercel repassa). Assim o aviso de pagamento do Inter e o resto não mudam.
- No Render (serviço da API › Environment): `ORIGENS_CLIENTE=https://www.omeufiscal.com.br,https://omeufiscal.com.br,https://meufiscal-cliente.vercel.app` e `ORIGENS_PAINEL=https://painel.omeufiscal.com.br,https://meufiscal-painel.vercel.app` (o primeiro de cada lista é o usado nos links de convite e e-mails).
- `SITE_URL` e `PAINEL_URL` em `sites/cliente/.env.production` já apontam para o domínio novo; o CORS do R2 (`api/r2-cors.json`) também, se o R2 estiver em uso.
- Depois, se quiser, a API pode ganhar `api.omeufiscal.com.br` (Render › Settings › Custom Domains, `CNAME api` → endereço do Render); aí é preciso atualizar `URL_PUBLICA_API`, `API_URL` nos dois `.env.production`, rodar `--configurar` e clicar em Testar conexão do banco para recadastrar o aviso do Inter.

## Sites na Cloudflare (alternativa grátis à Vercel)

**Pelo caminho Workers (o que o painel da Cloudflare oferece hoje):** Workers & Pages → Create → importar `meu-fiscal`; Project name `meufiscal-cliente` ou `meufiscal-painel`; Build command `node ../build.mjs <site>`; Deploy command `npx wrangler deploy`; em *Advanced settings*, Path `sites/<site>`. A configuração está em `sites/<site>/wrangler.jsonc` e `worker.js` (gerados por `--configurar`).

**Pelo caminho Pages:**

O build já gera tudo o que a Cloudflare Pages precisa: `_redirects`, `_headers` e uma página por rota dentro de `dist/`,
e a ponte `/api/*` em `sites/<site>/functions/api/[[caminho]].js` (Pages Function, regenerada por `node sites/build.mjs <site> --configurar`).

Para cada site (cliente e painel), em **Workers & Pages → Create → Pages → Connect to Git**:

| Campo | Cliente | Painel |
|---|---|---|
| Repositório / branch | `meu-fiscal` / `main` | `meu-fiscal` / `main` |
| Framework preset | None | None |
| Build command | `node ../build.mjs cliente` | `node ../build.mjs painel` |
| Build output directory | `dist` | `dist` |
| Root directory | `sites/cliente` | `sites/painel` |
| Variável `NODE_VERSION` | `22` | `22` |

Opcional: variável `API_URL` (troca o endereço da API sem mexer no código — útil na mudança para a VPS).
Depois, em **Custom domains**, adicione `www.omeufiscal.com.br` (cliente) e `painel.omeufiscal.com.br` (painel)
e ajuste os registros CNAME no GoDaddy para os endereços `*.pages.dev` indicados. A Vercel continua funcionando em paralelo até a troca.

## Théo envia documentos da empresa

Quando o cliente pede um documento ("me manda o contrato social"), pelo WhatsApp ou no Atendimento do portal, o Théo envia na hora
o arquivo guardado em **Documentos da empresa**, sem passar pelo atendente. Também envia o PDF das guias em aberto.
- Só para contatos identificados da própria empresa (telefone cadastrado em Atendimento › Contatos ou no cadastro).
- Mais de um da mesma categoria: vai o mais recente. Documento que não está no sistema: o Théo chama a equipe.
- Também envia as certidões registradas no **Monitor fiscal** (Federal, Estadual, Municipal, FGTS/CRF e Trabalhista/CNDT): a mais recente de cada esfera, só negativa ou positiva com efeito de negativa, com PDF e dentro da validade.
- Nunca envia guia vencida nem documento fora da validade (certidão, alvará…): avisa que está vencido e chama a equipe para emitir um atualizado.
- Liga/desliga e categorias permitidas em **Atendimento › Regras do atendimento** (padrão: todas menos "Outros").
- Cada envio fica no histórico da conversa com uma nota interna ("O Théo enviou ao cliente: Contrato Social").

## Apuração do Simples Nacional (etapa 1 do sistema fiscal/contábil)

Menu **Apuração do Simples** no painel (permissão do módulo "Apuração, guias e notas").
- **Lançamentos de receita** por competência (coleção `receitas`): data, valor, descrição, **anexo da atividade** (I a V, ou
  "III ou V pelo Fator R") e segregação: ISS retido, ICMS-ST, PIS/Cofins monofásico, exportação, sem ISS. Importa as NFS-e
  emitidas do mês. O total dos lançamentos vira o faturamento do mês (`faturamento`, origem `lancamentos`), base do RBT12.
- **Cálculo**: RBT12 dos 12 meses anteriores (proporcional no início de atividade), Fator R com a folha de 12 meses (FS12, informada
  ou estimada), alíquota efetiva por anexo e **repartição dos tributos** por faixa (LC 123, Anexos I a V, LC 155/2016), ISS limitado
  a 5% com redistribuição do excesso, dedução dos tributos segregados, alertas de sublimite (R$ 3,6 mi) e limite (R$ 4,8 mi).
- **Memória de cálculo**, **registro de receitas** e, para MEI, **relatório mensal de receitas brutas** em PDF (página de impressão).
- **Gerar/atualizar guia DAS** com o valor calculado e a memória gravada na guia (guia paga ou com comprovante não muda).
- A tela "Apuração e guias" passa a usar esse cálculo quando há lançamentos. Conferir com o PGDAS-D antes de transmitir.
- Tabelas valem até 2026; a partir de 2027 entram as regras da reforma tributária (IBS/CBS) no Simples.

## Sistema fiscal (`fiscal.omeufiscal.com.br`)

A escrituração fica num terceiro site, separado do painel. Ele usa o mesmo login da equipe, o mesmo banco e as mesmas permissões, e fala com a API como "painel". A guia do DAS gerada lá cai direto no portal do cliente.

- **Layout de sistema contábil:**
  - módulos no topo: Escrita Fiscal (ativo) e, nas próximas etapas, Contabilidade, Folha e Obrigações anuais;
  - empresa e competência fixas logo abaixo;
  - menu da rotina à esquerda;
  - barra de status embaixo.
- **Atalhos:** **F8** troca de empresa (com busca e Enter). **PgUp/PgDn** muda a competência.
- **Rotinas da Escrita Fiscal:**
  - Notas fiscais de saída;
  - Notas fiscais de entrada;
  - Simples Nacional e MEI;
  - Livros e relatórios.
- No painel, esses módulos saíram do menu e foram trocados por um link **Sistema contábil ↗**.
- **Build:** `node sites/build.mjs fiscal`, com saída em `sites/fiscal/dist`.
  - Rotas: `/login` e `/escrita`.
  - `PAINEL_URL`, em `sites/contabil/.env.production`, é o link de volta ao painel.
  - `CONTABIL_URL`, no build do painel, é o link do painel para cá. O padrão é `https://contabil.omeufiscal.com.br`.

### Publicar na Cloudflare

1. **Workers & Pages → Create → Import a repository**, no mesmo repositório:
   - nome `meufiscal-contabil`;
   - **Root directory** `sites/contabil`;
   - **Build command** `node ../build.mjs contabil`;
   - **Deploy command** `npx wrangler deploy`;
   - variável `NODE_VERSION` = `22`.
2. No Render, acrescente em `ORIGENS_PAINEL`, separados por vírgula: `https://contabil.omeufiscal.com.br` e o endereço `https://meufiscal-contabil.<sua-conta>.workers.dev`.
3. Com o domínio ativo na Cloudflare, abra **Worker → Settings → Domains & Routes → Add → Custom domain** e informe `contabil.omeufiscal.com.br`.
4. O login é por domínio. Entre uma vez com o mesmo e-mail e senha do painel.

## Sistema contábil (`contabil.omeufiscal.com.br`)

São três sistemas de departamento com o mesmo casco, o mesmo login e o mesmo banco: **Fiscal** (`fiscal.`), **Contábil** (`contabil.`) e **DP** (`dp.`). O menu do topo leva de um para o outro.

- **Plano de contas:** plano padrão simplificado para ME/EPP. As contas analíticas têm 4 níveis. Cada empresa pode criar contas próprias; na primeira alteração, o plano padrão é copiado para ela (coleção `planocontas`).
- **Lançamentos contábeis** (coleção `lanccontabeis`): partidas dobradas manuais, mais as geradas pela integração e pela conciliação.
- **Gerar integração** (no cartão da competência): transforma o fiscal e a folha do mês em lançamentos, num lote que pode ser refeito.
  - Fiscal:
    - receitas por anexo (D Clientes / C Vendas ou Serviços);
    - devoluções;
    - DAS (D Simples / C Simples a recolher);
    - notas de entrada por CFOP e lançamentos fiscais por acumulador (D custo, despesa ou imobilizado / C Fornecedores);
    - retenções de serviços tomados.
  - Folha fechada: salários e pró-labore desdobrados em líquido, INSS, IRRF, VT, adiantamentos e outros descontos; salário-família compensado no INSS; FGTS e INSS patronal.
  - O cartão avisa quando a integração fica desatualizada.
- **Conciliação bancária:** importa o OFX (coleção `extratos`, sem duplicar linhas pelo FITID). Sugere a contrapartida pela regra memorizada, pelo texto (tarifa, DAS, FGTS, INSS, aluguel, energia…) ou por um padrão (Clientes ou Fornecedores). Há conciliação em lote e opção de desfazer.
- **Demonstrações:**
  - Balancete, que confere se débitos e créditos batem.
  - DRE.
  - Balanço patrimonial, com o resultado ainda não encerrado no PL e conferência ativo = passivo + PL.
  - Fluxo de caixa pelo método direto (contas 1.1.1), separado em operacional, investimento e financiamento.
  - Diário e Razão.
  - Tudo sai em PDF, com assinatura do representante e do contador, ou em planilha.
- **Build:** `node sites/build.mjs contabil` (rotas `/login` e `/contabil`; `/escrita` redireciona para o fiscal).

### Competência, apuração e lançamentos (sistema fiscal)

- **Competência na lateral:** um cartão mostra o mês (‹ › ou PgUp/PgDn), a situação e o botão **Gerar apuração**.
  - Situações: sem movimento, receitas lançadas, apurada, desatualizada, guia liberada ou paga.
  - O botão calcula o DAS e cria ou atualiza a guia em rascunho, com a memória da apuração.
- **Central da competência:** todas as empresas do Simples e MEI no mês, com notas, lançamentos, receita, DAS calculado e situação da guia. Filtros por busca, regime, situação e responsável. Gera a apuração em lote das selecionadas; guias já liberadas ou pagas não são alteradas no lote.
- **Lançamentos fiscais** (coleção `lancfiscais`): saídas, serviços prestados, entradas, serviços tomados e outros documentos (energia, telecom, água, CT-e, aluguel). Cada lançamento usa um **acumulador** com código, como na Domínio, que diz se gera receita do Simples, em qual anexo e com qual segregação (ST, monofásico, exportação, ISS retido, locação sem ISS, não optante). A devolução de venda abate a receita.
- **Serviços tomados:** retenções de ISS, IRRF, PIS, Cofins, CSLL e INSS, com o botão "Sugerir retenções" (1,5% / 4,65% / 11%, sem reter quando dá até R$ 10).
- **Livros e relatórios:** os lançamentos entram nos Livros de Saídas e de Entradas. Há dois relatórios novos: "Retenções sobre serviços", base da EFD-Reinf e da DCTFWeb, e "Lançamentos por acumulador".

## Departamento Pessoal (`dp.omeufiscal.com.br`)

O DP é o quarto site e usa o mesmo casco do sistema contábil: módulos no topo (Escrita Fiscal ↔ Folha de Pagamento), empresa e competência fixas, **F8** e **PgUp/PgDn**. O login, o banco e as permissões são os mesmos do painel. As telas exigem o módulo "Demandas, admissões e folha".

- **Colaboradores e sócios:** ficha completa com vínculo (CLT, aprendiz, estagiário ou sócio com pró-labore), contrato, adicional, VT, dependentes de IRRF e de salário-família, e dados de pagamento. Também tem desligamento e reativação. Os sócios não aparecem no portal do cliente.
- **Admissões:** os pedidos que o cliente envia pelo portal aparecem aqui. Você muda a situação e efetiva; o colaborador entra no cadastro com os documentos.
- **Lançamentos do mês:** HE 50% e 100%, faltas, atrasos, comissões, gratificação, outros proventos e descontos, adiantamento e custo do VT. Dias úteis e domingos/feriados vêm do calendário e podem ser ajustados.
- **Cálculo da folha (tabelas 2026):**
  - INSS progressivo, com teto de R$ 8.475,55; o sócio paga 11%.
  - IRRF pela tabela da Lei 15.191/2025, com a redução da Lei 15.270/2025: isento até R$ 5.000 e redução parcial até R$ 7.350. Usa dedução por dependente ou o desconto simplificado, o que for melhor, e dispensa valores abaixo de R$ 10.
  - FGTS de 8% (aprendiz 2%) e salário-família de R$ 67,54 por filho para remuneração até R$ 1.980,38.
  - Horas extras com DSR, faltas, atrasos, VT de 6% e proporcionalidade na admissão e no desligamento.
  - Encargos patronais conforme o regime: Simples com CPP no DAS, Anexo IV, MEI 3%, e LP/LR com 20% + RAT×FAP + terceiros.
- **Fechar folha** grava o cálculo. A folha fechada alimenta o **Fator R** do sistema contábil.
- **Holerites:** PDF para impressão. "Publicar no portal" gera um PDF por colaborador (gerador próprio, sem biblioteca externa) e o coloca em "Pessoal e folha" no portal do cliente.
- **Relatórios:** resumo por rubrica, FGTS, INSS, IRRF e líquidos para pagamento, em tela, CSV ou PDF.
- **Coleções novas:** `dpmov` e `dpfolhas`, no módulo `dem` e ocultas para o cliente.
- **Build:** `node sites/build.mjs dp` (rotas `/login` e `/folha`). Na Cloudflare, use o Worker `meufiscal-dp` com Root directory `sites/dp` e build `node ../build.mjs dp`.
- **Próximas etapas:** férias, 13º, rescisão, horistas e eSocial/DCTFWeb.

### Férias, 13º e rescisões (DP)

- **Férias:** controle dos períodos aquisitivos de cada empregado, com o saldo pelas faltas (art. 130), o limite para conceder e o alerta de pagamento em dobro.
  - Na programação: abono pecuniário de 1/3 e adiantamento da 1ª parcela do 13º.
  - Cálculo: remuneração com a média das variáveis do período aquisitivo; férias + 1/3 e abono + 1/3; INSS e IRRF em separado. O FGTS não incide sobre o abono.
  - O recibo sai com pagamento 2 dias antes do início, junto com o aviso de férias em PDF.
  - Na folha do mês, os dias de férias saem do salário, e o INSS considera salário + férias do mês, cobrando só a diferença.
- **13º salário:**
  - Avos contam os meses com 15 dias ou mais, e a média de HE e comissões vem das folhas fechadas.
  - 1ª parcela: metade, sem descontos (ou a que já foi paga nas férias).
  - 2ª parcela: total com INSS e IRRF próprios, menos o adiantamento.
  - FGTS de cada parcela e recibos em PDF.
- **Rescisões:**
  - Motivos: sem justa causa, pedido de demissão, justa causa, acordo (484-A), término de experiência e de prazo.
  - Aviso prévio proporcional (Lei 12.506), que pode ser indenizado (com projeção), trabalhado, dispensado ou descontado.
  - Verbas: saldo de salário, 13º proporcional menos o adiantamento, férias vencidas e proporcionais com 1/3.
  - INSS e IRRF do saldo e do 13º em separado; aviso e férias indenizadas sem IRRF.
  - FGTS do mês, multa de 40% ou 20% sobre o saldo informado, prazo de 10 dias e termo de rescisão em PDF.
  - Ao salvar, o empregado é desligado e sai da folha do mês.
- O FGTS, o INSS e o IRRF desses recibos já entram somados nas guias da folha do mês de pagamento (coleção `dpeventos`).

### Folha: motor de cálculo e facilidades do analista (DP)

- **Calendário:** feriados nacionais (inclui Sexta-feira Santa e 20/11) e locais da empresa (botão "Feriados"; guardados em `empresas.dp.feriados`) entram no DSR. Nov/2026 = 23 úteis / 7 DSR.
- **DSR** sobre todas as variáveis com incidência (HE, adicional noturno, comissões, eventos marcados). **DSR perdido** (rubrica 213) pela semana de cada falta injustificada (campo "Dias das faltas").
- **Atestado:** não desconta, mas reduz os dias de VT e VA.
- **Catálogo de eventos** (botão "Outros eventos" por pessoa): adicional noturno e HE noturna com hora reduzida, HE 60–80%, sobreaviso, gratificação, prêmio, ajuda de custo, pensão (% de bruto − INSS ou valor, deduzida no IRRF), plano de saúde, consignado, sindical, eventos personalizados com incidências.
- **Eventos fixos** no cadastro (`f.fixos`, com vigência e parcelas): entram sozinhos todo mês.
- **Benefícios:** VT por tarifa diária × dias trabalhados (desconto até 6%, limitado ao custo); VA por dia ou mensal com desconto % (rubrica 248). Totais de compra na folha e relatório "Benefícios".
- **Vale quinzenal em lote** (% configurável, proporcional para admitidos na 1ª quinzena) com recibos em PDF.
- **Importar planilha** (CSV ou colado do Excel) por CPF: he50, he100, faltas, faltasDatas, atestado, atrasos, comissoes, vale, vt, noturno.
- **Reajuste com vigência:** histórico em `f.salarios`; se a vigência cai em folha já fechada, as diferenças (rubrica 090) são lançadas no mês atual.
- **INSS com outro vínculo** (`f.inssOutraBase`) respeita o teto.
- **Conferência antes de fechar:** salário abaixo do mínimo e líquido negativo são críticos (pedem confirmação); vale > 60%, consignado > 35% e PIS ausente são avisos. Roteiro do mês no topo da folha.
- **Contabilidade:** a integração da folha agora lança a compra de VT (4.2.1.05) e VA (4.2.1.07) e credita pensões, consignados e outros descontos em 2.1.5.01; faltas reduzem a despesa.

- O IRRF usa a redução da Lei 15.270/2025 sobre a base de cada pagamento. Confira a orientação da Receita para férias e rescisões.
- **Fora do cálculo:** indenizações dos arts. 479/480, estabilidades e verbas de convenção.

## Escrita fiscal de saída (no sistema contábil)

A escrita fiscal fica no sistema contábil, nas rotinas Notas fiscais de saída, Simples Nacional e MEI, e Livros e relatórios.

- **Importar XML ou ZIP:** NF-e e NFC-e (com protocolo), NFS-e do padrão nacional e ABRASF, eventos de cancelamento (110111) e ZIPs com vários XML. A nota de um fornecedor para a empresa vai para Notas de entrada. A nota de outro CNPJ é ignorada.
- **Receita automática:** sai dos CFOP de venda e serviço. Produção vai para o Anexo II, revenda para o Anexo I e serviço para o anexo da empresa.
  - ST: CSOSN 500, CST 60 ou CFOP 405/411.
  - Monofásico: PIS/COFINS CST 04/05.
  - Exportação: CFOP 7.
  - ISS retido: lido do XML da NFS-e.
  - Devoluções abatem a receita.
  - Remessas, transferências e bonificações não geram receita.
  - No detalhe da nota dá para trocar o anexo, marcar Fator R ou não considerar a nota como receita.
- **Lançamento manual:** regime (Simples ou não optante), anexo, Fator R, ISS retido, ST, monofásico, exportação e valor negativo para devolução. A receita de não optante fica fora do DAS.
- **Filtros:** modelo, CFOP, CST/CSOSN, destaque (ICMS, ST, IPI, monofásico, ISS retido, devolução), situação e texto.
- **Relatórios** (tela, CSV e PDF):
  - por CFOP, CST, NCM, cliente, dia, modelo e anexo (base do PGDAS-D);
  - Livro Registro de Saídas;
  - Livro Registro de Entradas;
  - itens.
- **Ainda não trata:** ISS devido a outro município, as regras da reforma tributária de 2027 e exceções de CFOP fora das regras acima. Essas exceções se ajustam nota a nota.

## Notas de entrada (NF-e dos fornecedores, direto da SEFAZ)

Menu **Notas de entrada** no painel. Para cada empresa com **certificado A1** cadastrado, o sistema consulta de hora em hora o
serviço oficial e gratuito **NFeDistribuicaoDFe** do Ambiente Nacional e grava as NF-e emitidas contra o CNPJ do cliente
(coleção `nfentrada`, id = chave de acesso; XML em `arquivos`).
- Primeiro chega o **resumo**; o sistema registra a **ciência da operação** (evento 210210, assinado com o A1) e o **XML completo**
  chega na consulta seguinte. Ciência e busca automáticas podem ser desligadas na própria tela.
- Respeita as regras da SEFAZ: 1 hora de espera ao chegar ao fim da fila (cStat 137/maxNSU) e no bloqueio por consumo indevido (656).
  O controle de NSU fica na tabela `nfe_entrada_estado`.
- A SEFAZ só entrega notas dos últimos ~90 dias, e só com o certificado da própria empresa (mesma raiz de CNPJ).
- Cancelamentos feitos pelo emissor marcam a nota como cancelada. Exportação em planilha (CSV) pela tela.
- Variáveis: `NFE_ENTRADA_AMBIENTE=homologacao` (opcional, padrão produção); `NFE_CA_ARQUIVO` (opcional, .pem com a cadeia ICP-Brasil,
  se a SEFAZ recusar a conexão por certificado desconhecido); `NFE_ENTRADA_FALSO=1` só para teste local.

## Página comercial (o que fica em `/` no site do cliente)

- **Preços, planos, números e depoimentos**: edite `app/landing.config.json` no GitHub (lápis ✏️ → *Commit changes*). A Vercel publica sozinha em ~1 minuto.
- **Depoimentos** só aparecem quando a lista `depoimentos` tiver itens. Use apenas depoimentos reais, com autorização do cliente.
- **Botão do topo**: mostra "Mudar de contabilidade". Se a abertura de empresa for sem custo de honorário, troque `aberturaGratis` para `true` e ele vira "Abrir empresa grátis".
- **Botão "Contratar"** (topo e planos) abre uma janela em duas etapas: nome completo, WhatsApp e e-mail; depois empresa, CNPJ, funcionários e se já tem contador, com o plano escolhido e o preço. O pedido cai na hora em **Painel → CRM comercial › Novos leads** (e na Central de alertas).
- Textos de termos e privacidade: `app/legal.html` (revise com seu advogado).
- Se mudar classes de layout em `app/landing.html`, recompile o CSS com o Tailwind CLI: `tailwindcss -c sites/landing/tailwind.config.js -i sites/landing/landing.src.css -o app/landing.css --minify`. Só editar o JSON não exige isso.

## Rotas publicadas

| Site 1 · Portal do Cliente | | Site 2 · Painel Contábil | |
|---|---|---|---|
| `/` | **página comercial** (planos, FAQ, formulário) | | |
| `/termos`, `/privacidade` | textos legais | | |
| `/login` | entrar | `/admin/login` | entrar (e-mail corporativo) |
| `/definir-senha?token=` | convite / nova senha | `/admin/definir-senha?token=` | convite / nova senha |
| `/dashboard` | portal | `/admin/dashboard` | painel operacional |
| `/cadastro` | → formulário da página comercial · `/primeiro-acesso` → orientação de primeiro acesso | `/admin/cadastro` | Acessos e equipe |
| `/admin/*` | → `/login` (bloqueado) | `/`, `/login`, `/dashboard` | → rotas `/admin/…` |

## Testar no seu computador

```bash
# Postgres local (Docker): docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16
cp api/.env.example api/.env    # ajuste: DATABASE_URL local (sslmode=disable), ARQUIVOS_DRIVER=disco,
                                # ORIGENS_CLIENTE=http://localhost:4001, ORIGENS_PAINEL=http://localhost:4002,
                                # URL_PUBLICA_API=http://localhost:8080, NODE_ENV=development
cd api && npm start                                               # API em :8080
API_URL=http://localhost:8080 node sites/build.mjs cliente && API_URL=http://localhost:8080 node sites/dev.mjs cliente 4001
API_URL=http://localhost:8080 node sites/build.mjs painel  && API_URL=http://localhost:8080 node sites/dev.mjs painel  4002
```
`sites/dev.mjs` imita a Vercel: lê o `vercel.json` e aplica proxy, redirects e cabeçalhos.

## O que foi verificado antes da entrega

Tudo abaixo rodou contra um PostgreSQL 16 real, com os dois sites em domínios separados e um navegador em cada:

- **Banco:** conexão com TLS e SCRAM-SHA-256, consultas, transações e `LISTEN/NOTIFY`.
- **Arquivos:** a assinatura das URLs pré-assinadas (AWS SigV4) confere com o exemplo oficial da AWS.
- **Login e convites:**
  - convite, criação de senha e uso único do link;
  - login e logout;
  - recusa cruzada entre portal e painel;
  - cookie renomeado recusado.
- **Isolamento:** o cliente vê só a própria empresa, e guia em rascunho não chega ao portal.
- **Escritas negadas pela API:**
  - cliente alterando o valor de uma guia, marcando-a como paga ou mudando o regime;
  - renovação de certificado com valor adulterado;
  - documento ou arquivo enviado para a empresa de outro cliente;
  - escrita vinda de origem desconhecida.
- **Fluxo integrado:**
  - solicitação do cliente aparece no painel em 0,5 s;
  - conclusão do escritório aparece no portal em 0,5 s;
  - guia liberada chega ao portal em 0,4 s;
  - documento com PDF enviado pelo cliente e aberto pelo painel.
- **Resiliência:**
  - bloquear o cliente no painel o desconecta na hora;
  - a API caiu e voltou, os sites reconectaram em 1 s e recuperaram a mudança feita durante a queda.

## Limites do plano gratuito (vale saber)

- **Render free:** o serviço "dorme" após cerca de 15 minutos sem uso. O primeiro acesso depois disso leva até 1 minuto; a tela mostra uma mensagem e tenta de novo sozinha. Para eliminar a espera, use o plano pago mais barato do Render ou um monitor de disponibilidade.
- **Neon (banco):** o plano free é permanente e não pede cartão. Ele dá 100 horas de computação por mês, 1 GB de dados e uma janela de restauração de apenas 6 horas, e o banco dorme após 5 minutos sem uso (acorda em cerca de 1 s). A API só mantém o banco acordado enquanto alguém está com um dos sites aberto, para economizar essas horas.
- **Antes de cobrar de clientes:** passe o Neon para o plano Launch, que é pago por uso e sem mensalidade mínima. A janela de restauração de 6 horas é curta demais para dados contábeis de terceiros.
- **R2:** 10 GB grátis; confira o painel de uso no primeiro mês.
- **Escala:** a API foi feita para rodar em **uma instância**: o limite de tentativas de login fica em memória. Para várias instâncias, mova esse limite para o banco ou para um Redis.
- **Senhas:** a regra de exatamente 8 letras ou números, sem verificação em duas etapas, é a parte mais frágil. Para aceitar senhas maiores, altere `SENHA_RE` em `api/src/config.js` e no `app/login.html`.


### Planos, contrato automático e comissões

- **Planos** (site, cadastro e Théo comercial): MEI Serviços R$ 99,90 · MEI Comércio R$ 159,90 · Essencial R$ 259 · Profissional R$ 450 · Premium R$ 700 · Essencial Comércio R$ 359 · Profissional Comércio R$ 550 · Premium Comércio R$ 900. Todos têm emissor de NFS-e integrado, painel financeiro, portal e Théo 24h. Atendimento por ligação só no Premium; atendimento prioritário do Profissional para cima; abertura de CNPJ e certificado A1 grátis só em planos acima de R$ 450. Textos de venda em `app/landing.config.json`; serviços que vão no contrato em `api/src/planos.js`.
- **Contrato de prestação de serviços** (Resolução CFC nº 1.590/2020): gerado em PDF sozinho quando o pagamento da ativação é confirmado (ou o voucher de isenção ativa o cadastro), com os dados do cadastro, o plano, os serviços inclusos, os honorários, reajuste, aviso prévio, carta de responsabilidade, Lei 9.613/98, LGPD, rescisão/distrato e foro. O contratado é o contador responsável técnico; a Meu Fiscal aparece só como plataforma. Antes, o master preenche **Configurações › Contrato de prestação de serviços e comissões** (CPF/CNPJ e endereço profissional do contador, foro, índice de reajuste, aviso prévio). No cadastro do cliente: Baixar contrato, Gerar de novo e **Anexar contrato assinado** (PDF ou foto), que também vai para Documentos do cliente. O CFC não exige enviar cada contrato ao CRC: o contador guarda e apresenta quando a fiscalização pedir.
- **Quem cadastrou e comissões**: todo cadastro guarda quem o fez. Quando o 1º pagamento é confirmado, nasce a comissão (padrão 30% do valor pago, ajustável nas Configurações). Cada usuário vê as suas em **Minhas comissões** (com os contratos que faltam assinar); o master e quem edita o Financeiro veem todas em **Financeiro › Comissões**, registram o pagamento (data e forma), desfazem, cancelam e exportam CSV. As comissões ficam numa tabela própria no servidor: um comercial não vê a do outro.
- **Cadastro com dados da Receita**: no "Novo cliente", ao digitar o CNPJ completo (ou clicar em Buscar), o sistema consulta os dados públicos da Receita Federal (BrasilAPI; se falhar, CNPJ.ws) e preenche razão social, fantasia, endereço completo, município/UF, e-mail, telefone, responsável (1º sócio), regime (MEI, Simples ou fora) e guarda CNAE, data de abertura e sócios. Mostra a situação cadastral e avisa se não estiver ATIVA. Gratuito, sem chave; consultas guardadas por 12 h.

### Emissor de NFS-e (padrão nacional)

- **Emissão pelo servidor**: a DPS (leiaute 1.01) é montada com os dados da empresa, do tomador e do serviço, assinada com o certificado A1 da empresa (guardado no cofre) e enviada ao Sistema Nacional (SEFIN). Volta autorizada com chave de acesso, XML e DANFSe em PDF (se o oficial não estiver disponível, sai um espelho com a chave). Rejeições mostram o código e o motivo; dá para corrigir e reenviar. Cancelamento (evento 101101) e substituição também são feitos pelo sistema. O navegador não consegue alterar situação, número nem chave de uma nota transmitida.
- **Por empresa** (Carteira › cadastro › Emissão de NFS-e): ambiente de teste ou produção, inscrição municipal, série da DPS e código IBGE. Comece em teste, confira uma nota e só então libere a produção.
- **Novo serviço com sugestão pela atividade**: o sistema lê o CNAE da empresa e sugere o código de tributação nacional (LC 116) mais provável, já preenchendo descrição e código; também busca por palavra ou código e sugere NBS. A tabela CNAE → serviço fica em `api/src/nfse-cnae.js` (não existe tabela oficial nacional; o usuário confirma).
- **Campo Grande/MS**: desde 01/11/2026 MEI e optantes do Simples emitem só no Emissor Nacional (é o que o sistema faz). Empresas fora do Simples emitem pelo emissor da prefeitura (nfse.campogrande.ms.gov.br): o sistema avisa, não envia ao SEFIN e gera a DPS para conferência.
- **Teste offline**: `node api/test/nfse-teste.mjs <pasta> <cert.pfx> <senha>` gera DPS de MEI, Simples, Simples com retenção, não optante e cancelamento assinados, para validar nos schemas oficiais em `api/test/xsd` (o xmllint precisa de uma cópia dos XSD sem os `^`/`$` dos padrões).

### Procurações eletrônicas (e-CAC)

- **Procurações** (menu da Operação): lista todas as empresas ativas com a situação da procuração do cliente para o escritório (ativa, vence em até 30 dias, vencida, sem procuração, não consultada), validade e serviços.
- **Consulta na Receita**: pelo Integra Contador (`PROCURACOES / OBTERPROCURACAO41`), com o certificado e-CNPJ do escritório já cadastrado em Configurações › Integração com a Receita (o outorgado é o CNPJ desse certificado). Botão "Consultar todas", consulta por empresa e reconsulta automática a cada 7 dias (de madrugada).
- **Registro manual**: quando a integração não está configurada, registre a validade à mão.
- **Pedir ao cliente / Pedir renovação**: envia por WhatsApp e e-mail o passo a passo do e-CAC (Senhas e Procurações › Procuração eletrônica › Cadastrar) com o CNPJ do escritório.
- **Alertas** na Central de alertas e no cadastro da empresa: vencida, vence em até 30 dias e sem procuração. A situação da procuração é gravada só pelo servidor.
- **Notas fiscais**: a procuração do e-CAC não vale para a NFS-e; a emissão continua com o certificado A1 de cada empresa.

### Plano de comissão por comercial e renovação do certificado pelo banco

- **Plano de comissão** (Equipe e permissões › colaborador): aparece só quando o departamento Comercial (ou "Todos os setores") está marcado. Opções: % do 1º honorário; do 1º e do 3º; do 1º, do 3º e do 5º (o % padrão é o de Configurações › Contrato e comissões, 30%). O 1º honorário é o pagamento da ativação; o 3º e o 5º contam pela ordem das mensalidades pagas do cliente (baixa no banco ou manual). Cada comissão mostra o honorário de origem.
- **Renovação do certificado digital**: quando o cliente pede a renovação no portal, o sistema gera a cobrança no Banco Inter (QR Code PIX, PIX copia e cola e boleto em PDF, vencimento em 3 dias) pelo valor configurado pelo escritório. O pagamento dá baixa sozinho pelo aviso do banco (ou pelo botão "Já paguei · conferir"), o pedido vai para "em andamento" e o escritório agenda a validação. Sem banco conectado, continua o PIX da chave do escritório com envio de comprovante.

### Plano e contrato do cliente

- **Aba "Plano e contrato"** no cadastro do cliente (logo depois de Dados gerais): plano atual (nome, honorário, funcionários inclusos, adicional por funcionário, vencimento, vigência), contrato vigente (baixar PDF, gerar de novo, anexar o assinado), contratos anteriores, honorários em aberto no Financeiro e histórico de alterações do plano.
- **Upgrade, reajuste ou mudança de plano**: o atendente escolhe o novo plano/valor e o motivo; a alteração vale sempre a partir do 1º dia do próximo mês. Na hora, o sistema gera o novo contrato de prestação de serviços (numerado como alteração, com cláusula que substitui o anterior a partir da vigência) para assinatura, guarda o contrato anterior no histórico e agenda o plano novo. O Financeiro já gera as mensalidades a partir da vigência com o valor novo (e atualiza as que já existiam em aberto, sem boleto); no dia 1º o plano agendado vira o plano atual. Dá para cancelar a alteração antes da vigência.
- Usuários sem permissão de edição não veem mais o aviso de "só consulta": apenas não aparecem os botões de edição.
