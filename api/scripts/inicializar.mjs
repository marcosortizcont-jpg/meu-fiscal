// Primeira inicialização automática (para hospedagens sem terminal, como o Render gratuito).
// Roda a cada início da API e só age quando falta algo:
//  - sem nenhum usuário e com MASTER_EMAIL definido: cria o escritório e o master (convidado)
//    e escreve no log o link para criar a senha (vale 72 h);
//  - com IMPORTAR_DADOS_INICIAIS=1 e banco de negócio vazio: importa dados-atuais.json.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG, EMAIL_RE } from '../src/config.js';
import { criarPool } from '../src/pg.js';
import { sha256, aleatorio } from '../src/seguranca.js';
import { COLECOES, empresaDe } from '../src/regras.js';

const e = process.env;
const db = criarPool(CONFIG.banco, { max: 1 });
try {
  let [esc] = await db.query('SELECT id FROM escritorios ORDER BY criado_em LIMIT 1');
  const [{ n: usuarios }] = await db.query('SELECT count(*)::int AS n FROM usuarios');

  const email = String(e.MASTER_EMAIL || '').trim().toLowerCase();
  if (usuarios === 0 && EMAIL_RE.test(email)) {
    if (!esc) [esc] = await db.query('INSERT INTO escritorios (nome) VALUES ($1) RETURNING id', [e.ESCRITORIO_NOME || 'Meu escritório']);
    const nome = String(e.MASTER_NOME || email.split('@')[0]).trim();
    const [u] = await db.query(`INSERT INTO usuarios (escritorio_id, nome, email, ambiente, papel, funcao, status) VALUES ($1,$2,$3,'equipe','master','Master','convidado') RETURNING id`, [esc.id, nome, email]);
    const token = aleatorio(32);
    await db.query(`INSERT INTO tokens (hash, usuario_id, tipo, expira_em) VALUES ($1,$2,'convite', now() + interval '72 hours')`, [sha256(token), u.id]);
    console.log('\n================ PRIMEIRO ACESSO ================');
    console.log(`Master criado: ${nome} <${email}>`);
    console.log('Abra este link para criar a sua senha (vale 72 h, uso único):');
    console.log(`${CONFIG.origens.painel[0]}/admin/definir-senha?token=${token}`);
    console.log('==================================================\n');
  } else if (usuarios > 0) {
    // Master ainda sem senha: a cada início sai um link novo no log (o anterior deixa de valer)
    const [m] = await db.query(`SELECT id, nome, email FROM usuarios WHERE ambiente = 'equipe' AND papel = 'master' AND status = 'convidado' ORDER BY criado_em LIMIT 1`);
    if (m) {
      const token = aleatorio(32);
      await db.tx(async q => {
        await q(`UPDATE tokens SET usado_em = now() WHERE usuario_id = $1 AND tipo = 'convite' AND usado_em IS NULL`, [m.id]);
        await q(`INSERT INTO tokens (hash, usuario_id, tipo, expira_em) VALUES ($1,$2,'convite', now() + interval '72 hours')`, [sha256(token), m.id]);
      });
      console.log('\n================ PRIMEIRO ACESSO ================');
      console.log(`Master ainda sem senha: ${m.nome} <${m.email}>`);
      console.log('Abra este link para criar a sua senha (vale 72 h, uso único):');
      console.log(`${CONFIG.origens.painel[0]}/admin/definir-senha?token=${token}`);
      console.log('==================================================\n');
    }
  } else if (usuarios === 0) {
    console.log('[inicializar] Nenhum usuário ainda. Defina MASTER_EMAIL, MASTER_NOME e ESCRITORIO_NOME no Render para criar o primeiro acesso.');
  }

  if (e.IMPORTAR_DADOS_INICIAIS === '1') {
    if (!esc) [esc] = await db.query('SELECT id FROM escritorios ORDER BY criado_em LIMIT 1');
    const [{ n: registros }] = await db.query('SELECT count(*)::int AS n FROM registros');
    const arquivo = fileURLToPath(new URL('../dados-atuais.json', import.meta.url));
    if (esc && registros === 0 && fs.existsSync(arquivo)) {
      const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      let total = 0;
      await db.tx(async q => {
        for (const c of COLECOES) for (const item of Array.isArray(dados[c]) ? dados[c] : []) {
          const reg = { ...item }; if (!reg.id) reg.id = crypto.randomUUID(); if (c === 'empresas') delete reg.acessos;
          await q(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
            [esc.id, c, String(reg.id), empresaDe(c, reg), JSON.stringify(reg)]);
          total++;
        }
      });
      console.log(`[inicializar] ${total} registros importados de dados-atuais.json.`);
    }
  }
} catch (err) {
  console.error('[inicializar] falhou:', err.message);
} finally {
  await db.encerrar();
}
