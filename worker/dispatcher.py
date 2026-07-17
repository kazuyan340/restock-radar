from __future__ import annotations

from urllib.parse import urlparse

from parsers.amazon import AmazonParser
from parsers.base import Parser, StockResult, fetch_html
from parsers.generic_fallback import GenericFallbackParser

# site_type values must stay in sync with the check constraint on
# watched_items.site_type in supabase/migrations/0001_init.sql.
_HOST_SUFFIX_TO_SITE_TYPE = [
    ("amazon.co.jp", "amazon"),
    ("amzn.asia", "amazon"),
    ("item.rakuten.co.jp", "rakuten"),
    ("shopping.yahoo.co.jp", "yahoo_shopping"),
    ("snkrdunk.com", "snkrdunk"),
    ("zozo.jp", "zozotown"),
]

# Sites without a dedicated parser yet fall back to keyword/JSON-LD detection
# (see docs/設計書.md build order — remaining parsers are added incrementally).
_PARSERS: dict[str, Parser] = {
    "amazon": AmazonParser(),
}
_FALLBACK_PARSER = GenericFallbackParser()


def detect_site_type(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    for suffix, site_type in _HOST_SUFFIX_TO_SITE_TYPE:
        if host == suffix or host.endswith("." + suffix):
            return site_type
    return "generic"


def get_parser(site_type: str) -> Parser:
    return _PARSERS.get(site_type, _FALLBACK_PARSER)


def check_url(url: str) -> tuple[str, StockResult]:
    """Fetch and parse a single watched URL. Returns (site_type, result)."""
    site_type = detect_site_type(url)
    parser = get_parser(site_type)
    html = fetch_html(url)
    return site_type, parser.parse(html)
