"""
flipp_price_check.py
--------------------
Search for a product across Albertsons (or any chain) locations using
the public Flipp API. No authentication required.

Usage:
    python flipp_price_check.py
    python flipp_price_check.py "reser's macaroni salad"

The STORES list below mirrors the Albertsons locations in the Fetch
Deals hub. Add or remove entries as needed.
"""

import sys
import json
import ssl
import urllib.request
import urllib.parse
from datetime import datetime

# Use an unverified SSL context — required on some Windows machines where
# Python's bundled CA bundle conflicts with corporate/system certificates.
_SSL_CTX = ssl._create_unverified_context()

# -- STORES TO CHECK -----------------------------------------------------------
# Each entry: (display label, postal_code, merchant filter string)
# The merchant filter is matched case-insensitively against Flipp's
# merchant_name field so "albertsons" catches "Albertsons" etc.
STORES = [
    # -- Albertsons ------------------------------------------------------------
    ("Albertsons - Los Angeles (Hillhurst Ave)",  "90029", "albertsons"),
    ("Albertsons - Los Angeles (Crenshaw Blvd)",  "90016", "albertsons"),
    ("Albertsons - El Paso (Mesa St)",            "79912", "albertsons"),
    ("Albertsons - El Paso (Montana Ave)",        "79902", "albertsons"),

    # -- Carrs (Alaska) --------------------------------------------------------
    ("Carrs - Anchorage (Huffman Rd)",            "99515", "carrs"),
    ("Carrs - Anchorage (W Northern Lights Blvd)","99517", "carrs"),
    ("Carrs - Anchorage (Abbott Rd)",             "99507", "carrs"),
    ("Carrs - Anchorage (Seward Hwy)",            "99503", "carrs"),
    ("Carrs - Anchorage (W Dimond Blvd)",         "99502", "carrs"),
    ("Carrs - Anchorage (Debarr Rd)",             "99504", "carrs"),
    ("Carrs - Anchorage (E Northern Lights Blvd)","99504", "carrs"),
    ("Carrs - Palmer",                            "99645", "carrs"),
    ("Carrs - Wasilla",                           "99654", "carrs"),

    # -- Safeway ---------------------------------------------------------------
    ("Safeway - Oakland (Broadway) #3132",        "94611", "safeway"),
    ("Safeway - Denver (Federal Blvd) #1635",     "80211", "safeway"),
    ("Safeway - Grand Junction (Broadway) #897",  "81507", "safeway"),
    ("Safeway - Honolulu (Pali Hwy) #203",        "96813", "safeway"),
    ("Safeway - San Francisco (16th St) #1490",   "94103", "safeway"),
    ("Safeway - Seattle (15th Ave NE) #1586",     "98125", "safeway"),
]

# -- SEARCH TERMS --------------------------------------------------------------
# Script will run all of these and merge results.
DEFAULT_QUERIES = [
    "reser's potato salad",
    "reser's macaroni salad",
    "reser's salad",
]

# -- FLIPP API -----------------------------------------------------------------
FLIPP_URL = "https://backflipp.wishabi.com/flipp/items/search"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept":     "application/json",
}


def search_flipp(query: str, postal_code: str) -> list:
    """Return all Flipp items matching query near postal_code."""
    params = urllib.parse.urlencode({"q": query, "postal_code": postal_code})
    url    = f"{FLIPP_URL}?{params}"
    req    = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
            data = json.loads(resp.read().decode())
            return data.get("items", [])
    except Exception as e:
        print(f"  [!] Request failed for {postal_code!r}: {e}")
        return []


def fmt_price(val) -> str:
    if val is None:
        return "—"
    try:
        return f"${float(val):.2f}"
    except (ValueError, TypeError):
        return str(val)


def fmt_date(iso: str) -> str:
    """Convert ISO 8601 to readable short date."""
    if not iso:
        return "?"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%b %-d")
    except Exception:
        return iso[:10]


def run(queries: list[str]):
    # results[store_label] = list of matching deal dicts
    results: dict[str, list] = {label: [] for label, _, _ in STORES}

    print(f"\n{'-'*60}")
    print(f"  Flipp Price Check")
    print(f"  Queries : {', '.join(repr(q) for q in queries)}")
    print(f"  Stores  : {len(STORES)}")
    print(f"{'-'*60}\n")

    for label, postal, merchant_filter in STORES:
        print(f"Checking {label} ({postal})…")
        for query in queries:
            items = search_flipp(query, postal)
            for item in items:
                mname = (item.get("merchant_name") or "").lower()
                if merchant_filter.lower() not in mname:
                    continue
                # Deduplicate by flyer_item_id
                if any(r["flyer_item_id"] == item.get("flyer_item_id")
                       for r in results[label]):
                    continue
                results[label].append(item)
        count = len(results[label])
        print(f"  -> {count} matching deal(s) found")

    # -- Print comparison table -----------------------------------------------
    print(f"\n{'='*60}")
    print("  RESULTS")
    print(f"{'='*60}\n")

    any_found = False
    for label, _, _ in STORES:
        deals = results[label]
        if not deals:
            print(f"  {label}\n  (no matching deals)\n")
            continue
        any_found = True
        print(f"  {label}")
        for d in deals:
            name       = d.get("name")        or "Unknown item"
            price      = fmt_price(d.get("current_price"))
            orig       = fmt_price(d.get("original_price"))
            pre_text   = d.get("pre_price_text")  or ""
            post_text  = d.get("post_price_text") or ""
            sale_story = d.get("sale_story")      or ""
            valid_from = fmt_date(d.get("valid_from") or "")
            valid_to   = fmt_date(d.get("valid_to")   or "")

            price_str  = price
            if orig and orig != "—":
                price_str += f"  (reg {orig})"
            if pre_text:
                price_str = f"{pre_text} {price_str}"
            if post_text:
                price_str += f" {post_text}"
            if sale_story:
                price_str += f"  [{sale_story}]"

            print(f"    • {name}")
            print(f"      Price : {price_str}")
            print(f"      Valid : {valid_from} - {valid_to}")
        print()

    if not any_found:
        print("  No deals found at any location for the given search terms.\n")
        print("  Tips:")
        print("    • The item may not be in this week's ad")
        print("    • Try a shorter query: python flipp_price_check.py \"reser's\"")
        print("    • Flipp coverage varies by market\n")

    # -- Price consistency summary --------------------------------------------
    all_prices = set()
    for label, _, _ in STORES:
        for d in results[label]:
            p = d.get("current_price")
            if p is not None:
                all_prices.add(round(float(p), 2))

    if len(all_prices) > 1:
        print(f"{'-'*60}")
        print(f"  !  Prices differ across locations: "
              f"{', '.join(fmt_price(p) for p in sorted(all_prices))}")
        print(f"{'-'*60}\n")
    elif len(all_prices) == 1:
        print(f"{'-'*60}")
        print(f"  OK  Price is consistent across all locations: "
              f"{fmt_price(next(iter(all_prices)))}")
        print(f"{'-'*60}\n")


if __name__ == "__main__":
    queries = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_QUERIES
    run(queries)
