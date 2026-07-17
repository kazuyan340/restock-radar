from __future__ import annotations

import logging
from typing import Any

import dispatcher
import supabase_client
from webpush_client import send_restock_push

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("restock-radar-worker")


def _is_restock(previous_status: str | None, status: str) -> bool:
    return previous_status == "sold_out" and status == "in_stock"


def process_item(item: dict[str, Any]) -> None:
    item_id = item["id"]
    url = item["url"]
    previous_status = item["status"]  # the status before this check, becomes "previous_status"

    try:
        _site_type, result = dispatcher.check_url(url)
    except Exception:
        logger.exception("check failed for item %s (%s)", item_id, url)
        supabase_client.record_check_error(item_id, item["consecutive_error_count"])
        return

    supabase_client.record_check_success(
        item_id,
        status=result.status,
        previous_status=previous_status,
        product_name=result.product_name or item.get("product_name"),
        product_image_url=result.product_image_url or item.get("product_image_url"),
    )

    if not _is_restock(previous_status, result.status):
        return

    device = item.get("devices") or {}
    subscription = device.get("web_push_subscription")
    if not subscription:
        logger.info("item %s restocked but device has no web_push_subscription", item_id)
        return

    product_name = result.product_name or item.get("product_name")
    push_result = send_restock_push(subscription, item_id, product_name)

    if push_result == "sent":
        supabase_client.mark_notified(item_id)
        supabase_client.record_notification(item["device_id"], item_id, url, product_name)
    elif push_result == "unregistered":
        supabase_client.clear_web_push_subscription(item["device_id"])
    else:
        logger.warning("push failed for item %s", item_id)


def main() -> None:
    items = supabase_client.get_active_items()
    logger.info("checking %d active items", len(items))
    for item in items:
        process_item(item)


if __name__ == "__main__":
    main()
