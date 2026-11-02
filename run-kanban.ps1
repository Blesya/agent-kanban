#Requires -Version 5.1
<#
  agent-kanban launcher for Windows.

    start      start the server in background (no-op if the port is already listening)
    stop       kill the process listening on the port
    status     show state
    install    autostart at logon (shortcut in Startup folder)
    uninstall  remove the autostart shortcut

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File run-kanban.ps1 start
    powershell -NoProfile -ExecutionPolicy Bypass -File run-kanban.ps1 install
#>
param(
    [ValidateSet('start', 'stop', 'status', 'install', 'uninstall')]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Port = if ($env:KANBAN_PORT) { [int]$env:KANBAN_PORT } else { 7777 }
$Url = "http://127.0.0.1:$Port"
$LogDir = Join-Path $Root 'kanban_data\logs'
$OutLog = Join-Path $LogDir 'server.out.log'
$ErrLog = Join-Path $LogDir 'server.err.log'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'agent-kanban.lnk'

function Get-KanbanProcess {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess |
        ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
}

function Test-PortOpen {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        return $true
    } catch {
        return $false
    }
}

switch ($Action) {
    'start' {
        if (Test-PortOpen) {
            Write-Host "agent-kanban is already running: $Url"
            return
        }
        if (-not (Test-Path $Python)) {
            throw "venv not found: $Python  (run: cd `"$Root`"; uv sync --python 3.12)"
        }
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        Start-Process -FilePath $Python `
            -ArgumentList '-m', 'kanban_ui' `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $OutLog `
            -RedirectStandardError $ErrLog
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Milliseconds 250
            if (Test-PortOpen) { break }
        }
        if (Test-PortOpen) {
            Write-Host "agent-kanban started: $Url  (logs: $LogDir)"
        } else {
            Write-Host "Not up after 15s, see $ErrLog"
            if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 20 }
            exit 1
        }
    }
    'stop' {
        $p = Get-KanbanProcess
        if (-not $p) { Write-Host "Nothing is listening on port $Port"; return }
        Stop-Process -Id $p.Id -Force
        Write-Host "Stopped pid $($p.Id) (port $Port)"
    }
    'status' {
        $p = Get-KanbanProcess
        if ($p) {
            Write-Host "Running: pid $($p.Id), $Url"
        } else {
            Write-Host "Not running (port $Port is free)"
        }
        if (Test-Path $Shortcut) {
            Write-Host "Autostart: on ($Shortcut)"
        } else {
            Write-Host "Autostart: off"
        }
        $db = Join-Path $Root 'tasks.db'
        if (Test-Path $db) {
            $kb = [math]::Round((Get-Item $db).Length / 1KB, 1)
            Write-Host "DB: $db (${kb} KB)"
        }
    }
    'install' {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($Shortcut)
        $lnk.TargetPath = (Get-Command powershell.exe).Source
        $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Root\run-kanban.ps1`" start"
        $lnk.WorkingDirectory = $Root
        $lnk.IconLocation = 'powershell.exe,0'
        $lnk.Save()
        Write-Host "Autostart installed: $Shortcut"
    }
    'uninstall' {
        if (Test-Path $Shortcut) {
            Remove-Item $Shortcut -Force
            Write-Host "Autostart removed"
        } else {
            Write-Host "Autostart was not installed"
        }
    }
}
