!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "AbixCine requires 64-bit Windows 10 or Windows 11."
    Abort
  ${EndIf}
  nsExec::ExecToStack 'taskkill /F /IM abixcine.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM ffmpeg.exe /IM ffprobe.exe'
  Pop $0
  Pop $1
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack 'taskkill /F /IM abixcine.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM ffmpeg.exe /IM ffprobe.exe'
  Pop $0
  Pop $1
  Sleep 600
!macroend
