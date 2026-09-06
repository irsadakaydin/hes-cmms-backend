const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const SABLON_YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

/** Platform Admin (ADMIN) her holdingi görür; diğerleri yalnızca kendi işletmesini. */
function platformAdminMi(req) {
  return req.user.rol === "ADMIN";
}

// GET /api/v1/bakim-sablonlari — varsayılan olarak yalnızca aktif şablonları
// listeler (bakım planı oluştururken kullanılan seçim içindir — eski/pasif
// bir şablonun yeni bir plana atanmasını önler). Yönetim sayfası (Bakım
// Şablonları) ?hepsi=1 göndererek pasifleştirilmiş olanları da görebilir.
// (?ekipman_tipi= ile filtrelenebilir; Platform Admin isteğe bağlı ?isletme_id= ile tek bir holdinge bakabilir)
router.get("/", async (req, res, next) => {
  try {
    const { ekipman_tipi, isletme_id, hepsi } = req.query;
    const params = [];
    let sorgu = `SELECT bs.sablon_id, bs.ad, bs.ekipman_tipi, bs.periyot_tipi, bs.versiyon, bs.aktif_mi,
                        bs.olusturma_tarihi, bs.isletme_id, i.ad AS isletme_adi
                 FROM bakim_sablonu bs
                 JOIN isletme i ON i.isletme_id = bs.isletme_id
                 WHERE 1=1`;
    if (!hepsi) {
      sorgu += ` AND bs.aktif_mi = TRUE`;
    }

    if (platformAdminMi(req)) {
      if (isletme_id) {
        params.push(isletme_id);
        sorgu += ` AND bs.isletme_id = $${params.length}`;
      }
      // isletme_id belirtilmezse Platform Admin TÜM holdinglerin şablonlarını görür
    } else {
      params.push(req.user.isletme_id);
      sorgu += ` AND bs.isletme_id = $${params.length}`;
    }

    if (ekipman_tipi) {
      params.push(ekipman_tipi);
      sorgu += ` AND bs.ekipman_tipi = $${params.length}`;
    }
    sorgu += ` ORDER BY i.ad, bs.ad`;

    const { rows } = await req.db.query(sorgu, params);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/bakim-sablonlari/diger-holdingler — kopyalama amacıyla BAŞKA
// holdinglerin (kendi holdingi hariç) aktif şablonlarını listeler. Yeni
// açılan bir holding, başka bir holdingin kütüphanesinden ödünç şablon
// alabilsin diye — ama yalnızca GÖRÜNTÜLEME içindir, düzenleme/silme yetkisi
// vermez; kopyalanan şablon her zaman kendi holdingine yazılır.
// NOT: Bu route, "/:sablon_id" route'undan ÖNCE tanımlanmalı — aksi halde
// Express "diger-holdingler" metnini bir sablon_id değeri sanır.
router.get("/diger-holdingler", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const params = [];
    let kosul = "WHERE bs.aktif_mi = TRUE";
    if (!platformAdminMi(req)) {
      params.push(req.user.isletme_id);
      kosul += ` AND bs.isletme_id <> $${params.length}`;
    }
    const { rows } = await req.db.query(
      `SELECT bs.sablon_id, bs.ad, bs.ekipman_tipi, bs.periyot_tipi, bs.isletme_id, i.ad AS isletme_adi
       FROM bakim_sablonu bs
       JOIN isletme i ON i.isletme_id = bs.isletme_id
       ${kosul}
       ORDER BY i.ad, bs.ad`,
      params
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/bakim-sablonlari/:sablon_id — şablon detayı + checklist yapısı
router.get("/:sablon_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const sablon = rows[0];
    if (!sablon) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
    }
    if (!platformAdminMi(req) && sablon.isletme_id !== req.user.isletme_id) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu şablona erişim yetkiniz yok." });
    }
    res.json(sablon);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/bakim-sablonlari — yeni şablon oluşturur (föy dijitalleştirme)
// Platform Admin isteğe bağlı isletme_id belirtebilir (hangi holding için); diğerleri
// her zaman kendi holdingi için oluşturur.
router.post("/", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { ad, ekipman_tipi, periyot_tipi, checklist_json } = req.body;
    if (!ad || !ekipman_tipi || !periyot_tipi || !checklist_json) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "ad, ekipman_tipi, periyot_tipi ve checklist_json alanları zorunludur.",
      });
    }

    const hedefIsletmeId =
      platformAdminMi(req) && req.body.isletme_id ? req.body.isletme_id : req.user.isletme_id;

    const { rows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, olusturan_kullanici_id, isletme_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ad, ekipman_tipi, periyot_tipi, JSON.stringify(checklist_json), req.user.kullanici_id, hedefIsletmeId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "22P02") {
      return res.status(400).json({
        hata_kodu: "GECERSIZ_PERIYOT",
        mesaj: "periyot_tipi GUNLUK/HAFTALIK/AYLIK/UC_AYLIK/ALTI_AYLIK/YILLIK değerlerinden biri olmalı.",
      });
    }
    next(err);
  }
});

// PATCH /api/v1/bakim-sablonlari/:sablon_id — YENİ VERSİYON oluşturur, eskiyi pasifleştirir
router.patch("/:sablon_id", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: eskiRows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const eski = eskiRows[0];
    if (!eski) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
    }
    if (!platformAdminMi(req) && eski.isletme_id !== req.user.isletme_id) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu şablona erişim yetkiniz yok." });
    }

    const ad = req.body.ad ?? eski.ad;
    const ekipman_tipi = req.body.ekipman_tipi ?? eski.ekipman_tipi;
    const periyot_tipi = req.body.periyot_tipi ?? eski.periyot_tipi;
    const checklist_json = req.body.checklist_json
      ? JSON.stringify(req.body.checklist_json)
      : JSON.stringify(eski.checklist_json);

    await req.db.query("BEGIN");
    await req.db.query(`UPDATE bakim_sablonu SET aktif_mi = FALSE WHERE sablon_id = $1`, [eski.sablon_id]);

    const { rows: yeniRows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, versiyon, olusturan_kullanici_id, isletme_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [ad, ekipman_tipi, periyot_tipi, checklist_json, eski.versiyon + 1, req.user.kullanici_id, eski.isletme_id]
    );
    await req.db.query("COMMIT");

    res.status(201).json({
      mesaj: "Yeni versiyon oluşturuldu, önceki versiyon pasifleştirildi.",
      yeni_sablon: yeniRows[0],
    });
  } catch (err) {
    await req.db.query("ROLLBACK");
    next(err);
  }
});

// POST /api/v1/bakim-sablonlari/:sablon_id/kopyala — mevcut şablondan yeni bir
// tane türetir. Kaynak HANGİ holdingden olursa olsun kopyalanabilir (başka bir
// holdingden ödünç almak için) — ama sonuç her zaman kopyalayanın KENDİ
// holdingine yazılır (Platform Admin isterse hedef_isletme_id belirtebilir).
router.post("/:sablon_id/kopyala", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows: kaynakRows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const kaynak = kaynakRows[0];
    if (!kaynak) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Kaynak şablon bulunamadı." });
    }

    const hedefIsletmeId =
      platformAdminMi(req) && req.body.hedef_isletme_id ? req.body.hedef_isletme_id : req.user.isletme_id;
    const yeniAd = req.body.ad || kaynak.ad;

    const { rows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, olusturan_kullanici_id, isletme_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        yeniAd,
        kaynak.ekipman_tipi,
        kaynak.periyot_tipi,
        JSON.stringify(kaynak.checklist_json),
        req.user.kullanici_id,
        hedefIsletmeId,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/bakim-sablonlari/:sablon_id/pasiflestir — kütüphaneden gizler
// (versiyon geçmişini bozmaz, yalnızca aktif_mi=false yapar)
router.post(
  "/:sablon_id/pasiflestir",
  requireRole(...SABLON_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { rows: mevcutRows } = await req.db.query(`SELECT isletme_id FROM bakim_sablonu WHERE sablon_id = $1`, [
        req.params.sablon_id,
      ]);
      if (!mevcutRows[0]) {
        return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
      }
      if (!platformAdminMi(req) && mevcutRows[0].isletme_id !== req.user.isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu şablona erişim yetkiniz yok." });
      }
      const { rows } = await req.db.query(
        `UPDATE bakim_sablonu SET aktif_mi = FALSE WHERE sablon_id = $1 RETURNING *`,
        [req.params.sablon_id]
      );
      res.json({ mesaj: "Şablon pasifleştirildi.", sablon: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/bakim-sablonlari/:sablon_id/aktiflestir
router.post(
  "/:sablon_id/aktiflestir",
  requireRole(...SABLON_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { rows: mevcutRows } = await req.db.query(`SELECT isletme_id FROM bakim_sablonu WHERE sablon_id = $1`, [
        req.params.sablon_id,
      ]);
      if (!mevcutRows[0]) {
        return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
      }
      if (!platformAdminMi(req) && mevcutRows[0].isletme_id !== req.user.isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu şablona erişim yetkiniz yok." });
      }
      const { rows } = await req.db.query(
        `UPDATE bakim_sablonu SET aktif_mi = TRUE WHERE sablon_id = $1 RETURNING *`,
        [req.params.sablon_id]
      );
      res.json({ mesaj: "Şablon yeniden aktifleştirildi.", sablon: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/bakim-sablonlari/:sablon_id — yalnızca hiçbir bakım planı
// bu şablonu kullanmıyorsa gerçekten silinir.
router.delete(
  "/:sablon_id",
  requireRole(...SABLON_YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { rows: mevcutRows } = await req.db.query(`SELECT isletme_id FROM bakim_sablonu WHERE sablon_id = $1`, [
        req.params.sablon_id,
      ]);
      if (!mevcutRows[0]) {
        return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
      }
      if (!platformAdminMi(req) && mevcutRows[0].isletme_id !== req.user.isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu şablona erişim yetkiniz yok." });
      }

      const { rows: planSayimRows } = await req.db.query(
        `SELECT COUNT(*) AS sayi FROM bakim_plani WHERE sablon_id = $1`,
        [req.params.sablon_id]
      );
      if (Number(planSayimRows[0].sayi) > 0) {
        return res.status(409).json({
          hata_kodu: "SABLON_KULLANIMDA",
          mesaj: `Bu şablon ${planSayimRows[0].sayi} bakım planı tarafından kullanılıyor, silinemez. Bunun yerine pasifleştirin.`,
        });
      }

      await req.db.query(`DELETE FROM bakim_sablonu WHERE sablon_id = $1`, [req.params.sablon_id]);
      res.json({ mesaj: "Bakım şablonu silindi." });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
