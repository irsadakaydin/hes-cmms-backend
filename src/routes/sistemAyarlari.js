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

module.exports = router;
