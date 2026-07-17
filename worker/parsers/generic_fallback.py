from __future__ import annotations

from .base import Parser, StockResult, extract_json_ld_stock, soup_of

# Order matters: checked as substrings against the page's visible text.
# Negative signals are checked first — a page can legitimately contain the
# word "在庫あり" inside an unrelated recommendation widget, but an explicit
# "SOLD OUT" / "品切れ" near the main content is a stronger, less ambiguous
# signal in practice.
_NEGATIVE_SIGNALS = ["sold out", "sold-out", "品切れ", "売り切れ", "在庫切れ", "入荷お知らせ"]
_POSITIVE_SIGNALS = ["在庫あり", "カートに入れる", "add to cart", "buy now", "今すぐ購入"]


class GenericFallbackParser(Parser):
    """Best-effort parser for sites without a dedicated parser.

    Never guesses: if neither a JSON-LD signal nor a clear keyword signal is
    found, returns "unknown" rather than risking a false restock
    notification (a wrong "sold_out" is harmless — the user just doesn't get
    notified early; a wrong "in_stock" sends a false-positive push and
    erodes trust in the app).
    """

    def parse(self, html: str) -> StockResult:
        soup = soup_of(html)

        json_ld_result = extract_json_ld_stock(soup)
        if json_ld_result is not None:
            return json_ld_result

        text = soup.get_text(separator=" ").lower()

        if any(signal in text for signal in _NEGATIVE_SIGNALS):
            return StockResult(status="sold_out")
        if any(signal in text for signal in _POSITIVE_SIGNALS):
            return StockResult(status="in_stock")

        return StockResult(status="unknown")
