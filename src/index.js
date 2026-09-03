require("dotenv").config();
const express = require("express");

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

const app = express();
app.use(express.json());

// Basit sağlık kontrolü — deploy sonrası hızlı doğrulama için
app.get("/health", (req, res) => res.json({ durum: "ayakta" }));

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/santraller", santralRoutes);
app.use("/api/v1/gorevler", gorevRoutes);
app.use("/api/v1/isletmeler", isletmeRoutes);
app.use("/api/v1/bakim-sablonlari", bakimSablonRoutes);
app.use("/api/v1/raporlar", raporRoutes);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HES CMMS API — http://localhost:${PORT} üzerinde çalışıyor`);
});
