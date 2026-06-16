    #Requires -RunAsAdministrator

Write-Host "Starting setup script for printer service..."

# Clone the public repo
Write-Host "Cloning the printer-service repository..."
$repoUrl = "https://github.com/0xSaurabhx/printer-service"
$repoFolder = "printer-service"
if (!(Test-Path $repoFolder)) {
    git clone $repoUrl $repoFolder
    Write-Host "Repository cloned successfully."
} else {
    Write-Host "Repository folder already exists. Skipping clone."
}
Set-Location $repoFolder

# Check if Node.js is installed
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Installing Node.js..."
    try {
        winget install --id OpenJS.NodeJS --silent --accept-source-agreements --accept-package-agreements
        Write-Host "Node.js installed successfully."
    } catch {
        Write-Host "Failed to install Node.js via winget. Please install manually from https://nodejs.org/"
        exit 1
    }
} else {
    Write-Host "Node.js is already installed."
}

# Install WinUSB driver via pnputil
Write-Host "Downloading and installing WinUSB driver..."
$tempPath = $env:TEMP
$url = "https://raw.githubusercontent.com/microsoft/Windows-driver-samples/main/usb/winusb/winusb.inf"
$infPath = "$tempPath\winusb.inf"
$sysPath = "$tempPath\winusb.sys"
try {
    # Download winusb.inf
    # Invoke-WebRequest -Uri $url -OutFile $infPath
    # Copy winusb.sys from local folder
    $localSysPath = Join-Path $PSScriptRoot "winusb\winusb.sys"
    if (Test-Path $localSysPath) {
        Copy-Item $localSysPath $sysPath
    } else {
        Write-Host "Local winusb.sys not found. Using system winusb.sys."
        Copy-Item "C:\Windows\System32\drivers\winusb.sys" $sysPath
    }
    # Install using pnputil
    pnputil /add-driver $infPath /install
    Write-Host "WinUSB driver installed successfully."
} catch {
    Write-Host "Failed to install WinUSB driver. Please install manually."
}

# Install Bun
Write-Host "Installing Bun..."
try {
    Invoke-RestMethod -Uri "https://bun.sh/install.ps1" | Invoke-Expression
    Write-Host "Bun installed successfully."
} catch {
    Write-Host "Failed to install Bun. Please install manually from https://bun.sh/"
}

# Install cloudflared
Write-Host "Installing cloudflared..."
try {
    winget install --id cloudflare.cloudflared --silent --accept-source-agreements --accept-package-agreements
    Write-Host "cloudflared installed successfully."
} catch {
    Write-Host "Failed to install cloudflared via winget. Please install manually."
}

# Ask for tunnel token
$tunnelToken = Read-Host "Enter your Cloudflare tunnel token"

# Install cloudflare service with token
Write-Host "Installing cloudflare service..."
try {
    cloudflared service install --tunnel-token $tunnelToken
    Write-Host "Cloudflare service installed."
} catch {
    Write-Host "Failed to install cloudflare service."
}

# Install PM2
Write-Host "Installing PM2..."
try {
    npm install -g pm2
    Write-Host "PM2 installed successfully."
} catch {
    Write-Host "Failed to install PM2."
}

# Run the API with PM2
Write-Host "Starting the API with PM2..."
$indexPath = Join-Path $PSScriptRoot "index.js"
if (Test-Path $indexPath) {
    pm2 start $indexPath --name "printer-service"
    Write-Host "API started with PM2."
} else {
    Write-Host "index.js not found. Please ensure the entry point exists."
}

# Set up PM2 autostart
Write-Host "Setting up PM2 autostart..."
try {
    pm2 startup
    pm2 save
    Write-Host "PM2 autostart configured."
} catch {
    Write-Host "Failed to configure PM2 autostart."
}

Write-Host "Setup complete. The printer service should now be running and set to autostart."