"""Source contracts for closed-chat routing, patient choice and chat archive."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET


EXT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"
NS = {"m": "http://v8.1c.ru/8.3/MDClasses", "r": "http://v8.1c.ru/8.2/roles"}


def source(path):
    return (EXT / path).read_text(encoding="utf-8-sig")


def routine(text, name):
    match = re.search(rf"(?:Функция|Процедура) {name}\(.*?(?:КонецФункции|КонецПроцедуры)", text, re.S)
    if not match:
        raise AssertionError(f"Missing routine {name}")
    return match.group()


class ChatReopenArchiveSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.integration = source("CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl")
        cls.archive = source("CommonModules/бит_омни_АрхивЧатовMAX/Ext/Module.bsl")
        cls.form = source("DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl")

    def test_closed_chat_is_reset_before_new_message_is_recorded(self):
        created = routine(self.integration, "ОбработатьСозданиеСообщения")
        self.assertLess(created.index("ДиалогЗакрытMAX"), created.index("ЗаписатьВходящееСообщениеMAX"))
        self.assertLess(created.index("ПодготовитьПовторноеОбращениеMAX"), created.index("ЗаписатьВходящееСообщениеMAX"))
        reset = routine(self.integration, "ПодготовитьПовторноеОбращениеВТранзакцииMAX")
        self.assertIn("СброситьПациента", reset)
        self.assertLess(
            reset.index("ПеревестиЗакрытыйДиалогВНовыйMAX"),
            reset.index("ИзменитьМаршрутизациюКонтактаВТранзакцииMAX"),
        )
        self.assertIn("Истина);", reset)
        reopen = routine(self.integration, "ПеревестиЗакрытыйДиалогВНовыйMAX")
        self.assertIn("Перечисления.бит_омни_СостоянияДиалоговMAX.Новый", reopen)
        self.assertIn("Справочники.Пользователи.ПустаяСсылка()", reopen)

    def test_multiple_patients_are_explicitly_selected_and_revalidated(self):
        auth = routine(self.integration, "ОбработатьПолученныйКонтактMAX")
        self.assertIn("Клиенты.Количество() > 1", auth)
        self.assertIn("ЗапроситьПациентаMAX", auth)
        callback = routine(self.integration, "ОбработатьВыборПациентаMAX")
        self.assertLess(callback.index("ПодтвержденныйТелефонКонтактаMAX"), callback.index("ИзменитьМаршрутизациюКонтактаMAX"))
        self.assertIn("Клиенты.Найти(Пациент)", callback)
        parser = routine(self.integration, "ПациентИзКомандыMAX")
        self.assertIn('Лев(Команда, 8) <> "patient:"', parser)
        self.assertIn("Новый УникальныйИдентификатор", parser)
        self.assertNotRegex(parser, r"(?i)(Выполнить|Вычислить)\s*\(")

    def test_patient_menu_has_fixed_supported_commands(self):
        menu = routine(self.integration, "НастроитьКомандыБотаMAX")
        self.assertIn('"patient", "Выбрать пациента"', menu)
        self.assertIn('"department", "Выбрать отделение"', menu)
        polling = routine(self.integration, "ВыполнитьРегламентныйОбменСVDS")
        self.assertIn("НужноНастроитьКоманды = Истина", polling)
        self.assertIn("НастроитьКомандыБотаMAX(Бот)", polling)
        command = routine(self.integration, "ОбработатьКоманду")
        self.assertIn('ИмяКоманды = "patient"', command)
        self.assertIn('ИмяКоманды = "department"', command)

    def test_archive_is_privileged_but_not_client_callable(self):
        meta = ET.parse(EXT / "CommonModules/бит_омни_АрхивЧатовMAX.xml")
        self.assertEqual(meta.findtext(".//m:Server", namespaces=NS), "true")
        self.assertEqual(meta.findtext(".//m:Privileged", namespaces=NS), "true")
        self.assertEqual(meta.findtext(".//m:ServerCall", namespaces=NS), "false")
        archive = routine(self.archive, "АрхивироватьДиалог")
        self.assertLess(archive.index("ПроверитьДоступККонтакту"), archive.index("ЗаблокироватьИсториюДиалога"))
        self.assertLess(archive.index("НаборАрхива.Записать()"), archive.index("НаборИстории.Очистить()"))

    def test_close_state_and_archive_share_one_transaction(self):
        close = routine(self.form, "ЗакрытьДиалогНаСервере")
        self.assertLess(close.index("НачатьТранзакцию()"), close.index("УстановитьСостояниеДиалогаНаСервере"))
        self.assertLess(close.index("АрхивироватьДиалог"), close.index("ЗафиксироватьТранзакцию()"))
        self.assertIn("ОтменитьТранзакцию()", close)

    def test_archive_has_department_rls_and_is_available_in_ui(self):
        role = ET.parse(EXT / "Roles/бит_омни_ОператорОтделенияMAX/Ext/Rights.xml")
        objects = {obj.findtext("r:name", namespaces=NS): obj for obj in role.findall("r:object", NS)}
        item = objects["InformationRegister.бит_омни_АрхивЧатовMAX"]
        read = next(x for x in item.findall("r:right", NS) if x.findtext("r:name", namespaces=NS) == "Read")
        condition = read.findtext("r:restrictionByCondition/r:condition", namespaces=NS)
        self.assertIn("&бит_омни_ОтделениеПользователяMAX", condition)
        self.assertIn("Отделение", condition)
        form_xml = source("DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form.xml")
        self.assertIn("Form.Command.ОткрытьАрхивЧатов", form_xml)
        self.assertIn("РегистрСведений.бит_омни_АрхивЧатовMAX.ФормаСписка", self.form)


if __name__ == "__main__":
    unittest.main()
