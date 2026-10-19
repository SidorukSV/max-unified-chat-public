"""Inbox durability contracts. Static checks; execute the BSL fixture separately."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET
from prepare_incoming_durability_regression import compose

ROOT = Path(__file__).resolve().parents[1]
MODULES = ROOT / "src/extension/бит_МедицинаОмни_ПРОФ/CommonModules"


def routine(text, name):
    match = re.search(rf"(?:Функция|Процедура) {name}\(.*?(?:КонецФункции|КонецПроцедуры)", text, re.S)
    if match is None:
        raise AssertionError(f"Missing routine: {name}")
    return match.group()


class IncomingDurabilitySourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inbox = (MODULES / "бит_омни_НадежныйОбменMAX/Ext/Module.bsl").read_text(encoding="utf-8-sig")
        cls.integration = (MODULES / "бит_омни_ИнтеграцияСMAX/Ext/Module.bsl").read_text(encoding="utf-8-sig")

    def test_durable_receive_commits_before_scenario_transaction(self):
        process = routine(self.inbox, "ОбработатьВходящее")
        self.assertLess(process.index("СохранитьПриемВходящего("), process.index("НачатьТранзакцию()"))
        self.assertLess(process.index("НачатьТранзакцию()"), process.index("ОбработатьОбновление(Прием.update, Бот, Прием.context)"))
        stage = routine(self.inbox, "СохранитьПриемВходящего")
        self.assertLess(stage.index("ВходящаяЗаписьПодБлокировкой"), stage.index("СохранитьПриемОбновленияMAX"))
        self.assertIn("ПопыткаВходящегоАктуальна(Запись, НомерПопытки, ИдентификаторПопытки)", stage)
        self.assertLess(stage.index("Запись.ДанныеJSON = ВJSON(Прием)"), stage.index("ЗафиксироватьТранзакцию()"))
        self.assertIn("Если Прием.inbox_version = 0 Тогда", stage)

    def test_retry_keeps_original_payload_and_context(self):
        claim = routine(self.inbox, "НачатьПопыткуВходящего")
        self.assertIn("Если Не Запись.Выбран() Тогда Запись.ДанныеJSON = ДанныеJSON", claim)
        self.assertIn('Запись.Состояние = "Ошибка" И Запись.ДатаИзменения > ТекущаяДатаСеанса() - 120', claim)
        self.assertIn("Запись.Попыток >= 5", claim)
        self.assertIn("Запись.АрендаДо <= ТекущаяДатаСеанса()", claim)
        decode = routine(self.inbox, "ДанныеПриемаВходящего")
        self.assertIn('"inbox_version", -1) = 1', decode)
        self.assertIn('0, Данные, Неопределено', decode)
        recovery = routine(self.inbox, "ОбработатьЛокальныеПовторы")
        self.assertIn("ДанныеПриемаВходящего(Выборка.ДанныеJSON)", recovery)
        self.assertNotIn('"Карантин"', recovery)

    def test_duplicate_has_no_reopen_or_scenario(self):
        stage = routine(self.integration, "СохранитьПриемОбновленияMAX")
        duplicate = stage[stage.index("Если СообщениеЧатаУжеЗаписаноMAX"):stage.index("РазрешенныеВложения =")]
        self.assertIn("Возврат Контекст", duplicate)
        self.assertIn("Контекст.Дубль = Истина", duplicate)
        dispatch = routine(self.integration, "ОбработатьОбновление")
        self.assertLess(dispatch.index('"Дубль"'), dispatch.index("ПовторноеОбращениеАктуальноMAX"))
        self.assertLess(dispatch.index("ПовторноеОбращениеАктуальноMAX"), dispatch.index("ОбработатьСозданиеСообщения("))

    def test_receive_stage_has_no_network_scenario_or_phone_lookup(self):
        stage = routine(self.integration, "СохранитьПриемОбновленияMAX")
        for forbidden in ("Отправить", "ПоставитьИсходящее", "ПодготовитьПовторноеОбращениеMAX(",
                          "ПодтвержденныйТелефонКонтактаMAX(", "КлиентыПоТелефонуMAX("):
            self.assertNotIn(forbidden, stage)
        self.assertIn("Блокировка.Заблокировать()", stage)
        self.assertIn('"type") = "contact"', stage)
        self.assertIn("Формат(ВыборкаПриема.Период", stage)
        self.assertIn("ФиксироватьОткрытиеДиалогаПриПриемеMAX", stage)

    def test_mid_is_stable_without_random_uuid(self):
        identity = routine(self.integration, "ИдентификаторВходящегоСообщенияMAX")
        self.assertIn('"mid"', identity)
        self.assertIn("ХешФункция.SHA256", identity)
        self.assertNotIn("Новый УникальныйИдентификатор", identity)
        created = routine(self.integration, "ОбработатьСозданиеСообщения")
        self.assertNotIn("ЗаписатьВходящееСообщениеMAX(", created)

    def test_history_archive_dedup_is_scoped_and_not_rls_filtered(self):
        check = routine(self.integration, "СообщениеЧатаУжеЗаписаноMAX")
        for table in ("ИсторияЧатов", "Архив"):
            for field in ("ИдентификаторСообщения", "Контакт", "Бот", "Входящее"):
                self.assertIn(f"{table}.{field} = &{field}", check)
        self.assertNotIn("РАЗРЕШЕННЫЕ", check)

    def test_custom_handler_and_action_errors_reach_inbox(self):
        handler = routine(self.integration, "ВыполнитьОбработчик")
        self.assertEqual(handler.count("УстановитьБезопасныйРежим(БылБезопасныйРежим)"), 2)
        self.assertIn("ВызватьИсключение;", handler)
        command = routine(self.integration, "ОбработатьКоманду")
        self.assertIn("ВызватьИсключение Результат.Описание", command)
        error = routine(self.inbox, "ЗарегистрироватьОшибкуВходящего")
        self.assertIn("КраткоеПредставлениеОшибки(Ошибка)", error)
        self.assertIn('?(НомерПопытки >= 5, "Карантин", "Ошибка")', error)

    def test_selected_admin_recovery_validates_key_and_preserves_context(self):
        replay = routine(self.inbox, "ПовторитьКарантин")
        for guard in ('РольДоступна("ПолныеПрава")', 'Запись.Состояние <> "Карантин"',
                      "КлючСобытия(Данные) <> Ключ", "ПустаяСтрока(СокрЛП(Причина))"):
            self.assertIn(guard, replay)
        self.assertNotIn("Запись.ДанныеJSON =", replay)
        self.assertNotIn("ИсходящиеНамерения", replay)
        self.assertIn('"ОМНИ.MAX.Inbox.Replay"', replay)

    def test_uuid_fence_prevents_aba_after_manual_budget_reset(self):
        claim = routine(self.inbox, "НачатьПопыткуВходящего")
        self.assertIn("Результат.ИдентификаторПопытки = Строка(Новый УникальныйИдентификатор)", claim)
        self.assertIn('Прием.Вставить("claim_id", Результат.ИдентификаторПопытки)', claim)
        fence = routine(self.inbox, "ПопыткаВходящегоАктуальна")
        self.assertIn('Свойство(Прием, "claim_id", "") = ИдентификаторПопытки', fence)
        self.assertIn("Не ПустаяСтрока(ИдентификаторПопытки)", fence)
        for name in ("ОбработатьВходящее", "СохранитьПриемВходящего", "ЗарегистрироватьОшибкуВходящего"):
            self.assertIn("ПопыткаВходящегоАктуальна(", routine(self.inbox, name))
        error = routine(self.inbox, "ЗарегистрироватьОшибкуВходящего")
        self.assertIn('Этап + ": "', error)

    def test_direct_webhook_dispatch_uses_reliable_ingress(self):
        dispatch = routine(self.integration, "ОбработатьОбновление")
        self.assertLess(dispatch.index("Если Не ТранзакцияАктивна()"), dispatch.index("ОбработатьВходящее("))
        self.assertLess(dispatch.index("ОбработатьВходящее("), dispatch.index("ТипОбновления ="))

    def test_bot_start_unblocks_contact_before_state_validation(self):
        stage = routine(self.integration, "СохранитьПриемОбновленияMAX")
        self.assertLess(stage.index("УстановитьБлокировкуКонтакта(Контакт, Ложь)"),
                        stage.index("ФиксироватьОткрытиеДиалогаПриПриемеMAX"))
        self.assertIn('Если ТипОбновления = "bot_started" Тогда', stage)

    def test_runtime_aba_fixture_uses_exact_production_guard(self):
        generated = compose()
        for name in ("ПопыткаВходящегоАктуальна", "ДанныеПриемаВходящего", "Свойство", "ИзJSON"):
            self.assertEqual(routine(generated, name), routine(self.inbox, name))
        self.assertIn("ПопыткаВходящегоАктуальна(Запись, 1, СтарыйUUID)", generated)
        self.assertIn("ПопыткаВходящегоАктуальна(Запись, 1, НовыйUUID)", generated)

    def test_fixture_cleanup_filters_match_actual_register_dimensions(self):
        generated = compose()
        cleanup = routine(generated, "УдалитьФикстурыРегрессииПриемаMAX")
        names = re.search(r'СтрРазделить\("([^"]+)"', cleanup).group(1).split(",")
        ns = {"m": "http://v8.1c.ru/8.3/MDClasses"}
        registers = MODULES.parent / "InformationRegisters"

        def dimensions(name):
            metadata = ET.parse(registers / f"бит_омни_{name}MAX.xml")
            return {item.findtext("m:Properties/m:Name", namespaces=ns)
                    for item in metadata.findall(".//m:Dimension", ns)}

        for name in names:
            with self.subTest(register=name):
                self.assertIn("Бот", dimensions(name))
        self.assertEqual(dimensions("ИсходящиеНамерения"), {"Ключ"})
        outgoing = routine(generated, "УдалитьИсходящиеФикстурыРегрессииПриемаMAX")
        self.assertIn("ГДЕ Бот = &Бот", outgoing)
        self.assertIn("Запись.Ключ = СтрокаКлюча.Ключ", outgoing)
        self.assertIn("Запись.Выбран() И Запись.Бот = Бот", outgoing)
        self.assertNotIn("СоздатьНаборЗаписей", outgoing)

    def test_fixture_cleanup_failure_preserves_original_exception(self):
        generated = compose()
        execute = routine(generated, "ВыполнитьРегрессиюНадежногоПриемаMAX")
        capture = execute.index("ИсходнаяОшибка = ПодробноеПредставлениеОшибки(ИнформацияОбОшибке())")
        cleanup = execute.index("УдалитьФикстурыРегрессииПриемаMAX(", capture)
        self.assertLess(capture, cleanup)
        self.assertIn('ИсходнаяОшибка = ИсходнаяОшибка + Символы.ПС + "Дополнительная ошибка очистки фикстур:', execute)
        self.assertIn("ВызватьИсключение ИсходнаяОшибка", execute)


if __name__ == "__main__":
    unittest.main()
