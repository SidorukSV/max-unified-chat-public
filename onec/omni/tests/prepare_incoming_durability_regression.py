"""Compose a trusted test EPF module using the actual private UUID fence code.

Run: python onec/omni/tests/prepare_incoming_durability_regression.py --output WIP/incoming-regression.bsl
Load the result into a trusted test EPF in an isolated infobase; invoke
ВыполнитьРегрессиюНадежногоПриемаMAX(). Does not start 1C or connect to an infobase.
"""
import argparse
from pathlib import Path
import re


def compose():
    tests = Path(__file__).resolve().parent
    module = tests.parent / "src/extension/бит_МедицинаОмни_ПРОФ/CommonModules/бит_омни_НадежныйОбменMAX/Ext/Module.bsl"
    source = module.read_text(encoding="utf-8-sig")
    chunks = [tests.joinpath("incoming-durability-regression.bsl").read_text(encoding="utf-8-sig")]
    for name in ("ПопыткаВходящегоАктуальна", "ДанныеПриемаВходящего", "Свойство", "ИзJSON"):
        match = re.search(rf"Функция {name}\(.*?КонецФункции", source, re.S)
        if match is None:
            raise ValueError(f"Missing production function: {name}")
        chunks.append(match.group())
    return "\n\n".join(chunks) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(compose(), encoding="utf-8-sig")
