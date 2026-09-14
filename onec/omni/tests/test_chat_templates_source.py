"""Source contracts for editable chat templates; runtime rendering is tested in 1C."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"
CATALOG = ROOT / "Catalogs/бит_омни_ШаблоныСообщений"
CODE = (CATALOG / "Ext/ManagerModule.bsl").read_text(encoding="utf-8-sig")


def function(name):
    return CODE.split("Функция " + name + "(", 1)[1].split("КонецФункции", 1)[0]


class ChatTemplateContracts(unittest.TestCase):
    def test_editable_chat_standards_exist(self):
        standards = function("СтандартныеШаблоны")
        for identifier in ("MAX_DEPARTMENT_SELECTION", "MAX_PATIENT_SELECTION", "MAX_APPOINTMENT_CANCEL_CONFIRMATION",
                           "MAX_ATTACHMENTS_REJECTED"):
            self.assertEqual(standards.count('"' + identifier + '"'), 1)
        self.assertIn('"ПочтаКлиники"', standards)
        self.assertIn('""clinic_email""', standards)

    def test_department_keyboard_is_not_frozen_in_template(self):
        department = function("СтандартныеШаблоны").split('"MAX_DEPARTMENT_SELECTION"', 1)[1].split(");", 1)[0]
        self.assertIn('"", "", Новый Массив', department)

    def test_cancel_confirmation_uses_single_use_context_token(self):
        standards = function("СтандартныеШаблоны")
        for action in ("cancelYes", "cancelNo"):
            self.assertIn("_" + action + "-<ПодтверждениеОтмены>", standards)
        self.assertIn('""cancel_token""', standards)
        self.assertIn("_<ВерсияЗаписи>_reschedule", standards)

    def test_loader_does_not_overwrite_existing_templates(self):
        loader = function("ЗагрузитьСтандартныеШаблоны")
        guard = loader.index("Если Не СсылкаШаблона.Пустая() Тогда")
        self.assertLess(guard, loader.index("ОбъектШаблона = СоздатьЭлемент()"))
        self.assertIn("Продолжить;", loader[guard:].split("КонецЕсли;", 1)[0])
        self.assertNotIn("ПолучитьОбъект()", loader)

    def test_reminder_upgrade_is_narrow_and_preserves_text(self):
        upgrade = function("ОбновитьСтандартныеКнопкиНапоминаний")
        self.assertIn("ЭтоПрежниеСтандартныеКнопкиНапоминания", upgrade)
        self.assertIn("ОбъектШаблона.КнопкиMAX = ОписаниеШаблона.Кнопки", upgrade)
        self.assertNotIn("ЗаполнитьОбъектСтандартногоШаблона", upgrade)
        self.assertNotIn("ШаблонСообщения =", upgrade)
        matcher = function("ЭтоПрежниеСтандартныеКнопкиНапоминания")
        self.assertIn("КнопкиВJSON(Кнопки) = КнопкиВJSON(ПрежниеКнопки)", matcher)
        self.assertIn("Возврат Ложь", matcher)

    def test_chat_only_standard_list(self):
        standards = function("СтандартныеШаблоны")
        self.assertNotIn("MAX_SURVEY_REQUEST", standards)
        self.assertNotIn('"open_app"', standards)
        self.assertNotIn("анкеты", standards)

    def test_missing_deleted_empty_or_broken_text_has_fallback(self):
        render = function("СтандартныйТекстИлиРезервный")
        for guard in ("Шаблон.Пустая()", "Шаблон.ПометкаУдаления", "ПустаяСтрока(Текст)", "Исключение"):
            self.assertIn(guard, render)
        self.assertNotIn("Записать()", render)

    def test_upgrade_command_is_visible_and_bound(self):
        ns = {"f": "http://v8.1c.ru/8.3/xcf/logform"}
        form = ET.parse(CATALOG / "Forms/ФормаСписка/Ext/Form.xml")
        commands = {e.attrib["name"] for e in form.findall("./f:Commands/f:Command", ns)}
        self.assertIn("ОбновитьСтандартныеКнопкиНапоминаний", commands)
        for element in form.findall(".//f:CommandName", ns):
            if element.text.startswith("Form.Command."):
                self.assertIn(element.text.removeprefix("Form.Command."), commands)
        items = form.find("./f:ChildItems", ns)
        ids = [e.attrib["id"] for e in items.iter() if "id" in e.attrib]
        self.assertEqual(len(ids), len(set(ids)))

    def test_reschedule_editor_and_roundtrip_source_contract(self):
        form = (CATALOG / "Forms/ФормаЭлемента/Ext/Form/Module.bsl").read_text(encoding="utf-8-sig")
        buttons = (ROOT / "CommonModules/бит_омни_КнопкиMAX/Ext/Module.bsl").read_text(encoding="utf-8-sig")
        self.assertIn('Список.Добавить("reschedule", "Перенести приём")', form)
        self.assertIn('СтрокаКнопки.Текст = "Перенести"', form)
        self.assertIn('СтрокаТаблицы.Действие = "reschedule"', buttons)
        self.assertIn('ТипКнопки = "reschedule"', buttons)
        self.assertIn('"appointment_<ИдентификаторЗаписи>_<ВерсияЗаписи>_reschedule"', buttons)


if __name__ == "__main__":
    unittest.main()
