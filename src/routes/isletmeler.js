const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

// GET /api/v1/isletmeler — tüm işletmeleri listeler (yalnızca Platform Admin)
router.get("/", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT isletme_id, ad, alan_adi, durum, olusturma_tarihi FROM isletme ORDER BY ad`
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/isletmeler/:isletme_id — Platform Admin ya da kendi İşletme Admin'i
router.get("/:isletme_id", async (req, res, next) => {
  try {
    const { isletme_id } = req.params;
    const yetkiVar = req.user.rol === "ADMIN" || req.user.isletme_id === isletme_id;
    if (!yetkiVar) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu işletmeye erişim yetkiniz yok." });
    }

    const { rows: isletmeRows } = await req.db.query(`SELECT * FROM isletme WHERE isletme_id = $1`, [
      isletme_id,
    ]);
    if (!isletmeRows[0]) {
      return res.status(404).json({ hata_kodu: "ISLETME_BULUNAMADI", mesaj: "İşletme bulunamadı." });
    }

    const { rows: sayilar } = await req.db.query(
      `SELECT
         (SELECT COUNT(*) FROM santral WHERE isletme_id = $1) AS santral_sayisi,
         (SELECT COUNT(*) FROM kullanici WHERE isletme_id = $1) AS kullanici_sayisi`,
      [isletme_id]
    );

    res.json({ ...isletmeRows[0], ...sayilar[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/isletmeler — yeni işletme + ilk İşletme Admin kullanıcısı oluşturur
router.post("/", requireRole("ADMIN"), async (req, res, next) => {
  const { ad, alan_adi, ilk_admin } = req.body;

  if (!ad || !alan_adi || !ilk_admin || !ilk_admin.ad_soyad || !ilk_admin.eposta) {
    return res.status(400).json({
      hata_kodu: "EKSIK_ALAN",
      mesaj: "ad, alan_adi ve ilk_admin (ad_soyad, eposta) alanları zorunludur.",
    });
  }

  try {
    await req.db.query("BEGIN");

    const { rows: isletmeRows } = await req.db.query(
      `INSERT INTO isletme (ad, alan_adi) VALUES ($1, $2) RETURNING *`,
      [ad, alan_adi]
    );
    const isletme = isletmeRows[0];

    // Geçici şifre — kullanıcı ilk girişte değiştirmeli (davet e-postası akışı ileride eklenir)
    const bcrypt = require("bcryptjs");
    const gecidiSifreHash = await bcrypt.hash(Math.random().toString(36).slice(2) + Date.now(), 10);

    const { rows: kullaniciRows } = await req.db.query(
      `INSERT INTO kullanici (isletme_id, ad_soyad, eposta, sifre_hash, rol)
       VALUES ($1, $2, $3, $4, 'ISLETME_ADMIN')
       RETURNING kullanici_id, ad_soyad, eposta, rol`,
      [isletme.isletme_id, ilk_admin.ad_soyad, ilk_admin.eposta, gecidiSifreHash]
    );

    await req.db.query("COMMIT");

    res.status(201).json({
      isletme,
      ilk_admin: kullaniciRows[0],
      not: "İlk admin için şifre sıfırlama e-postası gönderilmeli (bu taslakta e-posta entegrasyonu yok).",
    });
  } catch (err) {
    await req.db.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({
        hata_kodu: "ALAN_ADI_KULLANIMDA",
        mesaj: "Bu alan_adi veya işletme adı zaten kullanımda.",
      });
    }
    next(err);
  }
});

// PATCH /api/v1/isletmeler/:isletme_id
router.patch("/:isletme_id", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const izinliAlanlar = ["ad", "alan_adi"];
    const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));
    if (guncellenecekler.length === 0) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Güncellenecek en az bir alan gönderilmeli." });
    }

    const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
    const degerler = guncellenecekler.map((alan) => req.body[alan]);

    const { rows } = await req.db.query(
      `UPDATE isletme SET ${setIfadesi} WHERE isletme_id = $${guncellenecekler.length + 1} RETURNING *`,
      [...degerler, req.params.isletme_id]
    );
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "ISLETME_BULUNAMADI", mesaj: "İşletme bulunamadı." });
    }
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ hata_kodu: "ALAN_ADI_KULLANIMDA", mesaj: "Bu alan_adi zaten kullanımda." });
    }
    next(err);
  }
});

// POST /api/v1/isletmeler/:isletme_id/pasiflestir
router.post("/:isletme_id/pasiflestir", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `UPDATE isletme SET durum = 'PASIF' WHERE isletme_id = $1 RETURNING *`,
      [req.params.isletme_id]
    );
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "ISLETME_BULUNAMADI", mesaj: "İşletme bulunamadı." });
    }
    res.json({ mesaj: "İşletme pasifleştirildi, tüm kullanıcı girişleri engellendi.", isletme: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
