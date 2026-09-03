const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const SABLON_YONETICI_ROLLERI = ["ISLETME_ADMIN", "ADMIN"];

// GET /api/v1/bakim-sablonlari — tüm aktif şablonları listeler (?ekipman_tipi= ile filtrelenebilir)
router.get("/", async (req, res, next) => {
  try {
    const { ekipman_tipi } = req.query;
    const params = [];
    let sorgu = `SELECT sablon_id, ad, ekipman_tipi, periyot_tipi, versiyon, aktif_mi, olusturma_tarihi
                 FROM bakim_sablonu WHERE aktif_mi = TRUE`;
    if (ekipman_tipi) {
      params.push(ekipman_tipi);
      sorgu += ` AND ekipman_tipi = $${params.length}`;
    }
    sorgu += ` ORDER BY ad`;

    const { rows } = await req.db.query(sorgu, params);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/bakim-sablonlari/:sablon_id — şablon detayı + checklist yapısı
router.get("/:sablon_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/bakim-sablonlari — yeni şablon oluşturur (föy dijitalleştirme)
router.post("/", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { ad, ekipman_tipi, periyot_tipi, checklist_json } = req.body;
    if (!ad || !ekipman_tipi || !periyot_tipi || !checklist_json) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "ad, ekipman_tipi, periyot_tipi ve checklist_json alanları zorunludur.",
      });
    }

    const { rows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, olusturan_kullanici_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ad, ekipman_tipi, periyot_tipi, JSON.stringify(checklist_json), req.user.kullanici_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "22P02") {
      return res.status(400).json({
        hata_kodu: "GECERSIZ_PERIYOT",
        mesaj: "periyot_tipi GUNLUK/HAFTALIK/AYLIK/UC_AYLIK/ALTI_AYLIK/YILLIK değerlerinden biri olmalı.",
      });
    }
    next(err);
  }
});

// PATCH /api/v1/bakim-sablonlari/:sablon_id — YENİ VERSİYON oluşturur, eskiyi pasifleştirir
router.patch("/:sablon_id", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: eskiRows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const eski = eskiRows[0];
    if (!eski) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
    }

    const ad = req.body.ad ?? eski.ad;
    const ekipman_tipi = req.body.ekipman_tipi ?? eski.ekipman_tipi;
    const periyot_tipi = req.body.periyot_tipi ?? eski.periyot_tipi;
    const checklist_json = req.body.checklist_json
      ? JSON.stringify(req.body.checklist_json)
      : JSON.stringify(eski.checklist_json);

    await req.db.query("BEGIN");
    await req.db.query(`UPDATE bakim_sablonu SET aktif_mi = FALSE WHERE sablon_id = $1`, [eski.sablon_id]);

    const { rows: yeniRows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, versiyon, olusturan_kullanici_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ad, ekipman_tipi, periyot_tipi, checklist_json, eski.versiyon + 1, req.user.kullanici_id]
    );
    await req.db.query("COMMIT");

    res.status(201).json({
      mesaj: "Yeni versiyon oluşturuldu, önceki versiyon pasifleştirildi.",
      yeni_sablon: yeniRows[0],
    });
  } catch (err) {
    await req.db.query("ROLLBACK");
    next(err);
  }
});

// POST /api/v1/bakim-sablonlari/:sablon_id/kopyala — mevcut şablondan yeni bir tane türetir
router.post("/:sablon_id/kopyala", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: kaynakRows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const kaynak = kaynakRows[0];
    if (!kaynak) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Kaynak şablon bulunamadı." });
    }

    const yeniAd = req.body.ad || `${kaynak.ad} (kopya)`;

    const { rows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, olusturan_kullanici_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [yeniAd, kaynak.ekipman_tipi, kaynak.periyot_tipi, JSON.stringify(kaynak.checklist_json), req.user.kullanici_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
