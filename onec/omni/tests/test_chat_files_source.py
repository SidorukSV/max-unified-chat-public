"""Source contracts only; not a replacement for live 1C/MAX acceptance."""
from pathlib import Path
import unittest

EXT = Path(__file__).resolve().parents[1] / 'src/extension/бит_МедицинаОмни_ПРОФ'


class ChatFilesSource(unittest.TestCase):
    def test_operator_access_before_privilege(self):
        source = (EXT / 'CommonModules/бит_омни_ОтделенияMAXСервер/Ext/Module.bsl').read_text(encoding='utf-8-sig')
        function = source.split('Функция ОтправитьФайлОператора(', 1)[1].split('КонецФункции', 1)[0]
        self.assertLess(function.index('ПроверитьДоступККонтакту'), function.index('УстановитьПривилегированныйРежим'))
        self.assertIn('5 * 1024 * 1024', function)

    def test_rejection_before_history_and_handler(self):
        source = (EXT / 'CommonModules/бит_омни_ИнтеграцияСMAX/Ext/Module.bsl').read_text(encoding='utf-8-sig')
        function = source.split('Процедура ОбработатьСозданиеСообщения(', 1)[1].split('КонецПроцедуры', 1)[0]
        self.assertLess(function.index('ОтклонитьВходящиеВложенияMAX'), function.index('ЗаписатьВходящееСообщениеMAX'))
        reject = source.split('Процедура ОтклонитьВходящиеВложенияMAX(', 1)[1].split('КонецПроцедуры', 1)[0]
        self.assertLess(reject.index('ЗафиксироватьТранзакцию'), reject.index('ОтправитьТекстовоеСообщение'))
        self.assertIn('MAX_ATTACHMENTS_REJECTED', reject)
        self.assertIn('MAX_CLINIC_EMAIL', reject)
        self.assertIn('"contact"', reject)

    def test_recipient_snapshot_and_reschedule_attention(self):
        source = (EXT / 'DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl').read_text(encoding='utf-8-sig')
        self.assertIn('ДополнительныеПараметры.Контакт', source)
        self.assertIn('ДополнительныеПараметры.Бот', source)
        self.assertIn('Контакт <> ТекущийКонтакт', source)
        self.assertIn('Перечисления.бит_омни_СостоянияДиалоговMAX.ПереносЗаписи', source)


if __name__ == '__main__':
    unittest.main()
