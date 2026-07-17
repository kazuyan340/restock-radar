from pathlib import Path

import pytest

from dispatcher import detect_site_type
from parsers.amazon import AmazonParser
from parsers.generic_fallback import GenericFallbackParser

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


# --- dispatcher -------------------------------------------------------

@pytest.mark.parametrize(
    ("url", "expected_site_type"),
    [
        ("https://www.amazon.co.jp/dp/B0EXAMPLE", "amazon"),
        ("https://amzn.asia/d/abc123", "amazon"),
        ("https://item.rakuten.co.jp/shop/item-1/", "rakuten"),
        ("https://shopping.yahoo.co.jp/products/abc", "yahoo_shopping"),
        ("https://snkrdunk.com/products/abc", "snkrdunk"),
        ("https://zozo.jp/shop/brand/goods/12345", "zozotown"),
        ("https://example.com/some-product", "generic"),
    ],
)
def test_detect_site_type(url: str, expected_site_type: str) -> None:
    assert detect_site_type(url) == expected_site_type


# --- AmazonParser -------------------------------------------------------

def test_amazon_parser_in_stock() -> None:
    result = AmazonParser().parse(_load("amazon_in_stock.html"))
    assert result.status == "in_stock"
    assert result.product_name == "テスト商品 ワイヤレスイヤホン"


def test_amazon_parser_sold_out() -> None:
    result = AmazonParser().parse(_load("amazon_sold_out.html"))
    assert result.status == "sold_out"


# --- GenericFallbackParser: JSON-LD takes priority ----------------------

def test_generic_parser_prefers_json_ld_in_stock() -> None:
    result = GenericFallbackParser().parse(_load("generic_json_ld_in_stock.html"))
    assert result.status == "in_stock"
    assert result.product_name == "テスト商品 限定スニーカー"
    assert result.product_image_url == "https://example.com/images/sneaker.jpg"


def test_generic_parser_prefers_json_ld_sold_out() -> None:
    result = GenericFallbackParser().parse(_load("generic_json_ld_sold_out.html"))
    assert result.status == "sold_out"


# --- GenericFallbackParser: keyword fallback when no JSON-LD ------------

def test_generic_parser_keyword_sold_out() -> None:
    result = GenericFallbackParser().parse(_load("generic_keyword_sold_out.html"))
    assert result.status == "sold_out"


def test_generic_parser_keyword_in_stock() -> None:
    result = GenericFallbackParser().parse(_load("generic_keyword_in_stock.html"))
    assert result.status == "in_stock"


def test_generic_parser_returns_unknown_rather_than_guessing() -> None:
    result = GenericFallbackParser().parse(_load("generic_unknown.html"))
    assert result.status == "unknown"
