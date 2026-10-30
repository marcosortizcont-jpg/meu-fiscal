// Cria/atualiza as tabelas. Uso: npm run db:schema  (lê DATABASE_URL do ambiente ou do .env)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../src/config.js';
import { Conexao, lerUrl } from '../src/pg.js';

const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!url) { console.error('Defina DATABASE_URL.'); process.exit(1); }
const sql = fs.readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
// divide em comandos respeitando blocos $$ … $$ das funções
const comandos = []; let atual = '', dentro = false;
for (const linha of sql.split('\n')) {
  if (/^\s*--/.test(linha) && !dentro) continue;
  atual += linha + '\n';
  if ((linha.match(/\$\$/g) || []).length % 2 === 1) dentro = !dentro;
  if (!dentro && /;\s*$/.test(linha)) { comandos.push(atual.trim()); atual = ''; }
}
const c = await new Conexao(lerUrl(url)).conectar();
for (const cmd of comandos) { try { await c.consultar(cmd); } catch (e) { console.error("Falhou:\n" + cmd.slice(0, 400)); throw e; } }
c.fechar();
console.log(`Schema aplicado (${comandos.length} comandos).`);
