"""Callback source contracts and an offline EPF module assembler; no 1C execution.

python onec/omni/tests/test_callback_identity_source.py --emit-runtime-module <path>
assembles the BSL fixture with exact current production helper bodies. Build this
as a test EPF and call ВыполнитьРегрессиюCallbackMAX(patient_before, patient_after)
in an isolated infobase. The fixture rolls back and never calls HTTP.
"""
from pathlib import Path
import re
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "src/extension/бит_МедицинаОмни_ПРОФ/CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl"
FIXTURE = Path(__file__).with_name("callback-identity-regression.bsl")
HELPERS = (
    "НайтиКонтактMAX", "ПроверитьСнимокCallbackMAX", "ПроверитьСнимокОчередиMAX",
    "ОтпечатокПолучателяКонтактаMAX", "ТелоСообщенияMAX", "СтроковоеСвойство",
    "ЗначениеСвойства", "СтрокаИдентификатора",
)


def routine(source, name):
    match = re.search(
        rf"^(?:Функция|Процедура) {name}\(.*?^(?:КонецФункции|КонецПроцедуры)",
        source, re.M | re.S,
    )
    if not match:
        raise ValueError(f"Missing production routine: {name}")
    return match.group()


def runtime_module():
    source = MODULE.read_text(encoding="utf-8-sig")
    return FIXTURE.read_text(encoding="utf-8-sig") + "\n\n" + "\n\n".join(
        routine(source, name) for name in HELPERS
    ) + "\n"


class CallbackIdentityContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = MODULE.read_text(encoding="utf-8-sig")

    def test_existing_mapping_never_falls_through_to_unique_fallback(self):
        resolver = routine(self.source, "НайтиКонтактMAX")
        mapping, fallback = resolver.split("Если ЗаписьИдентичности.Выбран() Тогда", 1)[1].split("Иначе", 1)
        self.assertIn("Контакт = ЗаписьИдентичности.Контакт", mapping)
        self.assertNotIn("ПолучитьСуществующийКонтакт", mapping)
        self.assertIn("ПолучитьСуществующийКонтакт", fallback)
        self.assertNotIn("ПЕРВЫЕ 1", resolver)
        for guard in ("ПометкаУдаления", "Заблокирован", "Контакт.Бот <> Бот",
                      "Контакт.Идентификатор <> ИдентификаторПользователя", "Контакт.Канал"):
            self.assertIn(guard, resolver)
        self.assertNotIn("Привилегированный", resolver)

    def test_callback_identity_checked_before_direct_http_or_enqueue(self):
        answer = routine(self.source, "бит_ОтветитьНаCallbackMAX")
        self.assertIn('"Параметр,Значение,ИдентификаторCallback"', answer)
        self.assertLess(answer.index("ПроверитьСнимокCallbackMAX"), answer.index("ВыполнитьЗапросVDS"))
        self.assertLess(answer.index("ПроверитьСнимокCallbackMAX"), answer.index("ПоставитьИсходящее"))
        self.assertNotIn("ОтпечатокПолучателя", answer)

    def test_callback_preflight_is_independent_of_patient_but_bound_to_identity(self):
        callback = routine(self.source, "ПроверитьСнимокCallbackMAX")
        for field in ('"ИдентификаторCallback"', '"callback_id"', '"user_id"',
                      "НайтиКонтактMAX(Контакт.Идентификатор, Бот) <> Контакт", "Контакт.Заблокирован"):
            self.assertIn(field, callback)
        self.assertNotIn("Получатель", callback)
        send = routine(self.source, "бит_ОтправитьНамерениеMAX")
        self.assertLess(send.index("ПроверитьСнимокCallbackMAX"), send.index("ИначеЕсли ЗначениеЗаполнено(Намерение.Контакт)"))
        self.assertIn('Результат.Состояние = "Отменено"', send)
        self.assertIn("требуется повторное действие пользователя", send)

    def test_personal_messages_retain_fingerprint_and_contact_guards(self):
        send = routine(self.source, "бит_ОтправитьНамерениеMAX")
        personal = send.split("ИначеЕсли ЗначениеЗаполнено(Намерение.Контакт) Тогда", 1)[1].split('Если Намерение.Вид = "message" Тогда', 1)[0]
        self.assertIn('"ОтпечатокПолучателя") <> ОтпечатокПолучателяКонтактаMAX', personal)
        for guard in ("ПометкаУдаления", "Заблокирован", "Намерение.Контакт.Бот <> Намерение.Бот"):
            self.assertIn(guard, personal)
        snapshot = routine(self.source, "ПроверитьСнимокОчередиMAX")
        self.assertIn("Адресат.ОтпечатокПолучателя <> ОтпечатокПолучателяКонтактаMAX", snapshot)

    def test_runtime_module_contains_current_production_helpers_and_no_network(self):
        assembled = runtime_module()
        for helper in HELPERS:
            self.assertIn(routine(self.source, helper), assembled)
        for forbidden in ("ВыполнитьЗапросVDS", "HTTPСоединение", "ОтправитьОжидающие", "ЗафиксироватьТранзакцию"):
            self.assertNotIn(forbidden, assembled)
        self.assertIn("ОтменитьТранзакцию", assembled)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--emit-runtime-module":
        Path(sys.argv[2]).write_text(runtime_module(), encoding="utf-8-sig")
    else:
        unittest.main()
