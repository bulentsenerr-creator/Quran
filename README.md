# Kur’ân Okuma • Elmalılı (PWA)

## Özellikler
- Ayet görünümü + Sayfa görünümü (Açık Kuran API)
- Arama (Arapça + Türkçe)
- Yer imi + Not (IndexedDB)
- PWA (offline uygulama kabuğu)
- **Sesli okuma**:
  - Ayet mp3: EveryAyah (ayet ayet, otomatik sonraki + okla takip)
  - Sure mp3: Açık Kuran sure mp3
- **Kaldığın yeri otomatik hatırlama**
- **Arapça + meal aynı satır** (Ayarlar → “yan yana”)
- **Tecvid renklendirme** (opsiyonel veri ile)

## Çalıştırma
> Service Worker ve fetch için HTTP sunucu gerekir.

```bash
cd quran-elmalili-pwa
python -m http.server 5500
```
Tarayıcı: http://localhost:5500

## Tecvid Renklendirme (Opsiyonel)
Bu iki dosyayı `data/` klasörüne eklerseniz “Tecvid renklendirme” açılabilir:
- `quran-uthmani.txt`
- `tajweed.hafs.uthmani-pause-sajdah.json`

Not: Bu paket bu dosyaları içermez.


## Ses İyileştirmeleri
- Kâri arama (type-to-search)
- Favori kâriler (üstte)
- Hız kontrolü (0.75×–1.5×)
- Ayet tekrar (1×–10×)
- Ses çalamazsa otomatik yedek kâri (fallback)
