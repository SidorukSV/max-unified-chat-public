"""Release transport contracts; not a substitute for the bundled BSL acceptance."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

EXT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"
NS = {"m": "http://v8.1c.ru/8.3/MDClasses"}


def module(name):
    return (EXT / f"CommonModules/{name}/Ext/Module.bsl").read_text(encoding="utf-8-sig")


def routine(text, name):
    return re.search(rf"(?:Функция|Процедура) {name}\(.*?(?:КонецФункции|КонецПроцедуры)", text, re.S).group()


class ReliableTransportTests(unittest.TestCase):
    def setUp(self):
        self.transport = module("бит_омни_ИнтеграцияСMAX")
        self.reliable = module("бит_омни_НадежныйОбменMAX")

    def test_inbox_precedes_ack_and_lease_receipt_is_not_identity(self):
        poll = routine(self.transport, "ВыполнитьРегламентныйОбменСVDS")
        self.assertLess(poll.index("ОбработатьВходящее"), poll.index('"/api/v1/onec/messages/incoming/ack"'))
        key = routine(self.reliable, "КлючСобытия")
        self.assertIn('"mid"', key)
        self.assertIn('"callback_id"', key)
        self.assertNotIn("receipt", key)

    def test_inbox_commit_is_after_business_and_attempt_limit_has_quarantine(self):
        process = routine(self.reliable, "ОбработатьВходящее")
        tail = process[process.index("бит_омни_ИнтеграцияСMAX.ОбработатьОбновление"):]
        self.assertLess(tail.index('Запись.Состояние = "Обработано"'), tail.index("ЗафиксироватьТранзакцию"))
        claim = routine(self.reliable, "НачатьПопыткуВходящего")
        self.assertIn('Запись.Попыток >= 5', claim)
        self.assertIn('"Карантин"', claim)
        self.assertIn("Запись.ДанныеJSON = ДанныеJSON", claim)

    def test_send_inside_business_transaction_is_only_intention(self):
        send = routine(self.transport, "ОтправитьСообщениеПолучателю")
        self.assertIn("Если ТранзакцияАктивна() Тогда", send)
        self.assertIn("ПоставитьИсходящее", send)
        self.assertNotIn("ОтправитьСообщениеЧерезVDS", send)
        network = routine(self.transport, "бит_ОтправитьНамерениеMAX")
        self.assertLess(network.index("ТранзакцияАктивна"), network.index("ОтправитьСообщениеЧерезVDS"))

    def test_uncertainty_persisted_before_send_and_operator_no_auto_retry(self):
        claim = routine(self.reliable, "ЗахватитьИсходящее")
        self.assertIn('Запись.Состояние = "Неопределено"', claim)
        self.assertIn("ЗафиксироватьТранзакцию", claim)
        outcome = routine(self.reliable, "ЗафиксироватьИтогИсходящего")
        self.assertIn('Результат.Состояние = "Ошибка"', outcome)
        self.assertIn("Запись.ВидОтправителя <> Перечисления.бит_омни_ВидыОтправителейMAX.Оператор", outcome)

    def test_contact_uniqueness_and_relink_preflight(self):
        contact = routine(self.reliable, "ПолучитьИлиСоздатьКонтакт")
        self.assertLess(contact.index("Блокировка.Заблокировать"), contact.index("КонтактыПоИдентификаторуMAX"))
        self.assertLess(contact.index("КонтактИзРегистраИдентичностейMAX"), contact.index("КонтактыПоИдентификаторуMAX"))
        self.assertIn("Контакты.Количество() > 1", contact)
        existing = routine(self.reliable, "ПолучитьСуществующийКонтакт")
        self.assertLess(existing.index("КонтактИзРегистраИдентичностейMAX"), existing.index("КонтактыПоИдентификаторуMAX"))
        identity = routine(self.reliable, "КонтактИзРегистраИдентичностейMAX")
        self.assertIn("бит_омни_ИдентичностиКонтактовMAX", identity)
        self.assertIn("Контакт.Идентификатор <> Идентификатор", identity)
        send = routine(self.transport, "бит_ОтправитьНамерениеMAX")
        self.assertIn('"ОтпечатокПолучателя"', send)
        self.assertIn("Намерение.Контакт.Бот <> Намерение.Бот", send)

    def test_https_and_common_result_no_latest_history_guess(self):
        connection = routine(self.transport, "СоединениеVDS")
        self.assertIn('Схема) <> "https"', connection)
        self.assertLess(connection.index('Схема) <> "https"'), connection.index("Новый HTTPСоединение"))
        chat = (EXT / "DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl").read_text(encoding="utf-8-sig")
        send = routine(chat, "ОтправитьОтветНаСервере")
        self.assertNotIn("РезультатПоследнейОтправкиНаСервере", send)
        self.assertIn('Успех = Статус = "sent"', send)
        history = routine(self.transport, "ЗаписатьИсходящееСообщениеMAX")
        self.assertNotIn("КодСостояния >= 200", history)

    def test_service_registers_independent_and_nonperiodical(self):
        for name in ("ВходящиеСобытия", "ИсходящиеНамерения", "ИдентичностиКонтактов"):
            meta = ET.parse(EXT / f"InformationRegisters/бит_омни_{name}MAX.xml")
            self.assertEqual(meta.findtext(".//m:InformationRegisterPeriodicity", namespaces=NS), "Nonperiodical")
            self.assertEqual(meta.findtext(".//m:WriteMode", namespaces=NS), "Independent")

    def test_quarantine_replay_requires_full_rights_and_never_resets_done(self):
        replay = routine(self.reliable, "ПовторитьКарантин")
        self.assertIn('РольДоступна("ПолныеПрава")', replay)
        self.assertIn('Запись.Состояние <> "Карантин"', replay)
        self.assertNotIn("ИсходящиеНамерения", replay)


if __name__ == "__main__":
    unittest.main()
