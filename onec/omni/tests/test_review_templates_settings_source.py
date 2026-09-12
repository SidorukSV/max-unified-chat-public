"""Source contracts for R6/R7/R10; executable BSL scenarios accompany these checks."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"


def source(path):
    return (ROOT / path).read_text(encoding="utf-8-sig")


def body(code, name):
    marker = "Функция " if "Функция " + name + "(" in code else "Процедура "
    end = "КонецФункции" if marker.startswith("Функция") else "КонецПроцедуры"
    return code.split(marker + name + "(", 1)[1].split(end, 1)[0]


class TemplateSettingsReviewContracts(unittest.TestCase):
    def setUp(self):
        self.templates = source("Catalogs/бит_омни_ШаблоныСообщений/Ext/ManagerModule.bsl")
        self.settings = source("InformationRegisters/бит_омни_ЗначенияНастроек/Ext/ManagerModule.bsl")

    def test_keyboard_has_server_object_guard(self):
        obj = source("Catalogs/бит_омни_ШаблоныСообщений/Ext/ObjectModule.bsl")
        self.assertIn("ПроверитьКнопкиШаблона(КнопкиMAX)", body(obj, "ПередЗаписью"))
        form = source("Catalogs/бит_омни_ШаблоныСообщений/Forms/ФормаЭлемента/Ext/Form/Module.bsl")
        self.assertIn("ПроверитьКнопкиШаблона(ТекущийОбъект.КнопкиMAX)", body(form, "ПередЗаписьюНаСервере"))

    def test_render_does_not_mask_bad_keyboard_as_empty(self):
        render = body(self.templates, "СформироватьКнопкиПоШаблону")
        self.assertIn("ПроверитьКнопкиШаблона", render)
        self.assertIn("ПроверитьСтруктуруКнопок(Кнопки)", render)
        catch = render.split("Исключение\n", 1)[1]
        self.assertIn("ВызватьИсключение;", catch)
        self.assertNotIn("Возврат Новый Массив", catch)

    def test_keyboard_limits_and_required_fields(self):
        validation = body(self.templates, "ПроверитьСтруктуруКнопок")
        for expected in ('Тип("Массив")', 'Тип("Структура")', '"payload", 1024',
                         '"text", 128', '"url", 2048', 'КоличествоКнопок > 100',
                         'Ряд.Количество() = 0', 'КодировкаТекста.UTF8, Ложь',
                         'ТипКнопки <> "request_contact" И ТипКнопки <> "open_app"'):
            self.assertIn(expected, validation)

    def test_algorithms_evaluate_once_for_combined_message(self):
        combined = body(self.templates, "СформироватьСообщениеПоШаблону")
        self.assertEqual(combined.count("РассчитатьПоляШаблона("), 1)
        self.assertEqual(combined.count("Контекст, ЗначенияПолей)"), 2)
        self.assertEqual(self.templates.count("Выполнить(ПолеШаблона.АлгоритмРасчета)"), 1)
        legacy = source("CommonModules/бит_омни_РаботаССообщениями/Ext/Module.bsl")
        self.assertIn("Справочники.бит_омни_ШаблоныСообщений.СформироватьТекстСообщенияПоШаблону(",
                      body(legacy, "СформироватьТекстСообщенияПоШаблону"))
        self.assertNotIn("Выполнить(", body(legacy, "СформироватьТекстСообщенияПоШаблону"))

    def test_storage_matches_defined_string_limits(self):
        ns = {"m": "http://v8.1c.ru/8.3/MDClasses", "v": "http://v8.1c.ru/8.1/data/core"}
        register = ET.parse(ROOT / "InformationRegisters/бит_омни_ЗначенияНастроек.xml")
        resources = register.findall(".//m:Resource/m:Properties", ns)
        value = next(e for e in resources if e.find("m:Name", ns).text == "Значение")
        self.assertGreaterEqual(int(value.find("m:Type/v:StringQualifiers/v:Length", ns).text), 254)

    def test_settings_guard_precedes_typed_assignment(self):
        for name in ("УстановитьЗначениеКонстантыБезРазреза", "УстановитьЗначениеКонстантыПоРазрезу"):
            setter = body(self.settings, name)
            self.assertLess(setter.index("ПроверитьЗначениеДляЗаписи"), setter.index("МенеджерЗаписи.Значение ="))
            self.assertIn("МенеджерЗаписи.Прочитать()", setter)
            self.assertEqual(setter.count("ПроверитьСохранностьЗначения"), 2)
        guard = body(self.settings, "ПроверитьЗначениеДляЗаписи")
        self.assertIn("ПределОписания", guard)
        self.assertIn("ПределХранилища", guard)

    def test_duplicate_index_check_is_explicit(self):
        manager = source("Catalogs/бит_омни_Настройки/Ext/ManagerModule.bsl")
        self.assertIn("КонстантыУдалить.Найти(СтрокиДанныеКонстанты[Индекс].Константа) = Неопределено", manager)
        self.assertNotIn('ТипЗнч(ЗначениеКонстанты) = Новый ОписаниеТипов("Булево")', self.settings)


if __name__ == "__main__":
    unittest.main()
