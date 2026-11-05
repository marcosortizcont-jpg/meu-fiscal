// Teste offline do emissor de NFS-e: monta DPS (MEI, Simples e não optante) e cancelamento, assina com um
// certificado de teste e grava os XMLs para validação no schema oficial (api/test/xsd) e conferência da assinatura.
// Uso: node api/test/nfse-teste.mjs <pasta-saida> <arquivo.pfx> <senha>
import fs from 'node:fs';
import path from 'node:path';
import { montarDps, montarCancelamento, assinarXml, pemDoPfx, dataHoraBr, conferirDados } from '../src/nfse.js';

const [saida, pfxArq, senha] = process.argv.slice(2);
const pem = pemDoPfx(fs.readFileSync(pfxArq), senha);
const base = { razao: 'EMPRESA TESTE LTDA', cnpj: '12345678000195', ibge: '5002704', municipio: 'Campo Grande', uf: 'MS', telefone: '67999998888', email: 'contato@teste.com.br' };
const tomPF = { nome: 'João da Silva & Filhos <teste>', doc: '52998224725', email: 'joao@teste.com' };
const tomPJ = { nome: 'Cliente Empresa SA', doc: '11222333000181', cep: '79002000', ibge: '5002704', logradouro: 'Rua 14 de Julho', numero: '1500', bairro: 'Centro', telefone: '6733334444' };
const serv = { cTribNac: '170601', descricao: 'Serviços de promoção de vendas', cNBS: '', aliqISS: 5 };
const casos = [
  ['mei', { ...base, regime: 'MEI' }, tomPF, serv, false],
  ['simples', { ...base, regime: 'SN', nfse: { im: '123456' } }, tomPJ, { ...serv, cTribNac: '010701', cNBS: '115013000', descricao: 'Suporte técnico em informática' }, false],
  ['simples-retido', { ...base, regime: 'SN' }, tomPJ, { ...serv, cTribNac: '171901', descricao: 'Serviços de contabilidade', aliqISS: 2 }, true],
  ['nao-optante', { ...base, regime: 'LP' }, tomPJ, { ...serv, cTribNac: '070502', descricao: 'Reforma de estrada', aliqISS: 3.5 }, false],
];
let i = 0;
for (const [nome, e, t, s, retido] of casos) {
  const falta = conferirDados({ e, t, s, valor: 150.5 }); if (falta.length) throw new Error(nome + ': ' + falta.join(', '));
  const n = { serie: '1', nDPS: ++i, dhEmi: dataHoraBr(), dCompet: dataHoraBr().slice(0, 10), valor: 150.5, issRetido: retido, aliqISS: s.aliqISS, descricao: s.descricao, obs: 'Pedido nº 45\nreferente a outubro' };
  const { xml } = montarDps({ e, n, t, s, tpAmb: 2 });
  fs.writeFileSync(path.join(saida, `dps-${nome}.xml`), assinarXml(xml, 'infDPS', pem));
}
const { xml } = montarCancelamento({ chave: '50027042212345678000195000000000000126110012345678', cnpj: '12345678000195', cMotivo: 1, xMotivo: 'Erro na emissão: valor digitado incorreto', tpAmb: 2 });
fs.writeFileSync(path.join(saida, 'cancelamento.xml'), assinarXml(xml, 'infPedReg', pem));
console.log('ok', fs.readdirSync(saida).join(' '));
