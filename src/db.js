const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Havuzdan bağlantı alamayan (ya da yeni bağlantı kuramayan) istek,
  // SONSUZA KADAR beklemek yerine bu süre sonunda hata verir. Böylece
  // "Giriş yapılıyor…" ekranında sessizce donma yerine, Render
  // loglarında nedenini gösteren bir hata satırı oluşur.
  connectionTimeoutMillis: 20000,
});

pool.on("error", (err) => {
  console.error("Beklenmeyen veritabanı havuzu hatası:", err);
});

// Teşhis: havuzda bekleyen istek varsa (yani tüm bağlantılar meşgulse)
// durumu Render loglarına yazar. Bekleyen yoksa hiçbir şey yazmaz.
setInterval(() => {
  if (pool.waitingCount > 0) {
    console.error(
      `UYARI: bağlantı havuzu dolu — toplam:${pool.totalCount} boşta:${pool.idleCount} bekleyen:${pool.waitingCount}`
    );
  }
}, 10000).unref();

module.exports = { pool };
