'use strict';
// TESLIM-MATRIS-01 — sohbet teslim matrisinin TEK kaynağı: mesaj × giriş × motor × işletim sistemi
// ve hücre hükmü. SAF, bağımlılıksız; hem kapı (ana depo) hem prob (test deposuna kopyalanır) okur.
// Metinler sabit ve kişisel veri içermez: ham baytlar herkese açık artefakta düşer.

const TR = 'Şu işi bugün çözelim: müşterinin ödeme ekranındaki güncelleme çalışmıyor, ığüşöç İĞÜŞÖÇ harfleri doğru görünsün ve sonuçları bana yaz. ';

// `ilkis` metni src/app/i18n/dictionaries/tr.ts `ilkIs.is.kod.sade.metin` ile birebir (katalog testi denetler).
const ILKIS_ANAHTARI = 'ilkIs.is.kod.sade.metin';
const ILKIS_METNI = 'Projemdeki hataları bulup onarın. Önce tek soruda sor: proje klasörü ve projenin ne yaptığı tek cümleyle. Sonra kısa bir plan yaz (kim ne yapacak, ne kadar sürer) ve onayımı al; onaydan sonra işi ekibe dağıt. Onarımı ayrı bir dalda yap. Sonucu ne bozuktu, ne onarıldı, nasıl denendi diye anlatan tek bir rapor olarak getir; web sitesiyse yerelde çalıştırıp Tarayıcı sekmesinde göster.';

const MESAJLAR = Object.freeze({
  kisa: { ad: 'kısa', govde: 'Merhaba, durum nedir?' },
  turkce: { ad: 'Türkçe karakterli', govde: 'Çok güzel, şöyle yapalım: İĞÜŞÖÇ ığüşöç tamam mı?' },
  coksatir: { ad: 'çok satırlı', govde: 'Birinci satır: ödeme\nİkinci satır: güncelleme\nÜçüncü satır: tamam' },
  uzun256: { ad: '>256 bayt', govde: TR.repeat(3).trim() },
  uzun4k: { ad: '>4 KB', govde: TR.repeat(36).trim() },
  onay: { ad: 'onay cevabı', govde: 'Evet, onayladım', acikSoru: 'Bu değişikliği yayına alalım mı?' },
  ilkis: { ad: 'ilk iş promptu', govde: ILKIS_METNI },
});

// `rol`: mesajın düştüğü terminal. `metin(g)`: müşterinin kutuya yazdığı ham metin.
const GIRISLER = Object.freeze({
  hedefsiz: { ad: 'hedefsiz', rol: 'lider', metin: (g) => g },
  ajan: { ad: 'ajan adı', rol: 'calisan', metin: (g) => `@Ayşe ${g}` },
  duzeltme: { ad: 'Düzeltme iste', rol: 'calisan', metin: (g) => `@Ayşe TM-1 için: ${g}`, duzeltme: true },
  tel_lider: { ad: 'telefon', rol: 'lider', metin: (g) => g, kaynak: 'mobile' },
  tel_calisan: { ad: 'telefon + ajan adı', rol: 'calisan', metin: (g) => `@Ayşe ${g}`, kaynak: 'mobile' },
});

// `gercek`: tabloya aynen yazılan etiket. Gerçek modele hiçbir hücrede gidilmiyor.
const MOTORLAR = Object.freeze({
  claude: { ad: 'Claude Code', gercek: 'gerçek CLI, sahte anahtar, yerel yakalayıcı' },
  codex: { ad: 'Codex', gercek: 'gerçek CLI, sahte anahtar, yerel yakalayıcı' },
  opencode: { ad: 'OpenCode', gercek: 'gerçek CLI, sahte anahtar, yerel yakalayıcı' },
  antigravity: { ad: 'Antigravity', gercek: 'SAHTE TUI (agy giriş hesabı yok, gerçek agy koşulamadı)' },
});

// `zorunlu`: kapı bu kulvarı Latest için şart koşar. `kol`: nerede, ne ile koşar.
const KULVARLAR = Object.freeze([
  { id: 'windows-2025', ad: 'Windows Server 2025', kol: 'public', zorunlu: true },
  { id: 'windows-2022', ad: 'Windows Server 2022', kol: 'public', zorunlu: true },
  { id: 'windows-11-arm', ad: 'Windows 11 arm64', kol: 'public', zorunlu: true },
  { id: 'macos-15', ad: 'macOS 15 arm64', kol: 'public', zorunlu: true },
  { id: 'macos-26', ad: 'macOS 26 arm64', kol: 'public', zorunlu: true },
  { id: 'ubuntu-24.04', ad: 'Linux x64', kol: 'public', zorunlu: true },
  { id: 'ubuntu-24.04-arm', ad: 'Linux arm64', kol: 'public', zorunlu: true },
  { id: 'murat-win', ad: 'Windows 10 19045 (masaüstü)', kol: 'ozel', zorunlu: true },
  { id: 'bu-mac-14.6', ad: 'bu Mac, macOS 14.6', kol: 'yerel', zorunlu: false, not: 'yük yasağı: tek atım, sahte TUI; kapı saymaz' },
  { id: 'win11-x64-el', ad: 'Windows 11 x64 masaüstü', kol: 'el', zorunlu: false, not: 'ayrı el listesi' },
]);

const TEKRAR = 10;

/** Ürünün açık tavanı: telefon 4000 karakterden uzun metni "mesaj çok uzun" diye reddeder (mobileRoutes/chat.cjs). */
const UYGULANAMAZ = Object.freeze({
  'tel_lider|uzun4k': 'ürün telefondan 4000 karakter üstünü açıkça reddediyor',
  'tel_calisan|uzun4k': 'ürün telefondan 4000 karakter üstünü açıkça reddediyor',
});

const hucreKimligi = (motor, giris, mesaj) => `${motor}|${giris}|${mesaj}`;

/** Bir kulvarda ölçülecek tüm hücreler. */
function hucreler(motorlar = Object.keys(MOTORLAR)) {
  const out = [];
  for (const motor of motorlar) {
    for (const giris of Object.keys(GIRISLER)) {
      for (const mesaj of Object.keys(MESAJLAR)) {
        if (UYGULANAMAZ[`${giris}|${mesaj}`]) continue;
        out.push({ id: hucreKimligi(motor, giris, mesaj), motor, giris, mesaj, rol: GIRISLER[giris].rol });
      }
    }
  }
  return out;
}

const normal = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();

/**
 * Tek gönderimin hükmü. Girdi yalnız ÖLÇÜLEN baytlar; ürünün "iletildi" sözü hükme GİRMEZ.
 * gonderilen: ürünün terminale yazdırdığı metin · alinan: motorun aldığı mesajlar · govde: müşteri metni.
 */
function atimHukmu({ govde, gonderilen, alinan }) {
  const sebepler = [];
  const sent = normal(gonderilen);
  const got = (Array.isArray(alinan) ? alinan : []).map(normal).filter(Boolean);
  if (!sent) sebepler.push('urun_yazmadi');
  else if (!sent.includes(normal(govde))) sebepler.push('sarmalayici_govdeyi_kesti');
  if (sent) {
    if (got.length === 0) sebepler.push('gonderilmedi');
    else if (got.length > 1) sebepler.push('cift_mesaj');
    else if (got[0] !== sent) sebepler.push('bayt_farki');
  }
  let at = 0;
  const bir = got.length ? got[0] : '';
  while (at < bir.length && bir[at] === sent[at]) at++;
  return {
    gecti: sebepler.length === 0,
    sebepler,
    mesaj_sayisi: got.length,
    gonderilen_bayt: Buffer.byteLength(sent, 'utf8'),
    alinan_bayt: Buffer.byteLength(got.join('\n'), 'utf8'),
    ilk_fark: bir === sent ? null : { konum: at, gonderilen: sent.slice(Math.max(0, at - 20), at + 40), alinan: bir.slice(Math.max(0, at - 20), at + 40) },
  };
}

/**
 * Hücre hükmü: yeşil yalnız TEKRAR atımın TAMAMI geçtiyse. Bir atım bile geçmediyse kırmızı
 * (aralıklı kusur yeşil sayılmaz). Eksik atım = ölçülemedi; bu da yeşil değildir.
 */
function hucreHukmu(atimlar, tekrar = TEKRAR) {
  const list = Array.isArray(atimlar) ? atimlar : [];
  const gecen = list.filter((a) => a && a.gecti === true).length;
  const kalan = list.length - gecen;
  const durum = kalan > 0 ? 'kirmizi' : list.length >= tekrar ? 'yesil' : 'olculemedi';
  return { durum, atim: list.length, gecen };
}

module.exports = {
  MESAJLAR, GIRISLER, MOTORLAR, KULVARLAR, TEKRAR, UYGULANAMAZ, ILKIS_ANAHTARI, ILKIS_METNI,
  hucreKimligi, hucreler, normal, atimHukmu, hucreHukmu,
};
