const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();

router.use(requireAuth, withDbContext);

// GET /api/v1/santraller — kullanıcının erişimi olan santralleri listeler
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT s.santral_id, s.ad, s.konum, s.kurulu_guc_mw, s.turbin_tipi, s.durum
       FROM santral s
       WHERE s.santral_id IN (
         SELECT santral_id FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1
       )
       ORDER BY s.ad`,
      [req.user.kullanici_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/santraller/:santral_id — tek santral detayı
router.get("/:santral_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT s.*
       FROM santral s
       WHERE s.santral_id = $1
         AND s.santral_id IN (
           SELECT santral_id FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $2
         )`,
      [req.params.santral_id, req.user.kullanici_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        hata_kodu: "SANTRAL_BULUNAMADI",
        mesaj: "Santral bulunamadı ya da erişim yetkiniz yok.",
      });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
