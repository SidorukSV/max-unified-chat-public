"""Release hardening source contracts; platform rights must be tested separately."""
import unittest
import xml.etree.ElementTree as ET
from test_departments_source import EXT, NS, source, routine


class ReleaseHardeningTests(unittest.TestCase):
    def test_reminder_role_does_not_write_service_queue(self):
        role = ET.parse(EXT / 'Roles/бит_омни_НапоминанияMAX/Ext/Rights.xml')
        for obj in role.findall('r:object', NS):
            name = obj.findtext('r:name', namespaces=NS)
            if not name.startswith('InformationRegister.'):
                continue
            rights = {r.findtext('r:name', namespaces=NS): r.findtext('r:value', namespaces=NS)
                      for r in obj.findall('r:right', NS)}
            self.assertNotEqual(rights.get('Update'), 'true')
            self.assertEqual(rights.get('Read'), 'true')

    def test_contact_identity_guard_also_covers_programmatic_write(self):
        text = source('Catalogs/бит_омни_Контакты/Ext/ObjectModule.bsl')
        guard = routine(text, 'ПередЗаписью')
        self.assertIn('ПривилегированныйРежим()', guard)
        self.assertIn('РольДоступна("ПолныеПрава")', guard)
        self.assertIn('ПроверитьДоступККонтакту(Ссылка)', guard)
        self.assertNotIn('Если ОбменДанными.Загрузка', guard)
        for field in ['Бот', 'Канал', 'Идентификатор', 'Получатель', 'ОтделениеMAX']:
            self.assertIn(f'{field} <> СохраненныйКонтакт.{field}', guard)

    def test_legacy_http_handlers_fail_closed_before_accessing_request(self):
        text = source('HTTPServices/бит_омни_Интеграция/Ext/Module.bsl')
        for name in ['CatalogsGET', 'TransactionsPOST', 'DocumentsGET', 'DocumentsPUT',
                     'DocumentsPOST', 'SettingsGET', 'MAXWebhookPOST',
                     'StartIBSessionHEAD', 'FinishIBSessionHEAD']:
            body = routine(text, name)
            self.assertIn('Возврат бит_НеиспользуемыйHTTPИнтерфейс()', body)
            self.assertNotIn('Запрос.', body)
        self.assertIn('"endpoint_disabled", 410', text)
        self.assertNotIn('Вычислить(', text)
        self.assertNotIn('Выполнить(', text)


if __name__ == '__main__':
    unittest.main()
