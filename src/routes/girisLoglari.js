const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const LOG_ROLLERI = ["ISLETME_ADMIN", "ADMIN"];

function platformAdminMi(req) {
  return req.user.rol === "ADMIN";
}

const FONT_NORMAL = path.join(__dirname, "..", "DejaVuSans.ttf");
const FONT_KALIN = path.join(__dirname, "..", "DejaVuSans-Bold.ttf");

function tarihSaatFormatla(deger) {
  return deger
    ? new Date(deger).toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

/**
 * Filtrelere göre giriş kayıtlarını toplar. santral_idleri belirtilmişse
 * (yalnızca GM), yalnızca o santrallere erişimi olan kullanıcıların
 * kayıtları döner. Diğerleri (İşletme Admin) her zaman yalnızca kendi
 * holdinginin kullanıcılarını görür.
 */
async function girisKayitlariniTopla(req) {
  const params = [];
  const kosullar = [];

  if (platformAdminMi(req)) {
    if (req.query.santral_idleri) {
      const santralIdleri = Array.isArray(req.query.santral_idleri)
        ? req.query.santral_idleri
        : [req.query.santral_idleri];
      params.push(santralIdleri);
      kosullar.push(
        `k.kullanici_id IN (SELECT kullanici_id FROM v_kullanici_yetkili_santraller WHERE santral_id = ANY($${params.length}::uuid[]))`
      );
    } else if (req.query.isletme_id) {
      params.push(req.query.isletme_id);
      kosullar.push(`k.isletme_id = $${params.length}`);
    }
  } else {
    params.push(req.user.isletme_id);
    kosullar.push(`k.isletme_id = $${params.length}`);
  }

  if (req.query.kullanici_id) {
    params.push(req.query.kullanici_id);
    kosullar.push(`g.kullanici_id = $${params.length}`);
  }
  if (req.query.baslangic) {
    params.push(req.query.baslangic);
    kosullar.push(`g.giris_tarihi >= $${params.length}`);
  }
  if (req.query.bitis) {
    params.push(`${req.query.bitis} 23:59:59`);
    kosullar.push(`g.giris_tarihi <= $${params.length}`);
  }

  const whereIfadesi = kosullar.length > 0 ? `WHERE ${kosullar.join(" AND ")}` : "";
  const limit = Math.min(Number(req.query.limit) || 1000, 1000);

  const { rows } = await req.db.query(
    `SELECT g.kayit_id, g.giris_tarihi, g.ip_adresi,
            k.kullanici_id, k.ad_soyad, k.eposta, k.rol, i.ad AS isletme_adi
     FROM giris_kaydi g
     JOIN kullanici k ON k.kullanici_id = g.kullanici_id
     JOIN isletme i ON i.isletme_id = k.isletme_id
     ${whereIfadesi}
     ORDER BY g.giris_tarihi DESC
     LIMIT ${limit}`,
    params
  );
  return rows;
}

// GET /api/v1/giris-loglari/filtre-secenekleri — Kişi (ve GM için Holding/Santral) kutularını doldurur
// Platform Admin, ?isletme_id= ve/veya ?santral_idleri= göndererek Kişi
// listesini yalnızca seçtiği holding/santral(ler)deki kişilerle sınırlayabilir
// (bunlar gönderilmezse — hiçbir holding seçilmemişse — TÜM kişiler döner).
router.get("/filtre-secenekleri", requireRole(...LOG_ROLLERI), async (req, res, next) => {
  try {
    const params = [];
    let kosul = "";
    if (!platformAdminMi(req)) {
      params.push(req.user.isletme_id);
      kosul = `WHERE isletme_id = $1`;
    } else if (req.query.santral_idleri) {
      const santralIdleri = Array.isArray(req.query.santral_idleri)
        ? req.query.santral_idleri
        : [req.query.santral_idleri];
      params.push(santralIdleri);
      kosul = `WHERE kullanici_id IN (SELECT kullanici_id FROM v_kullanici_yetkili_santraller WHERE santral_id = ANY($1::uuid[]))`;
    } else if (req.query.isletme_id) {
      params.push(req.query.isletme_id);
      kosul = `WHERE isletme_id = $1`;
    }
    const { rows: kisiler } = await req.db.query(
      `SELECT kullanici_id, ad_soyad, eposta FROM kullanici ${kosul} ORDER BY ad_soyad`,
      params
    );

    let holdingler = [];
    let santraller = [];
    if (platformAdminMi(req)) {
      const { rows: hRows } = await req.db.query(`SELECT isletme_id, ad FROM isletme ORDER BY ad`);
      holdingler = hRows;
      const { rows: sRows } = await req.db.query(
        `SELECT santral_id, ad, isletme_id FROM santral ORDER BY ad`
      );
      santraller = sRows;
    }

    res.json({ kisiler, holdingler, santraller });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/giris-loglari — filtrelenmiş giriş kayıtlarını listeler
router.get("/", requireRole(...LOG_ROLLERI), async (req, res, next) => {
  try {
    const rows = await girisKayitlariniTopla(req);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/giris-loglari/pdf — aynı filtrelerle PDF raporu üretir
router.get("/pdf", requireRole(...LOG_ROLLERI), async (req, res, next) => {
  try {
    const rows = await girisKayitlariniTopla(req);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="giris-loglari.pdf"`);

    const dokuman = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
    res.on("error", (err) => console.error("Log raporu akış hatası:", err.message));
    dokuman.on("error", (err) => console.error("Log PDF üretim hatası:", err.message));
    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    dokuman.font("DejaVu-Bold").fontSize(16).fillColor("#0f3d3e").text("HES Bakım Yönetim Sistemi");
    dokuman.font("DejaVu-Bold").fontSize(12).fillColor("#13201c").text("Giriş Logları Raporu");
    dokuman
      .font("DejaVu")
      .fontSize(8)
      .fillColor("#5b6b62")
      .text(`Toplam kayıt: ${rows.length}   |   Rapor tarihi: ${tarihSaatFormatla(new Date())}`);
    dokuman.moveDown(0.8);
    dokuman.strokeColor("#c17a24").lineWidth(1.5).moveTo(40, dokuman.y).lineTo(802, dokuman.y).stroke();
    dokuman.moveDown(0.6);

    const sutunlar = [
      { baslik: "Ad Soyad", genislik: 180 },
      { baslik: "E-posta", genislik: 220 },
      { baslik: "Rol", genislik: 140 },
      { baslik: "Holding", genislik: 130 },
      { baslik: "Giriş Tarihi", genislik: 92 },
    ];
    const tabloSolX = 40;
    let y = dokuman.y;
    const SATIR_YUKSEKLIGI = 16;

    function hucreYaz(metin, sutunIndex, kalinMi) {
      let x = tabloSolX;
      for (let i = 0; i < sutunIndex; i++) x += sutunlar[i].genislik;
      dokuman
        .font(kalinMi ? "DejaVu-Bold" : "DejaVu")
        .fontSize(8.5)
        .fillColor(kalinMi ? "#0f3d3e" : "#13201c")
        .text(String(metin), x, y, {
          width: sutunlar[sutunIndex].genislik - 8,
          height: SATIR_YUKSEKLIGI,
          ellipsis: true,
          lineBreak: false,
        });
    }

    sutunlar.forEach((s, i) => hucreYaz(s.baslik, i, true));
    y += SATIR_YUKSEKLIGI;
    dokuman.strokeColor("#c9d0c8").lineWidth(0.5).moveTo(tabloSolX, y - 2).lineTo(802, y - 2).stroke();
    y += 2;

    rows.forEach((r) => {
      if (y > 555) {
        dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
        y = 40;
      }
      hucreYaz(r.ad_soyad, 0, false);
      hucreYaz(r.eposta, 1, false);
      hucreYaz(r.rol, 2, false);
      hucreYaz(r.isletme_adi, 3, false);
      hucreYaz(tarihSaatFormatla(r.giris_tarihi), 4, false);
      y += SATIR_YUKSEKLIGI;
    });

    if (rows.length === 0) {
      dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62").text("Seçilen filtrelerle eşleşen kayıt yok.", tabloSolX, y);
    }

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
