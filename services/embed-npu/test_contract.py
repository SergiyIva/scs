#!/usr/bin/env python3
"""Проверка контракта NPU-бэкенда без NPU.

Смысл: отделить то, что можно проверить на любой машине (форма ответа,
префиксы, нормализация, бакеты длин, идентификатор модели), от того, что
проверяется только на целевом железе (доля графа на NPU, качество после
квантизации). Первое обязано быть зелёным всегда — иначе на целевую машину
приедет бэкенд, сломанный ещё до встречи с NPU.

Запуск:
    python server.py &            # CPU-провайдер достаточно
    python test_contract.py
    python test_contract.py --reference vectors_cuda.jsonl
"""
from __future__ import annotations

import argparse
import os
import json
import math
import sys
import urllib.request

URL = os.environ.get("SCS_EMBED_URL", "http://127.0.0.1:8077")


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{URL}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{URL}{path}", timeout=30) as resp:
        return json.loads(resp.read())


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'  — ' + detail if detail else ''}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", help="jsonl с эталонными векторами fp32/CUDA")
    ap.add_argument(
        "--compare-with",
        help="URL другого бэкенда того же контракта (например dev на :8077). "
        "Обязательная проверка: форма ответа может быть правильной при полностью "
        "неверных векторах.",
    )
    args = ap.parse_args()

    passed = True
    health = get("/health")
    passed &= check(
        "health отдаёт поля контракта",
        {"backend", "model", "dims", "maxTokens", "ready"} <= health.keys(),
        json.dumps(health, ensure_ascii=False),
    )
    passed &= check("dims == 768", health.get("dims") == 768)

    docs = ["export function scheduleRedelivery(id) {\n  return queue.enqueue(id)\n}", "const x = 1"]
    res = post("/embed", {"inputs": docs, "kind": "document", "dims": 768})

    passed &= check("на каждый вход по вектору", len(res["vectors"]) == len(docs))
    passed &= check("размерность вектора", all(len(v) == 768 for v in res["vectors"]))
    passed &= check("model совпадает с health", res["model"] == health["model"])
    passed &= check("truncated по числу входов", len(res["truncated"]) == len(docs))

    norms = [math.sqrt(sum(x * x for x in v)) for v in res["vectors"]]
    passed &= check(
        "вектора нормализованы сервисом",
        all(abs(n - 1.0) < 1e-3 for n in norms),
        f"нормы {['%.4f' % n for n in norms]}",
    )

    # Асимметрия префиксов: один и тот же текст как запрос и как документ обязан
    # давать РАЗНЫЕ вектора. Совпадение означает, что префиксы не применяются, —
    # это тихая поломка, которая роняет recall в разы и ничего не логирует.
    q = post("/embed", {"inputs": [docs[0]], "kind": "query", "dims": 768})["vectors"][0]
    d = res["vectors"][0]
    cos = sum(a * b for a, b in zip(q, d))
    passed &= check("префиксы запроса и документа различаются", cos < 0.999, f"косинус {cos:.4f}")

    # Бакеты длин: длинный вход не должен ломаться и не должен молча обрезаться
    # без пометки truncated.
    long_doc = "const value = compute(index)\n" * 900
    long_res = post("/embed", {"inputs": [long_doc], "kind": "document", "dims": 768})
    passed &= check(
        "переполнение контекста помечается",
        long_res["truncated"][0] is True,
        "truncated не выставлен на входе длиннее 2048 токенов",
    )

    if args.compare_with:
        # Эта проверка нашла настоящий дефект: экспорт EmbeddingGemma отдаёт два
        # выхода, и ручной mean-pooling по last_hidden_state вместо готового
        # sentence_embedding давал вектора правильной формы и правильной нормы,
        # но с косинусом −0.06 к эталону. Ни одна проверка формы этого не видит.
        probe = [
            "export function scheduleRedelivery(id) {\n  return queue.enqueue(id)\n}",
            "export async function sendPushToResident(user, message) { await push.send(user.token, message) }",
            "const MAX_RETRIES = 5",
        ]
        mine = post("/embed", {"inputs": probe, "kind": "document", "dims": 768})["vectors"]
        req = urllib.request.Request(
            f"{args.compare_with}/embed",
            data=json.dumps({"inputs": probe, "kind": "document", "dims": 768}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            theirs = json.loads(resp.read())["vectors"]

        cosines = [sum(a * b for a, b in zip(x, y)) for x, y in zip(mine, theirs)]
        worst = min(cosines)
        passed &= check(
            "вектора совпадают с эталонным бэкендом",
            worst >= 0.98,
            f"косинусы {['%.4f' % c for c in cosines]} — ниже 0.98 значит сломан конвейер, "
            f"а не квантизация",
        )

    if args.reference:
        with open(args.reference, encoding="utf-8") as fh:
            refs = [json.loads(line) for line in fh if line.strip()]
        got = post("/embed", {"inputs": [r["text"] for r in refs], "kind": "document", "dims": 768})
        cosines = [
            sum(a * b for a, b in zip(v, r["vector"])) for v, r in zip(got["vectors"], refs)
        ]
        worst = min(cosines)
        avg = sum(cosines) / len(cosines)
        passed &= check(
            "косинус к fp32-эталону >= 0.99",
            worst >= 0.99,
            f"средний {avg:.4f}, худший {worst:.4f} — ниже 0.99 значит квантизация испортила вектора",
        )

    print("\nКонтракт" + (" соблюдён." if passed else " НАРУШЕН."))
    print("Это не заменяет приёмку на железе: доля графа на NPU и recall@5 проверяются отдельно (README).")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
