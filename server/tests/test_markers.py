from app.services.markers import (
    validate_markers,
    allowed_ids_from_source,
    is_verbatim_echo,
)


def test_valid_paired_and_void():
    assert validate_markers("在<g1>渲染</g1>前调用 <g0>fetch()</g0><x2/>", {0, 1, 2}).ok


def test_nesting_ok_crossing_fails():
    assert validate_markers("<g0><g1>x</g1></g0>", {0, 1}).ok
    assert not validate_markers("<g0><g1>x</g0></g1>", {0, 1}).ok  # 交叉


def test_unknown_id_rejected():
    assert not validate_markers("<g5>x</g5>", {0, 1}).ok


def test_malformed_lexeme_rejected():
    assert not validate_markers("<g0/>裸自闭成对标记", {0}).ok   # <gN/> 畸形
    assert not validate_markers("< g0 >空格", {0}).ok            # 形似标记残留


def test_void_duplicate_rejected():
    assert not validate_markers("<x0/><x0/>", {0}).ok


def test_omission_allowed():
    # 允许省略无意义的成对包装：allowedIds 不强求全部出现
    assert validate_markers("纯译文无标记", {0, 1}).ok


def test_allowed_ids_from_source():
    assert allowed_ids_from_source("<x0/><g1>a</g1><g3>b</g3>") == {0, 1, 3}


def test_verbatim_echo():
    assert is_verbatim_echo("Hello  world", "Hello world")  # 归一化空白后相同
    assert not is_verbatim_echo("Hello world", "你好世界")
