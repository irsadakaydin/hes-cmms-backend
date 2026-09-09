const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");
const KLASOR_AGACI_VERISI = require("../klasorAgaciVerisi");

const router = express.Router();
router.use(requireAuth, withDbContext);

const YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

async function santralErisimVarMi(req, santral_id) {
  if (req.user.rol === "ADMIN") return true;
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

// GET /api/v1/santraller/:santral_id/klasorler?ust_klasor_id=
// ust_klasor_id verilmezse KÖK seviye (o santralin en üst klasörleri) döner.
// Her düğüm için "alt_sayisi" de döner — bu, arayüzün "bu düğümün altında
// daha alt klasör mü var yoksa buraya doğrudan şablon mu yüklenecek"
// ayrımını yapabilmesi içindir.
router.get("/santraller/:santral_id/klasorler", async (req, res, next) => {
  try {
    if (!(await santralErisimVarMi(req, req.params.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }
    const ustKlasorId = req.query.ust_klasor_id || null;
    const { rows } = await req.db.query(
      `SELECT k.klasor_id, k.ad, k.sira, k.periyot_tipi,
              (SELECT COUNT(*) FROM ekipman_klasoru alt WHERE alt.ust_klasor_id = k.klasor_id) AS alt_sayisi,
              EXISTS (
                SELECT 1 FROM ekipman_klasoru alt WHERE alt.ust_klasor_id = k.klasor_id AND alt.periyot_tipi IS NOT NULL
              ) AS alt_periyot_mu,
              (SELECT COUNT(*) FROM ekipman e WHERE e.klasor_id = k.klasor_id) AS ekipman_sayisi,
              (SELECT COUNT(*) FROM bakim_sablonu bs WHERE bs.klasor_id = k.klasor_id AND bs.aktif_mi = TRUE) AS sablon_sayisi
       FROM ekipman_klasoru k
       WHERE k.santral_id = $1 AND k.ust_klasor_id ${ustKlasorId ? "= $2" : "IS NULL"}
       ORDER BY k.sira, k.ad`,
      ustKlasorId ? [req.params.santral_id, ustKlasorId] : [req.params.santral_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/klasorler/:klasor_id/yol — kökten bu düğüme kadar olan yolu
// (breadcrumb) döner, ör. "Elektromekanik > Turbin > Türbin > Ünite 1".
router.get("/klasorler/:klasor_id/yol", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `WITH RECURSIVE yol AS (
         SELECT klasor_id, ust_klasor_id, ad, sira, periyot_tipi, santral_id, 0 AS derinlik
         FROM ekipman_klasoru WHERE klasor_id = $1
         UNION ALL
         SELECT k.klasor_id, k.ust_klasor_id, k.ad, k.sira, k.periyot_tipi, k.santral_id, y.derinlik + 1
         FROM ekipman_klasoru k JOIN yol y ON k.klasor_id = y.ust_klasor_id
       )
       SELECT klasor_id, ad, periyot_tipi, santral_id FROM yol ORDER BY derinlik DESC`,
      [req.params.klasor_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ hata_kodu: "KLASOR_BULUNAMADI", mesaj: "Klasör bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, rows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu klasöre erişim yetkiniz yok." });
    }
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/klasorler/:klasor_id/ekipmanlar — bu düğüme (tipik olarak bir
// Ünite düzeyi) bağlı ekipman kayıtlarını döner.
router.get("/klasorler/:klasor_id/ekipmanlar", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT ekipman_id, ad, tip, unite_no, durum FROM ekipman WHERE klasor_id = $1 AND durum = 'AKTIF' ORDER BY ad`,
      [req.params.klasor_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/klasorler/:klasor_id/periyot-yapraklari — bu düğümün (bir
// ekipman düğümü) altındaki periyot yapraklarını (Haftalık/Aylık/vb.)
// döner. Şablon Oluştur ve Bakım Planı Oluştur'da, Ekipman seçildikten
// sonra "Periyot" açılır kutusunu doldurmak için kullanılır.
router.get("/klasorler/:klasor_id/periyot-yapraklari", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT klasor_id, ad, periyot_tipi,
              (SELECT COUNT(*) FROM bakim_sablonu bs WHERE bs.klasor_id = k.klasor_id AND bs.aktif_mi = TRUE) AS sablon_sayisi
       FROM ekipman_klasoru k
       WHERE k.ust_klasor_id = $1 AND k.periyot_tipi IS NOT NULL
       ORDER BY k.sira, k.ad`,
      [req.params.klasor_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/klasorler/:klasor_id/sablonlar-alt-agacta — bu düğümün (bir
// ekipman düğümü) altındaki TÜM periyot yapraklarına yüklenmiş şablonları
// tek seferde döner. Bakım Planı Oluştur'da "Ekipman seçildi, şimdi bu
// ekipmana ait TÜM şablonları (hangi periyotta olursa olsun) listele"
// ihtiyacı içindir.
router.get("/klasorler/:klasor_id/sablonlar-alt-agacta", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT bs.sablon_id, bs.ad, bs.periyot_tipi, bs.klasor_id
       FROM bakim_sablonu bs
       JOIN ekipman_klasoru yaprak ON yaprak.klasor_id = bs.klasor_id
       WHERE yaprak.ust_klasor_id = $1 AND bs.aktif_mi = TRUE
       ORDER BY yaprak.sira, bs.ad`,
      [req.params.klasor_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);

  }
});

// POST /api/v1/santraller/:santral_id/klasorler — "Yeni Klasör Ekle".
// Yeni eklenen ya da haritada yeri unutulan bir ekipman için, akışı
// durdurmadan anında yeni bir klasör oluşturulmasını sağlar.
router.post("/santraller/:santral_id/klasorler", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    if (!(await santralErisimVarMi(req, req.params.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }
    const { ust_klasor_id, ad, periyot_tipi } = req.body;
    if (!ad) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "Klasör adı zorunludur." });
    }
    const { rows: siraRows } = await req.db.query(
      `SELECT COALESCE(MAX(sira), 0) + 10 AS sonraki_sira FROM ekipman_klasoru
       WHERE santral_id = $1 AND ust_klasor_id ${ust_klasor_id ? "= $2" : "IS NULL"}`,
      ust_klasor_id ? [req.params.santral_id, ust_klasor_id] : [req.params.santral_id]
    );
    const { rows } = await req.db.query(
      `INSERT INTO ekipman_klasoru (santral_id, ust_klasor_id, ad, sira, periyot_tipi)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.params.santral_id, ust_klasor_id || null, ad, siraRows[0].sonraki_sira, periyot_tipi || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/santraller/:santral_id/klasor-agaci-yukle — standart HES
// bakım klasör ağacını (Elektromekanik/Hidromekanik/... > ... > Ünite >
// Periyot) bu santralin altına TEK SEFERDE kurar. Santralda hâlâ hiç
// klasör yoksa kullanılması içindir; hâlihazırda kök seviyede klasör
// varsa mükerrer kurulumu engeller.
router.post(
  "/santraller/:santral_id/klasor-agaci-yukle",
  requireRole(...YONETICI_ROLLERI),
  async (req, res, next) => {
    try {
      if (!(await santralErisimVarMi(req, req.params.santral_id))) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
      }
      const { rows: mevcutRows } = await req.db.query(
        `SELECT COUNT(*) AS sayi FROM ekipman_klasoru WHERE santral_id = $1 AND ust_klasor_id IS NULL`,
        [req.params.santral_id]
      );
      if (Number(mevcutRows[0].sayi) > 0) {
        return res.status(409).json({
          hata_kodu: "KLASOR_AGACI_ZATEN_VAR",
          mesaj: "Bu santralde zaten kök seviyede klasör(ler) var — mükerrer kurulum engellendi.",
        });
      }

      let toplamDugum = 0;
      async function dugumleriEkle(dugumler, ustKlasorId) {
        for (const d of dugumler) {
          const { rows } = await req.db.query(
            `INSERT INTO ekipman_klasoru (santral_id, ust_klasor_id, ad, sira, periyot_tipi)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING klasor_id`,
            [req.params.santral_id, ustKlasorId, d.ad, d.sira || 0, d.periyot_tipi || null]
          );
          toplamDugum++;
          if (d.children && d.children.length > 0) {
            await dugumleriEkle(d.children, rows[0].klasor_id);
          }
        }
      }

      await req.db.query("BEGIN");
      try {
        await dugumleriEkle(KLASOR_AGACI_VERISI, null);
        await req.db.query("COMMIT");
      } catch (icErr) {
        await req.db.query("ROLLBACK");
        throw icErr;
      }

      res.status(201).json({ mesaj: `Klasör ağacı kuruldu (${toplamDugum} klasör oluşturuldu).`, toplam: toplamDugum });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/klasorler/:klasor_id — bu klasörü, altındaki TÜM alt
// klasörleriyle birlikte siler. Bu klasör ağacında ekipman/şablon bağlıysa
// (?zorla=1 verilmemişse) önce sayılarıyla birlikte UYARI döner, hiçbir
// şey silmez; ?zorla=1 verilirse bağlı ekipman/şablonlar ve onlara ait
// bakım planı/görev geçmişiyle birlikte KALICI olarak siler.
router.delete("/klasorler/:klasor_id", requireRole(...YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: klasorRows } = await req.db.query(
      `SELECT klasor_id, santral_id, ad, ust_klasor_id FROM ekipman_klasoru WHERE klasor_id = $1`,
      [req.params.klasor_id]
    );
    const klasor = klasorRows[0];
    if (!klasor) {
      return res.status(404).json({ hata_kodu: "KLASOR_BULUNAMADI", mesaj: "Klasör bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, klasor.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    // Bu klasör ve TÜM alt klasörlerinin kimliklerini bul.
    const { rows: altAgacRows } = await req.db.query(
      `WITH RECURSIVE alt_agac AS (
         SELECT klasor_id FROM ekipman_klasoru WHERE klasor_id = $1
         UNION ALL
         SELECT k.klasor_id FROM ekipman_klasoru k JOIN alt_agac a ON k.ust_klasor_id = a.klasor_id
       )
       SELECT klasor_id FROM alt_agac`,
      [req.params.klasor_id]
    );
    const altAgacIdleri = altAgacRows.map((r) => r.klasor_id);

    const { rows: ekipmanRows } = await req.db.query(
      `SELECT ekipman_id FROM ekipman WHERE klasor_id = ANY($1::uuid[])`,
      [altAgacIdleri]
    );
    const { rows: sablonRows } = await req.db.query(
      `SELECT sablon_id FROM bakim_sablonu WHERE klasor_id = ANY($1::uuid[])`,
      [altAgacIdleri]
    );
    const ekipmanIdleri = ekipmanRows.map((r) => r.ekipman_id);
    const sablonIdleri = sablonRows.map((r) => r.sablon_id);

    const zorla = req.query.zorla === "1" || req.query.zorla === "true";

    if ((ekipmanIdleri.length > 0 || sablonIdleri.length > 0) && !zorla) {
      return res.status(409).json({
        hata_kodu: "KLASOR_DOLU",
        mesaj: `"${klasor.ad}" klasörünün altında ${ekipmanIdleri.length} ekipman ve ${sablonIdleri.length} bakım şablonu var. Bunların hepsi (varsa bakım planı/görev geçmişiyle birlikte) kalıcı olarak silinecek. Emin misiniz?`,
        ekipman_sayisi: ekipmanIdleri.length,
        sablon_sayisi: sablonIdleri.length,
      });
    }

    await req.db.query("BEGIN");
    try {
      if (ekipmanIdleri.length > 0 || sablonIdleri.length > 0) {
        const { rows: planRows } = await req.db.query(
          `SELECT plan_id FROM bakim_plani WHERE ekipman_id = ANY($1::uuid[]) OR sablon_id = ANY($2::uuid[])`,
          [ekipmanIdleri, sablonIdleri]
        );
        const planIdleri = planRows.map((r) => r.plan_id);
        if (planIdleri.length > 0) {
          await req.db.query(
            `DELETE FROM bakim_kaydi WHERE gorev_id IN (SELECT gorev_id FROM bakim_gorevi WHERE plan_id = ANY($1::uuid[]))`,
            [planIdleri]
          );
          await req.db.query(`DELETE FROM bakim_gorevi WHERE plan_id = ANY($1::uuid[])`, [planIdleri]);
          await req.db.query(`DELETE FROM bakim_plani_sorumlu WHERE plan_id = ANY($1::uuid[])`, [planIdleri]);
          await req.db.query(`DELETE FROM bakim_plani WHERE plan_id = ANY($1::uuid[])`, [planIdleri]);
        }
        if (ekipmanIdleri.length > 0) {
          await req.db.query(`DELETE FROM ekipman WHERE ekipman_id = ANY($1::uuid[])`, [ekipmanIdleri]);
        }
        if (sablonIdleri.length > 0) {
          await req.db.query(`DELETE FROM bakim_sablonu WHERE sablon_id = ANY($1::uuid[])`, [sablonIdleri]);
        }
      }
      // Klasörün kendisini sil — ekipman_klasoru.ust_klasor_id üzerindeki
      // ON DELETE CASCADE, tüm alt klasörleri otomatik olarak birlikte siler.
      await req.db.query(`DELETE FROM ekipman_klasoru WHERE klasor_id = $1`, [req.params.klasor_id]);
      await req.db.query("COMMIT");
    } catch (icErr) {
      await req.db.query("ROLLBACK");
      throw icErr;
    }

    res.json({
      mesaj: `"${klasor.ad}" klasörü ve içeriği (${ekipmanIdleri.length} ekipman, ${sablonIdleri.length} şablon dahil) kalıcı olarak silindi.`,
      ust_klasor_id: klasor.ust_klasor_id,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/santraller/:santral_id/unite-sablonlari — bu santraldeki
// TÜM "Ünite N" adlı düğümleri (Türbin, Generatör, HPU, vb. hangi ekipman
// grubunun altında olursa olsun) ÜNİTE NUMARASINA göre birleştirip, her
// numaranın altındaki TÜM şablonları tek listede döner. Yani "Ünite 1"
// hem Türbin'in hem Generatör'ün hem HPU'nun Ünite 1'ini kapsar.
router.get("/santraller/:santral_id/unite-sablonlari", async (req, res, next) => {
  try {
    if (!(await santralErisimVarMi(req, req.params.santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }
    const { rows } = await req.db.query(
      `SELECT (regexp_match(u.ad, '\\d+'))[1]::int AS unite_no,
              bs.sablon_id, bs.ad, bs.periyot_tipi
       FROM ekipman_klasoru u
       JOIN ekipman_klasoru yaprak ON yaprak.ust_klasor_id = u.klasor_id
       JOIN bakim_sablonu bs ON bs.klasor_id = yaprak.klasor_id
       WHERE u.santral_id = $1 AND u.ad ~* '^Ünite\\s*\\d+$' AND bs.aktif_mi = TRUE
       ORDER BY unite_no, bs.ad`,
      [req.params.santral_id]
    );

    const gruplar = {};
    for (const r of rows) {
      if (!gruplar[r.unite_no]) gruplar[r.unite_no] = [];
      gruplar[r.unite_no].push({ sablon_id: r.sablon_id, ad: r.ad, periyot_tipi: r.periyot_tipi });
    }
    const veri = Object.keys(gruplar)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({ unite_no: n, ad: `Ünite ${n}`, sablonlar: gruplar[n] }));

    res.json({ veri });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
