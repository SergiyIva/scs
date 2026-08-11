#!/usr/bin/env python3
"""Prod-бэкенд эмбеддера: тот же HTTP-контракт, но поверх Ryzen AI NPU.

Контракт байт-в-байт совпадает с services/embed-ollama (§4): POST /embed
и GET /health. TS-ядро не должно уметь отличить один бэкенд от другого —
в этом весь смысл границы.

ВНИМАНИЕ: этот файл написан, но НЕ ПРОВЕРЕН на железе. Машина разработки —
Intel + NVIDIA, а целевая — AMD Strix Point с XDNA2. Всё, что здесь можно
было проверить без NPU (форма контракта, префиксы, батчинг, бакеты длин),
проверяется тестом test/npu_contract.py на CPU-провайдере. Всё остальное
проверяется процедурой приёмки в конце файла и до её прохождения считается
неработающим.

Запуск:
    pip install -r requirements.txt
    python server.py                       # CPU, для проверки контракта
    SCS_NPU_PROVIDER=VitisAI python server.py
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

PORT = int(os.environ.get("SCS_EMBED_PORT", "8077"))
HOST = "127.0.0.1"
MODEL_DIR = os.environ.get("SCS_NPU_MODEL_DIR", "./model")
MODEL_ID = os.environ.get("SCS_EMBED_MODEL", "embeddinggemma-300m-npu")
PROVIDER = os.environ.get("SCS_NPU_PROVIDER", "CPU")
DIMS = 768
MAX_TOKENS = 2048
BATCH = int(os.environ.get("SCS_NPU_BATCH", "32"))

# Префиксы — свойство модели, поэтому живут в сервисе, а не в клиенте (§4).
# Значения обязаны совпадать с dev-бэкендом, иначе индекс и запросы разъедутся
# молча: recall упадёт в разы, а ошибки не будет ни одной.
PREFIX = {
    "query": "task: search result | query: ",
    "document": "title: none | text: ",
}

# NPU не любит динамический seq_len: под каждую длину компилируется свой граф.
# Вход паддится до ближайшего бакета сверху. Без этого часть подграфов молча
# уезжает на CPU, и весь выигрыш по энергии исчезает.
BUCKETS = (128, 256, 512, 1024, 2048)

# Схлопывание пробельных серий: на dev-бэкенде это дало ×48 по скорости при
# нулевой разнице в качестве (§17). Токенизатор здесь другой, поэтому выигрыш
# может быть иным, но РЕЖИМ обязан совпадать с тем, которым построен индекс, —
# он входит в идентификатор модели.
COLLAPSE_WS = os.environ.get("SCS_EMBED_WS", "collapse") == "collapse"
MODEL_ID_FULL = f"{MODEL_ID}+ws" if COLLAPSE_WS else MODEL_ID


def providers() -> list:
    """Vitis AI EP сам решает, какие узлы графа уйдут на NPU."""
    if PROVIDER.lower() == "vitisai":
        return [
            (
                "VitisAIExecutionProvider",
                {"config_file": os.environ.get("SCS_VITIS_CONFIG", "vaip_config.json")},
            ),
            "CPUExecutionProvider",
        ]
    return ["CPUExecutionProvider"]


class Embedder:
    def __init__(self) -> None:
        self.tokenizer = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
        self.tokenizer.no_padding()
        self.tokenizer.no_truncation()

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            os.path.join(MODEL_DIR, "model.onnx"), opts, providers=providers()
        )
        self.input_names = {i.name for i in self.session.get_inputs()}
        output_names = [o.name for o in self.session.get_outputs()]
        # У экспорта EmbeddingGemma ДВА выхода: last_hidden_state и
        # sentence_embedding. Второй — это результат пулинга вместе с dense-головой
        # модели, и именно он сравним с векторами dev-бэкенда. Ручной mean-pooling
        # по первому выходу даёт формально правильный вектор нужной размерности,
        # который при этом не имеет отношения к настоящему: замер косинуса
        # с Ollama дал −0.06 вместо ожидаемых 0.99. Это ровно тот тихий отказ,
        # ради которого приёмка сравнивает вектора с эталоном, а не только форму.
        self.embedding_output = (
            "sentence_embedding" if "sentence_embedding" in output_names else output_names[0]
        )
        print(f"[embed-npu] выход модели: {self.embedding_output}", flush=True)
        self._report_placement()

    def _report_placement(self) -> None:
        """Доля графа на NPU пишется в лог при старте.

        Если там 30%, это провал компиляции, а не «работает медленно», и узнать
        об этом надо сразу, а не по итогам недельного профилирования.
        """
        used = self.session.get_providers()
        print(f"[embed-npu] провайдеры: {used}", flush=True)
        if "VitisAIExecutionProvider" in used:
            log = os.environ.get("SCS_VITIS_REPORT", "vitisai_ep_report.json")
            try:
                with open(log, encoding="utf-8") as fh:
                    report = json.load(fh)
                stats = report.get("deviceStat", [])
                total = sum(s.get("nodeNum", 0) for s in stats) or 1
                on_npu = sum(s.get("nodeNum", 0) for s in stats if s.get("name") == "DPU")
                share = on_npu / total * 100
                print(f"[embed-npu] узлов на NPU: {on_npu}/{total} ({share:.1f}%)", flush=True)
                if share < 70:
                    print(
                        "[embed-npu] ВНИМАНИЕ: меньше 70% графа на NPU — это провал "
                        "компиляции, а не медленная работа. Проверьте бакеты длин "
                        "и статичность шейпов.",
                        file=sys.stderr,
                        flush=True,
                    )
            except FileNotFoundError:
                print("[embed-npu] отчёт Vitis AI не найден, долю узлов проверить нечем", flush=True)

    @staticmethod
    def _bucket(length: int) -> int:
        for b in BUCKETS:
            if length <= b:
                return b
        return BUCKETS[-1]

    def _prepare(self, text: str) -> str:
        return " ".join(text.split()) if COLLAPSE_WS else text

    def encode(self, texts: list[str], kind: str) -> tuple[np.ndarray, list[bool]]:
        prepared = [self._prepare(PREFIX[kind] + t) for t in texts]
        encodings = [self.tokenizer.encode(t) for t in prepared]

        truncated = [len(e.ids) > MAX_TOKENS for e in encodings]
        ids = [e.ids[:MAX_TOKENS] for e in encodings]

        vectors = np.zeros((len(ids), DIMS), dtype=np.float32)
        # Группируем по бакетам: перекомпиляция графа на каждый новый шейп
        # стоит дороже, чем лишний паддинг.
        order = sorted(range(len(ids)), key=lambda i: len(ids[i]))
        for chunk in _batched(order, BATCH):
            bucket = self._bucket(max(len(ids[i]) for i in chunk))
            batch_ids = np.zeros((len(chunk), bucket), dtype=np.int64)
            mask = np.zeros((len(chunk), bucket), dtype=np.int64)
            for row, idx in enumerate(chunk):
                seq = ids[idx]
                batch_ids[row, : len(seq)] = seq
                mask[row, : len(seq)] = 1

            feeds = {"input_ids": batch_ids, "attention_mask": mask}
            if "token_type_ids" in self.input_names:
                feeds["token_type_ids"] = np.zeros_like(batch_ids)

            out = self.session.run([self.embedding_output], feeds)[0]
            # Пулинг руками нужен только если экспорт отдал сырые состояния.
            pooled = _mean_pool(out, mask) if out.ndim == 3 else out
            for row, idx in enumerate(chunk):
                vectors[idx] = pooled[row][:DIMS]

        return _l2_normalize(vectors), truncated


def _batched(seq: list[int], size: int) -> Iterable[list[int]]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _mean_pool(hidden: np.ndarray, mask: np.ndarray) -> np.ndarray:
    m = mask[..., None].astype(np.float32)
    return (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    """Нормализация всегда на стороне сервиса: потом косинус = скалярное произведение."""
    norm = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.clip(norm, 1e-12, None)


class Handler(BaseHTTPRequestHandler):
    embedder: Embedder

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:  # noqa: D102 - тише в journald
        pass

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "нет такого маршрута"})
            return
        self._send(
            200,
            {
                "backend": "npu",
                "model": MODEL_ID_FULL,
                "dims": DIMS,
                "maxTokens": MAX_TOKENS,
                "ready": True,
            },
        )

    def do_POST(self) -> None:
        if self.path != "/embed":
            self._send(404, {"error": "нет такого маршрута"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            inputs = body.get("inputs")
            if not isinstance(inputs, list) or not all(isinstance(s, str) for s in inputs):
                self._send(400, {"error": "inputs должен быть массивом строк"})
                return
            if body.get("dims") not in (None, DIMS):
                self._send(400, {"error": f"эта модель отдаёт {DIMS} измерений"})
                return

            kind = "query" if body.get("kind") == "query" else "document"
            if not inputs:
                self._send(
                    200,
                    {"vectors": [], "model": MODEL_ID_FULL, "dims": DIMS, "normalized": True, "truncated": []},
                )
                return

            vectors, truncated = self.embedder.encode(inputs, kind)
            self._send(
                200,
                {
                    "vectors": vectors.tolist(),
                    "model": MODEL_ID_FULL,
                    "dims": DIMS,
                    "normalized": True,
                    "truncated": truncated,
                },
            )
        except Exception as err:  # noqa: BLE001 - наружу отдаём как 500 по контракту
            self._send(500, {"error": str(err)})


def main() -> None:
    Handler.embedder = Embedder()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"embed-npu: http://{HOST}:{PORT} → {MODEL_ID_FULL} ({PROVIDER}, {DIMS}d)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
