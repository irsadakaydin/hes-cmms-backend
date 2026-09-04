const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

// Türkçe karakterleri (ı, ş, ğ, ü, ö, ç, İ) doğru göstermek için pdfkit'in
// varsayılan 14 fontu yetersiz (yalnızca WinAnsi kodlaması) — bu yüzden
// Unicode desteği tam olan DejaVu Sans fontunu projeye gömüp kullanıyoruz.
const FONT_NORMAL = path.join(__dirname, "..", "assets", "DejaVuSans.ttf");
const FONT_KALIN = path.join(__dirname, "..", "assets", "DejaVuSans-Bold.ttf");

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
// ---------------------------------------------------------------------
async function santralRaporVerisiTopla(req, santral_id) {
  const { rows: santralRows } = await req.db.query(`SELECT * FROM santral WHERE santral_id = $1`, [
    santral_id,
  ]);
  const santral = santralRows[0];

  const { rows: ozetRows } = await req.db.query(
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
     WHERE bp.santral_id = $1`,
    [santral_id]
  );

  const { rows: gecikmisRows } = await req.db.query(
    `SELECT * FROM v_gecikmis_gorevler WHERE santral_adi = $1 ORDER BY gecikme_gun_sayisi DESC`,
    [santral?.ad]
  );

  return { santral, ozet: ozetRows[0], gecikmisGorevler: gecikmisRows };
}

// GET /api/v1/raporlar/santral/:santral_id/pdf
router.get("/santral/:santral_id/pdf", async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { santral, ozet, gecikmisGorevler } = await santralRaporVerisiTopla(req, santral_id);
    if (!santral) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bakim-raporu-${santral.ad.replace(/\s+/g, "-")}.pdf"`
    );

    const dokuman = new PDFDocument({ size: "A4", margin: 50 });
    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    // Başlık
    dokuman.font("DejaVu-Bold").fontSize(18).fillColor("#0f3d3e").text("HES Bakım Yönetim Sistemi", { align: "left" });
    dokuman.font("DejaVu-Bold").fontSize(13).fillColor("#13201c").text(`${santral.ad} — Bakım Özet Raporu`);
    dokuman
      .font("DejaVu")
      .fontSize(9)
      .fillColor("#5b6b62")
      .text(`Rapor tarihi: ${new Date().toLocaleDateString("tr-TR")}`);
    dokuman.moveDown(1.2);
    dokuman.strokeColor("#c17a24").lineWidth(2).moveTo(50, dokuman.y).lineTo(545, dokuman.y).stroke();
    dokuman.moveDown(1);

    // Özet tablosu
    dokuman.font("DejaVu-Bold").fontSize(12).fillColor("#0f3d3e").text("Özet");
    dokuman.moveDown(0.4);
    const ozetSatirlari = [
      ["Toplam görev", ozet.toplam_gorev],
      ["Tamamlanan", ozet.tamamlanan],
      ["Gecikmiş", ozet.gecikmis],
      ["Bekleyen", ozet.bekleyen],
      ["Tamamlanma yüzdesi", `%${ozet.tamamlanma_yuzdesi ?? 0}`],
    ];
    dokuman.font("DejaVu").fontSize(10).fillColor("#13201c");
    ozetSatirlari.forEach(([etiket, deger]) => {
      dokuman.text(`${etiket}:  ${deger}`);
    });
    dokuman.moveDown(1);

    // Gecikmiş görevler listesi
    dokuman.font("DejaVu-Bold").fontSize(12).fillColor("#0f3d3e").text("Gecikmiş Görevler");
    dokuman.moveDown(0.4);
    if (gecikmisGorevler.length === 0) {
      dokuman.font("DejaVu").fontSize(10).fillColor("#5b6b62").text("Gecikmiş görev bulunmuyor.");
    } else {
      dokuman.font("DejaVu").fontSize(9).fillColor("#13201c");
      gecikmisGorevler.forEach((g) => {
        dokuman.text(
          `• ${g.ekipman_adi} — ${g.sablon_adi}  |  Planlanan: ${new Date(
            g.planlanan_tarih
          ).toLocaleDateString("tr-TR")}  |  ${g.gecikme_gun_sayisi} gün gecikmiş  |  Sorumlu: ${g.atanan_kullanici}`
        );
      });
    }

    // Onay/imza alanları
    dokuman.moveDown(2);
    const imzaY = dokuman.y;
    dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62");
    dokuman.text("Bakım Müdürlüğü", 50, imzaY);
    dokuman.text("_____________________", 50, imzaY + 30);
    dokuman.text("İşletme Yöneticisi / Müdürü", 320, imzaY);
    dokuman.text("_____________________", 320, imzaY + 30);

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/santral/:santral_id/excel
router.get("/santral/:santral_id/excel", async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { santral, ozet, gecikmisGorevler } = await santralRaporVerisiTopla(req, santral_id);
    if (!santral) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "HES CMMS";
    workbook.created = new Date();

    const ozetSheet = workbook.addWorksheet("Özet");
    ozetSheet.columns = [
      { header: "Alan", key: "alan", width: 28 },
      { header: "Değer", key: "deger", width: 20 },
    ];
    ozetSheet.getRow(1).font = { bold: true };
    ozetSheet.addRows([
      { alan: "Santral", deger: santral.ad },
      { alan: "Rapor tarihi", deger: new Date().toLocaleDateString("tr-TR") },
      { alan: "Toplam görev", deger: Number(ozet.toplam_gorev) },
      { alan: "Tamamlanan", deger: Number(ozet.tamamlanan) },
      { alan: "Gecikmiş", deger: Number(ozet.gecikmis) },
      { alan: "Bekleyen", deger: Number(ozet.bekleyen) },
      { alan: "Tamamlanma yüzdesi (%)", deger: Number(ozet.tamamlanma_yuzdesi ?? 0) },
    ]);

    const gecikmisSheet = workbook.addWorksheet("Gecikmiş Görevler");
    gecikmisSheet.columns = [
      { header: "Ekipman", key: "ekipman_adi", width: 24 },
      { header: "Bakım Şablonu", key: "sablon_adi", width: 32 },
      { header: "Planlanan Tarih", key: "planlanan_tarih", width: 16 },
      { header: "Gecikme (gün)", key: "gecikme_gun_sayisi", width: 14 },
      { header: "Sorumlu", key: "atanan_kullanici", width: 22 },
    ];
    gecikmisSheet.getRow(1).font = { bold: true };
    gecikmisGorevler.forEach((g) => {
      gecikmisSheet.addRow({
        ekipman_adi: g.ekipman_adi,
        sablon_adi: g.sablon_adi,
        planlanan_tarih: new Date(g.planlanan_tarih).toLocaleDateString("tr-TR"),
        gecikme_gun_sayisi: g.gecikme_gun_sayisi,
        atanan_kullanici: g.atanan_kullanici,
      });
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
