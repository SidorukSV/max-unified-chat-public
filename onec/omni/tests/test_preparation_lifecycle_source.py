"""Structural release gates, not a replacement for the BSL/1C scenarios."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"


def code(path):
    return (ROOT / path).read_text(encoding="utf-8-sig")


class PreparationLifecycleContracts(unittest.TestCase):
    def setUp(self):
        self.prep = code("CommonModules/бит_ПодготовкаУведомленийMAX/Ext/Module.bsl")
        self.queue = code("CommonModules/бит_омни_ОчередьСообщенийMAX/Ext/Module.bsl")

    def test_medical_subscription_only_captures_intent(self):
        sub = code("CommonModules/бит_омни_ПодпискиНаСобытия/Ext/Module.bsl")
        for forbidden in ("ВыполнитьСхему", "ХранилищеСКД", "СформироватьТекст", "РассчитатьДату", "HTTP"):
            self.assertNotIn(forbidden, sub)
        self.assertIn("ЗафиксироватьПослеЗаписи(Источник)", sub)

    def test_legacy_cache_does_not_decode_optional_schema(self):
        common = code("CommonModules/бит_омни_ОбщегоНазначения/Ext/Module.bsl")
        cache = common.split("Функция ПолучитьСписокОбъектовДляРассылок(", 1)[1].split("КонецФункции", 1)[0]
        self.assertNotIn("ОписаниеНабораДанных", cache)
        self.assertNotIn("СКДКонтекст.Получить()", cache)
        self.assertNotIn("СКДПолучатели.Получить()", cache)
        self.assertIn("ЗаполнитьЗначенияСвойств(Структура, ВыборкаРассылки)", cache)

    def test_render_before_transaction_cas_then_apply(self):
        worker = self.prep.split("Процедура ВыполнитьПодготовку(", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertNotIn("НачатьТранзакцию()", worker)
        self.assertLess(worker.index("Подготовка = ПодготовитьНамерение("), worker.index("ПрименитьНамерение("))
        apply = self.prep.split("Процедура ПрименитьНамерение(", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertLess(apply.index("Запись.Версия = Кандидат.Версия"), apply.index("бит_ПрименитьПодготовку("))
        self.assertIn('Запись.Снимок = Новый ХранилищеЗначения(Неопределено)', apply)

    def test_preparation_error_durable_after_rollback_and_bounded(self):
        worker = self.prep.split("Процедура ВыполнитьПодготовку(", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertLess(worker.index("ОтменитьТранзакцию()"), worker.index("ЗафиксироватьОшибку("))
        self.assertIn('Запись.Попыток >= 5, "Ошибка", "Ожидает"', self.prep)
        self.assertIn("Процедура ПовторитьПодготовку(", self.prep)

    def test_service_module_is_not_client_callable_or_implicitly_privileged(self):
        ns = {"m": "http://v8.1c.ru/8.3/MDClasses"}
        meta = ET.parse(ROOT / "CommonModules/бит_ПодготовкаУведомленийMAX.xml")
        self.assertEqual(meta.findtext(".//m:ServerCall", namespaces=ns), "false")
        self.assertEqual(meta.findtext(".//m:Privileged", namespaces=ns), "false")
        self.assertEqual(meta.findtext(".//m:ExternalConnection", namespaces=ns), "true")

    def test_cancel_invalidates_prepared_generation_then_pending_queue(self):
        manager = code("Documents/Заявка/Ext/ManagerModule.bsl")
        self.assertLess(manager.index("ОтменитьНамеренияЗаявки(ОбъектЗаявки.Ссылка)"),
                        manager.index("бит_ОтменитьОжидающиеЗаявки(ОбъектЗаявки.Ссылка)"))
        cancel = self.prep.split("Процедура ОтменитьНамеренияЗаявки(", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertIn("Запись.Версия = Строка(Новый УникальныйИдентификатор)", cancel)

    def test_immediate_not_retained_as_stale_exception(self):
        self.assertNotIn('Отменять = СтрокаОчереди.Правило <> "IMMEDIATE"', self.queue)
        self.assertIn('Настройка.Шаблон.ИдентификаторСтандартногоШаблона = "MAX_APPOINTMENT_CREATED"', self.prep)
        self.assertIn("бит_ЕстьОжидающееСобытие", self.prep)

    def test_preflight_blocks_live_patient_date_doctor_mismatch(self):
        self.assertIn("Объект.Клиент <> Сообщение.Контакт.Получатель", self.queue)
        self.assertIn('Адресат.Свойство("ВерсияСобытияИсточника", Версия)', self.queue)
        self.assertIn("Версия <> бит_ВерсияСобытияИсточника(Объект)", self.queue)
        self.assertLess(self.queue.index("ПричинаОтказа = бит_ПроверитьАктуальностьСобытия"),
                        self.queue.index("Результат = бит_омни_ИнтеграцияСMAX.ОтправитьПодготовленноеСообщение"))

    def test_failed_preparation_not_among_send_candidates(self):
        self.assertIn('Намерения.Состояние ЕСТЬ NULL ИЛИ Намерения.Состояние = ""Готово""', self.queue)
        self.assertIn("ВосстановитьСтарыеСнимки(ТолькоИсточник, ТолькоБот)", self.prep)

    def test_no_optional_skd_allows_static_schedule(self):
        reminders = code("CommonModules/бит_омни_НапоминанияMAX/Ext/Module.bsl")
        self.assertLess(reminders.index("ЕстьКонтекст = Истина"), reminders.index("ЕстьКонтекст = Контекст.Количество() > 0"))

    def test_custom_after_event_mailing_keeps_its_own_skd_semantics(self):
        allowed = self.queue.split("Функция бит_ДопустимИсточникУведомления(", 1)[1].split("КонецФункции", 1)[0]
        self.assertIn('ИдентификаторШаблона <> "MAX_APPOINTMENT_CREATED"', allowed)
        templates = code("Catalogs/бит_омни_ШаблоныСообщений/Ext/ManagerModule.bsl")
        for template_id in ("MAX_APPOINTMENT_REMINDER", "MAX_APPOINTMENT_REMINDER_24H", "MAX_APPOINTMENT_REMINDER_2H"):
            self.assertIn('"' + template_id + '"', templates)
            self.assertIn('ИдентификаторШаблона <> "' + template_id + '"', allowed)
        self.assertLess(allowed.index('Тогда Возврат Истина'), allowed.index('Источник.ДатаНачала <='))
        self.assertLess(allowed.index('ТипСостояния = Перечисления.ТипыСостоянийЗаявок.Отменена'), allowed.index('Тогда Возврат Истина'))
        self.assertIn('бит_ДопустимИсточникУведомления(Объект, Сообщение.Рассылка)', self.queue)


if __name__ == "__main__":
    unittest.main()
