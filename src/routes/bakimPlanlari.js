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
         ) AS sorumlular,
         sd.son_tarih AS son_donem_tarihi,
         sonuc.toplam AS son_donem_toplam,
         sonuc.tamamlanan AS son_donem_tamamlanan,
         COALESCE(sonuc.geciken, 0) AS son_donem_geciken,
         CASE
           WHEN NOT bp.aktif_mi THEN 'DURDURULAN'
           WHEN COALESCE(sonuc.toplam, 0) > 0 AND sonuc.tamamlanan = sonuc.toplam THEN 'TAMAMLANAN'
           WHEN COALESCE(sonuc.geciken, 0) > 0 THEN 'GECIKEN'
           ELSE 'DEVAM_EDEN'
         END AS kategori
       FROM bakim_plani bp
       JOIN ekipman e        ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
       LEFT JOIN LATERAL (
         SELECT MAX(planlanan_tarih) AS son_tarih FROM bakim_gorevi WHERE plan_id = bp.plan_id
       ) sd ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS toplam, COUNT(*) FILTER (WHERE durum = 'TAMAMLANDI') AS tamamlanan,
                COUNT(*) FILTER (WHERE durum = 'GECIKTI') AS geciken
         FROM bakim_gorevi WHERE plan_id = bp.plan_id AND planlanan_tarih = sd.son_tarih
       ) sonuc ON true
       WHERE bp.santral_id = $1
       ORDER BY bp.aktif_mi DESC, bp.baslangic_tarihi DESC`,
      [req.params.santral_id]
    );

    // İsteğe bağlı tarih aralığı filtresi — yalnızca TAMAMLANAN kategorisine
    // uygulanır (belirli bir dönemde tamamlanmış bakımları görmek için).
    // DEVAM_EDEN, GECİKEN ve DURDURULAN her zaman görünür — bunlar "şu an
    // geçerli durum" bilgisidir, belirli bir tarihe bağlı değildir.
    let sonuclar = rows;
    if (req.query.baslangic || req.query.bitis) {
      sonuclar = rows.filter((p) => {
        // Yalnızca TAMAMLANAN bir tarih aralığına göre süzülür (o tamamlanma
        // döneminin raporunu görmek isteyebilirsiniz). DEVAM_EDEN, GECİKEN
        // ve DURDURULAN, tarihten bağımsız GÜNCEL bir durumdur — o anda kaç
        // tanesi varsa her zaman o kadar görünür.
        if (p.kategori !== "TAMAMLANAN") return true;
        if (!p.son_donem_tarihi) return true;
        const tarih = new Date(p.son_donem_tarihi);
        if (req.query.baslangic && tarih < new Date(req.query.baslangic)) return false;
        if (req.query.bitis && tarih > new Date(`${req.query.bitis}T23:59:59`)) return false;
        return true;
      });
    }

    res.json({ veri: sonuclar });
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
// ?zorla=1 gönderilirse (yalnızca GM/İşletme Admin) plan, tüm görev ve bakım
// kayıt geçmişiyle BİRLİKTE kalıcı olarak silinir — deneme/test verilerini
// tamamen temizlemek için. Bu parametre olmadan davranış eskisi gibi
// güvenlidir (geçmişi olan bir plan silinemez, "durdur" önerilir).
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
      const gorevSayisi = Number(gorevSayimRows[0].sayi);

      if (gorevSayisi > 0) {
        const zorlaIsteniyor = req.query.zorla === "1" || req.query.zorla === "true";
        if (!zorlaIsteniyor) {
          return res.status(409).json({
            hata_kodu: "PLAN_GECMISI_VAR",
            mesaj: `Bu plana ait ${gorevSayisi} görev kaydı var. Geçmişi korumak için silinemez — bunun yerine "durdur" kullanın.`,
          });
        }
        if (!["ISLETME_ADMIN", "ADMIN"].includes(req.user.rol)) {
          return res.status(403).json({
            hata_kodu: "YETKI_YOK",
            mesaj: "Geçmişi olan bir planı zorla silmek yalnızca GM ve İşletme Admin'e açıktır.",
          });
        }

        // Zorla silme: görev geçmişini de birlikte kaldır (yalnızca deneme/
        // test verisi temizliği için kullanılmalı — geri alınamaz).
        await req.db.query("BEGIN");
        await req.db.query(
          `DELETE FROM bakim_kaydi WHERE gorev_id IN (SELECT gorev_id FROM bakim_gorevi WHERE plan_id = $1)`,
          [req.params.plan_id]
        );
        await req.db.query(`DELETE FROM bakim_gorevi WHERE plan_id = $1`, [req.params.plan_id]);
        await req.db.query(`DELETE FROM bakim_plani_sorumlu WHERE plan_id = $1`, [req.params.plan_id]);
        await req.db.query(`DELETE FROM bakim_plani WHERE plan_id = $1`, [req.params.plan_id]);
        await req.db.query("COMMIT");
        return res.json({
          mesaj: `Bakım planı, ${gorevSayisi} görev kaydıyla birlikte kalıcı olarak silindi.`,
        });
      }

      await req.db.query(`DELETE FROM bakim_plani WHERE plan_id = $1`, [req.params.plan_id]);
      res.json({ mesaj: "Bakım planı silindi." });
    } catch (err) {
      await req.db.query("ROLLBACK").catch(() => {});
      next(err);
    }
  }
);

module.exports = router;
