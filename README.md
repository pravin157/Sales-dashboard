# CloudTalk report

Local report for a CloudTalk account. The browser talks only to this app. The Access Key ID and Secret stay in `.env` and are sent to CloudTalk with HTTP Basic auth.

## What it loads

From `https://my.cloudtalk.io/api`:

- Calls for the selected dates (up to 2,000)
- Agents, and call totals per agent from those calls
- Contacts (up to 1,500)
- Phone numbers
- Groups
- Tags
- Contact notes (up to 1,000)
- Today’s live group statistics

A source that CloudTalk refuses is marked on the page. The rest of the report still loads.

## Run

```bash
cd cloudtalk
npm install
npm run dev
```

Open http://localhost:3200. Use the **CloudTalk** and **Frejun** tabs to switch dashboards. CloudTalk reads `CLOUDTALK_KEY_ID` and `CLOUDTALK_KEY_SECRET` from `.env` and spaces its requests so CloudTalk’s rate limit is not hit on every refresh. Frejun reads `FREJUN_API_KEY` and loads call logs, grouped by virtual number.
