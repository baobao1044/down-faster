#!/usr/bin/env node
// Verify ad card: nạp extension, mở popup + manager, chụp, kiểm #adSlot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitForEngineReady } from './launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'assets');

async function main() {
  const { context, page, serviceWorker, cleanup } = await launch('[ad-verify]');
  try {
    await waitForEngineReady(serviceWorker, 5000);
    const extId = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
    console.log('[ad-verify] extension id:', extId);

    // Mở popup bằng action click (headless: mở trực tiếp URL).
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    await page.goto(popupUrl);
    await page.waitForTimeout(500);

    // Kiểm #adSlot tồn tại và không hidden sau render.
    const popupAd = await page.evaluate(() => {
      const slot = document.getElementById('adSlot');
      return {
        exists: !!slot,
        hidden: slot?.hidden,
        textContent: slot?.textContent?.trim()?.slice(0, 120),
        childCount: slot?.childElementCount,
      };
    });
    console.log('[ad-verify] popup ad slot:', JSON.stringify(popupAd));
    await page.screenshot({ path: path.join(OUT, 'popup-with-ad.png'), fullPage: true });

    // Mở manager.
    const managerUrl = `chrome-extension://${extId}/manager.html`;
    await page.goto(managerUrl);
    await page.waitForTimeout(500);
    const managerAd = await page.evaluate(() => {
      const slot = document.getElementById('adSlot');
      return {
        exists: !!slot,
        hidden: slot?.hidden,
        textContent: slot?.textContent?.trim()?.slice(0, 120),
        childCount: slot?.childElementCount,
      };
    });
    console.log('[ad-verify] manager ad slot:', JSON.stringify(managerAd));
    await page.screenshot({ path: path.join(OUT, 'manager-with-ad.png'), fullPage: true });

    // Kiểm link href đúng.
    const linkHref = await page.evaluate(() => {
      const link = document.querySelector('#adSlot a');
      return link?.getAttribute('href');
    });
    console.log('[ad-verify] ad link href:', linkHref);

    // Đổi ngôn ngữ sang en (qua override) — kiểm disclosure dịch.
    // (headless không đổi browser locale dễ; chỉ verify text hiện ở vi mặc định.)
    console.log('[ad-verify] done');
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('[ad-verify] FAILED:', err);
  process.exit(1);
});
