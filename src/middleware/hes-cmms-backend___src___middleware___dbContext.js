const { pool } = require("../db");

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
  const client = await pool.connect();
  try {
    if (req.user && req.user.kullanici_id) {
      // set_config(..., false) => sadece bu bağlantı/işlem ömrü boyunca geçerli
      await client.query("SELECT set_config('app.current_user_id', $1, false)", [
        req.user.kullanici_id,
      ]);
    }
    req.db = client;

    // İstek tamamlandığında bağlantıyı havuza iade et (yalnızca bir kez)
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        client.release();
      }
    };
    res.on("finish", releaseOnce);
    res.on("close", releaseOnce);

    next();
  } catch (err) {
    client.release();
    next(err);
  }
}

module.exports = { withDbContext };
