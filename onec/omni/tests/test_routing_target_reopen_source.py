"""Routing source contracts; these checks do not execute BSL or prove runtime RLS.

Runtime acceptance still needs a disposable infobase: closed target patient and
department; a second MAX contact sharing the same patient/bot/department; retry
after durable reopen; newer inbound/reroute before retry; callback replay after
archive; ordinary operator with own, other and empty department assignments.
"""
from pathlib import Path
import re
import sys
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
    # Comments must not satisfy a call-order contract.
    return re.sub(r"(?m)^\s*//.*$", "", match.group())


class RoutingTargetReopenSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.integration = source("CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl")
        cls.departments = source("CommonModules/бит_омни_ОтделенияMAXСервер/Ext/Module.bsl")
        cls.fixture = Path(__file__).with_name("routing-target-reopen-runtime.bsl").read_text(encoding="utf-8-sig")

    def test_runtime_fixture_uses_exact_private_routing_body_and_rollback(self):
        production = routine(self.integration, "ИзменитьМаршрутизациюКонтактаВТранзакцииMAX")
        extracted = routine(self.fixture, "ТестИзменитьМаршрутизациюКонтактаВТранзакцииMAX")
        extracted = extracted.replace("ТестИзменитьМаршрутизацию", "ИзменитьМаршрутизацию")
        extracted = extracted.replace("бит_омни_ИнтеграцияСMAX.ПеревестиЗакрытыйДиалогВНовыйMAX", "ПеревестиЗакрытыйДиалогВНовыйMAX")
        self.assertEqual(re.sub(r"\s+", "", extracted), re.sub(r"\s+", "", production))
        self.assertIn("ОтменитьТранзакцию()", self.fixture)
        self.assertNotIn("ЗафиксироватьТранзакцию()", self.fixture)
        self.assertNotIn("HTTPСоединение", self.fixture)
        self.assertNotIn("ОтправитьСообщение(", self.fixture)

    def test_patient_route_opens_target_after_write_in_same_transaction(self):
        route = routine(self.integration, "ИзменитьМаршрутизациюКонтактаВТранзакцииMAX")
        self.assertLess(route.index("КонтактОбъект.Записать()"), route.index("ПеревестиЗакрытыйДиалогВНовыйMAX"))
        self.assertNotIn("ЗафиксироватьТранзакцию", route)
        patient = routine(self.integration, "ОбработатьВыборПациентаMAX")
        self.assertLess(patient.index("Клиенты.Найти(Пациент)"), patient.index("ИзменитьМаршрутизациюКонтактаMAX"))

    def test_reopen_uses_locked_actual_route_and_group_dimensions(self):
        state = routine(self.integration, "СостояниеДиалогаПодБлокировкойMAX")
        self.assertLess(state.index("ТранзакцияАктивна()"), state.index("Блокировка.Заблокировать()"))
        self.assertLess(state.index("Блокировка.Заблокировать()"), state.index("Контакт.ПолучитьОбъект()"))
        for field in ["Пациент", "Бот", "Отделение"]:
            self.assertIn(f'Элемент.УстановитьЗначение("{field}"', state)
        self.assertLess(state.index("БлокировкаСостояния.Заблокировать()"), state.index("Запись.Прочитать()"))
        after_read = state.split("Запись.Прочитать();", 1)[1]
        for field in ["Пациент", "Бот", "Отделение"]:
            self.assertIn(f"Запись.{field} =", after_read)
        self.assertNotIn("УстановитьПривилегированныйРежим", state)

    def test_reopen_rejects_disabled_deleted_or_foreign_contact_and_bot(self):
        state = routine(self.integration, "СостояниеДиалогаПодБлокировкойMAX")
        for check in ["КонтактОбъект.ПометкаУдаления", "КонтактОбъект.Заблокирован",
                      "КонтактОбъект.Бот <> Бот", "Бот.ПометкаУдаления", "Не Бот.Использовать"]:
            self.assertIn(check, state)

    def test_durable_stage_only_opens_state_and_snapshots_after_open(self):
        stage = routine(self.integration, "ФиксироватьОткрытиеДиалогаПриПриемеMAX")
        self.assertLess(stage.index("ПовторноеОбращение ="), stage.index("ПеревестиЗакрытыйДиалогВНовыйMAX"))
        self.assertLess(stage.index("ПеревестиЗакрытыйДиалогВНовыйMAX"), stage.index("ОтпечаткиСостоянияДиалогаMAX"))
        self.assertIn('Вставить("ПовторноеОбращение", ПовторноеОбращение)', stage)
        for forbidden in ["КлиентыПоТелефону", "ПодтвержденныйТелефон", "ИзменитьМаршрутизацию", "Отправить"]:
            self.assertNotIn(forbidden, stage)
        reopen = routine(self.integration, "ПеревестиЗакрытыйДиалогВНовыйMAX")
        self.assertIn("Состояние <> Перечисления.бит_омни_СостоянияДиалоговMAX.Закрыт", reopen)
        self.assertIn("СостоянияДиалоговMAX.Новый", reopen)
        self.assertIn("Ответственный = Справочники.Пользователи.ПустаяСсылка()", reopen)

    def test_stale_retry_checks_route_state_and_both_history_stores(self):
        guard = routine(self.integration, "ПовторноеОбращениеАктуальноMAX")
        self.assertNotIn('ЗначениеСвойства(КонтекстПриема, "ПовторноеОбращение"', guard)
        self.assertIn("Отпечатки.ОтпечатокМаршрута <>", guard)
        self.assertIn("Отпечатки.ОтпечатокСостояния <>", guard)
        for store in ["История", "Архив"]:
            self.assertIn(f"{store}.Контакт = &Контакт И {store}.Бот = &Бот И {store}.Входящее", guard)
            self.assertIn(f"{store}.Период >= &Период", guard)
            self.assertIn(f"{store}.ИдентификаторСообщения <> &Идентификатор", guard)
        self.assertNotIn("ПеревестиЗакрытыйДиалогВНовыйMAX(", guard)
        self.assertNotIn("ИзменитьМаршрутизацию", guard)

    def test_same_second_previous_input_is_part_of_persisted_baseline(self):
        stage = routine(self.integration, "ФиксироватьОткрытиеДиалогаПриПриемеMAX")
        self.assertIn('Вставить("ОтпечатокВходящих", ОтпечатокВходящихДиалогаMAX(Контакт, Бот))', stage)
        guard = routine(self.integration, "ПовторноеОбращениеАктуальноMAX")
        self.assertLess(guard.index("ОтпечатокВходящих = ОтпечатокВходящихДиалогаMAX"), guard.index("Новый Запрос("))
        snapshot = routine(self.integration, "ОтпечатокВходящихДиалогаMAX")
        for store in ["бит_омни_ИсторияЧатовMAX", "бит_омни_АрхивЧатовMAX"]:
            self.assertIn(store, snapshot)
        self.assertIn("КОЛИЧЕСТВО(*)", snapshot)
        self.assertIn("ОБЪЕДИНИТЬ", snapshot)
        self.assertNotIn("ОБЪЕДИНИТЬ ВСЕ", snapshot)

    def test_department_event_id_is_stable_per_callback_and_not_per_contact(self):
        callback = routine(self.integration, "ОбработатьВыборОтделенияMAX")
        self.assertIn('СтроковоеСвойство(Callback, "callback_id")', callback)
        self.assertIn("КлючСобытия = СтруктураВJSON(Callback)", callback)
        self.assertIn("ХешФункция.SHA256", callback)
        self.assertIn("Контакт, Бот, Отделение, ИдентификаторСобытия", callback)
        history = routine(self.integration, "ЗаписатьВыборОтделенияMAX")
        self.assertIn('Идентификатор = "department:" + ИдентификаторСобытия', history)
        self.assertNotIn("Контакт.УникальныйИдентификатор", history)
        self.assertLess(history.index("СообщениеЧатаУжеЗаписаноMAX"), history.index("ПеревестиЗакрытыйДиалогВНовыйMAX"))
        self.assertLess(history.index("ПеревестиЗакрытыйДиалогВНовыйMAX"), history.index("ЗаписатьСообщениеЧатаMAX"))

    def test_department_repeat_returns_before_any_history_or_state_mutation(self):
        assign = routine(self.departments, "ЗакрепитьОтделениеВТранзакции")
        repeat = assign[assign.index("Если ЗначениеЗаполнено(ОбъектКонтакта.ОтделениеMAX)"):]
        repeat = repeat[:repeat.index("КонецЕсли;")]
        self.assertIn("Возврат Результат", repeat)
        self.assertNotIn("Записать", repeat)
        self.assertLess(assign.index("ОбъектКонтакта.Записать()"), assign.index("ЗаписатьВыборОтделенияMAX"))
        self.assertIn("Контакт, Бот, Отделение, ИдентификаторСобытия", assign)

    def test_operator_safe_callback_scope_checks_authority_before_privilege(self):
        callback = routine(self.integration, "ОбработатьВыборОтделенияMAX")
        grant = callback.index("УстановитьПривилегированныйРежим(Истина)")
        for validation in ["ПолучитьСуществующийКонтакт", "Контакт.Бот = Бот", "Контакт.Идентификатор",
                           "ИдентификаторMAX", "ПодтвержденныйТелефонКонтактаMAX", "Не ПустаяСтрока(Телефон)"]:
            self.assertLess(callback.index(validation), grant)
        assignment = callback.index(".ЗакрепитьОтделение(")
        self.assertLess(callback.index("КлиентыПоТелефонуMAX"), assignment)
        self.assertEqual(callback.count("ПодтвержденныйТелефонКонтактаMAX"), 1)
        self.assertEqual(callback.count("УстановитьПривилегированныйРежим(БылПривилегированныйРежим)"), 2)
        confirmation = callback[callback.index("Если ОтделениеИзменено Тогда"):]
        self.assertIn("ОтправитьТекстовоеСообщение(ТекстОтвета", confirmation)
        self.assertIn("Если Клиенты.Количество() > 0 Тогда ЗапроситьПациентаMAX", confirmation)
        self.assertNotIn("ИзменитьМаршрутизациюКонтактаMAX", callback)
        self.assertNotIn("Возврат;", callback)

    def test_callback_queue_failure_propagates_inside_inbox_transaction(self):
        for name in ["ОбработатьВыборОтделенияMAX", "ОбработатьВыборПациентаMAX"]:
            callback = routine(self.integration, name)
            response = callback[callback.index("бит_ОтветитьНаCallbackMAX("):]
            self.assertIn("Если ТранзакцияАктивна() Тогда ВызватьИсключение", response)

    def test_operator_rls_and_non_client_callable_modules_remain_in_force(self):
        role = ET.parse(EXT / "Roles/бит_омни_ОператорОтделенияMAX/Ext/Rights.xml")
        objects = {o.findtext("r:name", namespaces=NS): o for o in role.findall("r:object", NS)}
        for name in ["Catalog.бит_омни_Контакты", "InformationRegister.бит_омни_СостоянияДиалоговMAX",
                     "InformationRegister.бит_омни_ИсторияЧатовMAX", "InformationRegister.бит_омни_АрхивЧатовMAX"]:
            read = next(r for r in objects[name].findall("r:right", NS) if r.findtext("r:name", namespaces=NS) == "Read")
            self.assertIn("&бит_омни_ОтделениеПользователяMAX", read.findtext("r:restrictionByCondition/r:condition", namespaces=NS))
        for name in ["бит_омни_ИнтеграцияСMAX", "бит_омни_ОтделенияMAXСервер"]:
            meta = ET.parse(EXT / f"CommonModules/{name}.xml")
            self.assertEqual(meta.findtext(".//m:ServerCall", namespaces=NS), "false")
            self.assertEqual(meta.findtext(".//m:Privileged", namespaces=NS), "false")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--emit-runtime-module":
        integration = source("CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl")
        body = routine(integration, "ИзменитьМаршрутизациюКонтактаВТранзакцииMAX")
        body = body.replace("Функция ИзменитьМаршрутизацию", "Функция ТестИзменитьМаршрутизацию", 1)
        body = body.replace("ПеревестиЗакрытыйДиалогВНовыйMAX(", "бит_омни_ИнтеграцияСMAX.ПеревестиЗакрытыйДиалогВНовыйMAX(")
        fixture = Path(__file__).with_name("routing-target-reopen-runtime.bsl").read_text(encoding="utf-8-sig")
        fixture = re.sub(
            r"(?<=// BEGIN EXTRACTED ROUTING HELPER: keep in sync with production \(source test\)\.)[\s\S]*?(?=// END EXTRACTED ROUTING HELPER)",
            lambda _: "\n" + body + "\n", fixture,
        )
        Path(sys.argv[2]).write_text(fixture, encoding="utf-8")
        print(sys.argv[2])
    else:
        unittest.main()
