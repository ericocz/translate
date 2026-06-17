# 额度扣费费率（D-02/D-03）：单位＝元（Decimal），高精度不量化到分；展示层才 round 2 位。
# DeepSeek V4 Flash 成本价（每 token）：输入按前缀缓存命中拆两档，输出不缓存。
from decimal import Decimal

YUAN_PER_INPUT_MISS_TOKEN = Decimal("0.000001")    # 输入·未命中 ¥1 / 1M
YUAN_PER_INPUT_HIT_TOKEN = Decimal("0.00000002")   # 输入·命中  ¥0.02 / 1M（≈未命中 1/50）
YUAN_PER_OUTPUT_TOKEN = Decimal("0.000002")        # 输出       ¥2 / 1M

# 平台服务费：成本价 ×1.3（+30%）。走平台 key 翻译的唯一持续盈利来源
# （BYOK 客户端直连各 provider 不经此处、不计费）。要调利润改这里。
SERVICE_FEE_RATE = Decimal("1.3")


def cost(input_miss_tokens: int, input_hit_tokens: int, output_tokens: int) -> Decimal:
    """本次翻译应扣的额度（元）＝三档成本价 × 服务费率。
    返回高精度 Decimal（不量化到分）——余额由账本流水加总得出，只在展示时 round 2 位。"""
    base = (
        input_miss_tokens * YUAN_PER_INPUT_MISS_TOKEN
        + input_hit_tokens * YUAN_PER_INPUT_HIT_TOKEN
        + output_tokens * YUAN_PER_OUTPUT_TOKEN
    )
    return base * SERVICE_FEE_RATE
