const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { withDbContext } = require("../middleware/dbContext");

const router = express.Router();
router.use(requireAuth, withDbContext);

const MESAJ_YONETICI_ROLLERI = ["SANTRAL_SORUMLUSU", "ISLETME_ADMIN", "ADMIN"];

function platformAdminMi(req) {
  return req.user.rol === "ADMIN";
}

// GET /api/v1/mesajlar/alicilar — mesaj gönderilebilecek kullanıcıları listeler.
// Platform Admin (ADMIN) herkesi görür; diğerleri yalnızca KENDİ holdingindeki
// kullanıcıları görür (kendisi hariç).
router.get("/alicilar", requireRole(...MESAJ_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const params = [req.user.kullanici_id];
    let sorgu = `SELECT kullanici_id, ad_soyad, eposta, rol FROM kullanici
                 WHERE aktif_mi = TRUE AND kullanici_id <> $1`;
    if (!platformAdminMi(req)) {
      params.push(req.user.isletme_id);
      sorgu += ` AND isletme_id = $${params.length}`;
    }
    sorgu += ` ORDER BY ad_soyad`;

    const { rows } = await req.db.query(sorgu, params);
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mesajlar/gelen-kutusu — oturum açan kullanıcının aldığı mesajlar
router.get("/gelen-kutusu", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT m.mesaj_id, m.icerik, m.gonderim_tarihi, m.okundu_mu, m.okunma_tarihi,
              g.kullanici_id AS gonderen_id, g.ad_soyad AS gonderen_adi
       FROM mesaj m
       JOIN kullanici g ON g.kullanici_id = m.gonderen_kullanici_id
       WHERE m.alici_kullanici_id = $1
       ORDER BY m.gonderim_tarihi DESC`,
      [req.user.kullanici_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mesajlar/giden-kutusu — oturum açan kullanıcının gönderdiği mesajlar
// (her birinin yanında alıcının o mesajı okuyup okumadığı bilgisi)
router.get("/giden-kutusu", async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT m.mesaj_id, m.icerik, m.gonderim_tarihi, m.okundu_mu, m.okunma_tarihi,
              a.kullanici_id AS alici_id, a.ad_soyad AS alici_adi
       FROM mesaj m
       JOIN kullanici a ON a.kullanici_id = m.alici_kullanici_id
       WHERE m.gonderen_kullanici_id = $1
       ORDER BY m.gonderim_tarihi DESC`,
      [req.user.kullanici_id]
    );
    res.json({ veri: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/mesajlar — tek veya toplu mesaj gönderir.
// Gövde: { alici_kullanici_idleri: [uuid, ...], icerik: "..." }
// Yönetici roller (Santral Sorumlusu/İşletme Admin/Platform Admin) yeni bir
// konuşma başlatıp toplu gönderebilir. Diğer roller YENİ konuşma başlatamaz —
// yalnızca kendilerine daha önce mesaj göndermiş TEK bir kişiye (yanıt olarak)
// mesaj yazabilirler.
router.post("/", async (req, res, next) => {
  try {
    const { alici_kullanici_idleri, icerik } = req.body;
    if (!Array.isArray(alici_kullanici_idleri) || alici_kullanici_idleri.length === 0 || !icerik?.trim()) {
      return res.status(400).json({
        hata_kodu: "EKSIK_ALAN",
        mesaj: "alici_kullanici_idleri (en az bir alıcı) ve icerik alanları zorunludur.",
      });
    }

    const yoneticiMi = MESAJ_YONETICI_ROLLERI.includes(req.user.rol);

    if (!yoneticiMi) {
      if (alici_kullanici_idleri.length !== 1) {
        return res.status(403).json({
          hata_kodu: "YETKI_YOK",
          mesaj: "Yalnızca size daha önce mesaj göndermiş bir kişiye, yanıt olarak tek tek mesaj yazabilirsiniz.",
        });
      }
      const { rows: dahaOnceRows } = await req.db.query(
        `SELECT 1 FROM mesaj WHERE gonderen_kullanici_id = $1 AND alici_kullanici_id = $2 LIMIT 1`,
        [alici_kullanici_idleri[0], req.user.kullanici_id]
      );
      if (!dahaOnceRows[0]) {
        return res.status(403).json({
          hata_kodu: "YETKI_YOK",
          mesaj: "Yeni bir konuşma başlatamazsınız — yalnızca size mesaj göndermiş birine yanıt verebilirsiniz.",
        });
      }
    }

    // Alıcıların gerçekten mesaj gönderenin izinli kapsamında olduğunu doğrula
    // (Platform Admin hariç: yalnızca kendi holdingindeki kullanıcılara gönderilebilir)
    const params = [alici_kullanici_idleri];
    let kapsamKosulu = "";
    if (!platformAdminMi(req)) {
      params.push(req.user.isletme_id);
      kapsamKosulu = ` AND isletme_id = $${params.length}`;
    }
    const { rows: gecerliAlicilar } = await req.db.query(
      `SELECT kullanici_id FROM kullanici WHERE kullanici_id = ANY($1::uuid[]) AND aktif_mi = TRUE ${kapsamKosulu}`,
      params
    );
    const gecerliIdSeti = new Set(gecerliAlicilar.map((r) => r.kullanici_id));
    const geçersizler = alici_kullanici_idleri.filter((id) => !gecerliIdSeti.has(id));
    if (geçersizler.length > 0) {
      return res.status(403).json({
        hata_kodu: "YETKI_YOK",
        mesaj: "Belirtilen alıcılardan bazıları kapsamınız dışında (farklı bir holdingde ya da pasif).",
      });
    }

    await req.db.query("BEGIN");
    const olusanlar = [];
    for (const aliciId of alici_kullanici_idleri) {
      const { rows } = await req.db.query(
        `INSERT INTO mesaj (gonderen_kullanici_id, alici_kullanici_id, icerik)
         VALUES ($1, $2, $3)
         RETURNING mesaj_id`,
        [req.user.kullanici_id, aliciId, icerik.trim()]
      );
      olusanlar.push(rows[0].mesaj_id);
    }
    await req.db.query("COMMIT");

    res.status(201).json({
      mesaj: `${olusanlar.length} kişiye mesaj gönderildi.`,
      mesaj_idleri: olusanlar,
    });
  } catch (err) {
    await req.db.query("ROLLBACK");
    next(err);
  }
});

// POST /api/v1/mesajlar/:mesaj_id/okundu-isaretle — yalnızca mesajın ALICISI
// tarafından çağrılabilir; gönderenin "giden kutusu"ndaki o mesajın altındaki
// çizgiyi kırmızıdan yeşile döndürür.
router.post("/:mesaj_id/okundu-isaretle", async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(
      `SELECT alici_kullanici_id, okundu_mu FROM mesaj WHERE mesaj_id = $1`,
      [req.params.mesaj_id]
    );
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "MESAJ_BULUNAMADI", mesaj: "Mesaj bulunamadı." });
    }
    if (mevcutRows[0].alici_kullanici_id !== req.user.kullanici_id) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu mesaj size ait değil." });
    }

    if (!mevcutRows[0].okundu_mu) {
      await req.db.query(
        `UPDATE mesaj SET okundu_mu = TRUE, okunma_tarihi = now() WHERE mesaj_id = $1`,
        [req.params.mesaj_id]
      );
    }
    res.json({ mesaj: "Okundu olarak işaretlendi." });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/mesajlar/:mesaj_id — yalnızca yönetici roller (Santral
// Sorumlusu/İşletme Admin/Platform Admin) silebilir, ve yalnızca kendi
// gönderdiği ya da kendisine gelen bir mesajı. Diğer roller hiçbir mesajı
// silemez (gelen mesajlar dahil).
router.delete("/:mesaj_id", requireRole(...MESAJ_YONETICI_ROLLERI), async (req, res, next) => {
  try {
    const { rows: mevcutRows } = await req.db.query(
      `SELECT gonderen_kullanici_id, alici_kullanici_id FROM mesaj WHERE mesaj_id = $1`,
      [req.params.mesaj_id]
    );
    if (!mevcutRows[0]) {
      return res.status(404).json({ hata_kodu: "MESAJ_BULUNAMADI", mesaj: "Mesaj bulunamadı." });
    }
    const { gonderen_kullanici_id, alici_kullanici_id } = mevcutRows[0];
    if (req.user.kullanici_id !== gonderen_kullanici_id && req.user.kullanici_id !== alici_kullanici_id) {
      return res.status(403).json({ hata_kodu: "YETKI_YOK", mesaj: "Bu mesaj size ait değil." });
    }

    await req.db.query(`DELETE FROM mesaj WHERE mesaj_id = $1`, [req.params.mesaj_id]);
    res.json({ mesaj: "Mesaj silindi." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
