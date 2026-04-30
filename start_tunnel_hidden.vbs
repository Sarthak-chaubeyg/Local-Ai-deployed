' ═══════════════════════════════════════════════════════
'  start_tunnel_hidden.vbs
'  Launches the Cloudflare tunnel SILENTLY on boot.
'
'  HOW TO USE:
'  1. Double-click this file → tunnel starts invisibly
'  2. To auto-start on boot: Press Win+R → type "shell:startup"
'     → create a shortcut to THIS file in that folder
'  3. It will auto-capture the URL, update GitHub, and
'     Netlify will deploy automatically.
' ═══════════════════════════════════════════════════════

Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")

' Get the directory where this script lives
strFolder = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Set working directory to the project folder
objShell.CurrentDirectory = strFolder

' Launch start_tunnel.bat with window style 0 = HIDDEN
objShell.Run """" & strFolder & "\start_tunnel.bat""", 0, False

' Clean up
Set objShell = Nothing
Set objFSO = Nothing
