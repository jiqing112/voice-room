# =============================================================================
# deploy-windows.ps1 —— voice-rooms 一键部署（Windows Server / Win10+, 管理员 PowerShell）
#
# 用法:
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\deploy-windows.ps1                          # 局域网自签 HTTPS（推荐）
#   .\deploy-windows.ps1 -Http                    # 纯 HTTP（仅本机测试）
#
# 部署: Caddy(80/443) + LiveKit(7880/7881/UDP50000-50100) + Go 后端(127.0.0.1:8080)
#       + SvelteKit Web(127.0.0.1:3000)，全部注册为 Windows 服务开机自启
# =============================================================================
param(
    [switch]$Http,
    [string]$BasicAuthUser = "admin"
)
$ErrorActionPreference = "Stop"
# 自签 HTTPS 的健康检查需要忽略证书校验（仅本部署会话内生效）
try { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } } catch {}
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "请以管理员身份运行 PowerShell"; exit 1
}
$Root = "C:\voice-rooms"
$Bin  = "$Root\bin"
New-Item -ItemType Directory -Force -Path "$Bin", "$Root\web" | Out-Null

# ---------- 随机密钥 ----------
# Get-Random 不是密码学安全的 PRNG，不能用来生成密钥/口令——用 CSPRNG
function Rand-Hex($n) {
	$bytes = New-Object byte[] ([Math]::Ceiling($n / 2))
	$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
	try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
	$hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
	return $hex.Substring(0, $n)
}
$LK_KEY = Rand-Hex 16
$LK_SECRET = Rand-Hex 48
$BA_PASS = Rand-Hex 6

Write-Host "================================================"
Write-Host " BasicAuth:  $BasicAuthUser / $BA_PASS"
Write-Host " 注册系统:   关闭（游客自由建房/进房，可在服务环境变量中开启）"
Write-Host "================================================"
Start-Sleep 2

# ---------- 1. 下载依赖（Node / LiveKit / Caddy 的 Windows 版） ----------
$dl = {
    param($url, $out)
    if (-not (Test-Path $out)) {
        Write-Host "下载 $url"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    }
}
$nodeZip = "$env:TEMP\node.zip"
& $dl "https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip" $nodeZip
if (-not (Test-Path "$Bin\node.exe")) {
    Expand-Archive $nodeZip -DestinationPath "$env:TEMP\node" -Force
    Copy-Item "$env:TEMP\node\node-v20.18.0-win-x64\*" $Bin -Recurse -Force
}
$lkZip = "$env:TEMP\livekit.zip"
& $dl "https://github.com/livekit/livekit/releases/download/v1.13.7/livekit_1.13.7_windows_amd64.zip" $lkZip
if (-not (Test-Path "$Bin\livekit-server.exe")) {
    Expand-Archive $lkZip -DestinationPath "$env:TEMP\livekit" -Force
    Copy-Item "$env:TEMP\livekit\livekit-server.exe" $Bin -Force
}
$caddyZip = "$env:TEMP\caddy.zip"
& $dl "https://github.com/caddyserver/caddy/releases/download/v2.11.2/caddy_2.11.2_windows_amd64.zip" $caddyZip
if (-not (Test-Path "$Bin\caddy.exe")) {
    Expand-Archive $caddyZip -DestinationPath "$env:TEMP\caddy" -Force
    Copy-Item "$env:TEMP\caddy\caddy.exe" $Bin -Force
}

# ---------- 2. 部署文件 ----------
Copy-Item "$PSScriptRoot\bin\voice-rooms-windows.exe" "$Bin\voice-rooms-windows.exe" -Force
Copy-Item "$PSScriptRoot\web\build" "$Root\web\build" -Recurse -Force
Copy-Item "$PSScriptRoot\web\node_modules" "$Root\web\node_modules" -Recurse -Force
Copy-Item "$PSScriptRoot\web\package.json" "$Root\web\package.json" -Force

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
$origin = if ($Http) { "http://${ip}" } else { "https://${ip}" }

# ---------- 3. LiveKit 配置 ----------
@"
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${LK_KEY}: ${LK_SECRET}
"@ | Out-File "$Root\livekit.yaml" -Encoding utf8

# ---------- 4. 注册 Windows 服务（环境变量写注册表） ----------
function New-ServiceEx($name, $display, $exe, $srvArgs, $envVars) {
    sc.exe create $name binPath= "`"$exe`" $srvArgs" start= auto DisplayName= $display | Out-Null
    if ($envVars) {
        $multi = ($envVars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`0"
        reg add "HKLM\SYSTEM\CurrentControlSet\Services\$name\Environment" /v Environment /t REG_MULTI_SZ /d $multi /f | Out-Null
    }
    sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
}

$goEnv = @{ PORT = "8080"; GIN_MODE = "release"; LIVEKIT_API_KEY = $LK_KEY; LIVEKIT_API_SECRET = $LK_SECRET;
    LIVEKIT_URL = "$origin/livekit"; LIVEKIT_HTTP_URL = "http://127.0.0.1:7880"; WS_ALLOWED_ORIGIN = $origin;
    AUTH_DB = "$Root\auth.db"; AUTH_REGISTER_ENABLED = "false"; CREATE_REQUIRE_ACCOUNT = "false";
    MAIL_VERIFY_ENABLED = "false"; MAIL_FROM_NAME = "回声室" }
New-ServiceEx "voice-rooms" "Voice Rooms Go API Server" "$Bin\voice-rooms-windows.exe" "" $goEnv

$webEnv = @{ PORT = "3000"; HOST = "127.0.0.1" }
New-ServiceEx "voicerooms-web" "Voice Rooms Web" "$Bin\node.exe" "`"$Root\web\build\index.js`"" $webEnv

$lkEnv = @{ LIVEKIT_CONFIG = "$Root\livekit.yaml" }
New-ServiceEx "livekit" "LiveKit Media Server" "$Bin\livekit-server.exe" "--config `"$Root\livekit.yaml`"" $lkEnv

# ---------- 5. Caddy 配置 + 服务 ----------
$caddySite = ":80"
if (-not $Http) { $caddySite = "https://${ip}:443 {`n`t`ttls internal`n`t}" }
@"
$caddySite {
	basic_auth / {
		$BasicAuthUser $(caddy hash-password --plaintext $BA_PASS 2>$null)
	}
	basic_auth /api/rooms {
		$BasicAuthUser $(caddy hash-password --plaintext $BA_PASS 2>$null)
	}
	handle /api/* { reverse_proxy 127.0.0.1:8080 }
	handle /ws { reverse_proxy 127.0.0.1:8080 }
	handle_path /livekit/* {
		reverse_proxy 127.0.0.1:7880 { header_up -Authorization }
	}
	handle { reverse_proxy 127.0.0.1:3000 }
}
"@ | Out-File "$Root\Caddyfile" -Encoding utf8

New-ServiceEx "voicerooms-caddy" "Voice Rooms Caddy" "$Bin\caddy.exe" "run --config `"$Root\Caddyfile`"" @{}

# ---------- 6. 防火墙 ----------
$ports = @(80, 443, 7881, 3478)
foreach ($p in $ports) {
    netsh advfirewall firewall add rule name "voice-rooms-tcp-$p" dir in action allow protocol TCP localport $p | Out-Null
    netsh advfirewall firewall add rule name "voice-rooms-udp-$p" dir in action allow protocol UDP localport $p | Out-Null
}
netsh advfirewall firewall add rule name "voice-rooms-udp-rtc" dir in action allow protocol UDP localport 50000-50100 | Out-Null

# ---------- 7. 启动全部服务 ----------
foreach ($s in @("voice-rooms", "voicerooms-web", "livekit", "voicerooms-caddy")) {
    sc.exe start $s | Out-Null
}
Start-Sleep 3

# ---------- 8. 健康检查 ----------
$proto = "http"
if (-not $Http) { $proto = "https" }
try {
    $h = Invoke-RestMethod -Uri "$proto`://${ip}/api/health" -TimeoutSec 8 -ErrorAction Stop
    Write-Host "健康检查: OK ($($h.go) / $($h.livekit))"
} catch { Write-Host "健康检查: 未通过（自签证书需在浏览器中信任一次后重试）" }

Write-Host "================================================"
Write-Host " ✅ 部署完成"
Write-Host " 访问地址:  $origin`://$ip"
Write-Host " 站点密码:  $BasicAuthUser / $BA_PASS"
Write-Host " 服务管理:  Get-Service voice-rooms,livekit,voicerooms-web,voicerooms-caddy"
Write-Host " 配置文件:  $Root\livekit.yaml, $Root\Caddyfile, 注册表 Services\*\Environment"
Write-Host " 注意: 无域名的自签 HTTPS，浏览器首次访问需点『高级→继续前往』"
Write-Host "================================================"
