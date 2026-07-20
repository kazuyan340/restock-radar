from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

import requests
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential

StockStatus = Literal["in_stock", "sold_out", "unknown"]

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# A bare User-Agent is a common bot-detection tripwire — real browsers send
# a full header set on every navigation. Some sites (observed with Amazon
# from GitHub Actions' cloud IPs) serve a stripped-down page missing
# availability info to requests that look automated, without an outright
# block; this brings the request closer to what a real browser sends.
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}


@dataclass
class StockResult:
    status: StockStatus
    product_name: str | None = None
    product_image_url: str | None = None


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=15))
def fetch_html(url: str, timeout: float = 25.0) -> str:
    response = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
    response.raise_for_status()
    return response.text


def soup_of(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


class Parser:
    """Contract every site parser must implement."""

    def parse(self, html: str) -> StockResult:
        raise NotImplementedError


_AVAILABILITY_STATUS = {
    "instock": "in_stock",
    "limitedavailability": "in_stock",
    "onlineonly": "in_stock",
    "instorenow": "in_stock",
    "outofstock": "sold_out",
    "soldout": "sold_out",
    "discontinued": "sold_out",
}


def _availability_to_status(value: str) -> StockStatus | None:
    # e.g. "https://schema.org/InStock" -> "instock"
    key = value.rsplit("/", 1)[-1].strip().lower()
    return _AVAILABILITY_STATUS.get(key)


def _walk_products(node: object):
    if isinstance(node, dict):
        node_type = node.get("@type")
        types = node_type if isinstance(node_type, list) else [node_type]
        if "Product" in types:
            yield node
        for value in node.values():
            yield from _walk_products(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_products(item)


def extract_json_ld_stock(soup: BeautifulSoup) -> StockResult | None:
    """Best-effort Schema.org JSON-LD read: Product.offers.availability.

    Preferred over text/CSS scraping because JSON-LD is a stable, documented
    contract most EC platforms already emit for SEO, unlike hashed CSS
    classes (see price-scout's mercari_scraper.py for the lesson learned
    there: aria-label text was more stable than CSS class names).
    """
    for script in soup.find_all("script", type="application/ld+json"):
        if not script.string:
            continue
        try:
            data = json.loads(script.string)
        except (json.JSONDecodeError, TypeError):
            continue

        for product in _walk_products(data):
            offers = product.get("offers")
            offer_list = offers if isinstance(offers, list) else [offers]
            for offer in offer_list:
                if not isinstance(offer, dict):
                    continue
                availability = offer.get("availability")
                if not isinstance(availability, str):
                    continue
                status = _availability_to_status(availability)
                if status is None:
                    continue
                return StockResult(
                    status=status,
                    product_name=product.get("name"),
                    product_image_url=_first_image(product.get("image")),
                )
    return None


def _first_image(image: object) -> str | None:
    if isinstance(image, str):
        return image
    if isinstance(image, list) and image:
        first = image[0]
        return first if isinstance(first, str) else None
    if isinstance(image, dict):
        url = image.get("url")
        return url if isinstance(url, str) else None
    return None
