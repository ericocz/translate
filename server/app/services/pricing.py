# 额度扣费费率（D-02/D-03）：micro-¥（1e-6 元）/token。
# 当前＝成本价透传：DeepSeek V4 Flash ¥1/M 输入、¥2/M 输出 → 1 / 2 micro-¥/token（整数精确）。
# 要加毛利就调大这两个常数。命中/未命中分档计价是后续细化（需 UsageEvent 带缓存命中拆分）。
MICRO_YUAN_PER_INPUT_TOKEN = 1
MICRO_YUAN_PER_OUTPUT_TOKEN = 2


def cost_micro(input_tokens: int, output_tokens: int) -> int:
    """本次翻译应扣的额度（micro-¥）。"""
    return input_tokens * MICRO_YUAN_PER_INPUT_TOKEN + output_tokens * MICRO_YUAN_PER_OUTPUT_TOKEN
