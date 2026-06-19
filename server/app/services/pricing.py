# 额度扣费费率（D-02/D-03）：单位＝币种原生单位（Decimal），高精度不量化；展示层才 round。
# 计费按「桶」币种走：人民币桶用 ¥ 三档价、美元桶用 $ 三档价——同一份 DeepSeek 成本，
# 两套官方定价各自透传 ×1.3，**不做汇率换算**（扣费永远只动单一桶、用该桶币种计价）。
# DeepSeek V4 Flash 成本价（每 token）：输入按前缀缓存命中拆两档，输出不缓存。
from decimal import Decimal

# 人民币三档（¥/M：未命中 1、命中 0.02、输出 2）
YUAN_PER_INPUT_MISS_TOKEN = Decimal("0.000001")    # 输入·未命中 ¥1 / 1M
YUAN_PER_INPUT_HIT_TOKEN = Decimal("0.00000002")   # 输入·命中  ¥0.02 / 1M（≈未命中 1/50）
YUAN_PER_OUTPUT_TOKEN = Decimal("0.000002")        # 输出       ¥2 / 1M

# 美元三档（$/M：未命中 0.14、命中 0.0028、输出 0.28，DeepSeek 官网英文定价）
USD_PER_INPUT_MISS_TOKEN = Decimal("0.00000014")   # 输入·未命中 $0.14 / 1M
USD_PER_INPUT_HIT_TOKEN = Decimal("0.0000000028")  # 输入·命中  $0.0028 / 1M（≈未命中 1/50）
USD_PER_OUTPUT_TOKEN = Decimal("0.00000028")       # 输出       $0.28 / 1M

# 平台服务费：成本价 ×1.3（+30%）。走平台 key 翻译的唯一持续盈利来源。要调利润改这里。
SERVICE_FEE_RATE = Decimal("1.3")


def cost_cny(input_miss_tokens: int, input_hit_tokens: int, output_tokens: int) -> Decimal:
    """本次翻译应扣的人民币额度（元）＝三档成本价 × 服务费率。高精度，不量化到分。"""
    base = (
        input_miss_tokens * YUAN_PER_INPUT_MISS_TOKEN
        + input_hit_tokens * YUAN_PER_INPUT_HIT_TOKEN
        + output_tokens * YUAN_PER_OUTPUT_TOKEN
    )
    return base * SERVICE_FEE_RATE


def cost_usd(input_miss_tokens: int, input_hit_tokens: int, output_tokens: int) -> Decimal:
    """本次翻译应扣的美元额度（$）＝美元三档成本价 × 服务费率。高精度，不量化到分。"""
    base = (
        input_miss_tokens * USD_PER_INPUT_MISS_TOKEN
        + input_hit_tokens * USD_PER_INPUT_HIT_TOKEN
        + output_tokens * USD_PER_OUTPUT_TOKEN
    )
    return base * SERVICE_FEE_RATE


# 向后兼容别名：未指明币种处＝人民币。
cost = cost_cny


def cost_for(currency: str, input_miss_tokens: int, input_hit_tokens: int, output_tokens: int) -> Decimal:
    """按币种选三档计价：'USD' 用美元价，其余（'CNY'）用人民币价。"""
    if currency == "USD":
        return cost_usd(input_miss_tokens, input_hit_tokens, output_tokens)
    return cost_cny(input_miss_tokens, input_hit_tokens, output_tokens)
