"""Build a rollback-only EPF module with the current chat notification routines."""
from pathlib import Path
import argparse
import re

ROOT = Path(__file__).resolve().parents[1]
FORM = ROOT / "src/extension/бит_МедицинаОмни_ПРОФ/DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    text = FORM.read_text(encoding="utf-8-sig")
    functions = []
    for name in ["ПолучитьНовыеОповещенияНаСервере", "ТекущийПользовательНаСервере",
                 "СформироватьКлючДиалога", "УчастникДиалога",
                 "ПредставлениеОтделения", "ПредставлениеСобеседникаMAX"]:
        match = re.search(rf"Функция {name}\(.*?КонецФункции", text, re.S)
        if not match:
            raise ValueError(f"Missing production routine {name}")
        functions.append(match.group())
    module = "Перем ГраницаОповещений;\nПерем КлючиОповещенийГраницы;\n\n"
    module += (Path(__file__).with_name("chat-lt-regression.bsl").read_text(encoding="utf-8-sig"))
    module += "\n\n" + "\n\n".join(functions) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(module, encoding="utf-8-sig")


if __name__ == "__main__":
    main()
