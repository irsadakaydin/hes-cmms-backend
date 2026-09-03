const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();

// POST /api/v1/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { eposta, sifre } = req.body;
    if (!eposta || !sifre) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "eposta ve sifre alanları zorunludur.",
      });
    }

    const { rows } = await pool.query(
      `SELECT kullanici_id, isletme_id, ad_soyad, eposta, sifre_hash, rol, aktif_mi
       FROM kullanici WHERE eposta = $1`,
      [eposta]
    );

    const kullanici = rows[0];
    if (!kullanici || !kullanici.aktif_mi) {
      return res.status(401).json({
        hata_kodu: "GIRIS_BASARISIZ",
        mesaj: "E-posta veya şifre hatalı, ya da hesap pasif.",
      });
    }

    const sifreDogru = await bcrypt.compare(sifre, kullanici.sifre_hash);
    if (!sifreDogru) {
      return res.status(401).json({
        hata_kodu: "GIRIS_BASARISIZ",
        mesaj: "E-posta veya şifre hatalı.",
      });
    }

    const token = jwt.sign(
      {
        kullanici_id: kullanici.kullanici_id,
        rol: kullanici.rol,
        isletme_id: kullanici.isletme_id, // Platform Admin için null
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    await pool.query(
      `UPDATE kullanici SET son_giris_tarihi = now() WHERE kullanici_id = $1`,
      [kullanici.kullanici_id]
    );

    res.json({
      access_token: token,
      kullanici: {
        kullanici_id: kullanici.kullanici_id,
        ad_soyad: kullanici.ad_soyad,
        eposta: kullanici.eposta,
        rol: kullanici.rol,
        isletme_id: kullanici.isletme_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/ben — oturum açan kullanıcının profili + erişimli santraller
router.get("/ben", requireAuth, withDbContext, async (req, res, next) => {
  try {
    const { rows: kullaniciRows } = await req.db.query(
      `SELECT kullanici_id, isletme_id, ad_soyad, eposta, telefon, rol, son_giris_tarihi
       FROM kullanici WHERE kullanici_id = $1`,
      [req.user.kullanici_id]
    );

    const { rows: santralRows } = await req.db.query(
      `SELECT s.santral_id, s.ad, s.konum
       FROM santral s
       WHERE s.santral_id IN (
         SELECT santral_id FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1
       )
       ORDER BY s.ad`,
      [req.user.kullanici_id]
    );

    res.json({
      kullanici: kullaniciRows[0],
      erisimli_santraller: santralRows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
