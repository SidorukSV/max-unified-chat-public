"""Source contracts only; actual effective permissions require a 1C session."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"
NS = {"r": "http://v8.1c.ru/8.2/roles", "m": "http://v8.1c.ru/8.3/MDClasses"}


class BaseRoleContracts(unittest.TestCase):
    def test_minimal_permissions_only(self):
        role = ET.parse(ROOT / "Roles/бит_омни_БазоваяРоль/Ext/Rights.xml").getroot()
        actual = {}
        for obj in role.findall("r:object", NS):
            actual[obj.findtext("r:name", namespaces=NS)] = {
                right.findtext("r:name", namespaces=NS)
                for right in obj.findall("r:right", NS)
                if right.findtext("r:value", namespaces=NS) == "true"
            }
        self.assertEqual(actual, {
            "Catalog.бит_омни_Рассылки": {"Read"},
            "Catalog.бит_омни_СхемыКомпоновкиДанных": {"Read"},
            "Catalog.бит_омни_ШаблоныСообщений": {"Read"},
            "InformationRegister.бит_омни_АктивныеРассылки": {"Read"},
            "SessionParameter.бит_омни_КешОбъектовДляРассылки": {"Get"},
            "SessionParameter.бит_омни_ОтделениеПользователяMAX": {"Get"},
            "SessionParameter.бит_омни_ПолныеПраваMAX": {"Get"},
            "Configuration.бит_МедицинаМАКС": {
                "MainWindowModeNormal",
                "MainWindowModeWorkplace",
                "MainWindowModeEmbeddedWorkplace",
                "MainWindowModeFullscreenWorkplace",
                "MainWindowModeKiosk",
                "AnalyticsSystemClient",
            },
        })
        self.assertEqual(role.findtext("r:setForNewObjects", namespaces=NS), "false")

    def test_role_registered_and_default(self):
        config = ET.parse(ROOT / "Configuration.xml")
        self.assertIn("бит_омни_БазоваяРоль", [e.text for e in config.findall(".//m:ChildObjects/m:Role", NS)])
        defaults = config.find(".//m:DefaultRoles", NS)
        self.assertIn("Role.бит_омни_БазоваяРоль", [e.text for e in defaults])

    def test_cache_writers_share_server_only_setter(self):
        module = ROOT / "CommonModules/бит_омни_ОбщегоНазначения"
        code = (module / "Ext/Module.bsl").read_text(encoding="utf-8-sig")
        setter = code.split("Процедура УстановитьКешОбъектовДляРассылок(Кеш) Экспорт", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertIn("БылПривилегированныйРежим = ПривилегированныйРежим()", setter)
        self.assertEqual(setter.count("УстановитьПривилегированныйРежим(БылПривилегированныйРежим)"), 2)
        self.assertIn("ВызватьИсключение;", setter)
        meta = ET.parse(ROOT / "CommonModules/бит_омни_ОбщегоНазначения.xml")
        self.assertEqual(meta.findtext(".//m:ServerCall", namespaces=NS), "false")
        for path in ["Ext/SessionModule.bsl", "Catalogs/бит_омни_Рассылки/Ext/ObjectModule.bsl",
                     "InformationRegisters/бит_омни_АктивныеРассылки/Ext/RecordSetModule.bsl"]:
            caller = (ROOT / path).read_text(encoding="utf-8-sig")
            self.assertIn("УстановитьКешОбъектовДляРассылок(Кеш)", caller)
            self.assertNotIn("КешОбъектовДляРассылки =", caller)

    def test_source_business_data_not_privileged(self):
        code = (ROOT / "CommonModules/бит_омни_ПодпискиНаСобытия/Ext/Module.bsl").read_text(encoding="utf-8-sig")
        self.assertNotIn("УстановитьПривилегированныйРежим", code)
        self.assertIn("бит_ПодготовкаУведомленийMAX.ЗафиксироватьДоЗаписи(Источник)", code)
        self.assertNotIn("ВыполнитьСхему", code)
        preparation = (ROOT / "CommonModules/бит_ПодготовкаУведомленийMAX/Ext/Module.bsl").read_text(encoding="utf-8-sig")
        after = preparation.split("Процедура ЗафиксироватьПослеЗаписи(", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertLess(after.index("После = СнимокРеквизитов(Источник)"), after.index("УстановитьПривилегированныйРежим(Истина)"))
        before = preparation.split("Процедура ЗафиксироватьДоЗаписи(", 1)[1].split("КонецПроцедуры", 1)[0]
        self.assertLess(before.index("УстановитьПривилегированныйРежим(ПрежнийРежим)"), before.index("До = СнимокРеквизитов"))


if __name__ == "__main__":
    unittest.main()
