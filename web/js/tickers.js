// 종목 빠른 입력용 사전 + 검색.
//
// "삼성" 만 쳐도 삼성전자가 나오게 하려고 이름/영문/티커/초성으로 찾는다.
// 여기 없는 종목도 티커를 직접 치면 그대로 등록되므로, 이 목록은 어디까지나 '도우미'다.
// 종목코드가 맞는지는 화면에 같이 보여주고 사용자가 확인하게 한다.

const KR = [
  ['005930.KS', '삼성전자', 'Samsung Electronics', '반도체'],
  ['000660.KS', 'SK하이닉스', 'SK Hynix', '반도체'],
  ['373220.KS', 'LG에너지솔루션', 'LG Energy Solution', '2차전지'],
  ['207940.KS', '삼성바이오로직스', 'Samsung Biologics', '바이오/제약'],
  ['005380.KS', '현대차', 'Hyundai Motor', '자동차'],
  ['000270.KS', '기아', 'Kia', '자동차'],
  ['012330.KS', '현대모비스', 'Hyundai Mobis', '자동차'],
  ['005490.KS', 'POSCO홀딩스', 'POSCO Holdings', '철강'],
  ['051910.KS', 'LG화학', 'LG Chem', '화학'],
  ['006400.KS', '삼성SDI', 'Samsung SDI', '2차전지'],
  ['035420.KS', 'NAVER', 'Naver', '인터넷'],
  ['035720.KS', '카카오', 'Kakao', '인터넷'],
  ['068270.KS', '셀트리온', 'Celltrion', '바이오/제약'],
  ['066570.KS', 'LG전자', 'LG Electronics', '가전/전장'],
  ['105560.KS', 'KB금융', 'KB Financial', '금융'],
  ['055550.KS', '신한지주', 'Shinhan Financial', '금융'],
  ['086790.KS', '하나금융지주', 'Hana Financial', '금융'],
  ['316140.KS', '우리금융지주', 'Woori Financial', '금융'],
  ['024110.KS', '기업은행', 'Industrial Bank of Korea', '금융'],
  ['032830.KS', '삼성생명', 'Samsung Life', '금융'],
  ['000810.KS', '삼성화재', 'Samsung Fire & Marine', '금융'],
  ['028260.KS', '삼성물산', 'Samsung C&T', '건설'],
  ['009150.KS', '삼성전기', 'Samsung Electro-Mechanics', 'IT하드웨어'],
  ['018260.KS', '삼성에스디에스', 'Samsung SDS', 'IT서비스'],
  ['096770.KS', 'SK이노베이션', 'SK Innovation', '에너지'],
  ['034730.KS', 'SK', 'SK Inc', '지주'],
  ['017670.KS', 'SK텔레콤', 'SK Telecom', '통신'],
  ['030200.KS', 'KT', 'KT', '통신'],
  ['032640.KS', 'LG유플러스', 'LG Uplus', '통신'],
  ['015760.KS', '한국전력', 'KEPCO', '에너지'],
  ['033780.KS', 'KT&G', 'KT&G', '유통/소비재'],
  ['051900.KS', 'LG생활건강', 'LG H&H', '유통/소비재'],
  ['090430.KS', '아모레퍼시픽', 'Amorepacific', '유통/소비재'],
  ['097950.KS', 'CJ제일제당', 'CJ CheilJedang', '식품'],
  ['271560.KS', '오리온', 'Orion', '식품'],
  ['004370.KS', '농심', 'Nongshim', '식품'],
  ['282330.KS', 'BGF리테일', 'BGF Retail', '유통/소비재'],
  ['069960.KS', '현대백화점', 'Hyundai Department Store', '유통/소비재'],
  ['139480.KS', '이마트', 'Emart', '유통/소비재'],
  ['012450.KS', '한화에어로스페이스', 'Hanwha Aerospace', '방산'],
  ['047810.KS', '한국항공우주', 'Korea Aerospace', '방산'],
  ['064350.KS', '현대로템', 'Hyundai Rotem', '방산'],
  ['329180.KS', 'HD현대중공업', 'HD Hyundai Heavy', '조선'],
  ['009540.KS', 'HD한국조선해양', 'HD KSOE', '조선'],
  ['010140.KS', '삼성중공업', 'Samsung Heavy', '조선'],
  ['042660.KS', '한화오션', 'Hanwha Ocean', '조선'],
  ['034020.KS', '두산에너빌리티', 'Doosan Enerbility', '에너지'],
  ['267250.KS', 'HD현대', 'HD Hyundai', '지주'],
  ['010950.KS', 'S-Oil', 'S-Oil', '에너지'],
  ['078930.KS', 'GS', 'GS Holdings', '지주'],
  ['011200.KS', 'HMM', 'HMM', '해운'],
  ['086280.KS', '현대글로비스', 'Hyundai Glovis', '물류'],
  ['003490.KS', '대한항공', 'Korean Air', '항공'],
  ['323410.KS', '카카오뱅크', 'KakaoBank', '금융'],
  ['259960.KS', '크래프톤', 'Krafton', '게임'],
  ['036570.KS', '엔씨소프트', 'NCSoft', '게임'],
  ['251270.KS', '넷마블', 'Netmarble', '게임'],
  ['352820.KS', '하이브', 'HYBE', '엔터'],
  ['128940.KS', '한미약품', 'Hanmi Pharm', '바이오/제약'],
  ['000100.KS', '유한양행', 'Yuhan', '바이오/제약'],
  ['302440.KS', 'SK바이오사이언스', 'SK Bioscience', '바이오/제약'],
  ['001040.KS', 'CJ', 'CJ Corp', '지주'],
  ['011170.KS', '롯데케미칼', 'Lotte Chemical', '화학'],
  ['010130.KS', '고려아연', 'Korea Zinc', '비철금속'],
  ['004020.KS', '현대제철', 'Hyundai Steel', '철강'],
  ['241560.KS', '두산밥캣', 'Doosan Bobcat', '기계'],
  ['006800.KS', '미래에셋증권', 'Mirae Asset Securities', '금융'],
  ['016360.KS', '삼성증권', 'Samsung Securities', '금융'],
  ['071050.KS', '한국금융지주', 'Korea Investment Holdings', '금융'],
  ['180640.KS', '한진칼', 'Hanjin KAL', '지주'],
  ['247540.KQ', '에코프로비엠', 'Ecopro BM', '2차전지'],
  ['086520.KQ', '에코프로', 'Ecopro', '2차전지'],
  ['196170.KQ', '알테오젠', 'Alteogen', '바이오/제약'],
  ['058470.KQ', '리노공업', 'Leeno Industrial', '반도체'],
  ['263750.KQ', '펄어비스', 'Pearl Abyss', '게임'],
  ['041510.KQ', '에스엠', 'SM Entertainment', '엔터'],
  ['035900.KQ', 'JYP Ent.', 'JYP Entertainment', '엔터'],
  ['122870.KQ', '와이지엔터테인먼트', 'YG Entertainment', '엔터'],
  ['091990.KQ', '셀트리온헬스케어', 'Celltrion Healthcare', '바이오/제약'],
  ['028300.KQ', 'HLB', 'HLB', '바이오/제약'],
  ['112040.KQ', '위메이드', 'Wemade', '게임'],
  ['293490.KQ', '카카오게임즈', 'Kakao Games', '게임'],
  ['357780.KQ', '솔브레인', 'Soulbrain', '반도체'],
  ['240810.KQ', '원익IPS', 'Wonik IPS', '반도체'],
  ['042700.KS', '한미반도체', 'Hanmi Semiconductor', '반도체'],
  ['403870.KQ', 'HPSP', 'HPSP', '반도체'],
];

const US = [
  ['AAPL', '애플', 'Apple', 'IT하드웨어'],
  ['MSFT', '마이크로소프트', 'Microsoft', '소프트웨어'],
  ['NVDA', '엔비디아', 'NVIDIA', '반도체'],
  ['GOOGL', '알파벳', 'Alphabet (Google)', '인터넷'],
  ['AMZN', '아마존', 'Amazon', '소비재/클라우드'],
  ['META', '메타', 'Meta Platforms', '인터넷'],
  ['TSLA', '테슬라', 'Tesla', '자동차'],
  ['AVGO', '브로드컴', 'Broadcom', '반도체'],
  ['AMD', 'AMD', 'Advanced Micro Devices', '반도체'],
  ['INTC', '인텔', 'Intel', '반도체'],
  ['QCOM', '퀄컴', 'Qualcomm', '반도체'],
  ['TSM', 'TSMC', 'Taiwan Semiconductor', '반도체'],
  ['ASML', 'ASML', 'ASML Holding', '반도체'],
  ['MU', '마이크론', 'Micron Technology', '반도체'],
  ['ARM', 'ARM', 'Arm Holdings', '반도체'],
  ['NFLX', '넷플릭스', 'Netflix', '미디어'],
  ['DIS', '디즈니', 'Walt Disney', '미디어'],
  ['CRM', '세일즈포스', 'Salesforce', '소프트웨어'],
  ['ORCL', '오라클', 'Oracle', '소프트웨어'],
  ['ADBE', '어도비', 'Adobe', '소프트웨어'],
  ['NOW', '서비스나우', 'ServiceNow', '소프트웨어'],
  ['PLTR', '팔란티어', 'Palantir', '소프트웨어'],
  ['UBER', '우버', 'Uber', '플랫폼'],
  ['ABNB', '에어비앤비', 'Airbnb', '플랫폼'],
  ['COIN', '코인베이스', 'Coinbase', '금융'],
  ['PYPL', '페이팔', 'PayPal', '금융'],
  ['V', '비자', 'Visa', '금융'],
  ['MA', '마스터카드', 'Mastercard', '금융'],
  ['JPM', 'JP모건', 'JPMorgan Chase', '금융'],
  ['BAC', '뱅크오브아메리카', 'Bank of America', '금융'],
  ['GS', '골드만삭스', 'Goldman Sachs', '금융'],
  ['BRK.B', '버크셔해서웨이', 'Berkshire Hathaway B', '금융'],
  ['JNJ', '존슨앤드존슨', 'Johnson & Johnson', '바이오/제약'],
  ['LLY', '일라이릴리', 'Eli Lilly', '바이오/제약'],
  ['UNH', '유나이티드헬스', 'UnitedHealth', '헬스케어'],
  ['PFE', '화이자', 'Pfizer', '바이오/제약'],
  ['MRK', '머크', 'Merck', '바이오/제약'],
  ['ABBV', '애브비', 'AbbVie', '바이오/제약'],
  ['NVO', '노보노디스크', 'Novo Nordisk', '바이오/제약'],
  ['XOM', '엑슨모빌', 'Exxon Mobil', '에너지'],
  ['CVX', '셰브론', 'Chevron', '에너지'],
  ['KO', '코카콜라', 'Coca-Cola', '식품'],
  ['PEP', '펩시코', 'PepsiCo', '식품'],
  ['MCD', '맥도날드', 'McDonalds', '식품'],
  ['SBUX', '스타벅스', 'Starbucks', '식품'],
  ['NKE', '나이키', 'Nike', '유통/소비재'],
  ['WMT', '월마트', 'Walmart', '유통/소비재'],
  ['COST', '코스트코', 'Costco', '유통/소비재'],
  ['PG', 'P&G', 'Procter & Gamble', '유통/소비재'],
  ['HD', '홈디포', 'Home Depot', '유통/소비재'],
  ['BA', '보잉', 'Boeing', '방산'],
  ['LMT', '록히드마틴', 'Lockheed Martin', '방산'],
  ['CAT', '캐터필러', 'Caterpillar', '기계'],
  ['GE', 'GE에어로스페이스', 'GE Aerospace', '방산'],
  ['T', 'AT&T', 'AT&T', '통신'],
  ['VZ', '버라이즌', 'Verizon', '통신'],
  ['SPY', 'S&P500 ETF', 'SPDR S&P 500 ETF', 'ETF'],
  ['VOO', '뱅가드 S&P500', 'Vanguard S&P 500 ETF', 'ETF'],
  ['QQQ', '나스닥100 ETF', 'Invesco QQQ', 'ETF'],
  ['SCHD', '슈드', 'Schwab US Dividend Equity ETF', 'ETF'],
  ['VTI', '뱅가드 토탈마켓', 'Vanguard Total Stock Market ETF', 'ETF'],
  ['TLT', '미국 장기국채 ETF', 'iShares 20+ Year Treasury', 'ETF'],
  ['GLD', '금 ETF', 'SPDR Gold Shares', 'ETF'],
];

const VN = [
  ['FPT.VN', 'FPT', 'FPT Corporation', 'IT서비스'],
  ['VIC.VN', '빈그룹', 'Vingroup', '지주'],
  ['VHM.VN', '빈홈즈', 'Vinhomes', '건설'],
  ['VCB.VN', '베트콤뱅크', 'Vietcombank', '금융'],
  ['BID.VN', 'BIDV', 'BIDV', '금융'],
  ['CTG.VN', '비에틴뱅크', 'VietinBank', '금융'],
  ['TCB.VN', '테크콤뱅크', 'Techcombank', '금융'],
  ['MBB.VN', 'MB뱅크', 'Military Bank', '금융'],
  ['HPG.VN', '호아팟그룹', 'Hoa Phat Group', '철강'],
  ['VNM.VN', '비나밀크', 'Vinamilk', '식품'],
  ['MSN.VN', '마산그룹', 'Masan Group', '유통/소비재'],
  ['MWG.VN', '모바일월드', 'Mobile World', '유통/소비재'],
  ['GAS.VN', '페트로베트남가스', 'PetroVietnam Gas', '에너지'],
  ['SSI.VN', 'SSI증권', 'SSI Securities', '금융'],
  ['VJC.VN', '비엣젯항공', 'Vietjet Air', '항공'],
];

// 목록에 적은 순서를 인지도 순으로 보고 동점일 때 앞선 종목을 먼저 보여준다
// (예: "삼성" 검색 시 삼성물산보다 삼성전자가 위로)
let rank = 0;
function make(rows, country, currency) {
  return rows.map(([ticker, name, english, sector]) => ({
    ticker, name, english, sector, country, currency, rank: rank++,
  }));
}

export const CATALOG = [
  ...make(KR, 'KR', 'KRW'),
  ...make(US, 'US', 'USD'),
  ...make(VN, 'VN', 'VND'),
];

// ─────────────────────────────── 초성 검색
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ',
  'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

export function chosung(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0) - 0xac00;
    out += (code >= 0 && code <= 11171) ? CHO[Math.floor(code / 588)] : ch;
  }
  return out;
}

const isChosungOnly = (q) => /^[ㄱ-ㅎ]+$/.test(q);
const norm = (s) => String(s || '').toLowerCase().replace(/[\s.\-&]/g, '');

// 검색어를 어느 필드가 어떻게 맞췄는지에 따라 점수를 매겨 정렬한다
function score(item, q) {
  const nq = norm(q);
  const name = norm(item.name);
  const eng = norm(item.english);
  const tick = norm(item.ticker);

  if (isChosungOnly(q)) {
    const cs = chosung(item.name);
    if (cs.startsWith(q)) return 90;
    if (cs.includes(q)) return 60;
    return 0;
  }
  if (tick === nq || norm(item.ticker.split('.')[0]) === nq) return 100;
  if (name === nq) return 98;
  if (name.startsWith(nq)) return 92;
  if (eng.startsWith(nq)) return 85;
  if (tick.startsWith(nq)) return 80;
  if (name.includes(nq)) return 70;
  if (eng.includes(nq)) return 55;
  return 0;
}

/**
 * 종목 검색.
 * @param {string} query  "삼성", "samsung", "005930", "ㅅㅅㅈㅈ" 다 됨
 * @param {object} known  이미 등록된 종목 (db.assets) - 있으면 위로 올린다
 */
export function search(query, known = {}, limit = 12) {
  const q = String(query || '').trim();
  if (!q) {
    return Object.entries(known).slice(0, limit).map(([ticker, a]) => ({
      ticker, name: a.name || ticker, english: '', sector: a.sector || '기타',
      country: a.country || '??', currency: a.currency || 'USD', owned: true,
    }));
  }

  const seen = new Set();
  const results = [];

  // 1) 내가 이미 등록한 종목 먼저
  for (const [ticker, a] of Object.entries(known)) {
    const item = {
      ticker, name: a.name || ticker, english: '', sector: a.sector || '기타',
      country: a.country || '??', currency: a.currency || 'USD', owned: true,
    };
    const s = score(item, q);
    if (s > 0) { results.push({ ...item, _s: s + 15 }); seen.add(ticker); }
  }

  // 2) 사전
  for (const item of CATALOG) {
    if (seen.has(item.ticker)) continue;
    const s = score(item, q);
    if (s > 0) results.push({ ...item, _s: s });
  }

  results.sort((a, b) => b._s - a._s || (a.rank ?? 999) - (b.rank ?? 999)
    || a.name.localeCompare(b.name, 'ko'));
  return results.slice(0, limit);
}

export function lookup(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  return CATALOG.find((x) => x.ticker.toUpperCase() === t) || null;
}
