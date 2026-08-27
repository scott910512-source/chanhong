Attribute VB_Name = "SOP_BatchReplace"
Option Explicit

'==================================================================
'  SOP Word 일괄변경 도구  (VBA 버전)
'
'  * Normal.dotm 에 넣어 두면 모든 Word 문서에서 항상 사용할 수 있다.
'  * 치환 규칙은 파일이 아니라 레지스트리(HKCU)에 저장하므로
'    디스크에 별도 파일을 만들 수 없는 환경에서도 동작한다.
'  * Word 자체의 찾기/바꾸기를 쓰므로 서식이 그대로 유지된다.
'    (사람이 Ctrl+H 로 '모두 바꾸기' 한 것과 동일)
'
'  실행: Alt + F8  ->  SOP_Main
'
'  ※ 이 파일을 '붙여넣기' 로 넣는 경우에는
'     맨 첫 줄 (Attribute VB_Name = ...) 을 지우고 붙여 넣으세요.
'     '파일 > 파일 가져오기' 로 넣는 경우에는 그대로 두시면 됩니다.
'==================================================================

'--- 기본 설정 ---------------------------------------------------
Private Const APP_TITLE As String = "SOP Word 일괄변경 도구"
Private Const APP_NAME  As String = "SOPBatchReplace"   ' 레지스트리 저장 이름
Private Const MAX_RULES As Long = 300                   ' 규칙 최대 개수
Private Const MAX_TEXT  As Long = 255                   ' Word 찾기 문구 길이 제한
Private Const MAX_SCAN  As Long = 20000                 ' 무한 루프 방지용 상한
Private Const BACKUP_MARK As String = "_원본백업_"

' 암호가 걸린 문서에서 암호 입력창이 뜨는 대신 오류가 나게 하는 더미 암호
Private Const DUMMY_PW As String = "@@SOP_NO_PASSWORD@@"

'--- 규칙 보관용 모듈 변수 ---------------------------------------
Private gCount As Long
Private gEnabled(1 To MAX_RULES) As Boolean
Private gFind(1 To MAX_RULES) As String
Private gRepl(1 To MAX_RULES) As String


'==================================================================
'  1. 메인 메뉴  (Alt+F8 에서 이것을 실행한다)
'==================================================================
Public Sub SOP_Main()
    Dim choice As String

    LoadRules

    Do
        choice = InputBox( _
            "=== " & APP_TITLE & " ===" & vbCrLf & vbCrLf & _
            "현재 규칙 : " & gCount & "개  (사용 ON : " & EnabledCount() & "개)" & vbCrLf & vbCrLf & _
            "1. 치환 규칙 관리" & vbCrLf & _
            "2. 사전 확인   (파일을 바꾸지 않고 미리 검사)" & vbCrLf & _
            "3. 일괄 변경 실행" & vbCrLf & _
            "4. 규칙 목록 전체 보기" & vbCrLf & _
            "0. 종료" & vbCrLf & vbCrLf & _
            "번호를 입력하고 [확인] 을 누르세요:", APP_TITLE, "1")

        Select Case Trim$(choice)
            Case "1": RuleMenu
            Case "2": RunJob True
            Case "3": RunJob False
            Case "4": ShowRuleListDocument
            Case "0", "": Exit Do
            Case Else
                MsgBox "0 ~ 4 중에서 입력해 주세요.", vbExclamation, APP_TITLE
        End Select
    Loop
End Sub


'==================================================================
'  2. 규칙 관리 메뉴
'==================================================================
Public Sub SOP_Rules()
    LoadRules
    RuleMenu
End Sub

Private Sub RuleMenu()
    Dim choice As String

    Do
        choice = InputBox( _
            "=== 치환 규칙 관리 ===" & vbCrLf & vbCrLf & _
            RuleListText(700) & vbCrLf & _
            "1. 규칙 추가" & vbCrLf & _
            "2. 규칙 수정" & vbCrLf & _
            "3. 규칙 삭제" & vbCrLf & _
            "4. 사용 ON/OFF 전환" & vbCrLf & _
            "5. 전체 ON        6. 전체 OFF" & vbCrLf & _
            "7. 위로 이동      8. 아래로 이동" & vbCrLf & _
            "0. 돌아가기" & vbCrLf & vbCrLf & _
            "번호를 입력하세요:", APP_TITLE, "1")

        Select Case Trim$(choice)
            Case "1": AddRule
            Case "2": EditRule
            Case "3": DeleteRule
            Case "4": ToggleRule
            Case "5": SetAllRules True
            Case "6": SetAllRules False
            Case "7": MoveRule -1
            Case "8": MoveRule 1
            Case "0", "": Exit Do
            Case Else
                MsgBox "0 ~ 8 중에서 입력해 주세요.", vbExclamation, APP_TITLE
        End Select
    Loop
End Sub

'--- 규칙 추가 ----------------------------------------------------
Private Sub AddRule()
    Dim f As String, r As String

    If gCount >= MAX_RULES Then
        MsgBox "규칙은 최대 " & MAX_RULES & "개까지 등록할 수 있습니다.", vbExclamation, APP_TITLE
        Exit Sub
    End If

    f = InputBox("찾을 문구를 입력하세요." & vbCrLf & _
                 "(비워 두면 취소됩니다)", "규칙 추가 - 1/2  찾을 문구")
    If Len(Trim$(f)) = 0 Then Exit Sub
    If Not CheckLength(f, "찾을 문구") Then Exit Sub

    r = InputBox("바꿀 문구를 입력하세요." & vbCrLf & vbCrLf & _
                 "찾을 문구 : " & f & vbCrLf & vbCrLf & _
                 "※ 비워 두고 [확인] 을 누르면 그 문구를 '삭제' 합니다.", _
                 "규칙 추가 - 2/2  바꿀 문구")

    ' InputBox 는 취소해도 "" 를 돌려주므로, 빈 값이면 한 번 더 확인한다.
    If Len(r) = 0 Then
        If MsgBox("바꿀 문구가 비어 있습니다." & vbCrLf & vbCrLf & _
                  "'" & f & "' 를 문서에서 삭제하는 규칙으로 등록할까요?", _
                  vbYesNo + vbQuestion, APP_TITLE) <> vbYes Then Exit Sub
    End If
    If Not CheckLength(r, "바꿀 문구") Then Exit Sub

    If FindDuplicate(f, r, 0) > 0 Then
        MsgBox "동일한 치환 규칙이 이미 등록되어 있습니다.", vbExclamation, APP_TITLE
        Exit Sub
    End If

    gCount = gCount + 1
    gEnabled(gCount) = True
    gFind(gCount) = f
    gRepl(gCount) = r
    SaveRules

    MsgBox "규칙을 추가했습니다.  (" & gCount & "번)" & vbCrLf & vbCrLf & _
           f & "   ->   " & r, vbInformation, APP_TITLE
End Sub

'--- 규칙 수정 ----------------------------------------------------
Private Sub EditRule()
    Dim n As Long, f As String, r As String

    n = AskRuleNumber("수정할 규칙 번호를 입력하세요:")
    If n = 0 Then Exit Sub

    f = InputBox("찾을 문구를 입력하세요.", "규칙 수정 - 1/2  찾을 문구", gFind(n))
    If Len(Trim$(f)) = 0 Then Exit Sub
    If Not CheckLength(f, "찾을 문구") Then Exit Sub

    r = InputBox("바꿀 문구를 입력하세요." & vbCrLf & vbCrLf & _
                 "※ 비워 두고 [확인] 을 누르면 그 문구를 '삭제' 합니다.", _
                 "규칙 수정 - 2/2  바꿀 문구", gRepl(n))
    If Len(r) = 0 And Len(gRepl(n)) > 0 Then
        If MsgBox("바꿀 문구가 비어 있습니다." & vbCrLf & vbCrLf & _
                  "'" & f & "' 를 삭제하는 규칙으로 바꿀까요?", _
                  vbYesNo + vbQuestion, APP_TITLE) <> vbYes Then Exit Sub
    End If
    If Not CheckLength(r, "바꿀 문구") Then Exit Sub

    If FindDuplicate(f, r, n) > 0 Then
        MsgBox "동일한 치환 규칙이 이미 등록되어 있습니다.", vbExclamation, APP_TITLE
        Exit Sub
    End If

    gFind(n) = f
    gRepl(n) = r
    SaveRules
    MsgBox "규칙 " & n & "번을 수정했습니다.", vbInformation, APP_TITLE
End Sub

'--- 규칙 삭제 ----------------------------------------------------
Private Sub DeleteRule()
    Dim n As Long, i As Long

    n = AskRuleNumber("삭제할 규칙 번호를 입력하세요:")
    If n = 0 Then Exit Sub

    If MsgBox("선택한 치환 규칙을 삭제하시겠습니까?" & vbCrLf & vbCrLf & _
              n & ". " & gFind(n) & "   ->   " & gRepl(n), _
              vbYesNo + vbQuestion, APP_TITLE) <> vbYes Then Exit Sub

    For i = n To gCount - 1
        gEnabled(i) = gEnabled(i + 1)
        gFind(i) = gFind(i + 1)
        gRepl(i) = gRepl(i + 1)
    Next i
    gCount = gCount - 1
    SaveRules
    MsgBox "삭제했습니다.", vbInformation, APP_TITLE
End Sub

'--- 사용 ON/OFF 전환 ---------------------------------------------
Private Sub ToggleRule()
    Dim n As Long

    n = AskRuleNumber("ON/OFF 를 바꿀 규칙 번호를 입력하세요:")
    If n = 0 Then Exit Sub

    gEnabled(n) = Not gEnabled(n)
    SaveRules
    MsgBox n & "번 규칙을 " & IIf(gEnabled(n), "ON", "OFF") & " 으로 바꿨습니다.", _
           vbInformation, APP_TITLE
End Sub

'--- 전체 ON / OFF ------------------------------------------------
Private Sub SetAllRules(ByVal flag As Boolean)
    Dim i As Long

    If gCount = 0 Then
        MsgBox "등록된 규칙이 없습니다.", vbInformation, APP_TITLE
        Exit Sub
    End If

    For i = 1 To gCount
        gEnabled(i) = flag
    Next i
    SaveRules
    MsgBox "모든 규칙을 " & IIf(flag, "ON", "OFF") & " 으로 바꿨습니다.", _
           vbInformation, APP_TITLE
End Sub

'--- 순서 이동 ----------------------------------------------------
'  치환은 1번부터 순서대로 적용되므로 순서가 중요하다.
Private Sub MoveRule(ByVal delta As Long)
    Dim n As Long, m As Long
    Dim tb As Boolean, ts As String

    n = AskRuleNumber(IIf(delta < 0, "위로 옮길", "아래로 옮길") & " 규칙 번호를 입력하세요:")
    If n = 0 Then Exit Sub

    m = n + delta
    If m < 1 Or m > gCount Then
        MsgBox "더 이상 옮길 수 없습니다.", vbInformation, APP_TITLE
        Exit Sub
    End If

    tb = gEnabled(n): gEnabled(n) = gEnabled(m): gEnabled(m) = tb
    ts = gFind(n):    gFind(n) = gFind(m):       gFind(m) = ts
    ts = gRepl(n):    gRepl(n) = gRepl(m):       gRepl(m) = ts

    SaveRules
    MsgBox n & "번 규칙을 " & m & "번 위치로 옮겼습니다.", vbInformation, APP_TITLE
End Sub


'==================================================================
'  3. 실제 작업 (사전 확인 / 일괄 변경)
'==================================================================
Private Sub RunJob(ByVal previewOnly As Boolean)
    Dim folder As String, recurse As Boolean
    Dim files As Collection, openDocs As Collection
    Dim backupRoot As String
    Dim i As Long, k As Long
    Dim p As String, nm As String, status As String, errMsg As String
    Dim nChanged As Long, nUnchanged As Long, nOpen As Long, nRO As Long, nErr As Long
    Dim totals(1 To MAX_RULES) As Long
    Dim fileCounts(1 To MAX_RULES) As Long
    Dim detail As String, skipList As String, errList As String
    Dim startedAt As Date
    Dim savedAlerts As Long, savedScreen As Boolean, savedStatus As Variant

    LoadRules

    '--- 사전 검사 -------------------------------------------------
    If EnabledCount() = 0 Then
        MsgBox "사용(ON) 상태인 치환 규칙이 없습니다." & vbCrLf & vbCrLf & _
               "먼저 [1. 치환 규칙 관리] 에서 규칙을 등록해 주세요.", _
               vbExclamation, APP_TITLE
        Exit Sub
    End If

    folder = PickFolder(GetSetting(APP_NAME, "Options", "LastFolder", ""))
    If Len(folder) = 0 Then Exit Sub
    folder = RemoveSlash(folder)
    SaveSetting APP_NAME, "Options", "LastFolder", folder

    recurse = (MsgBox("하위 폴더에 있는 문서까지 포함할까요?" & vbCrLf & vbCrLf & folder, _
                      vbYesNo + vbQuestion, APP_TITLE) = vbYes)

    Set files = CollectFiles(folder, recurse)
    If files.Count = 0 Then
        MsgBox "선택한 폴더에서 Word 문서(.docx / .docm / .doc)를 찾지 못했습니다." & vbCrLf & vbCrLf & _
               "하위 폴더에 있다면 '하위 폴더 포함'을 [예] 로 선택해 주세요.", _
               vbInformation, APP_TITLE
        Exit Sub
    End If

    '--- 최종 확인 -------------------------------------------------
    If Not previewOnly Then
        If MsgBox(EnabledCount() & "개의 치환 규칙을" & vbCrLf & _
                  files.Count & "개의 Word 문서에 적용합니다." & vbCrLf & vbCrLf & _
                  "원본 문서는 자동으로 백업됩니다." & vbCrLf & _
                  "Word 에서 열려 있는 문서는 제외됩니다." & vbCrLf & vbCrLf & _
                  "계속하시겠습니까?", vbYesNo + vbQuestion, APP_TITLE) <> vbYes Then Exit Sub
    End If

    startedAt = Now

    '--- 현재 Word 에 열려 있는 문서 목록 (작업 시작 시점 기준) -----
    Set openDocs = OpenDocPaths()

    '--- 백업 폴더 준비 (실제 변경 모드에서만) ---------------------
    If Not previewOnly Then
        backupRoot = MakeBackupRoot(folder)
        EnsureFolder backupRoot
        If Not FolderExists(backupRoot) Then
            MsgBox "백업 폴더를 만들 수 없습니다." & vbCrLf & vbCrLf & backupRoot & vbCrLf & vbCrLf & _
                   "백업을 만들 수 없으므로 작업을 중단합니다.", vbCritical, APP_TITLE
            Exit Sub
        End If
    End If

    '--- Word 환경 설정 (작업이 끝나면 반드시 되돌린다) ------------
    savedAlerts = Application.DisplayAlerts
    savedScreen = Application.ScreenUpdating
    savedStatus = Application.StatusBar

    On Error GoTo cleanUp
    Application.DisplayAlerts = wdAlertsNone   ' 경고창 때문에 멈추지 않게
    Application.ScreenUpdating = False

    '--- 문서별 처리 ----------------------------------------------
    For k = 1 To files.Count
        p = files(k)
        nm = FileNameOnly(p)
        Application.StatusBar = "[" & k & "/" & files.Count & "] " & _
                                IIf(previewOnly, "검사 중", "변경 중") & " ... " & nm
        DoEvents

        errMsg = ""

        ' (1) Word 에서 이미 열려 있는 문서는 절대 건드리지 않는다
        If InCollection(openDocs, LCase$(p)) Then
            nOpen = nOpen + 1
            skipList = skipList & nOpen & ". " & nm & vbCrLf & "    " & p & vbCrLf
            detail = detail & "[SKIP] " & nm & vbCrLf & "  사유: Word 에서 현재 열려 있음" & vbCrLf & vbCrLf
            GoTo nextFile
        End If

        ' (2) 읽기 전용 파일은 수정하지 않는다
        If Not previewOnly Then
            If IsReadOnlyFile(p) Then
                nRO = nRO + 1
                errList = errList & nRO & ". " & nm & vbCrLf & _
                          "    → 파일이 읽기 전용입니다." & vbCrLf
                detail = detail & "[SKIP] " & nm & vbCrLf & "  사유: 읽기 전용 파일" & vbCrLf & vbCrLf
                GoTo nextFile
            End If

            ' (3) 원본 백업. 실패하면 절대 수정하지 않는다.
            If Not BackupOne(p, folder, backupRoot) Then
                nErr = nErr + 1
                errList = errList & "E" & nErr & ". " & nm & vbCrLf & _
                          "    → 백업에 실패하여 변경하지 않았습니다." & vbCrLf
                detail = detail & "[오류] " & nm & vbCrLf & "  사유: 백업 실패 (변경하지 않음)" & vbCrLf & vbCrLf
                GoTo nextFile
            End If
        End If

        ' (4) 치환 실행
        status = ProcessOne(p, previewOnly, fileCounts, errMsg)

        Select Case status
            Case "CHANGED"
                nChanged = nChanged + 1
                detail = detail & IIf(previewOnly, "[변경 예상] ", "[변경] ") & nm & vbCrLf
                For i = 1 To gCount
                    If fileCounts(i) > 0 Then
                        totals(i) = totals(i) + fileCounts(i)
                        detail = detail & "  " & gFind(i) & " -> " & gRepl(i) & " : " & fileCounts(i) & "건" & vbCrLf
                    End If
                Next i
                detail = detail & vbCrLf

            Case "UNCHANGED"
                nUnchanged = nUnchanged + 1

            Case "RO"
                nRO = nRO + 1
                errList = errList & nRO & ". " & nm & vbCrLf & "    → " & errMsg & vbCrLf
                detail = detail & "[SKIP] " & nm & vbCrLf & "  사유: " & errMsg & vbCrLf & vbCrLf

            Case Else   ' "ERR"
                nErr = nErr + 1
                errList = errList & "E" & nErr & ". " & nm & vbCrLf & "    → " & errMsg & vbCrLf
                detail = detail & "[오류] " & nm & vbCrLf & "  사유: " & errMsg & vbCrLf & vbCrLf
        End Select

nextFile:
    Next k

cleanUp:
    '--- Word 환경 복원 (오류가 나도 반드시 실행된다) --------------
    On Error Resume Next
    Application.DisplayAlerts = savedAlerts
    Application.ScreenUpdating = savedScreen
    Application.StatusBar = savedStatus
    On Error GoTo 0

    '--- 결과 보고 -------------------------------------------------
    ShowResult previewOnly, folder, recurse, backupRoot, files.Count, _
               nChanged, nUnchanged, nOpen, nRO, nErr, _
               totals, detail, skipList, errList, startedAt
End Sub


'--- 문서 한 개 처리 ----------------------------------------------
'  반환값: "CHANGED" / "UNCHANGED" / "RO" / "ERR"
Private Function ProcessOne(ByVal p As String, ByVal previewOnly As Boolean, _
                            ByRef fileCounts() As Long, ByRef errMsg As String) As String
    Dim doc As Document
    Dim hadTrack As Boolean
    Dim i As Long, total As Long

    For i = 1 To gCount
        fileCounts(i) = 0
    Next i

    '--- 문서 열기 -------------------------------------------------
    '  PasswordDocument 에 엉뚱한 암호를 넘기면, 암호가 걸린 문서일 때
    '  입력창이 뜨는 대신 오류가 발생한다(작업이 멈추지 않게 하기 위함).
    '  Visible:=False 로 화면에 띄우지 않고, 최근 문서 목록도 건드리지 않는다.
    On Error GoTo failOpen
    Set doc = Documents.Open(FileName:=p, _
                             ConfirmConversions:=False, _
                             ReadOnly:=previewOnly, _
                             AddToRecentFiles:=False, _
                             PasswordDocument:=DUMMY_PW, _
                             WritePasswordDocument:=DUMMY_PW, _
                             Revert:=False, _
                             Visible:=False)
    ' 문서가 열린 뒤부터는 오류가 나도 반드시 문서를 닫도록 핸들러를 바꾼다.
    On Error GoTo failProc

    '--- 읽기 전용으로 열렸으면 수정하지 않는다 --------------------
    If Not previewOnly Then
        If doc.ReadOnly Then
            doc.Close SaveChanges:=wdDoNotSaveChanges
            errMsg = "Word 가 읽기 전용으로 열었습니다."
            ProcessOne = "RO"
            Exit Function
        End If

        ' 변경 내용 추적이 켜져 있으면 치환이 '수정 표시'로 남는다.
        ' 잠시 끄고 저장 직전에 원래대로 되돌린다.
        On Error Resume Next
        hadTrack = doc.TrackRevisions
        doc.TrackRevisions = False
        On Error GoTo failProc
    End If

    '--- 치환 ------------------------------------------------------
    ApplyRules doc, previewOnly, fileCounts

    total = 0
    For i = 1 To gCount
        total = total + fileCounts(i)
    Next i

    '--- 사전 확인이면 저장하지 않고 닫는다 ------------------------
    If previewOnly Then
        doc.Close SaveChanges:=wdDoNotSaveChanges
        ProcessOne = IIf(total > 0, "CHANGED", "UNCHANGED")
        Exit Function
    End If

    On Error Resume Next
    doc.TrackRevisions = hadTrack
    On Error GoTo failProc

    If total > 0 Then
        doc.Save                      ' 원래 파일 형식(.doc/.docx/.docm) 유지
        doc.Close SaveChanges:=wdDoNotSaveChanges
        ProcessOne = "CHANGED"
    Else
        doc.Close SaveChanges:=wdDoNotSaveChanges
        ProcessOne = "UNCHANGED"
    End If
    Exit Function

failOpen:
    errMsg = DescribeError(Err.Number, Err.Description)
    ProcessOne = "ERR"
    Exit Function

failProc:
    errMsg = DescribeError(Err.Number, Err.Description)
    On Error Resume Next
    doc.Close SaveChanges:=wdDoNotSaveChanges
    On Error GoTo 0
    ProcessOne = "ERR"
End Function


'--- 문서 전체 영역에 규칙을 순서대로 적용 ------------------------
'  doc.StoryRanges 에는 본문/머리글/바닥글/각주/미주/주석/텍스트 상자 등
'  각 종류의 '첫 번째' 영역만 들어 있다. 같은 종류의 나머지 영역
'  (구역별 머리글, 여러 개의 텍스트 상자 등)은 NextStoryRange 로
'  이어져 있으므로 체인을 끝까지 따라간다.
Private Sub ApplyRules(ByVal doc As Document, ByVal previewOnly As Boolean, _
                       ByRef counts() As Long)
    Dim i As Long, guard As Long, found As Long
    Dim st As Range, cur As Range, nxt As Range

    For i = 1 To gCount
        If gEnabled(i) Then

            For Each st In doc.StoryRanges
                Set cur = st
                guard = 0

                Do While Not cur Is Nothing
                    guard = guard + 1
                    If guard > 5000 Then Exit Do

                    ' Word 의 '모두 바꾸기' 는 바꾼 횟수를 알려주지 않는다.
                    ' 그래서 바꾸기 직전에 같은 조건으로 먼저 세어 둔다.
                    found = CountInStory(cur, gFind(i))

                    If found > 0 Then
                        If previewOnly Then
                            counts(i) = counts(i) + found
                        ElseIf ReplaceInStory(cur, gFind(i), gRepl(i)) Then
                            counts(i) = counts(i) + found
                        End If
                    End If

                    Set nxt = Nothing
                    On Error Resume Next
                    Set nxt = cur.NextStoryRange
                    On Error GoTo 0
                    Set cur = nxt
                Loop
            Next st

        End If
    Next i
End Sub


'--- 한 영역에서 문구가 몇 번 나오는지 센다 (문서는 바꾸지 않음) ---
Private Function CountInStory(ByVal storyRng As Range, ByVal findText As String) As Long
    Dim scan As Range
    Dim storyEnd As Long, cnt As Long, lastEnd As Long
    Dim hit As Boolean

    On Error GoTo finished

    storyEnd = storyRng.End
    Set scan = storyRng.Duplicate
    lastEnd = -1

    Do
        ConfigureFind scan.Find, findText, ""
        hit = scan.Find.Execute
        If Not hit Then Exit Do

        cnt = cnt + 1
        If cnt >= MAX_SCAN Then Exit Do

        ' Execute 가 성공하면 scan 은 '찾은 부분'으로 좁혀진다.
        ' 그 다음 위치부터 영역 끝까지로 다시 잡고 계속 찾는다.
        If scan.End <= lastEnd Then Exit Do        ' 진행이 없으면 중단
        If scan.End >= storyEnd Then Exit Do       ' 영역 끝에 도달
        lastEnd = scan.End
        scan.SetRange scan.End, storyEnd
    Loop

finished:
    CountInStory = cnt
End Function


'--- 한 영역에서 '모두 바꾸기' 실행 -------------------------------
Private Function ReplaceInStory(ByVal storyRng As Range, ByVal findText As String, _
                                ByVal replText As String) As Boolean
    Dim r As Range

    On Error GoTo failed
    Set r = storyRng.Duplicate
    ConfigureFind r.Find, findText, replText
    r.Find.Execute Replace:=wdReplaceAll
    ReplaceInStory = True
    Exit Function

failed:
    ReplaceInStory = False
End Function


'--- Find 조건을 '단순 텍스트 치환' 으로 초기화 -------------------
Private Sub ConfigureFind(ByVal f As Find, ByVal findText As String, ByVal replText As String)
    With f
        .ClearFormatting
        .Replacement.ClearFormatting
        .Text = EscapeCaret(findText)
        .Replacement.Text = EscapeCaret(replText)
        .Forward = True
        .Wrap = wdFindStop          ' 영역 끝에서 멈춤 (다른 영역으로 넘어가지 않게)
        .Format = False             ' 서식 조건 없이 글자만 비교
        .MatchCase = True           ' 대소문자 구분
        .MatchWholeWord = False
        .MatchWildcards = False
        .MatchSoundsLike = False
        .MatchAllWordForms = False
    End With

    ' 한국어/동아시아판 Word 전용 옵션. 없는 버전에서는 그냥 무시된다.
    On Error Resume Next
    f.MatchByte = True              ' 전자/반자 구분
    f.MatchFuzzy = False            ' 유사 문자열 매칭 끄기
    On Error GoTo 0
End Sub


'--- '^' 를 글자 그대로 찾도록 처리 -------------------------------
'  Word 에서 '^' 는 특수 코드(^p, ^t ...)의 시작 문자다.
'  '^94' 는 캐럿 문자 자체를 뜻하는 Word 코드다.
Private Function EscapeCaret(ByVal s As String) As String
    EscapeCaret = Replace(s, "^", "^94")
End Function


'==================================================================
'  4. 결과 보고
'==================================================================
Private Sub ShowResult(ByVal previewOnly As Boolean, ByVal folder As String, _
                       ByVal recurse As Boolean, ByVal backupRoot As String, _
                       ByVal nTotal As Long, ByVal nChanged As Long, _
                       ByVal nUnchanged As Long, ByVal nOpen As Long, _
                       ByVal nRO As Long, ByVal nErr As Long, _
                       ByRef totals() As Long, ByVal detail As String, _
                       ByVal skipList As String, ByVal errList As String, _
                       ByVal startedAt As Date)
    Dim i As Long, grand As Long
    Dim head As String, body As String, ruleSummary As String

    For i = 1 To gCount
        grand = grand + totals(i)
        If gEnabled(i) Then
            ruleSummary = ruleSummary & gFind(i) & " -> " & gRepl(i) & " : " & totals(i) & "건" & vbCrLf
        End If
    Next i

    '--- 화면에 띄울 요약 -----------------------------------------
    If previewOnly Then
        head = "검사 결과   (실제 파일은 변경하지 않았습니다)" & vbCrLf & vbCrLf & _
               "대상 Word 파일 : " & nTotal & "개" & vbCrLf & _
               "적용 규칙 : " & EnabledCount() & "개" & vbCrLf & vbCrLf & _
               "변경 예상 문서 : " & nChanged & "개" & vbCrLf & _
               "변경 없음 : " & nUnchanged & "개" & vbCrLf & _
               "열려 있어 제외 : " & nOpen & "개" & vbCrLf & _
               "읽기 전용 제외 : " & nRO & "개" & vbCrLf & _
               "오류 : " & nErr & "개" & vbCrLf & vbCrLf & _
               "예상 치환 횟수 : " & grand & "회"
    Else
        head = "일괄 변경 완료" & vbCrLf & vbCrLf & _
               "전체 Word 파일 : " & nTotal & "개" & vbCrLf & _
               "변경된 파일 : " & nChanged & "개" & vbCrLf & _
               "변경 없음 : " & nUnchanged & "개" & vbCrLf & _
               "열려 있어 제외 : " & nOpen & "개" & vbCrLf & _
               "읽기 전용 제외 : " & nRO & "개" & vbCrLf & _
               "오류 : " & nErr & "개" & vbCrLf & vbCrLf & _
               "총 치환 횟수 : " & grand & "회" & vbCrLf & vbCrLf & _
               "원본 백업:" & vbCrLf & backupRoot
    End If

    MsgBox head & vbCrLf & vbCrLf & _
           String(30, "-") & vbCrLf & _
           "규칙별 건수" & vbCrLf & _
           String(30, "-") & vbCrLf & _
           ruleSummary & vbCrLf & _
           "자세한 내용은 새로 열리는 문서를 확인하세요.", _
           vbInformation, APP_TITLE

    '--- 상세 보고서를 새 문서로 만들어 보여준다 -------------------
    '  (파일로 저장하지 않으므로, 필요하면 사용자가 직접 저장하면 된다)
    body = "[" & APP_TITLE & IIf(previewOnly, " - 사전 확인", "") & "]" & vbCrLf & vbCrLf & _
           "작업시작: " & Format$(startedAt, "yyyy-mm-dd hh:nn:ss") & vbCrLf & _
           "작업종료: " & Format$(Now, "yyyy-mm-dd hh:nn:ss") & vbCrLf & vbCrLf & _
           "대상폴더:" & vbCrLf & folder & vbCrLf & _
           "하위 폴더 포함: " & IIf(recurse, "예", "아니오") & vbCrLf & vbCrLf & _
           "규칙 (사용 ON 만):" & vbCrLf & EnabledRuleText() & vbCrLf & _
           String(50, "-") & vbCrLf & vbCrLf & _
           head & vbCrLf & vbCrLf & _
           String(50, "-") & vbCrLf & _
           "규칙별 건수" & vbCrLf & _
           String(50, "-") & vbCrLf & ruleSummary & vbCrLf

    If Len(skipList) > 0 Then
        body = body & String(50, "-") & vbCrLf & _
               "[열려 있어서 제외된 파일]" & vbCrLf & String(50, "-") & vbCrLf & _
               skipList & vbCrLf
    End If
    If Len(errList) > 0 Then
        body = body & String(50, "-") & vbCrLf & _
               "[읽기 전용 / 오류 파일]" & vbCrLf & String(50, "-") & vbCrLf & _
               errList & vbCrLf
    End If

    body = body & String(50, "-") & vbCrLf & _
           "[파일별 상세]" & vbCrLf & String(50, "-") & vbCrLf & vbCrLf & _
           IIf(Len(detail) = 0, "(변경된 문서가 없습니다)" & vbCrLf, detail)

    ShowTextDocument body
End Sub


'--- 텍스트를 새 Word 문서로 열어서 보여준다 ----------------------
Private Sub ShowTextDocument(ByVal body As String)
    Dim d As Document

    On Error Resume Next
    Set d = Documents.Add
    If d Is Nothing Then Exit Sub
    With d.Content
        .Text = body
        .Font.Name = "맑은 고딕"
        .Font.Size = 10
    End With
    On Error GoTo 0
End Sub


'--- 규칙 목록을 새 문서로 보여준다 -------------------------------
Private Sub ShowRuleListDocument()
    Dim i As Long, s As String

    s = "[" & APP_TITLE & " - 치환 규칙 목록]" & vbCrLf & vbCrLf & _
        "총 " & gCount & "개  (사용 ON : " & EnabledCount() & "개)" & vbCrLf & vbCrLf & _
        "※ 위에서부터 순서대로 적용됩니다." & vbCrLf & vbCrLf & _
        String(60, "-") & vbCrLf

    For i = 1 To gCount
        s = s & i & ". [" & IIf(gEnabled(i), "ON ", "OFF") & "]  " & _
            gFind(i) & vbCrLf & _
            "       ->  " & gRepl(i) & vbCrLf
    Next i

    If gCount = 0 Then s = s & "(등록된 규칙이 없습니다)" & vbCrLf

    ShowTextDocument s
End Sub


'==================================================================
'  5. 규칙 저장 / 불러오기  (레지스트리 HKCU - 파일을 만들지 않는다)
'==================================================================
Private Sub LoadRules()
    Dim n As Long, i As Long
    Dim raw As String, parts() As String

    gCount = 0
    n = CLng(Val(GetSetting(APP_NAME, "Rules", "Count", "0")))
    If n > MAX_RULES Then n = MAX_RULES

    For i = 1 To n
        raw = GetSetting(APP_NAME, "Rules", "R" & i, "")
        If Len(raw) > 0 Then
            parts = Split(raw, vbTab)
            If UBound(parts) >= 2 Then
                gCount = gCount + 1
                gEnabled(gCount) = (parts(0) = "1")
                gFind(gCount) = parts(1)
                gRepl(gCount) = parts(2)
            End If
        End If
    Next i
End Sub

Private Sub SaveRules()
    Dim i As Long, oldCount As Long

    oldCount = CLng(Val(GetSetting(APP_NAME, "Rules", "Count", "0")))

    For i = 1 To gCount
        SaveSetting APP_NAME, "Rules", "R" & i, _
            IIf(gEnabled(i), "1", "0") & vbTab & gFind(i) & vbTab & gRepl(i)
    Next i

    ' 규칙이 줄어들었으면 남아 있는 항목을 지운다
    For i = gCount + 1 To oldCount
        On Error Resume Next
        DeleteSetting APP_NAME, "Rules", "R" & i
        On Error GoTo 0
    Next i

    SaveSetting APP_NAME, "Rules", "Count", CStr(gCount)
End Sub


'==================================================================
'  6. 파일 / 폴더 도우미
'==================================================================

'--- 대상 Word 문서 수집 ------------------------------------------
'  Dir 함수는 중첩해서 쓸 수 없으므로, 폴더 목록을 큐처럼 늘려가며 처리한다.
Private Function CollectFiles(ByVal rootPath As String, ByVal recurse As Boolean) As Collection
    Dim result As New Collection
    Dim folders As New Collection
    Dim idx As Long
    Dim cur As String, nm As String

    folders.Add RemoveSlash(rootPath)
    idx = 1

    Do While idx <= folders.Count
        cur = folders(idx)

        ' 이 폴더의 파일들
        nm = Dir(AddSlash(cur) & "*.*", vbNormal)
        Do While Len(nm) > 0
            If IsTargetFile(nm) Then result.Add AddSlash(cur) & nm
            nm = Dir
        Loop

        ' 하위 폴더 (백업 폴더는 제외)
        If recurse Then
            nm = Dir(AddSlash(cur) & "*.*", vbDirectory)
            Do While Len(nm) > 0
                If nm <> "." And nm <> ".." Then
                    If IsFolder(AddSlash(cur) & nm) Then
                        If Not IsBackupFolderName(nm) Then folders.Add AddSlash(cur) & nm
                    End If
                End If
                nm = Dir
            Loop
        End If

        idx = idx + 1
    Loop

    Set CollectFiles = result
End Function

Private Function IsTargetFile(ByVal nm As String) As Boolean
    Dim pos As Long, ext As String

    If Left$(nm, 2) = "~$" Then Exit Function      ' Word 임시 파일 제외
    pos = InStrRev(nm, ".")
    If pos = 0 Then Exit Function

    ext = LCase$(Mid$(nm, pos))
    IsTargetFile = (ext = ".docx" Or ext = ".docm" Or ext = ".doc")
End Function

Private Function IsBackupFolderName(ByVal nm As String) As Boolean
    IsBackupFolderName = (InStr(nm, BACKUP_MARK) > 0) Or _
                         (InStr(LCase$(nm), "backup") > 0) Or _
                         (InStr(nm, "백업") > 0)
End Function

Private Function IsFolder(ByVal p As String) As Boolean
    On Error Resume Next
    IsFolder = ((GetAttr(p) And vbDirectory) = vbDirectory)
End Function

Private Function FolderExists(ByVal p As String) As Boolean
    If Len(p) = 0 Then Exit Function
    On Error Resume Next
    FolderExists = ((GetAttr(p) And vbDirectory) = vbDirectory)
End Function

Private Function IsReadOnlyFile(ByVal p As String) As Boolean
    On Error Resume Next
    IsReadOnlyFile = ((GetAttr(p) And vbReadOnly) = vbReadOnly)
End Function

Private Function AddSlash(ByVal p As String) As String
    If Right$(p, 1) = "\" Then
        AddSlash = p
    Else
        AddSlash = p & "\"
    End If
End Function

Private Function RemoveSlash(ByVal p As String) As String
    If Len(p) > 3 And Right$(p, 1) = "\" Then
        RemoveSlash = Left$(p, Len(p) - 1)
    Else
        RemoveSlash = p
    End If
End Function

Private Function FileNameOnly(ByVal p As String) As String
    Dim pos As Long
    pos = InStrRev(p, "\")
    If pos = 0 Then
        FileNameOnly = p
    Else
        FileNameOnly = Mid$(p, pos + 1)
    End If
End Function

'--- 폴더 선택 대화상자 -------------------------------------------
Private Function PickFolder(ByVal startPath As String) As String
    Dim fd As FileDialog

    Set fd = Application.FileDialog(msoFileDialogFolderPicker)
    fd.Title = "SOP 문서가 들어 있는 폴더를 선택하세요"
    If FolderExists(startPath) Then fd.InitialFileName = AddSlash(startPath)

    If fd.Show = -1 Then PickFolder = fd.SelectedItems(1)
End Function

'--- 백업 폴더 이름 만들기 ----------------------------------------
'  C:\SOP\생산절차서  ->  C:\SOP\생산절차서_원본백업_20260827_143500
Private Function MakeBackupRoot(ByVal folder As String) As String
    Dim pos As Long, stamp As String

    stamp = Format$(Now, "yyyymmdd_hhnnss")
    folder = RemoveSlash(folder)
    pos = InStrRev(folder, "\")

    If pos <= 3 Then
        ' 드라이브 루트라서 형제 폴더를 만들 수 없는 경우 -> 폴더 안쪽에 만든다
        MakeBackupRoot = AddSlash(folder) & "원본백업_" & stamp
    Else
        MakeBackupRoot = Left$(folder, pos - 1) & "\" & Mid$(folder, pos + 1) & BACKUP_MARK & stamp
    End If
End Function

'--- 폴더를 상위부터 차례로 만든다 --------------------------------
Private Sub EnsureFolder(ByVal p As String)
    Dim parent As String, pos As Long

    If Len(p) = 0 Then Exit Sub
    If FolderExists(p) Then Exit Sub

    pos = InStrRev(p, "\")
    If pos > 3 Then
        parent = Left$(p, pos - 1)
        EnsureFolder parent
    End If

    On Error Resume Next
    MkDir p
End Sub

'--- 원본 파일 한 개를 백업 폴더로 복사 (하위 구조 유지) ----------
Private Function BackupOne(ByVal src As String, ByVal srcRoot As String, _
                           ByVal bkRoot As String) As Boolean
    Dim rel As String, dest As String, pos As Long

    On Error GoTo failed

    rel = Mid$(src, Len(AddSlash(srcRoot)) + 1)
    dest = AddSlash(bkRoot) & rel

    pos = InStrRev(dest, "\")
    If pos > 3 Then EnsureFolder Left$(dest, pos - 1)

    FileCopy src, dest
    BackupOne = FileExists(dest)
    Exit Function

failed:
    BackupOne = False
End Function

Private Function FileExists(ByVal p As String) As Boolean
    On Error Resume Next
    FileExists = (Len(Dir(p, vbNormal)) > 0)
End Function


'==================================================================
'  7. 기타 도우미
'==================================================================

'--- 현재 Word 에 열려 있는 문서들의 경로 (소문자) ----------------
'  이 매크로는 사용자의 Word 안에서 실행되므로,
'  Documents 컬렉션이 곧 '지금 열려 있는 문서' 목록이다.
Private Function OpenDocPaths() As Collection
    Dim c As New Collection
    Dim d As Document

    On Error Resume Next
    For Each d In Application.Documents
        If Len(d.Path) > 0 Then c.Add LCase$(d.FullName)   ' 저장 안 된 새 문서는 제외
    Next d
    On Error GoTo 0

    Set OpenDocPaths = c
End Function

Private Function InCollection(ByVal c As Collection, ByVal v As String) As Boolean
    Dim entry As Variant

    For Each entry In c
        If entry = v Then
            InCollection = True
            Exit Function
        End If
    Next entry
End Function

Private Function EnabledCount() As Long
    Dim i As Long

    For i = 1 To gCount
        If gEnabled(i) Then EnabledCount = EnabledCount + 1
    Next i
End Function

Private Function FindDuplicate(ByVal f As String, ByVal r As String, _
                               ByVal skipIdx As Long) As Long
    Dim i As Long

    For i = 1 To gCount
        If i <> skipIdx Then
            If gFind(i) = f And gRepl(i) = r Then
                FindDuplicate = i
                Exit Function
            End If
        End If
    Next i
End Function

Private Function CheckLength(ByVal s As String, ByVal label As String) As Boolean
    If Len(s) > MAX_TEXT Then
        MsgBox "'" & label & "' 는 " & MAX_TEXT & "자를 넘을 수 없습니다." & vbCrLf & _
               "(Microsoft Word 자체의 제한입니다)", vbExclamation, APP_TITLE
        Exit Function
    End If
    CheckLength = True
End Function

Private Function AskRuleNumber(ByVal prompt As String) As Long
    Dim s As String, n As Long

    If gCount = 0 Then
        MsgBox "등록된 규칙이 없습니다.", vbInformation, APP_TITLE
        Exit Function
    End If

    s = InputBox(RuleListText(700) & vbCrLf & prompt, APP_TITLE)
    If Len(Trim$(s)) = 0 Then Exit Function

    n = CLng(Val(s))
    If n < 1 Or n > gCount Then
        MsgBox "1 ~ " & gCount & " 사이의 번호를 입력하세요.", vbExclamation, APP_TITLE
        Exit Function
    End If

    AskRuleNumber = n
End Function

'--- 규칙 목록을 짧게 요약한 문자열 (InputBox 표시용) --------------
Private Function RuleListText(ByVal maxChars As Long) As String
    Dim i As Long, s As String, ln As String

    If gCount = 0 Then
        RuleListText = "(등록된 규칙이 없습니다)" & vbCrLf
        Exit Function
    End If

    For i = 1 To gCount
        ln = i & ". [" & IIf(gEnabled(i), "ON ", "OFF") & "] " & _
             Shorten(gFind(i), 20) & "  ->  " & Shorten(gRepl(i), 20)

        If maxChars > 0 And Len(s) + Len(ln) + 2 > maxChars Then
            s = s & "  ... 외 " & (gCount - i + 1) & "개" & vbCrLf
            Exit For
        End If

        s = s & ln & vbCrLf
    Next i

    RuleListText = s
End Function

Private Function EnabledRuleText() As String
    Dim i As Long, s As String

    For i = 1 To gCount
        If gEnabled(i) Then s = s & gFind(i) & " -> " & gRepl(i) & vbCrLf
    Next i

    If Len(s) = 0 Then s = "(없음)" & vbCrLf
    EnabledRuleText = s
End Function

Private Function Shorten(ByVal s As String, ByVal n As Long) As String
    If Len(s) = 0 Then
        Shorten = "(삭제)"
    ElseIf Len(s) > n Then
        Shorten = Left$(s, n - 1) & "…"
    Else
        Shorten = s
    End If
End Function

'--- COM/Word 오류를 알기 쉬운 한국어로 바꾼다 --------------------
Private Function DescribeError(ByVal num As Long, ByVal desc As String) As String
    Dim d As String
    d = LCase$(desc)

    If InStr(d, "password") > 0 Or InStr(desc, "암호") > 0 Then
        DescribeError = "암호가 설정된 문서입니다."
    ElseIf InStr(d, "read-only") > 0 Or InStr(desc, "읽기 전용") > 0 Then
        DescribeError = "파일이 읽기 전용입니다."
    ElseIf InStr(d, "in use") > 0 Or InStr(desc, "사용 중") > 0 Then
        DescribeError = "다른 프로그램이 파일을 사용 중입니다."
    ElseIf InStr(d, "cannot be found") > 0 Or InStr(desc, "찾을 수 없") > 0 Then
        DescribeError = "파일을 찾을 수 없습니다."
    Else
        DescribeError = "오류 " & num & " : " & desc
    End If
End Function
