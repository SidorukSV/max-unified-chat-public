param([string]$ExtensionPath = (Join-Path $PSScriptRoot '../src/extension/бит_МедицинаОмни_ПРОФ'))

# Emit a JSON-encoded BSL unit test for execute_code; no UI or database writes.
# The form is a property-bag substitute: actual customer UI hooks are not executed.
$formPath = Join-Path $ExtensionPath 'Reports/КалендарьПланирования/Forms/ФормаОтчетаУпр/Ext/Form.xml'
[xml]$form = Get-Content -Raw -Encoding UTF8 -LiteralPath $formPath
$before = $form.SelectNodes('//*[local-name()="Events"]/*[local-name()="Event"]') |
    Where-Object { $_.name -eq 'NotificationProcessing' -and $_.callType -eq 'Before' -and $_.InnerText -eq 'бит_омни_ОбработкаОповещенияПеред' }
if (@($before).Count -ne 1) { throw 'Missing before-notification event binding' }
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path (Split-Path $formPath) 'Form/Module.bsl')
$body = [regex]::Match($source, '(?s)Процедура бит_омни_ОбработкаОповещенияПеред\([^\r\n]*\)(.*?)КонецПроцедуры').Groups[1].Value
if (-not $body.Contains('ЭтотОбъект.мКлиентВзятИзДанныхЗаявки = Ложь;')) { throw 'Missing reset implementation' }
$body = $body.Replace('ЭтотОбъект.', 'ТестФорма.')
$prefix = @'
Пациент = Справочники.Клиенты.ПолучитьСсылку(Новый УникальныйИдентификатор);
Для НомерТеста = 1 По 6 Цикл
    ТестФорма = Новый Структура("мКлиентВзятИзДанныхЗаявки", Истина);
    ИмяСобытия = "НамерениеЗаписиПоДокументу";
    Параметр = Новый Структура("Клиент, бит_омни_ПереносимаяЗаявка", Пациент, Документы.Заявка.ПустаяСсылка());
    Если НомерТеста = 2 Тогда
        Параметр.бит_омни_ПереносимаяЗаявка = Документы.Заявка.ПолучитьСсылку(Новый УникальныйИдентификатор);
    ИначеЕсли НомерТеста = 3 Тогда
        Параметр.Удалить("бит_омни_ПереносимаяЗаявка");
    ИначеЕсли НомерТеста = 4 Тогда
        ИмяСобытия = "ДругоеСобытие";
    ИначеЕсли НомерТеста = 5 Тогда
        Параметр.Клиент = Справочники.Клиенты.ПустаяСсылка();
    ИначеЕсли НомерТеста = 6 Тогда
        Параметр = Неопределено;
    КонецЕсли;
'@
$suffix = @'
    ОжидаетсяСброс = НомерТеста <= 2;
    Если ТестФорма.мКлиентВзятИзДанныхЗаявки = ОжидаетсяСброс Тогда
        ВызватьИсключение "Unexpected calendar flag, case " + НомерТеста;
    КонецЕсли;
    Если ОжидаетсяСброс Тогда
        // Reproduce the standard empty-cell branch after receiving the new patient.
        Клиент = Параметр.Клиент;
        Если ТестФорма.мКлиентВзятИзДанныхЗаявки = Истина Тогда
            Клиент = Неопределено;
        КонецЕсли;
        Если Клиент <> Пациент Тогда
            ВызватьИсключение "Patient lost after empty-cell activation";
        КонецЕсли;
    КонецЕсли;
КонецЦикла;
Результат = "PASS: new booking and transfer reset stale flag; unrelated events and empty patient unchanged; empty-cell branch preserves patient (form substitute, no writes)";
'@
($prefix + "`n" + $body + "`n" + $suffix) | ConvertTo-Json -Compress
