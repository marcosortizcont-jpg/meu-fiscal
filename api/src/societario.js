// Societário ↔ carteira de clientes.
//
// Abertura de empresa: ao abrir o processo, o cliente já entra na carteira com status "em_abertura" (sem CNPJ, sem
// cobrança e fora das rotinas mensais). Quando a empresa sai, o Societário conclui a abertura: o servidor confere o CNPJ,
// completa o cadastro (dados da Receita conferidos pela equipe), ativa o cliente e gera o contrato de prestação de
// serviços. O status "em_abertura" só muda por aqui (o navegador não consegue ativar sozinho).
import crypto from 'node:crypto';
import { ErroHttp } from './http.js';
import { limitar } from './seguranca.js';
import { criarApoio, soDig, agoraLocal, brl } from './apoio.js';

const REGIME_ID = { MEI: 'reg2-mei', SN: 'reg2-sn-sem-ie', 'SN-IE': 'reg2-sn-com-ie', OUTRO: 'reg2-outros' };
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const t = (v, n) => String(v ?? '').trim().slice(0, n);
function cnpjValido(c) {
  c = soDig(c); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const planoDe = (p, antes = {}) => ({ ...antes, nome: t(p?.nome ?? antes.nome, 60), valor: r2(p?.valor ?? antes.valor), funcInclusos: Math.max(0, Math.round(Number(p?.funcInclusos ?? antes.funcInclusos ?? 0)) || 0),
  adicionalFunc: Math.max(0, r2(p?.adicionalFunc ?? antes.adicionalFunc ?? 0)), metodo: antes.metodo || 'bolepix', diaVenc: Math.min(28, Math.max(1, Number(p?.diaVenc ?? antes.diaVenc) || 10)) });
const enderecoDe = en => ({ cep: soDig(en?.cep).slice(0, 8), logradouro: t(en?.logradouro, 90), numero: t(en?.numero, 10), complemento: t(en?.complemento, 30), bairro: t(en?.bairro, 60) });

export function registrarSocietario(r, { db, exigir, log, pode, contratos }) {
  const A = criarApoio(db);
  const podeSoc = u => u.papel === 'master' || pode(u, 'sis_societario', 'editar') || pode(u, 'carteira', 'editar');

  /* cliente novo na carteira, a partir do processo de abertura */
  r.post('/api/societario/abertura', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeSoc(u)) throw new ErroHttp(403, 'Seu acesso não permite cadastrar clientes.');
    if (limitar(`soc-ab:${u.id}`, 40, 3600).bloqueado) throw new ErroHttp(429, 'Muitos cadastros seguidos. Aguarde alguns minutos.');
    const b = ctx.corpo || {}; const esc = u.escritorio_id;
    const nome = t(b.nome, 160); if (nome.length < 3) throw new ErroHttp(400, 'Informe o nome empresarial pretendido.');
    const resp = t(b.responsavel, 80); if (resp.length < 3) throw new ErroHttp(400, 'Informe o nome do responsável.');
    const email = t(b.email, 120).toLowerCase(); if (!emailOk(email)) throw new ErroHttp(400, 'Informe um e-mail válido do cliente.');
    const fone = soDig(b.telefone).slice(0, 13); if (fone.length < 10) throw new ErroHttp(400, 'Informe o WhatsApp do cliente com DDD.');
    const plano = planoDe(b.plano); if (!(plano.valor > 0)) throw new ErroHttp(400, 'Informe o honorário mensal que vai valer depois da abertura.');
    const regime = REGIME_ID[b.regime] ? b.regime : 'SN';
    const id = 'e-' + crypto.randomBytes(6).toString('hex'); const agora = new Date().toISOString();
    const cpf = soDig(b.cpf).length === 11 ? soDig(b.cpf) : '';
    const e = { id, razao: nome, fantasia: t(b.fantasia, 120), cnpj: '', regime: regime === 'SN-IE' ? 'SN' : regime, regimeId: REGIME_ID[regime], anexo: regime.startsWith('SN') ? 'III' : null,
      email, telefone: fone, endereco: enderecoDe(b.endereco), municipio: t(b.municipio, 80), uf: t(b.uf, 2).toUpperCase(), ibge: '', abertura: '', cnae: '', atividade: t(b.atividade, 200),
      contatos: [{ nome: resp, cargo: 'Responsável', telefone: fone, email }], socios: [], plano,
      status: 'em_abertura', origem: 'abertura', processoId: t(b.processoId, 40), inicioControle: '', checklist: [],
      criadoEm: agora, criadoPor: u.id, criadoPorNome: u.nome, cadastradoPor: { id: u.id, nome: u.nome, em: agora }, representante: { nome: resp, cpf } };
    await A.gravar(esc, 'empresas', id, id, e);
    await log('empresa_cadastrada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${nome} · em abertura (Societário) · ${brl(plano.valor)}/mês depois da abertura` });
    return { ok: true, empresa: e };
  });

  /* empresa pronta: completa o cadastro, ativa e gera o contrato */
  r.post('/api/societario/abertura/:id/concluir', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); if (!podeSoc(u)) throw new ErroHttp(403, 'Seu acesso não permite esta ação.');
    const esc = u.escritorio_id; const e = await A.empresa(esc, ctx.params.id); if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    if (e.status !== 'em_abertura') throw new ErroHttp(409, 'Esta empresa já não está em abertura.');
    const b = ctx.corpo || {}; const d = b.empresa || {};
    const cnpj = soDig(d.cnpj); if (!cnpjValido(cnpj)) throw new ErroHttp(400, 'CNPJ inválido. Confira os dígitos.');
    const [dup] = await db.query(`SELECT dados->>'razao' AS razao FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id <> $3 AND regexp_replace(coalesce(dados->>'cnpj',''),'\\D','','g') = $2 LIMIT 1`, [esc, cnpj, e.id]);
    if (dup) throw new ErroHttp(409, 'Já existe uma empresa com este CNPJ na carteira: ' + dup.razao + '.');
    const razao = t(d.razao, 160); if (razao.length < 3) throw new ErroHttp(400, 'Informe a razão social.');
    const endereco = enderecoDe(d.endereco);
    if (endereco.cep.length !== 8 || !endereco.logradouro || !t(d.municipio, 80) || t(d.uf, 2).length !== 2) throw new ErroHttp(400, 'Informe o endereço completo da empresa (CEP, rua, cidade e UF).');
    const regime = REGIME_ID[d.regime] ? d.regime : 'SN'; const L = agoraLocal();
    const inicio = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.inicioControle || '')) ? b.inicioControle : L.comp;
    const email = t(d.email || e.email, 120).toLowerCase(); const fone = soDig(d.telefone || e.telefone).slice(0, 13);
    const agora = new Date().toISOString();
    const novo = { ...e, cnpj, razao, fantasia: t(d.fantasia, 120) || e.fantasia || '', regime: regime === 'SN-IE' ? 'SN' : regime, regimeId: REGIME_ID[regime],
      anexo: regime.startsWith('SN') ? (t(d.anexo, 4) || e.anexo || 'III') : null, abertura: t(d.abertura, 10), cnae: t(d.cnae, 12), atividade: t(d.atividade, 200) || e.atividade || '',
      natureza: t(d.natureza, 120), ie: soDig(d.ie).slice(0, 14), im: t(d.im, 20), endereco, municipio: t(d.municipio, 80), uf: t(d.uf, 2).toUpperCase(), ibge: /^\d{7}$/.test(String(d.ibge || '')) ? String(d.ibge) : (e.ibge || ''),
      email: emailOk(email) ? email : e.email, telefone: fone.length >= 10 ? fone : e.telefone,
      socios: Array.isArray(d.socios) && d.socios.length ? d.socios.slice(0, 10).map(s => ({ nome: t(s?.nome, 100), qualificacao: t(s?.qualificacao, 60) })).filter(s => s.nome) : (e.socios || []),
      plano: planoDe(b.plano, e.plano || {}), status: 'ativo', ativadaEm: agora, inicioControle: inicio, aberturaConcluida: { em: agora, por: u.nome, processoId: t(b.processoId, 40) || e.processoId || '' },
      ativacao: { status: 'abertura', em: agora, por: u.nome } };
    if (!(novo.plano.valor > 0)) throw new ErroHttp(400, 'Informe o honorário mensal.');
    await A.gravar(esc, 'empresas', e.id, e.id, novo);
    let contrato = null, erroContrato = '';
    try { contrato = await contratos.gerarContrato(esc, e.id, u.nome); }
    catch (er) { erroContrato = er.message; const at = await A.empresa(esc, e.id); await A.gravar(esc, 'empresas', at.id, at.id, { ...at, contrato: { ...(at.contrato || {}), status: 'pendente', erro: er.message } }); }
    await log('empresa_ativada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${razao} · abertura concluída no Societário · CNPJ ${cnpj}${contrato ? ' · contrato ' + contrato.numero : ''}` });
    return { ok: true, empresa: await A.empresa(esc, e.id), contrato, erroContrato };
  });
}
