"""YunGouOS 大陆充值（微信扫码 nativePay）。

签名与字段对齐 YunGouOS-PAY-SDK（JS-SDK PaySignUtil）：
- 签名：参与字段按**参数名字典序升序** → 拼 `k=v&...&key={支付密钥}` → MD5 → **大写**。
- nativePay **只 4 个核心字段参与签名**：out_trade_no / total_fee / mch_id / body；
  其余（notify_url / type / attach 等）随请求带、不参与签名。
- 异步回调 notify 验签字段：code / orderNo / outTradeNo / payNo / money / mchId。

注意：endpoint 与成功码按官方文档实现，真实联调需用户用商户号 + 支付密钥验证。
"""

import hashlib
import hmac
from typing import Any

import httpx

# 微信扫码下单。真实 base 见 https://open.pay.yungouos.com 。
NATIVE_PAY_URL = "https://api.pay.yungouos.com/api/pay/wxpay/nativePay"

# 异步回调验签字段（对齐 JS-SDK checkNotifySign）。
_NOTIFY_SIGN_FIELDS = ("code", "orderNo", "outTradeNo", "payNo", "money", "mchId")


class YunGouOSError(Exception):
    """下单失败（YunGouOS 返回非成功码）。"""


def pay_sign(params: dict[str, str], pay_key: str) -> str:
    """参数名字典序升序 → `k=v&...&key={pay_key}` → MD5 → 大写。
    传入的 params 即参与签名的字段（调用方只放该签名的字段，不在此额外过滤）。"""
    parts = [f"{k}={params[k]}" for k in sorted(params)]
    parts.append(f"key={pay_key}")
    return hashlib.md5("&".join(parts).encode()).hexdigest().upper()


def check_notify_sign(payload: dict[str, Any], sign: str, pay_key: str) -> bool:
    """校验异步回调签名：取固定字段（缺则空串）算签名，与回调 sign 常量时间比对。"""
    params = {k: str(payload.get(k, "")) for k in _NOTIFY_SIGN_FIELDS}
    expected = pay_sign(params, pay_key)
    return hmac.compare_digest(expected, (sign or "").upper())


async def create_native_pay(
    *,
    out_trade_no: str,
    total_fee: str,
    mch_id: str,
    body: str,
    pay_key: str,
    notify_url: str,
    attach: str = "",
) -> str:
    """微信扫码下单，返回付款二维码地址（result.data）。仅 4 个核心字段参与签名。"""
    sign_params = {
        "out_trade_no": out_trade_no,
        "total_fee": total_fee,
        "mch_id": mch_id,
        "body": body,
    }
    form: dict[str, str] = dict(sign_params)
    form["sign"] = pay_sign(sign_params, pay_key)
    form["notify_url"] = notify_url
    form["type"] = "2"  # 直接返回付款二维码图片地址（前端 <img> 展示）
    if attach:
        form["attach"] = attach
    # trust_env=False：与其它上游直连一致，绕开开发机本地 SOCKS 代理。
    async with httpx.AsyncClient(trust_env=False, timeout=10.0) as client:
        resp = await client.post(NATIVE_PAY_URL, data=form)
        resp.raise_for_status()
        result = resp.json()
    if str(result.get("code")) != "0":
        raise YunGouOSError(str(result.get("msg") or "下单失败"))
    return str(result.get("data") or "")
