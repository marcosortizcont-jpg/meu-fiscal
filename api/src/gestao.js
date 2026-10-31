// Certificado A1 e cofre de senhas dos portais: só a equipe, conforme as permissões de cada pessoa.
// Os segredos ficam cifrados (cofre.js); revelar uma senha ou baixar um certificado fica registrado na auditoria.
import { ErroHttp } from './http.js';
import { cifrar, decifrar, lerCertificadoA1 } from './cofre.js';
import { CONFIG } from './config.js';

export function registrarGestao(r, { db, exigir, log, pode }) {
  const semChave = () => { if (!CONFIG.cofreChave) throw new ErroHttp(503, 'Cofre indisponível: falta a variável COFRE_CHAVE no servidor.'); };
  async function empresa(u, id) {
    const [e] = await db.query(`SELECT dados FROM registros WHERE escritorio_id = $1 AND colecao = 'empresas' AND id = $2`, [u.escritorio_id, String(id)]);
    if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    return e.dados;
  }
  const exigirModulo = (u, m, nivel) => { if (!pode(u, m, nivel)) throw new ErroHttp(403, nivel === 'editar' ? 'Seu acesso a esta área é só de consulta.' : 'Seu acesso não inclui esta área.'); };

  /* ---------------- certificado A1 ---------------- */
  r.get('/api/certificados/:empresaId', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cert', 'ver');
    const [c] = await db.query(`SELECT c.nome_arquivo, c.titular, c.cnpj, c.emissor, c.valido_de, c.valido_ate, c.enviado_em, us.nome AS enviado_por
      FROM certificados_a1 c LEFT JOIN usuarios us ON us.id = c.enviado_por WHERE c.escritorio_id = $1 AND c.empresa_id = $2`, [u.escritorio_id, ctx.params.empresaId]);
    return { certificado: c || null };
  });

  r.post('/api/certificados/:empresaId', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cert', 'editar'); semChave();
    const emp = await empresa(u, ctx.params.empresaId);
    const senha = String(ctx.corpo.senha || '');
    let pfx; try { pfx = Buffer.from(String(ctx.corpo.arquivo || ''), 'base64'); } catch { pfx = Buffer.alloc(0); }
    if (!pfx.length || pfx.length > 100 * 1024) throw new ErroHttp(400, 'Envie o arquivo .pfx (até 100 KB).');
    if (!senha) throw new ErroHttp(400, 'Informe a senha do certificado.');
    let info; try { info = lerCertificadoA1(pfx, senha); } catch (e) { throw new ErroHttp(400, e.message); }
    if (info.cnpj && emp.cnpj && info.cnpj !== String(emp.cnpj) && !ctx.corpo.ignorarCnpj)
      throw new ErroHttp(409, `Este certificado é do CNPJ ${info.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}, diferente da empresa.`, { codigo: 'cnpj_diferente' });
    await db.tx(async q => {
      await q(`INSERT INTO certificados_a1 (escritorio_id, empresa_id, pfx_cifrado, senha_cifrada, nome_arquivo, titular, cnpj, emissor, valido_de, valido_ate, enviado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (escritorio_id, empresa_id) DO UPDATE SET pfx_cifrado = EXCLUDED.pfx_cifrado, senha_cifrada = EXCLUDED.senha_cifrada, nome_arquivo = EXCLUDED.nome_arquivo,
          titular = EXCLUDED.titular, cnpj = EXCLUDED.cnpj, emissor = EXCLUDED.emissor, valido_de = EXCLUDED.valido_de, valido_ate = EXCLUDED.valido_ate,
          enviado_por = EXCLUDED.enviado_por, enviado_em = now()`,
      [u.escritorio_id, ctx.params.empresaId, cifrar(pfx), cifrar(senha), String(ctx.corpo.nome || 'certificado.pfx').slice(0, 120), info.titular, info.cnpj, info.emissor, info.validoDe, info.validoAte, u.id]);
      // o registro "certificados" alimenta os alertas de vencimento do painel e do portal
      const id = 'a1-' + ctx.params.empresaId;
      const dados = { id, empresaId: String(ctx.params.empresaId), titular: info.titular, cnpjCert: info.cnpj, emissor: info.emissor, validadeInicio: info.validoDe, validade: info.validoAte,
        enviadoEm: new Date().toISOString(), lembretes: [], noCofre: true };
      await q(`INSERT INTO registros (escritorio_id, colecao, id, empresa_id, dados, atualizado_por) VALUES ($1,'certificados',$2,$3,$4::jsonb,$5)
        ON CONFLICT (escritorio_id, colecao, id) DO UPDATE SET dados = EXCLUDED.dados, versao = registros.versao + 1, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`,
      [u.escritorio_id, id, String(ctx.params.empresaId), JSON.stringify(dados), u.id]);
    });
    await log('certificado_a1_salvo', { usuarioId: u.id, ip: ctx.ip, detalhe: `${emp.razao || ''} · válido até ${info.validoAte}` });
    return { ok: true, certificado: { titular: info.titular, cnpj: info.cnpj, emissor: info.emissor, valido_de: info.validoDe, valido_ate: info.validoAte } };
  }, { limite: 200 * 1024 });

  async function segredoCert(u, empresaId) {
    const [c] = await db.query('SELECT pfx_cifrado, senha_cifrada, nome_arquivo FROM certificados_a1 WHERE escritorio_id = $1 AND empresa_id = $2', [u.escritorio_id, empresaId]);
    if (!c) throw new ErroHttp(404, 'Nenhum certificado guardado para esta empresa.');
    return c;
  }
  r.post('/api/certificados/:empresaId/senha', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cert', 'editar'); semChave();
    const c = await segredoCert(u, ctx.params.empresaId);
    await log('certificado_senha_revelada', { usuarioId: u.id, ip: ctx.ip, detalhe: 'empresa ' + ctx.params.empresaId });
    return { senha: decifrar(c.senha_cifrada) };
  });
  r.get('/api/certificados/:empresaId/arquivo', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cert', 'editar'); semChave();
    const c = await segredoCert(u, ctx.params.empresaId);
    const pfx = decifrar(c.pfx_cifrado, false);
    await log('certificado_baixado', { usuarioId: u.id, ip: ctx.ip, detalhe: 'empresa ' + ctx.params.empresaId });
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-pkcs12', 'Content-Length': pfx.length, 'Content-Disposition': `attachment; filename="${(c.nome_arquivo || 'certificado.pfx').replace(/[^\w.\- ]/g, '_')}"` });
    ctx.res.end(pfx);
  });
  r.delete('/api/certificados/:empresaId', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cert', 'editar');
    await db.query('DELETE FROM certificados_a1 WHERE escritorio_id = $1 AND empresa_id = $2', [u.escritorio_id, ctx.params.empresaId]);
    await log('certificado_removido', { usuarioId: u.id, ip: ctx.ip, detalhe: 'empresa ' + ctx.params.empresaId });
    return { ok: true };
  });

  /* ---------------- cofre de senhas dos portais ---------------- */
  r.get('/api/cofre/:empresaId', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cofre', 'ver');
    const itens = await db.query(`SELECT c.id, c.portal, c.url, c.login, (c.senha_cifrada IS NOT NULL) AS tem_senha, c.observacao, c.atualizado_em, us.nome AS atualizado_por
      FROM cofre_senhas c LEFT JOIN usuarios us ON us.id = c.atualizado_por WHERE c.escritorio_id = $1 AND c.empresa_id = $2 ORDER BY c.portal`, [u.escritorio_id, ctx.params.empresaId]);
    return { itens, podeEditar: pode(u, 'cofre', 'editar') };
  });
  r.post('/api/cofre/:empresaId', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cofre', 'editar'); semChave();
    await empresa(u, ctx.params.empresaId);
    const c = ctx.corpo; const portal = String(c.portal || '').trim().slice(0, 80);
    if (!portal) throw new ErroHttp(400, 'Informe o portal.');
    const url = String(c.url || '').trim().slice(0, 300), login = String(c.login || '').trim().slice(0, 200), obs = String(c.observacao || '').slice(0, 1000);
    if (url && !/^https?:\/\//i.test(url)) throw new ErroHttp(400, 'O endereço do portal precisa começar com https://');
    const senha = typeof c.senha === 'string' && c.senha.length ? cifrar(c.senha.slice(0, 300)) : null;
    let id = c.id;
    if (id) {
      const res = await db.query(`UPDATE cofre_senhas SET portal = $1, url = $2, login = $3, observacao = $4, senha_cifrada = COALESCE($5, senha_cifrada), atualizado_por = $6, atualizado_em = now()
        WHERE id = $7 AND escritorio_id = $8 AND empresa_id = $9`, [portal, url, login, obs, senha, u.id, id, u.escritorio_id, ctx.params.empresaId]);
      if (!res.count) throw new ErroHttp(404, 'Item não encontrado.');
    } else {
      [{ id }] = await db.query(`INSERT INTO cofre_senhas (escritorio_id, empresa_id, portal, url, login, senha_cifrada, observacao, atualizado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [u.escritorio_id, ctx.params.empresaId, portal, url, login, senha, obs, u.id]);
    }
    await log('cofre_salvo', { usuarioId: u.id, ip: ctx.ip, detalhe: `${portal} · empresa ${ctx.params.empresaId}` });
    return { ok: true, id };
  });
  r.delete('/api/cofre/:empresaId/:id', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cofre', 'editar');
    await db.query('DELETE FROM cofre_senhas WHERE id = $1 AND escritorio_id = $2 AND empresa_id = $3', [ctx.params.id, u.escritorio_id, ctx.params.empresaId]);
    await log('cofre_removido', { usuarioId: u.id, ip: ctx.ip, detalhe: `item ${ctx.params.id}` });
    return { ok: true };
  });
  r.post('/api/cofre/:empresaId/:id/revelar', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'cofre', 'ver'); semChave();
    const [c] = await db.query('SELECT portal, senha_cifrada FROM cofre_senhas WHERE id = $1 AND escritorio_id = $2 AND empresa_id = $3', [ctx.params.id, u.escritorio_id, ctx.params.empresaId]);
    if (!c || !c.senha_cifrada) throw new ErroHttp(404, 'Senha não encontrada.');
    await log('cofre_senha_revelada', { usuarioId: u.id, ip: ctx.ip, detalhe: `${c.portal} · empresa ${ctx.params.empresaId}` });
    return { senha: decifrar(c.senha_cifrada) };
  });

  /* ---------------- auditoria de acessos sensíveis (master) ---------------- */
  r.get('/api/admin/acessos-log', async ctx => {
    const u = await exigir(ctx, { site: 'painel' }); exigirModulo(u, 'equipe', 'ver');
    const l = await db.query(`SELECT l.em, l.acao, l.email, l.ip, l.detalhe, us.nome FROM acessos_log l LEFT JOIN usuarios us ON us.id = l.usuario_id
      WHERE us.escritorio_id = $1 ORDER BY l.em DESC LIMIT 200`, [u.escritorio_id]);
    return { registros: l };
  });
}
