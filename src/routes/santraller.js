const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();

router.use(requireAuth, withDbContext);

// GET /api/v1/santraller — kullanıcının erişimi olan santralleri listeler
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT s.santral_id, s.ad, s.konum, s.kurulu_guc_mw, s.turbin_tipi, s.durum,
              s.isletme_id, i.ad AS isletme_adi
       FROM santral s
       JOIN isletme i ON i.isletme_id = s.isletme_id
       WHERE s.santral_id IN (
         SELECT santral_id FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1
       )
       ORDER BY i.ad, s.ad`,
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
      `SELECT s.*, i.ad AS isletme_adi
       FROM santral s
       JOIN isletme i ON i.isletme_id = s.isletme_id
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

// GET /api/v1/santraller/:santral_id/atanabilir-kullanicilar — bu santralde
// bakım görevi ATANABİLECEK kullanıcıları listeler. Yalnızca fiilen sahada
// bakımı yapacak roller (Saha Personeli, Santral Sorumlusu) döner — Platform
// Admin/İşletme Admin gibi yönetici roller, santrale erişimleri olsa bile
// bu listede görünmez (onlar görevi fiilen yapan ki değil, yöneten kişilerdir).
router.get("/:santral_id/atanabilir-kullanicilar", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT DISTINCT k.kullanici_id, k.ad_soyad, k.rol
       FROM kullanici k
       WHERE k.kullanici_id IN (
         SELECT kullanici_id FROM v_kullanici_yetkili_santraller WHERE santral_id = $1
       )
       AND k.aktif_mi = TRUE
       AND k.rol IN ('SAHA_PERSONELI', 'SANTRAL_SORUMLUSU')
       ORDER BY k.ad_soyad`,
      [req.params.santral_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller — yeni santral oluşturur (gövdede isletme_id
// belirtilir). Yalnızca Platform Admin — bir holdinge yeni tesis eklemek
// büyük bir organizasyonel karar olduğu için bilinçli olarak GM'e ayrılmıştır.
router.post("/", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { isletme_id, ad, konum, kurulu_guc_mw, turbin_tipi, isletmeye_alma_tarihi } = req.body;
    if (!isletme_id || !ad) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "isletme_id ve ad alanları zorunludur." });
    }

    const { rows: isletmeRows } = await req.db.query(`SELECT isletme_id FROM isletme WHERE isletme_id = $1`, [
      isletme_id,
    ]);
    if (!isletmeRows[0]) {
      return res.status(404).json({ hata_kodu: "ISLETME_BULUNAMADI", mesaj: "Holding bulunamadı." });
    }

    const { rows } = await req.db.query(
      `INSERT INTO santral (isletme_id, ad, konum, kurulu_guc_mw, turbin_tipi, isletmeye_alma_tarihi)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [isletme_id, ad, konum || null, kurulu_guc_mw || null, turbin_tipi || null, isletmeye_alma_tarihi || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ hata_kodu: "SANTRAL_ADI_KULLANIMDA", mesaj: "Bu isimde bir santral zaten var." });
    }
    next(err);
  }
});

// PATCH /api/v1/santraller/:santral_id — santral bilgilerini düzenler
router.patch("/:santral_id", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const izinliAlanlar = ["ad", "konum", "kurulu_guc_mw", "turbin_tipi", "isletmeye_alma_tarihi", "durum"];
    const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));
    if (guncellenecekler.length === 0) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Güncellenecek en az bir alan gönderilmeli." });
    }
    const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
    const degerler = guncellenecekler.map((alan) => req.body[alan]);

    const { rows } = await req.db.query(
      `UPDATE santral SET ${setIfadesi} WHERE santral_id = $${guncellenecekler.length + 1} RETURNING *`,
      [...degerler, req.params.santral_id]
    );
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller/:santral_id/pasiflestir
router.post("/:santral_id/pasiflestir", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `UPDATE santral SET durum = 'DEVRE_DISI' WHERE santral_id = $1 RETURNING *`,
      [req.params.santral_id]
    );
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }
    res.json({ mesaj: "Santral pasifleştirildi.", santral: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller/:santral_id/aktiflestir
router.post("/:santral_id/aktiflestir", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`UPDATE santral SET durum = 'AKTIF' WHERE santral_id = $1 RETURNING *`, [
      req.params.santral_id,
    ]);
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }
    res.json({ mesaj: "Santral yeniden aktifleştirildi.", santral: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/santraller/:santral_id — yalnızca içinde hiç ekipman/bakım
// planı/kullanıcı erişimi yoksa gerçekten silinir; aksi halde veri kaybını
// önlemek için reddedilir.
router.delete("/:santral_id", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows: sayimRows } = await req.db.query(
      `SELECT
         (SELECT COUNT(*) FROM ekipman WHERE santral_id = $1) AS ekipman_sayisi,
         (SELECT COUNT(*) FROM bakim_plani WHERE santral_id = $1) AS plan_sayisi,
         (SELECT COUNT(*) FROM kullanici_santral WHERE santral_id = $1) AS erisim_sayisi`,
      [req.params.santral_id]
    );
    const { ekipman_sayisi, plan_sayisi, erisim_sayisi } = sayimRows[0];
    if (Number(ekipman_sayisi) > 0 || Number(plan_sayisi) > 0 || Number(erisim_sayisi) > 0) {
      return res.status(409).json({
        hata_kodu: "SANTRAL_BOS_DEGIL",
        mesaj: `Bu santralde ${ekipman_sayisi} ekipman, ${plan_sayisi} bakım planı ve ${erisim_sayisi} kullanıcı erişimi var. Silmeden önce bunları kaldırın, ya da yalnızca pasifleştirin.`,
      });
    }

    const { rows } = await req.db.query(`DELETE FROM santral WHERE santral_id = $1 RETURNING santral_id`, [
      req.params.santral_id,
    ]);
    if (!rows[0]) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }
    res.json({ mesaj: "Santral silindi." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
