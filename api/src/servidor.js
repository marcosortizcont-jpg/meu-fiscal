// Meu Fiscal · API única (Portal do Cliente + Painel Contábil)
// Node.js 20+, sem dependências externas.
import http from 'node:http';
import { CONFIG, validarConfig } from './config.js';
import { criarPool, ouvir } from './pg.js';
import { criarRoteador } from './http.js';
import { criarHub } from './tempo-real.js';
import { registrarRotas } from './rotas.js';

validarConfig();

const db = criarPool(CONFIG.banco, { max: CONFIG.poolMax });
let carregarEmpresas = async () => [];
// O banco gratuito (Neon) cobra por hora de computação e dorme após 5 min sem uso.
// Por isso a API só escuta o banco (LISTEN) enquanto alguém está com um dos sites aberto.
let ouvinte = null, timerParar = null;
function aoMudarTotal(total) {
  if (total > 0) {
    clearTimeout(timerParar); timerParar = null;
    if (!ouvinte) ouvinte = ouvir(CONFIG.bancoDireto, 'meufiscal', p => hub.aviso(p), () => hub.reconectado());
  } else if (ouvinte && !timerParar) {
    timerParar = setTimeout(() => { ouvinte?.parar(); ouvinte = null; timerParar = null; }, 2 * 60 * 1000);
  }
}
const hub = criarHub({ carregarEmpresas: id => carregarEmpresas(id), aoMudarTotal });
const r = criarRoteador();
({ carregarEmpresas } = registrarRotas(r, { db, hub }));


const servidor = http.createServer((req, res) => r.tratar(req, res));
servidor.keepAliveTimeout = 65000;     // acima do timeout dos balanceadores
servidor.headersTimeout = 66000;
servidor.requestTimeout = 0;            // SSE fica aberto; as outras rotas têm limite de corpo
servidor.listen(CONFIG.porta, () => console.log(`Meu Fiscal API ouvindo na porta ${CONFIG.porta}`));

function desligar() {
  console.log('Encerrando…');
  ouvinte?.parar();
  hub.encerrarTodos();                 // os navegadores reconectam sozinhos na próxima instância
  servidor.close(() => db.encerrar().then(() => process.exit(0)));
  servidor.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', desligar);
process.on('SIGINT', desligar);
