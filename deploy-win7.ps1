<#
.SYNOPSIS
Windows 7 Deployment Script for Printer Service

.DESCRIPTION
This script sets up the Node.js printer service and Cloudflared tunnel.
It supports strict idempotency, robust error handling, dynamic token retrieval,
and uniform status logging for all operations.
#>

param (
    [Parameter(Mandatory=$true, HelpMessage="Please enter the Cloudflare Tunnel Token")]
    [string]$TunnelToken
)

$currentUser = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!($currentUser.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
    Write-Host "This script requires Administrator privileges. Please run PowerShell as Administrator." -ForegroundColor Red
    exit
}

# ---------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------

function Write-Status {
    param (
        [ValidateSet("EXECUTED", "SKIPPED", "FAILED")]
        [string]$Status,
        [string]$Message
    )
    $color = switch ($Status) {
        "EXECUTED" { "Green" }
        "SKIPPED" { "DarkYellow" }
        "FAILED" { "Red" }
    }
    Write-Host "[$Status] $Message" -ForegroundColor $color
}

function Invoke-SafeDownload {
    param (
        [string]$Url,
        [string]$Destination
    )
    try {
        if (Test-Path $Destination) {
            Remove-Item $Destination -Force -ErrorAction SilentlyContinue
        }
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($Url, $Destination)
        return $true
    } catch {
        try {
            $certutilOut = & certutil.exe -urlcache -split -f $Url $Destination 2>&1
            if ($LASTEXITCODE -eq 0 -and (Test-Path $Destination)) {
                return $true
            }
        } catch { }
        
        # Ultimate fallback: Use Node.js for TLS 1.2 HTTPS downloads
        if (Get-Command node -ErrorAction SilentlyContinue) {
            $jsDest = $Destination.Replace("\", "\\")
            $nodeCode = "const https=require('https');const fs=require('fs');function dl(u){https.get(u,(res)=>{if(res.statusCode===301||res.statusCode===302){dl(res.headers.location)}else if(res.statusCode===200){const f=fs.createWriteStream('$jsDest');res.pipe(f);f.on('finish',()=>{process.exit(0)})}else{process.exit(1)}}).on('error',()=>{process.exit(1)})}dl('$Url')"
            $nodeOut = & node -e $nodeCode 2>&1
            if ($LASTEXITCODE -eq 0 -and (Test-Path $Destination)) {
                return $true
            }
        }

        Write-Status "FAILED" "Failed to download $Url."
        return $false
    }
}

# ---------------------------------------------------------
# Main Execution
# ---------------------------------------------------------
Write-Host "=========================================="
Write-Host " Printer Service Windows 7 Deployment"
Write-Host "=========================================="

# 1. Architecture Detection
$is64Bit = [Environment]::Is64BitOperatingSystem
if ($is64Bit) {
    Write-Status "EXECUTED" "Detected 64-bit Architecture."
    $nodeUrl = "https://nodejs.org/dist/v12.22.12/node-v12.22.12-x64.msi"
    $nodeMsi = "node-v12.22.12-x64.msi"
    $cloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/download/2022.12.1/cloudflared-windows-amd64.exe"
} else {
    Write-Status "EXECUTED" "Detected 32-bit Architecture."
    $nodeUrl = "https://nodejs.org/dist/v12.22.12/node-v12.22.12-x86.msi"
    $nodeMsi = "node-v12.22.12-x86.msi"
    $cloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/download/2022.12.1/cloudflared-windows-386.exe"
}

# 2. TLS 1.2 Enforcement
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Write-Status "EXECUTED" "Enforced TLS 1.2 protocol."
} catch {
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = 3072
        Write-Status "EXECUTED" "Enforced TLS 1.2 protocol (fallback)."
    } catch {
        Write-Status "FAILED" "Could not enable TLS 1.2. Downloads may fail."
    }
}

# 3. Node.js Verification & Installation
try {
    $nodeOutput = & node -v 2>&1
    $nodeInstalled = ($LASTEXITCODE -eq 0)
} catch {
    $nodeInstalled = $false
}

if ($nodeInstalled -and $nodeOutput -match "v12\.22\.12") {
    Write-Status "SKIPPED" "Node.js v12.22.12 is already installed."
} else {
    if ($nodeInstalled) {
        Write-Status "EXECUTED" "Different Node.js version found ($nodeOutput). Will attempt to install v12.22.12."
    }
    Write-Host "Downloading Node.js v12.22.12..."
    $nodeMsiPath = "$env:TEMP\$nodeMsi"
    if (Invoke-SafeDownload -Url $nodeUrl -Destination $nodeMsiPath) {
        Write-Host "Installing Node.js..."
        $process = Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsiPath`" /quiet /norestart" -Wait -PassThru
        if ($process.ExitCode -eq 0) {
            Write-Status "EXECUTED" "Node.js v12.22.12 installed successfully."
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        } else {
            Write-Status "FAILED" "Node.js installation returned exit code $($process.ExitCode)."
        }
    }
}

# 4. Git Repository Setup
$repoUrl = "https://github.com/Arisecraft/printer-service.git"
$repoFolder = "printer-service"

$gitInstalled = Get-Command git -ErrorAction SilentlyContinue
if (!$gitInstalled) {
    Write-Host "Git not found. Automatically downloading Git v2.39.2..."
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.39.2.windows.1/Git-2.39.2-32-bit.exe"
    if ($env:PROCESSOR_ARCHITECTURE -eq "AMD64") {
        $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.39.2.windows.1/Git-2.39.2-64-bit.exe"
    }
    $gitExe = "$env:TEMP\git-setup.exe"
    if (Invoke-SafeDownload -Url $gitUrl -Destination $gitExe) {
        Write-Host "Installing Git silently. This may take a minute..."
        $process = Start-Process -FilePath $gitExe -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS" -Wait -PassThru
        if ($process.ExitCode -eq 0) {
            Write-Status "EXECUTED" "Git installed successfully."
            $env:Path += ";C:\Program Files\Git\cmd;C:\Program Files (x86)\Git\cmd"
        } else {
            Write-Status "FAILED" "Git installation failed with exit code $($process.ExitCode)."
            exit
        }
    } else {
        Write-Status "FAILED" "Failed to download Git. Please install it manually."
        exit
    }
}

if (Test-Path ".git") {
    Write-Host "In git repository. Pulling changes..."
    $gitOutput = & git pull 2>&1
    if ($LASTEXITCODE -eq 0) {
        if ($gitOutput -match "Already up to date") {
            Write-Status "SKIPPED" "Repository is already up to date."
        } else {
            Write-Status "EXECUTED" "Repository updated successfully."
        }
    } else {
        Write-Status "FAILED" "Git pull failed: $gitOutput"
    }
} else {
    if (Test-Path $repoFolder) {
        Write-Host "Removing existing non-git directory..."
        Remove-Item $repoFolder -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Cloning repository..."
    $gitOutput = & git clone $repoUrl $repoFolder 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Status "EXECUTED" "Cloned repository successfully."
        Set-Location $repoFolder
    } else {
        Write-Status "FAILED" "Git clone failed: $gitOutput"
        exit
    }
}

# 5. Dependency Installation
$nodeModulesPath = Join-Path (Get-Location) "node_modules"
if (Test-Path $nodeModulesPath) {
    Write-Status "SKIPPED" "node_modules already exists. Assuming dependencies are installed."
} else {
    Write-Host "Installing NPM dependencies..."
    Write-Host "Downgrading Puppeteer for Node 12 compatibility..."
    & npm install puppeteer@13.7.0 --save | Out-Null
    
    $npmOutput = & npm install 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Status "EXECUTED" "Dependencies installed."
    } else {
        Write-Status "FAILED" "NPM install failed: $npmOutput"
        exit
    }
}

# 6. Application Verification
Write-Host "Verifying application starts properly..."
$appProc = Start-Process node.exe -ArgumentList "index.js" -WorkingDirectory (Get-Location).Path -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

if ($appProc.HasExited) {
    Write-Status "FAILED" "Application failed to start. Check logs."
} else {
    $netstatOutput = netstat -ano | findstr "7195"
    if ($netstatOutput) {
        Write-Status "EXECUTED" "Application verified listening on port 7195."
    } else {
        Write-Status "FAILED" "Application is running but port 7195 doesn't seem to be active."
    }
    Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
}

# 7. Windows Service Creation
Write-Host "Setting up Printer Service..."

# Dynamic WinSW selection based on OS version
$osMajor = [System.Environment]::OSVersion.Version.Major
if ($osMajor -ge 10) {
    Write-Status "EXECUTED" "Detected modern OS (Windows 10/11). Using WinSW .NET 4."
    $winSwUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET4.exe"
} else {
    Write-Status "EXECUTED" "Detected legacy OS (Windows 7/8). Using WinSW .NET 2."
    $winSwUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET2.exe"
}

$winSwExe = "printerservice.exe"
$winSwFullPath = Join-Path (Get-Location).Path $winSwExe

$winSwDownloaded = $true
if (Test-Path $winSwFullPath) {
    Write-Status "SKIPPED" "WinSW wrapper already downloaded."
} else {
    $winSwDownloaded = Invoke-SafeDownload -Url $winSwUrl -Destination $winSwFullPath
    if ($winSwDownloaded) {
        Write-Status "EXECUTED" "Downloaded WinSW wrapper."
    }
}

if ($winSwDownloaded) {
    $nodeExePath = "node.exe"
    if (Test-Path "C:\Program Files\nodejs\node.exe") {
        $nodeExePath = "C:\Program Files\nodejs\node.exe"
    } elseif (Test-Path "C:\Program Files (x86)\nodejs\node.exe") {
        $nodeExePath = "C:\Program Files (x86)\nodejs\node.exe"
    }

    $xmlConfig = @"
<service>
  <id>printerservice</id>
  <name>Node.js Printer Service</name>
  <description>Express backend handling printer tasks</description>
  <executable>$nodeExePath</executable>
  <arguments>index.js</arguments>
  <logmode>roll</logmode>
  <onfailure action="restart" delay="10 sec"/>
</service>
"@
    $xmlConfigPath = Join-Path (Get-Location).Path "printerservice.xml"
    Set-Content -Path $xmlConfigPath -Value $xmlConfig
    Write-Status "EXECUTED" "Created service configuration file."

    $serviceExists = Get-WmiObject Win32_Service -Filter "Name='printerservice'"
    if ($serviceExists) {
        Write-Status "SKIPPED" "Printer service is already installed."
    } else {
        $installProc = Start-Process -FilePath $winSwFullPath -ArgumentList "install" -WorkingDirectory (Get-Location).Path -Wait -PassThru -WindowStyle Hidden
        if ($installProc.ExitCode -eq 0) {
            Start-Process -FilePath $winSwFullPath -ArgumentList "start" -WorkingDirectory (Get-Location).Path -Wait -WindowStyle Hidden
            Write-Status "EXECUTED" "Printer service installed and started."
        } else {
            Write-Status "FAILED" "Failed to install Printer service."
        }
    }
} else {
    Write-Status "FAILED" "Cannot install service because WinSW download failed."
}

# 8. Cloudflared Installation & Service
Write-Host "Setting up Cloudflared tunnel..."
$cfDir = "C:\cloudflared"

$cfService = Get-WmiObject Win32_Service -Filter "Name='cloudflared'"
if ($cfService) {
    Write-Status "SKIPPED" "Cloudflared service is already installed."
} else {
    if (!(Test-Path $cfDir)) {
        New-Item -ItemType Directory -Path $cfDir | Out-Null
    }
    
    $cfExe = "$cfDir\cloudflared.exe"
    $cfDownloaded = $true

    if (Test-Path $cfExe) {
        Write-Status "SKIPPED" "Cloudflared executable already exists."
    } else {
        $cfDownloaded = Invoke-SafeDownload -Url $cloudflaredUrl -Destination $cfExe
        if ($cfDownloaded) {
            Write-Status "EXECUTED" "Downloaded Cloudflared binary."
        }
    }

    if ($cfDownloaded) {
        if ([string]::IsNullOrWhiteSpace($TunnelToken)) {
            Write-Status "FAILED" "No tunnel token provided. Service installation skipped."
        } else {
            Write-Host "Installing Cloudflared service..."
            $cfProcess = Start-Process -FilePath $cfExe -ArgumentList "service install $TunnelToken" -Wait -PassThru
            if ($cfProcess.ExitCode -eq 0) {
                Write-Status "EXECUTED" "Cloudflared service installed and started."
            } else {
                Write-Status "FAILED" "Failed to install Cloudflared service. Exit Code: $($cfProcess.ExitCode)"
            }
        }
    } else {
        Write-Status "FAILED" "Cannot install Cloudflared service because download failed."
    }
}

Write-Host "=========================================="
Write-Host " Deployment script finished execution."
Write-Host "=========================================="
Start-Sleep -Seconds 3
