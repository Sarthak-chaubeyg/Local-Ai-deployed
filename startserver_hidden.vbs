' ═══════════════════════════════════════════════════════
'  startserver_hidden.vbs
'  Launches the chat server SILENTLY — no window, no taskbar icon.
'
'  HOW TO USE:
'  1. Double-click this file → server starts invisibly
'  2. To auto-start on boot: Press Win+R → type "shell:startup"
'     → create a shortcut to THIS file in that folder
'  3. To stop: run stopserver.bat
' ═══════════════════════════════════════════════════════

Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")

' Get the directory where this script lives
strFolder = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Set working directory to the project folder
objShell.CurrentDirectory = strFolder

' Launch startserver.bat with window style 0 = HIDDEN
' The False means "don't wait for it to finish"
objShell.Run """" & strFolder & "\startserver.bat""", 0, False

' Clean up
Set objShell = Nothing
Set objFSO = Nothing
