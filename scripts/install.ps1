# Install MATE (mate.exe) and add it to your user PATH. No admin needed.
# Usage (PowerShell):
#   iwr https://raw.githubusercontent.com/m-rui001/MATE/main/scripts/install.ps1 -useb | iex
$ErrorActionPreference = "Stop"

$Repo = "m-rui001/MATE"

$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -eq "ARM64") { $platform = "windows-arm64" } else { $platform = "windows-x64" }

$InstallDir = if ($env:MATE_INSTALL_DIR) { $env:MATE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\mate" }
$Url = "https://github.com/$Repo/releases/latest/download/mate-$platform.zip"

Write-Host "Downloading mate for $platform..."
$Tmp = New-TemporaryFile
$Zip = "$Tmp.zip"; Remove-Item $Tmp
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

    Write-Host "Extracting to $InstallDir..."
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -Path $Zip -DestinationPath $InstallDir -Force

    # Put the directory holding mate.exe on the user PATH (idempotent).
    $Dir = (Resolve-Path $InstallDir).Path
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @()
    if ($UserPath) { $Parts = $UserPath -split ";" | Where-Object { $_ -and ($_ -ne $Dir) } }
    [Environment]::SetEnvironmentVariable("Path", (($Parts + $Dir) -join ";"), "User")
    if (($env:Path -split ";") -notcontains $Dir) { $env:Path = "$env:Path;$Dir" }

    & (Join-Path $Dir "mate.exe") --version | ForEach-Object { Write-Host "Installed: mate $_" }
    Write-Host "Open a NEW terminal, then run: mate"
} finally {
    Remove-Item $Zip -ErrorAction SilentlyContinue
}
