# 찬홍팍 주식관리

구매 이력만 파일로 넣으면 **평단 / 현재가 / 주수 / 비중**을 자동 환산하고,
**국가별·종목별·섹터별 목표 비중**을 벗어나면 매수·매도를 안내하는 개인용 시스템.
실시간 시세는 무료 API 를 여러 개 물려서 하나가 죽어도 다음 걸로 넘어간다.

- 외부 파이썬 패키지 없이 동작 (설정 파일만 YAML 이라 PyYAML 1개 필요)
- 미국 / 한국 / 베트남 종목 전부 지원, 통화가 달라도 기준통화(KRW)로 환산해서 비중 계산
- 모든 안내는 **BYPASS(예외 처리)** 로 끌 수 있고, 꺼진 것도 사유와 함께 화면에 남는다

```
python3 -m portfolio serve         # 폰에서 쓸 웹앱(PWA) 띄우기
python3 -m portfolio show          # 터미널 리포트
python3 -m portfolio html          # 정적 리포트 HTML 생성
```

---

## 0. 폰에서 쓰는 앱 (PWA) — 여기부터 보세요

`web/` 폴더가 **설치형 웹앱**입니다. 폰 홈 화면에 `찬홍팍` 이름으로 추가되고,
비행기 모드에서도 켜지며, **매수 내역을 앱에서 직접 입력**해서 관리합니다.

### 여는 방법 3가지

| 방법 | 준비 | 폰에서 쓰기 |
|---|---|---|
| **① GitHub Pages** (권장) | 저장소 Settings → Pages → Source 를 **GitHub Actions** 로 변경 | `https://<계정>.github.io/<저장소>/` 접속 → 홈 화면에 추가 |
| **② PC 에서 서버** | `python3 -m portfolio serve` | 같은 와이파이에서 `http://<PC IP>:8765` |
| **③ 아무 정적 호스팅** | `web/` 폴더 통째로 업로드 | 그 주소로 접속 |

> 서비스워커(오프라인 실행)는 **https 또는 localhost 에서만** 동작합니다.
> 파일을 직접 열면(`file://`) 앱은 돌아가지만 오프라인 캐시는 안 됩니다.

### 화면 구성

- **맨 위 — 보유 주식 현황**: 종목별 비중 / 수익률 / 주수 / 평단 / 현재가 / 평가액.
  현재가 숫자를 누르면 **직접 고칠 수 있습니다.**
- **그 아래 — 관리 현황**: 국가 · 섹터 · 종목 · 통화 · 계좌 · 태그 · 자산군 **7개 축**을
  칩으로 전환하며 봅니다. 목표를 걸어둔 항목은 `비중 많음 / 적정 / 비중 적음` 으로 판정됩니다.
- **매매 안내**: 목표를 벗어난 만큼 **몇 원어치 · 몇 주**를 사고팔면 되는지 나옵니다.
- 오른쪽 위 **+ 추가** — 일자 / 종목 / 구분 / 수량 / 단가 / 수수료 / 계좌 / 메모 입력.
  목록에서 항목을 누르면 수정·삭제됩니다.
- 오른쪽 위 **설치** — 홈 화면에 추가 (아이폰은 공유 → 홈 화면에 추가).

### 목표는 3가지 방식으로 걸 수 있습니다

| 기준 | 예시 | 허용오차 의미 |
|---|---|---|
| **비중 %** | 미국 55% | ±%p (예: 5 → 50~60%) |
| **투자금액** | LG전자 300만원 | 목표의 ±% (예: 10 → 270~330만원) |
| **주 수량** | 삼성전자 100주 | 목표의 ±% |

축(국가/섹터/종목/…)마다 여러 개를 섞어 쓸 수 있습니다.
예시 데이터에는 삼성전자를 **주 수량 100주**, LG전자를 **투자금액 300만원**,
나머지는 **비중 %** 로 걸어놨습니다.

### 데이터는 어디에 저장되나요 (리셋 안 되나요?)

- 저장 위치는 **그 기기의 브라우저 저장소**입니다. 서버로 아무것도 보내지 않습니다.
- 새로고침·앱 재시작·폰 재부팅으로는 **지워지지 않습니다.**
- 안전장치를 3중으로 걸어놨습니다.
  1. `localStorage` 기본 저장 + `IndexedDB` 사본 (하나가 비면 다른 쪽에서 복구)
  2. `navigator.storage.persist()` 로 **브라우저 자동 정리 대상에서 제외** 요청
     (설정 탭에서 "영구보관 켜짐" 여부를 확인할 수 있습니다)
  3. 저장할 때마다 **되돌리기 지점 5개** 보관 → 설정 탭의 `되돌리기`
- 다만 **브라우저 사이트 데이터 삭제**, **앱 삭제**, **시크릿 모드**는 못 막습니다.
  설정 탭의 `전체 백업(JSON)` 을 가끔 눌러 파일로 받아두세요. 그 파일로 언제든 복원됩니다.
- 아이폰 Safari 는 홈 화면에 추가하지 않고 브라우저 탭으로만 쓰면 오래 방치 시
  저장소를 정리할 수 있습니다. **홈 화면에 추가해서 쓰는 걸 권합니다.**

### 폰에서 실시간 시세

브라우저는 CORS 정책 때문에 아무 API나 못 부릅니다. Yahoo·네이버·Stooq 는 브라우저에서 직접
호출이 막혀 있어서, 폰에서 쓸 수 있는 경로는 이렇습니다.

1. **무료 API 키 입력** (설정 탭 → 시세 API) — 이게 제일 간단합니다.
   - `Twelve Data` (800회/일, 한국·베트남 포함) ← 한 개만 넣는다면 이걸 추천
   - `Finnhub` (60회/분, 미국), `Alpha Vantage` (25회/일)
2. **PC 서버 사용** — `python3 -m portfolio serve` 가 켜져 있으면 앱이 자동으로 감지해서
   서버 쪽 공급자(Yahoo/네이버/베트남 등 8종)를 씁니다.
3. **직접 입력** — 보유 현황 표의 현재가를 눌러 숫자만 고치면 됩니다. 키도 서버도 필요 없습니다.

환율은 키 없이 브라우저에서 바로 받아집니다(frankfurter / open.er-api / exchangerate.host).


---

## 1. CLI 로 쓰기 (PC)

```bash
git clone <이 저장소>
cd chanhong
pip install pyyaml            # 설정 파일(YAML)을 읽는 데만 쓰인다
                              # 설치가 곤란하면 같은 내용을 data/settings.json 으로
                              # 만들어 두면 PyYAML 없이도 그걸 읽는다

python3 -m portfolio show               # 실시간 시세 받아서 계산
python3 -m portfolio show --offline     # 네트워크 없이 마지막 캐시로 계산
python3 -m portfolio show --refresh -v  # 캐시 무시하고 새로 받기 + 수집 로그 전부 보기
```

예시 데이터(삼성전자 / LG전자 / 애플 / 아마존 / 테슬라 / FPT(베트남))가 이미 들어 있어서
클론 직후 바로 돌아간다.

> **처음 실행 시 주의**: 저장소에 들어 있는 `data/cache/quotes.seed.json` 은 개발용
> **데모 스냅샷**이지 실제 시세가 아니다. 네트워크가 되는 환경에서 `--refresh` 를 한 번
> 돌리면 실제 API 값이 `data/cache/quotes.json` 에 저장되고 그 뒤로는 시드를 쓰지 않는다.
> 시드/캐시에서 온 값은 리포트에 `*` 와 "캐시(과거) 값" 경고로 표시된다.

---

## 2. 내 매매 이력 입력하기

### 방법 A - `data/transactions.csv` 를 직접 편집

```csv
date,ticker,side,quantity,price,fee,account,note
2023-03-15,005930.KS,BUY,50,60500,4537,키움,첫 매수
2025-02-14,TSLA,SELL,4,355.00,1.07,미래에셋,일부 익절
```

| 컬럼 | 설명 |
|---|---|
| `date` | 체결일. `2024-01-05`, `2024/01/05`, `2024.01.05`, `20240105` 다 됨 |
| `ticker` | 미국 `AAPL` / 한국 `005930.KS`(코스피), `.KQ`(코스닥) / 베트남 `FPT.VN` |
| `side` | `BUY`/`SELL` 또는 `매수`/`매도` |
| `quantity` | 주수 (소수점 가능 - 소수점 매수 대응) |
| `price` | **종목 통화 기준** 체결 단가 (애플은 USD, 삼성은 KRW, FPT 는 VND) |
| `fee` | 수수료·세금. 매수 시 평단에 포함되고 매도 시 실현손익에서 차감 |
| `account` | 증권사/계좌. 계좌별 비중 집계에 쓰임 |

### 방법 B - 폰이나 증권사에서 받은 파일을 가져오기

```bash
python3 -m portfolio import ~/Downloads/거래내역.xlsx
```

- `.csv` `.tsv` `.json` `.xlsx` 지원 (xlsx 는 `pip install openpyxl` 필요)
- 한글 헤더 자동 인식: `날짜/거래일`, `종목/종목코드`, `구분/매매구분`, `수량/주수`,
  `단가/가격/평단`, `수수료`, `계좌/증권사`, `메모/비고`
- `1,000` 같은 천단위 쉼표, `$150.25`, `70,500원` 전부 파싱
- 이미 있는 거래는 자동으로 건너뛰므로 **같은 파일을 여러 번 넣어도 안전**하다

가져온 뒤 `settings.yaml` 의 `assets` 에 없는 종목이 있으면 경고해 준다.
국가/통화를 등록해야 국가별 비중과 환산이 맞는다.

---

## 3. 목표 비중과 매매 안내 (`data/settings.yaml`)

### 구분 기준 (요청하신 "종목별/국가별 + 추천")

기본으로 **7가지 축**으로 동시에 쪼개서 보여준다.

| 축 | 목표 설정 | 왜 필요한가 |
|---|---|---|
| **국가** `country` | O | 요청 사항. 환율·정치 리스크 단위 |
| **종목** `ticker` | O | 요청 사항. 개별 종목 쏠림 방지 |
| **섹터** `sector` | O | *추천.* 국가는 분산됐는데 전부 반도체인 상황을 잡아낸다 |
| **통화** `currency` | O | *추천.* 국가 ≠ 통화. 실제 환노출은 통화 기준이다 |
| **자산군** `asset_class` | O | *추천.* 주식/ETF/현금/채권 섞을 때 |
| **계좌** `account` | O | *추천.* 증권사별 잔고 관리, 연금계좌 한도 관리 |
| **태그** `tag` | O | *추천.* `대형주/성장주/배당/고변동` 같은 자유 분류 |

여기에 더해 총괄 화면에 **집중도 지표**를 넣었다.
- `상위3종목 비중` - 한눈에 보는 쏠림
- `HHI`(허핀달 지수) / `실질분산 종목수` - 10종목을 갖고 있어도 한 종목이 70%면
  실질분산은 2개 수준이라는 걸 숫자로 보여준다

### 목표 설정 문법

```yaml
targets:
  country:
    tolerance: 5              # 그룹 공통 허용오차 ±5%p
    items:
      KR: {target: 30}                          # 25~35% 면 적정
      US: {target: 55, min: 45, max: 62}        # min/max 를 쓰면 그게 우선
      VN: {target: 15, tolerance: 3}            # 이 항목만 ±3%p (12~18%)
      JP: {target: 10, bypass: true}            # 이 항목만 안내 끄기
  sector:
    enabled: false            # 섹터 판정 자체를 끄기
```

- 비중이 **상한 초과** → `매도` 안내, 목표까지 되돌리는 데 필요한 금액과 주수를 계산
- 비중이 **하한 미달** → `매수` 안내
- 그룹(국가/섹터) 신호는 그룹 안에서 **실행 후보 종목**까지 골라준다
  (매도는 많이 오른 것부터, 매수는 덜 오른 것부터)

### 종목 단위 안전장치

```yaml
rules:
  max_position_weight: 30    # 1종목 비중 상한 -> 초과 시 매도
  min_position_weight: 3     # 자투리 종목 -> 정리 또는 추가매수
  take_profit_pct: 60        # 이만큼 오르면 일부 익절 검토
  stop_loss_pct: -25         # 손절선
  min_trade_amount: 300000   # 조정액이 이보다 작으면 '참고'로만 표시(잦은 매매 방지)
  cash: 0                    # 예수금. --cash 로 덮어쓰기 가능
```

---

## 4. BYPASS (예외 처리)

안내를 무시하고 싶을 때 쓴다. **예외 처리된 신호도 사라지지 않고**
"예외" 상태 + 사유와 함께 표에 남기 때문에, 왜 안내가 안 나왔는지 나중에 추적할 수 있다.

```yaml
bypass:
  enabled: true
  entries:
    - scope: ticker
      key: TSLA
      reason: 장기 보유 종목이라 비중 초과해도 매도 안 함
      until: 2026-12-31        # 이 날짜가 지나면 자동으로 다시 감시
    - scope: sector
      key: IT서비스
      reason: 베트남 계좌 환전 절차가 번거로워 당분간 손대지 않음
```

`scope` 는 `ticker` `country` `sector` `currency` `account` `asset_class` `rule` `all`,
`key` 에 `*` 를 쓰면 그 축 전체.

CLI 로 일회성 예외도 가능하다.

```bash
python3 -m portfolio show --bypass TSLA                    # 티커 예외
python3 -m portfolio show --bypass "country:VN=환전 이슈"  # 사유까지
python3 -m portfolio show --no-bypass                      # 예외 전부 무시하고 전수 점검
```

실행 후 **"이번에 걸리지 않은 예외 설정"** 을 알려준다. 티커 오타나 기간이 지난
예외가 방치되는 걸 막기 위한 장치다.

---

## 5. 실시간 시세 API

`providers.order` 순서대로 시도하고 **첫 성공 값**을 쓴다. 전부 실패하면 마지막 캐시로 대체하고
그 사실을 리포트에 표시한다. 어느 종목을 어디서 받았는지 표의 `출처` 칸에 나온다.

| id | 소스 | 키 | 범위 | 비고 |
|---|---|---|---|---|
| `yahoo` | Yahoo Finance | 불필요 | 전 세계 | 미국·한국(.KS/.KQ)·베트남(.VN) 다 됨. 1순위 |
| `naver` | 네이버 금융 | 불필요 | 한국 | 국내 종목 폴백 |
| `vietnam` | TCBS → VNDirect | 불필요 | 베트남 | 천VND 단위 자동 환산 |
| `stooq` | Stooq CSV | 불필요 | 미국·유럽 | 종가 위주(지연) |
| `finnhub` | Finnhub | `FINNHUB_API_KEY` | 미국 | 무료 60회/분 |
| `twelvedata` | Twelve Data | `TWELVE_DATA_API_KEY` | 전 세계 | 무료 800회/일 |
| `marketstack` | Marketstack | `MARKETSTACK_API_KEY` | 전 세계 | 무료 100회/월 |
| `alphavantage` | Alpha Vantage | `ALPHAVANTAGE_API_KEY` | 전 세계 | 무료 25회/일 |

키가 필요한 곳은 **환경변수만 넣으면 자동으로 활성화**되고, 없으면 조용히 건너뛴다.

```bash
export FINNHUB_API_KEY=xxxxx
python3 -m portfolio providers    # 지금 뭐가 붙어 있는지 확인
```

**환율**은 `open.er-api.com` → `frankfurter.app` → `exchangerate.host` →
Yahoo FX 페어 → Stooq 순으로 시도한다 (전부 키 불필요).

시세는 `cache_ttl_seconds`(기본 300초) 동안 재사용해서 API 호출을 아낀다.
지금 당장 다시 받고 싶으면 `--refresh`.

---

## 6. 화면과 출력

```bash
python3 -m portfolio show            # 터미널: 총괄/보유/축별 비중/판정/주문서
python3 -m portfolio show --all      # '적정' 판정까지 전부 표시
python3 -m portfolio html            # web/dashboard.html (파일 하나로 완결)
python3 -m portfolio serve --port 8765
#   -> 같은 와이파이면 폰 브라우저에서 http://<PC IP>:8765/dashboard.html 로 접속
python3 -m portfolio export --json out.json --csv out.csv
```

**실행 요약(주문서)** 은 겹치는 규칙을 종목 단위로 합쳐서 보여준다.
국가 초과 + 섹터 초과 + 종목 상한이 사실상 같은 매도를 가리키는 경우 금액을 더하지 않고
**가장 큰 제약 하나**만 남기며, 매수/매도가 동시에 걸리면 상계해서 순매매만 표시한다.

대시보드 HTML 은 외부 라이브러리를 하나도 안 쓰고, 하단 `<pre id="portfolio-data">` 에
계산 결과 JSON 이 통째로 들어 있다. 나중에 차트를 붙일 때 그대로 재사용하면 된다.

---

## 7. 계산 규칙 (알고 있어야 할 것)

- **평단**은 이동평균법. 매수 수수료는 평단에 포함, 매도해도 평단은 변하지 않는다.
- **실현손익**은 매도 시점의 평단 기준으로 잡는다. 다만 외화 실현손익을 기준통화로 바꿀 때
  **매도 당시 환율이 아니라 현재 환율**을 쓴다(단순화). 세무 신고용이 아니라 관리용 숫자다.
- **비중**은 `평가금액 / (시세를 받은 전체 평가금액 + 예수금)`.
  시세를 못 받은 종목은 분모에서 빠지고 `시세 미확보` 로 따로 표시된다.
- 태그·계좌가 여러 개인 포지션은 해당 축에서 **균등 분할**해서 집계한다.
- 표시 색은 국내 관행대로 **상승 빨강 / 하락 파랑**.

---

## 8. 구조

```
web/                     ← 폰에서 쓰는 PWA (독립 동작, 서버 불필요)
  index.html             화면 골격
  css/app.css            폰 우선 스타일 (라이트/다크 자동)
  js/store.js            localStorage + IndexedDB + 스냅샷 저장소
  js/engine.js           평단·평가·비중·축별 집계  (portfolio/engine.py 와 같은 계산)
  js/rules.js            목표 판정(비중%/금액/주수) · BYPASS · 주문서 합산
  js/quotes.js           브라우저 시세 수집 (CORS 되는 공급자 + 로컬 서버)
  js/ui.js  js/app.js    렌더링 / 이벤트
  sw.js  manifest.webmanifest  icons/   오프라인 실행 + 홈 화면 설치

portfolio/               ← PC 용 CLI + 로컬 API 서버
  models.py    Asset / Transaction / Quote / Position / Signal / PlanItem
  config.py    settings.yaml 로딩 (+ 앱이 저장한 settings.overrides.json 병합)
  loader.py    거래내역 파일 읽기·쓰기·삭제 (한글 헤더, 다양한 포맷)
  httpx.py     표준 라이브러리 HTTP 헬퍼
  providers/   시세 API 어댑터 8종
  fx.py        환율 (5개 소스 폴백)
  quotes.py    공급자 폴백 체인 + 캐시 + 병렬 수집
  engine.py    포지션 계산, 축별 집계, 집중도 지표
  rules.py     목표 대비 판정, BYPASS, 주문서 합산
  report.py    터미널 출력 (한글 폭 정렬)
  dashboard.py 정적 리포트 HTML
  exporter.py  JSON/CSV 내보내기
  server.py    PWA 서빙 + JSON API (앱의 시세 수집 대행)
  cli.py       커맨드라인

data/
  settings.yaml            설정 (CLI 기준)
  settings.overrides.json  앱에서 바꾼 설정 (있으면 위에 덮어씀, 자동 생성)
  transactions.csv         매매 이력
  cache/quotes.json        시세 캐시 (자동 생성, git 제외)
  cache/quotes.seed.json   데모용 스냅샷

tools/make_icons.mjs       앱 아이콘 PNG 생성 (아이콘 바꿀 때만 실행)
tests/                     파이썬 38개 + 웹앱 26개
```

```bash
python3 -m unittest discover -s tests -t .   # 계산·규칙·예외·로더
node --test "tests/js/*.test.mjs"            # 웹앱 엔진 (같은 값이 나오는지 포함)
```

> 계산 로직이 파이썬과 자바스크립트 양쪽에 있는 건, 앱이 서버 없이 폰에서 혼자
> 돌아가야 하기 때문이다. 두 엔진이 **예시 데이터에서 같은 값**을 내는지 테스트로
> 고정해놨다 (`예시 데이터는 파이썬 엔진과 같은 값이 나온다`).

---

## 9. 앞으로 붙일 수 있는 것

- 그래픽 개선 (지금은 표 + 막대 위주. JSON 이 그대로 들어 있어 차트 붙이기 쉬움)
- 배당 이력 관리와 배당수익률(YOC)
- 매도 당시 환율을 쓰는 정확한 실현손익 / 양도세 추정
- 목표 비중 도달까지의 자동 분할매수 스케줄
- cron 으로 매일 자동 실행 + 안내 발생 시 알림
