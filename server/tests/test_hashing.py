from app.core.hashing import key_of, VERSION


def test_key_is_stable_and_versioned():
    k1 = key_of("Hello world")
    k2 = key_of("Hello world")
    assert k1 == k2                      # 同源稳定
    assert k1.startswith(VERSION + ":")  # 版本前缀
    assert key_of("Hello world") != key_of("Hello world!")  # 不同源不同键


def test_version_is_short_hex():
    assert len(VERSION) == 12
    int(VERSION, 16)  # 必须是合法 hex，否则抛错
