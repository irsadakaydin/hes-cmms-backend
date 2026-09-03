const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();

router.use(requireAuth, withDbContext);

// GET /api/v1/gorevler/bana-atanan — oturum açan kullanıcıya atanmış güncel görevler
router.get("/bana-atanan", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
         g.gorev_id, g.planlanan_tarih, g.durum,
         s.santral_id, s.ad AS santral_adi,
         e.ekipman_id, e.ad AS ekipman_adi,
         bs.sablon_id, bs.ad AS sablon_adi
       FROM bakim_gorevi g
       JOIN bakim_plani bp   ON bp.plan_id = g.plan_id
       JOIN santral s        ON s.santral_id = bp.santral_id
       JOIN ekipman e        ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
       WHERE g.atanan_kullanici_id = $1
         AND g.durum IN ('BEKLIYOR', 'DEVAM_EDIYOR', 'GECIKTI')
       ORDER BY g.planlanan_tarih ASC`,
      [req.user.kullanici_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/gorevler/:gorev_id — görev detayı + checklist şablonu
router.get("/:gorev_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
         g.gorev_id, g.planlanan_tarih, g.durum, g.atanan_kullanici_id,
         s.ad AS santral_adi, e.ad AS ekipman_adi,
         bs.ad AS sablon_adi, bs.checklist_json
       FROM bakim_gorevi g
       JOIN bakim_plani bp   ON bp.plan_id = g.plan_id
       JOIN santral s        ON s.santral_id = bp.santral_id
       JOIN ekipman e        ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
       WHERE g.gorev_id = $1`,
      [req.params.gorev_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        hata_kodu: "GOREV_BULUNAMADI",
        mesaj: "Belirtilen görev kaydı bulunamadı.",
      });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/gorevler/:gorev_id/kaydi-tamamla
// Checklist doldurularak görevi kapatır — bakim_kaydi oluşturur ve
// bakim_gorevi.durum = 'TAMAMLANDI' yapar. Tek bir transaction içinde.
router.post("/:gorev_id/kaydi-tamamla", async (req, res, next) => {
  const { gorev_id } = req.params;
  const { checklist_sonuclari, notlar, fotograf_urlleri, imza_url } = req.body;

  if (!checklist_sonuclari || !imza_url) {
    return res.status(400).json({
      hata_kodu: "EKSIK_ALAN",
      mesaj: "checklist_sonuclari ve imza_url alanları zorunludur.",
    });
  }

  try {
    await req.db.query("BEGIN");

    // Görev gerçekten bu kullanıcıya mı atanmış — kontrol
    const { rows: gorevRows } = await req.db.query(
      `SELECT gorev_id, atanan_kullanici_id, durum FROM bakim_gorevi WHERE gorev_id = $1 FOR UPDATE`,
      [gorev_id]
    );
    const gorev = gorevRows[0];

    if (!gorev) {
      await req.db.query("ROLLBACK");
      return res.status(404).json({
        hata_kodu: "GOREV_BULUNAMADI",
        mesaj: "Belirtilen görev kaydı bulunamadı.",
      });
    }
    if (gorev.atanan_kullanici_id !== req.user.kullanici_id) {
      await req.db.query("ROLLBACK");
      return res.status(403).json({
        hata_kodu: "YETKI_YOK",
        mesaj: "Bu görev size atanmamış.",
      });
    }
    if (gorev.durum === "TAMAMLANDI") {
      await req.db.query("ROLLBACK");
      return res.status(409).json({
        hata_kodu: "GOREV_ZATEN_TAMAMLANDI",
        mesaj: "Bu görev zaten tamamlanmış.",
      });
    }

    const { rows: kayitRows } = await req.db.query(
      `INSERT INTO bakim_kaydi
         (gorev_id, tamamlayan_kullanici_id, checklist_sonuclari, notlar, fotograflar, imza_url, kilitli_mi)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING kayit_id, tamamlanma_tarihi`,
      [
        gorev_id,
        req.user.kullanici_id,
        JSON.stringify(checklist_sonuclari),
        notlar || null,
        fotograf_urlleri || [],
        imza_url,
      ]
    );

    await req.db.query(
      `UPDATE bakim_gorevi SET durum = 'TAMAMLANDI' WHERE gorev_id = $1`,
      [gorev_id]
    );

    await req.db.query("COMMIT");

    res.status(201).json({
      mesaj: "Bakım kaydı oluşturuldu, görev tamamlandı.",
      kayit: kayitRows[0],
    });
  } catch (err) {
    await req.db.query("ROLLBACK");
    next(err);
  }
});

module.exports = router;
