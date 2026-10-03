#!/usr/bin/env bash
# Windows check of the NTConsult thin installer on a DISPOSABLE Azure VM (there is no managed Windows machine to test on).
# Installs from the real blob (install.ps1 as an ordinary user with accent + space in the profile path),
# then restarts the VM: the autologon session fires the AtLogon task, which must bring the collector and updater up.
# Everything is deleted at the end (also on failure). NOT an EDR test: the VM has Defender only, no corporate EDR.
#
# Usage: NTC_BLOB_BASE_URL=https://<account>.blob.core.windows.net/pilot bash tools/ntc-azure-windows-test.sh
# Needs: az login, subscription "Projeto Beat" (override with AZURE_SUBSCRIPTION). No RDP/inbound rule, no public IP.
# The test key is synthetic (ntcp_ + 32 chars): it is never a credential and only ever lives in this process and
# the VM's one-shot script. The VM admin password is random and never printed.
set -euo pipefail

: "${NTC_BLOB_BASE_URL:?}"
SUB="${AZURE_SUBSCRIPTION:-Projeto Beat}"
LOC="${AZURE_LOCATION:-eastus2}"
SIZE="${VM_SIZE:-Standard_D2s_v3}"
RG="${NTC_WIN_RG:-rg-ntc-win-smoke-$RANDOM}"
VM="ntcwin"
USERNAME="Jose Teste (accent added in PowerShell)" # real name is "Jos"+[char]0xE9+" Teste": az run-command does not deliver non-ASCII text intact
TEST_KEY="ntcp_WINSMOKE$(printf 'A%.0s' $(seq 1 25))" # ntcp_ + 33 chars, synthetic
PASS=0; FAIL=0

cleanup() {
  local rc=$?
  if [ "${NTC_WIN_KEEP:-}" = 1 ]; then echo "KEPT $RG (NTC_WIN_KEEP=1): delete it with az group delete -n $RG --subscription '$SUB' --yes"; exit "$rc"; fi
  echo "==> deleting $RG"
  az group delete -n "$RG" --subscription "$SUB" --yes >/dev/null 2>&1 || true
  if [ "$(az group exists -n "$RG" --subscription "$SUB")" = "false" ]; then echo "group $RG gone (az group exists = false)"; else echo "WARNING: $RG still exists"; fi
  exit "$rc"
}
trap cleanup EXIT

ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }

rc() { # <script file or inline> -> stdout of the VM script
  az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunPowerShellScript --scripts "$1" \
    --query 'value[0].message' -o tsv 2>&1
}

ADMINPW="Aa1-$(openssl rand -hex 12)"
USERPW="Bb2-$(openssl rand -hex 12)"

echo "==> creating $RG ($SIZE, $LOC)"
az group create -n "$RG" -l "$LOC" --subscription "$SUB" \
  --tags purpose=ntc-windows-smoke owner=francisco.prestes expires="$(date -u -v+1d +%F 2>/dev/null || date -u -d '+1 day' +%F)" -o none
az vm create -g "$RG" -n "$VM" --subscription "$SUB" --image Win2022Datacenter --size "$SIZE" \
  --admin-username ntcadmin --admin-password "$ADMINPW" --public-ip-address "" --nsg-rule NONE \
  --tags purpose=ntc-windows-smoke -o none

echo "==> local user 'Jos<e-acute> Teste' + autologon (interactive logon on every boot)"
rc "
\$ErrorActionPreference='Stop'
\$u = 'Jos' + [char]0xE9 + ' Teste'
\$sec = ConvertTo-SecureString '$USERPW' -AsPlainText -Force
New-LocalUser -Name \$u -Password \$sec -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member \$u
\$k='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty \$k AutoAdminLogon 1; Set-ItemProperty \$k DefaultUserName \$u
Set-ItemProperty \$k DefaultPassword '$USERPW'; Set-ItemProperty \$k DefaultDomainName \$env:COMPUTERNAME
" >/dev/null
az vm restart -g "$RG" -n "$VM" --subscription "$SUB" -o none

wait_session() {
  local i out
  for i in $(seq 1 30); do
    out="$(rc "(Get-CimInstance Win32_ComputerSystem).UserName")" || true
    # match on the ASCII tail only: run-command output may come back in another codepage
    case "$out" in *Teste*) return 0 ;; esac
    sleep 10
  done
  return 1
}
diag() {
  echo "--- diagnostics (no secrets)"
  rc '"console user: " + (Get-CimInstance Win32_ComputerSystem).UserName
quser 2>&1
Get-LocalUser | Select-Object Name,Enabled | Format-Table | Out-String
$k="HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
"AutoAdminLogon=" + (Get-ItemProperty $k).AutoAdminLogon + " DefaultUserName=" + (Get-ItemProperty $k).DefaultUserName
Get-WinEvent -FilterHashtable @{LogName="Security";Id=4624,4625} -MaxEvents 6 -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id | Format-Table | Out-String' | cut -c1-200
}
wait_session && ok "autologon: interactive session of '$USERNAME'" || { bad "autologon session did not appear"; diag; exit 1; }

echo "==> install from the blob in the user's own session"
rc "
\$u = (Get-LocalUser | Where-Object Name -like 'Jos*').Name
New-Item -ItemType Directory -Force C:\ntc | Out-Null
Set-Content C:\ntc\run-install.ps1 -Encoding UTF8 -Value @'
& {
\$env:NTC_PILOT_CHAVE = '$TEST_KEY'
\$env:NTC_PILOT_EMAIL = 'win@ntconsult.com.br'
\$env:NTC_PILOT_BLOB_URL = '$NTC_BLOB_BASE_URL'
try { irm '$NTC_BLOB_BASE_URL/install.ps1' | iex } catch { \"ERRO: \$_\" }
\"exit=\$LASTEXITCODE\"
} *> C:\ntc\install.log
'@
icacls C:\ntc /grant \"\${u}:(OI)(CI)M\" | Out-Null
\$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\ntc\run-install.ps1'
\$p = New-ScheduledTaskPrincipal -UserId \"\$env:COMPUTERNAME\\\$u\" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ntc-install -Action \$a -Principal \$p | Out-Null
Start-ScheduledTask -TaskName ntc-install
" >/dev/null
for i in $(seq 1 60); do
  st="$(rc "(Get-ScheduledTask -TaskName ntc-install).State")" || true
  case "$st" in *Running*) sleep 10 ;; *) break ;; esac
done
echo "--- install task"; rc '(Get-ScheduledTaskInfo -TaskName ntc-install).LastTaskResult'
LOG="$(rc "if (Test-Path C:\ntc\install.log) { Get-Content C:\ntc\install.log -Raw } else { 'NO install.log' }")"
echo "$LOG" | tail -12 | sed "s/$TEST_KEY/<chave>/g" | cut -c1-200

VERIFY="$(cat <<'PS'
$ud = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*Teste" }).LocalPath
$dd = Join-Path $ud ".loongsuite-pilot"
$cfg = Join-Path $dd "config.json"
"profile=$ud"
"datadir_exists=" + (Test-Path $dd)
"config_exists=" + (Test-Path $cfg)
"--- icacls config.json"; icacls $cfg
$ok = @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")
$extra = @((Get-Acl $cfg).Access | Where-Object { $_.IdentityReference.Value -notin $ok -and $_.IdentityReference.Value -notlike "*Teste" })
"acl_extra_principals=" + $extra.Count + " " + (($extra | ForEach-Object { $_.IdentityReference.Value }) -join ",")
"--- tasks"
$tasks = @(Get-ScheduledTask -TaskPath "\LoongsuitePilot\*" -ErrorAction SilentlyContinue)
$tasks | ForEach-Object { "task " + $_.TaskName + " state=" + $_.State + " triggers=" + (($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ",") }
"logon_trigger_tasks=" + @($tasks | Where-Object { $_.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" } }).Count
"--- node processes (owner)"
$nodes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" })
$rows = $nodes | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; [pscustomobject]@{ Id = $_.ProcessId; Owner = $o.User; Cmd = $_.CommandLine } }
$rows | ForEach-Object { "proc " + $_.Id + " owner=" + $_.Owner + " " + $_.Cmd }
"updater_nodes=" + @($rows | Where-Object { $_.Cmd -match "updater" }).Count
"collector_nodes=" + @($rows | Where-Object { $_.Cmd -notmatch "updater" }).Count
"nodes_owned_by_test_user=" + @($rows | Where-Object { $_.Owner -like "Jos*" }).Count + "/" + $rows.Count
"--- key in files"
$hits = Get-ChildItem $dd -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\versions\\|\\package\\" } | Select-String -Pattern "ntcp_WINSMOKE" -SimpleMatch -List
"key_hits=" + (@($hits).Count) + " files=" + (($hits | ForEach-Object { Split-Path $_.Path -Leaf }) -join ",")
"--- key in process command lines"
"key_in_cmdline=" + @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "ntcp_WINSMOKE" }).Count
PS
)"
OUT1="$(rc "$VERIFY")"
echo "$OUT1" | sed "s/$TEST_KEY/<chave>/g" | head -60

check() { # <name> <pattern in OUT>
  if printf '%s' "$OUT" | grep -Eq "$2"; then ok "$1"; else bad "$1"; fi
}
OUT="$OUT1"
check "data dir under a profile with accent + space" 'profile=.*Jos'
check "config.json exists" 'config_exists=True'
check "key only in config.json (by design, user-only ACL), nowhere else" 'key_hits=1 files=config.json'
check "key absent from every process command line" 'key_in_cmdline=0'
check "a node process of the collector exists" 'collector_nodes=[1-9]'
check "every node process runs as the test user" 'nodes_owned_by_test_user=([1-9][0-9]*)/\1( |$)'
check "updater daemon is running" 'updater_nodes=[1-9]'
check "AtLogon trigger registered (collector and updater tasks)" 'logon_trigger_tasks=2'
check "config.json ACL: only the user, SYSTEM and Administrators" 'acl_extra_principals=0 '

echo "==> restart: AtLogon task must bring the collector back"
az vm restart -g "$RG" -n "$VM" --subscription "$SUB" -o none
wait_session && ok "autologon again after restart" || bad "no session after restart"
sleep 60
OUT2="$(rc "$VERIFY")"
OUT="$OUT2"
echo "$OUT2" | sed "s/$TEST_KEY/<chave>/g" | sed -n '/node processes/,/key in files/p' | cut -c1-200
check "collector up after logoff/logon (AtLogon)" 'collector_nodes=[1-9]'
check "updater up after logoff/logon" 'updater_nodes=[1-9]'

echo "----"; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
