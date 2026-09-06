require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const santralRoutes = require("./routes/santraller");
const gorevRoutes = require("./routes/gorevler");
const ekipmanRoutes = require("./routes/ekipmanlar");
const bakimPlanRoutes = require("./routes/bakimPlanlari");
const isletmeRoutes = require("./routes/isletmeler");
const bakimSablonRoutes = require("./routes/bakimSablonlari");
const kullaniciRoutes = require("./routes/kullanicilar");
const bildirimRoutes = require("./routes/bildirimler");
const raporRoutes = require("./routes/raporlar");
const mesajRoutes = require("./routes/mesajlar");
const girisLoglariRoutes = require("./routes/girisLoglari");

const app = express();

// Render, ters proxy arkasında çalıştığı için gerçek istemci IP'sini
// (X-Forwarded-For) görebilmemiz lazım — aksi halde rate limiting ve
// giriş logundaki IP kaydı yanlış/işe yaramaz olur.
app.set("trust proxy", 1);

app.use(helmet());

// CORS artık yalnızca FRONTEND_URLS ortam değişkeninde belirtilen
// alan adlarından gelen isteklere izin verir (virgülle ayrılmış birden
// fazla adres girilebilir, ör: "https://hes-cmms-frontend.vercel.app,
// https://barajbakim.com"). NOT: Bu değişken HENÜZ ayarlanmamışsa (boşsa),
// sistem güvenlik amacıyla kilitlenmek yerine ESKİ (herkese açık) davranışa
// döner — böylece bu değişkeni eklemeyi unutursanız site çalışmaya devam
// eder, aniden kilitlenmezsiniz. Kilidin gerçekten devreye girmesi için
// Render'da bu değişkeni ayarlamanız gerekir.
const izinliOrijinler = (process.env.FRONTEND_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // origin yoksa (Postman, sunucu-sunucu istek, mobil uygulama vb.)
      // ya da izinli listedeyse kabul et.
      if (!origin || izinliOrijinler.length === 0 || izinliOrijinler.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("CORS: Bu kaynağa izin verilmiyor."));
    },
  })
);
app.use(express.json());

// Genel hız sınırı — tüm API için (kaba kuvvet/otomatik tarama saldırılarını
// yavaşlatır). 15 dakikada IP başına 300 istek — normal kullanımı
// engellemeyecek kadar geniş, ama otomatik saldırıyı zorlaştırır.
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { hata_kodu: "COK_FAZLA_ISTEK", mesaj: "Çok fazla istek gönderildi, lütfen biraz sonra tekrar deneyin." },
  })
);

// Girişe özel SIKI hız sınırı — şifre tahmin (brute-force) saldırılarına
// karşı asıl kritik savunma. 15 dakikada IP başına yalnızca 10 deneme.
const girisSiniri = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // başarılı girişler sayaca dahil edilmez
  message: {
    hata_kodu: "COK_FAZLA_DENEME",
    mesaj: "Çok fazla başarısız giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.",
  },
});

// Basit sağlık kontrolü — deploy sonrası hızlı doğrulama için
app.get("/health", (req, res) => res.json({ durum: "ayakta" }));

app.use("/api/v1/auth/login", girisSiniri);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/santraller", santralRoutes);
app.use("/api/v1/gorevler", gorevRoutes);
app.use("/api/v1/isletmeler", isletmeRoutes);
app.use("/api/v1/bakim-sablonlari", bakimSablonRoutes);
app.use("/api/v1/raporlar", raporRoutes);
app.use("/api/v1/mesajlar", mesajRoutes);
app.use("/api/v1/giris-loglari", girisLoglariRoutes);
// Bunlar /santraller/:id/... ve /kullanicilar/:id, /isletmeler/:id/kullanicilar,
// /gorevler/:id/bildirimler gibi birden fazla kök yolu aynı router içinde
// tanımladığı için /api/v1 köküne bağlanır.
app.use("/api/v1", ekipmanRoutes);
app.use("/api/v1", bakimPlanRoutes);
app.use("/api/v1", kullaniciRoutes);
app.use("/api/v1", bildirimRoutes);

// 404 — tanımsız rota
app.use((req, res) => {
  res.status(404).json({ hata_kodu: "ROTA_BULUNAMADI", mesaj: "İstenen uç nokta bulunamadı." });
});

// Merkezi hata yakalayıcı — her route'taki next(err) buraya düşer
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    hata_kodu: "SUNUCU_HATASI",
    mesaj: "Beklenmeyen bir hata oluştu.",
  });
});

// Güvenlik ağı: beklenmedik/yakalanmamış bir hata tüm sunucuyu çökertip
// sistemin geri kalanını (görev tamamlama, giriş, vb.) etkilemesin diye —
// hatayı logla, süreci KAPATMA. Render'ın kendi otomatik yeniden başlatma
// mekanizmasına (gerçek bir çökme durumunda) güvenmeye devam ediyoruz,
// ama tek bir isteğin hatası artık herkesi etkilemeyecek.
process.on("uncaughtException", (err) => {
  console.error("Yakalanmamış hata (süreç devam ediyor):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Yakalanmamış promise reddi (süreç devam ediyor):", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HES CMMS API — http://localhost:${PORT} üzerinde çalışıyor`);
});
