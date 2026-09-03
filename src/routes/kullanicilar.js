const express = require("express");
const bcrypt = require("bcryptjs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const ISLETME_YONETICI_ROLLERI = ["ISLETME_ADMIN", "ADMIN"];

/** Hedef kullanıcının, isteği yapanın işletmesiyle aynı işletmede olup olmadığını kontrol eder. */
async function ayniIsletmedeMi(req, hedefKullaniciId) {
  const { rows } = await req.db.query(`SELECT isletme_id FROM kullanici WHERE kullanici_id = $1`, [
    hedefKullaniciId,
  ]);
  if (!rows[0]) return { bulundu: false };
  const ayni = req.user.rol === "ADMIN" || rows[0].isletme_id === req.user.isletme_id;
  return { bulundu: true, ayni, isletme_id: rows[0].isletme_id };
}

// GET /api/v1/isletmeler/:isletme_id/kullanicilar
router.get(
  "/isletmeler/:isletme_id/kullanicilar",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { isletme_id } = req.params;
      if (req.user.rol !== "ADMIN" && req.user.isletme_id !== isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu işletmeye erişim yetkiniz yok." });
      }

      const { rows } = await req.db.query(
        `SELECT kullanici_id, ad_soyad, eposta, telefon, rol, aktif_mi, son_giris_tarihi
         FROM kullanici WHERE isletme_id = $1 ORDER BY ad_soyad`,
        [isletme_id]
      );
      res.json({ veri: rows });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/kullanicilar/:kullanici_id
router.get(
  "/kullanicilar/:kullanici_id",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { bulundu, ayni } = await ayniIsletmedeMi(req, req.params.kullanici_id);
      if (!bulundu) {
        return res.status(404).json({ hata_kodu: "KULLANICI_BULUNAMADI", mesaj: "Kullanıcı bulunamadı." });
      }
      if (!ayni) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu kullanıcıya erişim yetkiniz yok." });
      }

      const { rows } = await req.db.query(
        `SELECT kullanici_id, isletme_id, ad_soyad, eposta, telefon, rol, aktif_mi, son_giris_tarihi
         FROM kullanici WHERE kullanici_id = $1`,
        [req.params.kullanici_id]
      );

      const { rows: erisimler } = await req.db.query(
        `SELECT s.santral_id, s.ad FROM kullanici_santral ks
         JOIN santral s ON s.santral_id = ks.santral_id
         WHERE ks.kullanici_id = $1 ORDER BY s.ad`,
        [req.params.kullanici_id]
      );

      res.json({ ...rows[0], santral_erisimleri: erisimler });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/isletmeler/:isletme_id/kullanicilar — yeni kullanıcı davet eder
router.post(
  "/isletmeler/:isletme_id/kullanicilar",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { isletme_id } = req.params;
      if (req.user.rol !== "ADMIN" && req.user.isletme_id !== isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu işletmeye erişim yetkiniz yok." });
      }

      const { ad_soyad, eposta, telefon, rol } = req.body;
      const izinliRoller = ["ISLETME_ADMIN", "SANTRAL_SORUMLUSU", "SAHA_PERSONELI", "IZLEYICI"];
      if (!ad_soyad || !eposta || !rol || !izinliRoller.includes(rol)) {
        return res.status(400).json({
          hata_kodu: "EKSIK_ALAN",
          mesaj: `ad_soyad, eposta ve rol (${izinliRoller.join("/")}) alanları zorunludur.`,
        });
      }

      // Geçici şifre — gerçek akışta burada bir "davet e-postası + şifre belirleme linki" gönderilir
      const geciciSifre = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const sifreHash = await bcrypt.hash(geciciSifre, 10);

      const { rows } = await req.db.query(
        `INSERT INTO kullanici (isletme_id, ad_soyad, eposta, sifre_hash, telefon, rol)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING kullanici_id, isletme_id, ad_soyad, eposta, telefon, rol, aktif_mi`,
        [isletme_id, ad_soyad, eposta, sifreHash, telefon || null, rol]
      );

      res.status(201).json({
        kullanici: rows[0],
        not: "Gerçek kullanımda burada bir davet e-postası (şifre belirleme linkiyle) gönderilmelidir.",
      });
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ hata_kodu: "EPOSTA_KULLANIMDA", mesaj: "Bu e-posta zaten kayıtlı." });
      }
      next(err);
    }
  }
);

// PATCH /api/v1/kullanicilar/:kullanici_id
router.patch(
  "/kullanicilar/:kullanici_id",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { bulundu, ayni } = await ayniIsletmedeMi(req, req.params.kullanici_id);
      if (!bulundu) {
        return res.status(404).json({ hata_kodu: "KULLANICI_BULUNAMADI", mesaj: "Kullanıcı bulunamadı." });
      }
      if (!ayni) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu kullanıcıya erişim yetkiniz yok." });
      }

      const izinliAlanlar = ["ad_soyad", "telefon", "rol"];
      const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));
      if (guncellenecekler.length === 0) {
        return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Güncellenecek en az bir alan gönderilmeli." });
      }

      const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
      const degerler = guncellenecekler.map((alan) => req.body[alan]);

      const { rows } = await req.db.query(
        `UPDATE kullanici SET ${setIfadesi} WHERE kullanici_id = $${guncellenecekler.length + 1}
         RETURNING kullanici_id, ad_soyad, eposta, telefon, rol, aktif_mi`,
        [...degerler, req.params.kullanici_id]
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/kullanicilar/:kullanici_id/santral-erisimi
router.post(
  "/kullanicilar/:kullanici_id/santral-erisimi",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { bulundu, ayni, isletme_id } = await ayniIsletmedeMi(req, req.params.kullanici_id);
      if (!bulundu) {
        return res.status(404).json({ hata_kodu: "KULLANICI_BULUNAMADI", mesaj: "Kullanıcı bulunamadı." });
      }
      if (!ayni) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu kullanıcıya erişim yetkiniz yok." });
      }

      const { santral_id } = req.body;
      if (!santral_id) {
        return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "santral_id alanı zorunludur." });
      }

      // Santral gerçekten aynı işletmeye mi ait — çapraz işletme erişim ataması engellenir
      const { rows: santralRows } = await req.db.query(
        `SELECT santral_id FROM santral WHERE santral_id = $1 AND isletme_id = $2`,
        [santral_id, isletme_id]
      );
      if (!santralRows[0]) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_SANTRAL",
          mesaj: "Belirtilen santral, kullanıcının işletmesine ait değil.",
        });
      }

      await req.db.query(
        `INSERT INTO kullanici_santral (kullanici_id, santral_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.kullanici_id, santral_id]
      );
      res.status(201).json({ mesaj: "Santral erişimi eklendi." });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/kullanicilar/:kullanici_id/santral-erisimi/:santral_id
router.delete(
  "/kullanicilar/:kullanici_id/santral-erisimi/:santral_id",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { bulundu, ayni } = await ayniIsletmedeMi(req, req.params.kullanici_id);
      if (!bulundu) {
        return res.status(404).json({ hata_kodu: "KULLANICI_BULUNAMADI", mesaj: "Kullanıcı bulunamadı." });
      }
      if (!ayni) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu kullanıcıya erişim yetkiniz yok." });
      }

      await req.db.query(
        `DELETE FROM kullanici_santral WHERE kullanici_id = $1 AND santral_id = $2`,
        [req.params.kullanici_id, req.params.santral_id]
      );
      res.json({ mesaj: "Santral erişimi kaldırıldı." });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/kullanicilar/:kullanici_id/engelle
router.post(
  "/kullanicilar/:kullanici_id/engelle",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { bulundu, ayni } = await ayniIsletmedeMi(req, req.params.kullanici_id);
      if (!bulundu) {
        return res.status(404).json({ hata_kodu: "KULLANICI_BULUNAMADI", mesaj: "Kullanıcı bulunamadı." });
      }
      if (!ayni) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu kullanıcıya erişim yetkiniz yok." });
      }

      await req.db.query(`UPDATE kullanici SET aktif_mi = FALSE WHERE kullanici_id = $1`, [
        req.params.kullanici_id,
      ]);
      res.json({ mesaj: "Kullanıcı hesabı engellendi." });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/kullanicilar/:kullanici_id/engeli-kaldir
router.post(
  "/kullanicilar/:kullanici_id/engeli-kaldir",
  requireRole(...ISLETME_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { bulundu, ayni } = await ayniIsletmedeMi(req, req.params.kullanici_id);
      if (!bulundu) {
        return res.status(404).json({ hata_kodu: "KULLANICI_BULUNAMADI", mesaj: "Kullanıcı bulunamadı." });
      }
      if (!ayni) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu kullanıcıya erişim yetkiniz yok." });
      }

      await req.db.query(`UPDATE kullanici SET aktif_mi = TRUE WHERE kullanici_id = $1`, [
        req.params.kullanici_id,
      ]);
      res.json({ mesaj: "Kullanıcı hesabının engeli kaldırıldı." });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
