#!/usr/bin/env python3
"""Add opening hours, websites, booking links and photos to nyc/data/places.

Run after build_places.py. Needs open internet access (it reads
OpenStreetMap and restaurant websites), so it normally runs in GitHub
Actions (.github/workflows/places-data.yml), not on a laptop.

1. Download every named restaurant / bar / cafe in NYC from OpenStreetMap
   (Overpass) with its opening_hours, website and reservation tags.
2. Match each DOHMH place to an OSM place: within 80 m and a similar name.
3. For matched places with a website, read the page's own share image
   (og:image / twitter:image, the picture a link preview shows) and keep it
   only if it is a real photo: https, at least 500x300, not a logo or icon.

Rows in data/places/<stop>.json grow from 8 to 12 fields:
  [camis, name, cuisine, address, grade, lat, lon, meters,
   hours, website, image, bookUrl]
Empty string = unknown. Only the Python standard library is needed.

Usage:
    python3 nyc/scripts/build_extras.py nyc/data/places
"""
import concurrent.futures as cf
import difflib
import glob
import html
import json
import math
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
NYC_BBOX = "40.477,-74.259,40.917,-73.700"
MATCH_M = 80
UA = "Mozilla/5.0 (compatible; PintuNYC/1.0; +https://pintu-nyc.vercel.app)"
BOOKING = re.compile(r"(resy\.com|opentable\.com|exploretock\.com|tock\.com|sevenrooms\.com|yelp\.com/reservations)", re.I)
BAD_IMAGE = re.compile(r"(logo|favicon|icon|placeholder|default|blank|spacer|sprite|preview-background|\.svg|\.gif|\.ico)(\b|_|-|\.)", re.I)
STOP = {"the", "and", "restaurant", "restaurants", "nyc", "ny", "new", "york", "inc", "llc", "corp", "cafe", "bar",
        "grill", "kitchen", "of", "at", "co", "company", "house", "shop"}
# Words too common to identify a place on their own ("Pizza" vs "Joe's Pizza").
GENERIC = {"pizza", "pizzeria", "sushi", "deli", "thai", "chinese", "ramen", "taco", "tacos", "burger", "burgers",
           "bagel", "bagels", "diner", "coffee", "halal", "food", "foods", "express", "bakery", "noodle", "noodles",
           "chicken", "wine", "lounge", "garden", "palace", "golden", "great", "best", "famous", "original", "pho",
           "dumpling", "dumplings", "korean", "japanese", "italian", "mexican", "indian", "street", "avenue"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def overpass_places():
    q = (f'[out:json][timeout:300];nwr["amenity"~"^(restaurant|fast_food|cafe|bar|pub|food_court)$"]["name"]'
         f'({NYC_BBOX});out center tags;')
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=360) as r:
                    els = json.load(r)["elements"]
                if len(els) > 5000:
                    log(f"overpass: {len(els)} places from {url}")
                    return els
                last = f"only {len(els)} elements"
            except Exception as e:  # noqa: BLE001 - try the next mirror
                last = e
                log(f"overpass {url} failed: {e}")
        time.sleep(30)
    sys.exit(f"Overpass unavailable: {last}")


def norm(name):
    s = html.unescape(name or "").lower().replace("&", " and ")
    s = re.sub(r"['’]s\b", "", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return [w for w in s.split() if w not in STOP]


def similar(a, b):
    ta, tb = norm(a), norm(b)
    if not ta or not tb:
        return False
    ja, jb = " ".join(ta), " ".join(tb)
    if ja == jb or difflib.SequenceMatcher(None, ja, jb).ratio() >= 0.8:
        return True
    sa, sb = set(ta), set(tb)
    small, big = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
    return small <= big and any(len(w) >= 3 and w not in GENERIC for w in small)


def norm_key(name):
    return " ".join(norm(name))


def haversine_m(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2 +
         math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def clean_url(u):
    u = (u or "").strip().split(";")[0].strip()
    if not u:
        return ""
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u.lstrip("/")
    p = urllib.parse.urlparse(u)
    return u if p.netloc and "." in p.netloc else ""


def osm_index(els):
    grid = {}
    for e in els:
        t = e.get("tags", {})
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None or not t.get("name"):
            continue
        site = clean_url(t.get("website") or t.get("contact:website") or t.get("url"))
        book = clean_url(t.get("reservation:url") or t.get("contact:reservation") or "")
        if not book and BOOKING.search(site):
            book = site
        rec = (lat, lon, t["name"], (t.get("opening_hours") or "").strip()[:200], site, book)
        grid.setdefault((int(lat * 200), int(lon * 200)), []).append(rec)
    return grid


def match(grid, name, lat, lon):
    gi, gj = int(lat * 200), int(lon * 200)
    best = None
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            for rec in grid.get((gi + di, gj + dj), []):
                d = haversine_m(lat, lon, rec[0], rec[1])
                if d <= MATCH_M and similar(name, rec[2]) and (best is None or d < best[0]):
                    best = (d, rec)
    return best and best[1]


# ---------------------------------------------------------------- share images
META = re.compile(r"<meta\b[^>]*>", re.I)


def find_share_image(page_url, text):
    found = {}
    for tag in META.findall(text):
        prop = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        cont = re.search(r'content\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if prop and cont:
            found.setdefault(prop.group(1).lower(), html.unescape(cont.group(1)).strip())
    for key in ("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"):
        if found.get(key):
            return urllib.parse.urljoin(page_url, found[key])
    return ""


def image_size(head):
    """(width, height) from the first bytes of a JPEG, PNG or WebP, else None."""
    if head[:8] == b"\x89PNG\r\n\x1a\n" and len(head) >= 24:
        return struct.unpack(">II", head[16:24])
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        if head[12:16] == b"VP8X" and len(head) >= 30:
            return (1 + int.from_bytes(head[24:27], "little"), 1 + int.from_bytes(head[27:30], "little"))
        if head[12:16] == b"VP8 " and len(head) >= 30:
            w, h = struct.unpack("<HH", head[26:30])
            return (w & 0x3FFF, h & 0x3FFF)
        if head[12:16] == b"VP8L" and len(head) >= 25:
            b = head[21:25]
            return (1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6)))
    if head[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(head):
            if head[i] != 0xFF:
                i += 1
                continue
            marker = head[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", head[i + 5:i + 9])
                return (w, h)
            seg = struct.unpack(">H", head[i + 2:i + 4])[0]
            i += 2 + seg
    return None


def get(url, limit, extra=None):
    headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.8"}
    headers.update(extra or {})
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.geturl(), r.headers.get("Content-Type", ""), r.read(limit)


BOOK_LINK = re.compile(r'href\s*=\s*["\'](https://(?:www\.)?(?:resy\.com/cities/[^"\'\s]+|opentable\.com/(?:r/|restref/|restaurant/)[^"\'\s]+|'
                       r'exploretock\.com/[^"\'\s/]+[^"\'\s]*|tables\.sevenrooms\.com/[^"\'\s]+|sevenrooms\.com/reservations/[^"\'\s]+))', re.I)
LD_IMAGE = re.compile(r'"image"\s*:\s*(?:\[\s*)?(?:\{[^}]*?"url"\s*:\s*)?"(https://[^"]+\.(?:jpe?g|png|webp)[^"]*)"', re.I)


def site_info(site):
    """(photo, booking link) found on a restaurant's homepage; '' when none."""
    try:
        final, ctype, body = get(site, 600_000)
        if "html" not in ctype.lower():
            return "", ""
        text = body.decode("utf-8", "replace")
        m = BOOK_LINK.search(text)
        book = html.unescape(m.group(1)) if m else ""
        img = find_share_image(final, text)
        if not img:
            ld = LD_IMAGE.search(text)
            img = ld.group(1).replace("\\/", "/") if ld else ""
        return check_photo(img), book
    except Exception:  # noqa: BLE001 - any failure just means "nothing found"
        return "", ""


def check_photo(img):
    try:
        if not img.startswith("https://") or BAD_IMAGE.search(urllib.parse.urlparse(img).path):
            return ""
        # Fetch the image the way a browser on our site would (Referer set), so
        # hotlink-protected images are rejected here rather than shown broken.
        _, itype, head = get(img, 262_144, {"Referer": "https://pintu-nyc.vercel.app/", "Range": "bytes=0-262143"})
        if not itype.lower().startswith("image/") or "svg" in itype.lower():
            return ""
        size = image_size(head)
        if not size:
            return ""
        w, h = size
        if w < 500 or h < 300 or not (0.6 <= w / h <= 2.6):
            return ""
        return img
    except Exception:  # noqa: BLE001 - any failure just means "no photo"
        return ""


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    files = sorted(glob.glob(argv[1].rstrip("/") + "/*.json"))
    if not files:
        sys.exit("No places files found; run build_places.py first.")
    grid = osm_index(overpass_places())

    docs = {f: json.load(open(f, encoding="utf-8")) for f in files}
    places = {}
    for d in docs.values():
        for r in d["p"]:
            places.setdefault(r[0], r[:8])
    log(f"{len(places)} unique DOHMH places in {len(files)} stop files")

    extra = {}
    for camis, r in places.items():
        m = match(grid, r[1], r[5], r[6])
        extra[camis] = [m[3], m[4], "", m[5]] if m else ["", "", "", ""]
    matched = sum(1 for e in extra.values() if e[0] or e[1] or e[3])
    log(f"matched to OSM: {matched}; with hours: {sum(1 for e in extra.values() if e[0])}; "
        f"with website: {sum(1 for e in extra.values() if e[1])}")

    sites = sorted({e[1] for e in extra.values() if e[1]})
    info = {}
    with cf.ThreadPoolExecutor(max_workers=32) as pool:
        for n, (site, got) in enumerate(zip(sites, pool.map(site_info, sites)), 1):
            info[site] = got
            if n % 500 == 0:
                log(f"  checked {n}/{len(sites)} websites, photos so far: {sum(1 for v in info.values() if v[0])}")
    # A picture shared by several differently named places is a template or a
    # chain's generic graphic, not a photo of this place.
    owners = {}
    for camis, e in extra.items():
        img = info.get(e[1], ("", ""))[0]
        if img:
            owners.setdefault(img.split("?")[0], set()).add(norm_key(places[camis][1]))
    for camis, e in extra.items():
        img, book = info.get(e[1], ("", ""))
        e[2] = img if img and len(owners.get(img.split("?")[0], ())) < 3 else ""
        if not e[3] and book:
            e[3] = book
    log(f"places with a photo: {sum(1 for e in extra.values() if e[2])}")

    for f, d in docs.items():
        d["p"] = [r[:8] + extra[r[0]] for r in d["p"]]
        with open(f, "w", encoding="utf-8") as out:
            json.dump(d, out, separators=(",", ":"), ensure_ascii=False)
    stats = {"places": len(places), "hours": sum(1 for e in extra.values() if e[0]),
             "website": sum(1 for e in extra.values() if e[1]), "photo": sum(1 for e in extra.values() if e[2]),
             "book": sum(1 for e in extra.values() if e[3])}
    print(json.dumps(stats))


if __name__ == "__main__":
    main(sys.argv)
