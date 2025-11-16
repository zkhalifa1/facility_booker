// src/ubc.ts
import { chromium, BrowserContext, Page } from "playwright";
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

// Handles: URL1 → URL2 (Login Portal) → URL3 (CWL) → URL4 (back to courts list)
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

    // Try a few robust selectors for the CWL button
    const cwlButtonCandidates = [
        authPage.getByRole("button", { name: /cwl login/i }),
        authPage.getByRole("link", { name: /cwl login/i }),
        authPage.locator('a:has(img[alt*="CWL"])'),
        authPage.locator('img[alt*="CWL"]').locator("xpath=ancestor::a[1]")
    ];

    let cwlButton: Page["locator"] | null = null;
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

// Main entry used by /check_now
export async function checkAvailability(prefs: Preferences): Promise<Slot[]> {
    const browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext();
    let page: Page = await context.newPage();

    try {
        console.log("[ubc] Navigating to booking page…");
        await page.goto(BASE_URL, { waitUntil: "networkidle" });

        // Make sure we are logged in and back on the courts list
        page = await ensureLoggedIn(context, page);

        // TODO: once we understand the DOM, we’ll:
        //  - iterate dates up to prefs.days_ahead
        //  - filter on start_hour/end_hour/min_minutes
        //  - parse actual available slots from the grid

        const todayIso = new Date().toISOString().slice(0, 10);
        console.log("[ubc] Logged in; returning stubbed slot");

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
