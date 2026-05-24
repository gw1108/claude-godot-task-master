# PreToolUse guard for Bash test commands.
#
# Purpose: stop test-runner node processes from piling up. On this machine,
# `vitest run` can hang (see scripts/vitest-timeout.mjs), so launching a second
# run while one is alive leaves orphaned node processes behind.
#
# Rules (fail-open: any error -> allow):
#   1. Not a test command            -> allow
#   2. A test runner is already alive -> DENY (no concurrent runs)
#   3. Raw `vitest`/`npx vitest`      -> DENY, steer to the bounded `npm run test`
#      (only when $RequireBoundedRunner; the npm script routes through the
#       timeout watchdog so a hang can't linger forever)
#   4. Otherwise                      -> allow
#
# Detection ignores the task-master MCP server (it is node + long-lived but not
# a test). Set $RequireBoundedRunner = $false to allow raw vitest invocations.

$ErrorActionPreference = 'Stop'
$RequireBoundedRunner = $true

function Allow { exit 0 }

function Deny([string]$reason) {
	$obj = @{
		hookSpecificOutput = @{
			hookEventName            = 'PreToolUse'
			permissionDecision       = 'deny'
			permissionDecisionReason = $reason
		}
	}
	[Console]::Out.Write(($obj | ConvertTo-Json -Depth 6 -Compress))
	exit 0
}

# --- Parse the hook payload --------------------------------------------------
try {
	$raw = [Console]::In.ReadToEnd()
	if (-not $raw) { Allow }
	$cmd = ($raw | ConvertFrom-Json).tool_input.command
} catch { Allow }
if (-not $cmd) { Allow }

# --- Is this a test invocation? ----------------------------------------------
$testCmd = '(?i)(\bvitest\b|\bjest\b|npm(\.cmd)?\s+(run\s+)?test\b|pnpm\s+(run\s+)?test\b|yarn\s+(run\s+)?test\b|turbo\s+(run\s+)?test\b)'
if ($cmd -notmatch $testCmd) { Allow }

# --- Rule 2: is a runner already alive? --------------------------------------
$running = @(
	Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
		Where-Object {
			$_.CommandLine -and
			($_.CommandLine -match '(?i)(\bvitest\b|\bjest\b)') -and
			($_.CommandLine -notmatch '(?i)(mcp-server|task-master-ai)')
		}
)

if ($running.Count -gt 0) {
	$lines = $running | ForEach-Object {
		$c = ($_.CommandLine -replace '\s+', ' ').Trim()
		if ($c.Length -gt 90) { $c = $c.Substring(0, 90) + '...' }
		"  PID $($_.ProcessId): $c"
	}
	$detail = $lines -join "`n"
	Deny("A test run is already in progress ($($running.Count) runner process(es)). Do NOT start another -- that leaves orphaned node processes that hang. Wait for it to finish, or ask the user to kill it.`n$detail")
}

# --- Rule 3: require the bounded npm runner for raw vitest --------------------
if ($RequireBoundedRunner) {
	$isRawVitest = ($cmd -match '(?i)\bvitest\b') -and
		($cmd -notmatch '(?i)vitest-timeout') -and
		($cmd -notmatch '(?i)\bnpm\b.*\b(run\s+)?test\b')
	if ($isRawVitest) {
		Deny("Don't run vitest directly -- raw 'vitest run' can hang and linger on Windows. Use the bounded runner instead: 'npm run test -w <package>' (e.g. npm run test -w @tm/cli), which routes through scripts/vitest-timeout.mjs and force-kills a hung run. Pass extra args after --, e.g. npm run test -w @tm/cli -- path/to/file")
	}
}

Allow
