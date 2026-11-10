-- Meu Fiscal · banco único dos dois sites (PostgreSQL 14+; testado no 16)
-- Multitenant por escritório: toda linha de negócio carrega escritorio_id e toda consulta da API filtra por ele.
-- Idempotente: pode rodar de novo a cada deploy.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS escritorios (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       TEXT NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um e-mail = uma conta na plataforma inteira. É isso que permite recusar, com aviso claro,
-- um cliente que tenta entrar no Painel (e um colaborador que tenta entrar no Portal).
CREATE TABLE IF NOT EXISTS usuarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id    UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  nome             TEXT NOT NULL,
  email            TEXT NOT NULL,
  ambiente         TEXT NOT NULL CHECK (ambiente IN ('cliente','equipe')),
  papel            TEXT CHECK (papel IN ('master','gestor','analista')),
  status           TEXT NOT NULL DEFAULT 'convidado' CHECK (status IN ('convidado','ativo','bloqueado')),
  senha_hash       TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_login_em  TIMESTAMPTZ,
  CONSTRAINT equipe_tem_papel  CHECK (ambiente = 'cliente' OR papel IS NOT NULL),
  CONSTRAINT cliente_sem_papel CHECK (ambiente = 'equipe'  OR papel IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_unico ON usuarios (lower(email));
-- Função na equipe (Master, Analista Fiscal, Analista de DP, Analista Contábil, Legalização) e ajustes de permissão por módulo
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS funcao TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes JSONB NOT NULL DEFAULT '{}';
-- departamentos do Atendimento em que a pessoa atua ('*' = todos os setores; vazio/nulo = padrão da função)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS deptos TEXT[];
-- telefone de contato da pessoa (mostrado em Meu perfil; só o escritório altera)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone TEXT;
-- plano de comissão do comercial: p1 = 1º honorário; p13 = 1º e 3º; p135 = 1º, 3º e 5º
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS comissao_plano TEXT;
UPDATE usuarios SET funcao = 'Master' WHERE papel = 'master' AND funcao IS NULL;

-- Quais empresas cada usuário-cliente enxerga e com que perfil (vários CNPJs no mesmo login)
CREATE TABLE IF NOT EXISTS usuarios_empresas (
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id  TEXT NOT NULL,
  perfil      TEXT NOT NULL DEFAULT 'Sócio' CHECK (perfil IN ('Sócio','Financeiro','RH')),
  PRIMARY KEY (usuario_id, empresa_id)
);

CREATE TABLE IF NOT EXISTS sessoes (
  id           CHAR(64) PRIMARY KEY,                 -- SHA-256 do sid que vai no JWT
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  site         TEXT NOT NULL CHECK (site IN ('cliente','painel')),
  expira_em    TIMESTAMPTZ NOT NULL,
  revogada_em  TIMESTAMPTZ,
  ip           TEXT,
  user_agent   TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessoes_usuario ON sessoes (usuario_id) WHERE revogada_em IS NULL;

-- Convites (primeira senha) e redefinição de senha: só o SHA-256 do token fica salvo
CREATE TABLE IF NOT EXISTS tokens (
  hash        CHAR(64) PRIMARY KEY,
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('convite','redefinicao')),
  expira_em   TIMESTAMPTZ NOT NULL,
  usado_em    TIMESTAMPTZ,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dados de negócio: um registro por item das coleções do app (empresas, guias, documentos, tickets…).
-- empresa_id é extraído do próprio registro e é a chave do isolamento entre clientes.
CREATE TABLE IF NOT EXISTS registros (
  escritorio_id   UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  colecao         TEXT NOT NULL,
  id              TEXT NOT NULL,
  empresa_id      TEXT,
  dados           JSONB NOT NULL,
  versao          INTEGER NOT NULL DEFAULT 1,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por  UUID,
  PRIMARY KEY (escritorio_id, colecao, id)
);
CREATE INDEX IF NOT EXISTS registros_empresa ON registros (escritorio_id, empresa_id, colecao);

CREATE TABLE IF NOT EXISTS arquivos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id  UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  empresa_id     TEXT,
  chave          TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  tamanho        INTEGER NOT NULL,
  criado_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- onde cada arquivo está guardado (s3, banco ou disco): permite trocar o armazenamento sem perder os antigos
ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS local TEXT NOT NULL DEFAULT 's3';

-- Conteúdo dos arquivos quando ARQUIVOS_DRIVER=banco (fase inicial, sem armazenamento externo)
CREATE TABLE IF NOT EXISTS arquivos_conteudo (
  id        UUID PRIMARY KEY REFERENCES arquivos(id) ON DELETE CASCADE,
  conteudo  BYTEA NOT NULL
);

-- Certificado A1 de cada empresa: arquivo e senha cifrados com COFRE_CHAVE (AES-256-GCM)
CREATE TABLE IF NOT EXISTS certificados_a1 (
  escritorio_id  UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  empresa_id     TEXT NOT NULL,
  pfx_cifrado    BYTEA NOT NULL,
  senha_cifrada  BYTEA NOT NULL,
  nome_arquivo   TEXT,
  titular        TEXT,
  cnpj           TEXT,
  emissor        TEXT,
  valido_de      DATE,
  valido_ate     DATE NOT NULL,
  enviado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  enviado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (escritorio_id, empresa_id)
);

-- Cofre de senhas dos portais do cliente (Prefeitura/NFS-e, SEFAZ, e-CAC, FGTS Digital, Junta, SIMEI…)
CREATE TABLE IF NOT EXISTS cofre_senhas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id   UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  empresa_id      TEXT NOT NULL,
  portal          TEXT NOT NULL,
  url             TEXT,
  login           TEXT,
  senha_cifrada   BYTEA,
  observacao      TEXT,
  atualizado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cofre_empresa ON cofre_senhas (escritorio_id, empresa_id);

CREATE TABLE IF NOT EXISTS acessos_log (
  id          BIGSERIAL PRIMARY KEY,
  em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  acao        TEXT NOT NULL,
  usuario_id  UUID,
  email       TEXT,
  ip          TEXT,
  detalhe     TEXT
);
CREATE INDEX IF NOT EXISTS acessos_log_em ON acessos_log (em DESC);

-- Tempo real: toda gravação em "registros" avisa a API pelo canal "meufiscal".
-- A API repassa o aviso, por SSE, só para quem pode ver aquele registro.
CREATE OR REPLACE FUNCTION avisar_registro() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  r := COALESCE(NEW, OLD);
  PERFORM pg_notify('meufiscal', json_build_object(
    't', 'registro', 'esc', r.escritorio_id, 'c', r.colecao, 'id', r.id,
    'emp', r.empresa_id, 'op', lower(TG_OP), 'por', r.atualizado_por)::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS registros_aviso ON registros;
CREATE TRIGGER registros_aviso AFTER INSERT OR UPDATE OR DELETE ON registros
  FOR EACH ROW EXECUTE FUNCTION avisar_registro();

-- Mudança de acesso de um cliente (empresa liberada ou removida): a API reconecta a sessão dele.
CREATE OR REPLACE FUNCTION avisar_acesso() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  r := COALESCE(NEW, OLD);
  PERFORM pg_notify('meufiscal', json_build_object('t', 'acesso', 'usuario', r.usuario_id)::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usuarios_empresas_aviso ON usuarios_empresas;
CREATE TRIGGER usuarios_empresas_aviso AFTER INSERT OR UPDATE OR DELETE ON usuarios_empresas
  FOR EACH ROW EXECUTE FUNCTION avisar_acesso();

-- Permissões padrão de cada função, ajustáveis pelo master (sobrepõem as do código)
ALTER TABLE escritorios ADD COLUMN IF NOT EXISTS funcoes JSONB;

-- Sessão do WhatsApp conectado por QR code (chaves de criptografia do aparelho vinculado)
CREATE TABLE IF NOT EXISTS whatsapp_auth (
  escritorio_id  UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  chave          TEXT NOT NULL,
  valor          TEXT NOT NULL,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (escritorio_id, chave)
);

-- Histórico de alterações dos cadastros: quem mudou o quê, quando e de qual IP (só o master consulta)
CREATE TABLE IF NOT EXISTS alteracoes (
  id            BIGSERIAL PRIMARY KEY,
  escritorio_id UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id    UUID,
  usuario_nome  TEXT,
  ambiente      TEXT,
  ip            TEXT,
  colecao       TEXT NOT NULL,
  registro_id   TEXT,
  empresa_id    TEXT,
  acao          TEXT NOT NULL,
  resumo        TEXT,
  mudancas      JSONB
);
CREATE INDEX IF NOT EXISTS alteracoes_empresa ON alteracoes (escritorio_id, empresa_id, em DESC);
CREATE INDEX IF NOT EXISTS alteracoes_usuario ON alteracoes (escritorio_id, usuario_id, em DESC);

-- Integra Contador (SERPRO): credenciais do escritório para emitir o DAS do MEI pela API oficial da Receita
CREATE TABLE IF NOT EXISTS integra_config (
  escritorio_id            UUID PRIMARY KEY REFERENCES escritorios(id) ON DELETE CASCADE,
  ambiente                 TEXT NOT NULL DEFAULT 'producao',
  cnpj                     TEXT,
  consumer_key             TEXT,
  consumer_secret_cifrado  BYTEA,
  pfx_cifrado              BYTEA,
  senha_cifrada            BYTEA,
  cert_titular             TEXT,
  cert_validade            TEXT,
  auto                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  atualizado_por           UUID,
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Cada emissão e entrega do DAS-MEI (painel, Théo e envio mensal), para conferência e custos
CREATE TABLE IF NOT EXISTS integra_execucoes (
  id            BIGSERIAL PRIMARY KEY,
  escritorio_id UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  origem        TEXT NOT NULL,
  empresa_id    TEXT,
  comp          TEXT,
  ok            BOOLEAN NOT NULL,
  valor         NUMERIC,
  mensagem      TEXT,
  lote          TEXT
);
CREATE INDEX IF NOT EXISTS integra_exec_esc ON integra_execucoes (escritorio_id, em DESC);

-- Financeiro: banco integrado para boletos/PIX (Asaas). A chave da API fica cifrada; o token valida os avisos de pagamento.
CREATE TABLE IF NOT EXISTS financeiro_config (
  escritorio_id    UUID PRIMARY KEY REFERENCES escritorios(id) ON DELETE CASCADE,
  provedor         TEXT NOT NULL DEFAULT 'manual',
  ambiente         TEXT NOT NULL DEFAULT 'producao',
  api_key_cifrada  BYTEA,
  webhook_token    TEXT,
  ultima_execucao  JSONB,
  atualizado_por   UUID,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vouchers de desconto ou isenção para ativar cadastros (criados só pelo master)
CREATE TABLE IF NOT EXISTS vouchers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  codigo        TEXT NOT NULL,
  tipo          TEXT NOT NULL,              -- percentual | valor | isencao
  valor         NUMERIC NOT NULL DEFAULT 0,
  quantidade    INTEGER,                    -- NULL = ilimitado
  usados        INTEGER NOT NULL DEFAULT 0,
  meses         INTEGER NOT NULL DEFAULT 1, -- quantas mensalidades recebem o desconto (a 1ª é a da ativação)
  validade      DATE,
  ativo         BOOLEAN NOT NULL DEFAULT true,
  descricao     TEXT,
  criado_por    UUID,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_codigo ON vouchers (escritorio_id, upper(codigo));
CREATE TABLE IF NOT EXISTS voucher_usos (
  id            BIGSERIAL PRIMARY KEY,
  escritorio_id UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  voucher_id    UUID NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  empresa_id    TEXT,
  empresa_nome  TEXT,
  desconto      NUMERIC,
  usuario_id    UUID,
  usuario_nome  TEXT,
  em            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Banco Inter (cobrança com boleto + PIX): credenciais da integração, cifradas
ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS inter_client_id TEXT;
ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS inter_secret_cifrado BYTEA;
ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS inter_cert_cifrado BYTEA;
ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS inter_key_cifrada BYTEA;
ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS inter_conta TEXT;
-- Cobranças emitidas no banco: liga o código do banco ao registro do sistema (fatura ou ativação)
CREATE TABLE IF NOT EXISTS banco_cobrancas (
  escritorio_id  UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  provedor       TEXT NOT NULL,
  cobranca_id    TEXT NOT NULL,
  seu_numero     TEXT,
  ref            TEXT NOT NULL,
  valor          NUMERIC,
  venc           DATE,
  pago_simulado  BOOLEAN NOT NULL DEFAULT false,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (escritorio_id, provedor, cobranca_id)
);

-- Comissões do comercial: % do 1º pagamento de cada cliente cadastrado (só o próprio usuário e o Financeiro veem)
CREATE TABLE IF NOT EXISTS comissoes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id  UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  empresa_id     TEXT NOT NULL,
  empresa_nome   TEXT,
  usuario_id     UUID,
  usuario_nome   TEXT,
  base           NUMERIC NOT NULL,
  percentual     NUMERIC NOT NULL,
  valor          NUMERIC NOT NULL,
  referencia     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'a_pagar',
  paga_em        DATE,
  forma          TEXT,
  obs            TEXT,
  pago_por_nome  TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (escritorio_id, empresa_id, referencia)
);
CREATE INDEX IF NOT EXISTS comissoes_usuario ON comissoes (escritorio_id, usuario_id);

-- Notas de entrada (NF-e contra o CNPJ do cliente) pela Distribuição DF-e da SEFAZ: controle de NSU e da espera de 1 hora
CREATE TABLE IF NOT EXISTS nfe_entrada_estado (
  escritorio_id  UUID NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  empresa_id     TEXT NOT NULL,
  ult_nsu        TEXT NOT NULL DEFAULT '0',
  max_nsu        TEXT NOT NULL DEFAULT '0',
  proxima_em     TIMESTAMPTZ,
  ultima_em      TIMESTAMPTZ,
  c_stat         TEXT,
  mensagem       TEXT,
  notas_novas    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (escritorio_id, empresa_id)
);
