"""生成 D-13 会话加密静态密钥对。私钥进 server/.env，公钥进扩展构建 env（公钥可公开）。

用法：cd server && uv run python scripts/gen_session_keypair.py
"""
from app.core.crypto import gen_private_key_b64, load_private_key, public_key_b64

priv_b64 = gen_private_key_b64()
priv = load_private_key(priv_b64)
print("# server/.env")
print(f"SESSION_PRIVATE_KEY={priv_b64}")
print()
print("# front/.env  (WXT 构建期注入；公钥可公开)")
print(f"WXT_SERVER_PUBKEY={public_key_b64(priv)}")
