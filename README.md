# HES CMMS — Backend Başlangıç İskeleti

Bu, `hes_cmms_api_endpoints.md` dosyasında tanımlanan API'nin **bir alt kümesini**
gerçekten çalışır şekilde uygulayan bir başlangıç noktasıdır. Amaç sıfırdan
başlamak yerine, üzerine inşa edebileceğiniz sağlam bir iskelet sunmak.

## İçindeki uç noktalar

Artık `hes_cmms_api_endpoints.md`'deki **tüm uç noktalar** gerçek kodla uygulanmış durumda (32 endpoint).

| Modül | Yöntem | Yol |
|---|---|---|
| **Auth** | POST | `/api/v1/auth/login` |
| | GET | `/api/v1/auth/ben` |
| **İşletme** | GET | `/api/v1/isletmeler` (Platform Admin) |
| | GET | `/api/v1/isletmeler/:isletme_id` |
| | POST | `/api/v1/isletmeler` |
| | PATCH | `/api/v1/isletmeler/:isletme_id` |
| | POST | `/api/v1/isletmeler/:isletme_id/pasiflestir` |
| **Santral** | GET | `/api/v1/santraller` |
| | GET | `/api/v1/santraller/:santral_id` |
| **Ekipman** | GET/POST | `/api/v1/santraller/:santral_id/ekipmanlar` |
| | GET/PATCH/DELETE | `/api/v1/ekipmanlar/:ekipman_id` |
| **Bakım Şablonu** | GET/POST | `/api/v1/bakim-sablonlari` |
| | GET/PATCH | `/api/v1/bakim-sablonlari/:sablon_id` |
| | POST | `/api/v1/bakim-sablonlari/:sablon_id/kopyala` |
| **Bakım Planı** | GET/POST | `/api/v1/santraller/:santral_id/bakim-planlari` |
| | GET/PATCH | `/api/v1/bakim-planlari/:plan_id` |
| | POST | `/api/v1/bakim-planlari/:plan_id/durdur` |
| **Bakım Görevi** | GET | `/api/v1/gorevler/bana-atanan` |
| | GET | `/api/v1/gorevler/:gorev_id` |
| | POST | `/api/v1/gorevler/:gorev_id/kaydi-tamamla` |
| **Kullanıcı** | GET/POST | `/api/v1/isletmeler/:isletme_id/kullanicilar` |
| | GET/PATCH | `/api/v1/kullanicilar/:kullanici_id` |
| | POST/DELETE | `/api/v1/kullanicilar/:kullanici_id/santral-erisimi` |
| | POST | `/api/v1/kullanicilar/:kullanici_id/engelle` \| `/engeli-kaldir` |
| **Bildirim** | GET | `/api/v1/bildirimler/bana-gelen` |
| | GET | `/api/v1/gorevler/:gorev_id/bildirimler` |
| **Raporlama** | GET | `/api/v1/raporlar/santral/:santral_id/ozet` |
| | GET | `/api/v1/raporlar/santral/:santral_id/gecikmis-gorevler` |
| | GET | `/api/v1/raporlar/ekipman/:ekipman_id/gecmis` |
| | GET | `/api/v1/raporlar/isletme/:isletme_id/portfoy-ozeti` |
| | GET | `/api/v1/raporlar/platform-ozeti` (Platform Admin) |
| | GET | `/api/v1/raporlar/santral/:santral_id/pdf` \| `/excel` *(bkz. not aşağıda)* |

**PDF/Excel rapor uç noktaları** şu an `501 Not Implemented` döner — gerçek dosya üretimi bu iskelette yok. `/raporlar/santral/:id/ozet` aynı veriyi JSON olarak zaten döndürüyor; dosya üretimi eklemek isterseniz `pdfkit` (PDF) veya `exceljs` (Excel) paketleriyle `src/routes/raporlar.js`'deki ilgili handler genişletilmeli.

## Mimari notu — RLS nasıl devreye giriyor

`src/middleware/dbContext.js`, her istekte havuzdan ayrı bir bağlantı alıp
`app.current_user_id` PostgreSQL oturum değişkenini set ediyor. Bu sayede
`hes_cmms_schema.sql`'deki Row-Level Security politikaları devreye giriyor ve
route kodunun kendisi santral/işletme filtrelemesini elle yazmak zorunda
kalmıyor (yine de `santraller.js`/`gorevler.js` içinde `v_kullanici_yetkili_santraller`
görünümü üzerinden ek bir uygulama-katmanı kontrolü de var — savunma derinliği).

## Kurulum

```bash
npm install
cp .env.example .env
# .env içindeki DATABASE_URL'i kendi Supabase/PostgreSQL bağlantınızla değiştirin
# JWT_SECRET'ı rastgele, uzun bir değerle değiştirin
npm start
```

Sunucu `http://localhost:3000` üzerinde ayağa kalkar; `GET /health` ile hızlıca
test edebilirsiniz.

## Test kullanıcısı oluşturma

`hes_cmms_seed_data.sql` içindeki kullanıcıların `sifre_hash` alanları
**gerçek bir bcrypt hash'i değil**, yer tutucudur — bu haliyle giriş yapamazsınız.
Gerçek bir test şifresi üretmek için:

```bash
node -e "console.log(require('bcryptjs').hashSync('test1234', 10))"
```

Çıkan hash'i, örneğin İrşad'ın kaydında güncelleyin:

```sql
UPDATE kullanici
SET sifre_hash = '<yukarıda üretilen hash>'
WHERE eposta = 'irsad.akaydin@aydem.com.tr';
```

## Uçtan uca test (curl)

```bash
# 1) Giriş yap
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"eposta":"irsad.akaydin@aydem.com.tr","sifre":"test1234"}'
# → { "access_token": "...", "kullanici": {...} }

# 2) Token'ı kullanarak profil + erişimli santralleri gör
curl http://localhost:3000/api/v1/auth/ben \
  -H "Authorization: Bearer <access_token>"

# 3) Santralleri listele
curl http://localhost:3000/api/v1/santraller \
  -H "Authorization: Bearer <access_token>"
```

Saha personeli (örn. Ayşe Kara) ile giriş yapıp `/api/v1/gorevler/bana-atanan`
uç noktasını çağırırsanız, `hes_cmms_seed_data.sql`'de ona atanmış görevleri
görürsünüz.

## Sırada ne var

1. PDF/Excel rapor üretimini gerçekten uygulayın (`pdfkit` / `exceljs`).
2. `hes_cmms_scheduler.js`'i bu backend'in yanında ayrı bir süreç/cron olarak
   çalıştırın (aynı `DATABASE_URL`'i kullanır).
3. Girdi doğrulama için `zod` veya `joi` gibi bir kütüphane ekleyin — şu an
   yalnızca temel `if` kontrolleri var.
4. Refresh token, şifre sıfırlama, davet e-postası gönderimi gibi eksik auth
   akışlarını tamamlayın (şu an yeni kullanıcı/işletme oluşturma uç noktaları
   geçici bir rastgele şifre üretiyor ama e-posta göndermiyor).
5. Bir frontend (Next.js) ile bu API'yi tüketin.
6. Üretime almadan önce backend'i bir sunucuya (Railway/Render/VPS) dağıtın.
