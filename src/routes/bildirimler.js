const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

// GET /api/v1/bildirimler/bana-gelen — oturum açan kullanıcının bildirim geçmişi
router.get("/bildirimler/bana-gelen", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT bildirim_id, gorev_id, tip, icerik_ozeti, gonderim_tarihi, durum
       FROM bildirim
       WHERE alici_kullanici_id = $1
       ORDER BY gonderim_tarihi DESC
       LIMIT 100`,
      [req.user.kullanici_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/gorevler/:gorev_id/bildirimler — bir göreve ait tüm bildirimler
router.get(
  "/gorevler/:gorev_id/bildirimler",
  requireRole("SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"),
  async (req, res, next) => {
    try {
      const { rows } = await req.db.query(
        `SELECT b.bildirim_id, b.tip, b.icerik_ozeti, b.gonderim_tarihi, b.durum,
                k.ad_soyad AS alici_ad_soyad
         FROM bildirim b
         JOIN kullanici k ON k.kullanici_id = b.alici_kullanici_id
         WHERE b.gorev_id = $1
         ORDER BY b.gonderim_tarihi DESC`,
        [req.params.gorev_id]
      );
      res.json({ veri: rows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
