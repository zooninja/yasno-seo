' Yasno SEO: opens the app in the browser and starts it hidden if it is not running.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)

Function IsRunning()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", "http://localhost:4321/api/gsc/status", False
  http.send
  IsRunning = (Err.Number = 0 And http.status = 200)
End Function

If Not IsRunning() Then
  sh.CurrentDirectory = appDir
  sh.Run "cmd /c ""node server.js >> data\server.log 2>&1""", 0, False
  For i = 1 To 20
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
End If
sh.Run "http://localhost:4321"
