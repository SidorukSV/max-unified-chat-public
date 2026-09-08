param(
    [string]$ExtensionPath = (Join-Path $PSScriptRoot '../src/extension/бит_МедицинаОмни_ПРОФ'),
    [ValidateSet('Full', 'SetupOnly', 'QueryOnly', 'ClaimTwice')]
    [string]$Stage = 'Full',
    [ValidateSet('Bot', 'Contact', 'Appointment')]
    [string]$SetupPart = 'Appointment'
)

# Emits a rollback-only BSL fixture for execute_code in an isolated test infobase.
# Actual query and claim implementation are extracted; no HTTP/send code is executed.
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ExtensionPath 'CommonModules/бит_омни_НапоминанияMAX/Ext/Module.bsl')
function Get-FunctionBody([string]$name) {
    $result = [regex]::Match($source, '(?s)Функция ' + $name + '\([^\r\n]*\)(.*?)КонецФункции').Groups[1].Value
    if (-not $result) { throw "Missing function $name" }
    $result
}
$query = (Get-FunctionBody 'КандидатыНаОтправку').Replace('Возврат Запрос.Выполнить().Выгрузить();', 'Кандидаты = Запрос.Выполнить().Выгрузить();')
$record = (Get-FunctionBody 'ЗаписьДоставки').Replace('Возврат Запись;', '')
$locking = [regex]::Match($source, '(?s)Процедура ЗаблокироватьДоставку\([^\r\n]*\)(.*?)КонецПроцедуры').Groups[1].Value
if (-not $locking) { throw 'Missing claim lock implementation' }
$claim = (Get-FunctionBody 'ЗахватитьДоставку').Replace('ЗаблокироватьДоставку(Бот, Кандидат, Этап);', $locking).Replace('Запись = ЗаписьДоставки(Бот, Кандидат, Этап);', $record).Replace('Возврат ПопыткаДоставки;', '')
if (($query + $claim) -match '(?m)^\s*(Для|Пока)\s' -or $claim -match '\bВозврат\b') {
    throw 'Inline stage assumptions changed: inspect loops/returns before executing'
}

$before = @'
НачатьТранзакцию();
Попытка
    Момент = ТекущаяДатаСеанса();
    Если Не бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 86400, "24H", Момент)
        Или бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 86401, "24H", Момент)
        Или бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 85500, "24H", Момент)
        Или Не бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 85501, "24H", Момент)
        Или Не бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 7200, "2H", Момент)
        Или бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 6300, "2H", Момент)
        Или бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент - 1, "2H", Момент)
        Или бит_омни_НапоминанияMAX.ВОкнеНапоминания(Момент + 7200, "24H", Момент) Тогда
        ВызватьИсключение "Reminder windows failed";
    КонецЕсли;
    Запрос = Новый Запрос("ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ Справочник.Клиенты ГДЕ НЕ ПометкаУдаления И НЕ ЭтоГруппа");
    Пациенты = Запрос.Выполнить().Выгрузить();
    Если Пациенты.Количество() = 0 Тогда ВызватьИсключение "Existing patient required"; КонецЕсли;
    Пациент = Пациенты[0].Ссылка;
    БотОбъект = Справочники.бит_омни_Боты.СоздатьЭлемент();
    БотОбъект.Наименование = "TEST_REMINDERS_" + Строка(Новый УникальныйИдентификатор);
    БотОбъект.Канал = Перечисления.бит_омни_КаналыСвязи.MAX;
    БотОбъект.Использовать = Ложь;
    БотОбъект.ОбменДанными.Загрузка = Истина;
    БотОбъект.Записать();
    Бот = БотОбъект.Ссылка;
    Контакт = Справочники.бит_омни_Контакты.СоздатьЭлемент();
    Контакт.Наименование = "TEST_REMINDERS";
    Контакт.Канал = Перечисления.бит_омни_КаналыСвязи.MAX;
    Контакт.Бот = Бот;
    Контакт.Идентификатор = "999999999999";
    Контакт.Получатель = Пациент;
    Контакт.ОбменДанными.Загрузка = Истина;
    Контакт.ДополнительныеСвойства.Вставить("НеРегистрироватьДляОбмена", Истина);
    Контакт.Записать();
    РабочиеСостояния = УправлениеЗаявками.СостоянияЗаявкиДоПриходаКлиента();
    Если РабочиеСостояния.Количество() = 0 Тогда ВызватьИсключение "Working appointment state required"; КонецЕсли;
    ТестЗаявки = Новый Массив;
    ПоддерживаетсяГрупповая = Метаданные.Документы.Заявка.Реквизиты.Найти("Групповая") <> Неопределено;
    Для Номер = 1 По 6 Цикл
        Если Номер = 6 И Не ПоддерживаетсяГрупповая Тогда Продолжить; КонецЕсли;
        ЗаявкаОбъект = Документы.Заявка.СоздатьДокумент();
        ЗаявкаОбъект.Дата = Момент;
        ЗаявкаОбъект.Клиент = Пациент;
        ЗаявкаОбъект.Состояние = РабочиеСостояния[0];
        ЗаявкаОбъект.ДатаНачала = Момент + ?(Номер = 2, 7200, 86400);
        Если Номер = 3 Тогда ЗаявкаОбъект.Состояние = Справочники.ВидыСостоянийЗаявок.Отменена; КонецЕсли;
        Если Номер = 4 Тогда ЗаявкаОбъект.ПометкаУдаления = Истина; КонецЕсли;
        Если Номер = 5 Тогда ЗаявкаОбъект.Клиент = Справочники.Клиенты.ПустаяСсылка(); КонецЕсли;
        Если Номер = 6 Тогда ЗаявкаОбъект.Групповая = Истина; КонецЕсли;
        ЗаявкаОбъект.ДатаОкончания = ЗаявкаОбъект.ДатаНачала + 1800;
        ЗаявкаОбъект.ОбменДанными.Загрузка = Истина;
        ЗаявкаОбъект.ДополнительныеСвойства.Вставить("НеРегистрироватьДляОбмена", Истина);
        ЗаявкаОбъект.Записать();
        ТестЗаявки.Добавить(ЗаявкаОбъект.Ссылка);
    КонецЦикла;
    Этап = "24H";
'@
$afterFirstQuery = @'
    Если Кандидаты.Количество() <> 1 Или Кандидаты[0].Заявка <> ТестЗаявки[0] Тогда
        ВызватьИсключение "24h query did not exclude canceled/deleted/group/unlinked/2h appointments";
    КонецЕсли;
    Кандидат = Новый Структура("Заявка,ДатаНачала,Контакт", Кандидаты[0].Заявка, Кандидаты[0].ДатаНачала, Кандидаты[0].Контакт);
'@
$afterFirstClaim = @'
    Если ПустаяСтрока(ПопыткаДоставки) Тогда ВызватьИсключение "First delivery claim failed"; КонецЕсли;
'@
$afterSecondClaim = @'
    Если Не ПустаяСтрока(ПопыткаДоставки) Тогда ВызватьИсключение "Duplicate delivery claim allowed"; КонецЕсли;
'@
$afterClaimQuery = @'
    Если Кандидаты.Количество() <> 0 Тогда ВызватьИсключение "In-flight delivery not excluded"; КонецЕсли;
    Запись = РегистрыСведений.бит_омни_ДоставкаНапоминанийMAX.СоздатьМенеджерЗаписи();
    Запись.Бот = Бот;
    Запись.Заявка = Кандидат.Заявка;
    Запись.ДатаНачала = Кандидат.ДатаНачала;
    Запись.Этап = Этап;
    Запись.Прочитать();
    Запись.АрендаДо = ТекущаяДатаСеанса() - 1;
    Запись.Записать();
'@
$afterExpiredClaim = @'
    Если Не ПустаяСтрока(ПопыткаДоставки) Тогда ВызватьИсключение "Expired uncertain claim was retried"; КонецЕсли;
    Запись.Прочитать();
    Если Запись.Состояние <> "Неопределено" Тогда ВызватьИсключение "Expired claim not marked uncertain"; КонецЕсли;
    // Same document, changed start time: independent reminder key.
    ЗаявкаОбъект = ТестЗаявки[0].ПолучитьОбъект();
    ЗаявкаОбъект.ДатаНачала = ЗаявкаОбъект.ДатаНачала - 60;
    ЗаявкаОбъект.ОбменДанными.Загрузка = Истина;
    ЗаявкаОбъект.Записать();
'@
$afterMovedQuery = @'
    Если Кандидаты.Количество() <> 1 Тогда ВызватьИсключение "Rescheduled appointment incorrectly deduplicated"; КонецЕсли;
    Этап = "2H";
'@
$beforeBlockedQuery = @'
    Если Кандидаты.Количество() <> 1 Или Кандидаты[0].Заявка <> ТестЗаявки[1] Тогда
        ВызватьИсключение "2h query mixed stages";
    КонецЕсли;
    Контакт.Заблокирован = Истина;
    Контакт.Записать();
'@
$after = @'
    Если Кандидаты.Количество() <> 0 Тогда ВызватьИсключение "Blocked MAX contact received a reminder candidate"; КонецЕсли;
    Результат = "PASS: windows; metadata/query; canceled/deleted/group/unlinked/blocked exclusions; durable claim; repeat suppression; expired uncertainty; changed-start key; stage isolation. Rolled back; no HTTP sent.";
    ОтменитьТранзакцию();
Исключение
    ОтменитьТранзакцию();
    ВызватьИсключение;
КонецПопытки;
'@
if ($Stage -ne 'Full') {
    $finish = @'
    Результат = "PASS: __STAGE__; rollback; no HTTP";
    ОтменитьТранзакцию();
Исключение
    ОтменитьТранзакцию();
    ВызватьИсключение;
КонецПопытки;
'@
    $finish = $finish.Replace('__STAGE__', "$Stage/$SetupPart")
    if ($Stage -eq 'SetupOnly') {
        $setup = $before
        if ($SetupPart -eq 'Bot') {
            $setup = $setup.Substring(0, $setup.IndexOf('    Контакт = Справочники.бит_омни_Контакты.СоздатьЭлемент();'))
        } elseif ($SetupPart -eq 'Contact') {
            $setup = $setup.Substring(0, $setup.IndexOf('    РабочиеСостояния = УправлениеЗаявками.'))
        } else {
            # One ordinary appointment is enough to isolate the standard write handler.
            $setup = $setup.Replace('Для Номер = 1 По 6 Цикл', 'Для Номер = 1 По 1 Цикл')
        }
        ($setup + "`n" + $finish) | ConvertTo-Json -Compress
        exit
    }
    $emptySetup = @'
НачатьТранзакцию();
Попытка
    Момент = ТекущаяДатаСеанса();
    Бот = Справочники.бит_омни_Боты.ПолучитьСсылку(Новый УникальныйИдентификатор);
    Этап = "24H";
'@
    if ($Stage -eq 'QueryOnly') {
        # No fixture objects are written. The random bot reference guarantees zero rows.
        $assertEmpty = 'Если Кандидаты.Количество() <> 0 Тогда ВызватьИсключение "Unexpected random-bot candidates"; КонецЕсли;'
        ($emptySetup + "`n" + $query + "`n" + $assertEmpty + "`nЭтап = `"2H`";`n" + $query + "`n" + $assertEmpty + "`n" + $finish) | ConvertTo-Json -Compress
        exit
    }
    # References are unique typed keys only; no bot/contact/appointment objects are written.
    # The only write is the isolated delivery register, rolled back with the outer transaction.
    $candidate = @'
    Кандидат = Новый Структура("Заявка,ДатаНачала,Контакт",
        Документы.Заявка.ПолучитьСсылку(Новый УникальныйИдентификатор), Момент + 86400,
        Справочники.бит_омни_Контакты.ПолучитьСсылку(Новый УникальныйИдентификатор));
'@
    ($emptySetup + "`n" + $candidate + "`n" + $claim + "`n" + $afterFirstClaim + "`n" + $claim + "`n" + $afterSecondClaim + "`n" + $finish) | ConvertTo-Json -Compress
    exit
}
($before + "`n" + $query + "`n" + $afterFirstQuery + "`n" + $claim + "`n" + $afterFirstClaim + "`n" + $claim + "`n" + $afterSecondClaim + "`n" + $query + "`n" + $afterClaimQuery + "`n" + $claim + "`n" + $afterExpiredClaim + "`n" + $query + "`n" + $afterMovedQuery + "`n" + $query + "`n" + $beforeBlockedQuery + "`n" + $query + "`n" + $after) | ConvertTo-Json -Compress
