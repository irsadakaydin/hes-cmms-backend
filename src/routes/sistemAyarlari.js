const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");
// NOT: db.js muhtemelen pool'u { pool } şeklinde adlandırılmış bir dışa
// aktarım olarak veriyor (doğrudan "module.exports = pool" değil) —
// "pool.query is not a function" hatası tam olarak bunu gösteriyor.
const { pool } = require("../db");

const router = express.Router();

// GET /api/v1/sistem-ayarlari/arkaplan — GİRİŞ SAYFASI DA DAHİL herkes
// tarafından okunabilmeli (oturum açmadan önce de arka plan gösterilir),
// bu yüzden requireAuth/withDbContext UYGULANMIYOR — doğrudan havuzu
// (pool) kullanıyoruz.
router.get("/sistem-ayarlari/arkaplan", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT deger FROM sistem_ayarlari WHERE anahtar = 'arkaplan_resmi'`
    );
    res.json({ arkaplan_resmi: rows[0]?.deger || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/sistem-ayarlari/arkaplan — yalnızca Platform Admin (GM)
// değiştirebilir. Gövdede { resim_base64: "data:image/...;base64,..." }
// beklenir; resim doğrudan veritabanında (data URI olarak) saklanır, ayrı
// bir dosya deposuna ihtiyaç duyulmaz.
router.post(
  "/sistem-ayarlari/arkaplan",
  express.json({ limit: "12mb" }),
  requireAuth,
  withDbContext,
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const { resim_base64 } = req.body;
      if (!resim_base64 || typeof resim_base64 !== "string" || !resim_base64.startsWith("data:image/")) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_RESIM",
          mesaj: "resim_base64 alanı, 'data:image/...' ile başlayan geçerli bir resim verisi olmalıdır.",
        });
      }
      // Kabaca 8MB üstü resimleri reddet (veritabanını şişirmemek için).
      if (resim_base64.length > 11_000_000) {
        return res.status(400).json({
          hata_kodu: "RESIM_COK_BUYUK",
          mesaj: "Resim çok büyük — lütfen 8MB altında bir görsel yükleyin.",
        });
      }

      await pool.query(
        `INSERT INTO sistem_ayarlari (anahtar, deger, guncelleme_tarihi)
         VALUES ('arkaplan_resmi', $1, now())
         ON CONFLICT (anahtar) DO UPDATE SET deger = EXCLUDED.deger, guncelleme_tarihi = now()`,
        [resim_base64]
      );

      res.json({ mesaj: "Arka plan resmi güncellendi.", arkaplan_resmi: resim_base64 });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/sistem-ayarlari/arkaplan — varsayılan (statik) arka plana
// dönmek için özel resmi kaldırır.
router.delete(
  "/sistem-ayarlari/arkaplan",
  requireAuth,
  withDbContext,
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      await pool.query(
        `UPDATE sistem_ayarlari SET deger = NULL, guncelleme_tarihi = now() WHERE anahtar = 'arkaplan_resmi'`
      );
      res.json({ mesaj: "Arka plan resmi varsayılana döndürüldü." });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/sistem-ayarlari/zamanlayici/:santral_id — belirli bir
// SANTRALİN (tesisin) zamanlayıcısının (görev üretimi, hatırlatma,
// geciken işaretleme) aktif olup olmadığını döner.
router.get(
  "/sistem-ayarlari/zamanlayici/:santral_id",
  requireAuth,
  withDbContext,
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT zamanlayici_aktif FROM santral WHERE santral_id = $1`,
        [req.params.santral_id]
      );
      if (!rows[0]) {
        return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
      }
      res.json({ aktif_mi: rows[0].zamanlayici_aktif });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/sistem-ayarlari/zamanlayici/:santral_id — { aktif_mi: true|false }
// yalnızca Platform Admin (GM) değiştirebilir. Zamanlayıcının kendisi
// (hes_cmms_scheduler.js), her çalıştığında HER PLAN için, o planın
// bağlı olduğu SANTRALİN bu bayrağını kontrol eder — pasif olan
// santrallerin planları atlanır, diğerleri (aynı holding dahil) normal
// işlenir.
router.patch(
  "/sistem-ayarlari/zamanlayici/:santral_id",
  requireAuth,
  withDbContext,
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      if (typeof req.body.aktif_mi !== "boolean") {
        return res.status(400).json({
          hata_kodu: "EKSIK_ALAN",
          mesaj: "aktif_mi alanı (true/false) zorunludur.",
        });
      }
      const { rows } = await pool.query(
        `UPDATE santral SET zamanlayici_aktif = $1 WHERE santral_id = $2 RETURNING santral_id`,
        [req.body.aktif_mi, req.params.santral_id]
      );
      if (!rows[0]) {
        return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
      }
      res.json({
        mesaj: req.body.aktif_mi ? "Zamanlayıcı bu santral için aktifleştirildi." : "Zamanlayıcı bu santral için pasifleştirildi.",
        aktif_mi: req.body.aktif_mi,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
