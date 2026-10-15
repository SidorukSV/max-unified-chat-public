"""Source contracts only; these do not execute BSL or prove runtime RLS."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

EXT = Path(__file__).resolve().parents[1] / "src/extension/бит_МедицинаОмни_ПРОФ"
NS = {"m": "http://v8.1c.ru/8.3/MDClasses", "r": "http://v8.1c.ru/8.2/roles"}


def source(path):
    return (EXT / path).read_text(encoding="utf-8-sig")


def routine(text, name):
    match = re.search(
        rf"(?:Функция|Процедура) {name}\(.*?(?:КонецФункции|КонецПроцедуры)",
        text, re.S,
    )
    if not match:
        raise AssertionError(f"Missing routine {name}")
    return match.group()


class DepartmentSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.access = source("CommonModules/бит_омни_ОтделенияMAXСервер/Ext/Module.bsl")
        cls.transport = source("CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl")
        cls.chat = source("DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl")

    def test_assignment_nonperiodical_unique_user(self):
        meta = ET.parse(EXT / "InformationRegisters/бит_омни_ОтделенияПользователейMAX.xml")
        self.assertEqual(meta.findtext(".//m:InformationRegisterPeriodicity", namespaces=NS), "Nonperiodical")
        self.assertEqual(
            [x.findtext("m:Properties/m:Name", namespaces=NS) for x in meta.findall(".//m:Dimension", NS)],
            ["Пользователь"],
        )

    def test_full_access_does_not_use_default_extension_role(self):
        access = routine(self.access, "ПолучитьПараметрыДоступаMAX")
        self.assertIn('РольДоступна("ПолныеПрава")', access)
        self.assertNotIn('РольДоступна("бит_омни_ОсновнаяРоль")', access)
        self.assertIn("Пользователи.ТекущийПользователь()", access)

    def test_access_helper_does_not_shadow_platform_function(self):
        self.assertNotRegex(self.access, r"\bПараметрыДоступа\s*\(")
        self.assertNotRegex(self.chat, r"\bПараметрыДоступа\s*\(")
        self.assertEqual(self.access.count("ПолучитьПараметрыДоступаMAX()"), 3)
        self.assertEqual(self.chat.count("бит_омни_ОтделенияMAXСервер.ПолучитьПараметрыДоступаMAX()"), 3)

    def test_empty_department_fails_closed(self):
        check = routine(self.access, "ПроверитьДоступККонтакту")
        self.assertIn("Не ЗначениеЗаполнено(Доступ.Отделение)", check)
        self.assertIn("Доступ.Отделение <> Выборка.Отделение", check)
        self.assertIn("Бот <> Выборка.Бот", check)

    def test_assignment_and_history_same_transaction(self):
        assign = routine(self.access, "ЗакрепитьОтделение")
        self.assertLess(assign.index("ТранзакцияАктивна()"), assign.index("НачатьТранзакцию()"))
        self.assertIn("ЗакрепитьОтделениеВТранзакции", assign)
        self.assertIn("ОтменитьТранзакцию()", assign)
        inner = routine(self.access, "ЗакрепитьОтделениеВТранзакции")
        self.assertLess(inner.index("Блокировка.Заблокировать()"), inner.index("Контакт.ПолучитьОбъект()"))
        self.assertIn("ЗначениеЗаполнено(ОбъектКонтакта.ОтделениеMAX)", inner)
        self.assertLess(inner.index("ОбъектКонтакта.Записать()"), inner.index("ЗаписатьВыборОтделенияMAX"))
        self.assertIn("УстановитьПривилегированныйРежим(Истина)", inner)
        self.assertEqual(inner.count("УстановитьПривилегированныйРежим(БылПривилегированныйРежим)"), 2)
        self.assertNotIn("НачатьТранзакцию()", inner)
        self.assertNotIn("ОтменитьТранзакцию()", inner)

    def test_callback_requires_existing_own_signed_contact(self):
        callback = routine(self.transport, "ОбработатьВыборОтделенияMAX")
        self.assertIn("ВЫБРАТЬ ПЕРВЫЕ 2", callback)
        self.assertIn("Контакты.Количество() = 1", callback)
        self.assertLess(callback.index("ПодтвержденныйТелефонКонтактаMAX"), callback.index("ЗакрепитьОтделение"))
        self.assertNotIn("ПолучитьКонтактПоUser", callback)

    def test_strict_payload_does_not_execute_input(self):
        parse = routine(self.access, "ОтделениеИзКоманды")
        self.assertIn("СтрДлина(Команда) <> 47", parse)
        self.assertIn('Лев(Команда, 11) <> "department:"', parse)
        self.assertIn("Новый УникальныйИдентификатор", parse)
        self.assertNotRegex(parse, r"(?i)(Выполнить|Вычислить)\s*\(")

    def test_both_new_and_existing_patients_prompted(self):
        auth = routine(self.transport, "ОбработатьПолученныйКонтактMAX")
        self.assertEqual(auth.count("ЗапроситьОтделениеMAX("), 2)
        self.assertLess(auth.index("HMACSHA256MAX"), auth.index("ЗапроситьОтделениеMAX"))
        self.assertIn("Ряды.Количество() = 30", routine(self.transport, "ЗапроситьОтделениеMAX"))

    def test_history_and_read_marks_scoped(self):
        self.assertIn("История.Контакт.ОтделениеMAX = &Отделение", routine(self.chat, "ЗагрузитьСообщенияНаСервере"))
        self.assertIn("Контакты.ОтделениеMAX = &Отделение", routine(self.chat, "ПометитьВходящиеПрочитаннымиНаСервере"))
        grouping = routine(self.chat, "СвернутыеДиалогиНаСервере")
        self.assertIn('Новый Структура("Пациент, Бот, Отделение"', grouping)

    def test_untrusted_form_context_checked_before_send(self):
        send = routine(self.chat, "ОтправитьОтветНаСервере")
        self.assertLess(send.index("ПроверитьТекущийДиалогНаСервере"), send.index("ОтправитьТекстОператора"))
        open_chat = routine(self.chat, "ОткрытьДиалогНаСервере")
        self.assertIn("ТекущийПациент = ДанныеКонтакта.Пациент", open_chat)
        self.assertNotIn("ТекущийПациент = Пациент;", open_chat)

    def test_rls_present_and_session_values_not_client_writable(self):
        role = ET.parse(EXT / "Roles/бит_омни_ОператорОтделенияMAX/Ext/Rights.xml")
        objects = {o.findtext("r:name", namespaces=NS): o for o in role.findall("r:object", NS)}
        for name in [
            "Catalog.бит_омни_Контакты", "InformationRegister.бит_омни_ИсторияЧатовMAX",
            "InformationRegister.бит_омни_СостоянияДиалоговMAX",
        ]:
            rights = {r.findtext("r:name", namespaces=NS): r for r in objects[name].findall("r:right", NS)}
            for permission in ["Read", "Update"]:
                condition = rights[permission].findtext("r:restrictionByCondition/r:condition", namespaces=NS)
                self.assertIn("&бит_омни_ОтделениеПользователяMAX", condition)
                self.assertIn("ПустаяСсылка", condition)
        for name, obj in objects.items():
            if name.startswith("SessionParameter."):
                self.assertNotIn("Set", [r.findtext("r:name", namespaces=NS) for r in obj.findall("r:right", NS)])

    def test_transport_and_secret_module_not_client_callable(self):
        for name in ["бит_омни_ИнтеграцияСMAX", "бит_омни_ОбщегоНазначенияПолныеПрава", "бит_омни_ОтделенияMAXСервер"]:
            meta = ET.parse(EXT / f"CommonModules/{name}.xml")
            self.assertEqual(meta.findtext(".//m:ServerCall", namespaces=NS), "false")

    def test_operator_facades_validate_before_privilege(self):
        for name in ["ТелефонКонтактаДляОператора", "ОтправитьТекстОператора"]:
            facade = routine(self.access, name)
            self.assertLess(facade.index("ПроверитьДоступККонтакту"), facade.index("УстановитьПривилегированныйРежим(Истина)"))
            self.assertEqual(facade.count("УстановитьПривилегированныйРежим(БылПривилегированныйРежим)"), 2)
        role = source("Roles/бит_омни_ОператорОтделенияMAX/Ext/Rights.xml")
        self.assertNotIn("<name>Catalog.бит_омни_Боты</name>", role)

    def test_automatic_queue_is_separate_trusted_server_path(self):
        queue = source("CommonModules/бит_омни_ОчередьСообщенийMAX/Ext/Module.bsl")
        enqueue = routine(queue, "ПоставитьПриЗаписи")
        self.assertIn("ТранзакцияАктивна()", enqueue)
        self.assertIn("ПоставитьПриЗаписиСлужебно", enqueue)
        self.assertEqual(enqueue.count("УстановитьПривилегированныйРежим(БылПривилегированныйРежим)"), 2)
        meta = ET.parse(EXT / "CommonModules/бит_омни_ОчередьСообщенийMAX.xml")
        self.assertEqual(meta.findtext(".//m:ServerCall", namespaces=NS), "false")


if __name__ == "__main__":
    unittest.main()
