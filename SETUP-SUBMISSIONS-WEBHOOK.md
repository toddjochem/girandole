# Setting Up Girandole Submission Notifications

This connects the submission form to Google Sheets so you get notified of new API submissions.

## Sheet Created
https://docs.google.com/spreadsheets/d/1DXoaBTJWGVrY8_IxjcBrCwNGxsYUxp1Lz6y-XVLPz2Q

## Step 1: Open Apps Script

1. Open the sheet above
2. Click **Extensions** → **Apps Script**
3. Delete any code and paste:

```javascript
function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);
    
    if (data.type === 'new_submission') {
      var d = data.data;
      sheet.appendRow([
        data.timestamp || new Date().toISOString(),
        d.name || '',
        d.endpoint || '',
        d.category || '',
        d.description || '',
        d.contact || ''
      ]);
    }
    
    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## Step 2: Deploy as Web App

1. Click **Deploy** → **New deployment**
2. Click gear → **Web app**
3. Set:
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy** → **Authorize**
5. Copy the Web App URL

## Step 3: Add to Netlify

1. Go to Netlify → girandole → Site settings → Environment variables
2. Add:
   - Key: `SUBMISSION_WEBHOOK_URL`
   - Value: (the URL from step 2)
3. Redeploy

## Done!

Every verified submission will log to the sheet. Alfred will check it during heartbeats and can notify you.
