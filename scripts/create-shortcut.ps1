# Създава икона „Ясно SEO“ на десктопа. Пуска се с: npm run shortcut
$app = Split-Path -Parent $PSScriptRoot
$desk = [Environment]::GetFolderPath('Desktop')
$tmp = Join-Path $desk 'YasnoSEO-tmp.lnk'   # WScript.Shell не записва кирилски имена, затова преименуваме после
$final = Join-Path $desk ([string][char]0x042F + [char]0x0441 + [char]0x043D + [char]0x043E + ' SEO.lnk')  # „Ясно SEO.lnk“
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($tmp)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + (Join-Path $app 'open-yasno.vbs') + '"'
$s.WorkingDirectory = $app
$s.IconLocation = (Join-Path $app 'assets\yasno.ico') + ',0'
$s.Description = 'Yasno SEO'
$s.Save()
if (Test-Path $final) { Remove-Item $final -Force }
Rename-Item $tmp (Split-Path -Leaf $final)
Write-Host "Иконата е създадена: $final"
