// Cria o escritório e o primeiro administrador master (rode uma vez).
// Uso: npm run criar-master -- "Nome do Escritório" "Nome Completo" email@escritorio.com.br [senha8]
// Sem senha: imprime um link de convite (72 h) para a pessoa criar a própria senha no Painel.
import { CONFIG } from '../src/config.js';
import { criarPool } from '../src/pg.js';
import { hashSenha, sha256, aleatorio } from '../src/seguranca.js';
import { SENHA_RE, EMAIL_RE } from '../src/config.js';

const [escritorio, nome, emailBruto, senha] = process.argv.slice(2);
const email = String(emailBruto || '').trim().toLowerCase();
if (!escritorio || !nome || !EMAIL_RE.test(email)) { console.error('Uso: npm run criar-master -- "Escritório" "Nome Completo" email@dominio [senha]'); process.exit(1); }
if (senha && !SENHA_RE.test(senha)) { console.error('A senha precisa ter exatamente 8 letras ou números.'); process.exit(1); }
const db = criarPool(process.env.DATABASE_URL, { max: 1 });
const [existe] = await db.query('SELECT id FROM usuarios WHERE lower(email) = $1', [email]);
if (existe) { console.error('Já existe uma conta com este e-mail.'); process.exit(1); }
let [esc] = await db.query('SELECT id FROM escritorios ORDER BY criado_em LIMIT 1');
if (!esc) [esc] = await db.query('INSERT INTO escritorios (nome) VALUES ($1) RETURNING id', [escritorio]);
const [u] = await db.query(`INSERT INTO usuarios (escritorio_id, nome, email, ambiente, papel, status, senha_hash) VALUES ($1,$2,$3,'equipe','master',$4,$5) RETURNING id`,
  [esc.id, nome, email, senha ? 'ativo' : 'convidado', senha ? await hashSenha(senha) : null]);
if (senha) console.log(`Master criado. Entre em ${CONFIG.origens.painel[0] || '(site do painel)'}/admin/login`);
else {
  const token = aleatorio(32);
  await db.query(`INSERT INTO tokens (hash, usuario_id, tipo, expira_em) VALUES ($1,$2,'convite', now() + interval '72 hours')`, [sha256(token), u.id]);
  console.log(`Master criado. Abra este link para criar a senha (vale 72 h):\n${CONFIG.origens.painel[0] || 'https://SEU-PAINEL'}/admin/definir-senha?token=${token}`);
}
console.log('Escritório:', esc.id);
await db.encerrar();
