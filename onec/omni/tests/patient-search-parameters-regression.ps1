param([string]$ExtensionPath = (Join-Path $PSScriptRoot '../src/extension/бит_МедицинаОмни_ПРОФ'))

# Static contract check: does not emulate the customer's modified common form.
$sourcePath = Join-Path $ExtensionPath 'DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl'
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourcePath
$body = [regex]::Match($source, '(?s)Процедура ОткрытьПоискПациента\(\)(.*?)КонецПроцедуры').Groups[1].Value
if ($body -notmatch 'ПараметрыПоиска\s*=\s*Новый Структура\("Пациент",\s*ПредопределенноеЗначение\("Справочник\.Клиенты\.ПустаяСсылка"\)\)') {
    throw 'Missing typed empty patient parameter for an unlinked MAX contact'
}
if ($body -notmatch 'ПолучитьФорму\("ОбщаяФорма\.ФормаПоискаКлиентаУпр",\s*ПараметрыПоиска,\s*ЭтаФорма\)') {
    throw 'Patient parameter structure must be passed when creating the common form'
}
if ($body.IndexOf('ПараметрыПоиска =') -gt $body.IndexOf('ПолучитьФорму(')) {
    throw 'Patient parameter must exist before the form creation handler runs'
}
'PASS: patient search receives typed empty patient before form creation (static contract check)'
