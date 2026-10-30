// Importa os dados atuais (carteira, guias, documentos…) para o banco novo.
// Uso: npm run importar -- dados.json
// Formato: { "empresas": [ {...}, ... ], "guias": [...], ... } — as mesmas coleções do app.
// Pode rodar de novo: registros com o mesmo id são atualizados.
import fs from 'node:fs';
import crypto from 'node:crypto';
import '../src/config.js';
import { criarPool } from '../src/pg.js';
import { COLECOES, empresaDe } from '../src/regras.js';

const arquivo = process.argv[2];
if (!arquivo) { console.error('Uso: npm run importar -- dados.json'); process.exit(1); }
const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const db = criarPool(process.env.DATABASE_URL, { max: 1 });
const [esc] = await db.query('SELECT id FROM escritorios ORDER BY criado_em LIMIT 1');
if (!esc) { console.error('Crie o escritório antes: npm run criar-master'); process.exit(1); }
let total = 0;
await db.tx(async q => {
  for (const c of COLECOES) {
    for (const item of Array.isArray(dados[c]) ? dados[c] : []) {
      const reg = { ...item }; if (!reg.id) reg.id = crypto.randomUUID();
      if (c === 'empresas') delete reg.acessos; // acessos de clientes agora são cadastrados no painel (Acessos)
      await q(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados) VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (escritorio_id, colecao, id) DO UPDATE SET dados = EXCLUDED.dados, empresa_id = EXCLUDED.empresa_id, atualizado_em = now()`,
        [esc.id, c, String(reg.id), empresaDe(c, reg), JSON.stringify(reg)]);
      total++;
    }
  }
});
console.log(`${total} registros importados.`);
await db.encerrar();
