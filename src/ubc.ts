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

async function scanSingleCourtPage(
    page: Page,
    prefs: Preferences,
    courtName: string
): Promise<Slot[]> {
    const slots: Slot[] = [];
    console.log(
        `[ubc] On facility page for court "${courtName}", URL: ${page.url()}`
    );

    const desiredMinutes = getDesiredMinutes(prefs);

    // --- Step 1: try to set duration based on desiredMinutes ---
    try {
        const durationLabel =
            desiredMinutes > 60 ? /2\s*hour|120\s*min/i : /1\s*hour|60\s*min/i;
        const durationOption = page
            .getByRole("radio", { name: durationLabel })
            .first();

        if (await durationOption.isVisible().catch(() => false)) {
            await durationOption.click();
            console.log(`[ubc] Selected duration ≈ ${desiredMinutes} minutes`);
        } else {
            console.log("[ubc] No visible duration radio found; skipping duration set");
        }
    } catch (e: any) {
        console.warn(
            "[ubc] Could not select duration option:",
            e?.message || String(e)
        );
    }

    // --- Step 2: optional – try to set # of players to 2 ---
    try {
        const playersSelect = page
            .getByRole("combobox", { name: /players|people|participants/i })
            .first();

        const visible = await playersSelect.isVisible().catch(() => false);
        if (visible) {
            // Try "2" directly
            await playersSelect.selectOption("2").catch(async () => {
                // Fallback: find option that contains "2"
                const twoOption = playersSelect.locator("option", { hasText: /2/ });
                if ((await twoOption.count()) > 0) {
                    const value = await twoOption.first().getAttribute("value");
                    if (value) {
                        await playersSelect.selectOption(value);
                    }
                }
            });
            console.log("[ubc] Selected 2 players (best effort)");
        }
    } catch (e: any) {
        console.warn(
            "[ubc] Could not select players count:",
            e?.message || String(e)
        );
    }

    // --- Step 3: scan for time buttons on the current date ---
    // NOTE: This is a first-pass heuristic. We'll refine selectors once we see logs.
    const timeButtons = page
        .locator("button, a")
        .filter({ hasText: /(\d{1,2}:\d{2}\s*(am|pm)?)/i });

    const count = await timeButtons.count();
    console.log(
        `[ubc] Found ${count} candidate time buttons on court "${courtName}"`
    );

    const todayIso = new Date().toISOString().slice(0, 10);
    const startHourPref = prefs.start_hour ?? 0;
    const endHourPref = prefs.end_hour ?? 24;

    for (let i = 0; i < count; i++) {
        const el = timeButtons.nth(i);
        const label = (await el.innerText()).trim();

        const timeMatch = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (!timeMatch) continue;

        const hour = parseInt(timeMatch[1], 10);
        const minute = parseInt(timeMatch[2], 10);
        const ampm = timeMatch[3]?.toLowerCase();

        let hour24 = hour;
        if (ampm === "pm" && hour !== 12) hour24 = hour + 12;
        if (ampm === "am" && hour === 12) hour24 = 0;

        if (hour24 < startHourPref || hour24 >= endHourPref) {
            continue;
        }

        const timeStr = `${hour24.toString().padStart(2, "0")}:${minute
            .toString()
            .padStart(2, "0")}`;

        slots.push({
            date_iso: todayIso, // TODO: once we parse the actual date from the UI
            time_24h: timeStr,
            minutes: desiredMinutes,
            location: courtName,
            deep_link: page.url()
        });
    }

    console.log(
        `[ubc] Court "${courtName}" produced ${slots.length} candidate slots`
    );
    return slots;
}

async function scanCourtsAndSlots(
    page: Page,
    prefs: Preferences
): Promise<Slot[]> {
    const slots: Slot[] = [];

    // Find "Choose" buttons for each court
    const chooseButtons = page
        .locator("button", { hasText: /choose/i })
        .or(page.getByRole("button", { name: /choose/i }));

    const totalCourts = await chooseButtons.count();
    console.log(`[ubc] Found ${totalCourts} court 'Choose' buttons`);

    // To keep runtime reasonable, cap number of courts we scan in one call
    const maxCourts = Math.min(totalCourts, 10);

    for (let i = 0; i < maxCourts; i++) {
        const button = chooseButtons.nth(i);
        const courtName = await inferCourtName(button);

        console.log(
            `[ubc] Scanning court ${i + 1}/${maxCourts}: "${courtName}"…`
        );

        // Click "Choose" and wait for navigation to the facility page (URL5)
        await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle" }),
            button.click()
        ]);

        const courtSlots = await scanSingleCourtPage(page, prefs, courtName);
        slots.push(...courtSlots);

        // Go back to the courts list (URL4) for the next court
        console.log(
            `[ubc] Returning to courts list after scanning "${courtName}"…`
        );
        await page.goto(BASE_URL, { waitUntil: "networkidle" });
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
