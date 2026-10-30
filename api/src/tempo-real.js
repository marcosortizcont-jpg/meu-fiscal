// Tempo real: o PostgreSQL avisa (LISTEN/NOTIFY) e a API repassa por Server-Sent Events
// só para quem pode ver o registro. O navegador então busca o registro atualizado.
import { podeLer } from './regras.js';

export function criarHub({ carregarEmpresas, aoMudarTotal }) {
  const conexoes = new Set();
  const avisar = () => aoMudarTotal?.(conexoes.size);

  function escrever(c, evento, dados) {
    try { c.res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`); } catch { remover(c); }
  }
  function remover(c) { if (!conexoes.delete(c)) return; clearInterval(c.batida); try { c.res.end(); } catch { } avisar(); }

  function conectar(req, res, u, sessaoId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const c = { res, u, sessaoId };
    // comentário a cada 25 s: mantém a conexão aberta atrás de proxies e evita que o plano gratuito "durma" com alguém conectado
    c.batida = setInterval(() => { try { res.write(': ping\n\n'); } catch { remover(c); } }, 25000);
    conexoes.add(c); avisar();
    req.on('close', () => remover(c));
    escrever(c, 'pronto', { em: new Date().toISOString() });
  }

  async function aviso(payloadTexto) {
    let p; try { p = JSON.parse(payloadTexto); } catch { return; }
    if (p.t === 'registro') {
      for (const c of conexoes) {
        if (c.u.escritorio_id !== p.esc) continue;
        if (!podeLer(c.u, p.c, p.emp)) continue;
        escrever(c, 'registro', { c: p.c, id: p.id, op: p.op, por: p.por });
      }
    } else if (p.t === 'acesso') {
      for (const c of conexoes) {
        if (c.u.id !== p.usuario) continue;
        c.u.empresas = await carregarEmpresas(c.u.id).catch(() => c.u.empresas);
        escrever(c, 'recarregar', { motivo: 'acesso' });
      }
    }
  }

  // depois de uma queda do LISTEN, avisos podem ter se perdido: todos recarregam
  function reconectado() { for (const c of conexoes) escrever(c, 'recarregar', { motivo: 'reconexao' }); }
  function encerrarSessao(sessaoId) { for (const c of conexoes) if (c.sessaoId === sessaoId) { escrever(c, 'sair', {}); remover(c); } }
  function encerrarUsuario(usuarioId) { for (const c of conexoes) if (c.u.id === usuarioId) { escrever(c, 'sair', {}); remover(c); } }

  function encerrarTodos() { for (const c of conexoes) remover(c); }
  return { conectar, aviso, reconectado, encerrarSessao, encerrarUsuario, encerrarTodos, total: () => conexoes.size };
}
