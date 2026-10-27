"""Emit a trusted EPF module with the exact production helper; never run in production."""
from pathlib import Path
import argparse
import re

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
module = next((root / "src/CommonModules").glob("*/Ext/Module.bsl"))
source = module.read_text(encoding="utf-8-sig")
helper = re.search(
    r"^Процедура ДополнитьПризнакПодписиМедицинскойОрганизации\(.*?^КонецПроцедуры",
    source, re.M | re.S,
)
if helper is None:
    raise SystemExit("Production helper not found")
fixture = (root / "tests/regression.bsl").read_text(encoding="utf-8-sig")
args.output.write_text(fixture + "\n\n" + helper.group(0) + "\n", encoding="utf-8-sig")
print(args.output)
