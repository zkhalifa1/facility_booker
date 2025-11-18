// src/ubc.ts
import { chromium, BrowserContext, Page, Locator } from "playwright";
import { env } from "./config/env";

export type Preferences = {
    days_ahead?: number;
    start_hour?: number;
    end_hour?: number;
    min_minutes?: number;
    indoor_only?: boolean;
    locations?: string[];
    dates?: string[];
};

export type Slot = {
    date_iso: string;
    time_24h: string;
    minutes: number;
    location: string;
    deep_link: string | null;
};

const DEFAULT_BASE_URL =
    "https://ubc.perfectmind.com/24063/Clients/BookMe4FacilityList/List?calendarId=e65c1527-c4f8-4316-b6d6-3b174041f00e&widgetId=c7c36ee3-2494-4de2-b2cb-d50a86487656&embed=False&singleCalendarWidget=true";

const BASE_URL = env.ubc.baseUrl ?? DEFAULT_BASE_URL;

// ---------- LOGIN FLOW (URL1 → URL2 → URL3 → URL4) ----------

async function ensureLoggedIn(
    context: BrowserContext,
    page: Page
): Promise<Page> {
    console.log("[ubc] Checking login state…");

    // If there's no Login button/link in the header, assume we're already logged in
    const loginButton = page
        .getByRole("button", { name: /login/i })
        .or(page.getByRole("link", { name: /login/i }))
        .first();

    const loginVisible = await loginButton.isVisible().catch(() => false);
    if (!loginVisible) {
        console.log("[ubc] Already logged in (no Login button visible)");
        return page;
    }

    console.log("[ubc] Clicking Login (URL1 → URL2: Login Portal)…");
    const [maybeNewPage] = await Promise.all([
        context.waitForEvent("page").catch(() => null),
        loginButton.click()
    ]);

    // If login opened a new tab, use that; otherwise continue on the same tab
    let authPage: Page = maybeNewPage ?? page;

    await authPage.waitForLoadState("domcontentloaded");

    // --- URL2: Login Portal – click "CWL Login" ---
    console.log("[ubc] Looking for 'CWL Login' button on Login Portal…");

    const cwlButtonCandidates: Locator[] = [
        authPage.getByRole("button", { name: /cwl login/i }),
        authPage.getByRole("link", { name: /cwl login/i }),
        authPage.locator('a:has(img[alt*="CWL"])'),
        authPage.locator('img[alt*="CWL"]').locator("xpath=ancestor::a[1]")
    ];

    let cwlButton: Locator | null = null;
    for (const candidate of cwlButtonCandidates) {
        if (await candidate.isVisible().catch(() => false)) {
            cwlButton = candidate;
            break;
        }
    }

    if (cwlButton) {
        console.log("[ubc] Clicking CWL Login (URL2 → URL3)…");
        const [maybeCwlPage] = await Promise.all([
            context.waitForEvent("page").catch(() => null),
            cwlButton.click()
        ]);
        if (maybeCwlPage) authPage = maybeCwlPage;
        await authPage.waitForLoadState("domcontentloaded");
    } else {
        console.warn(
            "[ubc] Could not find CWL Login button; continuing on current page."
        );
    }

    // --- URL3: CWL Authentication – fill username/password ---
    const user = env.ubc.user;
    const pass = env.ubc.pass;

    console.log("[ubc] Looking for CWL username/password fields (URL3)…");

    const usernameLocator = authPage.locator(
        'input[name="username"], #username, input[id*="Login"], input[id*="User"], input[name="j_username"]'
    );
    const passwordLocator = authPage.locator(
        'input[name="password"], #password, input[type="password"], input[name="j_password"]'
    );

    await usernameLocator.waitFor({ timeout: 60000 });
    await passwordLocator.waitFor({ timeout: 60000 });

    console.log("[ubc] Filling CWL credentials…");
    await usernameLocator.fill(user);
    await passwordLocator.fill(pass);

    const submitButton = authPage
        .getByRole("button", { name: /login|sign in|submit/i })
        .first();

    console.log("[ubc] Submitting CWL form…");
    await submitButton.click();

    // Wait for the SAML round-trip + redirect / Duo, etc.
    await authPage.waitForLoadState("networkidle", { timeout: 60000 });

    // --- Back to URL4: courts list (logged in) ---
    const baseNoQuery = BASE_URL.split("?")[0];
    if (!authPage.url().startsWith(baseNoQuery)) {
        console.log(
            "[ubc] Navigating back to court list after login…",
            authPage.url()
        );
        await authPage.goto(BASE_URL, { waitUntil: "networkidle" });
    }

    console.log("[ubc] Login flow complete; back on court list (URL4).");
    return authPage;
}

// ---------- COURT & SLOT SCANNING HELPERS ----------

async function inferCourtName(chooseButton: Locator): Promise<string> {
    try {
        // Try to grab some surrounding text for a human-friendly name
        const card = chooseButton.locator("xpath=ancestor::div[1]");
        const text = (await card.innerText()).trim();
        const firstLine =
            text
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean)[0] ?? "";
        return firstLine || "Unknown court";
    } catch {
        return "Unknown court";
    }
}

function getDesiredMinutes(prefs: Preferences): number {
    const requested = prefs.min_minutes ?? 60;
    if (requested <= 60) return 60;
    return 120;
}

function parseTimeFromText(raw: string): string | null {
    const text = raw.trim();
    if (!text) return null;

    const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;

    let hour = parseInt(m[1], 10);
    const minute = m[2];
    const ampm = m[3].toUpperCase();

    if (ampm === "PM" && hour !== 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;

    const hh = hour.toString().padStart(2, "0");
    return `${hh}:${minute}`;
}



async function scanSingleCourtPage(
    page: Page,
    prefs: Preferences,
    courtName: string
): Promise<Slot[]> {
    const slots: Slot[] = [];

    // Give the page a moment to render the scheduler.
    await page.waitForTimeout(2000).catch(() => {});

    // Try to find the scheduler table by looking for time labels like '8:00 AM'.
    const tables = page.locator("table");
    const tableCount = await tables.count();
    let gridTable: Locator | null = null;

    for (let i = 0; i < tableCount; i++) {
        const t = tables.nth(i);
        const snippet = (await t.innerText().catch(() => "")).slice(0, 500);
        if (/8:00 AM|9:00 AM|10:00 PM|Bookable 24hrs in advance/i.test(snippet)) {
            gridTable = t;
            break;
        }
    }

    if (!gridTable) {
        console.log(
            `[ubc] No obvious scheduler table found on court "${courtName}"; skipping`
        );
        await debugListClickable(page);
        return slots;
    }

    const rows = gridTable.locator("tr");
    const rowCount = await rows.count();
    console.log(
        `[ubc] Scheduler table found on "${courtName}" with ${rowCount} rows`
    );

    const todayIso = new Date().toISOString().slice(0, 10);
    const prefsStart = prefs.start_hour ?? 0;
    const prefsEnd = prefs.end_hour ?? 24;
    const minutes = prefs.min_minutes ?? 60;

    for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i);

        // First cell in row should be the time label (e.g., "10:00 PM")
        const timeCell = row.locator("th, td").first();
        const rawTime = (await timeCell.innerText().catch(() => "")).trim();

        const time24h = parseTimeFromText(rawTime);
        if (!time24h) {
            // Header row or something else – skip
            continue;
        }

        // Respect user hour preferences
        const [hhStr] = time24h.split(":");
        const hh = parseInt(hhStr, 10);
        if (hh < prefsStart || hh >= prefsEnd) continue;

        // Does this row contain a "Book Now" button?
        const bookNowInRow = row.locator(
            'button:has-text("Book Now"), a:has-text("Book Now"), div:has-text("Book Now")'
        );
        const bookNowCount = await bookNowInRow.count();

        if (bookNowCount === 0) continue;

        console.log(
            `[ubc] Row "${rawTime}" on "${courtName}" has ${bookNowCount} "Book Now" cell(s)`
        );

        // For now we don't distinguish columns/dates – we treat them as "today+X".
        // We'll refine the date later if needed.
        slots.push({
            date_iso: todayIso,
            time_24h: time24h,
            minutes,
            location: courtName || "UBC Tennis Centre – court",
            deep_link: page.url()
        });
    }

    return slots;
}




 // Helper function to debug the program. Doesnt change behaviour, just prints out a bunch of useful statements
async function debugListClickable(page: Page) {
    console.log("[ubc-debug] No 'Choose' buttons found. Listing clickable elements…");

    const clickable = page.locator("button, a, [role='button'], input[type='button'], input[type='submit']");
    const count = await clickable.count();
    console.log(`[ubc-debug] Found ${count} clickable elements (button/a/input)`);

    const sampleCount = Math.min(count, 30);
    for (let i = 0; i < sampleCount; i++) {
        const el = clickable.nth(i);
        const tag = await el.evaluate((n) => n.tagName).catch(() => "UNKNOWN");
        const role = await el.getAttribute("role").catch(() => null);
        const text = (await el.innerText().catch(() => "")).trim();
        const valueAttr = (await el.getAttribute("value").catch(() => null)) || "";
        console.log(
            `[ubc-debug] [${i}] tag=${tag} role=${role ?? "none"} text="${text}" value="${valueAttr}"`
        );
    }
}


async function scanCourtsAndSlots(
    page: Page,
    prefs: Preferences
): Promise<Slot[]> {
    const slots: Slot[] = [];

    // Always re-query on the current page so indexes stay valid
    const chooseButtons = page.locator(
        'button:has-text("Choose"), a:has-text("Choose")'
    ).or(page.getByRole("button", { name: /choose/i }));

    const totalCourts = await chooseButtons.count();
    console.log(`[ubc] Found ${totalCourts} court 'Choose' buttons`);

    if (totalCourts === 0) {
        console.log("[ubc] No courts detected from current selectors");
        await debugListClickable(page);
        return slots;
    }

    const maxCourts = Math.min(totalCourts, 10);

    for (let i = 0; i < maxCourts; i++) {
        // Re-evaluate locator each loop
        const button = chooseButtons.nth(i);
        const courtName = await inferCourtName(button); // ok if this just returns "Choose"

        console.log(
            `[ubc] Scanning court ${i + 1}/${maxCourts}: "${courtName}"…`
        );

        try {
            const href = await button.getAttribute("href");

            if (!href) {
                console.log(
                    `[ubc] Court "${courtName}" has no href; falling back to direct click`
                );
                await button.click();
            } else {
                const facilityUrl = new URL(href, BASE_URL).toString();
                console.log(
                    `[ubc] Navigating to facility page for court "${courtName}", URL: ${facilityUrl}`
                );
                await page.goto(facilityUrl, { waitUntil: "domcontentloaded" });
            }

            const courtSlots = await scanSingleCourtPage(page, prefs, courtName);
            slots.push(...courtSlots);
        } catch (err: any) {
            console.warn(
                `[ubc] Error while scanning court "${courtName}":`,
                err?.message || String(err)
            );
        }

        // Go back to main court list for the next iteration
        console.log(
            `[ubc] Returning to courts list after scanning "${courtName}"…`
        );
        try {
            await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        } catch (err: any) {
            console.warn(
                "[ubc] Error returning to courts list; stopping court scan loop:",
                err?.message || String(err)
            );
            break;
        }
    }

    console.log(`[ubc] Total candidate slots found across courts: ${slots.length}`);
    return slots;
}




// ---------- PUBLIC ENTRY POINT USED BY /check_now ----------

export async function checkAvailability(prefs: Preferences): Promise<Slot[]> {
    const browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext();
    let page: Page = await context.newPage();

    try {
        console.log("[ubc] Navigating to booking page…");
        await page.goto(BASE_URL, { waitUntil: "networkidle" });

        // Make sure we are logged in and back on the courts list
        page = await ensureLoggedIn(context, page);

        try {
            const realSlots = await scanCourtsAndSlots(page, prefs);
            if (realSlots.length > 0) {
                console.log("[ubc] Returning real scanned slots");
                return realSlots;
            }
            console.log("[ubc] No slots found by scanner; falling back to stub");
        } catch (scanErr: any) {
            console.error(
                "[ubc] Error during scanCourtsAndSlots; falling back to stub:",
                scanErr?.message || String(scanErr)
            );
        }

        // Fallback: stub slot so the API still behaves nicely
        const todayIso = new Date().toISOString().slice(0, 10);
        return [
            {
                date_iso: todayIso,
                time_24h: "19:00",
                minutes: prefs.min_minutes ?? 60,
                location: "UBC Tennis Centre – (stubbed)",
                deep_link: BASE_URL
            }
        ];
    } finally {
        await browser.close();
    }
}
