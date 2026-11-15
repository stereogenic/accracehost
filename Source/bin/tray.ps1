$binPath = $PSScriptRoot
$icoPath = Join-Path $binPath 'icon.ico'
$nodeExe = Join-Path $binPath 'node.exe'
$scriptJs = Join-Path $binPath 'gui.js'

# Start Node.js silently in the background
$nodeProcess = Start-Process $nodeExe -ArgumentList $scriptJs -WorkingDirectory $binPath -PassThru -WindowStyle Hidden

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$tray = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $icoPath) { 
    $tray.Icon = [System.Drawing.Icon]::FromHandle((New-Object System.Drawing.Bitmap $icoPath).GetHicon())
} else { 
    $tray.Icon = [System.Drawing.SystemIcons]::Application 
}

$tray.Text = 'ACC Race Host'
$tray.Visible = $true

# Simplified menu containing ONLY "Open Web GUI"
$menu = New-Object System.Windows.Forms.ContextMenu
$openItem = $menu.MenuItems.Add('Open GUI', { Start-Process 'http://localhost:3030' })
$tray.ContextMenu = $menu

$tray.add_Click({ 
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { 
        Start-Process 'http://localhost:3030'
    }
})

Start-Process 'http://localhost:3030'

# TIMER WATCHER: Checks every 1 second if Node.js is still alive. 
# When you shut down from the web interface, it automatically cleans up and disappears.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    if ($nodeProcess.HasExited) {
        $timer.Stop()
        $tray.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()