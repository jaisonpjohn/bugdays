# Bug Days Contact Form Worker

Cloudflare Worker that handles contact form submissions and stores them in D1.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create the D1 database:
   ```bash
   wrangler d1 create bugdays-contact
   ```

3. Copy the database ID from the output and update `wrangler.toml`:
   ```toml
   database_id = "YOUR_DATABASE_ID_HERE"
   ```

4. Create the table:
   ```bash
   wrangler d1 execute bugdays-contact --file=./schema.sql
   ```

5. Deploy the worker:
   ```bash
   npm run deploy
   ```

## Local Development

```bash
npm run dev
```

## Viewing Submissions

You can view submissions via the Cloudflare dashboard or using wrangler:

```bash
wrangler d1 execute bugdays-contact --command="SELECT * FROM contacts ORDER BY created_at DESC LIMIT 20"
```

## API

### POST /api/contact

Request body:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "message": "Hello, I have a question..."
}
```

Success response:
```json
{
  "success": true,
  "message": "Message received"
}
```

Error response:
```json
{
  "success": false,
  "error": "Error description"
}
```
