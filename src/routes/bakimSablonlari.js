const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const SABLON_YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

/** Bir görev, PLANLANAN BAŞLANGIÇ tarihi geçtiği anda değil, o dönemin
 * SÜRESİ (bir sonraki dönemin başlayacağı tarih) geçtiğinde gecikmiş
 * sayılır — yani görevi yapmaya hâlâ zaman varsa "Bekliyor" kalır. */
function gecikmisMi(baslangicTarihi, periyot, bitisTarihi) {
  const bugun = new Date(new Date().toDateString());
  let sonTarih = otomatikBaslangicTarihiIcinPeriyotEkle(baslangicTarihi, periyot);
  if (bitisTarihi) {
    const bitis = new Date(bitisTarihi);
    if (bitis < sonTarih) sonTarih = bitis;
  }
  return bugun > sonTarih;
}
function otomatikBaslangicTarihiIcinPeriyotEkle(tarih, periyot) {
  const d = new Date(tarih);
  switch (periyot) {
    case "GUNLUK": d.setDate(d.getDate() + 1); break;
    case "HAFTALIK": d.setDate(d.getDate() + 7); break;
    case "AYLIK": d.setMonth(d.getMonth() + 1); break;
    case "UC_AYLIK": d.setMonth(d.getMonth() + 3); break;
    case "ALTI_AYLIK": d.setMonth(d.getMonth() + 6); break;
    case "YILLIK": d.setFullYear(d.getFullYear() + 1); break;
    case "IKI_YILLIK": d.setFullYear(d.getFullYear() + 2); break;
    case "UC_YILLIK": d.setFullYear(d.getFullYear() + 3); break;
    case "BES_YILLIK": d.setFullYear(d.getFullYear() + 5); break;
    case "ON_YILLIK": d.setFullYear(d.getFullYear() + 10); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d;
}

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
    const { ekipman_tipi, isletme_id, santral_id, periyot_tipi, hepsi } = req.query;
    const params = [];
    let sorgu = `SELECT bs.sablon_id, bs.ad, bs.ekipman_adi, bs.ekipman_tipi, bs.unite_no, bs.periyot_tipi, bs.versiyon, bs.aktif_mi,
                        bs.olusturma_tarihi, bs.isletme_id, i.ad AS isletme_adi,
                        bs.santral_id, s.ad AS santral_adi
                 FROM bakim_sablonu bs
                 JOIN isletme i ON i.isletme_id = bs.isletme_id
                 LEFT JOIN santral s ON s.santral_id = bs.santral_id
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
    if (periyot_tipi) {
      params.push(periyot_tipi);
      sorgu += ` AND bs.periyot_tipi = $${params.length}`;
    }
    // santral_id belirtilmişse: o santrale ÖZEL şablonlar + holding genelindeki
    // (santral_id IS NULL) şablonlar — bir bakım planı oluştururken kullanılan
    // seçim mantığıyla birebir aynı.
    if (santral_id) {
      params.push(santral_id);
      sorgu += ` AND (bs.santral_id = $${params.length} OR bs.santral_id IS NULL)`;
    }
    sorgu += ` ORDER BY i.ad, s.ad NULLS FIRST, bs.periyot_tipi, bs.ad`;

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

// GET /api/v1/bakim-sablonlari/ekipman-tipleri?isletme_id=&santral_id= —
// Şablon formunda "Ekipman Tipi"yi serbest yazı yerine açılır kutu yapmak
// için, sistemde GERÇEKTEN KAYITLI olan ekipman tiplerini döner. Bu, yazım
// hatası/farklı büyük-küçük harf yüzünden şablonun hiçbir ekipmanla
// eşleşmemesi sorununu kökünden engeller.
// NOT: "/:sablon_id" route'undan ÖNCE tanımlanmalı.
router.get("/ekipman-tipleri", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const hedefIsletmeId = platformAdminMi(req) ? req.query.isletme_id : req.user.isletme_id;
    const params = [];
    let kosul = "";
    if (req.query.santral_id) {
      params.push(req.query.santral_id);
      kosul = `WHERE e.santral_id = $1`;
    } else if (hedefIsletmeId) {
      params.push(hedefIsletmeId);
      kosul = `WHERE s.isletme_id = $1`;
    }
    const { rows } = await req.db.query(
      `SELECT DISTINCT e.tip FROM ekipman e JOIN santral s ON s.santral_id = e.santral_id ${kosul} ORDER BY e.tip`,
      params
    );
    res.json({ veri: rows.map((r) => r.tip) });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/bakim-sablonlari/saha-personeli?isletme_id=X — "Oto Bakım
// Planla" sayfasında sorumlu seçimi için, belirtilen SANTRALE erişimi olan
// saha personelini listeler (holding genelini değil — başka santrallerin
// personeli karışmasın diye). Platform Admin/İşletme Admin herhangi bir
// santral için sorgulayabilir; Santral Sorumlusu yalnızca erişimi olan
// santraller için.
// NOT: Bu route, "/:sablon_id" route'undan ÖNCE tanımlanmalı — aksi halde
// Express "saha-personeli" metnini bir sablon_id değeri sanır.
router.get("/saha-personeli", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { santral_id } = req.query;
    if (!santral_id) {
      return res.status(400).json({ hata_kodu: "EKSIK_ALAN", mesaj: "santral_id belirtilmelidir." });
    }
    const { rows: erisimRows } = await req.db.query(
      `SELECT 1 FROM v_kullanici_yetkili_santraller WHERE kullanici_id = $1 AND santral_id = $2`,
      [req.user.kullanici_id, santral_id]
    );
    if (!erisimRows[0]) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu santrale erişim yetkiniz yok." });
    }
    const { rows } = await req.db.query(
      `SELECT k.kullanici_id, k.ad_soyad FROM kullanici k
       WHERE k.rol = 'SAHA_PERSONELI' AND k.aktif_mi = TRUE
         AND k.kullanici_id IN (
           SELECT kullanici_id FROM v_kullanici_yetkili_santraller WHERE santral_id = $1
         )
       ORDER BY k.ad_soyad`,
      [santral_id]
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

// GET /api/v1/bakim-sablonlari/:sablon_id/karekod-ekipmanlari — KAREKOD
// OKUTMA sayfası içindir. Bakımlarımızın temeli şablon üzerinden ilerlediği
// için karekod EKİPMANA değil ŞABLONA basılır; okutulduğunda bu şablonun
// ekipman tipiyle eşleşen, şablonun kapsamındaki (santrale özelse o
// santral, değilse holdingin tüm santralleri) aktif ekipmanları listeler.
// Rol kısıtlaması YOKTUR — yalnızca oturum açmış olmak yeterlidir.
router.get("/:sablon_id/karekod-ekipmanlari", async (req, res, next) => {
  try {
    const { rows: sablonRows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const sablon = sablonRows[0];
    if (!sablon || !sablon.aktif_mi) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı ya da pasif." });
    }

    const { rows: ekipmanlar } = await req.db.query(
      sablon.santral_id
        ? `SELECT e.ekipman_id, e.ad, e.unite_no, s.ad AS santral_adi
           FROM ekipman e JOIN santral s ON s.santral_id = e.santral_id
           WHERE e.santral_id = $1 AND e.tip = $2 AND e.durum = 'AKTIF'
             AND ($3::text IS NULL OR e.unite_no = $3)
           ORDER BY e.ad`
        : `SELECT e.ekipman_id, e.ad, e.unite_no, s.ad AS santral_adi
           FROM ekipman e JOIN santral s ON s.santral_id = e.santral_id
           WHERE s.isletme_id = $1 AND e.tip = $2 AND e.durum = 'AKTIF'
             AND ($3::text IS NULL OR e.unite_no = $3)
           ORDER BY s.ad, e.ad`,
      [sablon.santral_id || sablon.isletme_id, sablon.ekipman_tipi, sablon.unite_no || null]
    );

    res.json({
      sablon: { sablon_id: sablon.sablon_id, ad: sablon.ad, periyot_tipi: sablon.periyot_tipi, ekipman_tipi: sablon.ekipman_tipi },
      ekipmanlar,
    });
  } catch (err) {
    next(err);
  }
});

const FONT_NORMAL = path.join(__dirname, "..", "DejaVuSans.ttf");
const FONT_KALIN = path.join(__dirname, "..", "DejaVuSans-Bold.ttf");
const PERIYOT_ETIKETLERI_PDF = {
  GUNLUK: "Günlük", HAFTALIK: "Haftalık", AYLIK: "Aylık", UC_AYLIK: "3 Ayda Bir",
  ALTI_AYLIK: "6 Ayda Bir", YILLIK: "Yıllık", IKI_YILLIK: "2 Yılda Bir",
  UC_YILLIK: "3 Yılda Bir", BES_YILLIK: "5 Yılda Bir", ON_YILLIK: "10 Yılda Bir",
};

// GET /api/v1/bakim-sablonlari/:sablon_id/karekod-pdf — bu şablonun TEK ve
// KALICI karekodunu (her zaman aynı sablon_id'den üretildiği için içeriği
// hep aynıdır) yazdırılabilir bir PDF olarak indirir. Harici bir servise
// bağımlı kalmadan (qrcode paketiyle) sunucu tarafında üretilir.
router.get("/:sablon_id/karekod-pdf", async (req, res, next) => {
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

    // Adresi öncelikle isteği yapan sayfadan (?site=) al — bu, tarayıcının o
    // an bulunduğu GERÇEK adresi (ör. https://barajbakim.com) yansıtır ve
    // sunucudaki FRONTEND_URLS ayarlanmamış/yanlışsa bile her zaman doğru
    // çalışır. Hiç gönderilmezse FRONTEND_URLS'e geri döner.
    const siteAdresi =
      (req.query.site && decodeURIComponent(req.query.site)) ||
      (process.env.FRONTEND_URLS || "").split(",")[0]?.trim() ||
      "";
    const karekodAdresi = `${siteAdresi}/karekod-sablon/${sablon.sablon_id}`;
    const qrDataUrl = await QRCode.toDataURL(karekodAdresi, { width: 500, margin: 1 });
    const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

    const guvenliDosyaAdi = sablon.ad
      .replace(/[ışŞğĞüÜöÖçÇİ]/g, (ch) => ({ ı: "i", İ: "I", ş: "s", Ş: "S", ğ: "g", Ğ: "G", ü: "u", Ü: "U", ö: "o", Ö: "O", ç: "c", Ç: "C" }[ch] || ch))
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\s+/g, "-");
    const utf8Ad = encodeURIComponent(`karekod-${sablon.ad}.pdf`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="karekod-${guvenliDosyaAdi}.pdf"; filename*=UTF-8''${utf8Ad}`);

    const dokuman = new PDFDocument({ size: "A4", margin: 50 });
    res.on("error", (err) => console.error("Karekod PDF akış hatası:", err.message));
    dokuman.on("error", (err) => console.error("Karekod PDF üretim hatası:", err.message));
    dokuman.pipe(res);
    dokuman.registerFont("DejaVu", FONT_NORMAL);
    dokuman.registerFont("DejaVu-Bold", FONT_KALIN);

    dokuman
      .font("DejaVu-Bold")
      .fontSize(16)
      .fillColor("#0f3d3e")
      .text(sablon.ad, { align: "center" });
    dokuman.moveDown(0.3);
    dokuman
      .font("DejaVu")
      .fontSize(11)
      .fillColor("#5b6b62")
      .text(`${sablon.ekipman_tipi} — ${PERIYOT_ETIKETLERI_PDF[sablon.periyot_tipi] || sablon.periyot_tipi}`, { align: "center" });
    dokuman.moveDown(1.5);

    const qrGenislik = 300;
    const sayfaGenisligi = dokuman.page.width - 100;
    dokuman.image(qrBuffer, 50 + (sayfaGenisligi - qrGenislik) / 2, dokuman.y, { width: qrGenislik });
    dokuman.y += qrGenislik + 20;

    dokuman
      .font("DejaVu")
      .fontSize(10)
      .fillColor("#5b6b62")
      .text("Bu karekodu yazdırıp ilgili ekipmanın üzerine yapıştırın.", { align: "center" });

    dokuman.end();
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/bakim-sablonlari — yeni şablon oluşturur (föy dijitalleştirme)
// Platform Admin isteğe bağlı isletme_id belirtebilir (hangi holding için); diğerleri
// her zaman kendi holdingi için oluşturur.
router.post("/", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { ad, ekipman_adi, ekipman_tipi, unite_no, periyot_tipi, checklist_json, santral_id } = req.body;
    if (!ad || !ekipman_tipi || !periyot_tipi || !checklist_json) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "ad, ekipman_tipi, periyot_tipi ve checklist_json alanları zorunludur.",
      });
    }

    const hedefIsletmeId =
      platformAdminMi(req) && req.body.isletme_id ? req.body.isletme_id : req.user.isletme_id;

    // santral_id verilmişse, gerçekten hedef holdinge ait bir santral olduğunu
    // doğrula — çapraz holding hatasını önler.
    if (santral_id) {
      const { rows: santralRows } = await req.db.query(
        `SELECT santral_id FROM santral WHERE santral_id = $1 AND isletme_id = $2`,
        [santral_id, hedefIsletmeId]
      );
      if (!santralRows[0]) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_SANTRAL",
          mesaj: "Belirtilen santral, hedef holdinge ait değil.",
        });
      }
    }

    const { rows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_adi, ekipman_tipi, unite_no, periyot_tipi, checklist_json, olusturan_kullanici_id, isletme_id, santral_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        ad,
        ekipman_adi || null,
        ekipman_tipi,
        unite_no || null,
        periyot_tipi,
        JSON.stringify(checklist_json),
        req.user.kullanici_id,
        hedefIsletmeId,
        santral_id || null,
      ]
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
    const ekipman_adi = req.body.ekipman_adi !== undefined ? req.body.ekipman_adi : eski.ekipman_adi;
    const ekipman_tipi = req.body.ekipman_tipi ?? eski.ekipman_tipi;
    const unite_no = req.body.unite_no !== undefined ? req.body.unite_no : eski.unite_no;
    const periyot_tipi = req.body.periyot_tipi ?? eski.periyot_tipi;
    const santral_id = req.body.santral_id !== undefined ? req.body.santral_id : eski.santral_id;
    const checklist_json = req.body.checklist_json
      ? JSON.stringify(req.body.checklist_json)
      : JSON.stringify(eski.checklist_json);

    await req.db.query("BEGIN");
    await req.db.query(`UPDATE bakim_sablonu SET aktif_mi = FALSE WHERE sablon_id = $1`, [eski.sablon_id]);

    const { rows: yeniRows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_adi, ekipman_tipi, unite_no, periyot_tipi, checklist_json, versiyon, olusturan_kullanici_id, isletme_id, santral_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [ad, ekipman_adi, ekipman_tipi, unite_no, periyot_tipi, checklist_json, eski.versiyon + 1, req.user.kullanici_id, eski.isletme_id, santral_id]
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

    // Hedef holdingde AYNI İSİMDE zaten aktif bir şablon varsa mükerrer
    // kopyalamayı engelle.
    const { rows: mevcutRows } = await req.db.query(
      `SELECT sablon_id FROM bakim_sablonu WHERE isletme_id = $1 AND ad = $2 AND aktif_mi = TRUE`,
      [hedefIsletmeId, yeniAd]
    );
    if (mevcutRows[0]) {
      return res.status(409).json({
        hata_kodu: "SABLON_ZATEN_VAR",
        mesaj: "Bu Bakım Şablonu Kayıtlarınızda Var",
      });
    }

    // Kaynağın santral bağlantısı hedef holdingde ANLAMSIZ (farklı santral
    // kimlikleri) — kopya varsayılan olarak holding geneli (santral_id=NULL)
    // olur; istenirse hedef holdinge ait geçerli bir santral belirtilebilir.
    let hedefSantralId = null;
    if (req.body.santral_id) {
      const { rows: santralRows } = await req.db.query(
        `SELECT santral_id FROM santral WHERE santral_id = $1 AND isletme_id = $2`,
        [req.body.santral_id, hedefIsletmeId]
      );
      if (santralRows[0]) hedefSantralId = req.body.santral_id;
    }

    const { rows } = await req.db.query(
      `INSERT INTO bakim_sablonu (ad, ekipman_tipi, periyot_tipi, checklist_json, olusturan_kullanici_id, isletme_id, santral_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        yeniAd,
        kaynak.ekipman_tipi,
        kaynak.periyot_tipi,
        JSON.stringify(kaynak.checklist_json),
        req.user.kullanici_id,
        hedefIsletmeId,
        hedefSantralId,
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

/** Periyoda göre bakım planının başlangıç tarihini hesaplar.
 * HAFTALIK  → içinde bulunulan haftanın Pazartesi günü (geçmişte kalsa
 *             bile — böylece o hafta için hâlâ oluşturulmamışsa görev
 *             doğru şekilde GECİKTİ olarak işaretlenir).
 * AYLIK     → içinde bulunulan ayın 1'i (aynı gerekçeyle).
 * Diğerleri → çağıran tarafından elle verilen tarih kullanılır. */
function otomatikBaslangicTarihi(periyotTipi) {
  const bugun = new Date();
  if (periyotTipi === "HAFTALIK") {
    const gun = bugun.getDay(); // 0=Pazar, 1=Pazartesi, ...
    const pazartesiyeFark = gun === 0 ? -6 : 1 - gun;
    const pazartesi = new Date(bugun);
    pazartesi.setDate(bugun.getDate() + pazartesiyeFark);
    return pazartesi.toISOString().slice(0, 10);
  }
  if (periyotTipi === "AYLIK") {
    return new Date(bugun.getFullYear(), bugun.getMonth(), 1).toISOString().slice(0, 10);
  }
  return null;
}

// POST /api/v1/bakim-sablonlari/:sablon_id/oto-planla — "Oto Bakım Planla"
// sayfasındaki ana işlem: bu şablonun ekipman tipiyle eşleşen, şablonun ait
// olduğu holdingin (ya da şablon tek bir santrale özelse yalnızca o
// santralin) TÜM ekipmanları için otomatik olarak birer bakım planı
// oluşturur — hâlihazırda bu ekipman+şablon için aktif bir plan varsa o
// ekipman atlanır (mükerrer plan oluşturulmaz).
router.post("/:sablon_id/oto-planla", requireRole(...SABLON_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: sablonRows } = await req.db.query(`SELECT * FROM bakim_sablonu WHERE sablon_id = $1`, [
      req.params.sablon_id,
    ]);
    const sablon = sablonRows[0];
    if (!sablon) {
      return res.status(404).json({ hata_kodu: "SABLON_BULUNAMADI", mesaj: "Bakım şablonu bulunamadı." });
    }
    if (!platformAdminMi(req) && sablon.isletme_id !== req.user.isletme_id) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu şablona erişim yetkiniz yok." });
    }

    const { sorumlu_kullanici_idleri, baslangic_tarihi, bitis_tarihi, santral_id } = req.body;
    if (!Array.isArray(sorumlu_kullanici_idleri) || sorumlu_kullanici_idleri.length === 0) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "En az bir sorumlu (saha personeli) seçilmelidir.",
      });
    }

    const otomatikTarih = otomatikBaslangicTarihi(sablon.periyot_tipi);
    const nihaiBaslangic = otomatikTarih || baslangic_tarihi;
    if (!nihaiBaslangic) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "Bu periyot için Bakım Başlama Tarihi belirtilmelidir.",
      });
    }

    // Hedef santraller: gövdede santral_id verilmişse (sayfa artık her
    // zaman belirli bir santral için çalıştığından bu her zaman verilir)
    // yalnızca O santral; verilmemişse eski davranış (şablon tek bir
    // santrale özelse o santral, değilse holdingin tamamı) uygulanır.
    let santralIdleri;
    if (santral_id) {
      const { rows: santralRows } = await req.db.query(
        `SELECT santral_id, isletme_id FROM santral WHERE santral_id = $1`,
        [santral_id]
      );
      if (!santralRows[0]) {
        return res.status(404).json({ hata_kodu: "SANTRAL_BULUNAMADI", mesaj: "Santral bulunamadı." });
      }
      if (sablon.santral_id && sablon.santral_id !== santral_id) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_SANTRAL",
          mesaj: "Bu şablon başka bir santrale özel, bu santral için kullanılamaz.",
        });
      }
      if (!sablon.santral_id && santralRows[0].isletme_id !== sablon.isletme_id) {
        return res.status(400).json({
          hata_kodu: "GECERSIZ_SANTRAL",
          mesaj: "Bu santral, şablonun ait olduğu holdinge ait değil.",
        });
      }
      santralIdleri = [santral_id];
    } else {
      const { rows: santralRows } = await req.db.query(
        sablon.santral_id
          ? `SELECT santral_id FROM santral WHERE santral_id = $1`
          : `SELECT santral_id FROM santral WHERE isletme_id = $1`,
        [sablon.santral_id || sablon.isletme_id]
      );
      santralIdleri = santralRows.map((r) => r.santral_id);
    }

    // Bu şablonun ekipman tipiyle eşleşen TÜM aktif ekipmanları bul, hangileri
    // için bu şablona ait AKTİF bir plan zaten var (mükerrer olur) ayrıca
    // işaretle.
    const { rows: ekipmanRows } = await req.db.query(
      `SELECT e.ekipman_id, e.santral_id, e.ad AS ekipman_adi, s.ad AS santral_adi,
              EXISTS (
                SELECT 1 FROM bakim_plani bp
                WHERE bp.ekipman_id = e.ekipman_id AND bp.sablon_id = $3 AND bp.aktif_mi = TRUE
              ) AS mukerrer
       FROM ekipman e
       JOIN santral s ON s.santral_id = e.santral_id
       WHERE e.santral_id = ANY($1::uuid[]) AND e.tip = $2 AND e.durum = 'AKTIF'
         AND ($4::text IS NULL OR e.unite_no = $4)`,
      [santralIdleri, sablon.ekipman_tipi, req.params.sablon_id, sablon.unite_no || null]
    );

    if (ekipmanRows.length === 0) {
      return res.json({
        mesaj: `"${sablon.ad}" için eşleşen ekipman bulunamadı — sistemde "${sablon.ekipman_tipi}" tipinde${
          sablon.unite_no ? ` ve Ünite No="${sablon.unite_no}" olan` : ""
        } aktif bir ekipman kaydı yok. Şablonu düzenleyip "Ekipman Tipi" alanını, Ekipman Listesi'ndeki gerçek değerlerden yeniden seçin.`,
        olusturulan_sayisi: 0,
      });
    }

    const zorla = req.body.zorla === true;
    const uygunEkipman = ekipmanRows.filter((e) => !e.mukerrer);
    const mukerrerEkipman = ekipmanRows.filter((e) => e.mukerrer);

    // Aylık sonrası TÜM periyotlarda (3 aylık ve ötesi): mükerrer varsa ve
    // "zorla" gönderilmemişse, hiçbir şey oluşturmadan önce kullanıcıya
    // sorulmak üzere bilgi döneriz. Haftalık/Aylık'ta ise onay istemeyiz —
    // bunun yerine aşağıda, mevcut plana YENİ SEÇİLEN kişileri ekleyerek
    // devam ederiz (bkz. altındaki not).
    if (!otomatikTarih && mukerrerEkipman.length > 0 && !zorla) {
      return res.status(409).json({
        hata_kodu: "MUKERRER_TESPIT_EDILDI",
        mesaj: `"${sablon.ad}" daha önce gönderilmiştir.`,
        sablon_adi: sablon.ad,
        mukerrer_sayisi: mukerrerEkipman.length,
      });
    }

    // Haftalık/Aylık'ta TÜM eşleşen ekipmanlar işlenir (mükerrer olanlar
    // ATLANMAZ — aksi halde o ekipman için az önce SEÇTİĞİNİZ kişilere hiç
    // görev gitmezdi). Aylık sonrası periyotlarda ise "zorla" verilmemişse
    // yalnızca uygun (henüz planı olmayan) ekipmanlar işlenir; "zorla"
    // verilmişse hepsi yeni birer plan olarak işlenir.
    const islenecekEkipman = otomatikTarih ? ekipmanRows : zorla ? ekipmanRows : uygunEkipman;

    if (islenecekEkipman.length === 0) {
      return res.json({
        mesaj: "Uygun ekipman bulunamadı — hepsi için zaten aktif bir plan var.",
        olusturulan_sayisi: 0,
      });
    }

    const gorevGecikmisMi = gecikmisMi(nihaiBaslangic, sablon.periyot_tipi, otomatikTarih ? null : bitis_tarihi);
    const sonuclar = [];

    await req.db.query("BEGIN");
    try {
      for (const ekipman of islenecekEkipman) {
        let planId;

        // Haftalık/Aylık'ta, bu ekipman için bu şablona ait AKTİF bir plan
        // zaten varsa (mükerrer), YENİ bir plan açmak yerine MEVCUT planı
        // kullanıp seçtiğiniz kişileri o plana ekleriz — böylece yeni
        // seçtiğiniz kişiler de görevi alır, eskisi tekrar oluşturulmaz.
        if (otomatikTarih && ekipman.mukerrer) {
          const { rows: mevcutPlanRows } = await req.db.query(
            `SELECT plan_id FROM bakim_plani WHERE ekipman_id = $1 AND sablon_id = $2 AND aktif_mi = TRUE LIMIT 1`,
            [ekipman.ekipman_id, req.params.sablon_id]
          );
          planId = mevcutPlanRows[0].plan_id;
        } else {
          const { rows: planRows } = await req.db.query(
            `INSERT INTO bakim_plani (santral_id, ekipman_id, sablon_id, periyot, baslangic_tarihi, bitis_tarihi)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING plan_id`,
            [
              ekipman.santral_id,
              ekipman.ekipman_id,
              req.params.sablon_id,
              sablon.periyot_tipi,
              nihaiBaslangic,
              otomatikTarih ? null : bitis_tarihi || null,
            ]
          );
          planId = planRows[0].plan_id;
        }

        for (const kullaniciId of sorumlu_kullanici_idleri) {
          await req.db.query(
            `INSERT INTO bakim_plani_sorumlu (plan_id, kullanici_id) VALUES ($1, $2)
             ON CONFLICT (plan_id, kullanici_id) DO NOTHING`,
            [planId, kullaniciId]
          );
          await req.db.query(
            `INSERT INTO bakim_gorevi (plan_id, atanan_kullanici_id, planlanan_tarih, durum)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (plan_id, planlanan_tarih, atanan_kullanici_id) DO NOTHING`,
            [planId, kullaniciId, nihaiBaslangic, gorevGecikmisMi ? "GECIKTI" : "BEKLIYOR"]
          );
        }
        sonuclar.push({ ekipman_adi: ekipman.ekipman_adi, santral_adi: ekipman.santral_adi });
      }
      await req.db.query("COMMIT");
    } catch (icErr) {
      await req.db.query("ROLLBACK");
      throw icErr;
    }

    res.status(201).json({
      mesaj: `${sonuclar.length} ekipman için görev(ler) oluşturuldu/atandı (başlangıç: ${nihaiBaslangic}${gorevGecikmisMi ? " — geciken olarak işaretlendi" : ""}).`,
      olusturulan_sayisi: sonuclar.length,
      detaylar: sonuclar,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
