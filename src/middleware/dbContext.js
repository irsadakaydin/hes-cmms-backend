const { pool } = require("../db");

// Bir bağlantı bu süreden uzun iade edilmezse Render loglarına, hangi
// isteğin tuttuğunu yazan bir uyarı düşer (havuz tükenmesi teşhisi için).
const UZUN_TUTMA_MS = 30000;

/**
 * Her istek için havuzdan AYRI bir bağlantı (client) alır ve
 * PostgreSQL oturum değişkeni app.current_user_id'yi set eder.
 * hes_cmms_schema.sql'deki Row-Level Security politikaları bu
 * değişkeni okuyarak sorguları otomatik olarak kullanıcının
 * işletmesi/santralleriyle sınırlar — bu satırı atlarsanız RLS
 * "current_setting bulunamadı" hatası verir.
 *
 * NOT: requireAuth middleware'inden SONRA çalıştırılmalıdır
 * (req.user'ın dolu olması gerekir).
 */
async function withDbContext(req, res, next) {
  let client;
  try {
    client = await pool.connect();
  } catch (baglantiHatasi) {
    // Bağlantı alınamadı (havuz dolu ya da veritabanına ulaşılamıyor).
    // Bu hata yakalanmazsa istek asılı kalır ve süreç çökebilir.
    console.error(
      "Veritabanı bağlantısı alınamadı:",
      req.method,
      req.originalUrl,
      "-",
      baglantiHatasi.message,
      `(toplam:${pool.totalCount} boşta:${pool.idleCount} bekleyen:${pool.waitingCount})`
    );
    return res.status(503).json({
      hata_kodu: "VERITABANI_MESGUL",
      mesaj: "Sunucu şu an yoğun, lütfen birkaç saniye sonra tekrar deneyin.",
    });
  }

  // İstek tamamlandığında bağlantıyı havuza iade et (yalnızca bir kez)
  let released = false;
  let uyariZamanlayici = null;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      if (uyariZamanlayici) clearTimeout(uyariZamanlayici);
      client.release();
    }
  };

  try {
    if (req.user && req.user.kullanici_id) {
      // set_config(..., false) => sadece bu bağlantı/işlem ömrü boyunca geçerli
      await client.query("SELECT set_config('app.current_user_id', $1, false)", [
        req.user.kullanici_id,
      ]);
    }
    req.db = client;

    uyariZamanlayici = setTimeout(() => {
      console.error(
        `UYARI: veritabanı bağlantısı ${UZUN_TUTMA_MS / 1000} sn'dir iade edilmedi:`,
        req.method,
        req.originalUrl
      );
    }, UZUN_TUTMA_MS);

    res.on("finish", releaseOnce);
    res.on("close", releaseOnce);

    next();
  } catch (err) {
    releaseOnce();
    next(err);
  }
}

module.exports = { withDbContext };
