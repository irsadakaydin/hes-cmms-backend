import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { istekAt, tokenAl, yoneticiMi, dosyaIndir } from "../lib/api";
import UstBar from "../components/UstBar";

const PERIYOT_ETIKETLERI = {
  GUNLUK: "Günlük",
  HAFTALIK: "Haftalık",
  AYLIK: "Aylık",
  UC_AYLIK: "3 Ayda Bir",
  ALTI_AYLIK: "6 Ayda Bir",
  YILLIK: "Yıllık",
};

const DONEM_ETIKETLERI = {
  TUM_ZAMANLAR: "Tüm Zamanlar",
  GUNLUK: "Bugün",
  HAFTALIK: "Son 7 Gün",
  AYLIK: "Bu Ay",
  YILLIK: "Bu Yıl",
  OZEL: "Özel Tarih Aralığı…",
};

function donemTarihAraligi(donem) {
  const bugun = new Date();
  const gunFormatla = (d) => d.toISOString().slice(0, 10);
  const bitis = gunFormatla(bugun);

  switch (donem) {
    case "GUNLUK":
      return { baslangic: bitis, bitis };
    case "HAFTALIK": {
      const d = new Date(bugun);
      d.setDate(d.getDate() - 6);
      return { baslangic: gunFormatla(d), bitis };
    }
    case "AYLIK": {
      const d = new Date(bugun.getFullYear(), bugun.getMonth(), 1);
      return { baslangic: gunFormatla(d), bitis };
    }
    case "YILLIK": {
      const d = new Date(bugun.getFullYear(), 0, 1);
      return { baslangic: gunFormatla(d), bitis };
    }
    default:
      return {};
  }
}

export default function RaporOlusturSayfasi() {
  const router = useRouter();
  const [santraller, setSantraller] = useState(null);
  const [personel, setPersonel] = useState(null);
  const [hata, setHata] = useState(null);
  const [indiriliyor, setIndiriliyor] = useState(false);

  // Kutulardan hiçbiri seçilmezse ("") o filtre hiç uygulanmaz — hepsi dahil olur.
  const [santralId, setSantralId] = useState("");
  const [periyot, setPeriyot] = useState("");
  const [sorumluId, setSorumluId] = useState("");
  const [donem, setDonem] = useState("TUM_ZAMANLAR");
  const [ozelBaslangic, setOzelBaslangic] = useState("");
  const [ozelBitis, setOzelBitis] = useState("");

  useEffect(() => {
    if (!tokenAl()) {
      router.replace("/");
      return;
    }
    if (!yoneticiMi()) {
      router.replace("/gorevler");
      return;
    }
    istekAt("/api/v1/raporlar/filtre-secenekleri")
      .then((veri) => {
        setSantraller(veri.santraller);
        setPersonel(veri.personel);
      })
      .catch((err) => setHata(err.message));
  }, [router]);

  async function raporOlustur(format) {
    setHata(null);
    if (donem === "OZEL" && (!ozelBaslangic || !ozelBitis)) {
      setHata("Özel tarih aralığı için başlangıç ve bitiş tarihini seçmelisiniz.");
      return;
    }
    setIndiriliyor(true);
    try {
      const { baslangic, bitis } =
        donem === "OZEL" ? { baslangic: ozelBaslangic, bitis: ozelBitis } : donemTarihAraligi(donem);
      const parametreler = new URLSearchParams();
      if (santralId) parametreler.set("santral_id", santralId);
      if (periyot) parametreler.set("periyot", periyot);
      if (sorumluId) parametreler.set("sorumlu_kullanici_id", sorumluId);
      if (baslangic) parametreler.set("baslangic", baslangic);
      if (bitis) parametreler.set("bitis", bitis);
      const sorguMetni = parametreler.toString() ? `?${parametreler.toString()}` : "";

      const uzanti = format === "pdf" ? "pdf" : "xlsx";

      const santralAdi = santralId
        ? santraller.find((s) => s.santral_id === santralId)?.ad || "Santral"
        : "Tüm Santraller";
      const periyotAdi = periyot ? PERIYOT_ETIKETLERI[periyot] || periyot : "Tüm Periyotlar";
      const dosyaAdi = `${santralAdi} (${periyotAdi}) Bakım Raporu.${uzanti}`;

      await dosyaIndir(`/api/v1/raporlar/${format}${sorguMetni}`, dosyaAdi);
    } catch (err) {
      setHata(err.message);
    } finally {
      setIndiriliyor(false);
    }
  }

  return (
    <>
      <Head>
        <title>Rapor Oluştur — HES CMMS</title>
      </Head>
      <div className="sayfa">
        <UstBar />
        <div className="icerik">
          <div className="bolumBaslik">
            <h2>Rapor Oluştur</h2>
          </div>

          {hata && <div className="hataKutusu">{hata}</div>}
          {!santraller && !hata && <div className="yukleniyor">Yükleniyor…</div>}

          {santraller && (
            <div className="yonetimFormu">
              <div className="alan">
                <label>Santral</label>
                <select value={santralId} onChange={(e) => setSantralId(e.target.value)}>
                  <option value="">Tüm Santraller</option>
                  {santraller.map((s) => (
                    <option key={s.santral_id} value={s.santral_id}>
                      {s.ad} {s.isletme_adi ? `(${s.isletme_adi})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="alan">
                <label>Bakım Periyodu</label>
                <select value={periyot} onChange={(e) => setPeriyot(e.target.value)}>
                  <option value="">Tüm Periyotlar</option>
                  {Object.entries(PERIYOT_ETIKETLERI).map(([deger, etiket]) => (
                    <option key={deger} value={deger}>
                      {etiket}
                    </option>
                  ))}
                </select>
              </div>

              <div className="alan">
                <label>Bakım Sorumlusu</label>
                <select value={sorumluId} onChange={(e) => setSorumluId(e.target.value)}>
                  <option value="">Tüm Personel</option>
                  {personel &&
                    personel.map((p) => (
                      <option key={p.kullanici_id} value={p.kullanici_id}>
                        {p.ad_soyad}
                      </option>
                    ))}
                </select>
              </div>

              <div className="alan">
                <label>Rapor Aralığı</label>
                <select value={donem} onChange={(e) => setDonem(e.target.value)}>
                  {Object.entries(DONEM_ETIKETLERI).map(([deger, etiket]) => (
                    <option key={deger} value={deger}>
                      {etiket}
                    </option>
                  ))}
                </select>
              </div>

              {donem === "OZEL" && (
                <div style={{ display: "flex", gap: "12px" }}>
                  <div className="alan" style={{ flex: 1 }}>
                    <label>Başlangıç tarihi</label>
                    <input
                      type="date"
                      value={ozelBaslangic}
                      onChange={(e) => setOzelBaslangic(e.target.value)}
                    />
                  </div>
                  <div className="alan" style={{ flex: 1 }}>
                    <label>Bitiş tarihi</label>
                    <input type="date" value={ozelBitis} onChange={(e) => setOzelBitis(e.target.value)} />
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                <button className="birincilButon" onClick={() => raporOlustur("pdf")} disabled={indiriliyor}>
                  {indiriliyor ? "Hazırlanıyor…" : "PDF Rapor Oluştur"}
                </button>
                <button className="birincilButon" onClick={() => raporOlustur("excel")} disabled={indiriliyor}>
                  {indiriliyor ? "Hazırlanıyor…" : "Excel Rapor Oluştur"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
