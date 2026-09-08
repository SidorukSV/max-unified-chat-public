param([string]$ExtensionPath = (Join-Path $PSScriptRoot '../src/extension/бит_МедицинаОмни_ПРОФ'))

# Emits pure BSL tests for execute_code, using the actual helper body. No DB or HTTP.
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ExtensionPath 'CommonModules/бит_омни_НапоминанияMAX/Ext/Module.bsl')
$body = [regex]::Match($source, '(?s)Функция ИдентификаторИзОтвета\(Ответ\)(.*?)КонецФункции').Groups[1].Value
if (-not $body.Contains('max_response')) { throw 'VDS response implementation missing' }
if ($body -match '(?m)^\s*(Для|Пока)\s') { throw 'Inline test requires a loop-free helper' }
$body = [regex]::Replace($body, 'Возврат ([^;\r\n]+);', 'ПолученныйMID = $1; Прервать;')

$mid = 'mid-test-123'
$raw = @{ message = @{ body = @{ mid = $mid } } }
$goodResult = @{ ok = $true; client_message_id = 'test'; max_response = $raw }
$cases = @(
    @{ name = 'raw message'; expected = $mid; response = $raw },
    @{ name = 'raw body'; expected = $mid; response = @{ body = @{ mid = $mid } } },
    @{ name = 'raw mid'; expected = $mid; response = @{ mid = $mid } },
    @{ name = 'VDS single success'; expected = $mid; response = @{ ok = $true; sent = 1; failed = 0; results = @($goodResult) } },
    @{ name = 'VDS failed even with MID'; expected = ''; response = @{ ok = $false; sent = 0; failed = 1; mid = $mid; results = @($goodResult) } },
    @{ name = 'VDS failed item'; expected = ''; response = @{ ok = $true; sent = 1; failed = 0; results = @(@{ ok = $false; max_response = $raw }) } },
    @{ name = 'VDS no max_response'; expected = ''; response = @{ ok = $true; sent = 1; failed = 0; results = @(@{ ok = $true }) } },
    @{ name = 'VDS empty results'; expected = ''; response = @{ ok = $true; sent = 1; failed = 0; results = @() } },
    @{ name = 'VDS multiple results'; expected = ''; response = @{ ok = $true; sent = 1; failed = 0; results = @($goodResult, $goodResult) } },
    @{ name = 'VDS wrong counters'; expected = ''; response = @{ ok = $true; sent = 2; failed = 0; results = @($goodResult) } },
    @{ name = 'VDS missing counters'; expected = ''; response = @{ ok = $true; results = @($goodResult) } },
    @{ name = 'VDS only ok plus spoof MID'; expected = ''; response = @{ ok = $true; mid = $mid } },
    @{ name = 'VDS results not array'; expected = ''; response = @{ ok = $true; sent = 1; failed = 0; results = $goodResult } },
    @{ name = 'missing raw MID'; expected = ''; response = @{ message = @{ body = @{} } } },
    @{ name = 'non-string MID'; expected = ''; response = @{ message = @{ body = @{ mid = 123 } } } },
    @{ name = 'null response'; expected = ''; response = $null }
)
$jsonLiteral = ($cases | ConvertTo-Json -Compress -Depth 12).Replace('"', '""')
$before = @'
Чтение = Новый ЧтениеJSON;
Чтение.УстановитьСтроку("__CASES__");
Кейсы = ПрочитатьJSON(Чтение);
Чтение.Закрыть();
Для Каждого Кейс Из Кейсы Цикл
    Ответ = Кейс.response;
    ПолученныйMID = "__not_returned__";
    Для НомерПрохода = 1 По 1 Цикл
'@
$after = @'
    КонецЦикла;
    Если ПолученныйMID <> Кейс.expected Тогда
        ВызватьИсключение "MID response failed: " + Кейс.name + " => " + ПолученныйMID;
    КонецЕсли;
КонецЦикла;
Результат = "PASS: rawMAX and VDS single-success MID, failure/missing/malformed/multiple result rejection; cases=" + Кейсы.Количество();
'@
($before.Replace('__CASES__', $jsonLiteral) + "`n" + $body + "`n" + $after) | ConvertTo-Json -Compress
