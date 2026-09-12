"""Bounded guards for one file-send attempt; not a substitute for 1C runtime."""
from pathlib import Path
import re
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / "src" / "extension" /
          "бит_МедицинаОмни_ПРОФ" / "CommonModules" / "бит_омни_ИнтеграцияСMAX" /
          "Ext" / "Module.bsl").read_text(encoding="utf-8-sig")


def function(name):
    return re.search(r"Функция " + re.escape(name) + r"\(.*?КонецФункции", SOURCE, re.S).group()


class FileDeliveryGuards(unittest.TestCase):
    def test_upload_token_and_attempt_are_saved_before_only_http_send(self):
        body = function("ОтправитьФайлMAX")
        self.assertLess(body.index('"/api/v1/onec/attachments/upload"'), body.index("История.Записать(Истина)"))
        self.assertLess(body.index("История.Записать(Истина)"), body.index("Ответ = ОтправитьСообщениеЧерезVDS"))
        self.assertEqual(body.count("Ответ = ОтправитьСообщениеЧерезVDS"), 1)
        self.assertNotIn("Результат = ОтправитьСообщение(", body)
        self.assertNotIn("ЗаписатьСообщениеЧатаMAX(", body)
        self.assertIn('ПараметрыСообщения.Вставить("client_message_id", ИдентификаторПопытки)', body)
        self.assertIn('"token"', body)

    def test_same_history_manager_and_fixed_period_are_used_for_terminal_update(self):
        body = function("ОтправитьФайлMAX")
        history = function("ИсторияПопыткиОтправкиФайлаMAX")
        self.assertEqual(body.count("История = ИсторияПопыткиОтправкиФайлаMAX("), 1)
        self.assertEqual(body.count("История.Записать(Истина)"), 2)
        self.assertNotIn("История.Период =", body)
        self.assertNotIn("История.ИдентификаторСообщения =", body)
        self.assertEqual(history.count("История.Период = ТекущаяДатаСеанса()"), 1)
        self.assertIn('История.Статус = "Доставка неизвестна"', history)
        self.assertIn("История.ДанныеВложений = JSONВложенийMAX(Вложения)", history)
        self.assertIn('"Отправлено"', body)
        self.assertIn('Результат.delivery_status = "not_sent"', body)

    def test_response_is_correlated_and_delivery_failure_does_not_retry(self):
        body = function("КлассифицироватьОтветФайлаMAX")
        self.assertIn("Результаты.Количество() = 1", body)
        self.assertIn('"client_message_id") = ИдентификаторПопытки', body)
        self.assertIn("КлассифицироватьОтветОчередиMAX", body)
        send = function("ОтправитьФайлMAX")
        self.assertNotRegex(send, r"\b(Пока|Цикл)\b")
        self.assertIn('"unknown"', send)
        self.assertIn("Результат.ИсторияЗаписана = Ложь", send)

    def test_new_delivery_status_is_authoritative_and_legacy_fallback_is_preserved(self):
        body = function("КлассифицироватьОтветОчередиMAX")
        status_pos = body.index('Если Отправка.Свойство("delivery_status") Тогда')
        fallback_pos = body.index('ЧастиОшибки[0] = "max_api_request_failed"')
        self.assertLess(status_pos, fallback_pos)
        status_branch = body[status_pos:body.index("ТекстОшибки =", status_pos)]
        self.assertIn('"delivery_status") = "not_sent"', status_branch)
        self.assertIn("Возврат Результат;", status_branch)
        self.assertNotIn('= "unknown" Тогда', status_branch, "unknown/invalid status must stay fail-closed by default")
        self.assertIn('"Состояние,ИдентификаторСообщения,ОписаниеОшибки,КодHTTP", "Неопределено"', body)


if __name__ == "__main__":
    unittest.main()
