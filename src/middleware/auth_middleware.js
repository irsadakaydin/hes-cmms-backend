const jwt = require("jsonwebtoken");
const { pool } = require("../db");

/**
 * Authorization: Bearer <token> başlığını doğrular ve
 * req.user = { kullanici_id, rol, isletme_id, jti } atar.
 * isletme_id, Platform Admin (rol = 'ADMIN') için null olabilir.
 *
 * TEK CİHAZDAN OTURUM KURALI: token geçerli olsa bile, taşıdığı jti
 * (oturum kimliği) artık "oturum" tablosunda yoksa (başka bir cihazdan
 * giriş yapılıp bu oturum sonlandırılmışsa) istek reddedilir —
 * OTURUM_SONLANDIRILDI. Frontend bunu TOKEN_GECERSIZ ile aynı şekilde
 * ele alıp kullanıcıyı giriş sayfasına yönlendirir.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      hata_kodu: "TOKEN_EKSIK",
      mesaj: "Authorization başlığında Bearer token bulunamadı.",
    });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      hata_kodu: "TOKEN_GECERSIZ",
      mesaj: "Token geçersiz veya süresi dolmuş.",
    });
  }

  // jti taşımayan eski token'lar (bu özellik eklenmeden önce verilmiş)
  // için geriye dönük uyumluluk: oturum kontrolü atlanır, token kendi
  // süresi (8 saat) dolana kadar normal çalışmaya devam eder.
  if (payload.jti) {
    try {
      const { rows } = await pool.query(`SELECT 1 FROM oturum WHERE jti = $1`, [payload.jti]);
      if (rows.length === 0) {
        return res.status(401).json({
          hata_kodu: "OTURUM_SONLANDIRILDI",
          mesaj: "Bu oturum başka bir cihazdan yapılan girişle sonlandırıldı.",
        });
      }
    } catch (err) {
      return next(err);
    }
  }

  req.user = {
    kullanici_id: payload.kullanici_id,
    rol: payload.rol,
    isletme_id: payload.isletme_id,
    jti: payload.jti,
  };
  next();
}

/**
 * Belirli rollerle sınırlayan yardımcı middleware üretici.
 * Kullanım: requireRole('ISLETME_ADMIN', 'ADMIN')
 */
function requireRole(...izinliRoller) {
  return (req, res, next) => {
    if (!req.user || !izinliRoller.includes(req.user.rol)) {
      return res.status(403).json({
        hata_kodu: "YETKI_YOK",
        mesaj: "Bu işlem için yetkiniz yok.",
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
