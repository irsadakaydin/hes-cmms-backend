const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

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

// GET /api/v1/raporlar/santral/:santral_id/pdf ve /excel
// NOT: Bu başlangıç iskeletinde gerçek dosya üretimi (pdfkit/exceljs) uygulanmamıştır.
// Aşağıdaki uç nokta, JSON verisini döner; gerçek PDF/Excel üretimi için
// 'pdfkit' veya 'exceljs' paketleriyle bu handler'ın genişletilmesi gerekir.
router.get(["/santral/:santral_id/pdf", "/santral/:santral_id/excel"], async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }
    res.status(501).json({
      hata_kodu: "HENUZ_UYGULANMADI",
      mesaj:
        "Dosya (PDF/Excel) üretimi bu başlangıç iskeletinde henüz uygulanmadı. " +
        "'pdfkit' veya 'exceljs' paketiyle genişletilmesi gerekir — /raporlar/santral/:id/ozet " +
        "uç noktası aynı veriyi JSON olarak döner.",
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
