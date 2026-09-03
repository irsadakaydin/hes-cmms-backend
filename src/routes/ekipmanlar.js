const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

// Ekipman ekleme/düzenleme/silme için minimum rol
const YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

/**
 * Verilen santral_id, oturum açan kullanıcının erişebildiği santraller
 * arasında mı — açık ve anlaşılır bir 403 döndürmek için RLS'den ÖNCE
 * uygulama katmanında kontrol ediyoruz (RLS zaten arka planda ikinci
 * bir savunma hattı olarak duruyor).
 */
async function santralErisimVarMi(req, santral_id) {
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

// GET /api/v1/santraller/:santral_id/ekipmanlar
router.get("/santraller/:santral_id/ekipmanlar", async (req, res, next) => {
  try {
    if (!(await santralErisimVarMi(req, req.params.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(
      `SELECT ekipman_id, ad, tip, seri_no, uretici, kurulum_tarihi, konum_notu, durum
       FROM ekipman WHERE santral_id = $1 ORDER BY ad`,
      [req.params.santral_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ekipmanlar/:ekipman_id
router.get("/ekipmanlar/:ekipman_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    const ekipman = rows[0];
    if (!ekipman) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, ekipman.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }
    res.json(ekipman);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller/:santral_id/ekipmanlar
router.post(
  "/santraller/:santral_id/ekipmanlar",
  requireRole(...YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { santral_id } = req.params;
      if (!(await santralErisimVarMi(req, santral_id))) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
      }

      const { ad, tip, seri_no, uretici, kurulum_tarihi, konum_notu } = req.body;
      if (!ad || !tip) {
        return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "ad ve tip alanları zorunludur." });
      }

      const { rows } = await req.db.query(
        `INSERT INTO ekipman (santral_id, ad, tip, seri_no, uretici, kurulum_tarihi, konum_notu)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [santral_id, ad, tip, seri_no || null, uretici || null, kurulum_tarihi || null, konum_notu || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/ekipmanlar/:ekipman_id
router.patch("/ekipmanlar/:ekipman_id", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(
      `SELECT santral_id FROM ekipman WHERE ekipman_id = $1`,
      [req.params.ekipman_id]
    );
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }

    // Yalnızca gönderilen alanları güncelle (kısmi güncelleme)
    const izinliAlanlar = ["ad", "tip", "seri_no", "uretici", "kurulum_tarihi", "konum_notu", "durum"];
    const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));
    if (guncellenecekler.length === 0) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Güncellenecek en az bir alan gönderilmeli." });
    }

    const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
    const degerler = guncellenecekler.map((alan) => req.body[alan]);

    const { rows } = await req.db.query(
      `UPDATE ekipman SET ${setIfadesi} WHERE ekipman_id = $${guncellenecekler.length + 1} RETURNING *`,
      [...degerler, req.params.ekipman_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/ekipmanlar/:ekipman_id — soft delete (durum = HURDA)
router.delete("/ekipmanlar/:ekipman_id", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(
      `SELECT santral_id FROM ekipman WHERE ekipman_id = $1`,
      [req.params.ekipman_id]
    );
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(
      `UPDATE ekipman SET durum = 'HURDA' WHERE ekipman_id = $1 RETURNING *`,
      [req.params.ekipman_id]
    );
    res.json({ mesaj: "Ekipman pasifleştirildi (HURDA).", ekipman: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
