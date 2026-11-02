'use strict';
// ACP-FAZ1-GOLGE-01 (AS-4584) — 10 gölge senaryosu. UYGULAMA KODU YOK (public test reposuna da kopyalanır).
//
// Her senaryo: istem(ler) + sahte modelin cevap betiği + GERÇEK (truth). İstemler yapay metindir;
// kişisel veri yok. İşaret `[SG-<id>-<tur>]` sahte modelin (oracle) istemi tanıdığı iğnedir.
//
// Model betiği adımları (aynı işaretin ardışık ana istekleri): adım 0 = kullanıcı istemi,
// adım 1 = araç sonucuyla dönüş. Her adım 0 isteği HOLD_MS bekletilir → "meşgul" kontrol noktası
// gerçekten uçuştaki bir tura denk gelir.

const HOLD_MS = 1200;

const LONG_TEXT = Array.from({ length: 80 }, (_, i) => `${String(i + 1).padStart(2, '0')}. satır — gölge kıyas uzun çıktı denemesi, sabit metin ${'x'.repeat(40)}`).join('\n');

const marker = (id, turn = 1) => `[SG-${id}-${turn}]`;

// İzin kipi: varsayılan 'bypass' = ÜRÜNÜN kipi (ekran: --dangerously-skip-permissions,
// ACP: session/set_mode bypassPermissions). `mode: 'default'` olan senaryo iki kolda da sorar.
/** @type {Array<{id:string, name:string, turns:string[], steps:Array<object>, truth:object, resume?:boolean, mode?:'bypass'|'default'}>} */
const SCENARIOS = [
  {
    id: 'S01', name: 'tek tur',
    turns: [`${marker('S01')} Tek tur: kısa bir cevap ver.`],
    steps: [{ text: 'Tamam, tek tur bitti.' }],
    truth: { menu: null, outcome: 'done' },
  },
  {
    id: 'S02', name: 'araç',
    turns: [`${marker('S02')} Klasördeki txt dosyalarını listele.`],
    steps: [{ tool: { name: 'Glob', input: { pattern: '*.txt' } } }, { text: 'Araç sonucu alındı.' }],
    truth: { menu: null, outcome: 'done', tool: true },
  },
  {
    id: 'S03', name: 'izin',
    // Ürün claude'u `--dangerously-skip-permissions` ile açar (engineRegistry defaultArgs) → üründe izin
    // menüsü çıkmaz. İzin KARARINI ölçmek için bu senaryo iki kolda da AÇIKÇA 'default' kipte koşar.
    // `echo` salt-okur sayılır ve sorulmadan geçer (ölçüldü 02.11, 2.1.316) → dosya yazan komut.
    mode: 'default',
    turns: [`${marker('S03')} Kabukta bir işaret dosyası oluştur.`],
    steps: [{ tool: { name: 'Bash', input: { command: 'touch golge-izin-ok.txt', description: 'Create a marker file' } } }, { text: 'Komut çalıştı.' }],
    truth: { menu: 'permission', outcome: 'done', tool: true },
  },
  {
    id: 'S04', name: 'soru',
    turns: [`${marker('S04')} Bana bir renk sor.`],
    steps: [{ tool: { name: 'AskUserQuestion', input: { questions: [{ question: 'Hangi rengi seçelim?', header: 'Renk', multiSelect: false, options: [{ label: 'Mavi', description: 'Sakin bir renk' }, { label: 'Yeşil', description: 'Canlı bir renk' }] }] } } }, { text: 'Seçim alındı.' }],
    truth: { menu: 'question', outcome: 'done', tool: true },
  },
  {
    id: 'S05', name: 'iptal',
    turns: [`${marker('S05')} Uzun sürecek bir iş yap.`],
    steps: [{ slow: { text: 'Uzun bir iş başlıyor', tickMs: 400, totalMs: 30000 } }],
    truth: { menu: null, outcome: 'cancelled' },
  },
  {
    id: 'S06', name: 'devam',
    resume: true,
    turns: [`${marker('S06', 1)} İlk tur: bunu hatırla.`, `${marker('S06', 2)} İkinci tur: önceki turu hatırlıyor musun?`],
    steps: [{ text: 'İlk tur tamam.' }],
    truth: { menu: null, outcome: 'done', resumeHistory: true },
  },
  {
    id: 'S07', name: 'limit',
    turns: [`${marker('S07')} Bu tur limite takılacak.`],
    steps: [{ limit: true }],
    truth: { menu: null, outcome: 'limit' },
  },
  {
    id: 'S08', name: 'uzun çıktı',
    turns: [`${marker('S08')} Uzun bir çıktı üret.`],
    steps: [{ text: LONG_TEXT, chunks: 40, chunkMs: 25 }],
    truth: { menu: null, outcome: 'done' },
  },
  {
    id: 'S09', name: 'çok satırlı mesaj',
    turns: [`${marker('S09')} Çok satırlı istek:\nbirinci satır\n- madde a\n- madde b\n\nson satır (boş satırdan sonra).`],
    steps: [{ text: 'Çok satırlı istek alındı.' }],
    truth: { menu: null, outcome: 'done' },
  },
  {
    id: 'S10', name: 'Türkçe mesaj',
    turns: [`${marker('S10')} Türkçe karakter denemesi: ığüşöç İĞÜŞÖÇ — “çift tırnak”, ‘tek tırnak’, «köşeli», 100₺ ve %50.`],
    steps: [{ text: 'Türkçe metin eksiksiz geldi: ığüşöç İĞÜŞÖÇ.' }],
    truth: { menu: null, outcome: 'done' },
  },
];

const MARKER_RE = /\[SG-(S\d\d)-(\d)\]/g;

module.exports = { SCENARIOS, HOLD_MS, MARKER_RE, marker };
