/**
 * =====================================================================
 * HES CMMS — ZAMANLAYICI SERVİSİ (SCHEDULER)
 * Rev. 1.0 — Eylül 2026
 *
 * Bu betik, hes_cmms_schema.sql şemasına göre çalışan, GÜNDE BİR KEZ
 * (örn. her gün 06:00'da) tetiklenmesi gereken arka plan işidir.
 * Üç görevi vardır:
 *
 *   1) generateUpcomingTasks()  — Aktif bakim_plani kayıtlarından,
 *      periyoduna göre sırası gelen bakim_gorevi kayıtlarını üretir.
 *   2) sendReminders()          — Planlanan tarihi yaklaşan görevler
 *      için kullanıcıya hatırlatma bildirimi gönderir.
 *   3) markOverdueAndEscalate() — Tarihi geçmiş, hâlâ tamamlanmamış
 *      görevleri "GECIKTI" yapar ve sorumluya ikinci bir uyarı gönderir.
 *
 * Çalıştırma:
 *   node hes_cmms_scheduler.js
 *
 * Zamanlama (iki seçenek):
 *   a) İşletim sistemi cron'u:  0 6 * * *  node /path/hes_cmms_scheduler.js
 *   b) node-cron ile uygulama içinden (bkz. dosya sonundaki örnek).
 *
 * Bağımlılıklar:  npm install pg
 * (Bildirim gönderimi için ayrıca: npm install @sendgrid/mail  — veya
 *  tercih ettiğiniz SMS sağlayıcısının SDK'sı, örn. Netgsm.)
 * =====================================================================
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // örn: postgres://user:pass@host:5432/hes_cmms
});

// Bildirimin planlanan tarihten kaç gün önce gönderileceği
const HATIRLATMA_GUN_SAYISI = 2;

// Görev üretiminin bugünden itibaren kaç gün ileriye kadar yapılacağı
// (sistem birkaç gün kapalı kalsa bile geriden gelen periyotları da tamamlar)
const URETIM_UFKU_GUN = 14;

// ---------------------------------------------------------------------
// Periyot → tarih ekleme yardımcı fonksiyonu
// ---------------------------------------------------------------------
function periyotEkle(tarih, periyot) {
  const d = new Date(tarih);
  switch (periyot) {
    case "GUNLUK":
      d.setDate(d.getDate() + 1);
      break;
    case "HAFTALIK":
      d.setDate(d.getDate() + 7);
      break;
    case "AYLIK":
      d.setMonth(d.getMonth() + 1);
      break;
    case "UC_AYLIK":
      d.setMonth(d.getMonth() + 3);
      break;
    case "ALTI_AYLIK":
      d.setMonth(d.getMonth() + 6);
      break;
    case "YILLIK":
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      throw new Error(`Bilinmeyen periyot tipi: ${periyot}`);
  }
  return d;
}

function tarihStr(d) {
  return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ---------------------------------------------------------------------
// Bildirim gönderme — burası bir SOYUTLAMA (abstraction). Gerçek
// e-posta/SMS entegrasyonunu (SendGrid, Netgsm vb.) buraya bağlayın.
// ---------------------------------------------------------------------
async function bildirimGonder({ tip, aliciEposta, aliciTelefon, konu, icerik }) {
  if (tip === "EPOSTA") {
    // TODO: gerçek e-posta gönderimi (örn. SendGrid)
    // await sgMail.send({ to: aliciEposta, from: 'bakim@sizinsistem.com', subject: konu, text: icerik });
    console.log(`[EPOSTA → ${aliciEposta}] ${konu}: ${icerik}`);
  } else if (tip === "SMS") {
    // TODO: gerçek SMS gönderimi (örn. Netgsm)
    console.log(`[SMS → ${aliciTelefon}] ${icerik}`);
  }
  // Gönderim başarısız olursa burada catch edip 'BASARISIZ' durumuyla
  // kaydedebilirsiniz; sadeleştirmek için bu taslakta her zaman başarılı varsayılmıştır.
  return { basarili: true };
}

// =======================================================================
// 1) SIRASI GELEN GÖREVLERİ ÜRET
// =======================================================================
async function generateUpcomingTasks(client) {
  const bugun = new Date();
  const ufuk = new Date();
  ufuk.setDate(bugun.getDate() + URETIM_UFKU_GUN);

  const { rows: planlar } = await client.query(`
    SELECT plan_id, santral_id, periyot, baslangic_tarihi, bitis_tarihi, sorumlu_kullanici_id
    FROM bakim_plani
    WHERE aktif_mi = TRUE
      AND (bitis_tarihi IS NULL OR bitis_tarihi >= CURRENT_DATE)
  `);

  let uretilenSayisi = 0;

  for (const plan of planlar) {
    // Bu plan için üretilmiş en son görevin tarihini bul
    const { rows: sonGorevRows } = await client.query(
      `SELECT MAX(planlanan_tarih) AS son_tarih FROM bakim_gorevi WHERE plan_id = $1`,
      [plan.plan_id]
    );
    let sonrakiTarih = sonGorevRows[0].son_tarih
      ? periyotEkle(sonGorevRows[0].son_tarih, plan.periyot)
      : new Date(plan.baslangic_tarihi);

    // Ufuk tarihine kadar (ve varsa plan bitiş tarihine kadar) eksik olan
    // tüm görevleri sırayla üret — sistem birkaç gün durmuş olsa bile açığı kapatır.
    while (
      sonrakiTarih <= ufuk &&
      (!plan.bitis_tarihi || sonrakiTarih <= new Date(plan.bitis_tarihi))
    ) {
      const sonuc = await client.query(
        `INSERT INTO bakim_gorevi (plan_id, atanan_kullanici_id, planlanan_tarih, durum)
         VALUES ($1, $2, $3, 'BEKLIYOR')
         ON CONFLICT (plan_id, planlanan_tarih) DO NOTHING
         RETURNING gorev_id`,
        [plan.plan_id, plan.sorumlu_kullanici_id, tarihStr(sonrakiTarih)]
      );
      if (sonuc.rowCount > 0) uretilenSayisi++;

      sonrakiTarih = periyotEkle(sonrakiTarih, plan.periyot);
    }
  }

  console.log(`[generateUpcomingTasks] ${uretilenSayisi} yeni görev üretildi.`);
  return uretilenSayisi;
}

// =======================================================================
// 2) YAKLAŞAN GÖREVLER İÇİN HATIRLATMA GÖNDER
// =======================================================================
async function sendReminders(client) {
  const { rows: gorevler } = await client.query(
    `
    SELECT g.gorev_id, g.planlanan_tarih, g.atanan_kullanici_id,
           k.eposta, k.telefon, k.ad_soyad,
           s.ad AS santral_adi, bs.ad AS sablon_adi
    FROM bakim_gorevi g
    JOIN kullanici k        ON k.kullanici_id = g.atanan_kullanici_id
    JOIN bakim_plani bp     ON bp.plan_id = g.plan_id
    JOIN santral s          ON s.santral_id = bp.santral_id
    JOIN bakim_sablonu bs   ON bs.sablon_id = bp.sablon_id
    WHERE g.durum = 'BEKLIYOR'
      AND g.planlanan_tarih <= CURRENT_DATE + $1::int
      AND g.son_bildirim_tarihi IS NULL
    `,
    [HATIRLATMA_GUN_SAYISI]
  );

  let gonderilenSayisi = 0;

  for (const g of gorevler) {
    const icerik = `${g.santral_adi} – ${g.sablon_adi} bakımı ${g.planlanan_tarih.toISOString().slice(0, 10)} tarihinde planlandı.`;

    await bildirimGonder({
      tip: "EPOSTA",
      aliciEposta: g.eposta,
      konu: "Yaklaşan Bakım Hatırlatması",
      icerik,
    });

    await client.query(
      `INSERT INTO bildirim (gorev_id, alici_kullanici_id, tip, icerik_ozeti, durum)
       VALUES ($1, $2, 'EPOSTA', $3, 'GONDERILDI')`,
      [g.gorev_id, g.atanan_kullanici_id, icerik]
    );

    await client.query(
      `UPDATE bakim_gorevi SET son_bildirim_tarihi = now() WHERE gorev_id = $1`,
      [g.gorev_id]
    );

    gonderilenSayisi++;
  }

  console.log(`[sendReminders] ${gonderilenSayisi} hatırlatma gönderildi.`);
  return gonderilenSayisi;
}

// =======================================================================
// 3) GECİKMİŞ GÖREVLERİ İŞARETLE VE SORUMLUYA UYARI GÖNDER
// =======================================================================
async function markOverdueAndEscalate(client) {
  const { rows: gecikenler } = await client.query(`
    UPDATE bakim_gorevi
    SET durum = 'GECIKTI'
    WHERE durum = 'BEKLIYOR'
      AND planlanan_tarih < CURRENT_DATE
    RETURNING gorev_id, plan_id, atanan_kullanici_id, planlanan_tarih
  `);

  let uyariSayisi = 0;

  for (const g of gecikenler) {
    // Görevi hem atanan kullanıcıya hem de planın sorumlusuna (amirine) bildir
    const { rows: alicilar } = await pool.query(
      `
      SELECT DISTINCT k.kullanici_id, k.eposta, k.ad_soyad
      FROM kullanici k
      WHERE k.kullanici_id = $1
         OR k.kullanici_id = (SELECT sorumlu_kullanici_id FROM bakim_plani WHERE plan_id = $2)
      `,
      [g.atanan_kullanici_id, g.plan_id]
    );

    const { rows: detay } = await pool.query(
      `
      SELECT s.ad AS santral_adi, bs.ad AS sablon_adi
      FROM bakim_plani bp
      JOIN santral s ON s.santral_id = bp.santral_id
      JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
      WHERE bp.plan_id = $1
      `,
      [g.plan_id]
    );
    const { santral_adi, sablon_adi } = detay[0];
    const icerik = `${santral_adi} – ${sablon_adi} bakımı gecikmiş durumda (planlanan tarih: ${tarihStr(g.planlanan_tarih)}).`;

    for (const alici of alicilar) {
      await bildirimGonder({
        tip: "EPOSTA",
        aliciEposta: alici.eposta,
        konu: "Gecikmiş Bakım Uyarısı",
        icerik,
      });

      await client.query(
        `INSERT INTO bildirim (gorev_id, alici_kullanici_id, tip, icerik_ozeti, durum)
         VALUES ($1, $2, 'EPOSTA', $3, 'GONDERILDI')`,
        [g.gorev_id, alici.kullanici_id, icerik]
      );
      uyariSayisi++;
    }
  }

  console.log(`[markOverdueAndEscalate] ${gecikenler.length} görev gecikti olarak işaretlendi, ${uyariSayisi} uyarı gönderildi.`);
  return { gecikenSayisi: gecikenler.length, uyariSayisi };
}

// =======================================================================
// ANA ÇALIŞTIRICI
// =======================================================================
async function run() {
  const client = await pool.connect();
  try {
    console.log(`\n=== HES CMMS Zamanlayıcı — ${new Date().toISOString()} ===`);
    await generateUpcomingTasks(client);
    await sendReminders(client);
    await markOverdueAndEscalate(client);
    console.log("=== Tamamlandı ===\n");
  } catch (err) {
    console.error("Zamanlayıcı hatası:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run();
}

module.exports = { generateUpcomingTasks, sendReminders, markOverdueAndEscalate, periyotEkle };

/**
 * =====================================================================
 * UYGULAMA İÇİNDEN ZAMANLAMA — node-cron ÖRNEĞİ (isteğe bağlı)
 * OS cron yerine, backend sürekli çalışan bir Node.js sürecine
 * gömülü zamanlayıcı istiyorsanız aşağıdakini ayrı bir dosyada kullanın:
 *
 *   npm install node-cron
 *
 *   const cron = require("node-cron");
 *   const { generateUpcomingTasks, sendReminders, markOverdueAndEscalate } = require("./hes_cmms_scheduler");
 *   const { Pool } = require("pg");
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 *   // Her gün saat 06:00'da (sunucu saat dilimine göre) çalışır
 *   cron.schedule("0 6 * * *", async () => {
 *     const client = await pool.connect();
 *     try {
 *       await generateUpcomingTasks(client);
 *       await sendReminders(client);
 *       await markOverdueAndEscalate(client);
 *     } finally {
 *       client.release();
 *     }
 *   });
 * =====================================================================
 */
