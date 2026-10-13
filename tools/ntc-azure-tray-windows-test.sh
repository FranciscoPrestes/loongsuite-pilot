#!/usr/bin/env bash
# NT TES collector + tray panel on a DISPOSABLE Windows Server VM in Azure (no public IP, no RDP rule).
# Installs from the real blob (thin install.ps1, as an ordinary user in an interactive autologon session), then:
#   1. waits for the collector to download, verify and install the tray under %USERPROFILE%\.loongsuite-pilot\tray\<v>\
#   2. reports whether the tray survives WITHOUT the WebView2 runtime (Server images do not ship it)
#   3. installs the WebView2 runtime (what Windows 10/11 clients already have), restarts the tray with the panel
#      forced open (NTC_TES_SHOW=1) and checks its window from inside the user's session
#   4. a second launch must reuse the running tray (single instance)
# Everything is deleted at the end (also on failure).
#
# Usage: NTC_BLOB_BASE_URL=https://<account>.blob.core.windows.net/pilot [NTC_CHANNEL=canary|stable] bash tools/ntc-azure-tray-windows-test.sh
# Needs: az login, subscription "Projeto Beat" (override with AZURE_SUBSCRIPTION). The test key is synthetic.
set -euo pipefail

: "${NTC_BLOB_BASE_URL:?}"
SUB="${AZURE_SUBSCRIPTION:-Projeto Beat}"
LOC="${AZURE_LOCATION:-eastus2}"
SIZE="${VM_SIZE:-Standard_D2s_v3}"
CHANNEL="${NTC_CHANNEL:-canary}"
RG="${NTC_WIN_RG:-rg-ntc-tray-win-$RANDOM}"
VM="ntcwin"
TEST_KEY="ntcp_WINSMOKE$(printf 'A%.0s' $(seq 1 25))"
PASS=0; FAIL=0; CREATED=0
W="$(mktemp -d)"

cleanup() {
  local rc=$?
  rm -rf "$W"
  [ "$CREATED" = 1 ] || exit "$rc"
  if [ "${NTC_WIN_KEEP:-}" = 1 ]; then echo "KEPT $RG: az group delete -n $RG --subscription '$SUB' --yes"; exit "$rc"; fi
  echo "==> deleting $RG"
  az group delete -n "$RG" --subscription "$SUB" --yes >/dev/null 2>&1 || true
  [ "$(az group exists -n "$RG" --subscription "$SUB")" = "false" ] && echo "group $RG gone" || echo "ERROR: $RG still exists, delete it by hand"
  exit "$rc"
}
trap cleanup EXIT

ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
info() { echo "INFO  $1"; }

rc() { # PowerShell file (as SYSTEM) -> its stdout
  az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunPowerShellScript --scripts "@$1" \
    --query 'value[0].message' -o tsv 2>&1
}
rcs() { printf '%s\n' "$1" > "$W/inline.ps1"; rc "$W/inline.ps1"; }
val() { printf '%s\n' "$1" | tr -d '\r' | sed -n "s/^$2=//p" | tail -1; }

[ "$(az group exists -n "$RG" --subscription "$SUB")" = "false" ] || { echo "refusing: $RG already exists" >&2; exit 2; }
ADMINPW="Aa1-$(openssl rand -hex 12)"; USERPW="Bb2-$(openssl rand -hex 12)"
echo "==> creating $RG ($SIZE, $LOC, channel=$CHANNEL)"
az group create -n "$RG" -l "$LOC" --subscription "$SUB" \
  --tags purpose=ntc-windows-tray-smoke owner=francisco.prestes expires="$(date -u -v+1d +%F 2>/dev/null || date -u -d '+1 day' +%F)" -o none
CREATED=1
az vm create -g "$RG" -n "$VM" --subscription "$SUB" --image Win2022Datacenter --size "$SIZE" \
  --admin-username ntcadmin --admin-password "$ADMINPW" --public-ip-address "" --nsg-rule NONE \
  --tags purpose=ntc-windows-tray-smoke -o none

echo "==> local user 'ntcuser' + autologon"
rcs "
\$sec = ConvertTo-SecureString '$USERPW' -AsPlainText -Force
New-LocalUser -Name ntcuser -Password \$sec -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member ntcuser
\$k='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty \$k AutoAdminLogon 1; Set-ItemProperty \$k DefaultUserName ntcuser
Set-ItemProperty \$k DefaultPassword '$USERPW'; Set-ItemProperty \$k DefaultDomainName \$env:COMPUTERNAME
" >/dev/null
az vm restart -g "$RG" -n "$VM" --subscription "$SUB" -o none
for i in $(seq 1 30); do
  out="$(rcs '(Get-CimInstance Win32_ComputerSystem).UserName')" || true
  case "$out" in *ntcuser*) ok "autologon: interactive session of ntcuser"; break ;; esac
  [ "$i" = 30 ] && { bad "autologon session did not appear"; exit 1; }
  sleep 10
done

# run a PowerShell body inside ntcuser's interactive session; output goes to C:\ntc\<name>.log
in_session() { # name, script-file
  local name="$1" file="$2"
  { printf 'New-Item -ItemType Directory -Force C:\\ntc | Out-Null\n'
    printf 'icacls C:\\ntc /grant "ntcuser:(OI)(CI)M" | Out-Null\n'
    printf 'Set-Content C:\\ntc\\%s.ps1 -Encoding UTF8 -Value @'"'"'\n& {\n' "$name"
    cat "$file"
    printf '\n} *> C:\\ntc\\%s.log\n'"'"'@\n' "$name"
    printf '$a = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\\ntc\\%s.ps1"\n' "$name"
    printf '$p = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\\ntcuser" -LogonType Interactive -RunLevel Limited\n'
    printf 'Unregister-ScheduledTask -TaskName %s -Confirm:$false -ErrorAction SilentlyContinue\n' "$name"
    printf 'Register-ScheduledTask -TaskName %s -Action $a -Principal $p | Out-Null\nStart-ScheduledTask -TaskName %s\n' "$name" "$name"
  } > "$W/launch-$name.ps1"
  rc "$W/launch-$name.ps1" >/dev/null
  local st
  for i in $(seq 1 90); do
    st="$(rcs "(Get-ScheduledTask -TaskName $name).State")" || true
    case "$st" in *Running*) sleep 8 ;; *) break ;; esac
  done
  rcs "if (Test-Path C:\\ntc\\$name.log) { Get-Content C:\\ntc\\$name.log -Raw }"
}

echo "==> install from the blob in the user's session ($CHANNEL channel)"
cat > "$W/install.ps1" <<PS
\$env:NTC_PILOT_CHAVE = '$TEST_KEY'
\$env:NTC_PILOT_EMAIL = 'win@ntconsult.com.br'
\$env:NTC_PILOT_BLOB_URL = '$NTC_BLOB_BASE_URL'
\$env:NTC_PILOT_CHANNEL = '$CHANNEL'
try { irm '$NTC_BLOB_BASE_URL/install.ps1' | iex } catch { "ERRO: \$_" }
"exit=\$LASTEXITCODE"
PS
LOG="$(in_session install "$W/install.ps1")"
echo "$LOG" | tail -8 | sed "s/$TEST_KEY/<chave>/g" | cut -c1-180
echo "$LOG" | grep -q "ERRO" && { bad "installer reported an error"; exit 1; } || ok "thin installer finished"

echo "==> 1. the collector must install and start the tray"
cat > "$W/run-probe1.ps1" <<PS
\$ud = (Get-CimInstance Win32_UserProfile | Where-Object { \$_.LocalPath -like '*ntcuser' }).LocalPath
\$td = Join-Path \$ud '.loongsuite-pilot\\tray'
for (\$i = 0; \$i -lt 60; \$i++) {
  \$exe = Get-ChildItem \$td -Recurse -Filter ntc-tes-tray.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (\$exe) { break }
  Start-Sleep -Seconds 5
}
Start-Sleep -Seconds 10
'tray_installed=' + \$(if (\$exe) { \$exe.Directory.Name } else { '' })
'tray_pid_file=' + \$(if (Test-Path "\$td\\tray.pid") { (Get-Content "\$td\\tray.pid" -Raw).Trim() } else { '' })
'tray_running=' + @(Get-Process ntc-tes-tray -ErrorAction SilentlyContinue).Count
'collector_nodes=' + @(Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'collector-daemon' }).Count
\$wv = Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
'webview2=' + \$(if (\$wv) { \$wv.pv } else { 'absent' })
PS
OUT="$(rc "$W/run-probe1.ps1")"; echo "$OUT" | tail -6 | cut -c1-160
[ -n "$(val "$OUT" tray_installed)" ] && ok "collector installed the tray: $(val "$OUT" tray_installed)" || bad "tray not installed by the collector"
[ "$(val "$OUT" collector_nodes)" -ge 1 ] 2>/dev/null && ok "collector is running" || bad "collector not running"
info "WebView2 runtime: $(val "$OUT" webview2); tray processes running right after install: $(val "$OUT" tray_running)"

echo "==> 2/3. WebView2 runtime, then the panel forced open in the user's session"
cat > "$W/webview.ps1" <<'PS'
$ErrorActionPreference = "Continue"
$key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (-not (Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
  $p = "C:\ntc\MicrosoftEdgeWebview2Setup.exe"
  Invoke-WebRequest "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $p -UseBasicParsing
  $r = Start-Process $p -ArgumentList "/silent /install" -Wait -PassThru
  "webview2_installer_exit=" + $r.ExitCode
}
"webview2_after=" + $(try { (Get-ItemProperty $key).pv } catch { "absent" })
PS
rcs "New-Item -ItemType Directory -Force C:\\ntc | Out-Null" >/dev/null
rc "$W/webview.ps1" | tr -d '\r' | tail -3
cat > "$W/panel.ps1" <<'PS'
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  public static List<string> Windows(uint[] pids) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) >= 0) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        R r; GetWindowRect(h, out r);
        list.Add(sb.ToString() + "|" + IsWindowVisible(h) + "|" + (r.Rt - r.L) + "x" + (r.B - r.T));
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$ud = $env:USERPROFILE
$exe = Get-ChildItem "$ud\.loongsuite-pilot\tray" -Recurse -Filter ntc-tes-tray.exe | Select-Object -First 1
Get-Process ntc-tes-tray -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$env:NTC_TES_SHOW = "1"
$env:LOONGSUITE_PILOT_DATA_DIR = "$ud\.loongsuite-pilot"
$p1 = Start-Process $exe.FullName -PassThru
Start-Sleep -Seconds 20
$p1.Refresh()
"first_alive=" + (-not $p1.HasExited)
$pids = [uint32[]]@(Get-Process ntc-tes-tray -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$wins = [W]::Windows($pids)
foreach ($w in $wins) { "win=" + $w }
$panel = $wins | Where-Object { $_ -like "NT TES|*" } | Select-Object -First 1
"panel=" + $panel
"webview_processes=" + @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -match 'br.com.ntconsult.tes.tray' }).Count
$p2 = Start-Process $exe.FullName -PassThru
Start-Sleep -Seconds 8
"processes_after_second_launch=" + @(Get-Process ntc-tes-tray -ErrorAction SilentlyContinue).Count
Get-Process ntc-tes-tray -ErrorAction SilentlyContinue | Stop-Process -Force
PS
LOG="$(in_session panel "$W/panel.ps1" | tr -d '\r')"; echo "$LOG" | tail -8 | cut -c1-160
[ "$(val "$LOG" first_alive)" = "True" ] && ok "tray stays alive with WebView2" || bad "tray exited"
panel="$(val "$LOG" panel)"
[ "$(val "$LOG" webview_processes)" -ge 1 ] 2>/dev/null && ok "WebView2 is running the app ($(val "$LOG" webview_processes) processes)" || bad "no WebView2 process for the app"
case "$panel" in "NT TES|True|"*) ok "panel window 'NT TES' is visible, size ${panel##*|}";; *) bad "no visible 'NT TES' panel window (panel='$panel')";; esac
[ "$(val "$LOG" processes_after_second_launch)" = 1 ] && ok "single instance: second launch reused the running tray" || bad "second launch left $(val "$LOG" processes_after_second_launch) processes"

echo; echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
