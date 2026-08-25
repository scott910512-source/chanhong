/**
 * 앱 아이콘(PNG) 생성기.
 *
 * 결과물인 web/icons/*.png 는 저장소에 커밋돼 있으므로 평소에는 실행할 필요가 없다.
 * 아이콘 디자인을 바꿀 때만 돌린다.
 *
 *   npm i playwright        (한 번만)
 *   node tools/make_icons.mjs
 *
 * 한글을 그려야 해서 헤드리스 크로미움으로 렌더링한다. 실행하는 PC 에 한글 폰트가
 * 있어야 글자가 제대로 나온다(없으면 네모로 나옴).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = `${ROOT}/web/icons`;

const TEXT = '찬홍팍';
const BG = '#0e1117';
const FG = '#f2f5fa';
const ACCENT = '#4d8ffb';

/**
 * @param {number} size  픽셀 크기
 * @param {number} pad   안전여백 비율 (maskable 은 크게)
 */
function html(size, pad) {
  const inner = 1 - pad * 2;          // 글자가 차지할 수 있는 비율
  const fontSize = size * inner * 0.345; // 3글자라 폭 기준으로 잡는다
  const barW = size * inner * 0.70;
  const barH = Math.max(2, size * 0.022);
  const gap = size * 0.048;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    body{width:${size}px;height:${size}px;background:${BG};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:${gap}px;overflow:hidden}
    .t{
      font-family:"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",
        "NanumGothic","WenQuanYi Zen Hei",sans-serif;
      font-weight:800; font-size:${fontSize}px; color:${FG};
      letter-spacing:${-fontSize * 0.045}px; line-height:1;
      /* 한글은 글자 위아래 여백이 있어 시각적 중심이 살짝 위로 뜬다 */
      transform:translateY(${size * 0.012}px);
    }
    .bar{width:${barW}px;height:${barH}px;border-radius:${barH}px;
      background:linear-gradient(90deg,${ACCENT},${FG})}
  </style></head><body><div class="t">${TEXT}</div><div class="bar"></div></body></html>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 0.10 },
  { file: 'icon-512.png', size: 512, pad: 0.10 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.20 }, // 안드로이드가 잘라내도 안전하게
  { file: 'apple-touch-icon.png', size: 180, pad: 0.10 },
];

const browser = await chromium.launch({
  args: ['--no-sandbox'],
  executablePath: process.env.CHROME_PATH || undefined,
});
mkdirSync(OUT, { recursive: true });

for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  await page.setContent(html(t.size, t.pad));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${t.file}` });
  await page.close();
  console.log(`  ${t.file}  ${t.size}x${t.size}`);
}
await browser.close();
console.log('완료:', OUT);
