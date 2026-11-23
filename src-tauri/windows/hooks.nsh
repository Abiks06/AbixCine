!macro _ShutdownIfExists filepath
  ${If} ${FileExists} "${filepath}"
    Push $0
    !insertmacro RestartManager_ShutdownFile "${filepath}" $0
    Pop $0
  ${EndIf}
!macroend

!macro _StopBundledMediaTools
  !insertmacro _ShutdownIfExists "$INSTDIR\resources\ffmpeg\ffmpeg.exe"
  !insertmacro _ShutdownIfExists "$INSTDIR\resources\ffmpeg\ffprobe.exe"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "AbixCine requires 64-bit Windows 10 or Windows 11."
    Abort
  ${EndIf}
  ; Fresh installs execute zero process-killing calls; updates use Restart Manager on AbixCine's bundled tools only.
  !insertmacro _StopBundledMediaTools
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _StopBundledMediaTools
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, i 0, i 0)'
!macroend
