-- Trading Terminal launcher (double-clickable, no Terminal window).
--
-- Compile to an app with:
--   osacompile -o ~/Desktop/"Trading Terminal.app" launcher.applescript
-- then give it the app icon:
--   cp <icon.icns> ~/Desktop/"Trading Terminal.app"/Contents/Resources/applet.icns
--
-- On open it: starts Ollama (Gemma) if down, starts MAMP MySQL if down, then
-- launches the native AI Trading Terminal.app. It then WAITS for the app to quit
-- and, on quit, stops MAMP MySQL (only if it started it) but LEAVES Ollama running
-- so Gemma stays available in the background.

on run
	set appPath to "/Users/ulrich/Sites/sandbox/app-native/src-tauri/target/release/bundle/macos/AI Trading Terminal.app"
	set appProc to "MacOS/ai-trading-terminal"
	set mampStart to "/Applications/MAMP/bin/startMysql.sh"
	set mampStop to "/Applications/MAMP/bin/stopMysql.sh"
	set logFile to "/tmp/trading-terminal-launcher.log"

	-- helper: append a line to the log via shell
	my logLine(logFile, "=== Trading Terminal launcher: OPEN ===")

	-- 1) Ollama (Gemma) — start only if not running; never stopped on close.
	do shell script "if pgrep -x ollama >/dev/null 2>&1; then echo 'ollama up'; else (command -v ollama >/dev/null 2>&1 && nohup ollama serve >/tmp/ollama.log 2>&1 &) ; sleep 2; fi"
	my logLine(logFile, "Ollama ensured running (left running on quit).")

	-- 2) MAMP MySQL — probe :8889; start only if down. Remember whether WE started it.
	set startedMysql to "0"
	set mysqlUp to do shell script "nc -z 127.0.0.1 8889 >/dev/null 2>&1 && echo up || echo down"
	if mysqlUp is "up" then
		my logLine(logFile, "MySQL (:8889) already up — leaving it.")
	else
		try
			do shell script "if [ -x " & quoted form of mampStart & " ]; then " & quoted form of mampStart & " >/dev/null 2>&1 || true; sleep 3; fi"
			set startedMysql to "1"
			my logLine(logFile, "Started MAMP MySQL.")
		on error errMsg
			my logLine(logFile, "! Could not start MySQL: " & errMsg)
		end try
	end if

	-- 3) Launch the native app.
	set appExists to do shell script "[ -d " & quoted form of appPath & " ] && echo yes || echo no"
	if appExists is "no" then
		my logLine(logFile, "! App not found at " & appPath & " — build it first. Aborting.")
		display dialog "AI Trading Terminal.app was not found. Build it first with cargo tauri build." buttons {"OK"} default button "OK" with icon caution
		return
	end if
	do shell script "open " & quoted form of appPath
	my logLine(logFile, "Launched the app.")

	-- 4) Wait for the app to quit (poll every 3s; the app's own process must exist).
	delay 4
	my logLine(logFile, "Waiting for the app to quit…")
	repeat
		-- NOTE: `running` is a reserved AppleScript property; use a plain variable.
		set appRunning to do shell script "pgrep -f " & quoted form of appProc & " >/dev/null 2>&1 && echo yes || echo no"
		if appRunning is "no" then exit repeat
		delay 3
	end repeat
	my logLine(logFile, "App has quit.")

	-- 5) Grace period so the app's final SQLite->MySQL sync push completes,
	--    then stop MySQL only if we started it. Leave Ollama running.
	delay 5
	if startedMysql is "1" then
		try
			do shell script "[ -x " & quoted form of mampStop & " ] && " & quoted form of mampStop & " >/dev/null 2>&1 || true"
			my logLine(logFile, "Stopped MAMP MySQL.")
		on error errMsg
			my logLine(logFile, "! Could not stop MySQL: " & errMsg)
		end try
	else
		my logLine(logFile, "Left MySQL as found (we did not start it).")
	end if
	my logLine(logFile, "Leaving Ollama RUNNING (Gemma available in background).")
	my logLine(logFile, "=== Trading Terminal launcher: DONE ===")
end run

-- Append a timestamped line to the log file.
on logLine(logFile, msg)
	do shell script "echo \"$(date '+%H:%M:%S') " & msg & "\" >> " & quoted form of logFile
end logLine
