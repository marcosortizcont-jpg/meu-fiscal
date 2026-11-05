// Gerador de PDF simples, sem dependências: texto em A4 com Helvetica, títulos, parágrafos justificados,
// listas, quebra automática de página, rodapé com numeração e linhas de assinatura.
// Acentos do português via WinAnsiEncoding.

const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const ESPECIAIS = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, 'º': 0xBA, 'ª': 0xAA, '§': 0xA7, '°': 0xB0 };

function larguraChar(ch, negrito) {
  const t = negrito ? WB : W; const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return t[c - 32];
  if (ESPECIAIS[ch] === 0x95) return 350; if (ESPECIAIS[ch] === 0x96) return 556; if (ESPECIAIS[ch] === 0x97) return 1000;
  const base = ch.normalize('NFD')[0]; const b = base.charCodeAt(0);
  return b >= 32 && b <= 126 ? t[b - 32] : 556;
}
const largura = (txt, tam, negrito) => [...txt].reduce((a, ch) => a + larguraChar(ch, negrito), 0) * tam / 1000;
function codificar(txt) {   // texto → string literal PDF em WinAnsi
  let out = '';
  for (const ch of txt) {
    let c = ESPECIAIS[ch] ?? ch.charCodeAt(0);
    if (c > 255) c = 63;
    if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out;
}
function quebrar(txt, tam, negrito, max) {
  const linhas = []; let atual = '';
  for (const palavra of String(txt).split(/\s+/).filter(Boolean)) {
    const tentativa = atual ? atual + ' ' + palavra : palavra;
    if (largura(tentativa, tam, negrito) <= max || !atual) atual = tentativa; else { linhas.push(atual); atual = palavra; }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [''];
}

// blocos: { t: 'titulo'|'subtitulo'|'h'|'p'|'li'|'espaco'|'assinaturas'|'quadro', texto, itens, negrito }
export function gerarPdf({ blocos, rodape = '', titulo = 'Documento' }) {
  const LARG = 595.28, ALT = 841.89, ME = 56, MD = 56, MT = 60, MB = 60; const UTIL = LARG - ME - MD;
  const paginas = []; let ops = []; let y = ALT - MT;
  const novaPagina = () => { if (ops.length) paginas.push(ops); ops = []; y = ALT - MT; };
  const garantir = h => { if (y - h < MB) novaPagina(); };
  const texto = (x, yy, s, tam, negrito) => ops.push(`BT /${negrito ? 'F2' : 'F1'} ${tam} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${codificar(s)}) Tj ET`);
  const justificado = (x, yy, linha, tam, negrito, max) => {
    const pal = linha.split(' '); if (pal.length < 2) return texto(x, yy, linha, tam, negrito);
    const sobra = max - largura(linha, tam, negrito); const tw = sobra / (pal.length - 1);
    ops.push(`BT /${negrito ? 'F2' : 'F1'} ${tam} Tf ${tw.toFixed(3)} Tw ${x.toFixed(2)} ${yy.toFixed(2)} Td (${codificar(linha)}) Tj 0 Tw ET`);
  };
  const linhaH = (x1, x2, yy) => ops.push(`0.5 w ${x1.toFixed(2)} ${yy.toFixed(2)} m ${x2.toFixed(2)} ${yy.toFixed(2)} l S`);
  const paragrafo = (s, { tam = 10, negrito = false, recuo = 0, marcador = '', just = true, centro = false, antes = 0, depois = 6 } = {}) => {
    const max = UTIL - recuo; const ls = quebrar(s, tam, negrito, max); const lh = tam * 1.42;
    y -= antes;
    ls.forEach((l, i) => {
      garantir(lh); y -= lh;
      if (i === 0 && marcador) texto(ME + recuo - 11, y, marcador, tam, false);
      if (centro) texto(ME + (UTIL - largura(l, tam, negrito)) / 2, y, l, tam, negrito);
      else if (just && i < ls.length - 1) justificado(ME + recuo, y, l, tam, negrito, max);
      else texto(ME + recuo, y, l, tam, negrito);
    });
    y -= depois;
  };
  for (const b of blocos) {
    if (b.t === 'titulo') paragrafo(b.texto, { tam: 14, negrito: true, centro: true, depois: 4 });
    else if (b.t === 'subtitulo') paragrafo(b.texto, { tam: 9.5, centro: true, depois: 14 });
    else if (b.t === 'h') { garantir(40); paragrafo(b.texto, { tam: 10.5, negrito: true, just: false, antes: 6, depois: 4 }); }
    else if (b.t === 'p') paragrafo(b.texto, { negrito: !!b.negrito });
    else if (b.t === 'li') paragrafo(b.texto, { recuo: 18, marcador: b.marcador || '•', depois: 3 });
    else if (b.t === 'espaco') y -= b.h || 10;
    else if (b.t === 'quadro') {   // pares rótulo: valor
      for (const [r, v] of b.itens) { const ls = quebrar(String(v || '—'), 10, false, UTIL - 150); garantir(ls.length * 14 + 2);
        y -= 14; texto(ME, y, r, 9.5, true); ls.forEach((l, i) => { if (i) y -= 14; texto(ME + 150, y, l, 10, false); }); }
      y -= 8;
    } else if (b.t === 'assinaturas') {
      const cols = 2, gap = 30, lw = (UTIL - gap) / cols;
      garantir(Math.ceil(b.itens.length / cols) * 80 + (b.local ? 40 : 0));
      if (b.local) paragrafo(b.local, { just: false, antes: 6, depois: 4 });
      for (let i = 0; i < b.itens.length; i += cols) {
        garantir(78); y -= 46;
        b.itens.slice(i, i + cols).forEach((a, k) => { const x = ME + k * (lw + gap); linhaH(x, x + lw, y);
          quebrar(a.nome, 9, true, lw).slice(0, 2).forEach((l, j) => texto(x, y - 12 - j * 11, l, 9, true));
          if (a.detalhe) texto(x, y - 12 - Math.min(2, quebrar(a.nome, 9, true, lw).length) * 11, a.detalhe, 8.5, false); });
        y -= 34;
      }
    }
  }
  novaPagina();
  // monta o arquivo
  const objs = []; const add = s => { objs.push(s); return objs.length; };
  const catalogo = add(''); const pags = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  paginas.forEach((p, i) => {
    const rod = `${rodape ? rodape + '   ·   ' : ''}Página ${i + 1} de ${paginas.length}`;
    const conteudo = [...p, `0.6 g BT /F1 8 Tf ${(ME + (UTIL - largura(rod, 8)) / 2).toFixed(2)} 32 Td (${codificar(rod)}) Tj ET 0 g`].join('\n');
    const buf = Buffer.from(conteudo, 'latin1');
    const c = add(`<< /Length ${buf.length} >>\nstream\n${buf.toString('latin1')}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pags} 0 R /MediaBox [0 0 ${LARG} ${ALT}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[catalogo - 1] = `<< /Type /Catalog /Pages ${pags} 0 R >>`;
  objs[pags - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${codificar(titulo)}) /Producer (Meu Fiscal) >>`);
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
