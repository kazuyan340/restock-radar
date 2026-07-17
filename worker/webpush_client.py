from __future__ import annotations

import json
import os

from pywebpush import WebPushException, webpush


def send_restock_push(subscription: dict, item_id: str, product_name: str | None) -> str:
    """Send a restock push via the standard Web Push protocol (VAPID).

    Returns "sent", "unregistered", or "error". On "unregistered" (the
    subscription is gone - user uninstalled/unsubscribed), the caller should
    clear devices.web_push_subscription so we stop trying it.
    """
    body = f"「{product_name}」の在庫が復活しました" if product_name else "登録した商品の在庫が復活しました"
    payload = json.dumps(
        {
            "title": "在庫復活のお知らせ",
            "body": body,
            "item_id": item_id,
            "url": f"./?item={item_id}",
        }
    )

    try:
        webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=os.environ.get("VAPID_PRIVATE_KEY_PATH", "private_key.pem"),
            vapid_claims={"sub": os.environ["VAPID_SUBJECT"]},
        )
        return "sent"
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (404, 410):
            return "unregistered"
        return "error"
