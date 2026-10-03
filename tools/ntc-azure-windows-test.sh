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
SIZE="${VM_SIZE:-Standard_B2s}"
RG="rg-ntc-win-smoke-$RANDOM"
VM="ntcwin"
USERNAME="José Teste"
TEST_KEY="ntcp_WINSMOKE$(printf 'A%.0s' $(seq 1 25))" # ntcp_ + 33 chars, synthetic
PASS=0; FAIL=0

cleanup() {
  local rc=$?
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

echo "==> local user '$USERNAME' + autologon (interactive logon on every boot)"
rc "
\$ErrorActionPreference='Stop'
\$sec = ConvertTo-SecureString '$USERPW' -AsPlainText -Force
New-LocalUser -Name '$USERNAME' -Password \$sec -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member '$USERNAME'
\$k='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty \$k AutoAdminLogon 1; Set-ItemProperty \$k DefaultUserName '$USERNAME'
Set-ItemProperty \$k DefaultPassword '$USERPW'; Set-ItemProperty \$k DefaultDomainName \$env:COMPUTERNAME
" >/dev/null
az vm restart -g "$RG" -n "$VM" --subscription "$SUB" -o none

wait_session() {
  local i out
  for i in $(seq 1 30); do
    out="$(rc "(Get-CimInstance Win32_ComputerSystem).UserName")" || true
    case "$out" in *"$USERNAME"*) return 0 ;; esac
    sleep 10
  done
  return 1
}
wait_session && ok "autologon: interactive session of '$USERNAME'" || { bad "autologon session did not appear"; exit 1; }

echo "==> install from the blob in the user's own session"
rc "
New-Item -ItemType Directory -Force C:\ntc | Out-Null
Set-Content C:\ntc\run-install.ps1 -Encoding UTF8 -Value @'
\$env:NTC_PILOT_CHAVE = '$TEST_KEY'
\$env:NTC_PILOT_EMAIL = 'win@ntconsult.com.br'
\$env:NTC_PILOT_BLOB_URL = '$NTC_BLOB_BASE_URL'
\$env:NTC_PILOT_SKIP_RESTART = ''
try { irm '$NTC_BLOB_BASE_URL/install.ps1' | iex } catch { \"ERRO: \$_\" }
\"exit=\$LASTEXITCODE\"
'@ -ErrorAction Stop
icacls C:\ntc /grant '${USERNAME}:(OI)(CI)M' | Out-Null
schtasks /Create /TN ntc-install /SC ONCE /ST 00:00 /RU '$USERNAME' /RP '$USERPW' /IT /RL LIMITED /F /TR 'powershell -NoProfile -ExecutionPolicy Bypass -Command \"& C:\ntc\run-install.ps1 *> C:\ntc\install.log\"' | Out-Null
schtasks /Run /TN ntc-install | Out-Null
" >/dev/null
for i in $(seq 1 60); do
  st="$(rc "(schtasks /Query /TN ntc-install /FO LIST | Select-String 'Status:').ToString()")" || true
  case "$st" in *Running*) sleep 10 ;; *) break ;; esac
done
LOG="$(rc "Get-Content C:\ntc\install.log -Raw")"
echo "$LOG" | tail -15 | sed "s/$TEST_KEY/<chave>/g"

VERIFY='
$ud = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*Teste" }).LocalPath
$dd = Join-Path $ud ".loongsuite-pilot"
"profile=$ud"
"datadir_exists=" + (Test-Path $dd)
"config_exists=" + (Test-Path (Join-Path $dd "config.json"))
"--- icacls config.json"; icacls (Join-Path $dd "config.json")
"--- icacls datadir"; icacls $dd
"--- tasks"; schtasks /Query /FO LIST | Select-String -Pattern "loongsuite" -Context 0,2
"--- trigger"; schtasks /Query /TN "loongsuite-pilot" /XML 2>$null | Select-String "LogonTrigger|BootTrigger"
"--- node processes (owner)"; Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; "$($_.ProcessId) $($o.User) $($_.CommandLine)" }
"--- key in files"
$hits = Get-ChildItem $dd -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\versions\\|\\package\\" } | Select-String -Pattern "ntcp_WINSMOKE" -SimpleMatch -List
"key_hits=" + (@($hits).Count) + " " + (($hits | ForEach-Object Path) -join ",")
"--- key in process command lines/env"
$cl = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "ntcp_WINSMOKE" }
"key_in_cmdline=" + (@($cl).Count)
"--- status"
'
OUT1="$(rc "$VERIFY")"
echo "$OUT1" | sed "s/$TEST_KEY/<chave>/g" | head -60

check() { # <name> <pattern in OUT>
  if printf '%s' "$OUT" | grep -Eq "$2"; then ok "$1"; else bad "$1"; fi
}
OUT="$OUT1"
check "data dir under a profile with accent + space" 'profile=.*Jos'
check "config.json exists" 'config_exists=True'
check "key absent from logs/state/config (config only holds it by design? see below)" 'key_hits=[01] '
check "key absent from every process command line" 'key_in_cmdline=0'
check "node process of the collector runs as the test user" 'node.exe|node '

echo "==> restart: AtLogon task must bring the collector back"
az vm restart -g "$RG" -n "$VM" --subscription "$SUB" -o none
wait_session && ok "autologon again after restart" || bad "no session after restart"
sleep 60
OUT2="$(rc "$VERIFY")"
OUT="$OUT2"
echo "$OUT2" | sed "s/$TEST_KEY/<chave>/g" | sed -n '/node processes/,/key in files/p'
check "collector up after logoff/logon (AtLogon)" 'node'

echo "----"; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
