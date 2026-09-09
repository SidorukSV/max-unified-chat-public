param([string]$ExtensionPath = (Join-Path $PSScriptRoot '../src/extension/бит_МедицинаОмни_ПРОФ'))

$ErrorActionPreference = 'Stop'
function Read-Source([string]$RelativePath) {
    Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ExtensionPath $RelativePath)
}
function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$mailings = Read-Source 'Catalogs/бит_омни_Рассылки/Ext/ManagerModule.bsl'
$templates = Read-Source 'Catalogs/бит_омни_ШаблоныСообщений/Ext/ManagerModule.bsl'
$immediate = [regex]::Match($mailings, '(?s)Функция СоздатьСтандартныеРассылкиЗаписейMAX\(Бот\).*?КонецФункции').Value
$reminders = [regex]::Match($mailings, '(?s)Функция СоздатьСтандартныеНапоминанияЗаписейMAX\(Бот\).*?КонецФункции').Value
Require ($immediate.Length -gt 0) 'Immediate notification command missing'
Require ($immediate.Contains('"MAX_APPOINTMENT_CREATED"')) 'Created notification missing'
Require (([regex]::Matches($immediate, '= СоздатьСтандартнуюРассылку\(')).Count -eq 1) 'Immediate command must create only one mailing'
Require (([regex]::Matches($immediate, 'Если АктивироватьРассылкуЕслиНужно\(')).Count -eq 1) 'Immediate command must activate only one mailing'
Require ($reminders.Contains('"MAX_APPOINTMENT_REMINDER_24H,MAX_APPOINTMENT_REMINDER_2H"')) 'Both delayed reminders must remain'
Require (-not $mailings.Contains('MAX_APPOINTMENT_CONFIRM_REQUEST')) 'Retired mailing recreated'
Require (-not $templates.Contains('MAX_APPOINTMENT_CONFIRM_REQUEST')) 'Retired template recreated'
Require ($templates.Contains('"callback", "Подтвердить"')) 'Confirm callback missing'
Require ($templates.Contains('"callback", "Отменить"')) 'Cancel callback missing'
$created = [regex]::Match($templates, '(?s)"MAX_APPOINTMENT_CREATED",.*?\);').Value
Require (-not $created.Contains('КнопкиВJSON')) 'Created notification must not ask for confirmation'

[xml]$configuration = Read-Source 'Configuration.xml'
Require ($configuration.SelectNodes('//*[local-name()="CommonPicture" and text()="КрасныйКруг"]').Count -eq 0) 'Borrowed red picture still registered'
Require (-not (Test-Path -LiteralPath (Join-Path $ExtensionPath 'CommonPictures/КрасныйКруг.xml'))) 'Borrowed red picture file still present'
Require (-not (Read-Source 'ConfigDumpInfo.xml').Contains('CommonPicture.КрасныйКруг')) 'Dump index retains red picture'
$calendar = Read-Source 'Reports/КалендарьПланирования/Forms/ФормаОтчетаУпр/Ext/Form.xml'
[xml]$calendarXml = $calendar
Require (-not $calendar.Contains('CommonPicture.КрасныйКруг')) 'Calendar retains red picture reference'
Require ($calendarXml.SelectNodes('//*[local-name()="PictureField" and @name="ДокументыОчередиНеотработанный"]').Count -eq 2) 'Calendar field or base-form field was removed instead of its picture'
$chat = Read-Source 'DataProcessors/бит_омни_ЕдиныйЧат/Forms/Форма/Ext/Form/Module.bsl'
Require (-not $chat.Contains('ОформлениеКругКрасный')) 'Chat still requires red indicator'
Require ($chat.Contains('Заголовок = "Онлайн"') -and $chat.Contains('Заголовок = "Офлайн"')) 'Chat state labels missing'

Write-Output 'PASS: one immediate notification, two delayed reminders, no retired template/mailing, no red picture dependency; calendar fields and chat labels preserved. Static source checks only; no database writes or HTTP.'
