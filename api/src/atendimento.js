// Regras do Atendimento: triagem pelo Théo, conversas por setor e devolução à fila por inatividade do atendente.
//
//  - Triagem: conversa que chega à equipe sem setor definido ("Triagem") é lida pelo Théo, que escolhe o departamento.
//    Sem IA (ou se ela não decidir), usa as regras de palavras-chave; se ainda assim não der, fica na Triagem.
//  - Por setor: cada atendente só recebe as conversas dos departamentos marcados no cadastro dele, mais as que
//    estão com ele ou foram transferidas para ele. Master e quem tem "Todos os setores" veem tudo.
//  - Inatividade: se o cliente está esperando resposta há X minutos e o atendente não respondeu, a conversa volta
//    para a fila (do setor ou da triagem), com todo o histórico, para outro atendente assumir.
import { DEPTOS_ATEND, classificarDepto, criarApoio } from './apoio.js';
import { perguntarIA, iaDisponivel } from './externos.js';

export const ATEND_PADRAO = { porSetor: true, triagemTheo: true, inatividadeMin: 30, devolverPara: 'setor', theoDocs: true, theoDocsCats: null };
// documentos que o Théo pode enviar sozinho quando o cliente pede (Atendimento › Regras do atendimento)
export const CATEGORIAS_DOC = ['Obrigações entregues', 'Contrato de prestação de serviços', 'Contrato Social', 'Alterações Contratuais', 'Cartão CNPJ', 'Inscrição Estadual', 'Inscrição Municipal', 'Alvarás e Licenças', 'Certidões', 'Outros'];
export const DOCS_THEO_PADRAO = CATEGORIAS_DOC.filter(c => c !== 'Outros');
export const catsDocTheo = conf => (conf && conf.theoDocs === false) ? [] : (Array.isArray(conf && conf.theoDocsCats) ? conf.theoDocsCats.filter(c => CATEGORIAS_DOC.includes(c)) : DOCS_THEO_PADRAO);
export const cfgAtend = cfg => ({ ...ATEND_PADRAO, ...((cfg && cfg.atendimento) || {}) });
// departamentos padrão de cada função, para quem ainda não tem os departamentos marcados no cadastro
export const FUNCAO_DEPTO = { 'Analista Fiscal': ['Fiscal'], 'Analista de DP': ['Pessoal'], 'Analista Contábil': ['Contábil'], 'Legalização': ['Legalização'], 'Comercial': ['Comercial'] };
export const TODOS = '*';
export const deptoConv = c => DEPTOS_ATEND.includes(c && c.depto) ? c.depto : 'Triagem';

export function limparDeptos(v) {
  if (!Array.isArray(v)) return null;
  const l = [...new Set(v.map(String))].filter(d => d === TODOS || DEPTOS_ATEND.includes(d));
  return l.includes(TODOS) ? [TODOS] : l;
}
// null = vê todos os setores
export function deptosDoUsuario(u) {
  if (u.papel === 'master') return null;
  if (Array.isArray(u.deptos)) return u.deptos.includes(TODOS) ? null : u.deptos;
  return FUNCAO_DEPTO[u.funcao] || null;
}
export function conversaVisivel(u, c, conf) {
  if (u.ambiente !== 'equipe' || !conf.porSetor) return true;
  const d = deptosDoUsuario(u); if (!d) return true;
  return d.includes(deptoConv(c)) || c.atendenteUid === u.id || c.transferidaPara === u.id;
}
// trecho SQL que restringe a coleção "conversas" (parâmetros a partir do índice i)
export function filtroConversas(u, conf, i) {
  if (u.ambiente !== 'equipe' || !conf.porSetor) return ['', []];
  const d = deptosDoUsuario(u); if (!d) return ['', []];
  return [` AND (colecao <> 'conversas' OR (CASE WHEN dados->>'depto' = ANY($${i}::text[]) THEN dados->>'depto' ELSE 'Triagem' END) = ANY($${i + 1}::text[])
    OR dados->>'atendenteUid' = $${i + 2} OR dados->>'transferidaPara' = $${i + 2})`, [DEPTOS_ATEND, d, u.id]];
}

const DESCRICAO = {
  Fiscal: 'impostos, DAS, guias, notas fiscais (NFS-e, NF-e), Simples Nacional, MEI, ICMS, ISS, parcelamentos, certidões negativas',
  Pessoal: 'funcionários, folha de pagamento, admissão, demissão, rescisão, férias, 13º, FGTS, eSocial, pró-labore dos sócios na folha',
  Contábil: 'balanço, balancete, DRE, lucro, distribuição de lucros, conciliação, extratos bancários, imposto de renda (IRPF/IRPJ)',
  Legalização: 'abertura, alteração ou baixa de empresa, contrato social, sócios, CNAE, alvarás, Junta Comercial, inscrições estadual/municipal',
  Financeiro: 'mensalidade, honorários, boleto ou fatura do escritório, plano contratado, reajuste',
  Comercial: 'quem ainda não é cliente e quer contratar o escritório, orçamento, proposta, preço dos planos',
};
// o Théo escolhe o departamento; sem IA ou sem resposta válida, usa as palavras-chave
export async function deptoPeloTheo(c, cfg) {
  if (c.modo === 'comercial') return { depto: 'Comercial', por: 'regras' };
  const msgs = (c.mensagens || []).filter(m => m.de === 'cliente' && m.texto).slice(-8).map(m => String(m.texto).slice(0, 400));
  const texto = msgs.join('\n');
  if (cfgAtend(cfg).triagemTheo && iaDisponivel() && texto.trim()) {
    try {
      const prompt = `Você é o Théo, da recepção de um escritório de contabilidade. Leia as mensagens do cliente e diga para qual departamento encaminhar.
Departamentos:
${Object.entries(DESCRICAO).map(([d, x]) => `- ${d}: ${x}`).join('\n')}
- Triagem: quando não der para saber o assunto (só cumprimento, por exemplo).
Responda só com o nome de um departamento, sem mais nada.
MENSAGENS DO CLIENTE:
${texto}`;
      const r = await perguntarIA({ mensagens: [{ role: 'user', content: prompt }] });
      const achou = DEPTOS_ATEND.find(d => new RegExp('^\\W*' + d.normalize('NFD').replace(/[̀-ͯ]/g, ''), 'i').test(String(r).normalize('NFD').replace(/[̀-ͯ]/g, '').trim()));
      if (achou) return { depto: achou, por: 'theo' };
    } catch (e) { console.error('[atendimento] triagem IA', e.message); }
  }
  return { depto: classificarDepto(texto), por: 'regras' };
}
// aplica a triagem na conversa (sem gravar)
export async function triar(c, cfg) {
  const { depto, por } = await deptoPeloTheo(c, cfg);
  const em = new Date().toISOString();
  c.triagem = { depto, por, em };
  if (depto !== 'Triagem' && deptoConv(c) !== depto) {
    c.depto = depto;
    c.mensagens.push({ de: 'sistema', interna: true, textoCliente: '', em, texto: `${por === 'theo' ? 'O Théo' : 'A triagem automática'} encaminhou para o setor ${depto}.` });
  }
  return depto;
}

// cliente esperando resposta do atendente: momento a partir do qual conta a inatividade (ou null)
export function esperandoDesde(c) {
  if (c.status !== 'humano' || !c.atendenteUid) return null;
  const ms = c.mensagens || [];
  let ultHumano = -1; for (let i = ms.length - 1; i >= 0; i--) if (ms[i].de === 'humano' || ms[i].de === 'ia') { ultHumano = i; break; }
  const pend = ms.slice(ultHumano + 1).find(m => m.de === 'cliente');
  if (!pend) return null;
  const marcos = [pend.em, c.assumidaEm, c.transferidaEm].filter(Boolean).sort();
  return marcos.at(-1);
}

export function registrarAtendimento(r, { db }) {
  const A = criarApoio(db);
  // grava só se ninguém mudou a conversa no meio do caminho (senão tenta no próximo ciclo)
  const gravarSe = (esc, c, versao) => db.query(`UPDATE registros SET dados = $4::jsonb, versao = versao + 1, atualizado_em = now(), atualizado_por = NULL
    WHERE escritorio_id = $1 AND colecao = 'conversas' AND id = $2 AND versao = $3`, [esc, c.id, versao, JSON.stringify(c)]);

  let ocupado = false;
  async function ciclo() {
    if (ocupado) return; ocupado = true;
    try {
      const escs = await db.query(`SELECT DISTINCT escritorio_id FROM registros WHERE colecao = 'conversas' AND coalesce(dados->>'status','') IN ('aguardando_humano','humano')`);
      for (const { escritorio_id: esc } of escs) {
        const cfg = await A.configEscritorio(esc); const conf = cfgAtend(cfg);
        const linhas = await db.query(`SELECT versao, dados FROM registros WHERE escritorio_id = $1 AND colecao = 'conversas' AND coalesce(dados->>'status','') IN ('aguardando_humano','humano')`, [esc]);
        for (const { versao, dados: c } of linhas) {
          try {
            // 1) triagem: na fila, sem setor, e com mensagem nova do cliente desde a última tentativa
            if (c.status === 'aguardando_humano' && deptoConv(c) === 'Triagem') {
              const ultCliente = [...(c.mensagens || [])].reverse().find(m => m.de === 'cliente')?.em || '';
              if (ultCliente && (!c.triagem || ultCliente > c.triagem.em)) { await triar(c, cfg); await gravarSe(esc, c, versao); continue; }
            }
            // 2) inatividade do atendente
            const min = Number(conf.inatividadeMin) || 0;
            const desde = min > 0 ? esperandoDesde(c) : null;
            if (desde && Date.now() - Date.parse(desde) >= min * 60000) {
              const em = new Date().toISOString(); const quem = c.atendenteUid;
              const [p] = await db.query('SELECT nome FROM usuarios WHERE id::text = $1', [String(quem)]).catch(() => []);
              const nome = String(p?.nome || 'O atendente').split(' ')[0];
              const destino = conf.devolverPara === 'triagem' ? 'Triagem' : deptoConv(c);
              (c.liberacoes = c.liberacoes || []).push({ em, uid: quem, minutos: min, para: destino });
              (c.transferencias = c.transferencias || []).push({ em, de: { depto: deptoConv(c), uid: quem, status: 'humano' }, para: { depto: destino, uid: null }, por: null, nota: `inatividade de ${min} min` });
              c.status = 'aguardando_humano'; c.atendenteUid = null; delete c.transferidaPara; delete c.assumidaEm; c.depto = destino;
              c.mensagens.push({ de: 'sistema', interna: true, textoCliente: '', em,
                texto: `${nome} ficou ${min} min sem responder o cliente. O Théo devolveu a conversa para a fila ${destino === 'Triagem' ? 'da triagem' : 'do setor ' + destino} para outro atendente assumir.` });
              await gravarSe(esc, c, versao);
            }
          } catch (e) { console.error('[atendimento] conversa', c.id, e.message); }
        }
      }
    } catch (e) { console.error('[atendimento]', e.message); } finally { ocupado = false; }
  }
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => ciclo(), 20000).unref?.(); setInterval(() => ciclo(), 30000).unref?.(); }
  return { ciclo };
}
