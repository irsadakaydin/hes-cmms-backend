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
         COALESCE(
           (SELECT json_agg(json_build_object('kullanici_id', k.kullanici_id, 'ad_soyad', k.ad_soyad) ORDER BY k.ad_soyad)
            FROM bakim_plani_sorumlu bps
            JOIN kullanici k ON k.kullanici_id = bps.kullanici_id
            WHERE bps.plan_id = bp.plan_id),
           '[]'
         ) AS sorumlular
       FROM bakim_plani bp
       JOIN ekipman e        ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
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

      const { ekipman_id, sablon_id, periyot, baslangic_tarihi, bitis_tarihi, sorumlu_kullanici_idleri } =
        req.body;

      if (
        !ekipman_id ||
        !sablon_id ||
        !periyot ||
        !baslangic_tarihi ||
        !Array.isArray(sorumlu_kullanici_idleri) ||
        sorumlu_kullanici_idleri.length === 0
      ) {
        return res.status(400).json({
          hata_kodu: "EKSIK_ALAN",
          mesaj:
            "ekipman_id, sablon_id, periyot, baslangic_tarihi ve en az bir kişilik sorumlu_kullanici_idleri dizisi zorunludur.",
        });
      }

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

      const { rows: sablonRows } = await req.db.query(
        `SELECT bs.sablon_id FROM bakim_sablonu bs
         JOIN santral s ON s.isletme_id = bs.isletme_id
         WHERE bs.sablon_id = $1 AND s.santral_id = $2
           AND (bs.santral_id IS NULL OR bs.santral_id = $2)`,
        [sablon_id, santral_id]
      );
      if (!sablonRows[0]) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_SABLON",
          mesaj: "Belirtilen bakım şablonu bu santralin bağlı olduğu holdinge ait değil.",
        });
      }

      await req.db.query("BEGIN");

      const { rows } = await req.db.query(
        `INSERT INTO bakim_plani
           (santral_id, ekipman_id, sablon_id, periyot, baslangic_tarihi, bitis_tarihi)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [santral_id, ekipman_id, sablon_id, periyot, baslangic_tarihi, bitis_tarihi || null]
      );
      const yeniPlan = rows[0];

      for (const kullaniciId of sorumlu_kullanici_idleri) {
        await req.db.query(
          `INSERT INTO bakim_plani_sorumlu (plan_id, kullanici_id) VALUES ($1, $2)`,
          [yeniPlan.plan_id, kullaniciId]
        );
      }

      const bugunKucukEsitMi = new Date(baslangic_tarihi) <= new Date(new Date().toDateString());
      for (const kullaniciId of sorumlu_kullanici_idleri) {
        await req.db.query(
          `INSERT INTO bakim_gorevi (plan_id, atanan_kullanici_id, planlanan_tarih, durum)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (plan_id, planlanan_tarih, atanan_kullanici_id) DO NOTHING`,
          [yeniPlan.plan_id, kullaniciId, baslangic_tarihi, bugunKucukEsitMi ? "GECIKTI" : "BEKLIYOR"]
        );
      }

      await req.db.query("COMMIT");
      res.status(201).json(yeniPlan);
    } catch (err) {
      await req.db.query("ROLLBACK");
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

    const izinliAlanlar = ["periyot", "baslangic_tarihi", "bitis_tarihi", "aktif_mi"];
    const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));

    let plan;
    if (guncellenecekler.length > 0) {
      const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
      const degerler = guncellenecekler.map((alan) => req.body[alan]);
      const { rows } = await req.db.query(
        `UPDATE bakim_plani SET ${setIfadesi} WHERE plan_id = $${guncellenecekler.length + 1} RETURNING *`,
        [...degerler, req.params.plan_id]
      );
      plan = rows[0];
    } else {
      const { rows } = await req.db.query(`SELECT * FROM bakim_plani WHERE plan_id = $1`, [req.params.plan_id]);
      plan = rows[0];
    }

    if (Array.isArray(req.body.sorumlu_kullanici_idleri)) {
      const yeniSet = req.body.sorumlu_kullanici_idleri;

      const { rows: eskiSorumlular } = await req.db.query(
        `SELECT kullanici_id FROM bakim_plani_sorumlu WHERE plan_id = $1`,
        [req.params.plan_id]
      );
      const eskiSet = eskiSorumlular.map((r) => r.kullanici_id);
      const cikarilanlar = eskiSet.filter((id) => !yeniSet.includes(id));
      const eklenenler = yeniSet.filter((id) => !eskiSet.includes(id));

      const { rows: bekleyenRows } = await req.db.query(
        `SELECT DISTINCT planlanan_tarih FROM bakim_gorevi
         WHERE plan_id = $1 AND durum IN ('BEKLIYOR', 'GECIKTI')
         ORDER BY planlanan_tarih DESC LIMIT 1`,
        [req.params.plan_id]
      );
      const bekleyenTarih = bekleyenRows[0]?.planlanan_tarih;

      await req.db.query(`DELETE FROM bakim_plani_sorumlu WHERE plan_id = $1`, [req.params.plan_id]);
      for (const kullaniciId of yeniSet) {
        await req.db.query(`INSERT INTO bakim_plani_sorumlu (plan_id, kullanici_id) VALUES ($1, $2)`, [
          req.params.plan_id,
          kullaniciId,
        ]);
      }

      if (cikarilanlar.length > 0) {
        await req.db.query(
          `DELETE FROM bakim_gorevi
           WHERE plan_id = $1 AND atanan_kullanici_id = ANY($2::uuid[]) AND durum IN ('BEKLIYOR', 'GECIKTI')`,
          [req.params.plan_id, cikarilanlar]
        );
      }
      if (eklenenler.length > 0 && bekleyenTarih) {
        for (const kullaniciId of eklenenler) {
          await req.db.query(
            `INSERT INTO bakim_gorevi (plan_id, atanan_kullanici_id, planlanan_tarih, durum)
             VALUES ($1, $2, $3, 'BEKLIYOR')
             ON CONFLICT (plan_id, planlanan_tarih, atanan_kullanici_id) DO NOTHING`,
            [req.params.plan_id, kullaniciId, bekleyenTarih]
          );
        }
      }
    }

    res.json(plan);
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

// POST /api/v1/bakim-planlari/:plan_id/aktiflestir — durdurulmuş planı yeniden başlatır
router.post(
  "/bakim-planlari/:plan_id/aktiflestir",
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
        `UPDATE bakim_plani SET aktif_mi = TRUE WHERE plan_id = $1 RETURNING *`,
        [req.params.plan_id]
      );
      res.json({ mesaj: "Bakım planı yeniden aktifleştirildi.", plan: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/bakim-planlari/:plan_id
router.delete(
  "/bakim-planlari/:plan_id",
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

      const { rows: gorevSayimRows } = await req.db.query(
        `SELECT COUNT(*) AS sayi FROM bakim_gorevi WHERE plan_id = $1`,
        [req.params.plan_id]
      );
      if (Number(gorevSayimRows[0].sayi) > 0) {
        return res.status(409).json({
          hata_kodu: "PLAN_GECMISI_VAR",
          mesaj: `Bu plana ait ${gorevSayimRows[0].sayi} görev kaydı var. Geçmişi korumak için silinemez — bunun yerine "durdur" kullanın.`,
        });
      }

      await req.db.query(`DELETE FROM bakim_plani WHERE plan_id = $1`, [req.params.plan_id]);
      res.json({ mesaj: "Bakım planı silindi." });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
