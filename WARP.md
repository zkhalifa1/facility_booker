# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

This is a TypeScript/Node.js backend service for checking UBC facility availability and sending notifications. The service exposes a REST API that can be consumed by GPT actions or other clients to check facility availability and send email notifications.

**Key Purpose**: Acts as a secure backend proxy that:
- Holds UBC credentials server-side (not exposed to GPT)
- Scrapes/checks facility availability via Playwright (planned)
- Sends email notifications via SMTP
- Authenticates API requests with bearer token

## Development Commands

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```
Starts the development server with hot-reload using `ts-node-dev`.

### Build
```bash
npm run build
```
Compiles TypeScript to JavaScript in the `dist/` directory.

### Production
```bash
npm start
```
Runs the compiled JavaScript from `dist/index.js`.

### Docker
```bash
docker build -t facility_booker .
docker run -p 8080:8080 --env-file .env facility_booker
```

## Architecture

### Entry Point
- **src/index.ts**: Express server with three main endpoints:
  - `GET /health`: Health check endpoint
  - `POST /check_now`: Check facility availability based on user preferences
  - `POST /notify`: Send notifications (currently email only)

### Module Structure
- **src/ubc.ts**: Contains `checkAvailability()` function (currently stubbed, needs Playwright implementation)
- **src/notify.ts**: Contains `sendEmail()` function using nodemailer

### Authentication
All endpoints except `/health` require Bearer token authentication via the `requireBearer` middleware. Token is set in `BOOKER_GPT_TOKEN` environment variable.

### Data Validation
Uses Zod schemas for request validation:
- `PreferencesSchema`: Validates facility search preferences (days_ahead, hours, locations, etc.)
- `NotifySchema`: Validates notification targets (email, sms placeholder, telegram placeholder)

### Environment Variables
Required configuration (see `.env.example`):
- `PORT`: Server port (default 8080)
- `BOOKER_GPT_TOKEN`: Bearer token for API authentication
- `UBC_USER`, `UBC_PASS`: UBC credentials (kept server-side only)
- `EMAIL_FROM`, `EMAIL_TO`: Email addresses for notifications
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: SMTP configuration

## Key Implementation Notes

### Planned Playwright Integration
The `checkAvailability()` function in `src/ubc.ts` is currently stubbed and returns mock data. This is where Playwright automation should be implemented to:
- Navigate to UBC facility booking system
- Authenticate with UBC credentials
- Search for available slots based on preferences
- Return structured slot data

### TypeScript Configuration
- Target: ES2021
- Module: ES2020 (ESM modules)
- Strict mode enabled
- Output to `dist/` directory

### Extension Points
The notification system is designed for future expansion:
- SMS via Twilio (schema defined but not implemented)
- Telegram notifications (schema defined but not implemented)

When adding new notification methods, implement in `src/notify.ts` and handle in the `/notify` endpoint logic.
