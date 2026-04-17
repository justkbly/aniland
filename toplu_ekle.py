"""
Toplu Anime Ekleyici
====================
anime scrape/anime_links.txt içindeki her URL için a.py'yi çalıştırır.

Kullanım:
  1. node server.js  (ayrı terminalde çalışıyor olmalı)
  2. python toplu_ekle.py
"""

import subprocess
import sys
import os
import time

LINKS_FILE = os.path.join(os.path.dirname(__file__), "anime scrape", "anime_links.txt")
SCRIPT     = os.path.join(os.path.dirname(__file__), "a.py")

def main():
    if not os.path.exists(LINKS_FILE):
        print(f"[!] Bulunamadı: {LINKS_FILE}")
        sys.exit(1)

    with open(LINKS_FILE, encoding="utf-8") as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith("#")]

    print(f"Toplam {len(urls)} anime işlenecek.\n")

    basarili = 0
    for i, url in enumerate(urls, 1):
        print(f"\n{'='*60}")
        print(f"[{i}/{len(urls)}] {url}")
        print('='*60)
        result = subprocess.run([sys.executable, SCRIPT, url])
        if result.returncode != 0:
            print(f"[!] Hata (returncode={result.returncode}), listede bırakıldı.")
        else:
            basarili += 1
            # Sadece başarılıysa listeden sil
            with open(LINKS_FILE, encoding="utf-8") as f:
                kalan = [line for line in f.readlines() if line.strip() != url]
            with open(LINKS_FILE, "w", encoding="utf-8") as f:
                f.writelines(kalan)
            print(f"[✓] {url} listeden silindi. Kalan: {len(urls) - i}")

        time.sleep(2)  # sunucuyu bunaltmamak için kısa bekleme

    print(f"\n✅ Tamamlandı! {basarili}/{len(urls)} anime başarıyla işlendi.")

if __name__ == "__main__":
    main()