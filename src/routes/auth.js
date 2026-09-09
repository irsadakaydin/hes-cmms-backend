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
    const { eposta, sifre, isletme_id } = req.body;
    if (!eposta || !sifre) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "eposta ve sifre alanları zorunludur.",
      });
    }

    // Aynı e-posta artık farklı holdinglerde AYRI birer hesaba ait
    // olabilir — bu yüzden önce eşleşen TÜM hesapları çekiyoruz.
    // isletme_id verilmişse (önceki "birden fazla hesap" adımından sonra
    // seçim yapıldıysa) doğrudan o hesaba daraltıyoruz.
    const { rows } = await pool.query(
      `SELECT k.kullanici_id, k.isletme_id, k.ad_soyad, k.eposta, k.sifre_hash, k.rol, k.aktif_mi,
              i.durum AS isletme_durum, i.ad AS isletme_adi
       FROM kullanici k
       LEFT JOIN isletme i ON i.isletme_id = k.isletme_id
       WHERE k.eposta = $1 AND k.aktif_mi = TRUE
         AND ($2::uuid IS NULL OR k.isletme_id = $2)`,
      [eposta, isletme_id || null]
    );

    // Yalnızca holdingi aktif olan (ya da Platform Admin) hesapları, ve
    // şifresi doğru olanları aday olarak bırak.
    const adaylar = [];
    for (const k of rows) {
      if (k.rol !== "ADMIN" && k.isletme_durum === "PASIF") continue;
      if (await bcrypt.compare(sifre, k.sifre_hash)) adaylar.push(k);
    }

    if (adaylar.length === 0) {
      return res.status(401).json({
        hata_kodu: "GIRIS_BASARISIZ",
        mesaj: "E-posta veya şifre hatalı, ya da hesap pasif.",
      });
    }

    if (adaylar.length > 1) {
      // Aynı e-posta/şifre birden fazla holdingde geçerli — hangi hesapla
      // giriş yapılacağını netleştirmek üzere seçim listesi döndür.
      return res.status(300).json({
        hata_kodu: "BIRDEN_FAZLA_HESAP",
        mesaj: "Bu e-posta birden fazla holdingde kayıtlı. Giriş yapmak istediğiniz holdingi seçin.",
        hesaplar: adaylar.map((k) => ({ isletme_id: k.isletme_id, isletme_adi: k.isletme_adi })),
      });
    }

    const kullanici = adaylar[0];

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
    // Giriş logu — "Log Giriş" sayfasında kişi/tarih bazlı görüntülenir.
    await pool.query(
      `INSERT INTO giris_kaydi (kullanici_id, ip_adresi) VALUES ($1, $2)`,
      [kullanici.kullanici_id, req.ip || null]
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
