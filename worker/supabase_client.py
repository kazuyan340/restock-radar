from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from supabase import Client, create_client

# After this many consecutive fetch/parse failures, an item's status is
# frozen to "error" so the cron loop stops re-fetching a permanently dead
# URL every cycle (it stays visible to the user, just not auto-retried).
ERROR_THRESHOLD = 5

_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        service_role_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, service_role_key)
    return _client


def get_active_items() -> list[dict[str, Any]]:
    """Active, non-errored items, joined with the owning device's Web Push subscription."""
    response = (
        get_client()
        .table("watched_items")
        .select("*, devices(web_push_subscription)")
        .eq("is_active", True)
        .neq("status", "error")
        .execute()
    )
    return response.data


def record_check_success(
    item_id: str,
    *,
    status: str,
    previous_status: str | None,
    product_name: str | None,
    product_image_url: str | None,
) -> None:
    get_client().table("watched_items").update(
        {
            "status": status,
            "previous_status": previous_status,
            "product_name": product_name,
            "product_image_url": product_image_url,
            "last_checked_at": _now_iso(),
            "consecutive_error_count": 0,
        }
    ).eq("id", item_id).execute()


def record_check_error(item_id: str, consecutive_error_count: int) -> None:
    new_count = consecutive_error_count + 1
    update: dict[str, Any] = {
        "consecutive_error_count": new_count,
        "last_checked_at": _now_iso(),
    }
    if new_count >= ERROR_THRESHOLD:
        update["status"] = "error"
    get_client().table("watched_items").update(update).eq("id", item_id).execute()


def mark_notified(item_id: str) -> None:
    get_client().table("watched_items").update({"last_notified_at": _now_iso()}).eq(
        "id", item_id
    ).execute()


def record_notification(device_id: str, item_id: str, url: str, product_name: str | None) -> None:
    """Append a row to the notification history shown in the web UI.

    Separate from mark_notified(), which only tracks the most recent send on
    the item itself; this keeps every past notification.
    """
    get_client().table("notifications").insert(
        {
            "device_id": device_id,
            "watched_item_id": item_id,
            "url": url,
            "product_name": product_name,
            "sent_at": _now_iso(),
        }
    ).execute()


def clear_web_push_subscription(device_id: str) -> None:
    get_client().table("devices").update({"web_push_subscription": None}).eq(
        "id", device_id
    ).execute()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
