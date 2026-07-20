from __future__ import annotations

import logging

from .base import Parser, StockResult, extract_json_ld_stock, soup_of
from .generic_fallback import GenericFallbackParser

logger = logging.getLogger("restock-radar-worker")

_NEGATIVE_AVAILABILITY_SIGNALS = ["在庫切れ", "現在お取り扱いできません", "販売、発送は行っておりません"]
_POSITIVE_AVAILABILITY_SIGNALS = ["在庫あり", "残り", "通常配送無料"]

_fallback = GenericFallbackParser()


class AmazonParser(Parser):
    """Amazon.co.jp product page parser.

    Amazon rarely emits reliable Product/Offer JSON-LD, so after trying that
    (cheap, and correct when present), the primary signal is the
    #availability element — an id (not a hashed class) that has been stable
    on Amazon product pages for years.
    """

    def parse(self, html: str) -> StockResult:
        soup = soup_of(html)

        json_ld_result = extract_json_ld_stock(soup)
        if json_ld_result is not None:
            return json_ld_result

        availability = soup.select_one("#availability")
        if availability is not None:
            text = availability.get_text(separator=" ").strip()
            if any(signal in text for signal in _NEGATIVE_AVAILABILITY_SIGNALS):
                return StockResult(status="sold_out", product_name=_product_name(soup))
            if any(signal in text for signal in _POSITIVE_AVAILABILITY_SIGNALS):
                return StockResult(status="in_stock", product_name=_product_name(soup))

        # TEMPORARY diagnostic (remove once the Amazon "unknown"
        # investigation is resolved): logs why this page fell through to
        # the generic fallback, since GitHub Actions' fetch of the same URL
        # has been producing "unknown" where a manual fetch succeeds.
        logger.info(
            "amazon parse fallthrough: html_len=%d has_availability_el=%s availability_text=%r",
            len(html),
            availability is not None,
            availability.get_text(separator=" ").strip()[:200] if availability is not None else None,
        )

        return _fallback.parse(html)


def _product_name(soup) -> str | None:
    title = soup.select_one("#productTitle")
    return title.get_text(strip=True) if title is not None else None
