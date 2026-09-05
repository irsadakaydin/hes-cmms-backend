const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

// Türkçe karakterleri (ı, ş, ğ, ü, ö, ç, İ) doğru göstermek için pdfkit'in
// varsayılan 14 fontu yetersiz (yalnızca WinAnsi kodlaması) — bu yüzden
// Unicode desteği tam olan DejaVu Sans fontunu projeye gömüp kullanıyoruz.
// NOT: Font dosyaları src/ klasörünün KÖKÜNDE duruyor (src/assets/ altında değil).
const FONT_NORMAL = path.join(__dirname, "..", "DejaVuSans.ttf");
const FONT_KALIN = path.join(__dirname, "..", "DejaVuSans-Bold.ttf");

const router = express.Router();
router.use(requireAuth, withDbContext);

async function santralErisimVarMi(req, santral_id) {
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

/** ?baslangic=&bitis=&durum= filtrelerini SQL koşuluna çevirir. */
function tarihFiltresi(req, startParamIndex, tarihKolonu = "g.planlanan_tarih") {
  const kosullar = [];
  const params = [];
  let i = startParamIndex;

  if (req.query.baslangic) {
    kosullar.push(`${tarihKolonu} >= $${i++}`);
    params.push(req.query.baslangic);
  }
  if (req.query.bitis) {
    kosullar.push(`${tarihKolonu} <= $${i++}`);
    params.push(req.query.bitis);
  }
  if (req.query.durum) {
    kosullar.push(`g.durum = $${i++}`);
    params.push(req.query.durum);
  }
  return { kosulMetni: kosullar.length ? "AND " + kosullar.join(" AND ") : "", params };
}

// GET /api/v1/raporlar/santral/:santral_id/ozet
router.get("/santral/:santral_id/ozet", async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { kosulMetni, params } = tarihFiltresi(req, 2);
    const { rows } = await req.db.query(
      `SELECT
         COUNT(*) AS toplam_gorev,
         COUNT(*) FILTER (WHERE g.durum = 'TAMAMLANDI') AS tamamlanan,
         COUNT(*) FILTER (WHERE g.durum = 'GECIKTI') AS gecikmis,
         COUNT(*) FILTER (WHERE g.durum = 'BEKLIYOR') AS bekleyen,
         ROUND(
           COUNT(*) FILTER (WHERE g.durum = 'TAMAMLANDI')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1
         ) AS tamamlanma_yuzdesi
       FROM bakim_gorevi g
       JOIN bakim_plani bp ON bp.plan_id = g.plan_id
       WHERE bp.santral_id = $1 ${kosulMetni}`,
      [santral_id, ...params]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/santral/:santral_id/gecikmis-gorevler
router.get("/santral/:santral_id/gecikmis-gorevler", async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(`SELECT * FROM v_gecikmis_gorevler WHERE santral_adi = (
      SELECT ad FROM santral WHERE santral_id = $1
    ) ORDER BY gecikme_gun_sayisi DESC`, [santral_id]);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/ekipman/:ekipman_id/gecmis
router.get("/ekipman/:ekipman_id/gecmis", async (req, res, next) => {
  try {
    const { rows: ekipmanRows } = await req.db.query(`SELECT santral_id, ad FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    if (!ekipmanRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, ekipmanRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(
      `SELECT
         bk.kayit_id, bk.tamamlanma_tarihi, bk.checklist_sonuclari, bk.notlar,
         k.ad_soyad AS tamamlayan, bs.ad AS sablon_adi
       FROM bakim_kaydi bk
       JOIN bakim_gorevi g   ON g.gorev_id = bk.gorev_id
       JOIN bakim_plani bp   ON bp.plan_id = g.plan_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
       JOIN kullanici k      ON k.kullanici_id = bk.tamamlayan_kullanici_id
       WHERE bp.ekipman_id = $1
       ORDER BY bk.tamamlanma_tarihi DESC`,
      [req.params.ekipman_id]
    );
    res.json({ ekipman_adi: ekipmanRows[0].ad, gecmis: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/isletme/:isletme_id/portfoy-ozeti
router.get(
  "/isletme/:isletme_id/portfoy-ozeti",
  requireRole("ISLETME_ADMIN", "ADMIN"),
  async (req, res, next) => {
    try {
      const { isletme_id } = req.params;
      if (req.user.rol !== "ADMIN" && req.user.isletme_id !== isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu işletmeye erişim yetkiniz yok." });
      }

      const { rows } = await req.db.query(`SELECT * FROM v_isletme_portfoy_ozeti WHERE isletme_id = $1`, [
        isletme_id,
      ]);
      res.json(rows[0] || null);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/raporlar/platform-ozeti — tüm işletmelerin karşılaştırmalı özeti
router.get("/platform-ozeti", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM v_isletme_portfoy_ozeti ORDER BY isletme_adi`);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// PDF / Excel rapor üretimi için ortak veri toplama
// ?baslangic= ve ?bitis= (YYYY-AA-GG) ile dönem filtrelenebilir — frontend
// "Günlük/Haftalık/Aylık/Yıllık" seçimini bu iki tarihe çevirip gönderir.
// ---------------------------------------------------------------------
async function santralRaporVerisiTopla(req, santral_id) {
  const { rows: santralRows } = await req.db.query(
    `SELECT s.*, i.ad AS isletme_adi FROM santral s JOIN isletme i ON i.isletme_id = s.isletme_id
     WHERE s.santral_id = $1`,
    [santral_id]
  );
  const santral = santralRows[0];

  const params = [santral_id];
  let ekKosul = "";
  if (req.query.baslangic) {
    params.push(req.query.baslangic);
    ekKosul += ` AND g.planlanan_tarih >= $${params.length}`;
  }
  if (req.query.bitis) {
    params.push(req.query.bitis);
    ekKosul += ` AND g.planlanan_tarih <= $${params.length}`;
  }
  if (req.query.periyot) {
    params.push(req.query.periyot);
    ekKosul += ` AND bp.periyot = $${params.length}`;
  }

  const { rows: gorevler } = await req.db.query(
    `SELECT
       g.gorev_id, g.durum, g.planlanan_tarih,
       e.ad AS ekipman_adi, bs.ad AS bakim_adi,
       atanan.ad_soyad AS atanan_personel,
       bk.tamamlanma_tarihi,
       tamamlayan.ad_soyad AS tamamlayan_personel
     FROM bakim_gorevi g
     JOIN bakim_plani bp     ON bp.plan_id = g.plan_id
     JOIN ekipman e          ON e.ekipman_id = bp.ekipman_id
     JOIN bakim_sablonu bs   ON bs.sablon_id = bp.sablon_id
     JOIN kullanici atanan   ON atanan.kullanici_id = g.atanan_kullanici_id
     LEFT JOIN bakim_kaydi bk      ON bk.gorev_id = g.gorev_id
     LEFT JOIN kullanici tamamlayan ON tamamlayan.kullanici_id = bk.tamamlayan_kullanici_id
     WHERE bp.santral_id = $1 ${ekKosul}
     ORDER BY g.planlanan_tarih DESC`,
    params
  );

  const ozet = {
    toplam_gorev: gorevler.length,
    tamamlanan: gorevler.filter((g) => g.durum === "TAMAMLANDI").length,
    gecikmis: gorevler.filter((g) => g.durum === "GECIKTI").length,
    bekleyen: gorevler.filter((g) => g.durum === "BEKLIYOR").length,
  };
  ozet.tamamlanma_yuzdesi = ozet.toplam_gorev
    ? Math.round((ozet.tamamlanan / ozet.toplam_gorev) * 1000) / 10
    : 0;

  return { santral, ozet, gorevler };
}

const DURUM_ETIKETLERI = { TAMAMLANDI: "Tamamlandı", GECIKTI: "Gecikti", BEKLIYOR: "Bekliyor", DEVAM_EDIYOR: "Devam Ediyor" };
const PERIYOT_ETIKETLERI = {
  GUNLUK: "Günlük",
  HAFTALIK: "Haftalık",
  AYLIK: "Aylık",
  UC_AYLIK: "3 Ayda Bir",
  ALTI_AYLIK: "6 Ayda Bir",
  YILLIK: "Yıllık",
};

function tarihFormatla(deger) {
  return deger ? new Date(deger).toLocaleDateString("tr-TR") : "—";
}

const RAPOR_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

// GET /api/v1/raporlar/santral/:santral_id/pdf
router.get("/santral/:santral_id/pdf", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { santral, ozet, gorevler } = await santralRaporVerisiTopla(req, santral_id);
    if (!santral) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bakim-raporu-${santral.ad.replace(/\s+/g, "-")}.pdf"`
    );

    const dokuman = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });

    // İstemci PDF akışı tamamlanmadan bağlantıyı keserse (ör. tarayıcı
    // isteği iptal eder, sekme kapanır), pdfkit yine de akışa yazmaya
    // devam edebilir ve bu "write after end" hatası yakalanmazsa TÜM
    // Node.js sürecini çökertir. Bu iki dinleyici, hatayı sessizce
    // loglayıp sürecin ayakta kalmasını sağlar.
    res.on("error", (err) => {
      console.error("Rapor akışı hatası (istemci muhtemelen bağlantıyı kesti):", err.message);
    });
    dokuman.on("error", (err) => {
      console.error("PDF üretim hatası:", err.message);
    });

    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    // Başlık
    dokuman.font("DejaVu-Bold").fontSize(16).fillColor("#0f3d3e").text("HES Bakım Yönetim Sistemi");
    dokuman
      .font("DejaVu-Bold")
      .fontSize(12)
      .fillColor("#13201c")
      .text(`${santral.isletme_adi} — ${santral.ad} — Bakım Raporu`);
    const donemMetni =
      req.query.baslangic || req.query.bitis
        ? `Dönem: ${req.query.baslangic ? tarihFormatla(req.query.baslangic) : "…"} – ${
            req.query.bitis ? tarihFormatla(req.query.bitis) : "…"
          }`
        : "Dönem: Tüm zamanlar";
    const periyotMetni = req.query.periyot ? `   |   Bakım periyodu: ${PERIYOT_ETIKETLERI[req.query.periyot] || req.query.periyot}` : "";
    dokuman
      .font("DejaVu")
      .fontSize(8)
      .fillColor("#5b6b62")
      .text(`${donemMetni}${periyotMetni}   |   Rapor tarihi: ${tarihFormatla(new Date())}`);
    dokuman.moveDown(0.8);
    dokuman.strokeColor("#c17a24").lineWidth(1.5).moveTo(40, dokuman.y).lineTo(802, dokuman.y).stroke();
    dokuman.moveDown(0.6);

    // Özet satırı
    dokuman
      .font("DejaVu")
      .fontSize(9)
      .fillColor("#13201c")
      .text(
        `Toplam: ${ozet.toplam_gorev}   ·   Tamamlanan: ${ozet.tamamlanan}   ·   Gecikmiş: ${ozet.gecikmis}   ·   Bekleyen: ${ozet.bekleyen}   ·   Tamamlanma: %${ozet.tamamlanma_yuzdesi}`
      );
    dokuman.moveDown(0.8);

    // Tablo
    const sutunlar = [
      { baslik: "İşletme", genislik: 95 },
      { baslik: "Bakım Adı", genislik: 285 },
      { baslik: "Durum", genislik: 78 },
      { baslik: "Personel", genislik: 90 },
      { baslik: "Atama Tarihi", genislik: 75 },
      { baslik: "Tamamlama T.", genislik: 85 },
    ];
    const tabloSolX = 40;
    let y = dokuman.y;
    const SATIR_YUKSEKLIGI = 16;

    function hucreYaz(metin, sutunIndex, kalinMi, renk) {
      let x = tabloSolX;
      for (let i = 0; i < sutunIndex; i++) x += sutunlar[i].genislik;
      dokuman
        .font(kalinMi ? "DejaVu-Bold" : "DejaVu")
        .fontSize(8.5)
        .fillColor(renk || "#13201c")
        .text(String(metin), x, y, {
          width: sutunlar[sutunIndex].genislik - 8,
          height: SATIR_YUKSEKLIGI,
          ellipsis: true,
          lineBreak: false,
        });
    }

    sutunlar.forEach((s, i) => hucreYaz(s.baslik, i, true, "#0f3d3e"));
    y += SATIR_YUKSEKLIGI;
    dokuman.strokeColor("#c9d0c8").lineWidth(0.5).moveTo(tabloSolX, y - 2).lineTo(802, y - 2).stroke();
    y += 2;

    const DURUM_RENK = { TAMAMLANDI: "#2c7a4b", GECIKTI: "#a83b2e", BEKLIYOR: "#c17a24", DEVAM_EDIYOR: "#1d4e75" };

    gorevler.forEach((g) => {
      if (y > 555) {
        dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
        y = 40;
      }
      hucreYaz(santral.ad, 0, false);
      hucreYaz(`${g.ekipman_adi} — ${g.bakim_adi}`, 1, false);
      hucreYaz(DURUM_ETIKETLERI[g.durum] || g.durum, 2, true, DURUM_RENK[g.durum] || "#13201c");
      hucreYaz(g.tamamlayan_personel || g.atanan_personel, 3, false);
      hucreYaz(tarihFormatla(g.planlanan_tarih), 4, false);
      hucreYaz(tarihFormatla(g.tamamlanma_tarihi), 5, false);
      y += SATIR_YUKSEKLIGI;
    });

    if (gorevler.length === 0) {
      dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62").text("Bu dönemde kayıtlı görev bulunmuyor.", tabloSolX, y);
      y += SATIR_YUKSEKLIGI;
    }

    // Onay/imza alanları
    y += 30;
    if (y > 540) {
      dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
      y = 40;
    }
    dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62");
    dokuman.text("Bakım Müdürlüğü", tabloSolX, y);
    dokuman.text("_____________________", tabloSolX, y + 30);
    dokuman.text("İşletme Yöneticisi / Müdürü", tabloSolX + 300, y);
    dokuman.text("_____________________", tabloSolX + 300, y + 30);

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/santral/:santral_id/excel
router.get("/santral/:santral_id/excel", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { santral, ozet, gorevler } = await santralRaporVerisiTopla(req, santral_id);
    if (!santral) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "HES CMMS";
    workbook.created = new Date();

    const ozetSheet = workbook.addWorksheet("Özet");
    ozetSheet.columns = [
      { header: "Alan", key: "alan", width: 28 },
      { header: "Değer", key: "deger", width: 24 },
    ];
    ozetSheet.getRow(1).font = { bold: true };
    ozetSheet.addRows([
      { alan: "İşletme (Holding)", deger: santral.isletme_adi },
      { alan: "Santral", deger: santral.ad },
      {
        alan: "Dönem",
        deger:
          req.query.baslangic || req.query.bitis
            ? `${tarihFormatla(req.query.baslangic) } – ${tarihFormatla(req.query.bitis)}`
            : "Tüm zamanlar",
      },
      { alan: "Bakım periyodu", deger: req.query.periyot ? (PERIYOT_ETIKETLERI[req.query.periyot] || req.query.periyot) : "Tümü" },
      { alan: "Rapor tarihi", deger: tarihFormatla(new Date()) },
      { alan: "Toplam görev", deger: ozet.toplam_gorev },
      { alan: "Tamamlanan", deger: ozet.tamamlanan },
      { alan: "Gecikmiş", deger: ozet.gecikmis },
      { alan: "Bekleyen", deger: ozet.bekleyen },
      { alan: "Tamamlanma yüzdesi (%)", deger: ozet.tamamlanma_yuzdesi },
    ]);

    const gorevSheet = workbook.addWorksheet("Bakım Kayıtları");
    gorevSheet.columns = [
      { header: "İşletme", key: "isletme_adi", width: 20 },
      { header: "Bakım Adı", key: "bakim_adi", width: 42 },
      { header: "Durum", key: "durum", width: 14 },
      { header: "Personel", key: "personel", width: 20 },
      { header: "Atama Tarihi", key: "atama_tarihi", width: 14 },
      { header: "Tamamlama Tarihi", key: "tamamlama_tarihi", width: 16 },
    ];
    gorevSheet.getRow(1).font = { bold: true };
    gorevler.forEach((g) => {
      const satir = gorevSheet.addRow({
        isletme_adi: santral.ad,
        bakim_adi: `${g.ekipman_adi} — ${g.bakim_adi}`,
        durum: DURUM_ETIKETLERI[g.durum] || g.durum,
        personel: g.tamamlayan_personel || g.atanan_personel,
        atama_tarihi: tarihFormatla(g.planlanan_tarih),
        tamamlama_tarihi: tarihFormatla(g.tamamlanma_tarihi),
      });
      const renkler = { TAMAMLANDI: "FF2C7A4B", GECIKTI: "FFA83B2E", BEKLIYOR: "FFC17A24", DEVAM_EDIYOR: "FF1D4E75" };
      if (renkler[g.durum]) {
        satir.getCell("durum").font = { color: { argb: renkler[g.durum] }, bold: true };
      }
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bakim-raporu-${santral.ad.replace(/\s+/g, "-")}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
