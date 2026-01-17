# Kur’ân Okuma • Elmalılı (PWA)

## Özellikler (tam paket — kırpma yok)
- Ayet + Sayfa görünümü
- Arama (Arapça + Türkçe)
- Arapça + meal aynı anda, **yan yana satır düzeni** (Ayarlar)
- Yer imi + Not
- Offline indirme (metin/meal cache)
- Sesli okuma:
  - Ayet (EveryAyah): otomatik sonraki + okla takip
  - Sure (AçıkKuran)
- Ses iyileştirmeleri:
  - Kâri arama
  - Favori kâriler
  - Hız kontrolü
  - Ayet tekrar
  - Fallback: ses çalmazsa otomatik yedek zinciri
  - Fallback sırasını Ayarlar’dan yönetme
- **PWA kurulumu için “📲 Yükle” butonu** (uygunsa görünür)
- **Ses Offline (🎧⬇)**
  - İndirilecek ses kârisini seç
  - Seçili sure ayet mp3’lerini indirip Cache Storage’a kaydet
  - İndirmeyi iptal et
  - Ses önbelleğini temizle
  - Önbellek dosya sayısı + MB tahmini raporu
- Tecvid renklendirme (opsiyonel veri ile)

## Çalıştırma
```bash
cd quran-elmalili-pwa
python -m http.server 5500
```

## Notlar
- Ses önbellek MB değeri **tahmini**dir (CORS nedeniyle gerçek byte ölçümü her tarayıcıda mümkün olmayabilir).
