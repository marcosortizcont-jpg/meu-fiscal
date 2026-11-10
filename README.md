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
