"""
Animecix.tv Video Link Bulucu v8
==============================
- Tau-video embed → ham MP4 dönüşümü (urllib direkt, Playwright fallback)
- Tüm kalite seçenekleri (480p/720p/1080p) tek seferde alınır
- epSubs için ikinci kez API çağrısı yapılmaz
- Movie ve bölümlü animeleri destekler

Kurulum:
  pip install selenium webdriver-manager playwright
  python -m playwright install chromium

Çalıştırma:
  python a.py
  python a.py https://animecix.tv/titles/...
  python a.py https://animecix.tv/titles/... --quality 720p
"""

import time
import re
import sys
import json
import threading
import urllib.request
import urllib.error

try:
    from playwright.sync_api import sync_playwright
    _PLAYWRIGHT_OK = True
except ImportError:
    _PLAYWRIGHT_OK = False

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from webdriver_manager.chrome import ChromeDriverManager
except ImportError:
    print("pip install selenium webdriver-manager")
    sys.exit(1)

_print_lock = threading.Lock()
def tprint(*args, **kwargs):
    with _print_lock:
        print(*args, flush=True, **kwargs)

BASE             = "https://animecix.tv"
QUALITY_PRIORITY = ["1080p", "720p", "480p"]
SERVER_URL       = os.environ.get("SERVER_URL", "http://localhost:3030")

IFRAME_HOSTS = [
    'tau-video', 'filemoon', 'streamtape', 'sibnet',
    'vidmoly', 'dood', 'voe.sx', 'upstream',
]

# ══════════════════════════════════════════════════════════════════════════════
# TAU-VIDEO → HAM MP4
# ══════════════════════════════════════════════════════════════════════════════

def is_tau_embed(url):
    return 'tau-video.xyz/embed/' in url

def tau_extract_id(embed_url):
    m   = re.search(r'/embed/([a-f0-9]{24})', embed_url)
    vid = re.search(r'[?&]vid=(\d+)', embed_url)
    return (m.group(1) if m else None), (vid.group(1) if vid else None)

def tau_api_direct(tau_id, vid, timeout=12):
    """Direkt urllib ile tau API — tarayıcı gerektirmez."""
    url = f"https://tau-video.xyz/api/video/{tau_id}"
    if vid:
        url += f"?vid={vid}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://animecix.tv/",
        "Origin":  "https://animecix.tv",
    })
    wait = 3.0  # başlangıç bekleme süresi (exponential backoff)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                tprint(f"      [tau] 429 rate limit, {wait:.1f}s bekleniyor... (deneme {attempt+1}/4)")
                time.sleep(wait)
                wait *= 2  # exponential backoff: 3 → 6 → 12 → 24
                continue
            tprint(f"      [tau] HTTP {e.code}: {e.reason}")
            return None
        except Exception as e:
            tprint(f"      [tau] hata: {e}")
            return None
    return None

def tau_api_playwright(embed_url, timeout=25):
    """Playwright fallback — direkt API başarısız olursa."""
    if not _PLAYWRIGHT_OK:
        return None
    result = {"data": None}
    def on_response(res):
        if "/api/video/" in res.url and result["data"] is None:
            try:
                result["data"] = res.json()
            except Exception:
                pass
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                extra_http_headers={"Referer": "https://animecix.tv/", "Origin": "https://animecix.tv"}
            )
            page = ctx.new_page()
            page.on("response", on_response)
            try:
                page.goto(embed_url, timeout=timeout * 1000)
            except Exception:
                pass
            for _ in range(20):
                if result["data"]:
                    break
                time.sleep(0.5)
            browser.close()
    except Exception as e:
        tprint(f"      [!] Playwright: {e}")
    return result["data"]

def tau_to_mp4(embed_url, preferred_quality=None, use_playwright=True):
    """
    Tau embed URL → ham MP4.
    Döner: {"url", "label", "size", "duration", "thumbnails", "all_qualities"} | None
    """
    tau_id, vid = tau_extract_id(embed_url)
    if not tau_id:
        return None

    tprint(f"      [tau] {tau_id} sorgulanıyor...")
    time.sleep(0.5)  # istekler arası kısa bekleme (rate limit önlemi)

    data = tau_api_direct(tau_id, vid)
    if not data or not data.get("urls"):
        if use_playwright:
            tprint(f"      [tau] direkt başarısız, Playwright deneniyor...")
            data = tau_api_playwright(embed_url)
        else:
            tprint(f"      [tau] direkt başarısız, atlanıyor.")

    if not data or not data.get("urls"):
        tprint(f"      [tau] API yanıt vermedi.")
        return None

    urls_list = data["urls"]
    quality_map = {u["label"]: u for u in urls_list}

    chosen = None
    if preferred_quality and preferred_quality in quality_map:
        chosen = quality_map[preferred_quality]
    else:
        for q in QUALITY_PRIORITY:
            if q in quality_map:
                chosen = quality_map[q]
                break
    if not chosen:
        chosen = urls_list[0]

    size_mb = chosen.get("size", 0) // 1024 // 1024
    tprint(f"      [tau] ✓ {chosen['label']} ({size_mb} MB)")

    return {
        "url":          chosen["url"],
        "label":        chosen["label"],
        "size":         chosen.get("size", 0),
        "duration":     data.get("duration"),
        "thumbnails":   data.get("thumbnails", {}),
        "subs":         data.get("subs", []),
        "all_qualities": [
            {"label": u["label"], "url": u["url"], "size": u.get("size", 0)}
            for u in urls_list
        ],
    }

# ══════════════════════════════════════════════════════════════════════════════
# ANİMECİX SCRAPING
# ══════════════════════════════════════════════════════════════════════════════

def create_driver(headless=True):
    options = Options()
    if headless:
        options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    return driver

def get_translator_links(driver):
    """Sayfadaki çeviri butonlarına tıklar, embed URL'leri toplar."""
    results = {}
    btns = driver.find_elements(By.CSS_SELECTOR, "button.translator-item")
    if not btns:
        tprint("      [-] Çeviri butonu yok")
        return results

    tprint(f"      {len(btns)} çeviri bulundu")
    for btn in btns:
        try:
            try:
                name = btn.find_element(By.CSS_SELECTOR, ".translator-name").text.strip() or "Bilinmiyor"
            except Exception:
                name = "Bilinmiyor"

            results[name] = []
            driver.execute_script("arguments[0].click();", btn)
            driver.execute_script("window.scrollTo(0, 500);")

            def _has_iframe(d):
                return d.execute_script("""
                    var all = document.querySelectorAll('iframe');
                    for (var i=0; i<all.length; i++) {
                        var s = all[i].src || '';
                        if (s && s.indexOf('animecix') === -1) return s;
                    }
                    return null;
                """)

            try:
                WebDriverWait(driver, 8).until(_has_iframe)
            except Exception:
                pass

            # Reklam atla
            if not _has_iframe(driver):
                driver.execute_script("""
                    document.querySelectorAll('video').forEach(function(v) {
                        try { v.pause();
                            if (v.duration && isFinite(v.duration)) v.currentTime = v.duration;
                            v.dispatchEvent(new Event('ended', {bubbles: true}));
                        } catch(e) {}
                    });
                """)
                try:
                    WebDriverWait(driver, 8).until(_has_iframe)
                except Exception:
                    pass

            srcs = driver.execute_script("""
                var res = [];
                document.querySelectorAll('iframe').forEach(function(f) {
                    var s = f.src || '';
                    if (s && s.indexOf('animecix') === -1 && res.indexOf(s) === -1) res.push(s);
                });
                return res;
            """) or []

            for src in srcs:
                results[name].append(src)
                tprint(f"        [embed] {src[:80]}")

            if not results[name]:
                tprint(f"        [-] {name}: bulunamadı")

        except Exception as e:
            tprint(f"      [!] {e}")

    return results

def collect_season_links(driver, title_id):
    seen, links = set(), []
    for a in driver.find_elements(By.TAG_NAME, "a"):
        href = a.get_attribute("href") or ""
        if f"/titles/{title_id}/" in href and "/season/" in href and "/episode/" not in href:
            if href not in seen:
                seen.add(href); links.append(href)
    links.sort(key=lambda u: int(re.search(r'/season/(\d+)', u).group(1))
               if re.search(r'/season/(\d+)', u) else 0)
    return links

def collect_episode_links(driver, title_id):
    seen, eps = set(), []
    for a in driver.find_elements(By.TAG_NAME, "a"):
        href = a.get_attribute("href") or ""
        if f"/titles/{title_id}/season/" in href and "/episode/" in href:
            if href not in seen:
                seen.add(href)
                name = a.text.strip() or href.split("/episode/")[-1] + ". Bölüm"
                eps.append((href, name))
    def _key(item):
        m = re.search(r'/season/(\d+)/episode/(\d+)', item[0])
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    eps.sort(key=_key)
    return eps

def click_load_more(driver, max_clicks=30):
    clicks, prev = 0, -1
    while clicks < max_clicks:
        try:
            btns = driver.find_elements(By.XPATH,
                "//button[contains(.,'Daha Fazla') or contains(.,'daha fazla') or contains(.,'Load More')]")
            visible = [b for b in btns if b.is_displayed()]
            if not visible: break
            count = len(driver.find_elements(By.CSS_SELECTOR, "a[href*='/episode/']"))
            if count == prev: break
            prev = count
            driver.execute_script("arguments[0].click();", visible[0])
            clicks += 1
            try:
                WebDriverWait(driver, 2).until(
                    lambda d: len(d.find_elements(By.CSS_SELECTOR, "a[href*='/episode/']")) > count)
            except Exception:
                pass
        except Exception:
            break

def get_anime_metadata(driver):
    meta = {
        "title": "", "altTitle": "", "year": time.strftime("%Y"),
        "genre": "Aksiyon", "score": "", "desc": "",
        "coverImage": "", "bannerImage": "", "emoji": "🎬"
    }
    try:
        # Başlık
        for sel in ["h1", "h2"]:
            for el in driver.find_elements(By.TAG_NAME, sel):
                t = el.text.strip()
                if t and len(t) > 2:
                    meta["title"] = t; break
            if meta["title"]: break
        if not meta["title"]:
            els = driver.find_elements(By.TAG_NAME, "title")
            if els:
                meta["title"] = re.sub(r'\s*[-|].*$', '', els[0].get_attribute("textContent").strip()).strip()

        # Jikan API
        try:
            import urllib.parse
            q = urllib.parse.quote(meta["title"])
            req = urllib.request.Request(
                f"https://api.jikan.moe/v4/anime?q={q}&limit=1&sfw",
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            item = (data.get("data") or [None])[0]
            if item:
                for cand in [item.get("title_english") or "", *(item.get("title_synonyms") or [])]:
                    if cand.strip() and cand.strip().lower() != meta["title"].lower():
                        meta["altTitle"] = cand.strip(); break
                synopsis = re.sub(r'\s*\[Written by MAL Rewrite\]', '',
                    (item.get("synopsis") or ""), flags=re.IGNORECASE).strip()
                if synopsis:
                    try:
                        from deep_translator import GoogleTranslator
                        tr = GoogleTranslator(source="en", target="tr").translate(synopsis[:4000])
                        if tr: meta["desc"] = tr
                    except Exception:
                        pass
        except Exception:
            pass

        # Yıl
        m = re.search(r'\((\d{4})\)', meta["title"])
        if m:
            meta["year"] = m.group(1)
            meta["title"] = meta["title"].replace(f"({m.group(1)})", "").strip(" .")
        else:
            for el in driver.find_elements(By.XPATH, "//*[contains(@class,'year') or contains(@class,'date')]"):
                ym = re.search(r'\b(19|20)\d{2}\b', el.text)
                if ym: meta["year"] = ym.group(0); break

        # Puan
        for el in driver.find_elements(By.XPATH,
                "//*[contains(@class,'score') or contains(@class,'rating')]"):
            sm = re.search(r'\b(\d+(?:[.,]\d+)?)\b', el.text)
            if sm:
                v = float(sm.group(1).replace(',', '.'))
                if 1 <= v <= 10: meta["score"] = str(v); break

        # Tür
        genre_map = {
            "aksiyon": "Aksiyon", "action": "Aksiyon", "romantik": "Romantik",
            "romance": "Romantik", "komedi": "Komedi", "comedy": "Komedi",
            "dram": "Dram", "drama": "Dram", "fantezi": "Fantezi", "fantasy": "Fantezi",
            "korku": "Korku", "horror": "Korku", "macera": "Macera", "adventure": "Macera",
            "sci-fi": "Bilim Kurgu", "science": "Bilim Kurgu", "spor": "Spor",
            "sports": "Spor", "psikolojik": "Psikolojik", "psychological": "Psikolojik",
            "gerilim": "Gerilim", "thriller": "Gerilim", "doğaüstü": "Doğaüstü",
            "supernatural": "Doğaüstü", "tarihi": "Tarihi", "historical": "Tarihi",
        }
        for el in driver.find_elements(By.XPATH,
                "//*[contains(@class,'genre') or contains(@class,'tag') or contains(@class,'category')]"):
            t = el.text.strip().lower()
            for k, v in genre_map.items():
                if k in t: meta["genre"] = v; break
            if meta["genre"] != "Aksiyon": break

        # Açıklama
        if not meta["desc"]:
            for sel in ["[class*='desc']", "[class*='synopsis']", "[class*='overview']", "p"]:
                for el in driver.find_elements(By.CSS_SELECTOR, sel):
                    t = re.sub(r'\s*(daha fazla|more|devamı)\s*$', '',
                        re.sub(r'^(KONU|ÖZET|SYNOPSIS)[:\s\n]+', '', el.text.strip(),
                               flags=re.IGNORECASE), flags=re.IGNORECASE).strip()
                    if len(t) > 80: meta["desc"] = t[:600]; break
                if meta["desc"]: break

        # Banner
        try:
            for hdr in driver.find_elements(By.TAG_NAME, "media-item-header"):
                for src_attr in [hdr.get_attribute("style"),
                                 driver.execute_script("return window.getComputedStyle(arguments[0]).backgroundImage", hdr)]:
                    bm = re.search(r'url\(["\']?(https?://[^"\')\s]+)["\']?\)', src_attr or "")
                    if bm: meta["bannerImage"] = bm.group(1); break
                if meta["bannerImage"]: break
        except Exception:
            pass

        # Kapak
        for sel in ["img.media-image-el", "img[class*='media-image']"]:
            for el in driver.find_elements(By.CSS_SELECTOR, sel):
                src_url = el.get_attribute("src") or ""
                if "wsrv.nl" in src_url and "w300" in src_url:
                    meta["coverImage"] = src_url; break
            if meta["coverImage"]: break
        if not meta["coverImage"]:
            for el in driver.find_elements(By.TAG_NAME, "img"):
                src_url = el.get_attribute("src") or ""
                if "wsrv.nl" in src_url:
                    meta["coverImage"] = src_url; break

        # Emoji
        meta["emoji"] = {
            "Aksiyon": "⚔️", "Romantik": "💕", "Komedi": "😂", "Dram": "😢",
            "Fantezi": "🧙", "Korku": "👻", "Macera": "🗺️", "Bilim Kurgu": "🚀",
            "Spor": "⚽", "Psikolojik": "🧠", "Gerilim": "😰", "Doğaüstü": "👁️",
        }.get(meta["genre"], "🎬")

    except Exception as e:
        tprint(f"   [!] Metadata hatası: {e}")
    return meta

# ══════════════════════════════════════════════════════════════════════════════
# LINK ÇÖZÜMLEME — TEK GEÇİŞ, TEKRAR API ÇAĞRISI YOK
# ══════════════════════════════════════════════════════════════════════════════

def pick_best_embed(translator_dict):
    """Tau-video'yu tercih eder, sonra diğer embed'ler."""
    for links in translator_dict.values():
        for link in links:
            if is_tau_embed(link): return link
    embed_hosts = ['filemoon', 'streamtape', 'sibnet', 'vidmoly', 'dood', 'voe.sx']
    for links in translator_dict.values():
        for link in links:
            if any(h in link for h in embed_hosts): return link
    for links in translator_dict.values():
        if links: return links[0]
    return None

def build_ep_links(all_results, is_movie=False, preferred_quality=None):
    """
    Embed → MP4 dönüşümü.
    - Tau embed: tau_to_mp4() → all_qualities'ten epSubs oluştur (tekrar API yok)
    - Aynı bölümün farklı çevirmenleri farklı tau embed'leri ise ayrıca dönüştürülür
    - Tau olmayan embed'ler olduğu gibi kaydedilir
    """
    ep_links  = {}
    ep_titles = {}
    ep_subs   = {}
    ep_meta   = {}

    if is_movie:
        entries = [("1", "Film", all_results.get("Film", {}))]
    else:
        entries = [(str(i+1), label, trs) for i, (label, trs) in enumerate(all_results.items())]

    for k, label, translators in entries:
        if not is_movie:
            ep_titles[k] = label

        best_embed = pick_best_embed(translators)
        if not best_embed:
            continue

        if is_tau_embed(best_embed):
            resolved = tau_to_mp4(best_embed, preferred_quality)
            if resolved:
                ep_links[k] = resolved["url"]

                # Meta (duration, thumbnails, kaliteler)
                m_entry = {}
                if resolved.get("duration"):      m_entry["duration"]      = resolved["duration"]
                if resolved.get("thumbnails"):    m_entry["thumbnails"]    = resolved["thumbnails"]
                if resolved.get("all_qualities"): m_entry["all_qualities"] = resolved["all_qualities"]
                if m_entry:
                    ep_meta[k] = m_entry

                # epSubs — all_qualities'ten kalite seçenekleri + çevirmenler
                subs = {}
                for q in (resolved.get("all_qualities") or []):
                    subs[q["label"]] = q["url"]  # "1080p", "720p", "480p"

                # Farklı çevirmen tau embed'leri — sadece best_embed'den farklıysa dönüştür
                tr_count = 0
                for tr_name, links in translators.items():
                    if not links: continue
                    if tr_count >= 4: break  # bölüm başına max 4 sub
                    link = links[0]
                    if is_tau_embed(link):
                        if link == best_embed:
                            subs[tr_name] = resolved["url"]
                        else:
                            r2 = tau_to_mp4(link, preferred_quality, use_playwright=False)
                            if not r2:
                                tprint(f"      [!] {tr_name} atlandı (çözümlenemedi)")
                                continue  # başarısız sub'ı kaydetme
                            subs[tr_name] = r2["url"]
                    else:
                        subs[tr_name] = link
                    tr_count += 1

                if subs: ep_subs[k] = subs

            else:
                # Dönüşüm başarısız — embed olduğu gibi
                ep_links[k] = best_embed
                tprint(f"      [!] Bölüm {k} dönüştürülemedi, embed kaydedildi.")
        else:
            # Tau olmayan embed
            ep_links[k] = best_embed
            subs = {tr: links[0] for tr, links in list(translators.items())[:4] if links}
            if subs: ep_subs[k] = subs

    return ep_links, ep_titles, ep_subs, ep_meta, len(entries)

# ══════════════════════════════════════════════════════════════════════════════
# SUNUCU İLETİŞİMİ
# ══════════════════════════════════════════════════════════════════════════════

def api_request(method, url, data=None, token=None):
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=payload, method=method, headers={
        "Content-Type": "application/json",
        **({("Authorization"): f"Bearer {token}"} if token else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:    return e.code, json.loads(body)
        except: return e.code, {"error": body}
    except Exception as ex:
        return None, {"error": str(ex)}

def upsert_anime(anime_data, token):
    status, resp = api_request("POST", f"{SERVER_URL}/api/animes", anime_data, token)
    if status == 200: return status, resp
    if status != 409: return status, resp

    _, all_animes = api_request("GET", f"{SERVER_URL}/api/animes", token=token)
    animes = all_animes.get("animes", [])
    existing = next((a for a in animes if a.get("slug") == resp.get("error","").split(": ")[-1]), None)
    if not existing:
        slug = re.sub(r'[^a-z0-9]+', '-',
            anime_data["title"].lower()
                .replace("ğ","g").replace("ü","u").replace("ş","s")
                .replace("ı","i").replace("ö","o").replace("ç","c")).strip("-")
        existing = next((a for a in animes if a.get("slug") == slug), None)
    if not existing: return status, resp
    tprint(f"[*] Mevcut anime güncelleniyor (id: {existing['id']})...")
    return api_request("PATCH", f"{SERVER_URL}/api/animes/{existing['id']}", anime_data, token)

def get_admin_token():
    admin_user = os.environ.get("ADMIN_USERNAME", "admin")
    admin_pass = os.environ.get("ADMIN_PASSWORD", "admin123")
    try:
        status, resp = api_request("POST", f"{SERVER_URL}/api/login", {
            "usernameOrEmail": admin_user,
            "password": admin_pass,
        })
        if status == 200 and resp.get("token"):
            tprint(f"[+] Admin token alındı ({admin_user}).")
            return resp["token"]
        print(f"[!] Login başarısız (status={status}): {resp}")
        return None
    except Exception as e:
        print(f"[!] Token hatası: {e}"); return None

# ══════════════════════════════════════════════════════════════════════════════
# ANA İŞLEM
# ══════════════════════════════════════════════════════════════════════════════

def process_url(anime_url, token, preferred_quality=None):
    if not anime_url or "animecix.tv" not in anime_url:
        print("[!] Geçerli animecix.tv URL'si gir."); return False
    m = re.search(r'/titles/(\d+)', anime_url)
    if not m:
        print("[!] URL'den title ID alınamadı."); return False
    title_id = m.group(1)
    quality  = preferred_quality or QUALITY_PRIORITY[0]
    print(f"\n[*] Kalite: {quality}")

    driver = create_driver(headless=True)
    all_episode_pairs, all_results, meta, is_movie = [], {}, {}, False

    try:
        driver.get(anime_url)
        print("[*] Metadata çekiliyor...")
        try: WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.TAG_NAME, "h1")))
        except Exception: pass

        meta = get_anime_metadata(driver)
        print(f"    {meta['title']} ({meta['year']}) — {meta['genre']}")

        season_links = collect_season_links(driver, title_id)

        if not season_links:
            click_load_more(driver)
            episode_links = collect_episode_links(driver, title_id)
            if not episode_links:
                is_movie = True
                print("[*] Movie algılandı.")
                all_results["Film"] = get_translator_links(driver)
            else:
                print(f"[*] {len(episode_links)} bölüm taranacak.")
                for ep_url, ep_name in episode_links:
                    all_episode_pairs.append((ep_url, f"B{ep_url.split('/episode/')[-1]} - {ep_name}"))
        else:
            print(f"[*] {len(season_links)} sezon bulundu.")
            for season_url in season_links:
                sn = re.search(r'/season/(\d+)', season_url)
                snum = sn.group(1) if sn else "?"
                print(f"[Sezon {snum}] bölümler toplanıyor...")
                driver.get(season_url)
                try: WebDriverWait(driver, 12).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, "a[href*='/episode/']")))
                except Exception: pass
                click_load_more(driver)
                for ep_url, ep_name in collect_episode_links(driver, title_id):
                    ep_num = ep_url.split('/episode/')[-1]
                    all_episode_pairs.append((ep_url, f"S{snum}E{ep_num} - {ep_name}"))

        if all_episode_pairs:
            print(f"\n[*] {len(all_episode_pairs)} bölüm taranıyor...\n")
            for i, (ep_url, label) in enumerate(all_episode_pairs, 1):
                print(f"  [{i}/{len(all_episode_pairs)}] {label}")
                try:
                    driver.get(ep_url)

                    def _on_page():
                        return "/episode/" in driver.current_url or "/titles/" in driver.current_url

                    def _wait_translators():
                        if not _on_page(): return
                        try: WebDriverWait(driver, 15).until(
                            EC.presence_of_element_located((By.CSS_SELECTOR, "title-videos:not(.hidden)")))
                        except Exception: pass
                        try: WebDriverWait(driver, 8).until(
                            EC.presence_of_element_located((By.CSS_SELECTOR, "button.translator-item")))
                        except Exception: pass

                    _wait_translators()
                    btns = driver.find_elements(By.CSS_SELECTOR, "button.translator-item")

                    if not btns or not _on_page():
                        print(f"       [~] Tekrar deneniyor...")
                        time.sleep(3)
                        driver.get(ep_url)
                        _wait_translators()
                        if not _on_page():
                            print(f"       [~] Atlanıyor.")
                            all_results[label] = {}
                            continue

                    result = get_translator_links(driver)
                    all_results[label] = result
                    if not result:
                        print(f"       [-] Link bulunamadı")
                except Exception as e:
                    print(f"       [!] {e}")
                    all_results[label] = {}
    finally:
        driver.quit()

    flat_raw = [(ep, tr, lnk)
                for ep, trs in all_results.items()
                for tr, links in trs.items()
                for lnk in links]
    print(f"\n[+] {len(flat_raw)} embed link toplandı.")
    if not flat_raw:
        print("[!] Hiç link yok."); return False

    # Ham linkleri kaydet
    with open("video_linkleri_raw.txt", "w", encoding="utf-8") as f:
        f.write(f"Kaynak: {anime_url}\n{'='*60}\n")
        for ep, tr, lnk in flat_raw:
            f.write(f"[{ep}] ({tr}) {lnk}\n")

    # Tau dönüşümü
    print(f"\n[*] Tau embed'ler {quality} MP4'e dönüştürülüyor...")
    ep_links, ep_titles, ep_subs, ep_meta, total_eps = build_ep_links(
        all_results, is_movie=is_movie, preferred_quality=quality)

    with open("video_linkleri_resolved.txt", "w", encoding="utf-8") as f:
        f.write(f"Kaynak: {anime_url}\nKalite: {quality}\n{'='*60}\n")
        for k, url in ep_links.items():
            f.write(f"[{ep_titles.get(k, 'Bölüm '+k)}] {url}\n")

    print(f"[+] {len(ep_links)} bölüm çözümlendi.")

    anime_data = {
        "title":       meta.get("title", "Bilinmiyor"),
        "altTitle":    meta.get("altTitle", ""),
        "genre":       meta.get("genre", "Aksiyon"),
        "year":        meta.get("year", time.strftime("%Y")),
        "score":       meta.get("score", ""),
        "desc":        meta.get("desc", ""),
        "emoji":       meta.get("emoji", "🎬"),
        "coverImage":  meta.get("coverImage", ""),
        "bannerImage": meta.get("bannerImage", ""),
        "eps":         str(total_eps),
        "epLinks":     ep_links,
        "epTitles":    ep_titles,
        "epSubs":      ep_subs,
        "epMeta":      ep_meta,
    }

    print(f"[*] '{anime_data['title']}' siteye ekleniyor...")
    status, resp = upsert_anime(anime_data, token)
    if status == 200:
        print(f"\n✓ Eklendi! {SERVER_URL}/#/anime/{resp.get('anime',{}).get('slug','?')}")
        return True
    else:
        print(f"\n[!] Hata ({status}): {resp}"); return False

def main():
    print("=" * 60)
    print("   Animecix → AniLand v8  |  Tau → Ham MP4")
    print("=" * 60)

    args = sys.argv[1:]
    preferred_quality = None
    if "--quality" in args:
        qi = args.index("--quality")
        if qi + 1 < len(args):
            preferred_quality = args[qi + 1]
            args = [a for j, a in enumerate(args) if j not in (qi, qi + 1)]
    if not preferred_quality:
        preferred_quality = QUALITY_PRIORITY[0]

    token = get_admin_token()
    if not token:
        print("[!] Admin token alınamadı."); return

    if args:
        ok = process_url(args[0], token, preferred_quality)
        sys.exit(0 if ok else 1)

    print(f"Kalite: {preferred_quality}  (--quality 480p/720p/1080p ile değiştir)\n")
    while True:
        try:
            url = input("Anime URL (q=çıkış): ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if url.lower() in ("q", "quit", "exit", ""):
            break
        process_url(url, token, preferred_quality)

if __name__ == "__main__":
    main()