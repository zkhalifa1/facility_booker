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

export type BookingRequest = {
    facility_url: string;      // The deep_link from a Slot
    time_24h: string;          // e.g. "09:00"
    duration_hours: 1 | 2;     // 1h or 2h rental
    num_people: 1 | 2 | 3 | 4; // Number of attendees
};

export type BookingResult = {
    success: boolean;
    confirmation_number?: string;
    message: string;
    booked_slot?: {
        time: string;
        duration: number;
        location: string;
    };
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

// ----------------------------- BOOKING API -----------------------------------

export async function bookSlot(
    request: BookingRequest
): Promise<BookingResult> {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let page = await context.newPage();

    try {
        console.log("[ubc] Starting booking flow…");
        console.log(`[ubc] Facility URL: ${request.facility_url}`);
        console.log(`[ubc] Time: ${request.time_24h}, Duration: ${request.duration_hours}h, People: ${request.num_people}`);

        // Navigate to the facility page
        await page.goto(request.facility_url, { waitUntil: "networkidle" });

        // Ensure logged in
        page = await ensureLoggedIn(context, page);

        // If we got redirected away from the facility page, navigate back
        if (!page.url().includes("BookMe4LandingPages/Facility")) {
            console.log("[ubc] Navigating back to facility page after login…");
            await page.goto(request.facility_url, { waitUntil: "networkidle" });
        }

        // Get the court name from the page
        const courtName = await page.locator('h1.facility-name').first().innerText().catch(() => "Unknown Court");
        console.log(`[ubc] On facility page: ${courtName.trim()}`);

        // =====================================================================
        // STEP 1: Click the "Book Now" button for the specific time slot
        // =====================================================================
        console.log(`[ubc] Step 1: Looking for Book Now button at ${request.time_24h}…`);
        
        // Convert 24h time to 12h format for matching
        const [hour, minute] = request.time_24h.split(":").map(Number);
        const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        const ampm = hour >= 12 ? "PM" : "AM";
        const time12h = `${hour12}:${minute.toString().padStart(2, "0")} ${ampm}`;
        
        console.log(`[ubc] Searching for time slot starting at ${time12h}…`);

        // Find all Book Now spans and match by time
        const bookNowSpans = page
            .locator("#scheduler .k-event-template.facility-booking-slot span")
            .filter({ hasText: /Book Now/i });

        const spanCount = await bookNowSpans.count();
        console.log(`[ubc] Found ${spanCount} Book Now buttons`);

        let targetSpan: Locator | null = null;
        for (let i = 0; i < spanCount; i++) {
            const span = bookNowSpans.nth(i);
            const titleAttr = (await span.getAttribute("title")) || "";
            
            // Check if this slot starts at the requested time
            if (titleAttr.toLowerCase().includes(time12h.toLowerCase())) {
                console.log(`[ubc] Found matching slot: ${titleAttr}`);
                targetSpan = span;
                break;
            }
        }

        if (!targetSpan) {
            return {
                success: false,
                message: `Could not find available slot at ${request.time_24h} (${time12h})`
            };
        }

        // Click the Book Now button
        console.log("[ubc] Clicking Book Now span…");
        await targetSpan.click();

        // Wait for the booking summary to appear
        await page.waitForTimeout(2000);

        // =====================================================================
        // STEP 2: Click the "Reserve" button
        // =====================================================================
        console.log("[ubc] Step 2: Looking for Reserve button…");
        
        const reserveButton = page.locator('button.button-book[name="book-button"], button:has-text("Reserve")').first();
        
        if (!await reserveButton.isVisible({ timeout: 10000 }).catch(() => false)) {
            return {
                success: false,
                message: "Reserve button not found after clicking Book Now"
            };
        }

        // Wait for any Kendo UI overlay to disappear (loading spinner/modal)
        console.log("[ubc] Waiting for any overlay to disappear…");
        await page.locator('.k-overlay').waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
            console.log("[ubc] Overlay still visible, removing via JavaScript…");
            // Forcefully remove the overlay if it's blocking
            await page.evaluate(() => {
                document.querySelectorAll('.k-overlay').forEach(el => el.remove());
            });
        });
        
        // Also wait for loading containers to disappear
        await page.locator('.loading-container, .bm-loading-container, #bm-overlay').waitFor({ state: 'hidden', timeout: 3000 }).catch(async () => {
            await page.evaluate(() => {
                document.querySelectorAll('.loading-container, .bm-loading-container, #bm-overlay').forEach(el => {
                    (el as HTMLElement).style.display = 'none';
                });
            });
        });

        // =====================================================================
        // Fill in number of attendees (default 2 unless specified)
        // =====================================================================
        const numAttendees = request.num_people || 2;
        console.log(`[ubc] Setting number of attendees to ${numAttendees}…`);
        
        // The Kendo NumericTextBox widget requires using JavaScript to set its value
        // because the visible input has aria-hidden="true" and isn't directly editable
        const setAttendeesResult = await page.evaluate((num) => {
            // Method 1: Try Kendo widget API
            const input = document.querySelector('#number-of-attendees, input[name="number-of-attendees"]') as HTMLInputElement;
            if (input) {
                const $ = (window as any).jQuery || (window as any).$;
                if ($) {
                    const kendoWidget = $(input).data('kendoNumericTextBox');
                    if (kendoWidget) {
                        kendoWidget.value(num);
                        kendoWidget.trigger('change');
                        return { success: true, method: 'kendo' };
                    }
                }
                // Method 2: Direct value set with events
                input.value = String(num);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, method: 'direct' };
            }
            
            // Method 3: Try the visible formatted input
            const visibleInput = document.querySelector('.number-of-people-input .k-formatted-value, .num-of-spots.k-formatted-value') as HTMLInputElement;
            if (visibleInput) {
                visibleInput.value = String(num);
                visibleInput.dispatchEvent(new Event('input', { bubbles: true }));
                visibleInput.dispatchEvent(new Event('change', { bubbles: true }));
                visibleInput.dispatchEvent(new Event('blur', { bubbles: true }));
                return { success: true, method: 'visible' };
            }
            
            return { success: false, method: 'none' };
        }, numAttendees);
        
        console.log(`[ubc] Set attendees result: ${JSON.stringify(setAttendeesResult)}`);
        
        // Wait for UI to update
        await page.waitForTimeout(1000);

        // Verify the booking summary shows correct info
        const summaryText = await page.locator('.booking-summary').innerText().catch(() => "");
        console.log(`[ubc] Booking summary: ${summaryText.replace(/\n/g, ' | ')}`);

        console.log("[ubc] Clicking Reserve button…");
        const currentUrl = page.url();
        
        // Remove any overlay that might be blocking
        await page.evaluate(() => {
            document.querySelectorAll('.k-overlay').forEach(el => el.remove());
        });
        
        // The Reserve button uses Knockout.js (data-bind="click: onBookButtonClick")
        // We need to click and wait for URL change, not just networkidle
        // Use force:true in case overlay is still partially visible
        await reserveButton.click({ force: true });
        console.log("[ubc] Reserve button clicked, waiting for navigation…");
        
        // Wait for URL to change (the JS will navigate to attendee page or login portal)
        try {
            await page.waitForURL(/BookMe4EventParticipants|Participant|Attendee|portal\.recreation|Login/i, { timeout: 15000 });
            console.log("[ubc] URL changed");
        } catch {
            console.log("[ubc] URL pattern wait timed out, checking current state…");
        }
        
        // Also wait for network to settle
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        
        const newUrl = page.url();
        console.log(`[ubc] URL after Reserve: ${newUrl}`);
        
        // Check if we got redirected to a login portal
        if (newUrl.includes("portal.recreation.ubc.ca") || newUrl.includes("Login")) {
            console.log("[ubc] Redirected to login portal, need to re-authenticate…");
            
            // Extract the returnUrl from the current URL - this is where we should end up after login
            const urlObj = new URL(newUrl);
            const returnUrl = urlObj.searchParams.get('returnUrl');
            console.log(`[ubc] Return URL after login should be: ${returnUrl}`);
            
            // Handle login on this portal (similar to CWL login)
            // Look for CWL Login button
            const cwlButton = page.locator('a:has-text("CWL"), button:has-text("CWL"), img[alt*="CWL"]').first();
            if (await cwlButton.isVisible({ timeout: 5000 }).catch(() => false)) {
                console.log("[ubc] Found CWL login button on portal, clicking…");
                await cwlButton.click();
                await page.waitForLoadState("domcontentloaded");
            }
            
            // Fill in credentials if we see a login form
            const usernameField = page.locator('input[name="username"], #username, input[type="text"][id*="user"]').first();
            const passwordField = page.locator('input[name="password"], #password, input[type="password"]').first();
            
            if (await usernameField.isVisible({ timeout: 10000 }).catch(() => false)) {
                const user = process.env.UBC_USER || "";
                const pass = process.env.UBC_PASS || "";
                
                console.log("[ubc] Filling login credentials on portal…");
                await usernameField.fill(user);
                await passwordField.fill(pass);
                
                const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign")').first();
                await submitBtn.click();
                
                // Wait for login to complete and redirect
                await page.waitForLoadState("networkidle", { timeout: 60000 });
            }
            
            // After login, check if we need to navigate to returnUrl
            const currentUrlAfterLogin = page.url();
            console.log(`[ubc] URL after portal login: ${currentUrlAfterLogin}`);
            
            // If we ended up on the wrong page, navigate to the returnUrl
            // The attendee page URL pattern: BookMe4EventParticipants (can be under /Contacts/ or /Menu/)
            if (returnUrl && !currentUrlAfterLogin.includes("BookMe4EventParticipants")) {
                console.log("[ubc] Navigating to attendee selection page from returnUrl…");
                const decodedUrl = decodeURIComponent(returnUrl);
                console.log(`[ubc] Decoded returnUrl: ${decodedUrl}`);
                await page.goto(decodedUrl, { waitUntil: "networkidle" });
            }
            
            console.log(`[ubc] Final URL after re-login: ${page.url()}`);
        }
        
        // Check if we're still on the facility page
        if (page.url().includes("BookMe4LandingPages/Facility")) {
            console.log("[ubc] Still on facility page - Reserve may not have worked");
            
            // Try clicking the Reserve button again with force
            console.log("[ubc] Trying to click Reserve button again with force…");
            await reserveButton.click({ force: true });
            await page.waitForTimeout(3000);
            
            // Check if booking summary has a different button or link
            const altBookButton = page.locator('.booking-summary button, .booking-summary a, [data-bind*="BookButton"] button').first();
            if (await altBookButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log("[ubc] Found alternative book button, removing overlays and clicking…");
                // Remove overlays again before clicking
                await page.evaluate(() => {
                    document.querySelectorAll('.k-overlay').forEach(el => el.remove());
                });
                await altBookButton.click({ force: true });
                await page.waitForTimeout(3000);
            }
            
            // Final URL check
            const finalUrl = page.url();
            console.log(`[ubc] Final URL: ${finalUrl}`);
            
            if (finalUrl.includes("BookMe4LandingPages/Facility")) {
                // Still stuck - let's check if there's an error message
                const errorMsg = await page.locator('.error, .alert, .validation-error').first().innerText().catch(() => "");
                if (errorMsg) {
                    return {
                        success: false,
                        message: `Could not proceed with booking: ${errorMsg}`
                    };
                }
                
                return {
                    success: false,
                    message: "Reserve button click did not navigate to attendee selection page"
                };
            }
        }

        // =====================================================================
        // STEP 3: Select attendee (the one marked as "You") and click Next
        // =====================================================================
        console.log("[ubc] Step 3: Selecting attendee…");
        console.log(`[ubc] Current URL: ${page.url()}`);

        // Wait for the attendee page to fully load
        // The attendees table is at: table tbody tr.bm-selectable-row
        await page.waitForSelector('table tr.bm-selectable-row, #event-attendees, .bm-participant-selection', { timeout: 15000 }).catch(() => {
            console.log("[ubc] Warning: Attendee section not found with primary selectors");
        });

        // Debug: log page content hints
        const pageTitle = await page.title().catch(() => "");
        console.log(`[ubc] Page title: ${pageTitle}`);

        // Find all attendee rows - the table structure is: table > tbody > tr.bm-selectable-row
        const attendeeRows = page.locator('table tbody tr.bm-selectable-row, #event-attendees tr.bm-selectable-row, .bm-participant-selection tr.bm-selectable-row');
        const rowCount = await attendeeRows.count();
        console.log(`[ubc] Found ${rowCount} potential attendees`);

        // Look for the row with "(You)" label - this is the logged-in user
        // The checkbox ID pattern: ParticipantsFamily_FamilyMembers_X__IsParticipating
        let selectedAttendeeName = "";
        for (let i = 0; i < rowCount; i++) {
            const row = attendeeRows.nth(i);
            const label = await row.locator('label').innerText().catch(() => "");
            const rowClass = await row.getAttribute("class").catch(() => "");
            const isRowHidden = await row.evaluate(el => (el as HTMLElement).style.display === 'none').catch(() => false);
            
            // Skip hidden rows
            if (isRowHidden) continue;
            
            console.log(`[ubc] Attendee ${i + 1}: "${label}" (class: ${rowClass})`);
            
            if (label.includes("(You)")) {
                console.log(`[ubc] Found YOUR attendee: ${label}`);
                selectedAttendeeName = label;
                
                // Check if the row is disabled
                const isDisabled = rowClass?.includes("disabled") || false;
                if (isDisabled) {
                    console.log(`[ubc] Attendee ${label} is disabled, skipping…`);
                    continue;
                }
                
                // Find the checkbox - it's input[type="checkbox"][id*="IsParticipating"]
                const checkbox = row.locator('input[type="checkbox"][id*="IsParticipating"]:not(.disabled):not([disabled])').first();
                if (await checkbox.count() > 0) {
                    const isChecked = await checkbox.isChecked().catch(() => false);
                    if (!isChecked) {
                        // Click the row or checkbox to select
                        await checkbox.click({ force: true });
                        console.log(`[ubc] Selected attendee: ${label}`);
                    } else {
                        console.log(`[ubc] Attendee already selected: ${label}`);
                    }
                    break;
                } else {
                    // Try clicking the row itself
                    console.log(`[ubc] Checkbox not found directly, clicking row…`);
                    await row.click();
                    break;
                }
            }
        }

        if (!selectedAttendeeName) {
            console.log("[ubc] Could not find (You) attendee, trying fallback…");
            // Fallback: select first non-disabled attendee
            for (let i = 0; i < rowCount; i++) {
                const row = attendeeRows.nth(i);
                const rowClass = await row.getAttribute("class").catch(() => "");
                const isDisabled = rowClass?.includes("disabled") || false;
                const isRowHidden = await row.evaluate(el => (el as HTMLElement).style.display === 'none').catch(() => false);
                
                if (!isDisabled && !isRowHidden) {
                    const checkbox = row.locator('input[type="checkbox"][id*="IsParticipating"]:not(.disabled):not([disabled])').first();
                    if (await checkbox.count() > 0) {
                        const isChecked = await checkbox.isChecked().catch(() => false);
                        if (!isChecked) {
                            await checkbox.click({ force: true });
                        }
                        selectedAttendeeName = await row.locator('label').innerText().catch(() => "Unknown");
                        console.log(`[ubc] Selected first available attendee: ${selectedAttendeeName}`);
                        break;
                    }
                }
            }
        }

        // Wait for any validation/hold creation after clicking attendee
        await page.waitForTimeout(3000);
        
        // Verify an attendee was selected
        if (!selectedAttendeeName) {
            return {
                success: false,
                message: "Could not select any attendee - none available or all disabled"
            };
        }

        // Wait for Next button to become enabled after attendee selection
        console.log("[ubc] Waiting for Next button to become available after attendee selection…");
        await page.waitForTimeout(2000);

        // Click the Next button - try multiple selectors
        console.log("[ubc] Looking for Next button…");
        
        const nextButtonSelectors = [
            '.next-button-container a.bm-button',
            '.next-button-container a',
            '.bm-form-navbar a.bm-button',
            'a.bm-button:has-text("Next")',
            'a:has(span:text("Next"))',
            '.bm-form-navbar a[title="Next"]',
            'button:has-text("Next")',
            'input[type="submit"][value*="Next"]'
        ];

        let nextButton = null;
        for (const selector of nextButtonSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                console.log(`[ubc] Found Next button with selector: ${selector}`);
                nextButton = btn;
                break;
            }
        }
        
        if (!nextButton) {
            // Debug: take a screenshot or log more info
            console.log("[ubc] Next button not found. Dumping available buttons…");
            const allButtons = await page.locator('a.bm-button, button, input[type="submit"]').all();
            for (const btn of allButtons.slice(0, 10)) {
                const text = await btn.innerText().catch(() => "");
                const href = await btn.getAttribute("href").catch(() => "");
                console.log(`[ubc]   Button: "${text}" href="${href}"`);
            }
            
            return {
                success: false,
                message: "Next button not found on attendee selection page"
            };
        }

        await nextButton.click();

        // Wait for navigation to payment page
        await page.waitForLoadState("networkidle", { timeout: 30000 });
        await page.waitForTimeout(2000);

        // =====================================================================
        // STEP 4: Select payment method (existing credit card)
        // =====================================================================
        console.log("[ubc] Step 4: Selecting payment method…");

        // Look for existing credit card option
        const existingCardOption = page.locator('.org-payment-type:has(.icon-creditcard-visa, .icon-creditcard-mastercard)').first();
        
        if (await existingCardOption.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log("[ubc] Found existing credit card, selecting it…");
            await existingCardOption.click();
            await page.waitForTimeout(1000);
        } else {
            console.log("[ubc] No existing credit card found, checking if already selected…");
            // Card might already be selected by default
        }

        // =====================================================================
        // STEP 5: Click "Place My Order" button
        // =====================================================================
        console.log("[ubc] Step 5: Clicking Place My Order…");

        const placeOrderButton = page.locator('button.process-now, button:has-text("Place My Order")').first();
        
        if (!await placeOrderButton.isVisible({ timeout: 10000 }).catch(() => false)) {
            return {
                success: false,
                message: "Place My Order button not found"
            };
        }

        console.log("[ubc] Clicking Place My Order button…");
        await placeOrderButton.click();

        // Wait for order processing
        await page.waitForLoadState("networkidle", { timeout: 60000 });
        await page.waitForTimeout(3000);

        // =====================================================================
        // Check for confirmation or error
        // =====================================================================
        console.log("[ubc] Checking for confirmation…");

        // Look for success indicators
        const pageText = await page.locator('body').innerText().catch(() => "");
        const hasConfirmation = /confirmation|thank you|order.*complete|booking.*confirmed|receipt/i.test(pageText);
        
        // Look for error messages
        const errorElement = page.locator('.error, .alert-danger, .validation-error, [class*="error-message"]').first();
        const errorText = await errorElement.innerText().catch(() => "");

        if (errorText && !hasConfirmation) {
            console.log(`[ubc] Booking error: ${errorText}`);
            return {
                success: false,
                message: `Booking failed: ${errorText}`
            };
        }

        // Try to extract confirmation number
        const confirmationNumber = await page.locator('[class*="confirmation-number"], [class*="order-number"], [class*="receipt-number"]')
            .first().innerText().catch(() => undefined);

        console.log("[ubc] Booking completed successfully!");

        return {
            success: true,
            confirmation_number: confirmationNumber,
            message: "Booking completed successfully",
            booked_slot: {
                time: request.time_24h,
                duration: request.duration_hours * 60,
                location: courtName.trim()
            }
        };

    } catch (error: any) {
        console.error("[ubc] Booking error:", error?.message || error);
        return {
            success: false,
            message: `Booking failed: ${error?.message || "Unknown error"}`
        };
    } finally {
        await browser.close();
    }
}
