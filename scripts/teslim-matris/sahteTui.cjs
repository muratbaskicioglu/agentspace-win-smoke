'use strict';
// TESLIM-MATRIS-01 — SAHTE TUI (tabloda "SAHTE" yazar). Gerçek pty'nin öbür ucunda koşar:
// köşeli yapıştırmayı açar, kutuya yazılanı çizer, Enter'da kutuyu boşaltır. Her stdin parçasını
// ve her gönderilen mesajı deftere ham yazar; hüküm bu defterden çıkar, ekrandan değil.
const fs = require('node:fs');

const LOG = process.argv[2];
const yaz = (o) => fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`);
let kutu = '';
let yapistir = false;
let kuyruk = '';

function ciz() {
  const satirlar = kutu.split('\n');
  const son = satirlar[satirlar.length - 1].slice(-90);
  process.stdout.write(`\x1b[2J\x1b[H AgentSpace sahte motor\r\n\r\n ctrl+x komutlar\r\n> ${satirlar.length > 1 ? `[Pasted text +${satirlar.length - 1} lines] ` : ''}${son}`);
}

function isle(d) {
  yaz({ ham: d });
  let t = kuyruk + d;
  kuyruk = '';
  while (t.length) {
    if (t.startsWith('\x1b[200~')) { yapistir = true; t = t.slice(6); continue; }
    if (t.startsWith('\x1b[201~')) { yapistir = false; t = t.slice(6); continue; }
    if (t[0] === '\x1b' && t.length < 6) { kuyruk = t; break; }
    const ch = t[0];
    t = t.slice(1);
    if (!yapistir && ch === '\r') {
      if (kutu) { yaz({ mesaj: kutu }); kutu = ''; } else yaz({ bos_enter: true });
    } else if (!yapistir && ch === '\x15') kutu = '';
    else if (!yapistir && ch === '\x03') process.exit(0);
    else kutu += ch === '\r' ? '\n' : ch;
  }
  ciz();
}

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004h');
ciz();
process.stdin.on('data', isle);
setInterval(() => {}, 1 << 30);
