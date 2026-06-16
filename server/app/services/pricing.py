# 额度扣费费率（D-02/D-03）：micro-¥（1e-6 元）/token。
# 成本价：DeepSeek V4 Flash ¥1/M 输入、¥2/M 输出 → 1 / 2 micro-¥/token（整数精确）。
MICRO_YUAN_PER_INPUT_TOKEN = 1
MICRO_YUAN_PER_OUTPUT_TOKEN = 2

# 平台服务费：成本价 ×1.3（+30%）。这是「走平台 key」翻译的唯一盈利来源
# （BYOK 客户端直连各 provider 不经此处、不计费）。要调利润改这里。
SERVICE_FEE_RATE = 1.3


def cost_micro(input_tokens: int, output_tokens: int) -> int:
    """本次翻译应扣的额度（micro-¥）＝成本价 × 服务费率，取整到整数 micro-¥。"""
    base = input_tokens * MICRO_YUAN_PER_INPUT_TOKEN + output_tokens * MICRO_YUAN_PER_OUTPUT_TOKEN
    return round(base * SERVICE_FEE_RATE)
