const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

// Türkçe karakterleri (ı, ş, ğ, ü, ö, ç, İ) doğru göstermek için pdfkit'in
// varsayılan 14 fontu yetersiz (yalnızca WinAnsi kodlaması) — bu yüzden
// Unicode desteği tam olan DejaVu Sans fontunu projeye gömüp kullanıyoruz.
// NOT: Font dosyaları src/ klasörünün KÖKÜNDE duruyor (src/assets/ altında değil).
const FONT_NORMAL = path.join(__dirname, "..", "DejaVuSans.ttf");
const FONT_KALIN = path.join(__dirname, "..", "DejaVuSans-Bold.ttf");

const router = express.Router();
router.use(requireAuth, withDbContext);

async function santralErisimVarMi(req, santral_id) {
  const { rows } = await req.db.query(
    `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
    [req.user.kullanici_id, santral_id]
  );
  return rows.length > 0;
}

/** ?baslangic=&bitis=&durum= filtrelerini SQL koşuluna çevirir. */
function tarihFiltresi(req, startParamIndex, tarihKolonu = "g.planlanan_tarih") {
  const kosullar = [];
  const params = [];
  let i = startParamIndex;

  if (req.query.baslangic) {
    kosullar.push(`${tarihKolonu} >= $${i++}`);
    params.push(req.query.baslangic);
  }
  if (req.query.bitis) {
    kosullar.push(`${tarihKolonu} <= $${i++}`);
    params.push(req.query.bitis);
  }
  if (req.query.durum) {
    kosullar.push(`g.durum = $${i++}`);
    params.push(req.query.durum);
  }
  return { kosulMetni: kosullar.length ? "AND " + kosullar.join(" AND ") : "", params };
}

// GET /api/v1/raporlar/santral/:santral_id/ozet
router.get("/santral/:santral_id/ozet", async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { kosulMetni, params } = tarihFiltresi(req, 2);
    const { rows } = await req.db.query(
      `SELECT
         COUNT(*) AS toplam_gorev,
         COUNT(*) FILTER (WHERE g.durum = 'TAMAMLANDI') AS tamamlanan,
         COUNT(*) FILTER (WHERE g.durum = 'GECIKTI') AS gecikmis,
         COUNT(*) FILTER (WHERE g.durum = 'BEKLIYOR') AS bekleyen,
         ROUND(
           COUNT(*) FILTER (WHERE g.durum = 'TAMAMLANDI')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1
         ) AS tamamlanma_yuzdesi
       FROM bakim_gorevi g
       JOIN bakim_plani bp ON bp.plan_id = g.plan_id
       WHERE bp.santral_id = $1 ${kosulMetni}`,
      [santral_id, ...params]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/santral/:santral_id/gecikmis-gorevler
router.get("/santral/:santral_id/gecikmis-gorevler", async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(`SELECT * FROM v_gecikmis_gorevler WHERE santral_adi = (
      SELECT ad FROM santral WHERE santral_id = $1
    ) ORDER BY gecikme_gun_sayisi DESC`, [santral_id]);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/ekipman/:ekipman_id/gecmis
router.get("/ekipman/:ekipman_id/gecmis", async (req, res, next) => {
  try {
    const { rows: ekipmanRows } = await req.db.query(`SELECT santral_id, ad FROM ekipman WHERE ekipman_id = $1`, [
      req.params.ekipman_id,
    ]);
    if (!ekipmanRows[0]) {
      return res.status(404).json({ hata_kodu: "EKIPMAN_BULUNAMADI", mesaj: "Ekipman bulunamadı." });
    }
    if (!(await santralErisimVarMi(req, ekipmanRows[0].santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu ekipmana erişim yetkiniz yok." });
    }

    const { rows } = await req.db.query(
      `SELECT
         bk.kayit_id, bk.tamamlanma_tarihi, bk.checklist_sonuclari, bk.notlar,
         k.ad_soyad AS tamamlayan, bs.ad AS sablon_adi
       FROM bakim_kaydi bk
       JOIN bakim_gorevi g   ON g.gorev_id = bk.gorev_id
       JOIN bakim_plani bp   ON bp.plan_id = g.plan_id
       JOIN bakim_sablonu bs ON bs.sablon_id = bp.sablon_id
       JOIN kullanici k      ON k.kullanici_id = bk.tamamlayan_kullanici_id
       WHERE bp.ekipman_id = $1
       ORDER BY bk.tamamlanma_tarihi DESC`,
      [req.params.ekipman_id]
    );
    res.json({ ekipman_adi: ekipmanRows[0].ad, gecmis: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/isletme/:isletme_id/portfoy-ozeti
router.get(
  "/isletme/:isletme_id/portfoy-ozeti",
  requireRole("ISLETME_ADMIN", "ADMIN"),
  async (req, res, next) => {
    try {
      const { isletme_id } = req.params;
      if (req.user.rol !== "ADMIN" && req.user.isletme_id !== isletme_id) {
        return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu işletmeye erişim yetkiniz yok." });
      }

      const { rows } = await req.db.query(`SELECT * FROM v_isletme_portfoy_ozeti WHERE isletme_id = $1`, [
        isletme_id,
      ]);
      res.json(rows[0] || null);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/raporlar/platform-ozeti — tüm işletmelerin karşılaştırmalı özeti
router.get("/platform-ozeti", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM v_isletme_portfoy_ozeti ORDER BY isletme_adi`);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// PDF / Excel rapor üretimi için ortak veri toplama
// ?baslangic= ve ?bitis= (YYYY-AA-GG) ile dönem filtrelenebilir — frontend
// "Günlük/Haftalık/Aylık/Yıllık" seçimini bu iki tarihe çevirip gönderir.
// ---------------------------------------------------------------------
async function santralRaporVerisiTopla(req, santral_id) {
  const { rows: santralRows } = await req.db.query(
    `SELECT s.*, i.ad AS isletme_adi FROM santral s JOIN isletme i ON i.isletme_id = s.isletme_id
     WHERE s.santral_id = $1`,
    [santral_id]
  );
  const santral = santralRows[0];

  const params = [santral_id];
  let ekKosul = "";
  if (req.query.baslangic) {
    params.push(req.query.baslangic);
    ekKosul += ` AND g.planlanan_tarih >= $${params.length}`;
  }
  if (req.query.bitis) {
    params.push(req.query.bitis);
    ekKosul += ` AND g.planlanan_tarih <= $${params.length}`;
  }
  if (req.query.periyot) {
    params.push(req.query.periyot);
    ekKosul += ` AND bp.periyot = $${params.length}`;
  }

  const { rows: gorevler } = await req.db.query(
    `SELECT
       g.gorev_id, g.durum, g.planlanan_tarih,
       e.ad AS ekipman_adi, bs.ad AS bakim_adi,
       atanan.ad_soyad AS atanan_personel,
       bk.tamamlanma_tarihi,
       tamamlayan.ad_soyad AS tamamlayan_personel
     FROM bakim_gorevi g
     JOIN bakim_plani bp     ON bp.plan_id = g.plan_id
     JOIN ekipman e          ON e.ekipman_id = bp.ekipman_id
     JOIN bakim_sablonu bs   ON bs.sablon_id = bp.sablon_id
     JOIN kullanici atanan   ON atanan.kullanici_id = g.atanan_kullanici_id
     LEFT JOIN bakim_kaydi bk      ON bk.gorev_id = g.gorev_id
     LEFT JOIN kullanici tamamlayan ON tamamlayan.kullanici_id = bk.tamamlayan_kullanici_id
     WHERE bp.santral_id = $1 ${ekKosul}
     ORDER BY g.planlanan_tarih DESC`,
    params
  );

  const ozet = {
    toplam_gorev: gorevler.length,
    tamamlanan: gorevler.filter((g) => g.durum === "TAMAMLANDI").length,
    gecikmis: gorevler.filter((g) => g.durum === "GECIKTI").length,
    bekleyen: gorevler.filter((g) => g.durum === "BEKLIYOR").length,
  };
  ozet.tamamlanma_yuzdesi = ozet.toplam_gorev
    ? Math.round((ozet.tamamlanan / ozet.toplam_gorev) * 1000) / 10
    : 0;

  return { santral, ozet, gorevler };
}

const DURUM_ETIKETLERI = { TAMAMLANDI: "Tamamlandı", GECIKTI: "Gecikti", BEKLIYOR: "Bekliyor", DEVAM_EDIYOR: "Devam Ediyor" };
const PERIYOT_ETIKETLERI = {
  GUNLUK: "Günlük",
  HAFTALIK: "Haftalık",
  AYLIK: "Aylık",
  UC_AYLIK: "3 Ayda Bir",
  ALTI_AYLIK: "6 Ayda Bir",
  YILLIK: "Yıllık",
  IKI_YILLIK: "2 Yılda Bir",
  UC_YILLIK: "3 Yılda Bir",
  BES_YILLIK: "5 Yılda Bir",
  ON_YILLIK: "10 Yılda Bir",
};

function tarihFormatla(deger) {
  return deger ? new Date(deger).toLocaleDateString("tr-TR") : "—";
}

const RAPOR_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

/** Oturum açan kullanıcının erişebildiği tüm santral kimliklerini döner. */
async function erisilenSantralIdleri(req) {
  const { rows } = await req.db.query(
    `SELECT santral_id FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1`,
    [req.user.kullanici_id]
  );
  return rows.map((r) => r.santral_id);
}

// GET /api/v1/raporlar/filtre-secenekleri — "Rapor Oluştur" sayfasındaki
// Santral ve Bakım Sorumlusu kutularını doldurmak için kullanılır.
router.get("/filtre-secenekleri", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const santralIdleri = await erisilenSantralIdleri(req);
    if (santralIdleri.length === 0) {
      return res.json({ santraller: [], personel: [] });
    }

    const { rows: santraller } = await req.db.query(
      `SELECT s.santral_id, s.ad, s.isletme_id, i.ad AS isletme_adi
       FROM santral s JOIN isletme i ON i.isletme_id = s.isletme_id
       WHERE s.santral_id = ANY($1::uuid[])
       ORDER BY i.ad, s.ad`,
      [santralIdleri]
    );

    const { rows: personel } = await req.db.query(
      `SELECT DISTINCT k.kullanici_id, k.ad_soyad, k.isletme_id
       FROM kullanici k
       WHERE k.kullanici_id IN (
         SELECT kullanici_id FROM v_kullanici_yetkili_santraller WHERE santral_id = ANY($1::uuid[])
       )
       AND k.rol IN ('SAHA_PERSONELI', 'SANTRAL_SORUMLUSU')
       AND k.aktif_mi = TRUE
       ORDER BY k.ad_soyad`,
      [santralIdleri]
    );

    res.json({ santraller, personel });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Genel (tek ya da çoklu santral) rapor verisi toplama — "Rapor Oluştur"
// sayfasındaki 4 kutu (santral, periyot, sorumlu, tarih aralığı) burada
// birleştirilir. Herhangi bir kutu boş bırakılırsa o filtre uygulanmaz
// (hepsi seçilmiş gibi davranılır).
// ---------------------------------------------------------------------
async function genelRaporVerisiTopla(req) {
  const santralIdleri = await erisilenSantralIdleri(req);
  if (santralIdleri.length === 0) {
    return { gorevler: [], ozet: { toplam_gorev: 0, tamamlanan: 0, gecikmis: 0, bekleyen: 0, tamamlanma_yuzdesi: 0 }, baslik: "Bakım Raporu" };
  }

  const params = [santralIdleri];
  let ekKosul = "";

  if (req.query.santral_id) {
    if (!santralIdleri.includes(req.query.santral_id)) {
      const hata = new Error("Bu santrale erişim yetkiniz yok.");
      hata.durum = 403;
      throw hata;
    }
    params.push(req.query.santral_id);
    ekKosul += ` AND s.santral_id = $${params.length}`;
  } else if (req.query.isletme_id) {
    // Belirli bir santral seçilmemiş ama bir HOLDING seçilmişse ("Tüm
    // Santraller" + o holding) — raporu yalnızca o holdingin santralleriyle
    // sınırla. Bu olmadan Platform Admin için rapor, seçilen holdingin
    // dışındaki (erişimi olan tüm) santralleri de karıştırıyordu.
    params.push(req.query.isletme_id);
    ekKosul += ` AND s.isletme_id = $${params.length}`;
  }
  if (req.query.sorumlu_kullanici_id) {
    params.push(req.query.sorumlu_kullanici_id);
    ekKosul += ` AND g.atanan_kullanici_id = $${params.length}`;
  }
  if (req.query.periyot) {
    params.push(req.query.periyot);
    ekKosul += ` AND bp.periyot = $${params.length}`;
  }
  if (req.query.durum) {
    params.push(req.query.durum);
    ekKosul += ` AND g.durum = $${params.length}`;
  }

  // Tarih aralığı filtresi — GECİKMİŞ (durum='GECIKTI') görevler bu
  // filtreden HER ZAMAN muaf tutulur: bir bakım hâlâ tamamlanmamış ve
  // gecikmişse, planlanan tarihi seçilen dönemin dışında kalsa bile
  // raporda görünmeye devam etmesi gerekir (aksi halde "Bu Ay" gibi bir
  // filtre, geçen aydan kalan gecikmiş bir bakımı gizlemiş olurdu).
  const tarihSartlari = [];
  if (req.query.baslangic) {
    params.push(req.query.baslangic);
    tarihSartlari.push(`g.planlanan_tarih >= $${params.length}`);
  }
  if (req.query.bitis) {
    params.push(req.query.bitis);
    tarihSartlari.push(`g.planlanan_tarih <= $${params.length}`);
  }
  if (tarihSartlari.length > 0) {
    ekKosul += ` AND (g.durum = 'GECIKTI' OR (${tarihSartlari.join(" AND ")}))`;
  }

  const { rows: gorevler } = await req.db.query(
    `SELECT
       g.gorev_id, g.durum, g.planlanan_tarih,
       s.ad AS santral_adi,
       bp.periyot,
       e.ad AS ekipman_adi, bs.ad AS bakim_adi,
       atanan.ad_soyad AS atanan_personel,
       bk.tamamlanma_tarihi,
       tamamlayan.ad_soyad AS tamamlayan_personel
     FROM bakim_gorevi g
     JOIN bakim_plani bp     ON bp.plan_id = g.plan_id
     JOIN santral s          ON s.santral_id = bp.santral_id
     JOIN ekipman e          ON e.ekipman_id = bp.ekipman_id
     JOIN bakim_sablonu bs   ON bs.sablon_id = bp.sablon_id
     JOIN kullanici atanan   ON atanan.kullanici_id = g.atanan_kullanici_id
     LEFT JOIN bakim_kaydi bk       ON bk.gorev_id = g.gorev_id
     LEFT JOIN kullanici tamamlayan ON tamamlayan.kullanici_id = bk.tamamlayan_kullanici_id
     WHERE s.santral_id = ANY($1::uuid[]) ${ekKosul}
     ORDER BY g.planlanan_tarih DESC`,
    params
  );

  const ozet = {
    toplam_gorev: gorevler.length,
    tamamlanan: gorevler.filter((g) => g.durum === "TAMAMLANDI").length,
    gecikmis: gorevler.filter((g) => g.durum === "GECIKTI").length,
    bekleyen: gorevler.filter((g) => g.durum === "BEKLIYOR").length,
  };
  ozet.tamamlanma_yuzdesi = ozet.toplam_gorev
    ? Math.round((ozet.tamamlanan / ozet.toplam_gorev) * 1000) / 10
    : 0;

  return { gorevler, ozet };
}

function pdfBakimTablosuCiz(dokuman, gorevler) {
  const sutunlar = [
    { baslik: "Santral", genislik: 90 },
    { baslik: "Bakım Adı", genislik: 296 },
    { baslik: "Periyot", genislik: 65 },
    { baslik: "Durum", genislik: 72 },
    { baslik: "Personel", genislik: 85 },
    { baslik: "Atama Tarihi", genislik: 72 },
    { baslik: "Tamamlama T.", genislik: 82 },
  ];
  const tabloSolX = 40;
  let y = dokuman.y;
  const SATIR_YUKSEKLIGI = 16;

  function hucreYaz(metin, sutunIndex, kalinMi, renk) {
    let x = tabloSolX;
    for (let i = 0; i < sutunIndex; i++) x += sutunlar[i].genislik;
    dokuman
      .font(kalinMi ? "DejaVu-Bold" : "DejaVu")
      .fontSize(8.5)
      .fillColor(renk || "#13201c")
      .text(String(metin), x, y, {
        width: sutunlar[sutunIndex].genislik - 8,
        height: SATIR_YUKSEKLIGI,
        ellipsis: true,
        lineBreak: false,
      });
  }

  sutunlar.forEach((s, i) => hucreYaz(s.baslik, i, true, "#0f3d3e"));
  y += SATIR_YUKSEKLIGI;
  dokuman.strokeColor("#c9d0c8").lineWidth(0.5).moveTo(tabloSolX, y - 2).lineTo(802, y - 2).stroke();
  y += 2;

  const DURUM_RENK = { TAMAMLANDI: "#2c7a4b", GECIKTI: "#a83b2e", BEKLIYOR: "#c17a24", DEVAM_EDIYOR: "#1d4e75" };

  gorevler.forEach((g) => {
    if (y > 555) {
      dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
      y = 40;
    }
    hucreYaz(g.santral_adi, 0, false);
    hucreYaz(`${g.ekipman_adi} — ${g.bakim_adi}`, 1, false);
    hucreYaz(PERIYOT_ETIKETLERI[g.periyot] || g.periyot, 2, false);
    hucreYaz(DURUM_ETIKETLERI[g.durum] || g.durum, 3, true, DURUM_RENK[g.durum] || "#13201c");
    hucreYaz(g.tamamlayan_personel || g.atanan_personel, 4, false);
    hucreYaz(tarihFormatla(g.planlanan_tarih), 5, false);
    hucreYaz(tarihFormatla(g.tamamlanma_tarihi), 6, false);
    y += SATIR_YUKSEKLIGI;
  });

  if (gorevler.length === 0) {
    dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62").text("Seçilen filtrelerle eşleşen görev bulunmuyor.", tabloSolX, y);
    y += SATIR_YUKSEKLIGI;
  }
  return y;
}

// GET /api/v1/raporlar/ozet-banner?baslangic=&bitis= — santral bazlı devam
// eden/geciken/tamamlanan/durdurulan PLAN sayılarını döner (2. banner'daki
// dairesel göstergeler için). Bakımlar sayfasıyla AYNI kategori mantığını
// kullanır (plan bazlı, çoklu sorumluda herkes onaylamadan tamamlanan
// sayılmaz) — böylece banner ile Bakımlar sayfasındaki sayılar HER ZAMAN
// birebir tutar. Geciken ve Durdurulan her zaman güncel durumu yansıtır
// (dönem filtresinden bağımsızdır); yalnızca Devam Eden/Tamamlanan, son
// dönem tarihine göre seçilen aralıkla sınırlanır.
router.get("/ozet-banner", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const santralIdleri = await erisilenSantralIdleri(req);
    if (santralIdleri.length === 0) {
      return res.json({ veri: [] });
    }

    const params = [santralIdleri];
    let holdingKosulu = "";
    if (req.query.isletme_id) {
      params.push(req.query.isletme_id);
      holdingKosulu = ` AND s.isletme_id = $${params.length}`;
    }

    // Önce erişilebilir TÜM santralleri (planı olsun olmasın) sıfır
    // sayımlarla map'e ekliyoruz — aksi halde hiç planı olmayan bir santral
    // banner'da hiç görünmezdi.
    const { rows: tumSantraller } = await req.db.query(
      `SELECT s.santral_id, s.ad AS santral_adi, s.isletme_id, i.ad AS isletme_adi
       FROM santral s JOIN isletme i ON i.isletme_id = s.isletme_id
       WHERE s.santral_id = ANY($1::uuid[]) ${holdingKosulu}`,
      params
    );
    const santralMap = new Map();
    for (const s of tumSantraller) {
      santralMap.set(s.santral_id, { ...s, devam_eden: 0, geciken: 0, tamamlanan: 0, durdurulan: 0 });
    }

    const { rows: planlar } = await req.db.query(
      `SELECT bp.santral_id,
         sd.son_tarih AS son_donem_tarihi,
         CASE
           WHEN NOT bp.aktif_mi THEN 'DURDURULAN'
           WHEN COALESCE(sonuc.toplam, 0) > 0 AND sonuc.tamamlanan = sonuc.toplam THEN 'TAMAMLANAN'
           WHEN COALESCE(sonuc.geciken, 0) > 0 THEN 'GECIKEN'
           ELSE 'DEVAM_EDEN'
         END AS kategori
       FROM bakim_plani bp
       LEFT JOIN LATERAL (
         SELECT MAX(planlanan_tarih) AS son_tarih FROM bakim_gorevi WHERE plan_id = bp.plan_id
       ) sd ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS toplam, COUNT(*) FILTER (WHERE durum = 'TAMAMLANDI') AS tamamlanan,
                COUNT(*) FILTER (WHERE durum = 'GECIKTI') AS geciken
         FROM bakim_gorevi WHERE plan_id = bp.plan_id AND planlanan_tarih = sd.son_tarih
       ) sonuc ON true
       WHERE bp.santral_id = ANY($1::uuid[])`,
      [[...santralMap.keys()]]
    );

    // Tarih aralığı filtresi (varsa) — yalnızca DEVAM_EDEN/TAMAMLANAN'a
    // uygulanır; GECIKEN/DURDURULAN her zaman sayılır. Bakımlar sayfasındaki
    // mantıkla birebir aynı.
    const filtreli = planlar.filter((p) => {
      // Yalnızca TAMAMLANAN bir tarih aralığına göre süzülür — DEVAM_EDEN,
      // GECİKEN ve DURDURULAN tarihten bağımsız GÜNCEL bir durumdur.
      if (p.kategori !== "TAMAMLANAN") return true;
      if (!req.query.baslangic && !req.query.bitis) return true;
      if (!p.son_donem_tarihi) return true;
      const tarih = new Date(p.son_donem_tarihi);
      if (req.query.baslangic && tarih < new Date(req.query.baslangic)) return false;
      if (req.query.bitis && tarih > new Date(`${req.query.bitis}T23:59:59`)) return false;
      return true;
    });

    for (const p of filtreli) {
      const kayit = santralMap.get(p.santral_id);
      if (!kayit) continue;
      if (p.kategori === "DEVAM_EDEN") kayit.devam_eden++;
      else if (p.kategori === "GECIKEN") kayit.geciken++;
      else if (p.kategori === "TAMAMLANAN") kayit.tamamlanan++;
      else if (p.kategori === "DURDURULAN") kayit.durdurulan++;
    }

    const sonuc = [...santralMap.values()].sort(
      (a, b) => a.isletme_adi.localeCompare(b.isletme_adi) || a.santral_adi.localeCompare(b.santral_adi)
    );
    res.json({ veri: sonuc });
  } catch (err) {
    next(err);
  }
});


// hepsi isteğe bağlıdır; boş bırakılan filtre uygulanmaz (hepsi seçilmiş sayılır).
router.get("/pdf", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { gorevler, ozet } = await genelRaporVerisiTopla(req);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="bakim-raporu.pdf"`);

    const dokuman = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
    res.on("error", (err) => console.error("Rapor akışı hatası:", err.message));
    dokuman.on("error", (err) => console.error("PDF üretim hatası:", err.message));
    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    dokuman.font("DejaVu-Bold").fontSize(16).fillColor("#0f3d3e").text("HES Bakım Yönetim Sistemi");
    dokuman.font("DejaVu-Bold").fontSize(12).fillColor("#13201c").text("Bakım Raporu");

    const donemMetni =
      req.query.baslangic || req.query.bitis
        ? `Dönem: ${req.query.baslangic ? tarihFormatla(req.query.baslangic) : "…"} – ${
            req.query.bitis ? tarihFormatla(req.query.bitis) : "…"
          }`
        : "Dönem: Tüm zamanlar";
    const periyotMetni = req.query.periyot
      ? `   |   Periyot: ${PERIYOT_ETIKETLERI[req.query.periyot] || req.query.periyot}`
      : "   |   Periyot: Tümü";
    dokuman
      .font("DejaVu")
      .fontSize(8)
      .fillColor("#5b6b62")
      .text(`${donemMetni}${periyotMetni}   |   Rapor tarihi: ${tarihFormatla(new Date())}`);
    dokuman.moveDown(0.8);
    dokuman.strokeColor("#c17a24").lineWidth(1.5).moveTo(40, dokuman.y).lineTo(802, dokuman.y).stroke();
    dokuman.moveDown(0.6);

    dokuman
      .font("DejaVu")
      .fontSize(9)
      .fillColor("#13201c")
      .text(
        `Toplam: ${ozet.toplam_gorev}   ·   Tamamlanan: ${ozet.tamamlanan}   ·   Gecikmiş: ${ozet.gecikmis}   ·   Bekleyen: ${ozet.bekleyen}   ·   Tamamlanma: %${ozet.tamamlanma_yuzdesi}`
      );
    dokuman.moveDown(0.8);

    let y = pdfBakimTablosuCiz(dokuman, gorevler);

    y += 30;
    if (y > 540) {
      dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
      y = 40;
    }
    dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62");
    dokuman.text("Bakım Müdürlüğü", 40, y);
    dokuman.text("_____________________", 40, y + 30);
    dokuman.text("İşletme Yöneticisi / Müdürü", 340, y);
    dokuman.text("_____________________", 340, y + 30);

    dokuman.end();
  } catch (err) {
    if (err.durum === 403) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: err.message });
    }
    next(err);
  }
});

// GET /api/v1/raporlar/excel — aynı filtreler
router.get("/excel", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { gorevler, ozet } = await genelRaporVerisiTopla(req);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "HES CMMS";
    workbook.created = new Date();

    const ozetSheet = workbook.addWorksheet("Özet");
    ozetSheet.columns = [
      { header: "Alan", key: "alan", width: 28 },
      { header: "Değer", key: "deger", width: 24 },
    ];
    ozetSheet.getRow(1).font = { bold: true };
    ozetSheet.addRows([
      {
        alan: "Dönem",
        deger:
          req.query.baslangic || req.query.bitis
            ? `${tarihFormatla(req.query.baslangic)} – ${tarihFormatla(req.query.bitis)}`
            : "Tüm zamanlar",
      },
      { alan: "Bakım periyodu", deger: req.query.periyot ? (PERIYOT_ETIKETLERI[req.query.periyot] || req.query.periyot) : "Tümü" },
      { alan: "Rapor tarihi", deger: tarihFormatla(new Date()) },
      { alan: "Toplam görev", deger: ozet.toplam_gorev },
      { alan: "Tamamlanan", deger: ozet.tamamlanan },
      { alan: "Gecikmiş", deger: ozet.gecikmis },
      { alan: "Bekleyen", deger: ozet.bekleyen },
      { alan: "Tamamlanma yüzdesi (%)", deger: ozet.tamamlanma_yuzdesi },
    ]);

    const gorevSheet = workbook.addWorksheet("Bakım Kayıtları");
    gorevSheet.columns = [
      { header: "Santral", key: "santral_adi", width: 18 },
      { header: "Bakım Adı", key: "bakim_adi", width: 38 },
      { header: "Periyot", key: "periyot", width: 14 },
      { header: "Durum", key: "durum", width: 14 },
      { header: "Personel", key: "personel", width: 20 },
      { header: "Atama Tarihi", key: "atama_tarihi", width: 14 },
      { header: "Tamamlama Tarihi", key: "tamamlama_tarihi", width: 16 },
    ];
    gorevSheet.getRow(1).font = { bold: true };
    gorevler.forEach((g) => {
      const satir = gorevSheet.addRow({
        santral_adi: g.santral_adi,
        bakim_adi: `${g.ekipman_adi} — ${g.bakim_adi}`,
        periyot: PERIYOT_ETIKETLERI[g.periyot] || g.periyot,
        durum: DURUM_ETIKETLERI[g.durum] || g.durum,
        personel: g.tamamlayan_personel || g.atanan_personel,
        atama_tarihi: tarihFormatla(g.planlanan_tarih),
        tamamlama_tarihi: tarihFormatla(g.tamamlanma_tarihi),
      });
      const renkler = { TAMAMLANDI: "FF2C7A4B", GECIKTI: "FFA83B2E", BEKLIYOR: "FFC17A24", DEVAM_EDIYOR: "FF1D4E75" };
      if (renkler[g.durum]) {
        satir.getCell("durum").font = { color: { argb: renkler[g.durum] }, bold: true };
      }
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="bakim-raporu.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    if (err.durum === 403) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: err.message });
    }
    next(err);
  }
});


// GET /api/v1/raporlar/santral/:santral_id/pdf
router.get("/santral/:santral_id/pdf", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { santral, ozet, gorevler } = await santralRaporVerisiTopla(req, santral_id);
    if (!santral) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bakim-raporu-${santral.ad.replace(/\s+/g, "-")}.pdf"`
    );

    const dokuman = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });

    // İstemci PDF akışı tamamlanmadan bağlantıyı keserse (ör. tarayıcı
    // isteği iptal eder, sekme kapanır), pdfkit yine de akışa yazmaya
    // devam edebilir ve bu "write after end" hatası yakalanmazsa TÜM
    // Node.js sürecini çökertir. Bu iki dinleyici, hatayı sessizce
    // loglayıp sürecin ayakta kalmasını sağlar.
    res.on("error", (err) => {
      console.error("Rapor akışı hatası (istemci muhtemelen bağlantıyı kesti):", err.message);
    });
    dokuman.on("error", (err) => {
      console.error("PDF üretim hatası:", err.message);
    });

    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    // Başlık
    dokuman.font("DejaVu-Bold").fontSize(16).fillColor("#0f3d3e").text("HES Bakım Yönetim Sistemi");
    dokuman
      .font("DejaVu-Bold")
      .fontSize(12)
      .fillColor("#13201c")
      .text(`${santral.isletme_adi} — ${santral.ad} — Bakım Raporu`);
    const donemMetni =
      req.query.baslangic || req.query.bitis
        ? `Dönem: ${req.query.baslangic ? tarihFormatla(req.query.baslangic) : "…"} – ${
            req.query.bitis ? tarihFormatla(req.query.bitis) : "…"
          }`
        : "Dönem: Tüm zamanlar";
    const periyotMetni = req.query.periyot ? `   |   Bakım periyodu: ${PERIYOT_ETIKETLERI[req.query.periyot] || req.query.periyot}` : "";
    dokuman
      .font("DejaVu")
      .fontSize(8)
      .fillColor("#5b6b62")
      .text(`${donemMetni}${periyotMetni}   |   Rapor tarihi: ${tarihFormatla(new Date())}`);
    dokuman.moveDown(0.8);
    dokuman.strokeColor("#c17a24").lineWidth(1.5).moveTo(40, dokuman.y).lineTo(802, dokuman.y).stroke();
    dokuman.moveDown(0.6);

    // Özet satırı
    dokuman
      .font("DejaVu")
      .fontSize(9)
      .fillColor("#13201c")
      .text(
        `Toplam: ${ozet.toplam_gorev}   ·   Tamamlanan: ${ozet.tamamlanan}   ·   Gecikmiş: ${ozet.gecikmis}   ·   Bekleyen: ${ozet.bekleyen}   ·   Tamamlanma: %${ozet.tamamlanma_yuzdesi}`
      );
    dokuman.moveDown(0.8);

    // Tablo
    const sutunlar = [
      { baslik: "İşletme", genislik: 95 },
      { baslik: "Bakım Adı", genislik: 285 },
      { baslik: "Durum", genislik: 78 },
      { baslik: "Personel", genislik: 90 },
      { baslik: "Atama Tarihi", genislik: 75 },
      { baslik: "Tamamlama T.", genislik: 85 },
    ];
    const tabloSolX = 40;
    let y = dokuman.y;
    const SATIR_YUKSEKLIGI = 16;

    function hucreYaz(metin, sutunIndex, kalinMi, renk) {
      let x = tabloSolX;
      for (let i = 0; i < sutunIndex; i++) x += sutunlar[i].genislik;
      dokuman
        .font(kalinMi ? "DejaVu-Bold" : "DejaVu")
        .fontSize(8.5)
        .fillColor(renk || "#13201c")
        .text(String(metin), x, y, {
          width: sutunlar[sutunIndex].genislik - 8,
          height: SATIR_YUKSEKLIGI,
          ellipsis: true,
          lineBreak: false,
        });
    }

    sutunlar.forEach((s, i) => hucreYaz(s.baslik, i, true, "#0f3d3e"));
    y += SATIR_YUKSEKLIGI;
    dokuman.strokeColor("#c9d0c8").lineWidth(0.5).moveTo(tabloSolX, y - 2).lineTo(802, y - 2).stroke();
    y += 2;

    const DURUM_RENK = { TAMAMLANDI: "#2c7a4b", GECIKTI: "#a83b2e", BEKLIYOR: "#c17a24", DEVAM_EDIYOR: "#1d4e75" };

    gorevler.forEach((g) => {
      if (y > 555) {
        dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
        y = 40;
      }
      hucreYaz(santral.ad, 0, false);
      hucreYaz(`${g.ekipman_adi} — ${g.bakim_adi}`, 1, false);
      hucreYaz(DURUM_ETIKETLERI[g.durum] || g.durum, 2, true, DURUM_RENK[g.durum] || "#13201c");
      hucreYaz(g.tamamlayan_personel || g.atanan_personel, 3, false);
      hucreYaz(tarihFormatla(g.planlanan_tarih), 4, false);
      hucreYaz(tarihFormatla(g.tamamlanma_tarihi), 5, false);
      y += SATIR_YUKSEKLIGI;
    });

    if (gorevler.length === 0) {
      dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62").text("Bu dönemde kayıtlı görev bulunmuyor.", tabloSolX, y);
      y += SATIR_YUKSEKLIGI;
    }

    // Onay/imza alanları
    y += 30;
    if (y > 540) {
      dokuman.addPage({ size: "A4", layout: "landscape", margin: 40 });
      y = 40;
    }
    dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62");
    dokuman.text("Bakım Müdürlüğü", tabloSolX, y);
    dokuman.text("_____________________", tabloSolX, y + 30);
    dokuman.text("İşletme Yöneticisi / Müdürü", tabloSolX + 300, y);
    dokuman.text("_____________________", tabloSolX + 300, y + 30);

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/raporlar/santral/:santral_id/excel
router.get("/santral/:santral_id/excel", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { santral_id } = req.params;
    if (!(await santralErisimVarMi(req, santral_id))) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }

    const { santral, ozet, gorevler } = await santralRaporVerisiTopla(req, santral_id);
    if (!santral) {
      return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "HES CMMS";
    workbook.created = new Date();

    const ozetSheet = workbook.addWorksheet("Özet");
    ozetSheet.columns = [
      { header: "Alan", key: "alan", width: 28 },
      { header: "Değer", key: "deger", width: 24 },
    ];
    ozetSheet.getRow(1).font = { bold: true };
    ozetSheet.addRows([
      { alan: "İşletme (Holding)", deger: santral.isletme_adi },
      { alan: "Santral", deger: santral.ad },
      {
        alan: "Dönem",
        deger:
          req.query.baslangic || req.query.bitis
            ? `${tarihFormatla(req.query.baslangic) } – ${tarihFormatla(req.query.bitis)}`
            : "Tüm zamanlar",
      },
      { alan: "Bakım periyodu", deger: req.query.periyot ? (PERIYOT_ETIKETLERI[req.query.periyot] || req.query.periyot) : "Tümü" },
      { alan: "Rapor tarihi", deger: tarihFormatla(new Date()) },
      { alan: "Toplam görev", deger: ozet.toplam_gorev },
      { alan: "Tamamlanan", deger: ozet.tamamlanan },
      { alan: "Gecikmiş", deger: ozet.gecikmis },
      { alan: "Bekleyen", deger: ozet.bekleyen },
      { alan: "Tamamlanma yüzdesi (%)", deger: ozet.tamamlanma_yuzdesi },
    ]);

    const gorevSheet = workbook.addWorksheet("Bakım Kayıtları");
    gorevSheet.columns = [
      { header: "İşletme", key: "isletme_adi", width: 20 },
      { header: "Bakım Adı", key: "bakim_adi", width: 42 },
      { header: "Durum", key: "durum", width: 14 },
      { header: "Personel", key: "personel", width: 20 },
      { header: "Atama Tarihi", key: "atama_tarihi", width: 14 },
      { header: "Tamamlama Tarihi", key: "tamamlama_tarihi", width: 16 },
    ];
    gorevSheet.getRow(1).font = { bold: true };
    gorevler.forEach((g) => {
      const satir = gorevSheet.addRow({
        isletme_adi: santral.ad,
        bakim_adi: `${g.ekipman_adi} — ${g.bakim_adi}`,
        durum: DURUM_ETIKETLERI[g.durum] || g.durum,
        personel: g.tamamlayan_personel || g.atanan_personel,
        atama_tarihi: tarihFormatla(g.planlanan_tarih),
        tamamlama_tarihi: tarihFormatla(g.tamamlanma_tarihi),
      });
      const renkler = { TAMAMLANDI: "FF2C7A4B", GECIKTI: "FFA83B2E", BEKLIYOR: "FFC17A24", DEVAM_EDIYOR: "FF1D4E75" };
      if (renkler[g.durum]) {
        satir.getCell("durum").font = { color: { argb: renkler[g.durum] }, bold: true };
      }
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bakim-raporu-${santral.ad.replace(/\s+/g, "-")}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// TAMAMLANAN GÖREVİN TAM DETAY PDF'İ ("Bakım Formu" çıktısı)
// Rapor Oluştur sayfasındaki "PDF Çıktı Al" özelliği için: tek bir
// tamamlanmış görevin checklist formunu (soru+cevap, not, imza, fotoğraf)
// ekrandaki hâline sadık kalarak PDF olarak üretir.
// ---------------------------------------------------------------------

// GET /api/v1/raporlar/tamamlanan-gorevler?baslangic=&bitis=&santral_id=&isletme_id=
// Seçim listesini doldurur — tarih aralığındaki TAMAMLANDI görevleri listeler.
router.get("/tamamlanan-gorevler", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const santralIdleri = await erisilenSantralIdleri(req);
    if (santralIdleri.length === 0) {
      return res.json({ veri: [] });
    }

    const params = [santralIdleri];
    let ekKosul = "";
    if (req.query.santral_id) {
      params.push(req.query.santral_id);
      ekKosul += ` AND s.santral_id = $${params.length}`;
    } else if (req.query.isletme_id) {
      params.push(req.query.isletme_id);
      ekKosul += ` AND s.isletme_id = $${params.length}`;
    }
    if (req.query.baslangic) {
      params.push(req.query.baslangic);
      ekKosul += ` AND bk.tamamlanma_tarihi >= $${params.length}`;
    }
    if (req.query.bitis) {
      params.push(`${req.query.bitis} 23:59:59`);
      ekKosul += ` AND bk.tamamlanma_tarihi <= $${params.length}`;
    }

    const { rows } = await req.db.query(
      `SELECT g.gorev_id, bk.tamamlanma_tarihi,
              s.ad AS santral_adi, e.ad AS ekipman_adi, bs.ad AS bakim_adi,
              k.ad_soyad AS tamamlayan_adi
       FROM bakim_gorevi g
       JOIN bakim_kaydi bk    ON bk.gorev_id = g.gorev_id
       JOIN bakim_plani bp    ON bp.plan_id = g.plan_id
       JOIN santral s         ON s.santral_id = bp.santral_id
       JOIN ekipman e         ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs  ON bs.sablon_id = bp.sablon_id
       JOIN kullanici k       ON k.kullanici_id = bk.tamamlayan_kullanici_id
       WHERE g.durum = 'TAMAMLANDI' AND s.santral_id = ANY($1::uuid[]) ${ekKosul}
       ORDER BY bk.tamamlanma_tarihi DESC
       LIMIT 500`,
      params
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

/** Bir görsel kaynağını (base64 data URL ya da http(s) URL) pdfkit'e
 * verilebilecek bir Buffer'a çevirir. Supabase Storage'a yüklenmiş
 * fotoğraf/imzalar http(s) URL, yapılandırılmamışsa base64 data URL olur. */
async function gorseleGetir(kaynak) {
  if (!kaynak) return null;
  if (kaynak.startsWith("data:")) {
    const eslesme = kaynak.match(/^data:image\/\w+;base64,(.+)$/);
    if (!eslesme) return null;
    return Buffer.from(eslesme[1], "base64");
  }
  try {
    const yanit = await fetch(kaynak);
    if (!yanit.ok) return null;
    const arrayBuffer = await yanit.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

/** HTTP header değerleri yalnızca ISO-8859-1/ASCII karakter kabul eder;
 * Türkçe ı/ş/ğ/İ gibi karakterler Content-Disposition'da "Invalid character
 * in header content" hatasına yol açar. ASCII'ye sadeleştirilmiş bir yedek
 * ad üretir; gerçek Türkçe ad ise RFC 6266 filename* parametresiyle
 * (UTF-8 kodlanmış) ayrıca eklenir, böylece modern tarayıcılarda doğru
 * görünür, eskilerinde de en azından çökmeden iner. */
function dosyaAdiGuvenliHaleGetir(metin) {
  const harita = {
    ı: "i", İ: "I", ş: "s", Ş: "S", ğ: "g", Ğ: "G",
    ü: "u", Ü: "U", ö: "o", Ö: "O", ç: "c", Ç: "C",
  };
  return metin
    .replace(/[ışŞğĞüÜöÖçÇİ]/g, (ch) => harita[ch] || ch)
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "-");
}
function contentDispositionOlustur(orijinalAd) {
  const guvenliAd = dosyaAdiGuvenliHaleGetir(orijinalAd);
  const utf8Ad = encodeURIComponent(orijinalAd);
  return `attachment; filename="${guvenliAd}"; filename*=UTF-8''${utf8Ad}`;
}

// GET /api/v1/raporlar/gorev-detay-pdf/:gorev_id
router.get("/gorev-detay-pdf/:gorev_id", requireRole(...RAPOR_ROLLERI), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT g.gorev_id, g.planlanan_tarih,
              bk.checklist_sonuclari, bk.notlar, bk.fotograflar, bk.imza_url, bk.tamamlanma_tarihi,
              s.santral_id, s.ad AS santral_adi, i.ad AS isletme_adi,
              e.ad AS ekipman_adi,
              bs.ad AS bakim_adi, bs.checklist_json,
              k.ad_soyad AS tamamlayan_adi
       FROM bakim_gorevi g
       JOIN bakim_kaydi bk    ON bk.gorev_id = g.gorev_id
       JOIN bakim_plani bp    ON bp.plan_id = g.plan_id
       JOIN santral s         ON s.santral_id = bp.santral_id
       JOIN isletme i         ON i.isletme_id = s.isletme_id
       JOIN ekipman e         ON e.ekipman_id = bp.ekipman_id
       JOIN bakim_sablonu bs  ON bs.sablon_id = bp.sablon_id
       JOIN kullanici k       ON k.kullanici_id = bk.tamamlayan_kullanici_id
       WHERE g.gorev_id = $1`,
      [req.params.gorev_id]
    );
    const kayit = rows[0];
    if (!kayit) {
      return res.status(404).json({ hata_kodu: "GOREV_BULUNAMADI", mesaj: "Görev ya da bakım kaydı bulunamadı." });
    }
    if (!(await erisilenSantralIdleri(req)).includes(kayit.santral_id)) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu göreve erişim yetkiniz yok." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      contentDispositionOlustur(`bakim-formu-${kayit.ekipman_adi}.pdf`)
    );

    const dokuman = new PDFDocument({ size: "A4", margin: 45 });
    res.on("error", (err) => console.error("Görev detay PDF akış hatası:", err.message));
    dokuman.on("error", (err) => console.error("Görev detay PDF üretim hatası:", err.message));
    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    const genislik = 505; // A4 - 2*45 kenar boşluğu

    dokuman.font("DejaVu-Bold").fontSize(15).fillColor("#0f3d3e").text(kayit.bakim_adi.toUpperCase());
    dokuman
      .font("DejaVu")
      .fontSize(10)
      .fillColor("#5b6b62")
      .text(`${kayit.isletme_adi} — ${kayit.santral_adi} — ${kayit.ekipman_adi}`);
    dokuman.moveDown(0.6);
    dokuman.strokeColor("#c17a24").lineWidth(1.5).moveTo(45, dokuman.y).lineTo(45 + genislik, dokuman.y).stroke();
    dokuman.moveDown(0.8);

    const kalemler = kayit.checklist_json?.kalemler || [];
    const cevaplar = kayit.checklist_sonuclari || {};
    const TIP_ETIKETLERI = { evet_hayir: "Evet / Hayır", olcum: "Ölçüm", metin: "Serbest metin" };

    kalemler.forEach((kalem) => {
      if (dokuman.y > 720) dokuman.addPage({ size: "A4", margin: 45 });
      const cevap = cevaplar[kalem.id]?.deger;

      dokuman.font("DejaVu-Bold").fontSize(10.5).fillColor("#13201c").text(kalem.soru, 45, dokuman.y, {
        width: genislik,
      });
      dokuman.moveDown(0.15);

      let cevapMetni = "—";
      let renk = "#5b6b62";
      if (kalem.tip === "evet_hayir") {
        cevapMetni = cevap === true ? "✓ Evet" : cevap === false ? "✗ Hayır" : "—";
        renk = cevap === true ? "#2c7a4b" : cevap === false ? "#a83b2e" : "#5b6b62";
      } else if (kalem.tip === "olcum") {
        cevapMetni = cevap !== undefined && cevap !== "" ? `${cevap}${kalem.birim ? " " + kalem.birim : ""}` : "—";
      } else {
        cevapMetni = cevap || "—";
      }
      dokuman.font("DejaVu-Bold").fontSize(10).fillColor(renk).text(cevapMetni, 45, dokuman.y, { width: genislik });
      dokuman.moveDown(0.6);
    });

    dokuman.moveDown(0.3);
    dokuman.font("DejaVu-Bold").fontSize(10.5).fillColor("#13201c").text("Genel not");
    dokuman.font("DejaVu").fontSize(10).fillColor("#5b6b62").text(kayit.notlar || "—", { width: genislik });
    dokuman.moveDown(0.8);

    // Fotoğraflar
    if (kayit.fotograflar && kayit.fotograflar.length > 0) {
      dokuman.font("DejaVu-Bold").fontSize(10.5).fillColor("#13201c").text(`Fotoğraflar (${kayit.fotograflar.length})`);
      dokuman.moveDown(0.3);
      let x = 45;
      const fotoGenislik = 110;
      for (const foto of kayit.fotograflar) {
        const buffer = await gorseleGetir(foto).catch(() => null);
        if (buffer) {
          if (x + fotoGenislik > 45 + genislik) {
            x = 45;
            dokuman.moveDown(0.5);
          }
          try {
            dokuman.image(buffer, x, dokuman.y, { width: fotoGenislik });
          } catch {
            // bozuk görsel verisi — sessizce atla
          }
          x += fotoGenislik + 10;
        }
      }
      dokuman.moveDown(9);
    }

    if (dokuman.y > 620) dokuman.addPage({ size: "A4", margin: 45 });
    dokuman.font("DejaVu-Bold").fontSize(10.5).fillColor("#13201c").text("Onay — İmza");
    dokuman.moveDown(0.3);
    const imzaBuffer = await gorseleGetir(kayit.imza_url).catch(() => null);
    if (imzaBuffer) {
      try {
        dokuman.image(imzaBuffer, 45, dokuman.y, { width: 200, height: 90, fit: [200, 90] });
        dokuman.moveDown(6.5);
      } catch {
        dokuman.font("DejaVu").fontSize(9).fillColor("#5b6b62").text("(imza görüntülenemedi)");
      }
    }

    dokuman
      .font("DejaVu")
      .fontSize(9)
      .fillColor("#5b6b62")
      .text(
        `Tamamlayan: ${kayit.tamamlayan_adi}   |   Tamamlanma tarihi: ${tarihFormatla(kayit.tamamlanma_tarihi)}`
      );

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
