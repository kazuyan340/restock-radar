# -*- coding: utf-8 -*-
"""
VAPID鍵ペアを1組生成し、Pythonワーカー(pywebpush)側とSupabase Edge
Function(npm:web-push)側の両方で使える形式で出力する1回限りのスクリプト。
同じ鍵から派生させることで、ブラウザが購読時に使う公開鍵と、
worker/send-test-notification両方の秘密鍵が必ず一致するようにする。

    python generate_vapid_keys.py
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def main() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    private_numbers = private_key.private_numbers()
    raw_private = private_numbers.private_value.to_bytes(32, "big")

    public_numbers = public_key.public_numbers()
    raw_public = b"\x04" + public_numbers.x.to_bytes(32, "big") + public_numbers.y.to_bytes(32, "big")

    print("=== private_key.pem（Pythonワーカー用。worker/private_key.pemに保存し、")
    print("    GitHub Secretsの VAPID_PRIVATE_KEY_PEM にも設定） ===")
    print(pem.decode("ascii"))

    print("=== VAPID_PRIVATE_KEY_RAW（send-test-notification Edge Function用。")
    print("    Supabase secrets set VAPID_PRIVATE_KEY_RAW=... で設定） ===")
    print(_b64url(raw_private))

    print("=== VAPID_PUBLIC_KEY（web/app.jsのVAPID_PUBLIC_KEYと、")
    print("    send-test-notification Edge Functionの両方で使用） ===")
    print(_b64url(raw_public))


if __name__ == "__main__":
    main()
