# Launches backend (Express on 3001) and frontend (Vite on 28001) in fully
# detached child processes, then returns immediately. Designed for OpenCode's
# `bash` tool: the parent PowerShell process MUST exit within a few seconds,
# otherwise the tool blocks waiting for stdout EOF and the user sees a "stuck
# shell" with no reply.
#
# Key trick: spawn via `cmd /c start "" /B <command>` (cmd's built-in `start`,
# NOT PowerShell's `Start-Process` cmdlet). The `cmd start /B` flavor detaches
# the child from the cmd process tree, so neither PowerShell nor the bash tool
# hold a handle on the child's stdio. PowerShell 5.1's `Start-Process -PassThru`
# does NOT do this — it keeps handles and hangs the parent.
#
# The 6-second blind `Start-Sleep` is replaced with a bounded port-readiness
# poll: if the port isn't listening within 10s we report the failure and
# continue (the detached process keeps running and its log is still useful).

$ErrorActionPreference = 'Continue'

$root      = $PSScriptRoot
$clientDir = Join-Path $root 'client'
$serverDir = Join-Path $root 'server'

# --- 1. Kill anything already on these ports ---------------------------------
function Kill-Port([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Write-Output ('[cleanup] killed PID {0} on port {1}' -f $conn.OwningProcess, $Port)
  }
}
Kill-Port 28001
Kill-Port 3001

# --- 2. Reset log files ------------------------------------------------------
$serverOut = Join-Path $root '.server-out.log'
$serverErr = Join-Path $root '.server-err.log'
$clientOut = Join-Path $root '.dev-out.log'
$clientErr = Join-Path $root '.dev-err.log'
Remove-Item -LiteralPath $serverOut, $serverErr, $clientOut, $clientErr -ErrorAction SilentlyContinue

# --- 3. Spawn detached -------------------------------------------------------
# Why this works and `Start-Process -PassThru` doesn't: `Start-Process` keeps
# the child's stdio handles in the PowerShell parent's process handle table,
# so PowerShell 5.1 waits for them to close — and `npx.cmd` never closes them,
# so the shell hangs. Instead we use a 2-stage indirection:
#   PowerShell  ->  cmd /c "npx.cmd ..."  > log
#   PowerShell waits only for `cmd /c` to exit, which happens within ~50ms of
#   the child launching (cmd detaches the child to its own process group).
# We use `cmd.exe /D /C` (not `start /B`) because `start /B` mangles output
# redirection on Windows in subtle ways.
function Spawn-Detached([string]$Workdir, [string]$Cmdline, [string]$OutLog, [string]$ErrLog, [string]$Label) {
  $shell = Join-Path $env:WINDIR 'System32\cmd.exe'
  # /D = ignore AutoRun, /S = strip outer quotes, /C = run and exit
  $argList = '/D /S /C "cd /D ""' + $Workdir + '" && ' + $Cmdline + ' > ""' + $OutLog + '"" 2> ""' + $ErrLog + '"" 2>&1"'
  $p = Start-Process -FilePath $shell -ArgumentList $argList -WindowStyle Hidden -PassThru
  Write-Output ('[{0}] spawned (host cmd PID {1})' -f $Label, $p.Id)
}

$serverCmd = 'npx.cmd tsx src/index.ts'
$clientCmd = 'npx.cmd vite --host 0.0.0.0 --port 28001 --strictPort'

Spawn-Detached -Workdir $serverDir -Cmdline $serverCmd -OutLog $serverOut -ErrLog $serverErr -Label 'backend'
Spawn-Detached -Workdir $clientDir -Cmdline $clientCmd -OutLog $clientOut -ErrLog $clientErr -Label 'frontend'

# --- 4. Poll port readiness (bounded) ----------------------------------------
function Wait-Port([int]$Port, [int]$TimeoutSec = 10) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return $c }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

$back  = Wait-Port 3001  10
$front = Wait-Port 28001 10

# --- 5. Report ---------------------------------------------------------------
if ($back) {
  Write-Output ('[backend]  listening on 3001 (PID {0})' -f $back.OwningProcess)
} else {
  Write-Output '[backend]  NOT listening on 3001 within 10s - see .server-err.log'
}

if ($front) {
  Write-Output ('[frontend] listening on 28001 (PID {0})' -f $front.OwningProcess)
  Write-Output 'Local: http://localhost:28001/'
  $iface = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias
  foreach ($ip in @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $iface)) {
    Write-Output ('LAN:   http://{0}:28001/' -f $ip.IPAddress)
  }
} else {
  Write-Output '[frontend] NOT listening on 28001 within 10s - see .dev-err.log'
}
