const express = require("express");
const PDFDocument = require("pdfkit");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");
// Çoklu sorgulu transaction'lar (BEGIN/COMMIT/ROLLBACK) için TEK BİR
// bağlantı (client) gerekiyor — bu yüzden pool'u doğrudan içe aktarıp
// pool.connect() ile özel bir client alıyoruz (bkz. Malzeme Giriş ve
// Çıkış Onaylama route'ları).
const { pool } = require("../db");

const router = express.Router();
router.use(requireAuth, withDbContext);

// Roller: sırayla en geniş yetkiye sahip olandan en dara.
const GIRIS_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];
const CIKIS_TALEP_ROLLERI = ["SAHA_PERSONELI", "SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];
const CIKIS_ONAY_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];
// Depo Malzeme Listesi'ni herkes (İzleyici dahil) görebilir — bu yüzden
// ayrıca bir rol listesi yok, yalnızca "bu santrale erişimi var mı" kontrolü
// yeterli.

async function santralErisimVarMi(req, santral_id) {
  if (req.user.rol === "ADMIN") return true;
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

async function erisimYoksaReddet(req, res, santral_id) {
  if (!(await santralErisimVarMi(req, santral_id))) {
    res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    return true;
  }
  return false;
}

// Kritik stok altına düşen bir malzeme için Santral Sorumlusu(lar)ı ve
// İşletme Admin(ler)ini mesaj kutusuyla uyarır. Mesajlaşma tablosunun tam
// yapısı bu ortamda doğrulanamadığı için bu fonksiyon KENDİ try/catch'i
// içinde çalışır — burada bir hata olsa bile giriş/çıkış işleminin kendisi
// ETKİLENMEZ, yalnızca konsola loglanır. Eğer uyarı mesajları gelmiyorsa,
// bu fonksiyonun içeriğini gerçek `mesaj` tablonuzun şemasına göre
// güncellememiz gerekebilir.
async function kritikStokUyarisiGonder(req, malzeme) {
  try {
    if (malzeme.kritik_stok_miktari == null) return;
    if (Number(malzeme.mevcut_miktar) >= Number(malzeme.kritik_stok_miktari)) return;

    const { rows: aliciRows } = await req.db.query(
      `SELECT DISTINCT k.kullanici_id
       FROM kullanici k
       WHERE k.aktif_mi = TRUE
         AND (
           (k.rol = 'SANTRAL_SORUMLUSU' AND k.kullanici_id IN (
             SELECT kullanici_id FROM v_kullanici_yetkili_santraller WHERE santral_id = $1
           ))
           OR (k.rol = 'ISLETME_ADMIN' AND k.isletme_id = (SELECT isletme_id FROM santral WHERE santral_id = $1))
         )`,
      [malzeme.santral_id]
    );

    const mesajMetni = `"${malzeme.ad}" kritik stok miktarının altına düşmüştür. (Mevcut: ${malzeme.mevcut_miktar} ${malzeme.birim}, Kritik sınır: ${malzeme.kritik_stok_miktari} ${malzeme.birim})`;

    for (const alici of aliciRows) {
      await req.db.query(
        `INSERT INTO mesaj (gonderen_kullanici_id, alici_kullanici_id, konu, icerik)
         VALUES (NULL, $1, 'Kritik Stok Uyarısı', $2)`,
        [alici.kullanici_id, mesajMetni]
      );
    }
  } catch (err) {
    console.error("Kritik stok uyarı mesajı gönderilemedi (mesaj tablosu şeması doğrulanmalı):", err.message);
  }
}

// Bir çıkış talebi reddedilince, talebi yapan kullanıcıya bildirim gönderir.
// Aynı şekilde kendi try/catch'i içinde — başarısız olsa bile reddetme
// işleminin kendisini ETKİLEMEZ.
async function cikisRedBildirimiGonder(req, talep) {
  try {
    const mesajMetni = talep.red_notu
      ? `"${talep.malzeme_adi}" (${talep.miktar} ${talep.birim}) için çıkış talebiniz onaylanmamıştır. Not: ${talep.red_notu}`
      : `"${talep.malzeme_adi}" (${talep.miktar} ${talep.birim}) için çıkış talebiniz onaylanmamıştır.`;
    await req.db.query(
      `INSERT INTO mesaj (gonderen_kullanici_id, alici_kullanici_id, konu, icerik)
       VALUES ($1, $2, 'İsteğiniz Onaylanmamıştır', $3)`,
      [req.user.kullanici_id, talep.talep_eden_kullanici_id, mesajMetni]
    );
  } catch (err) {
    console.error("Çıkış red bildirimi gönderilemedi (mesaj tablosu şeması doğrulanmalı):", err.message);
  }
}

// ---------------------------------------------------------------------
// DEPO MALZEME LİSTESİ — herkes (santrale erişimi olan herkes) görebilir.
// ---------------------------------------------------------------------
router.get("/santraller/:santral_id/depo/malzemeler", async (req, res, next) => {
  try {
    if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;
    const { rows } = await req.db.query(
      `SELECT * FROM depo_malzeme WHERE santral_id = $1 ORDER BY ad`,
      [req.params.santral_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/depo/malzemeler/:malzeme_id — TEK bir malzemeyi santral
// bilgisi dahil döner. Karekod okutulunca açılan çıkış-talep sayfası,
// hangi santralde olduğunu önceden bilmeden yalnızca malzeme_id ile bu
// uç noktayı kullanır.
router.get("/depo/malzemeler/:malzeme_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM depo_malzeme WHERE malzeme_id = $1`, [
      req.params.malzeme_id,
    ]);
    const malzeme = rows[0];
    if (!malzeme) {
      return res.status(404).json({ hata_kodu: "MALZEME_BULUNAMADI", mesaj: "Malzeme bulunamadı." });
    }
    if (await erisimYoksaReddet(req, res, malzeme.santral_id)) return;
    res.json(malzeme);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// MALZEME GİRİŞ — Santral Sorumlusu ve üstü.
// ---------------------------------------------------------------------
router.post(
  "/santraller/:santral_id/depo/giris",
  requireRole(...GIRIS_ROLLERI),
  async (req, res, next) => {
    let client;
    try {
      if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;

      const { sku, ad, barkod, birim, miktar, kritik_stok_miktari, konum } = req.body;
      if (!sku || !ad || !birim || miktar == null) {
        return res.status(400).json({
          hata_kodu: "EKSIK_ALAN",
          mesaj: "sku, ad, birim ve miktar alanları zorunludur.",
        });
      }
      if (Number(miktar) <= 0) {
        return res.status(400).json({ hata_kodu: "GECERSIZ_MIKTAR", mesaj: "Miktar sıfırdan büyük olmalıdır." });
      }

      // ÖNEMLİ: BEGIN/COMMIT/ROLLBACK'in aynı bağlantı üzerinde çalışması
      // ZORUNLU — paylaşılan pool.query() her çağrıda FARKLI bir bağlantı
      // kullanabileceği için (önceki sürümdeki hata buydu ve isteğin
      // sonsuza kadar asılı kalmasına yol açıyordu), burada tek bir
      // client (pool.connect()) alıp TÜM sorguları onun üzerinden
      // yürütüyoruz.
      client = await pool.connect();
      await client.query("BEGIN");
      try {
        // Malzeme bu santralde daha önce tanımlanmışsa üzerine ekle, yoksa
        // yeni oluştur.
        const { rows: mevcutRows } = await client.query(
          `SELECT * FROM depo_malzeme WHERE santral_id = $1 AND sku = $2 FOR UPDATE`,
          [req.params.santral_id, sku]
        );

        let malzeme;
        if (mevcutRows[0]) {
          const { rows } = await client.query(
            `UPDATE depo_malzeme
             SET mevcut_miktar = mevcut_miktar + $1,
                 ad = $2,
                 barkod = COALESCE($3, barkod),
                 birim = $4,
                 kritik_stok_miktari = COALESCE($5, kritik_stok_miktari),
                 konum = COALESCE($6, konum)
             WHERE malzeme_id = $7
             RETURNING *`,
            [miktar, ad, barkod || null, birim, kritik_stok_miktari ?? null, konum || null, mevcutRows[0].malzeme_id]
          );
          malzeme = rows[0];
        } else {
          const { rows } = await client.query(
            `INSERT INTO depo_malzeme (santral_id, sku, ad, barkod, birim, mevcut_miktar, kritik_stok_miktari, konum)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [req.params.santral_id, sku, ad, barkod || null, birim, miktar, kritik_stok_miktari ?? null, konum || null]
          );
          malzeme = rows[0];
        }

        const { rows: siraRows } = await client.query(`SELECT nextval('depo_giris_fis_sira') AS n`);
        const fisNo = `G-${String(siraRows[0].n).padStart(6, "0")}`;

        const { rows: girisRows } = await client.query(
          `INSERT INTO depo_giris (fis_no, santral_id, malzeme_id, teslim_alan_kullanici_id, miktar, olusturan_kullanici_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [fisNo, req.params.santral_id, malzeme.malzeme_id, req.user.kullanici_id, miktar, req.user.kullanici_id]
        );

        await client.query("COMMIT");
        res.status(201).json({ giris: girisRows[0], malzeme });
      } catch (icErr) {
        await client.query("ROLLBACK");
        throw icErr;
      }
    } catch (err) {
      next(err);
    } finally {
      if (client) client.release();
    }
  }
);

router.get("/santraller/:santral_id/depo/giris", async (req, res, next) => {
  try {
    if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;
    const params = [req.params.santral_id];
    let sorgu = `SELECT g.*, m.ad AS malzeme_adi, m.sku, m.birim, k.ad_soyad AS teslim_alan_adi
                 FROM depo_giris g
                 JOIN depo_malzeme m ON m.malzeme_id = g.malzeme_id
                 LEFT JOIN kullanici k ON k.kullanici_id = g.teslim_alan_kullanici_id
                 WHERE g.santral_id = $1`;
    if (req.query.baslangic) {
      params.push(req.query.baslangic);
      sorgu += ` AND g.giris_tarihi >= $${params.length}`;
    }
    if (req.query.bitis) {
      params.push(`${req.query.bitis} 23:59:59`);
      sorgu += ` AND g.giris_tarihi <= $${params.length}`;
    }
    sorgu += ` ORDER BY g.giris_tarihi DESC`;
    const { rows } = await req.db.query(sorgu, params);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// MALZEME ÇIKIŞ — Saha Personeli TALEP eder, Santral Sorumlusu/İşletme
// Admin ONAYLAR (stoktan asıl düşme onay anında olur).
// ---------------------------------------------------------------------
router.post(
  "/santraller/:santral_id/depo/cikis-talep",
  requireRole(...CIKIS_TALEP_ROLLERI),
  async (req, res, next) => {
    try {
      if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;
      const { malzeme_id, miktar, kullanim_yeri } = req.body;
      if (!malzeme_id || miktar == null || Number(miktar) <= 0) {
        return res.status(400).json({
          hata_kodu: "EKSIK_ALAN",
          mesaj: "malzeme_id ve sıfırdan büyük bir miktar zorunludur.",
        });
      }
      const { rows: malzemeRows } = await req.db.query(
        `SELECT * FROM depo_malzeme WHERE malzeme_id = $1 AND santral_id = $2`,
        [malzeme_id, req.params.santral_id]
      );
      if (!malzemeRows[0]) {
        return res.status(404).json({ hata_kodu: "MALZEME_BULUNAMADI", mesaj: "Malzeme bulunamadı." });
      }

      const { rows } = await req.db.query(
        `INSERT INTO depo_cikis (santral_id, malzeme_id, talep_eden_kullanici_id, miktar, kullanim_yeri)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.params.santral_id, malzeme_id, req.user.kullanici_id, miktar, kullanim_yeri || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/santraller/:santral_id/depo/cikis/:cikis_id/onayla",
  requireRole(...CIKIS_ONAY_ROLLERI),
  async (req, res, next) => {
    let client;
    try {
      if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;

      client = await pool.connect();
      await client.query("BEGIN");
      try {
        const { rows: talepRows } = await client.query(
          `SELECT c.*, m.mevcut_miktar, m.ad AS malzeme_adi, m.birim
           FROM depo_cikis c JOIN depo_malzeme m ON m.malzeme_id = c.malzeme_id
           WHERE c.cikis_id = $1 AND c.santral_id = $2 AND c.durum = 'BEKLIYOR' FOR UPDATE`,
          [req.params.cikis_id, req.params.santral_id]
        );
        const talep = talepRows[0];
        if (!talep) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            hata_kodu: "TALEP_BULUNAMADI",
            mesaj: "Bekleyen bir çıkış talebi bulunamadı (zaten onaylanmış/reddedilmiş olabilir).",
          });
        }
        if (Number(talep.mevcut_miktar) < Number(talep.miktar)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            hata_kodu: "YETERSIZ_STOK",
            mesaj: `Depoda yeterli "${talep.malzeme_adi}" yok (mevcut: ${talep.mevcut_miktar} ${talep.birim}, talep: ${talep.miktar} ${talep.birim}).`,
          });
        }

        const { rows: siraRows } = await client.query(`SELECT nextval('depo_cikis_fis_sira') AS n`);
        const fisNo = `C-${String(siraRows[0].n).padStart(6, "0")}`;

        const { rows: malzemeRows } = await client.query(
          `UPDATE depo_malzeme SET mevcut_miktar = mevcut_miktar - $1 WHERE malzeme_id = $2 RETURNING *`,
          [talep.miktar, talep.malzeme_id]
        );

        const { rows: guncelCikis } = await client.query(
          `UPDATE depo_cikis
           SET durum = 'ONAYLANDI', onaylayan_kullanici_id = $1, cikis_tarihi = now(), fis_no = $2
           WHERE cikis_id = $3
           RETURNING *`,
          [req.user.kullanici_id, fisNo, req.params.cikis_id]
        );

        await client.query("COMMIT");
        await kritikStokUyarisiGonder(req, malzemeRows[0]);
        res.json(guncelCikis[0]);
      } catch (icErr) {
        await client.query("ROLLBACK");
        throw icErr;
      }
    } catch (err) {
      next(err);
    } finally {
      if (client) client.release();
    }
  }
);

router.post(
  "/santraller/:santral_id/depo/cikis/:cikis_id/reddet",
  requireRole(...CIKIS_ONAY_ROLLERI),
  async (req, res, next) => {
    try {
      if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;
      const { rows } = await req.db.query(
        `UPDATE depo_cikis c
         SET durum = 'REDDEDILDI', onaylayan_kullanici_id = $1, red_notu = $2
         WHERE cikis_id = $3 AND santral_id = $4 AND durum = 'BEKLIYOR'
         RETURNING c.*, (SELECT ad FROM depo_malzeme m WHERE m.malzeme_id = c.malzeme_id) AS malzeme_adi,
                   (SELECT birim FROM depo_malzeme m WHERE m.malzeme_id = c.malzeme_id) AS birim`,
        [req.user.kullanici_id, req.body.red_notu || null, req.params.cikis_id, req.params.santral_id]
      );
      if (!rows[0]) {
        return res.status(404).json({
          hata_kodu: "TALEP_BULUNAMADI",
          mesaj: "Bekleyen bir çıkış talebi bulunamadı.",
        });
      }
      await cikisRedBildirimiGonder(req, rows[0]);
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.get("/santraller/:santral_id/depo/cikis", async (req, res, next) => {
  try {
    if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;
    const params = [req.params.santral_id];
    let sorgu = `SELECT c.*, m.ad AS malzeme_adi, m.sku, m.birim,
                        talep_eden.ad_soyad AS talep_eden_adi,
                        onaylayan.ad_soyad AS onaylayan_adi
                 FROM depo_cikis c
                 JOIN depo_malzeme m ON m.malzeme_id = c.malzeme_id
                 JOIN kullanici talep_eden ON talep_eden.kullanici_id = c.talep_eden_kullanici_id
                 LEFT JOIN kullanici onaylayan ON onaylayan.kullanici_id = c.onaylayan_kullanici_id
                 WHERE c.santral_id = $1`;
    if (req.query.durum) {
      params.push(req.query.durum);
      sorgu += ` AND c.durum = $${params.length}`;
    }
    if (req.query.baslangic) {
      params.push(req.query.baslangic);
      sorgu += ` AND c.talep_tarihi >= $${params.length}`;
    }
    if (req.query.bitis) {
      params.push(`${req.query.bitis} 23:59:59`);
      sorgu += ` AND c.talep_tarihi <= $${params.length}`;
    }
    sorgu += ` ORDER BY c.talep_tarihi DESC`;
    const { rows } = await req.db.query(sorgu, params);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// RAPOR PDF AL — Giriş ve Çıkış ayrı ayrı PDF olarak indirilebilir.
// ---------------------------------------------------------------------
router.get("/santraller/:santral_id/depo/rapor/pdf", async (req, res, next) => {
  try {
    if (await erisimYoksaReddet(req, res, req.params.santral_id)) return;
    const tip = req.query.tip === "cikis" ? "cikis" : "giris";

    const { rows: santralRows } = await req.db.query(`SELECT ad FROM santral WHERE santral_id = $1`, [
      req.params.santral_id,
    ]);
    const santralAdi = santralRows[0]?.ad || "";

    const params = [req.params.santral_id];
    let sorgu;
    if (tip === "giris") {
      sorgu = `SELECT g.fis_no, g.giris_tarihi AS tarih, m.ad AS malzeme_adi, m.sku, g.miktar, m.birim,
                      k.ad_soyad AS ilgili_kisi
               FROM depo_giris g
               JOIN depo_malzeme m ON m.malzeme_id = g.malzeme_id
               LEFT JOIN kullanici k ON k.kullanici_id = g.teslim_alan_kullanici_id
               WHERE g.santral_id = $1`;
    } else {
      sorgu = `SELECT c.fis_no, c.cikis_tarihi AS tarih, m.ad AS malzeme_adi, m.sku, c.miktar, m.birim,
                      k.ad_soyad AS ilgili_kisi
               FROM depo_cikis c
               JOIN depo_malzeme m ON m.malzeme_id = c.malzeme_id
               LEFT JOIN kullanici k ON k.kullanici_id = c.talep_eden_kullanici_id
               WHERE c.santral_id = $1 AND c.durum = 'ONAYLANDI'`;
    }
    if (req.query.baslangic) {
      params.push(req.query.baslangic);
      sorgu += ` AND ${tip === "giris" ? "g.giris_tarihi" : "c.cikis_tarihi"} >= $${params.length}`;
    }
    if (req.query.bitis) {
      params.push(`${req.query.bitis} 23:59:59`);
      sorgu += ` AND ${tip === "giris" ? "g.giris_tarihi" : "c.cikis_tarihi"} <= $${params.length}`;
    }
    sorgu += ` ORDER BY tarih DESC`;
    const { rows } = await req.db.query(sorgu, params);

    const dokuman = new PDFDocument({ size: "A4", layout: "landscape", margin: 40 });
    // pdfkit'in varsayılan Helvetica fontu Türkçe karakterleri (ç, ğ, ı,
    // ö, ş, ü) doğru göstermiyor — bu yüzden Türkçe dahil geniş Unicode
    // desteği olan DejaVu Sans fontunu gömüyoruz.
    const path = require("path");
    dokuman.registerFont("TR", path.join(__dirname, "..", "fonts", "DejaVuSans.ttf"));
    dokuman.registerFont("TR-Bold", path.join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf"));
    dokuman.font("TR");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="depo-${tip}-raporu.pdf"`
    );
    dokuman.pipe(res);

    dokuman.fontSize(16).text(`${santralAdi} — Depo ${tip === "giris" ? "Malzeme Giriş" : "Malzeme Çıkış"} Raporu`, {
      align: "left",
    });
    dokuman.moveDown();

    const sutunlar = [
      { baslik: "Fiş No", genislik: 110 },
      { baslik: "Tarih", genislik: 130 },
      { baslik: "Malzeme", genislik: 220 },
      { baslik: "SKU", genislik: 110 },
      { baslik: "Miktar", genislik: 100 },
      { baslik: "İlgili Kişi", genislik: 150 },
    ];
    const tabloSolX = 40;
    const SATIR_YUKSEKLIGI = 20;
    let y = dokuman.y;

    function hucreYaz(metin, sutunIndex, baslikMi) {
      let x = tabloSolX;
      for (let i = 0; i < sutunIndex; i++) x += sutunlar[i].genislik;
      dokuman
        .font(baslikMi ? "TR-Bold" : "TR")
        .fontSize(9)
        .fillColor(baslikMi ? "#ffffff" : "#13201c")
        .text(String(metin ?? "—"), x + 4, y + 5, { width: sutunlar[sutunIndex].genislik - 8 });
    }

    dokuman.rect(tabloSolX, y, sutunlar.reduce((a, s) => a + s.genislik, 0), SATIR_YUKSEKLIGI).fill("#0f3d3e");
    sutunlar.forEach((s, i) => hucreYaz(s.baslik, i, true));
    y += SATIR_YUKSEKLIGI;

    rows.forEach((r) => {
      if (y > 500) {
        dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
        dokuman.font("TR");
        y = 40;
      }
      hucreYaz(r.fis_no, 0, false);
      hucreYaz(new Date(r.tarih).toLocaleString("tr-TR"), 1, false);
      hucreYaz(r.malzeme_adi, 2, false);
      hucreYaz(r.sku, 3, false);
      hucreYaz(`${r.miktar} ${r.birim}`, 4, false);
      hucreYaz(r.ilgili_kisi, 5, false);
      y += SATIR_YUKSEKLIGI;
    });

    if (rows.length === 0) {
      dokuman.fontSize(10).fillColor("#5b6b62").text("Seçilen aralıkta kayıt bulunamadı.", tabloSolX, y + 10);
    }

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
