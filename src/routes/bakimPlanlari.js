const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

async function santralErisimVarMi(req, santral_id) {
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

// GET /api/v1/santraller/:santral_id/bakim-planlari
router.get("/santraller/:santral_id/bakim-planlari", async (req, res, next) => {
  try {
    if (!(await santralErisimVarMi(req, req.params.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(
      `SELECT
         bp.plan_id, bp.periyot, bp.baslangic_tarihi, bp.bitis_tarihi, bp.aktif_mi,
         e.ekipman_id, e.ad AS ekipman_adi,
         bs.sablon_id, bs.ad AS sablon_adi,
         k.kullanici_id AS sorumlu_kullanici_id, k.ad_soyad AS sorumlu_ad_soyad
       FROM bakim_plani bp
       JOIN ekipman e        ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
       LEFT JOIN kullanici k ON k.kullanici_id = bp.sorumlu_kullanici_id
       WHERE bp.santral_id = $1
       ORDER BY bp.aktif_mi DESC, bp.baslangic_tarihi DESC`,
      [req.params.santral_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/bakim-planlari/:plan_id
router.get("/bakim-planlari/:plan_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM bakim_plani WHERE plan_id = $1`, [
      req.params.plan_id,
    ]);
    const plan = rows[0];
    if (!plan) {
      return res.status(404).json({ hata_kodu: "PLAN_BULUNAMADI", mesaj: "Bakım planı bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, plan.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu plana erişim yetkiniz yok." });
    }
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller/:santral_id/bakim-planlari
router.post(
  "/santraller/:santral_id/bakim-planlari",
  requireRole(...YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { santral_id } = req.params;
      if (!(await santralErisimVarMi(req, santral_id))) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
      }

      const { ekipman_id, sablon_id, periyot, baslangic_tarihi, bitis_tarihi, sorumlu_kullanici_id } =
        req.body;

      if (!ekipman_id || !sablon_id || !periyot || !baslangic_tarihi) {
        return res.status(400).json({
          hata_kodu: "EKSIK_ALAN",
          mesaj: "ekipman_id, sablon_id, periyot ve baslangic_tarihi alanları zorunludur.",
        });
      }

      // Ekipman gerçekten bu santrale mi bağlı — çapraz santral hatasını önler
      const { rows: ekipmanRows } = await req.db.query(
        `SELECT ekipman_id FROM ekipman WHERE ekipman_id = $1 AND santral_id = $2`,
        [ekipman_id, santral_id]
      );
      if (!ekipmanRows[0]) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_EKIPMAN",
          mesaj: "Belirtilen ekipman bu santrale ait değil.",
        });
      }

      // Şablon, santralin bağlı olduğu holding (işletme) dışından seçilmiş olmasın
      const { rows: sablonRows } = await req.db.query(
        `SELECT bs.sablon_id FROM bakim_sablonu bs
         JOIN santral s ON s.isletme_id = bs.isletme_id
         WHERE bs.sablon_id = $1 AND s.santral_id = $2`,
        [sablon_id, santral_id]
      );
      if (!sablonRows[0]) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_SABLON",
          mesaj: "Belirtilen bakım şablonu bu santralin bağlı olduğu holdinge ait değil.",
        });
      }

      const { rows } = await req.db.query(
        `INSERT INTO bakim_plani
           (santral_id, ekipman_id, sablon_id, periyot, baslangic_tarihi, bitis_tarihi, sorumlu_kullanici_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          santral_id,
          ekipman_id,
          sablon_id,
          periyot,
          baslangic_tarihi,
          bitis_tarihi || null,
          sorumlu_kullanici_id || null,
        ]
      );
      const yeniPlan = rows[0];

      // İlk görevi ANINDA üretiyoruz — aksi halde ertesi gün otomatik
      // zamanlayıcı çalışana kadar (GitHub Actions, günde bir kez) atanan
      // kullanıcının "Görevlerim" listesinde hiçbir şey görünmezdi.
      if (sorumlu_kullanici_id) {
        const bugunKucukEsitMi = new Date(baslangic_tarihi) <= new Date(new Date().toDateString());
        await req.db.query(
          `INSERT INTO bakim_gorevi (plan_id, atanan_kullanici_id, planlanan_tarih, durum)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (plan_id, planlanan_tarih) DO NOTHING`,
          [yeniPlan.plan_id, sorumlu_kullanici_id, baslangic_tarihi, bugunKucukEsitMi ? "GECIKTI" : "BEKLIYOR"]
        );
      }

      res.status(201).json(yeniPlan);
    } catch (err) {
      // periyot enum'a uymuyorsa PostgreSQL 22P02/23514 türü hata döner —
      // burada kullanıcıya anlamlı bir mesaj göstermek için yakalıyoruz.
      if (err.code === "22P02") {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_PERIYOT",
          mesaj: "periyot alanı GUNLUK/HAFTALIK/AYLIK/UC_AYLIK/ALTI_AYLIK/YILLIK değerlerinden biri olmalı.",
        });
      }
      next(err);
    }
  }
);

// PATCH /api/v1/bakim-planlari/:plan_id
router.patch("/bakim-planlari/:plan_id", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(
      `SELECT santral_id FROM bakim_plani WHERE plan_id = $1`,
      [req.params.plan_id]
    );
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "PLAN_BULUNAMADI", mesaj: "Bakım planı bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu plana erişim yetkiniz yok." });
    }

    const izinliAlanlar = ["periyot", "baslangic_tarihi", "bitis_tarihi", "sorumlu_kullanici_id", "aktif_mi"];
    const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));
    if (guncellenecekler.length === 0) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Güncellenecek en az bir alan gönderilmeli." });
    }

    const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
    const degerler = guncellenecekler.map((alan) => req.body[alan]);

    const { rows } = await req.db.query(
      `UPDATE bakim_plani SET ${setIfadesi} WHERE plan_id = $${guncellenecekler.length + 1} RETURNING *`,
      [...degerler, req.params.plan_id]
    );

    // Sorumlu değiştiyse, henüz tamamlanmamış (BEKLIYOR/GECIKTI) görevleri de
    // ANINDA yeni sorumluya devret — aksi halde eski sorumlunun üzerinde
    // kalmaya devam ederdi, yeni sorumlunun listesinde hiç görünmezdi.
    if (req.body.sorumlu_kullanici_id) {
      await req.db.query(
        `UPDATE bakim_gorevi SET atanan_kullanici_id = $1
         WHERE plan_id = $2 AND durum IN ('BEKLIYOR', 'GECIKTI')`,
        [req.body.sorumlu_kullanici_id, req.params.plan_id]
      );
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/bakim-planlari/:plan_id/durdur — planı pasifleştirir
router.post(
  "/bakim-planlari/:plan_id/durdur",
  requireRole(...YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { rows: mevcutRows } = await req.db.query(
        `SELECT santral_id FROM bakim_plani WHERE plan_id = $1`,
        [req.params.plan_id]
      );
      if (!mevcutRows[0]) {
        return res.status(404).json({ hata_kodu: "PLAN_BULUNAMADI", mesaj: "Bakım planı bulunamadı." });
      }
      if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu plana erişim yetkiniz yok." });
      }

      const { rows } = await req.db.query(
        `UPDATE bakim_plani SET aktif_mi = FALSE WHERE plan_id = $1 RETURNING *`,
        [req.params.plan_id]
      );
      res.json({ mesaj: "Bakım planı durduruldu, yeni görev üretilmeyecek.", plan: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
