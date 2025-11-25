import { chromium, BrowserContext, Page, Locator } from "playwright";

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

const BASE_URL =
    process.env.UBC_BASE_URL ??
    "https://ubc.perfectmind.com/24063/Clients/BookMe4FacilityList/List?calendarId=e65c1527-c4f8-4316-b6d6-3b174041f00e&widgetId=c7c36ee3-2494-4de2-b2cb-d50a86487656&embed=False&singleCalendarWidget=true";

// ------------------------------ LOGIN FLOW ----------------------------------

async function ensureLoggedIn(
    context: BrowserContext,
    page: Page
): Promise<Page> {
    console.log("[ubc] Checking login state…");

    // If the header has a visible "Login" button/link, we're NOT logged in.
    const loginButton = page.locator('text=Login').first();
    const loginVisible = await loginButton
        .isVisible()
        .catch(() => false);

    if (!loginVisible) {
        console.log("[ubc] Already logged in (no Login button visible)");
        return page;
    }

    console.log("[ubc] Clicking Login (URL1 → URL2: Login Portal)…");
    const [maybeNewPage] = await Promise.all([
        context.waitForEvent("page").catch(() => null),
        loginButton.click()
    ]);

    let authPage: Page = maybeNewPage ?? page;
    await authPage.waitForLoadState("domcontentloaded");

    // --- URL2: Login Portal – click "CWL Login" ---
    console.log("[ubc] Looking for 'CWL Login' button on Login Portal…");

    const candidates: Locator[] = [
        authPage.getByRole("button", { name: /cwl login/i }),
        authPage.getByRole("link", { name: /cwl login/i }),
        authPage.locator('a:has(img[alt*="CWL"])'),
        authPage.locator('img[alt*="CWL"]').locator("xpath=ancestor::a[1]")
    ];

    let cwlButton: Locator | null = null;
    for (const cand of candidates) {
        const first = cand.first();
        if (await first.isVisible().catch(() => false)) {
            cwlButton = first;
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
    const user = process.env.UBC_USER || "";
    const pass = process.env.UBC_PASS || "";
    if (!user || !pass) {
        throw new Error("UBC_USER and UBC_PASS must be set in environment");
    }

    console.log("[ubc] Looking for CWL username/password fields (URL3)…");

    const usernameLocator = authPage.locator(
        'input[name="username"], #username, input[id*="Login"], input[id*="User"]'
    );
    const passwordLocator = authPage.locator(
        'input[name="password"], #password, input[type="password"]'
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

    // Wait for SAML + Duo + redirect chain to finish.
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

// ------------------------ SCHEDULER PARSING HELPERS -------------------------

function to24h(time12: string): string | null {
    // "03:00 PM" -> "15:00"
    const m = time12.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let [_, hh, mm, ampm] = m;
    let h = parseInt(hh, 10);
    const isPM = ampm.toUpperCase() === "PM";
    if (h === 12 && !isPM) h = 0; // 12 AM -> 00
    else if (h !== 12 && isPM) h += 12; // 1–11 PM -> 13–23
    return `${h.toString().padStart(2, "0")}:${mm}`;
}

function durationMinutes(start24: string, end24: string): number {
    const [sh, sm] = start24.split(":").map(Number);
    const [eh, em] = end24.split(":").map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
}

/**
 * On a facility page, scan for
 *   <span title="03:00 PM-04:00 PM">Book Now</span>
 * tiles and turn them into Slot objects.
 */
async function extractSlotsFromScheduler(
    page: Page,
    prefs: Preferences,
    courtLabel: string
): Promise<Slot[]> {
    const slots: Slot[] = [];

    // Every “Book Now” span under the scheduler’s booking template.
    const bookNowSpans = page
        .locator("#scheduler .k-event-template.facility-booking-slot span")
        .filter({ hasText: /Book Now/i });

    const count = await bookNowSpans.count();
    console.log(
        `[ubc] Found ${count} "Book Now" spans on court "${courtLabel}"`
    );

    for (let i = 0; i < count; i++) {
        const span = bookNowSpans.nth(i);
        
        // First check if the span is actually visible
        const isVisible = await span.isVisible().catch(() => false);
        if (!isVisible) {
            console.log(`[ubc] Skipping span ${i + 1}/${count} on "${courtLabel}": not visible`);
            continue;
        }
        
        // Verify the text content is actually "Book Now" (case-insensitive)
        const textContent = (await span.innerText().catch(() => "")).trim();
        if (!/^book\s+now$/i.test(textContent)) {
            console.log(`[ubc] Skipping span ${i + 1}/${count} on "${courtLabel}": text content "${textContent}" doesn't match "Book Now"`);
            continue;
        }
        
        // Check if the slot is actually available/bookable
        // Look for parent elements that might indicate unavailable/booked slots
        const isAvailable = await span.evaluate((el) => {
            const parent = (el as HTMLElement).closest('.facility-booking-slot, .k-event-template, [class*="event"]');
            if (!parent) return true; // If no parent found, assume available
            
            // Check for disabled/unavailable indicators in class names
            const classes = parent.className || '';
            const hasUnavailable = /unavailable|disabled|booked|reserved|full|past|expired/i.test(classes);
            
            // Check if parent is visible and not hidden
            const style = window.getComputedStyle(parent);
            const isHidden = style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1;
            
            // Check for pointer-events: none (indicates not clickable)
            const hasNoPointerEvents = style.pointerEvents === 'none';
            
            // Check if parent has aria-disabled or disabled attribute
            const isDisabled = parent.hasAttribute('disabled') || parent.getAttribute('aria-disabled') === 'true';
            
            return !hasUnavailable && !isHidden && !hasNoPointerEvents && !isDisabled;
        });
        
        if (!isAvailable) {
            console.log(`[ubc] Skipping span ${i + 1}/${count} on "${courtLabel}": slot appears unavailable/disabled`);
            continue;
        }
        
        const titleAttr = (await span.getAttribute("title")) || "";
        console.log(`[ubc] Processing span ${i + 1}/${count} on "${courtLabel}": title="${titleAttr}"`);

        // e.g. "03:00 PM-04:00 PM"
        const match = titleAttr.match(
            /([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))\s*-\s*([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))/
        );
        if (!match) {
            console.warn(
                `[ubc] Could not parse time range from title="${titleAttr}" on "${courtLabel}"`
            );
            continue;
        }

        const start24 = to24h(match[1]);
        const end24 = to24h(match[2]);
        if (!start24 || !end24) {
            console.warn(
                `[ubc] Failed 12h→24h conversion for title="${titleAttr}" on "${courtLabel}" (start24=${start24}, end24=${end24})`
            );
            continue;
        }

        const mins = durationMinutes(start24, end24);
        console.log(`[ubc] Parsed time: ${start24}-${end24} (${mins} minutes)`);

        // --- Apply preferences (time window + min duration) ---
        if (prefs.start_hour !== undefined) {
            const h = parseInt(start24.split(":")[0], 10);
            if (h < prefs.start_hour) {
                console.log(`[ubc] Filtered out: start hour ${h} < ${prefs.start_hour}`);
                continue;
            }
        }
        if (prefs.end_hour !== undefined) {
            const h = parseInt(start24.split(":")[0], 10);
            if (h >= prefs.end_hour) {
                console.log(`[ubc] Filtered out: start hour ${h} >= ${prefs.end_hour}`);
                continue;
            }
        }
        if (prefs.min_minutes !== undefined && mins < prefs.min_minutes) {
            console.log(`[ubc] Filtered out: duration ${mins} < ${prefs.min_minutes}`);
            continue;
        }

        // Try to get an ISO date from an ancestor with data-date (if present).
        const dateIso = await span.evaluate((el) => {
            const dateNode =
                (el as HTMLElement).closest<HTMLElement>("[data-date]");
            const raw = dateNode?.getAttribute("data-date") || "";
            if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
            return "";
        });

        const date_iso =
            dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso)
                ? dateIso
                : new Date().toISOString().slice(0, 10);

        const slot = {
            date_iso,
            time_24h: start24,
            minutes: mins,
            location: courtLabel,
            deep_link: page.url()
        };
        console.log(`[ubc] Adding slot: ${JSON.stringify(slot)}`);
        slots.push(slot);
    }

    console.log(`[ubc] Extracted ${slots.length} slots from ${count} "Book Now" spans on "${courtLabel}"`);
    return slots;
}

// ------------------------ COURT LIST SCANNING -------------------------------

async function scanCourtsAndSlots(
    context: BrowserContext,
    page: Page,
    prefs: Preferences
): Promise<Slot[]> {
    const allSlots: Slot[] = [];

    // Select only desktop "Choose" buttons to avoid duplicates (each court has desktop + tablet versions)
    const chooseButtons = page.locator('a.pm-confirm-button.desktop-details:has-text("Choose")');
    const count = await chooseButtons.count();
    console.log(`[ubc] Found ${count} court 'Choose' buttons (desktop only)`);

    const limit = Math.min(count, 10); // sanity cap
    for (let i = 0; i < limit; i++) {
        const button = chooseButtons.nth(i);

        // Extract court label from the facility-item container
        // The structure is: .facility-item > .facility-details > h2 (contains "Court 01", etc.)
        let courtLabel = `Court ${i + 1}`;
        try {
            // Navigate from button up to the facility-item container, then find .facility-details h2
            const facilityItem = button.locator('xpath=ancestor::div[contains(@class,"facility-item")]').first();
            
            if (await facilityItem.isVisible().catch(() => false)) {
                const heading = facilityItem.locator('.facility-details h2').first();
                if (await heading.isVisible().catch(() => false)) {
                    const text = (await heading.innerText()).trim();
                    if (text) courtLabel = text;
                }
            }
        } catch {
            // fall back to default
        }

        console.log(
            `[ubc] Scanning court ${i + 1}/${limit}: "${courtLabel}"…`
        );

        // Build a facility URL from the button's href if present.
        let facilityUrl: string;
        const href = await button.getAttribute("href");
        if (href) {
            facilityUrl = new URL(href, BASE_URL).toString();
        } else {
            // Fallback: click and wait for navigation
            console.log(
                `[ubc] No href on court button "${courtLabel}", clicking instead…`
            );
            await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle" }),
                button.click()
            ]);
            facilityUrl = page.url();
        }

        console.log(
            `[ubc] Navigating to facility page for court "${courtLabel}", URL: ${facilityUrl}`
        );
        await page.goto(facilityUrl, { waitUntil: "networkidle" });

        // Extract the actual court name from the facility page
        try {
            const facilityNameHeading = page.locator('h1.facility-name').first();
            if (await facilityNameHeading.isVisible({ timeout: 5000 }).catch(() => false)) {
                const extractedName = (await facilityNameHeading.innerText()).trim();
                if (extractedName) {
                    console.log(`[ubc] Found court name on facility page: "${extractedName}"`);
                    courtLabel = extractedName;
                }
            }
        } catch (err) {
            console.warn(`[ubc] Could not extract court name from facility page, using "${courtLabel}"`);
        }

        // Optional debug: how many table rows in the scheduler
        const rowCount = await page
            .locator('#scheduler tr[role="row"], #scheduler .k-scheduler-row')
            .count()
            .catch(() => 0);
        if (rowCount > 0) {
            console.log(
                `[ubc] Scheduler table found on "${courtLabel}" with ${rowCount} rows`
            );
        }

        const slotsHere = await extractSlotsFromScheduler(
            page,
            prefs,
            courtLabel
        );
        allSlots.push(...slotsHere);

        // Go back to courts list for the next court
        // Note: Don't call ensureLoggedIn here - session is maintained via cookies
        await page.goto(BASE_URL, { waitUntil: "networkidle" });
    }

    console.log(
        `[ubc] Total candidate slots found across courts: ${allSlots.length}`
    );
    return allSlots;
}

// ----------------------------- PUBLIC API -----------------------------------

export async function checkAvailability(
    prefs: Preferences
): Promise<Slot[]> {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let page = await context.newPage();

    try {
        console.log("[ubc] Navigating to booking page…");
        await page.goto(BASE_URL, { waitUntil: "networkidle" });

        // Make sure we are logged in and back on the courts list
        page = await ensureLoggedIn(context, page);

        const slots = await scanCourtsAndSlots(context, page, prefs);

        if (slots.length > 0) {
            // Sort by date + time just to be nice
            slots.sort((a, b) =>
                a.date_iso === b.date_iso
                    ? a.time_24h.localeCompare(b.time_24h)
                    : a.date_iso.localeCompare(b.date_iso)
            );
            return slots;
        }

        // Fallback stub if nothing matched
        const todayIso = new Date().toISOString().slice(0, 10);
        console.log("[ubc] No slots found by scanner; falling back to stub");

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
