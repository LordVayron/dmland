# Connect DMLand to Instagram (Meta setup)

> **This is a fallback checklist.** Meta changes its screens and names often. If you use an AI agent,
> it will check Meta's current documentation first. Use this page when you set things up by hand.
> Everything here stays free. It takes about 15 minutes.

What you are building: **your own Meta app**, in development mode, that DMLand uses to read comments
and send DMs for **your own Instagram account**. You do not need Meta's approval for this.

## What you need

- An Instagram **Professional** account (Business or Creator). In Instagram: Settings → Account type and tools.
- A Facebook account, and a **Business Portfolio** (Meta Business Suite) that contains your Instagram account.
- Node 24 or newer and DMLand running (`npm start`).

## 1. Create the app

1. Go to **developers.facebook.com** → My Apps → **Create App**.
2. Choose the business use case that includes the Instagram API. Name it anything (for example "DMLand").
3. Connect it to your Business Portfolio.
4. Leave the app in **Development mode**. You do not need to publish it.

## 2. Create a system user and give it access

1. In **Business Settings** (business.facebook.com/settings) → Users → **System users** → Add. Role: Admin.
2. **Assign assets**:
   - **Apps**: your new app, with "Develop app" access.
   - **Instagram accounts**: your account, with **Messages**, **Community activity** and **Insights** (insights are optional, they power the Home analytics).

## 3. Generate the token

1. On the system user, click **Generate token**, choose your app, and set expiry to **Never**.
2. Select these permissions:
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `instagram_manage_insights` (optional, for analytics)
3. Copy the token. **Treat it like a password.** Never paste it into chats, issues or screenshots.

## 4. Connect it in DMLand

1. Open the dashboard → **Brands & accounts** → create a brand.
2. Enter your Instagram account ID and paste the token → **Connect**.
3. The status should turn green with your account name.

Your Instagram account ID is shown in Business Settings → Accounts → Instagram accounts.

## 5. Test it

Create an automation on one of your own posts with a test keyword. From a **second account you own**,
comment that keyword. Within about a minute DMLand replies and sends the DM.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Application does not have permission" (code 10) | The system user is missing a permission on the Instagram account, usually **Insights**, **Messages** or **Community activity**. |
| The DM does not arrive | The comment is older than 7 days, or the person's privacy settings block message requests. |
| Meta pauses sending | You hit the hourly limit. DMLand waits (10 minutes, or 60 if Meta flags spam) and retries. |
| Account will not connect | The account is not Professional, or is not inside your Business Portfolio. |
