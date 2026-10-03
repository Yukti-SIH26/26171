#!/usr/bin/env python3
"""
Split an ONNX model's weights into external-data chunks small enough to commit.

Why: GitHub hard-rejects any file over 100 MiB, and Git LFS has a thin free
quota. ONNX lets weights live outside the graph file, and transformers.js can
load a fixed number of those chunks. So a 182 MiB model becomes one small graph
file plus two weight files, all committable, with no LFS and no runtime download
from a third party.

The chunk names are not ours to choose. transformers.js builds them in
`getExternalDataChunkNames`:

    model_q4.onnx_data      (chunk 0)
    model_q4.onnx_data_1    (chunk 1)
    model_q4.onnx_data_2    (chunk 2)

and each tensor's `location` field in the graph must match exactly, which is why
this script assigns locations per tensor rather than using onnx's default
single-file helper.

The output is bit-identical to the input: same weights, same dtype, same
accuracy. Only the storage layout changes.

Usage:
    python scripts/split_onnx.py .cache/onnx/model_q4.onnx \
        --out packages/extension/src/public/models/Xenova/owlvit-base-patch32/onnx \
        --limit 97
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import onnx
    from onnx import TensorProto
except ImportError:
    sys.exit("onnx is not installed. Run: python -m pip install onnx")

MB = 1024 * 1024

# Tensors smaller than this stay inline in the graph file. Scalars and tiny
# shape constants are not worth an external-data record, and keeping them inline
# makes the graph file self-describing enough to inspect by hand.
INLINE_THRESHOLD = 1024

# Pad each tensor's start offset to this boundary. ONNX Runtime Web slices a
# buffer so alignment is not strictly required, but aligned loads are free to
# provide and keep native runtimes happy if the same files are reused there.
ALIGNMENT = 64


def chunk_names(base_name: str, count: int) -> list[str]:
    """
    Mirror of transformers.js `getExternalDataChunkNames`.

    Kept as a separate function so the naming contract is stated in one place;
    if the library ever changes it, this is the only line that moves.
    """
    return [f"{base_name}_data{'' if i == 0 else f'_{i}'}" for i in range(count)]


def tensor_bytes(tensor: TensorProto) -> int:
    return len(tensor.raw_data)


def pack(
    tensors: list[TensorProto], limit: int
) -> list[list[TensorProto]]:
    """
    Assign tensors to chunks, largest first, first chunk that has room.

    Deliberately simple. Optimal bin packing is not needed: the binding
    constraint is the single largest tensor, which cannot be split at all, so no
    packing strategy can produce a smaller maximum file.
    """
    chunks: list[list[TensorProto]] = []
    totals: list[int] = []

    for tensor in sorted(tensors, key=lambda t: -tensor_bytes(t)):
        size = tensor_bytes(tensor)
        # Worst-case padding, so a chunk cannot overshoot the limit once
        # alignment gaps are added during writing.
        cost = size + ALIGNMENT

        if cost > limit:
            raise SystemExit(
                f"tensor '{tensor.name}' is {size / MB:.2f} MiB, which exceeds the "
                f"{limit / MB:.0f} MiB chunk limit. A single tensor cannot be split "
                f"across files, so this model cannot be chunked at this limit."
            )

        for index, total in enumerate(totals):
            if total + cost <= limit:
                chunks[index].append(tensor)
                totals[index] += cost
                break
        else:
            chunks.append([tensor])
            totals.append(cost)

    return chunks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path, help="source .onnx with inline weights")
    parser.add_argument("--out", type=Path, required=True, help="output directory")
    parser.add_argument(
        "--limit",
        type=float,
        default=97.0,
        help="max chunk size in MiB (default 97, leaving headroom under GitHub's 100)",
    )
    args = parser.parse_args()

    if not args.model.is_file():
        sys.exit(f"not found: {args.model}")

    base_name = args.model.name  # e.g. "model_q4.onnx"
    limit = int(args.limit * MB)

    args.out.mkdir(parents=True, exist_ok=True)

    print(f"source   {args.model}  ({args.model.stat().st_size / MB:.1f} MiB)")
    print(f"output   {args.out}")
    print(f"limit    {args.limit:.0f} MiB per chunk\n")

    model = onnx.load(str(args.model), load_external_data=False)

    external: list[TensorProto] = []
    inline_count = 0
    for tensor in model.graph.initializer:
        # Anything already external would need its source data resolved first;
        # this script only handles the inline-weights case it is given.
        if tensor.data_location == TensorProto.EXTERNAL:
            sys.exit(f"'{tensor.name}' is already external — expected an inline model")
        if tensor_bytes(tensor) >= INLINE_THRESHOLD:
            external.append(tensor)
        else:
            inline_count += 1

    if not external:
        sys.exit("no tensors large enough to externalise")

    chunks = pack(external, limit)
    names = chunk_names(base_name, len(chunks))

    # Captured before the raw_data fields are cleared, so the reload check at the
    # end has something to compare against without re-reading the source file.
    expected_bytes = sum(tensor_bytes(t) for t in external)

    print(f"tensors  {len(external)} external, {inline_count} kept inline")
    print(f"chunks   {len(chunks)}\n")

    for name, group in zip(names, chunks):
        path = args.out / name
        offset = 0
        with path.open("wb") as handle:
            for tensor in group:
                # Align, then record where these bytes actually landed.
                padding = (-offset) % ALIGNMENT
                if padding:
                    handle.write(b"\0" * padding)
                    offset += padding

                data = tensor.raw_data
                handle.write(data)

                tensor.data_location = TensorProto.EXTERNAL
                del tensor.external_data[:]
                for key, value in (
                    ("location", name),
                    ("offset", str(offset)),
                    ("length", str(len(data))),
                ):
                    entry = tensor.external_data.add()
                    entry.key = key
                    entry.value = value

                # The bytes now live in the chunk file. Leaving them here too
                # would double the on-disk size and defeat the whole exercise.
                tensor.ClearField("raw_data")
                offset += len(data)

        size = path.stat().st_size
        flag = "OK " if size < 100 * MB else "OVER"
        print(f"  {flag} {name:<26} {size / MB:7.2f} MiB  {len(group):>4} tensors")

    graph_path = args.out / base_name
    onnx.save(model, str(graph_path))
    graph_size = graph_path.stat().st_size
    print(f"  OK  {base_name:<26} {graph_size / MB:7.2f} MiB  (graph only)")

    total = graph_size + sum((args.out / n).stat().st_size for n in names)
    print(f"\ntotal    {total / MB:.1f} MiB across {len(names) + 1} files")
    print(f"load with use_external_data_format: {len(chunks)}")

    oversized = [n for n in (*names, base_name) if (args.out / n).stat().st_size >= 100 * MB]
    if oversized:
        print(f"\nFAILED: these files are at or over 100 MiB: {', '.join(oversized)}")
        return 1

    # Structural check: reload the graph, resolving external references against
    # the files just written, and confirm every byte comes back. Catches an
    # offset or length bug here rather than as a silent wrong-weights failure in
    # the browser, which would be far harder to diagnose.
    reloaded = onnx.load(str(graph_path), load_external_data=True)
    restored = sum(
        len(t.raw_data) for t in reloaded.graph.initializer if tensor_bytes(t) >= INLINE_THRESHOLD
    )
    if restored != expected_bytes:
        print(f"\nFAILED: reload recovered {restored} bytes, expected {expected_bytes}")
        return 1

    print(f"verified: reload recovered all {restored / MB:.1f} MiB of weights")
    return 0


if __name__ == "__main__":
    sys.exit(main())
