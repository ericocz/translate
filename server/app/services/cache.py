from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from app.core.hashing import key_of
from app.db.models import TranslationCache


@dataclass
class CacheHit:
    translated: str
    input_tokens: int
    output_tokens: int
    hits: int


class TranslationCacheRepo:
    """全局共享内容寻址缓存仓库。命中即刷新 hits/last_access（LRU）；写入用 upsert。

    设计上不抛错阻断翻译：调用方（translator）把缓存当优化，DB 异常时上层可降级处理。
    """

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_many(self, sources: list[str]) -> dict[str, CacheHit]:
        """批量查缓存：返回 source → 命中记录（仅命中项）。命中同时累加 hits、刷新 last_access。"""
        if not sources:
            return {}
        uniq = list(dict.fromkeys(sources))
        key_to_src = {key_of(src): src for src in uniq}
        rows = (
            await self._s.execute(
                select(TranslationCache).where(TranslationCache.key.in_(list(key_to_src)))
            )
        ).scalars().all()
        out: dict[str, CacheHit] = {}
        hit_keys: list[str] = []
        for r in rows:
            src = key_to_src.get(r.key)
            if src is None:
                continue
            out[src] = CacheHit(r.translated, r.input_tokens, r.output_tokens, r.hits + 1)
            hit_keys.append(r.key)
        if hit_keys:
            await self._s.execute(
                update(TranslationCache)
                .where(TranslationCache.key.in_(hit_keys))
                .values(hits=TranslationCache.hits + 1, last_access=func.now())
            )
            await self._s.commit()
        return out

    async def set_many(self, entries: list[dict]) -> None:
        """批量写入译文（带 token 估算列）。同键 upsert 覆盖。"""
        if not entries:
            return
        # 按键去重（同批同源只留最后一条）——PG 的 ON CONFLICT 不允许一条语句里同键命中两次。
        by_key: dict[str, dict] = {}
        for e in entries:
            by_key[key_of(e["source"])] = {
                "translated": e["translated"],
                "input_tokens": e.get("input_tokens", 0),
                "output_tokens": e.get("output_tokens", 0),
            }
        rows = [{"key": k, **v} for k, v in by_key.items()]
        stmt = insert(TranslationCache).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["key"],
            set_={
                "translated": stmt.excluded.translated,
                "input_tokens": stmt.excluded.input_tokens,
                "output_tokens": stmt.excluded.output_tokens,
                "last_access": func.now(),
            },
        )
        await self._s.execute(stmt)
        await self._s.commit()
