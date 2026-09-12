"""Bounded source guards; these do not replace 1C transaction/runtime tests."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET


SRC = Path(__file__).resolve().parents[1] / "src" / "extension" / "бит_МедицинаОмни_ПРОФ"
MANAGER = (SRC / "Documents/Заявка/Ext/ManagerModule.bsl").read_text(encoding="utf-8-sig")
INTEGRATION = (SRC / "CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl").read_text(encoding="utf-8-sig")


def function(source, name):
    return re.search(r"Функция " + name + r"\(.*?КонецФункции", source, re.S).group()


class AppointmentActionsSourceTests(unittest.TestCase):
    def test_reschedule_property_reference_can_be_persisted(self):
        ns = {"m": "http://v8.1c.ru/8.3/MDClasses", "v": "http://v8.1c.ru/8.1/data/core"}
        settings = ET.parse(SRC / "InformationRegisters/бит_омни_ЗначенияНастроек.xml")
        value = settings.find(".//m:Resource/m:Properties[m:Name='Значение']", ns)
        types = {item.text for item in value.findall("m:Type/v:Type", ns)}
        self.assertIn("cfg:CatalogRef.ВидыСостоянийЗаявок", types)
        self.assertIn("cfg:ChartOfCharacteristicTypesRef.СвойстваОбъектов", types)
        configuration = ET.parse(SRC / "Configuration.xml")
        self.assertIn("СвойстваОбъектов", {
            item.text for item in configuration.findall(".//m:ChildObjects/m:ChartOfCharacteristicTypes", ns)
        })
        property_type = ET.parse(SRC / "ChartsOfCharacteristicTypes/СвойстваОбъектов.xml")
        self.assertEqual(property_type.find(".//m:ObjectBelonging", ns).text, "Adopted")

    def test_state_is_independent_and_scoped_to_owner_version(self):
        tree = ET.parse(SRC / "InformationRegisters/бит_омни_ДействияЗаписейMAX.xml")
        ns = {"m": "http://v8.1c.ru/8.3/MDClasses"}
        self.assertEqual(tree.find(".//m:WriteMode", ns).text, "Independent")
        dims = {el.text for el in tree.findall(".//m:Dimension/m:Properties/m:Name", ns)}
        self.assertEqual(dims, {"Заявка", "Контакт", "Бот", "Версия"})
        resources = {el.text for el in tree.findall(".//m:Resource/m:Properties/m:Name", ns)}
        self.assertTrue({"КлючОтмены", "СрокПодтверждения", "ПереносЗапрошен", "ОжидаетОтмены"} <= resources)

    def test_cancel_prompt_does_not_write_appointment(self):
        body = function(MANAGER, "бит_омни_CallbackMAXВТранзакции")
        prompt = body.split('Если Действие = "cancel" Тогда', 1)[1].split('Если Действие = "cancelYes" Или', 1)[0]
        self.assertNotIn("ОбъектЗаявки.Записать()", prompt)
        self.assertIn("MAX_APPOINTMENT_CANCEL_CONFIRMATION", prompt)
        self.assertIn("15 * 60", prompt)

    def test_history_and_mutation_share_transaction(self):
        public = function(MANAGER, "бит_омни_ОбработатьCallbackMAX")
        self.assertLess(public.index("НачатьТранзакцию()"), public.index("бит_омни_CallbackMAXВТранзакции"))
        self.assertLess(public.index("бит_омни_CallbackMAXВТранзакции"), public.index("ЗафиксироватьТранзакцию()"))
        inner = function(MANAGER, "бит_омни_CallbackMAXВТранзакции")
        self.assertIn("бит_омни_ЗаписатьОтбивкуMAX", inner)
        self.assertNotIn("ВыполнитьЗапросVDS", inner)
        self.assertIn("Если Не СостояниеДействий.Подтверждена Тогда", inner)
        self.assertIn("Если Не СостояниеДействий.ПереносЗапрошен Тогда", inner)

    def test_reschedule_never_changes_date_or_cancels(self):
        body = function(MANAGER, "бит_омни_ОтметитьПереносMAX")
        self.assertNotRegex(body, r"ДатаНачала\s*=|ДатаОкончания\s*=")
        self.assertNotIn("ВидыСостоянийЗаявок.Отменена", body)
        self.assertIn("СостоянияЗаявкиДоПриходаКлиента()", body)
        self.assertIn('ТипЗначения.СодержитТип(Тип("Булево"))', body)
        self.assertIn("бит_омни_СостоянияДиалоговMAX.ПереносЗаписи", MANAGER)

    def test_callback_auth_still_precedes_state_mutation(self):
        body = function(MANAGER, "бит_омни_CallbackMAXВТранзакции")
        state_start = body.index("бит_омни_ПрочитатьДействияMAX")
        for guard in ["ОбъектКонтакта.Бот <> Бот", "ОбъектЗаявки.Клиент <> ОбъектКонтакта.Получатель",
                      "ОбъектЗаявки.ДатаНачала <= ТекущаяДатаСеанса()", '<> ВерсияЗаписи']:
            self.assertLess(body.index(guard), state_start)
        self.assertIn("КлючОтмены <> СостояниеДействий.КлючОтмены", body)
        self.assertIn("СостояниеДействий.СрокПодтверждения <= ТекущаяДатаСеанса()", body)

    def test_parser_is_allowlist_with_bounded_nonce(self):
        body = function(INTEGRATION, "РазобратьКомандуЗаписиMAX")
        self.assertIn('Части.Количество() <> 4', body)
        self.assertIn('"cancelYes-"', body)
        self.assertIn('"cancelNo-"', body)
        self.assertIn('СтрДлина(ЧастиДействия[1]) <> 12', body)
        self.assertIn('"0123456789abcdef"', body)
        self.assertIn('Действие <> "reschedule"', body)


if __name__ == "__main__":
    unittest.main()
