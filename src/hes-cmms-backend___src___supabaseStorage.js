const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// SUPABASE_SERVICE_ROLE_KEY yalnızca backend'de (Render ortam değişkeni
// olarak) tutulmalı — bu anahtar Storage'daki her şeye tam erişim verir,
// asla frontend koduna veya tarayıcıya gönderilmemeli.
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "bakim-medya";

/**
 * "data:image/png;base64,...." formatındaki bir data URL'i Supabase
 * Storage'a yükler, herkese açık (public) URL'ini döner.
 *
 * Supabase Storage yapılandırılmamışsa (ortam değişkenleri eksikse),
 * hiçbir şey yapmadan orijinal değeri aynen geri döner — böylece bu
 * özellik henüz kurulmamış bir ortamda sistem çökmez, sadece eski
 * (base64 veritabanına gömülü) davranışa geri düşer.
 */
async function dataUrlYukle(dataUrl, klasor) {
  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return dataUrl; // zaten bir URL ya da boş — dokunma
  }
  if (!supabase) {
    return dataUrl; // Storage yapılandırılmamış — eskisi gibi base64 olarak sakla
  }

  const eslesme = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!eslesme) return dataUrl;

  const [, mimeTipi, base64Veri] = eslesme;
  const uzanti = mimeTipi.split("/")[1] || "png";
  const dosyaAdi = `${klasor}/${Date.now()}-${crypto.randomUUID()}.${uzanti}`;
  const buffer = Buffer.from(base64Veri, "base64");

  const { error } = await supabase.storage.from(BUCKET).upload(dosyaAdi, buffer, {
    contentType: mimeTipi,
    upsert: false,
  });

  if (error) {
    console.error("Supabase Storage yükleme hatası:", error.message);
    return dataUrl; // yükleme başarısız olursa base64'ü kaybetmemek için aynen sakla
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(dosyaAdi);
  return data.publicUrl;
}

module.exports = { dataUrlYukle };
