// Cliente PostgreSQL mínimo, sem dependências: TLS com SNI (Neon/Supabase), SCRAM-SHA-256,
// consultas parametrizadas (protocolo estendido), pool, transações e LISTEN/NOTIFY.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const PROTOCOLO = 196608;
const SSL_REQUEST = 80877103;

export function lerUrl(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') || (['localhost', '127.0.0.1', '::1'].includes(u.hostname) ? 'disable' : 'require');
  return {
    host: u.hostname, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1) || u.username),
    ssl: sslmode !== 'disable',
    sslVerificar: ['verify-full', 'verify-ca'].includes(sslmode) || process.env.PG_SSL_VERIFICAR === '1',
    opcoes: u.searchParams.get('options') || null,
  };
}

export class ErroPg extends Error {
  constructor(campos) {
    super(campos.M || 'Erro do PostgreSQL');
    this.code = campos.C; this.detail = campos.D; this.constraint = campos.n; this.severity = campos.S;
  }
}

/* ---------- conversão de tipos (formato texto) ---------- */
const INTEIROS = new Set([20, 21, 23, 26]);
const DECIMAIS = new Set([700, 701, 1700]);
function converter(oid, v) {
  if (v === null) return null;
  if (oid === 16) return v === 't';
  if (oid === 17) return Buffer.from(v.slice(2), 'hex');            // bytea
  if (INTEIROS.has(oid) || DECIMAIS.has(oid)) return Number(v);
  if (oid === 114 || oid === 3802) return JSON.parse(v);
  if (oid === 1184 || oid === 1114) {
    const iso = v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00').replace(/([+-]\d\d)(\d\d)$/, '$1:$2') + (oid === 1114 ? 'Z' : '');
    const d = new Date(iso); return isNaN(d) ? v : d.toISOString();
  }
  if (oid === 1009 || oid === 1015) return lerArray(v);
  return v;
}
function lerArray(s) {
  if (s === '{}') return [];
  const out = []; let i = 1, atual = '', aspas = false, temAspas = false;
  for (; i < s.length - 1; i++) {
    const c = s[i];
    if (aspas) { if (c === '\\') { atual += s[++i]; } else if (c === '"') aspas = false; else atual += c; }
    else if (c === '"') { aspas = true; temAspas = true; }
    else if (c === ',') { out.push(!temAspas && atual === 'NULL' ? null : atual); atual = ''; temAspas = false; }
    else atual += c;
  }
  out.push(!temAspas && atual === 'NULL' ? null : atual);
  return out;
}
function serializar(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (Array.isArray(v)) return '{' + v.map(x => x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 't' : 'f';
  return String(v);
}

/* ---------- escrita de mensagens ---------- */
function msg(tipo, ...partes) {
  const corpo = Buffer.concat(partes.map(p => typeof p === 'string' ? Buffer.from(p + '\0', 'utf8') : p));
  const cab = Buffer.alloc(tipo ? 5 : 4);
  if (tipo) { cab.write(tipo, 0, 'latin1'); cab.writeInt32BE(corpo.length + 4, 1); }
  else cab.writeInt32BE(corpo.length + 4, 0);
  return Buffer.concat([cab, corpo]);
}
const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

/* ---------- conexão ---------- */
export class Conexao extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg; this.buf = Buffer.alloc(0); this.fila = []; this.atual = null; this.pronta = false; this.fechada = false;
  }

  async conectar() {
    const { host, port, ssl } = this.cfg;
    let sock = await new Promise((ok, falha) => {
      const s = net.connect({ host, port }); s.setNoDelay(true);
      s.once('connect', () => ok(s)); s.once('error', falha);
    });
    if (ssl) {
      sock.write(msg(null, i32(SSL_REQUEST)));
      const resp = await new Promise((ok, falha) => { sock.once('data', d => ok(d.toString('latin1', 0, 1))); sock.once('error', falha); });
      if (resp !== 'S') throw new Error('O servidor PostgreSQL não aceita TLS. Use sslmode=disable apenas em ambiente local.');
      sock = await new Promise((ok, falha) => {
        const t = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.cfg.sslVerificar });
        t.once('secureConnect', () => ok(t)); t.once('error', falha);
      });
    }
    this.sock = sock;
    sock.on('data', d => this.receber(d));
    sock.on('error', e => this.falhar(e));
    sock.on('close', () => this.falhar(new Error('Conexão com o PostgreSQL encerrada.')));
    const params = ['user', this.cfg.user, 'database', this.cfg.database, 'application_name', 'meu-fiscal-api', 'client_encoding', 'UTF8', 'TimeZone', 'UTC'];
    if (this.cfg.opcoes) params.push('options', this.cfg.opcoes);
    await new Promise((ok, falha) => {
      this.atual = { inicio: true, ok, falha };
      sock.write(msg(null, i32(PROTOCOLO), ...params, Buffer.from([0])));
    });
    this.pronta = true;
    return this;
  }

  falhar(e) {
    if (this.fechada) return;
    this.fechada = true; this.pronta = false;
    const pend = [this.atual, ...this.fila].filter(Boolean); this.atual = null; this.fila = [];
    pend.forEach(p => p.falha(e));
    this.emit('fechada', e);
  }

  fechar() { if (this.sock && !this.fechada) { try { this.sock.write(msg('X')); } catch { } this.sock.end(); } this.fechada = true; }

  receber(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const tipo = String.fromCharCode(this.buf[0]); const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const corpo = this.buf.subarray(5, len + 1); this.buf = this.buf.subarray(len + 1);
      try { this.tratar(tipo, corpo); } catch (e) { this.falhar(e); return; }
    }
  }

  tratar(tipo, b) {
    const a = this.atual;
    switch (tipo) {
      case 'R': return this.autenticar(b.readInt32BE(0), b.subarray(4));
      case 'S': case 'K': case 'N': case 't': case '1': case '2': case 'n': case 's': case 'I': return;
      case 'A': { // NOTIFY
        const pid = b.readInt32BE(0); let p = 4; const fim = () => { const z = b.indexOf(0, p); const s = b.toString('utf8', p, z); p = z + 1; return s; };
        const canal = fim(); const payload = fim(); this.emit('notificacao', { pid, canal, payload }); return;
      }
      case 'E': {
        const campos = {}; let p = 0;
        while (b[p] !== 0) { const k = String.fromCharCode(b[p]); const z = b.indexOf(0, p + 1); campos[k] = b.toString('utf8', p + 1, z); p = z + 1; }
        const erro = new ErroPg(campos);
        if (a && a.inicio) { this.atual = null; a.falha(erro); this.falhar(erro); return; }
        if (a) a.erro = erro; return;
      }
      case 'T': {
        const n = b.readInt16BE(0); let p = 2; const cols = [];
        for (let i = 0; i < n; i++) { const z = b.indexOf(0, p); const nome = b.toString('utf8', p, z); p = z + 1; const oid = b.readInt32BE(p + 6); p += 18; cols.push({ nome, oid }); }
        if (a) a.cols = cols; return;
      }
      case 'D': {
        if (!a || !a.cols) return; const n = b.readInt16BE(0); let p = 2; const linha = {};
        for (let i = 0; i < n; i++) { const len = b.readInt32BE(p); p += 4; const c = a.cols[i]; if (len === -1) linha[c.nome] = null; else { linha[c.nome] = converter(c.oid, b.toString('utf8', p, p + len)); p += len; } }
        a.linhas.push(linha); return;
      }
      case 'C': { if (a) { const t = b.toString('utf8', 0, b.length - 1); const m = t.match(/(\d+)$/); a.contagem = m ? Number(m[1]) : 0; } return; }
      case 'Z': {
        if (a && a.inicio) { this.atual = null; a.ok(); return; }
        this.atual = null;
        if (a) { if (a.erro) a.falha(a.erro); else { const r = a.linhas; r.count = a.contagem || 0; a.ok(r); } }
        this.proximo(); return;
      }
      default: return;
    }
  }

  autenticar(codigo, dados) {
    const { user, password } = this.cfg;
    if (codigo === 0) return;
    if (codigo === 3) { this.sock.write(msg('p', password)); return; }
    if (codigo === 5) {
      const md5 = s => crypto.createHash('md5').update(s).digest('hex');
      const interno = md5(password + user);
      this.sock.write(msg('p', 'md5' + md5(Buffer.concat([Buffer.from(interno), dados.subarray(0, 4)])))); return;
    }
    if (codigo === 10) {
      const mecs = dados.toString('utf8').split('\0').filter(Boolean);
      if (!mecs.includes('SCRAM-SHA-256')) throw new Error('Método de autenticação não suportado: ' + mecs.join(', '));
      this.scram = { nonce: crypto.randomBytes(18).toString('base64') };
      this.scram.primeiro = 'n=*,r=' + this.scram.nonce;
      const inicial = Buffer.from('n,,' + this.scram.primeiro);
      this.sock.write(msg('p', 'SCRAM-SHA-256', i32(inicial.length), inicial)); return;
    }
    if (codigo === 11) {
      const servidor = dados.toString('utf8');
      const at = Object.fromEntries(servidor.split(',').map(x => [x[0], x.slice(2)]));
      if (!at.r.startsWith(this.scram.nonce)) throw new Error('Resposta SCRAM inválida.');
      const salgada = crypto.pbkdf2Sync(password.normalize('NFKC'), Buffer.from(at.s, 'base64'), Number(at.i), 32, 'sha256');
      const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
      const chaveCliente = hmac(salgada, 'Client Key');
      const armazenada = crypto.createHash('sha256').update(chaveCliente).digest();
      const semProva = 'c=biws,r=' + at.r;
      const authMsg = this.scram.primeiro + ',' + servidor + ',' + semProva;
      const assinatura = hmac(armazenada, authMsg);
      const prova = Buffer.from(chaveCliente.map((x, i) => x ^ assinatura[i]));
      this.scram.assinaturaServidor = hmac(hmac(salgada, 'Server Key'), authMsg).toString('base64');
      this.sock.write(msg('p', Buffer.from(semProva + ',p=' + prova.toString('base64')))); return;
    }
    if (codigo === 12) {
      const v = dados.toString('utf8').match(/v=([^,]+)/);
      if (!v || v[1] !== this.scram.assinaturaServidor) throw new Error('Assinatura do servidor PostgreSQL não confere.');
      return;
    }
    throw new Error('Autenticação PostgreSQL não suportada (código ' + codigo + ').');
  }

  consultar(texto, params = []) {
    if (this.fechada) return Promise.reject(new Error('Conexão fechada.'));
    return new Promise((ok, falha) => { this.fila.push({ texto, params, ok, falha, linhas: [] }); if (!this.atual) this.proximo(); });
  }

  proximo() {
    if (this.atual || !this.fila.length || this.fechada) return;
    const q = this.atual = this.fila.shift();
    const vals = q.params.map(serializar);
    const bind = [Buffer.from('\0\0'), i16(0), i16(vals.length), ...vals.flatMap(v => v === null ? [i32(-1)] : (() => { const b = Buffer.from(v, 'utf8'); return [i32(b.length), b]; })()), i16(0)];
    this.sock.write(Buffer.concat([
      msg('P', '', q.texto, i16(0)),
      msg('B', ...bind),
      msg('D', Buffer.from('P\0')),
      msg('E', Buffer.from('\0'), i32(0)),
      msg('S'),
    ]));
  }
}

/* ---------- pool ---------- */
export function criarPool(url, { max = 5, ociosoMs = 30000 } = {}) {
  const cfg = lerUrl(url);
  const livres = []; const espera = []; let total = 0;

  async function pegar() {
    while (livres.length) { const c = livres.pop(); clearTimeout(c._ocioso); if (!c.fechada) return c; total--; }
    if (total < max) {
      total++;
      try { const c = await new Conexao(cfg).conectar(); c.on('fechada', () => { const i = livres.indexOf(c); if (i >= 0) { livres.splice(i, 1); total--; } else c._morta = true; }); return c; }
      catch (e) { total--; throw e; }
    }
    return new Promise((ok, falha) => espera.push({ ok, falha }));
  }
  function devolver(c) {
    if (c.fechada || c._morta) { total--; if (espera.length) pegar().then(espera.shift().ok, e => espera.shift()?.falha(e)); return; }
    if (espera.length) return espera.shift().ok(c);
    c._ocioso = setTimeout(() => { const i = livres.indexOf(c); if (i >= 0) { livres.splice(i, 1); total--; c.fechar(); } }, ociosoMs);
    livres.push(c);
  }

  async function query(texto, params) {
    const c = await pegar();
    try { return await c.consultar(texto, params); } finally { devolver(c); }
  }
  async function tx(fn) {
    const c = await pegar();
    try {
      await c.consultar('BEGIN');
      const q = (t, p) => c.consultar(t, p);
      const r = await fn(q);
      await c.consultar('COMMIT');
      return r;
    } catch (e) {
      if (!c.fechada) await c.consultar('ROLLBACK').catch(() => { });
      throw e;
    } finally { devolver(c); }
  }
  async function encerrar() { livres.splice(0).forEach(c => { clearTimeout(c._ocioso); c.fechar(); }); }
  return { query, tx, encerrar, cfg };
}

/* ---------- LISTEN com reconexão automática ---------- */
export function ouvir(url, canal, aoNotificar, aoReconectar) {
  const cfg = lerUrl(url); let c = null; let tentativa = 0; let parar = false;
  async function abrir() {
    if (parar) return;
    try {
      c = await new Conexao(cfg).conectar();
      c.on('notificacao', n => { if (n.canal === canal) aoNotificar(n.payload); });
      c.on('fechada', () => { if (!parar) setTimeout(abrir, Math.min(30000, 1000 * 2 ** tentativa++)); });
      await c.consultar(`LISTEN "${canal.replace(/"/g, '')}"`);
      // mantém a conexão viva atrás de poolers/NAT
      c._batida = setInterval(() => c.consultar('SELECT 1').catch(() => { }), 60000);
      c.on('fechada', () => clearInterval(c._batida));
      aoReconectar?.();   // na primeira conexão e nas seguintes: quem já está conectado recarrega o que pode ter perdido
      tentativa = 0;
    } catch (e) {
      console.error('[tempo-real] falha ao escutar o banco:', e.message);
      setTimeout(abrir, Math.min(30000, 1000 * 2 ** tentativa++));
    }
  }
  abrir();
  return { parar: () => { parar = true; if (c) { clearInterval(c._batida); c.fechar(); } } };
}
