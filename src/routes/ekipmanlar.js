const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

// Ekipman ekleme/düzenleme/silme için minimum rol
const YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

/**
 * Verilen santral_id, oturum açan kullanıcının erişebildiği santraller
 * arasında mı — açık ve anlaşılır bir 403 döndürmek için RLS'den ÖNCE
 * uygulama katmanında kontrol ediyoruz (RLS zaten arka planda ikinci
 * bir savunma hattı olarak duruyor).
 */
async function santralErisimVarMi(req, santral_id) {
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

// GET /api/v1/santraller/:santral_id/ekipmanlar
router.get("/santraller/:santral_id/ekipmanlar", async (req, res, next) => {
  try {
    if (!(await santralErisimVarMi(req, req.params.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(
      `SELECT ekipman_id, ad, tip, unite_no, seri_no, uretici, kurulum_tarihi, konum_notu, durum
       FROM ekipman WHERE santral_id = $1 ORDER BY ad`,
      [req.params.santral_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ekipmanlar/:ekipman_id
router.get("/ekipmanlar/:ekipman_id", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    const ekipman = rows[0];
    if (!ekipman) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, ekipman.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }
    res.json(ekipman);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller/:santral_id/ekipmanlar
router.post(
  "/santraller/:santral_id/ekipmanlar",
  requireRole(...YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      const { santral_id } = req.params;
      if (!(await santralErisimVarMi(req, santral_id))) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
      }

      const { ad, tip, unite_no, seri_no, uretici, kurulum_tarihi, konum_notu } = req.body;
      if (!ad || !tip) {
        return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "ad ve tip alanları zorunludur." });
      }

      const { rows } = await req.db.query(
        `INSERT INTO ekipman (santral_id, ad, tip, unite_no, seri_no, uretici, kurulum_tarihi, konum_notu)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [santral_id, ad, tip, unite_no || null, seri_no || null, uretici || null, kurulum_tarihi || null, konum_notu || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/ekipmanlar/:ekipman_id
router.patch("/ekipmanlar/:ekipman_id", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(
      `SELECT santral_id FROM ekipman WHERE ekipman_id = $1`,
      [req.params.ekipman_id]
    );
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }

    // Yalnızca gönderilen alanları güncelle (kısmi güncelleme)
    const izinliAlanlar = ["ad", "tip", "unite_no", "seri_no", "uretici", "kurulum_tarihi", "konum_notu", "durum"];
    const guncellenecekler = Object.keys(req.body).filter((k) => izinliAlanlar.includes(k));
    if (guncellenecekler.length === 0) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Güncellenecek en az bir alan gönderilmeli." });
    }

    const setIfadesi = guncellenecekler.map((alan, i) => `${alan} = $${i + 1}`).join(", ");
    const degerler = guncellenecekler.map((alan) => req.body[alan]);

    const { rows } = await req.db.query(
      `UPDATE ekipman SET ${setIfadesi} WHERE ekipman_id = $${guncellenecekler.length + 1} RETURNING *`,
      [...degerler, req.params.ekipman_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ekipmanlar/:ekipman_id/pasiflestir — ekipmanı listelerden
// gizler ama geçmişini (bakım planı/kaydı) korur. Tüm yönetici roller
// (Santral Sorumlusu dahil) kullanabilir.
router.post("/ekipmanlar/:ekipman_id/pasiflestir", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(`SELECT santral_id FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }
    const { rows } = await req.db.query(
      `UPDATE ekipman SET durum = 'HURDA' WHERE ekipman_id = $1 RETURNING *`,
      [req.params.ekipman_id]
    );
    res.json({ mesaj: "Ekipman pasifleştirildi.", ekipman: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/ekipmanlar/:ekipman_id — KALICI silme. Yalnızca GM ve
// İşletme Admin kullanabilir (Santral Sorumlusu yalnızca pasifleştirebilir).
// Bu ekipmana ait bir bakım planı varsa (geçmişi/görev kaydı olsun ya da
// olmasın) veri kaybını önlemek için reddedilir — önce o planların
// silinmesi/kaldırılması, ya da yalnızca pasifleştirme kullanılması gerekir.
router.delete("/ekipmanlar/:ekipman_id", requireRole("ISLETME_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(`SELECT santral_id FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, mevcutRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }

    const { rows: planSayimRows } = await req.db.query(
      `SELECT COUNT(*) AS sayi FROM bakim_plani WHERE ekipman_id = $1`,
      [req.params.ekipman_id]
    );
    if (Number(planSayimRows[0].sayi) > 0) {
      return res.status(409).json({
        hata_kodu: "EKIPMAN_KULLANIMDA",
        mesaj: `Bu ekipmana ait ${planSayimRows[0].sayi} bakım planı var, silinemez. Önce o planları silin/kaldırın, ya da yalnızca pasifleştirin.`,
      });
    }

    await req.db.query(`DELETE FROM ekipman WHERE ekipman_id = $1`, [req.params.ekipman_id]);
    res.json({ mesaj: "Ekipman kalıcı olarak silindi." });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// KAREKOD (QR) İLE BAKIM BAŞLATMA — herhangi bir oturum açmış kullanıcı
// (rolüne bakılmaksızın — saha personeli dahil) ekipmanın üzerindeki
// karekodu okutup, o ekipmanla eşleşen bakım şablonlarından birini seçip
// KENDİ ÜZERİNE atanmış bir görevi anında başlatabilir.
// ---------------------------------------------------------------------

// GET /api/v1/ekipmanlar/:ekipman_id/karekod-sablonlari — karekod
// okutulduğunda, bu ekipmanın tipiyle eşleşen (holding geneli ya da bu
// santrale özel) aktif şablonları listeler. Rol kısıtlaması YOKTUR —
// yalnızca oturum açmış olmak yeterlidir.
router.get("/ekipmanlar/:ekipman_id/karekod-sablonlari", async (req, res, next) => {
  try {
    const { rows: ekipmanRows } = await req.db.query(
      `SELECT e.ekipman_id, e.ad, e.tip, e.unite_no, e.santral_id, s.ad AS santral_adi, s.isletme_id
       FROM ekipman e JOIN santral s ON s.santral_id = e.santral_id
       WHERE e.ekipman_id = $1`,
      [req.params.ekipman_id]
    );
    const ekipman = ekipmanRows[0];
    if (!ekipman) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }

    const { rows: sablonlar } = await req.db.query(
      `SELECT sablon_id, ad, periyot_tipi
       FROM bakim_sablonu
       WHERE ekipman_tipi = $1 AND aktif_mi = TRUE AND isletme_id = $2
         AND (santral_id IS NULL OR santral_id = $3)
       ORDER BY ad`,
      [ekipman.tip, ekipman.isletme_id, ekipman.santral_id]
    );

    res.json({
      ekipman: { ekipman_id: ekipman.ekipman_id, ad: ekipman.ad, tip: ekipman.tip, unite_no: ekipman.unite_no, santral_adi: ekipman.santral_adi },
      sablonlar,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ekipmanlar/:ekipman_id/karekod-baslat — onaylanınca çağrılır.
// Bu ekipman+şablon için aktif bir plan varsa onun altına, yoksa YENİ bir
// plan açarak, BUGÜN tarihli bir görev üretir ve okutan kişiye (rolüne
// bakılmaksızın) atar. Plan zaten varsa, o planın normal sorumlu listesi
// DEĞİŞTİRİLMEZ — bu yalnızca o anlık, kendiliğinden başlatılan bir görevdir.
router.post("/ekipmanlar/:ekipman_id/karekod-baslat", async (req, res, next) => {
  try {
    const { sablon_id } = req.body;
    if (!sablon_id) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "sablon_id belirtilmelidir." });
    }

    const { rows: ekipmanRows } = await req.db.query(`SELECT * FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    const ekipman = ekipmanRows[0];
    if (!ekipman) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }

    const { rows: sablonRows } = await req.db.query(
      `SELECT * FROM bakim_sablonu WHERE sablon_id = $1 AND ekipman_tipi = $2 AND aktif_mi = TRUE`,
      [sablon_id, ekipman.tip]
    );
    const sablon = sablonRows[0];
    if (!sablon) {
      return res.status(400).json({
        hata_kodu: "GECERSIZ_SABLON",
        mesaj: "Bu şablon bu ekipman tipiyle eşleşmiyor ya da pasif.",
      });
    }

    const bugun = new Date().toISOString().slice(0, 10);

    await req.db.query("BEGIN");
    try {
      let { rows: planRows } = await req.db.query(
        `SELECT plan_id FROM bakim_plani WHERE ekipman_id = $1 AND sablon_id = $2 AND aktif_mi = TRUE`,
        [req.params.ekipman_id, sablon_id]
      );
      let planId;
      if (planRows[0]) {
        planId = planRows[0].plan_id;
      } else {
        const { rows: yeniPlanRows } = await req.db.query(
          `INSERT INTO bakim_plani (santral_id, ekipman_id, sablon_id, periyot, baslangic_tarihi)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING plan_id`,
          [ekipman.santral_id, req.params.ekipman_id, sablon_id, sablon.periyot_tipi, bugun]
        );
        planId = yeniPlanRows[0].plan_id;
        await req.db.query(`INSERT INTO bakim_plani_sorumlu (plan_id, kullanici_id) VALUES ($1, $2)`, [
          planId,
          req.user.kullanici_id,
        ]);
      }

      const { rows: gorevRows } = await req.db.query(
        `INSERT INTO bakim_gorevi (plan_id, atanan_kullanici_id, planlanan_tarih, durum)
         VALUES ($1, $2, $3, 'BEKLIYOR')
         ON CONFLICT (plan_id, planlanan_tarih, atanan_kullanici_id) DO NOTHING
         RETURNING gorev_id`,
        [planId, req.user.kullanici_id, bugun]
      );

      await req.db.query("COMMIT");

      if (!gorevRows[0]) {
        // Bugün için zaten kendi üzerinize bir görev oluşturulmuş
        const { rows: mevcutGorev } = await req.db.query(
          `SELECT gorev_id FROM bakim_gorevi WHERE plan_id = $1 AND atanan_kullanici_id = $2 AND planlanan_tarih = $3`,
          [planId, req.user.kullanici_id, bugun]
        );
        return res.json({ mesaj: "Bu bakım için bugüne ait göreviniz zaten var.", gorev_id: mevcutGorev[0]?.gorev_id });
      }

      res.status(201).json({ mesaj: "Görev başlatıldı.", gorev_id: gorevRows[0].gorev_id });
    } catch (icErr) {
      await req.db.query("ROLLBACK");
      throw icErr;
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;