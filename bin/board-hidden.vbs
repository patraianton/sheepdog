' Starts the board server with no console window (for autostart on logon).
' The path is derived from this script's own location; node is found via PATH.
Set fso = CreateObject("Scripting.FileSystemObject")
serverPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\board-server.mjs"
CreateObject("Wscript.Shell").Run "node """ & serverPath & """", 0, False
