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

#### Copiloto com IA gratuita (Google Gemini)
1. Entre em **aistudio.google.com** com uma conta Google do escritório → **Get API key** → **Create API key**.
2. No Render: serviço **meufiscal-api** → **Environment** → **Add Environment Variable** → nome `GEMINI_API_KEY`, valor = a chave. Salve (o Render reinicia sozinho).
3. Não cole a chave em chats nem no GitHub.

A camada gratuita do Gemini tem limite de pedidos por minuto e por dia e **o Google pode usar o conteúdo para melhorar os produtos dele**. Para dados sensíveis de clientes em produção, considere ativar o faturamento da chave (camada paga), que não usa os dados para treino.

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

### 7. Domínio próprio (opcional)
- Na Vercel, aponte `portal.seuescritorio.com.br` → projeto cliente e `painel.seuescritorio.com.br` → projeto painel.
- No Render, aponte `api.seuescritorio.com.br`.
- Depois atualize `ORIGENS_*` e `URL_PUBLICA_API` no Render, `API_URL` nos dois `.env.production`, rode `--configurar` de novo e atualize o CORS do R2.

## Página comercial (o que fica em `/` no site do cliente)

- **Preços, planos, números e depoimentos**: edite `app/landing.config.json` no GitHub (lápis ✏️ → *Commit changes*). A Vercel publica sozinha em ~1 minuto.
- **Depoimentos** só aparecem quando a lista `depoimentos` tiver itens. Use apenas depoimentos reais, com autorização do cliente.
- **Botão do topo**: mostra "Mudar de contabilidade". Se a abertura de empresa for sem custo de honorário, troque `aberturaGratis` para `true` e ele vira "Abrir empresa grátis".
- **Quem preenche o formulário** vira um *interessado* no Painel → Carteira de clientes (e um alerta na Central de alertas), em tempo real. Dali você chama no WhatsApp e, com um clique em *Cadastrar empresa*, o cadastro já abre com e-mail e telefone preenchidos.
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
