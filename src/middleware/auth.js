const jwt = require("jsonwebtoken");

/**
 * Authorization: Bearer <token> başlığını doğrular ve
 * req.user = { kullanici_id, rol, isletme_id } atar.
 * isletme_id, Platform Admin (rol = 'ADMIN') için null olabilir.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      hata_kodu: "TOKEN_EKSIK",
      mesaj: "Authorization başlığında Bearer token bulunamadı.",
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      kullanici_id: payload.kullanici_id,
      rol: payload.rol,
      isletme_id: payload.isletme_id,
    };
    next();
  } catch (err) {
    return res.status(401).json({
      hata_kodu: "TOKEN_GECERSIZ",
      mesaj: "Token geçersiz veya süresi dolmuş.",
    });
  }
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
