@echo off
chcp 65001 > nul
REM ===================================================================
REM  SOP Word 일괄변경 도구 - EXE 빌드 스크립트
REM  이 파일을 더블클릭하면 dist\SOP_Word_일괄변경.exe 가 만들어집니다.
REM ===================================================================

cd /d "%~dp0"

echo [1/3] 필요한 패키지를 설치합니다...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 goto :error

echo.
echo [2/3] 이전 빌드 결과를 정리합니다...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist "SOP_Word_일괄변경.spec" del /q "SOP_Word_일괄변경.spec"

echo.
echo [3/3] EXE 를 만듭니다. (몇 분 걸릴 수 있습니다)
python -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --noconsole ^
  --onefile ^
  --name "SOP_Word_일괄변경" ^
  --paths "." ^
  --hidden-import win32com ^
  --hidden-import win32com.client ^
  --hidden-import win32com.client.dynamic ^
  --hidden-import pythoncom ^
  --hidden-import pywintypes ^
  --hidden-import win32api ^
  --hidden-import win32timezone ^
  --exclude-module python-docx ^
  main.py
if errorlevel 1 goto :error

echo.
echo ===================================================================
echo  빌드 완료!
echo  결과 파일: %~dp0dist\SOP_Word_일괄변경.exe
echo ===================================================================
echo.
pause
exit /b 0

:error
echo.
echo -------------------------------------------------------------------
echo  빌드에 실패했습니다. 위의 오류 메시지를 확인해 주세요.
echo -------------------------------------------------------------------
echo.
pause
exit /b 1
